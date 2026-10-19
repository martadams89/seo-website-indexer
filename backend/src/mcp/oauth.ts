/**
 * mcp/oauth.ts — an OAuth 2.1 authorization server for the MCP endpoint, so
 * any MCP client that supports remote servers (chat apps, IDEs, agent CLIs)
 * can be added with just the URL: the client discovers this server, identifies
 * itself, sends the person to a consent screen in the dashboard, and receives
 * short-lived access tokens plus a rotating refresh token.
 *
 *   /.well-known/oauth-protected-resource[/mcp]   RFC 9728 resource metadata
 *   /.well-known/oauth-authorization-server[/mcp] RFC 8414 server metadata
 *   POST /oauth/register                           RFC 7591 dynamic client registration
 *   GET  /oauth/authorize                          authorization code + PKCE (S256 only)
 *   POST /oauth/token                              code and refresh_token grants
 *   POST /oauth/revoke                             RFC 7009 revocation
 *
 * Clients can identify themselves three ways: dynamic registration, an https
 * client_id that points at a Client ID Metadata Document, or a client a person
 * registered on the dashboard (for apps that ask for a client ID and secret).
 * Loopback redirect URIs match on any port (RFC 8252) and the authorization
 * response carries `iss` (RFC 9207).
 *
 * Access tokens are ordinary MCP tokens (hashed in mcp_tokens, linked to the
 * grant), so the MCP route authenticates them exactly like personal tokens.
 * Personal tokens keep working for clients that prefer a static header.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/database.js';
import { getUserById, recordAuditEvent, type User } from '../auth/users.js';
import { accessibleWorkspaces } from '../auth/workspaces.js';
import { publicOrigin } from '../utils/origin.js';
import { safeFetch } from '../security/outbound-url.js';
import { MCP_SCOPES, type McpScope } from './tokens.js';

const ACCESS_TOKEN_TTL_S = 3600;
const REFRESH_TOKEN_TTL_MS = 30 * 86_400_000;
const CODE_TTL_MS = 5 * 60_000;
const REQUEST_TTL_MS = 15 * 60_000;
const MAX_CLIENTS = 1000;

export const SCOPE_INFO: Record<McpScope, { label: string; description: string }> = {
  'mcp:read': { label: 'Read your data', description: 'Sites, Search Console, indexing, AI citations and Google Ads reporting in every workspace you can access.' },
  'mcp:write': { label: 'Run SEO actions', description: 'Submit URLs for indexing, trigger indexing runs and refresh performance snapshots.' },
  'ads:write': { label: 'Manage Google Ads', description: 'Propose and apply Google Ads changes. Each client\'s guardrails still apply: changes outside them wait for your approval.' },
};

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// ── Metadata ─────────────────────────────────────────────────────────────────

export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

function protectedResource(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'SEO Website Indexer',
    resource_documentation: 'https://github.com/martadams89/seo-website-indexer#mcp-server-connect-an-ai-assistant',
  };
}

function authorizationServer(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [...MCP_SCOPES],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    service_documentation: 'https://github.com/martadams89/seo-website-indexer/blob/main/docs/GOOGLE_ADS.md',
  };
}

// ── Clients ──────────────────────────────────────────────────────────────────

interface ClientRow { id: string; name: string; redirect_uris: string; secret_hash: string | null; token_endpoint_auth_method: string }

const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about']);

/**
 * Optional operator allowlist (MCP_OAUTH_REDIRECT_ALLOWLIST): hostnames such
 * as "claude.ai", wildcards such as "*.example.com", and app schemes such as
 * "vscode:". Unset means any https redirect may register.
 */
function redirectAllowlist(): string[] {
  return (process.env.MCP_OAUTH_REDIRECT_ALLOWLIST ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
}

function allowlisted(url: URL, scheme: string, list: string[]): boolean {
  if (!['http', 'https'].includes(scheme)) return list.includes(`${scheme}:`);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return list.some(entry => entry.startsWith('*.') ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry);
}

/** https anywhere, http only on loopback, or a private-use scheme for native apps — narrowed by the allowlist when set. */
export function validRedirectUri(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.hash) return false;
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const shapeOk = scheme === 'https'
    || (scheme === 'http' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    || (!['http', 'https'].includes(scheme) && /^[a-z][a-z0-9+.-]*$/.test(scheme) && !BLOCKED_SCHEMES.has(scheme));
  if (!shapeOk) return false;
  const list = redirectAllowlist();
  return !list.length || allowlisted(url, scheme, list);
}

function getClient(id: string): ClientRow | null {
  return (getDb().prepare('SELECT id,name,redirect_uris,secret_hash,token_endpoint_auth_method FROM mcp_oauth_clients WHERE id=?').get(id) as ClientRow | undefined) ?? null;
}

function clientRedirects(client: ClientRow): string[] {
  try { return JSON.parse(client.redirect_uris) as string[]; } catch { return []; }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Exact match, except that loopback http redirects may use any port: native
 * apps and CLIs (VS Code, agent CLIs) pick a free port at sign-in time.
 */
export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try { req = new URL(requested); } catch { return false; }
  if (req.protocol !== 'http:' || !LOOPBACK.has(req.hostname)) return false;
  return registered.some(raw => {
    try {
      const reg = new URL(raw);
      return reg.protocol === 'http:' && reg.hostname === req.hostname && reg.pathname === req.pathname && reg.search === req.search;
    } catch { return false; }
  });
}

// ── Client ID Metadata Documents ─────────────────────────────────────────────

const METADATA_TTL_MS = 3_600_000;
const METADATA_MAX_BYTES = 64 * 1024;
type MetadataFetcher = (url: string) => Promise<Response>;
let metadataFetcher: MetadataFetcher = url => safeFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
export function __setMetadataFetcherForTests(fetcher: MetadataFetcher): void { metadataFetcher = fetcher; }

/** An https client_id with a path (no fragment or credentials) is a metadata document URL. */
export function isMetadataClientId(id: string): boolean {
  try {
    const url = new URL(id);
    return url.protocol === 'https:' && url.pathname.length > 1 && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

/**
 * Fetch (or reuse, for an hour) a Client ID Metadata Document and store it as
 * a public client whose id is the document URL. The fetch goes through the
 * outbound-URL guard, so it can't be pointed at private addresses.
 */
async function resolveMetadataClient(id: string): Promise<ClientRow | { error: string }> {
  const db = getDb();
  const cached = db.prepare('SELECT metadata_fetched_at FROM mcp_oauth_clients WHERE id=?').get(id) as { metadata_fetched_at: string | null } | undefined;
  if (cached?.metadata_fetched_at && Date.now() - Date.parse(cached.metadata_fetched_at) < METADATA_TTL_MS) return getClient(id)!;
  let doc: Record<string, unknown>;
  try {
    const res = await metadataFetcher(id);
    if (!res.ok) return { error: `The client's metadata document returned HTTP ${res.status}.` };
    const text = await res.text();
    if (text.length > METADATA_MAX_BYTES) return { error: 'The client\'s metadata document is too large.' };
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return { error: `Couldn't read the client's metadata document: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (doc.client_id !== id) return { error: 'The metadata document\'s client_id does not match its URL.' };
  const method = String(doc.token_endpoint_auth_method ?? 'none');
  if (method !== 'none') return { error: `Unsupported token_endpoint_auth_method ${method} for a metadata-document client.` };
  const redirects = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.map(String) : [];
  if (!redirects.length || redirects.length > 20 || !redirects.every(validRedirectUri)) {
    return { error: 'The metadata document must list allowed redirect_uris (https, localhost http, or an app scheme).' };
  }
  const name = String(doc.client_name ?? new URL(id).host).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || new URL(id).host;
  db.prepare(`INSERT INTO mcp_oauth_clients(id,name,redirect_uris,token_endpoint_auth_method,metadata_fetched_at) VALUES(?,?,?,'none',?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, redirect_uris=excluded.redirect_uris, metadata_fetched_at=excluded.metadata_fetched_at`)
    .run(id, name, JSON.stringify(redirects), new Date().toISOString());
  return getClient(id)!;
}

export function registerClient(body: Record<string, unknown>, ip: string | null, registeredBy: string | null = null): { status: number; body: Record<string, unknown> } {
  const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!redirects.length || redirects.length > 10 || !redirects.every(validRedirectUri)) {
    return { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris must list 1–10 https URLs (http only for localhost, or an app-specific scheme).' } };
  }
  const method = String(body.token_endpoint_auth_method ?? 'none');
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
    return { status: 400, body: { error: 'invalid_client_metadata', error_description: `Unsupported token_endpoint_auth_method ${method}.` } };
  }
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types.map(String) : ['authorization_code', 'refresh_token'];
  if (grantTypes.some(g => !['authorization_code', 'refresh_token'].includes(g))) {
    return { status: 400, body: { error: 'invalid_client_metadata', error_description: 'Only authorization_code and refresh_token grants are supported.' } };
  }
  const name = String(body.client_name ?? 'MCP client').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || 'MCP client';
  const db = getDb();
  // Registration is open by design (RFC 7591); keep it bounded.
  db.prepare(`DELETE FROM mcp_oauth_clients WHERE last_used_at IS NULL AND registered_by IS NULL AND julianday(created_at) < julianday('now') - 7
    AND id NOT IN (SELECT client_id FROM mcp_oauth_grants)`).run();
  const count = (db.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_clients').get() as { n: number }).n;
  if (count >= MAX_CLIENTS) return { status: 503, body: { error: 'temporarily_unavailable', error_description: 'Too many registered clients. Try again later.' } };
  const id = `mcpc_${token(18)}`;
  const secret = method === 'none' ? null : `mcps_${token(32)}`;
  db.prepare('INSERT INTO mcp_oauth_clients(id,name,redirect_uris,secret_hash,token_endpoint_auth_method,created_ip,registered_by) VALUES(?,?,?,?,?,?,?)')
    .run(id, name, JSON.stringify(redirects), secret ? sha256(secret) : null, method, ip, registeredBy);
  return {
    status: 201,
    body: {
      client_id: id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: redirects,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    },
  };
}

/** Authenticate the client at the token/revoke endpoints. */
function authenticateClient(req: FastifyRequest, body: Record<string, string>): ClientRow | null {
  let id = body.client_id; let secret = body.client_secret;
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const split = decoded.indexOf(':');
    if (split > 0) { id = decodeURIComponent(decoded.slice(0, split)); secret = decodeURIComponent(decoded.slice(split + 1)); }
  }
  if (!id) return null;
  const client = getClient(id);
  if (!client) return null;
  if (client.secret_hash) {
    if (!secret || !safeEqual(sha256(secret), client.secret_hash)) return null;
  }
  return client;
}

// ── Authorization requests (pending consent) ─────────────────────────────────

export interface PendingRequest {
  id: string; client_id: string; client_name: string; redirect_uri: string; state: string | null; scope: string | null; code_challenge: string;
}

export function getPendingRequest(id: string): PendingRequest | null {
  const row = getDb().prepare(`SELECT r.id, r.client_id, c.name AS client_name, r.redirect_uri, r.state, r.scope, r.code_challenge, r.expires_at
    FROM mcp_oauth_requests r JOIN mcp_oauth_clients c ON c.id = r.client_id WHERE r.id=?`).get(id) as (PendingRequest & { expires_at: string }) | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    getDb().prepare('DELETE FROM mcp_oauth_requests WHERE id=?').run(id);
    return null;
  }
  return row;
}

function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

export function normalizeRequestedScopes(raw: unknown): McpScope[] {
  const wanted = String(raw ?? '').split(/[\s,]+/).filter(Boolean);
  const scopes = MCP_SCOPES.filter(s => wanted.includes(s));
  return scopes.length ? scopes : ['mcp:read'];
}

/** The person approved (with the scopes they ticked) or denied the request. */
export function decideRequest(requestId: string, user: User, approve: boolean, chosen: unknown, origin: string): { redirect: string } | null {
  const request = getPendingRequest(requestId);
  if (!request) return null;
  const db = getDb();
  db.prepare('DELETE FROM mcp_oauth_requests WHERE id=?').run(request.id);
  if (!approve) {
    return { redirect: withParams(request.redirect_uri, { error: 'access_denied', error_description: 'The user declined the request.', state: request.state, iss: origin }) };
  }
  const scopes = new Set<McpScope>(['mcp:read']);
  for (const s of Array.isArray(chosen) ? chosen.map(String) : []) if ((MCP_SCOPES as readonly string[]).includes(s)) scopes.add(s as McpScope);
  const code = token(32);
  db.prepare('INSERT INTO mcp_oauth_codes(code_hash,client_id,user_id,redirect_uri,code_challenge,scopes,expires_at) VALUES(?,?,?,?,?,?,?)')
    .run(sha256(code), request.client_id, user.id, request.redirect_uri, request.code_challenge, JSON.stringify([...scopes]), new Date(Date.now() + CODE_TTL_MS).toISOString());
  return { redirect: withParams(request.redirect_uri, { code, state: request.state, iss: origin }) };
}

export async function createAuthorizationRequest(q: Record<string, string | undefined>): Promise<{ ok: true; requestId: string } | { ok: false; status: number; message: string; redirect?: string }> {
  let client: ClientRow | null = null;
  if (q.client_id && isMetadataClientId(q.client_id)) {
    const resolved = await resolveMetadataClient(q.client_id);
    if ('error' in resolved) return { ok: false, status: 400, message: resolved.error };
    client = resolved;
  } else if (q.client_id) {
    client = getClient(q.client_id);
  }
  if (!client) return { ok: false, status: 400, message: 'Unknown client. Remove the server from your AI app and add it again so it can register.' };
  const registered = clientRedirects(client);
  const redirect = q.redirect_uri ?? (registered.length === 1 ? registered[0] : undefined);
  if (!redirect || !redirectMatches(registered, redirect)) return { ok: false, status: 400, message: 'The redirect URI does not match the one this client registered.' };
  const fail = (error: string, description: string) => ({ ok: false as const, status: 302, message: description, redirect: withParams(redirect, { error, error_description: description, state: q.state }) });
  if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
  if (!q.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return fail('invalid_request', 'PKCE code_challenge is required.');
  if ((q.code_challenge_method ?? 'plain') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256.');
  const id = randomUUID();
  const db = getDb();
  db.prepare("DELETE FROM mcp_oauth_requests WHERE julianday(expires_at) < julianday('now')").run();
  db.prepare("DELETE FROM mcp_oauth_codes WHERE julianday(expires_at) < julianday('now')").run();
  db.prepare('INSERT INTO mcp_oauth_requests(id,client_id,redirect_uri,state,scope,code_challenge,resource,expires_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, client.id, redirect, q.state ?? null, q.scope ?? null, q.code_challenge, q.resource ?? null, new Date(Date.now() + REQUEST_TTL_MS).toISOString());
  return { ok: true, requestId: id };
}

// ── Tokens ───────────────────────────────────────────────────────────────────

function issueAccessToken(grantId: string, userId: string, clientName: string, scopes: string[]): string {
  const raw = `seomcp_${token(32)}`;
  const db = getDb();
  db.prepare("DELETE FROM mcp_tokens WHERE oauth_grant_id=? AND (revoked_at IS NOT NULL OR julianday(expires_at) < julianday('now'))").run(grantId);
  db.prepare('INSERT INTO mcp_tokens(id,user_id,name,token_hash,scopes,expires_at,oauth_grant_id) VALUES(?,?,?,?,?,?,?)')
    .run(randomUUID(), userId, `OAuth: ${clientName}`.slice(0, 120), sha256(raw), JSON.stringify(scopes), new Date(Date.now() + ACCESS_TOKEN_TTL_S * 1000).toISOString(), grantId);
  return raw;
}

type TokenResult = { status: number; body: Record<string, unknown> };
const tokenError = (status: number, error: string, description: string): TokenResult => ({ status, body: { error, error_description: description } });

export function exchangeToken(client: ClientRow, body: Record<string, string>): TokenResult {
  const db = getDb();
  if (body.grant_type === 'authorization_code') {
    if (!body.code || !body.code_verifier) return tokenError(400, 'invalid_request', 'code and code_verifier are required.');
    const hash = sha256(body.code);
    const row = db.prepare('SELECT * FROM mcp_oauth_codes WHERE code_hash=?').get(hash) as {
      client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scopes: string; expires_at: string;
    } | undefined;
    db.prepare('DELETE FROM mcp_oauth_codes WHERE code_hash=?').run(hash); // single use, even on failure
    if (!row || row.client_id !== client.id || new Date(row.expires_at).getTime() < Date.now()) return tokenError(400, 'invalid_grant', 'The authorization code is invalid or expired.');
    if (body.redirect_uri && body.redirect_uri !== row.redirect_uri) return tokenError(400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
    const challenge = createHash('sha256').update(body.code_verifier).digest('base64url');
    if (!row.code_challenge || !safeEqual(challenge, row.code_challenge)) return tokenError(400, 'invalid_grant', 'PKCE verification failed.');
    const user = getUserById(row.user_id);
    if (!user || user.disabled) return tokenError(400, 'invalid_grant', 'The user is no longer active.');
    const scopes = JSON.parse(row.scopes) as string[];
    const grantId = randomUUID();
    const refresh = `seomcpr_${token(32)}`;
    db.prepare('INSERT INTO mcp_oauth_grants(id,client_id,user_id,scopes,refresh_hash,refresh_expires_at,last_used_at) VALUES(?,?,?,?,?,?,datetime(\'now\'))')
      .run(grantId, client.id, user.id, row.scopes, sha256(refresh), new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString());
    db.prepare("UPDATE mcp_oauth_clients SET last_used_at=datetime('now') WHERE id=?").run(client.id);
    recordAuditEvent({ actorUserId: user.id, action: 'mcp.oauth.granted', detail: { client: client.name, clientId: client.id, scopes } });
    return {
      status: 200,
      body: { access_token: issueAccessToken(grantId, user.id, client.name, scopes), token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: scopes.join(' ') },
    };
  }
  if (body.grant_type === 'refresh_token') {
    if (!body.refresh_token) return tokenError(400, 'invalid_request', 'refresh_token is required.');
    const grant = db.prepare('SELECT * FROM mcp_oauth_grants WHERE refresh_hash=?').get(sha256(body.refresh_token)) as {
      id: string; client_id: string; user_id: string; scopes: string; refresh_expires_at: string; revoked_at: string | null;
    } | undefined;
    if (!grant || grant.client_id !== client.id || grant.revoked_at || new Date(grant.refresh_expires_at).getTime() < Date.now()) {
      return tokenError(400, 'invalid_grant', 'The refresh token is invalid, expired or revoked. Reconnect the connector.');
    }
    const user = getUserById(grant.user_id);
    if (!user || user.disabled) return tokenError(400, 'invalid_grant', 'The user is no longer active.');
    let scopes = JSON.parse(grant.scopes) as string[];
    if (body.scope) {
      const narrowed = body.scope.split(/\s+/).filter(s => scopes.includes(s));
      if (!narrowed.length) return tokenError(400, 'invalid_scope', 'Requested scopes exceed the original grant.');
      scopes = narrowed;
    }
    const refresh = `seomcpr_${token(32)}`;
    db.prepare("UPDATE mcp_oauth_grants SET refresh_hash=?, refresh_expires_at=?, last_used_at=datetime('now') WHERE id=?")
      .run(sha256(refresh), new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(), grant.id);
    const name = getClient(client.id)?.name ?? 'MCP client';
    return {
      status: 200,
      body: { access_token: issueAccessToken(grant.id, user.id, name, scopes), token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: scopes.join(' ') },
    };
  }
  return tokenError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

export function revokeGrant(grantId: string): void {
  const db = getDb();
  db.prepare("UPDATE mcp_oauth_grants SET revoked_at=datetime('now'), refresh_hash=NULL WHERE id=? AND revoked_at IS NULL").run(grantId);
  db.prepare("UPDATE mcp_tokens SET revoked_at=datetime('now') WHERE oauth_grant_id=? AND revoked_at IS NULL").run(grantId);
}

function revokeToken(client: ClientRow, raw: string): void {
  const db = getDb();
  const grant = db.prepare('SELECT id FROM mcp_oauth_grants WHERE refresh_hash=? AND client_id=?').get(sha256(raw), client.id) as { id: string } | undefined;
  if (grant) { revokeGrant(grant.id); return; }
  db.prepare(`UPDATE mcp_tokens SET revoked_at=datetime('now') WHERE token_hash=? AND oauth_grant_id IN
    (SELECT id FROM mcp_oauth_grants WHERE client_id=?)`).run(sha256(raw), client.id);
}

export interface ConnectedApp { id: string; client_name: string; scopes: string[]; created_at: string; last_used_at: string | null }

export function listConnectedApps(userId: string): ConnectedApp[] {
  return (getDb().prepare(`SELECT g.id, c.name AS client_name, g.scopes, g.created_at, g.last_used_at FROM mcp_oauth_grants g
    JOIN mcp_oauth_clients c ON c.id = g.client_id WHERE g.user_id=? AND g.revoked_at IS NULL ORDER BY g.created_at DESC`).all(userId) as Array<Record<string, string>>)
    .map(r => ({ id: r.id, client_name: r.client_name, scopes: JSON.parse(r.scopes) as string[], created_at: r.created_at, last_used_at: r.last_used_at ?? null }));
}

export function listManualClients(userId: string): Array<{ id: string; name: string; redirect_uris: string[]; token_endpoint_auth_method: string; created_at: string; last_used_at: string | null }> {
  return (getDb().prepare(`SELECT id, name, redirect_uris, token_endpoint_auth_method, created_at, last_used_at FROM mcp_oauth_clients
    WHERE registered_by=? ORDER BY created_at DESC`).all(userId) as Array<Record<string, string>>)
    .map(r => ({ id: r.id, name: r.name, redirect_uris: JSON.parse(r.redirect_uris) as string[], token_endpoint_auth_method: r.token_endpoint_auth_method, created_at: r.created_at, last_used_at: r.last_used_at ?? null }));
}

export function revokeConnectedApp(userId: string, grantId: string): boolean {
  const row = getDb().prepare('SELECT id FROM mcp_oauth_grants WHERE id=? AND user_id=? AND revoked_at IS NULL').get(grantId, userId);
  if (!row) return false;
  revokeGrant(grantId);
  return true;
}

// ── Routes ───────────────────────────────────────────────────────────────────

const OAUTH_RATE_LIMIT = { config: { rateLimit: { max: parseInt(process.env.OAUTH_RATE_LIMIT_MAX ?? '30', 10), timeWindow: '1 minute' } } };

function cors(reply: FastifyReply): FastifyReply {
  return reply.header('Access-Control-Allow-Origin', '*').header('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version')
    .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function formBody(req: FastifyRequest): Record<string, string> {
  const body = req.body;
  if (body && typeof body === 'object') return Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  return {};
}

function htmlError(reply: FastifyReply, status: number, message: string) {
  const safe = message.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  return reply.status(status).type('text/html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Connection failed</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 24px;line-height:1.5"><h1 style="font-size:20px">This connection request can't continue</h1><p>${safe}</p></body></html>`);
}

export function registerMcpOAuthRoutes(app: FastifyInstance): void {
  // Token and revocation requests are form-encoded (RFC 6749).
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
  }

  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    app.get(path, async (req, reply) => cors(reply).send(protectedResource(publicOrigin(req))));
  }
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp']) {
    app.get(path, async (req, reply) => cors(reply).send(authorizationServer(publicOrigin(req))));
  }
  for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp']) {
    app.options(path, async (_req, reply) => cors(reply).status(204).send());
  }

  app.post('/oauth/register', OAUTH_RATE_LIMIT, async (req, reply) => {
    const result = registerClient((req.body ?? {}) as Record<string, unknown>, req.ip ?? null);
    return cors(reply).status(result.status).header('Cache-Control', 'no-store').send(result.body);
  });

  app.get('/oauth/authorize', async (req, reply) => {
    const result = await createAuthorizationRequest(req.query as Record<string, string | undefined>);
    if (!result.ok) {
      if (result.redirect) return reply.redirect(result.redirect, 302);
      return htmlError(reply, result.status, result.message);
    }
    // The dashboard renders the consent screen (and the sign-in form first if needed).
    return reply.redirect(`/oauth/consent?request=${encodeURIComponent(result.requestId)}`, 302);
  });

  app.post('/oauth/token', OAUTH_RATE_LIMIT, async (req, reply) => {
    cors(reply).header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    const body = formBody(req);
    const client = authenticateClient(req, body);
    if (!client) return reply.status(401).send({ error: 'invalid_client', error_description: 'Unknown client or bad client credentials.' });
    const result = exchangeToken(client, body);
    return reply.status(result.status).send(result.body);
  });

  app.post('/oauth/revoke', OAUTH_RATE_LIMIT, async (req, reply) => {
    cors(reply);
    const body = formBody(req);
    const client = authenticateClient(req, body);
    if (!client) return reply.status(401).send({ error: 'invalid_client' });
    if (body.token) revokeToken(client, body.token);
    return reply.status(200).send({});
  });
}

/** Session-authenticated consent and connected-app routes for the dashboard (under /api). */
export function registerMcpOAuthApiRoutes(app: FastifyInstance, currentUser: (req: FastifyRequest) => User): void {
  app.get('/api/oauth/requests/:id', async (req, reply) => {
    const request = getPendingRequest((req.params as { id: string }).id);
    if (!request) return reply.status(404).send({ error: 'This connection request has expired. Start the connection again from your AI app.' });
    const user = currentUser(req);
    let host = request.redirect_uri;
    try { const url = new URL(request.redirect_uri); host = url.protocol.startsWith('http') ? url.host : `${url.protocol}//`; } catch { /* keep raw */ }
    return {
      id: request.id,
      client_name: request.client_name,
      // For metadata-document clients the identity is the domain that published it.
      client_domain: isMetadataClientId(request.client_id) ? new URL(request.client_id).host : null,
      redirect_host: host,
      requested_scopes: normalizeRequestedScopes(request.scope),
      scopes: MCP_SCOPES.map(id => ({ id, ...SCOPE_INFO[id] })),
      user: { email: user.email, name: user.name },
      workspaces: accessibleWorkspaces(user).map(w => w.name),
    };
  });

  app.post('/api/oauth/requests/:id/decision', async (req, reply) => {
    const { approve, scopes } = (req.body ?? {}) as { approve?: boolean; scopes?: string[] };
    const result = decideRequest((req.params as { id: string }).id, currentUser(req), !!approve, scopes, publicOrigin(req));
    if (!result) return reply.status(404).send({ error: 'This connection request has expired. Start the connection again from your AI app.' });
    return result;
  });

  app.get('/api/oauth/apps', async (req) => listConnectedApps(currentUser(req).id));

  // Clients registered by hand, for AI apps that ask for a client ID and secret
  // instead of registering themselves.
  app.get('/api/oauth/clients', async (req) => listManualClients(currentUser(req).id));

  app.post('/api/oauth/clients', async (req, reply) => {
    const user = currentUser(req);
    const body = (req.body ?? {}) as { name?: string; redirect_uris?: string[] | string; confidential?: boolean };
    const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris : String(body.redirect_uris ?? '').split(/[\s,]+/);
    const result = registerClient({
      client_name: body.name,
      redirect_uris: redirects.map(r => r.trim()).filter(Boolean),
      token_endpoint_auth_method: body.confidential === false ? 'none' : 'client_secret_post',
    }, req.ip ?? null, user.id);
    if (result.status !== 201) return reply.status(400).send({ error: String(result.body.error_description ?? result.body.error) });
    recordAuditEvent({ actorUserId: user.id, action: 'mcp.oauth.client_registered', detail: { clientId: result.body.client_id, name: result.body.client_name } });
    const origin = publicOrigin(req);
    return { ...result.body, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, issuer: origin };
  });

  app.delete('/api/oauth/clients/:id', async (req, reply) => {
    const user = currentUser(req);
    const id = (req.params as { id: string }).id;
    const removed = getDb().prepare('DELETE FROM mcp_oauth_clients WHERE id=? AND registered_by=?').run(id, user.id).changes > 0;
    if (!removed) return reply.status(404).send({ error: 'OAuth client not found.' });
    recordAuditEvent({ actorUserId: user.id, action: 'mcp.oauth.client_deleted', detail: { clientId: id } });
    return { ok: true };
  });

  app.delete('/api/oauth/apps/:id', async (req, reply) => {
    const user = currentUser(req);
    const id = (req.params as { id: string }).id;
    if (!revokeConnectedApp(user.id, id)) return reply.status(404).send({ error: 'Connected app not found.' });
    recordAuditEvent({ actorUserId: user.id, action: 'mcp.oauth.revoked', detail: { grantId: id } });
    return { ok: true };
  });
}
