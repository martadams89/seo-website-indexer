import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

// OAuth 2.1 for MCP connectors: discovery from the 401, dynamic client
// registration, PKCE (S256 only), single-use codes, refresh rotation and
// revocation, and staying connected (long, sliding lifetimes, a lost or
// repeated refresh, reconnecting without a second consent). The consent
// decision is made through decideRequest, which the dashboard calls for a
// signed-in user.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-oauth-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'oauth-test-secret-1234567890';

let app: FastifyInstance;
let oauth: typeof import('../mcp/oauth.js');
let tokens: typeof import('../mcp/tokens.js');
let getDb: typeof import('../db/database.js').getDb;
let userId = '';
let user: import('../auth/users.js').User;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const ORIGIN = 'http://localhost:80';

const verifier = 'v'.repeat(20) + randomUUID().replaceAll('-', '');
const challenge = createHash('sha256').update(verifier).digest('base64url');

beforeAll(async () => {
  const users = await import('../auth/users.js');
  const ws = await import('../auth/workspaces.js');
  oauth = await import('../mcp/oauth.js');
  tokens = await import('../mcp/tokens.js');
  getDb = (await import('../db/database.js')).getDb;
  const { registerMcpProtocolRoute } = await import('../mcp/http.js');
  user = users.createUser({ email: `oauth-${randomUUID()}@x.com`, password: 'password123' });
  ws.bootstrapUserWorkspace(user, false);
  userId = user.id;
  app = Fastify();
  oauth.registerMcpOAuthRoutes(app);
  oauth.registerMcpOAuthApiRoutes(app, () => user);
  registerMcpProtocolRoute(app);
  await app.ready();
});

afterAll(async () => { await app?.close(); });

async function register(redirects = [REDIRECT]) {
  const res = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude', redirect_uris: redirects, token_endpoint_auth_method: 'none' } });
  return { status: res.statusCode, body: res.json() as Record<string, string> };
}

async function authorize(clientId: string, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'mcp:read ads:write', ...extra });
  return app.inject({ method: 'GET', url: `/oauth/authorize?${query}` });
}

async function codeFor(clientId: string, scopes = ['mcp:read', 'ads:write']) {
  const res = await authorize(clientId);
  const requestId = new URL(res.headers.location as string, ORIGIN).searchParams.get('request')!;
  const decision = oauth.decideRequest(requestId, user, true, scopes, ORIGIN)!;
  const url = new URL(decision.redirect);
  expect(url.searchParams.get('state')).toBe('xyz');
  return url.searchParams.get('code')!;
}

function tokenRequest(form: Record<string, string>) {
  return app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(form).toString() });
}

describe('MCP OAuth', () => {
  it('advertises itself from the MCP 401 and the well-known documents', async () => {
    const res = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata="http://localhost:80/.well-known/oauth-protected-resource/mcp"');
    const resource = (await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' })).json();
    expect(resource.resource).toBe('http://localhost:80/mcp');
    const server = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(server.code_challenge_methods_supported).toEqual(['S256']);
    expect(server.registration_endpoint).toBe('http://localhost:80/oauth/register');
  });

  it('only registers safe redirect URIs', async () => {
    expect((await register(['http://evil.example.com/cb'])).status).toBe(400);
    expect((await register(['javascript:alert(1)'])).status).toBe(400);
    expect((await register(['http://127.0.0.1:33418/callback'])).status).toBe(201);
    expect((await register(['vscode://anthropic.claude/callback'])).status).toBe(201);
  });

  it('requires S256 PKCE and an exact redirect URI', async () => {
    const { body } = await register();
    const plain = await authorize(body.client_id, { code_challenge_method: 'plain' });
    expect(plain.statusCode).toBe(302);
    expect(plain.headers.location).toContain('error=invalid_request');
    const wrongRedirect = await authorize(body.client_id, { redirect_uri: 'https://claude.ai/other' });
    expect(wrongRedirect.statusCode).toBe(400);
    const ok = await authorize(body.client_id);
    expect(ok.headers.location).toMatch(/^\/oauth\/consent\?request=/);
  });

  it('issues tokens for a correct verifier, once, and they authenticate MCP', async () => {
    const { body } = await register();
    const badCode = await codeFor(body.client_id);
    const bad = await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code: badCode, code_verifier: 'x'.repeat(50), redirect_uri: REDIRECT });
    expect(bad.json().error).toBe('invalid_grant');
    // The code was consumed by the failed attempt.
    expect((await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code: badCode, code_verifier: verifier })).json().error).toBe('invalid_grant');

    const code = await codeFor(body.client_id);
    const res = await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
    expect(res.statusCode).toBe(200);
    const issued = res.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string };
    expect(issued.expires_in).toBe(30 * 86_400);
    expect(issued.scope).toBe('mcp:read ads:write');
    const auth = tokens.authenticateMcpToken(issued.access_token)!;
    expect(auth.userId).toBe(userId);
    expect(auth.scopes.sort()).toEqual(['ads:write', 'mcp:read']);
    // OAuth tokens don't clutter the personal token list.
    expect(tokens.listMcpTokens(userId)).toEqual([]);
    expect(oauth.listConnectedApps(userId).some(a => a.client_name === 'Claude')).toBe(true);
    // Reusing the code fails.
    expect((await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code, code_verifier: verifier })).json().error).toBe('invalid_grant');
  });

  it('changes a connected app\'s access without reconnecting it', async () => {
    const { body } = await register();
    const first = (await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code: await codeFor(body.client_id, ['mcp:read']), code_verifier: verifier })).json() as { access_token: string; refresh_token: string };
    const grant = oauth.listConnectedApps(userId).find(a => a.scopes.join() === 'mcp:read')!;
    expect(oauth.updateConnectedAppScopes('someone-else', grant.id, ['reviews:write'])).toBeNull();
    expect(oauth.updateConnectedAppScopes(userId, grant.id, ['reviews:write', 'not-a-scope'])).toEqual(['mcp:read', 'reviews:write']);
    // The token it holds carries the new access straight away: no refresh, no reconnect.
    expect(tokens.authenticateMcpToken(first.access_token)!.scopes.sort()).toEqual(['mcp:read', 'reviews:write']);
    const renewed = (await tokenRequest({ grant_type: 'refresh_token', client_id: body.client_id, refresh_token: first.refresh_token })).json() as { access_token: string; scope: string };
    expect(renewed.scope).toBe('mcp:read reviews:write');
    expect(tokens.authenticateMcpToken(renewed.access_token)!.scopes.sort()).toEqual(['mcp:read', 'reviews:write']);
  });

  it('tells an assistant which tools are hidden and how a person can allow them', async () => {
    const { serverInstructions } = await import('../mcp/tools.js');
    const readOnly = serverInstructions({ scopes: ['mcp:read'] });
    expect(readOnly).toMatch(/reply to Google reviews, or add Business Profile photos, videos, posts/);
    expect(readOnly).toMatch(/Change access/);
    const full = serverInstructions({ scopes: ['mcp:read', 'mcp:write', 'ads:write', 'reviews:write'] });
    expect(full).not.toMatch(/hidden/);
  });

  it('rotates refresh tokens and revokes the whole grant', async () => {
    const { body } = await register();
    const first = (await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code: await codeFor(body.client_id, ['mcp:read']), code_verifier: verifier })).json() as { access_token: string; refresh_token: string };
    const second = (await tokenRequest({ grant_type: 'refresh_token', client_id: body.client_id, refresh_token: first.refresh_token })).json() as { access_token: string; refresh_token: string; scope: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.scope).toBe('mcp:read');
    // Presented again straight away (a lost reply), the old token gets the same new one back.
    expect((await tokenRequest({ grant_type: 'refresh_token', client_id: body.client_id, refresh_token: first.refresh_token })).json().refresh_token).toBe(second.refresh_token);
    // Another client can't use this refresh token.
    const other = (await register()).body;
    expect((await tokenRequest({ grant_type: 'refresh_token', client_id: other.client_id, refresh_token: second.refresh_token })).json().error).toBe('invalid_grant');

    const revoke = await app.inject({ method: 'POST', url: '/oauth/revoke', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ token: second.refresh_token, client_id: body.client_id }).toString() });
    expect(revoke.statusCode).toBe(200);
    expect(tokens.authenticateMcpToken(second.access_token)).toBeNull();
    expect((await tokenRequest({ grant_type: 'refresh_token', client_id: body.client_id, refresh_token: second.refresh_token })).json().error).toBe('invalid_grant');
    expect((await tokenRequest({ grant_type: 'refresh_token', client_id: body.client_id, refresh_token: first.refresh_token })).json().error).toBe('invalid_grant');
  });

  it('hands back the same new refresh token when the previous one is presented again soon after', async () => {
    const { body } = await register();
    const refresh = (token: string) => tokenRequest({ grant_type: 'refresh_token', client_id: body.client_id, refresh_token: token });
    const first = (await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code: await codeFor(body.client_id, ['mcp:read']), code_verifier: verifier })).json() as { refresh_token: string };
    const second = (await refresh(first.refresh_token)).json() as { access_token: string; refresh_token: string };
    // The reply was lost (a restart mid-request) or two refreshes raced: the old token still works once more…
    const again = (await refresh(first.refresh_token)).json() as { access_token: string; refresh_token: string };
    expect(again.refresh_token).toBe(second.refresh_token);
    expect(tokens.authenticateMcpToken(again.access_token)).not.toBeNull();
    expect(tokens.authenticateMcpToken(second.access_token)).not.toBeNull();
    // …until the token after it has been used.
    const third = (await refresh(second.refresh_token)).json() as { refresh_token: string };
    expect((await refresh(first.refresh_token)).json().error).toBe('invalid_grant');
    expect((await refresh(second.refresh_token)).json().refresh_token).toBe(third.refresh_token);
    // And only for a few minutes.
    getDb().prepare("UPDATE mcp_oauth_grants SET previous_refresh_until='2000-01-01T00:00:00.000Z' WHERE previous_refresh_hash IS NOT NULL").run();
    expect((await refresh(second.refresh_token)).json().error).toBe('invalid_grant');
    expect((await refresh(third.refresh_token)).statusCode).toBe(200);
  });

  it('keeps a connection in use from expiring, but not a personal token with an end date', async () => {
    const { body } = await register();
    const issued = (await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code: await codeFor(body.client_id, ['mcp:read']), code_verifier: verifier })).json() as { access_token: string };
    const soon = new Date(Date.now() + 60_000).toISOString();
    const grantId = (getDb().prepare('SELECT oauth_grant_id AS id FROM mcp_tokens WHERE token_hash=?').get(createHash('sha256').update(issued.access_token).digest('hex')) as { id: string }).id;
    getDb().prepare('UPDATE mcp_tokens SET expires_at=? WHERE oauth_grant_id=?').run(soon, grantId);
    getDb().prepare('UPDATE mcp_oauth_grants SET refresh_expires_at=? WHERE id=?').run(soon, grantId);
    expect(tokens.authenticateMcpToken(issued.access_token)).not.toBeNull();
    const days = (iso: string) => (Date.parse(iso) - Date.now()) / 86_400_000;
    const after = getDb().prepare('SELECT t.expires_at AS access, g.refresh_expires_at AS refresh FROM mcp_tokens t JOIN mcp_oauth_grants g ON g.id = t.oauth_grant_id WHERE g.id=?').get(grantId) as { access: string; refresh: string };
    expect(days(after.access)).toBeGreaterThan(29);
    expect(days(after.refresh)).toBeGreaterThan(89);

    const personal = tokens.createMcpToken({ userId, name: 'expiring', scopes: ['mcp:read'], expiresAt: soon });
    tokens.authenticateMcpToken(personal.token);
    expect((getDb().prepare('SELECT expires_at FROM mcp_tokens WHERE id=?').get(personal.id) as { expires_at: string }).expires_at).toBe(soon);
  });

  it('reconnects an app the person already approved without asking again', async () => {
    const { body } = await register();
    const pending = async () => new URL((await authorize(body.client_id)).headers.location as string, ORIGIN).searchParams.get('request')!;
    const ask = async () => (await app.inject({ method: 'GET', url: `/api/oauth/requests/${await pending()}` })).json() as { previously_granted: string[] | null };
    expect((await ask()).previously_granted).toBeNull();
    await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code: await codeFor(body.client_id, ['mcp:read', 'reviews:write']), code_verifier: verifier });
    expect((await ask()).previously_granted).toEqual(['mcp:read', 'reviews:write']);
    // Another app, or a disconnected one, asks again.
    expect(oauth.previousGrantScopes((await register()).body.client_id, userId)).toBeNull();
    for (const app of oauth.listConnectedApps(userId)) oauth.revokeConnectedApp(userId, app.id);
    expect((await ask()).previously_granted).toBeNull();
  });

  it('sends the person back with access_denied when they decline', async () => {
    const { body } = await register();
    const res = await authorize(body.client_id);
    const requestId = new URL(res.headers.location as string, ORIGIN).searchParams.get('request')!;
    const decision = oauth.decideRequest(requestId, user, false, [], ORIGIN)!;
    expect(decision.redirect).toContain('error=access_denied');
    expect(oauth.decideRequest(requestId, user, true, [], ORIGIN)).toBeNull();
  });

  it('requires the secret for confidential clients', async () => {
    const res = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Server app', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' } });
    const client = res.json() as { client_id: string; client_secret: string };
    expect(client.client_secret).toMatch(/^mcps_/);
    const code = await codeFor(client.client_id);
    expect((await tokenRequest({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier })).statusCode).toBe(401);
    const code2 = await codeFor(client.client_id);
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const ok = await app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` }, payload: new URLSearchParams({ grant_type: 'authorization_code', code: code2, code_verifier: verifier }).toString() });
    expect(ok.statusCode).toBe(200);
  });
});

describe('MCP OAuth redirect allowlist', () => {
  it('narrows registration to the operator\'s allowlist when set', async () => {
    const { validRedirectUri } = await import('../mcp/oauth.js');
    process.env.MCP_OAUTH_REDIRECT_ALLOWLIST = 'claude.ai, *.claude.com, localhost, vscode:';
    try {
      expect(validRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
      expect(validRedirectUri('https://app.claude.com/callback')).toBe(true);
      expect(validRedirectUri('http://localhost:6274/callback')).toBe(true);
      expect(validRedirectUri('vscode://anthropic.claude/cb')).toBe(true);
      expect(validRedirectUri('https://evil.example.com/cb')).toBe(false);
      expect(validRedirectUri('https://claude.ai.evil.com/cb')).toBe(false);
      expect(validRedirectUri('cursor://cb')).toBe(false);
    } finally {
      delete process.env.MCP_OAUTH_REDIRECT_ALLOWLIST;
    }
    expect(validRedirectUri('https://evil.example.com/cb')).toBe(true);
  });
});

describe('MCP OAuth compatibility with other clients', () => {
  it('advertises issuer identification and client metadata documents', async () => {
    const server = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(server.authorization_response_iss_parameter_supported).toBe(true);
    expect(server.client_id_metadata_document_supported).toBe(true);
  });

  it('accepts loopback redirects on any port, as native apps and CLIs use', async () => {
    const res = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Visual Studio Code', redirect_uris: ['https://vscode.dev/redirect', 'http://127.0.0.1:33418/', 'http://127.0.0.1/'] } });
    const { client_id } = res.json() as { client_id: string };
    expect((await authorize(client_id, { redirect_uri: 'http://127.0.0.1:51234/' })).headers.location).toMatch(/^\/oauth\/consent\?request=/);
    // Only the port may differ: another path or host is still rejected.
    expect((await authorize(client_id, { redirect_uri: 'http://127.0.0.1:51234/other' })).statusCode).toBe(400);
    expect((await authorize(client_id, { redirect_uri: 'http://localhost:51234/' })).statusCode).toBe(400);
    expect((await authorize(client_id, { redirect_uri: 'https://vscode.dev:8443/redirect' })).statusCode).toBe(400);
  });

  it('identifies a client by its Client ID Metadata Document', async () => {
    const clientId = 'https://app.example-ai.com/oauth/client.json';
    let served: Record<string, unknown> = { client_id: clientId, client_name: 'Example AI', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' };
    const fetched: string[] = [];
    oauth.__setMetadataFetcherForTests(async url => {
      fetched.push(url);
      return new Response(JSON.stringify(served), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const code = await codeFor(clientId, ['mcp:read']);
    const res = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
    expect(res.statusCode).toBe(200);
    expect(oauth.listConnectedApps(userId).some(a => a.client_name === 'Example AI')).toBe(true);
    // The document is cached rather than fetched on every sign-in.
    await codeFor(clientId, ['mcp:read']);
    expect(fetched.filter(u => u === clientId)).toHaveLength(1);

    // A document whose client_id doesn't match its own URL is refused.
    const other = 'https://evil.example-ai.com/client.json';
    served = { client_id: clientId, redirect_uris: [REDIRECT] };
    const bad = await app.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: other, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })}` });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('does not match its URL');
  });

  it('keeps clients a person registered on the dashboard when cleaning up', async () => {
    const db = (await import('../db/database.js')).getDb();
    const manual = oauth.registerClient({ client_name: 'Copilot Studio', redirect_uris: ['https://global.consent.azure-apim.net/redirect'], token_endpoint_auth_method: 'client_secret_post' }, null, userId);
    const auto = oauth.registerClient({ client_name: 'Stale', redirect_uris: [REDIRECT] }, null);
    db.prepare("UPDATE mcp_oauth_clients SET created_at = datetime('now', '-30 days') WHERE id IN (?, ?)").run(manual.body.client_id, auto.body.client_id);
    oauth.registerClient({ client_name: 'Trigger cleanup', redirect_uris: [REDIRECT] }, null);
    expect(oauth.listManualClients(userId).map(c => c.id)).toContain(manual.body.client_id);
    expect(db.prepare('SELECT 1 FROM mcp_oauth_clients WHERE id=?').get(auto.body.client_id)).toBeUndefined();
  });

  it('lets browser-based clients call /mcp cross-origin with a bearer token', async () => {
    const preflight = await app.inject({ method: 'OPTIONS', url: '/mcp', headers: { origin: 'https://inspector.example', 'access-control-request-method': 'POST' } });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(String(preflight.headers['access-control-allow-headers'])).toContain('Mcp-Protocol-Version');
    const unauth = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(unauth.headers['access-control-expose-headers']).toContain('WWW-Authenticate');
  });
});
