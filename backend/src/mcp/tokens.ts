/**
 * mcp/tokens.ts — account-wide personal access tokens for the MCP server.
 *
 * These differ from the workspace-scoped `service_tokens` (platform automation):
 * an MCP token belongs to a USER and lets an AI assistant reach every workspace
 * that user can access. Only the SHA-256 hash is persisted; the plaintext is
 * shown once at creation and never again — exactly like a GitHub PAT.
 */
import { createHash, randomBytes, randomUUID } from 'crypto';
import { getDb } from '../db/database.js';

/** Scopes an MCP token can carry. `mcp:read` = read data; `mcp:write` = safe actions. */
export const MCP_SCOPES = ['mcp:read', 'mcp:write'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** Human-visible prefix so a leaked token is easy to recognise and revoke. */
const TOKEN_PREFIX = 'seomcp_';

export interface McpTokenRow {
  id: string;
  user_id: string;
  name: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function parseScopes(value: unknown): string[] {
  try { const p = JSON.parse(String(value)); return Array.isArray(p) ? p.map(String) : []; }
  catch { return []; }
}

/** Keep only recognised scopes; default to read-only when nothing valid is asked for. */
export function normalizeScopes(requested: unknown): McpScope[] {
  const wanted = Array.isArray(requested) ? requested.map(String) : [];
  const valid = MCP_SCOPES.filter(s => wanted.includes(s));
  return valid.length ? valid : ['mcp:read'];
}

/**
 * Mint a new token. Returns the row id and the ONE-TIME plaintext token; only
 * its hash is stored. `mcp:write` implies `mcp:read` at authentication time.
 */
export function createMcpToken(input: {
  userId: string;
  name: string;
  scopes: McpScope[];
  expiresAt?: string | null;
}): { id: string; token: string } {
  const id = randomUUID();
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  getDb()
    .prepare('INSERT INTO mcp_tokens(id, user_id, name, token_hash, scopes, expires_at) VALUES(?,?,?,?,?,?)')
    .run(id, input.userId, input.name.trim() || 'MCP token', hashToken(token), JSON.stringify(input.scopes), input.expiresAt ?? null);
  return { id, token };
}

/** Token metadata for a user (never the hash or plaintext). */
export function listMcpTokens(userId: string): McpTokenRow[] {
  return (getDb()
    .prepare('SELECT id,user_id,name,scopes,expires_at,last_used_at,revoked_at,created_at FROM mcp_tokens WHERE user_id=? ORDER BY created_at DESC')
    .all(userId) as Array<Record<string, unknown>>)
    .map(row => ({ ...row, scopes: parseScopes(row.scopes) })) as McpTokenRow[];
}

/** Revoke one of the user's own tokens. Returns false if it wasn't theirs / already gone. */
export function revokeMcpToken(userId: string, id: string): boolean {
  return getDb()
    .prepare("UPDATE mcp_tokens SET revoked_at=datetime('now') WHERE id=? AND user_id=? AND revoked_at IS NULL")
    .run(id, userId).changes > 0;
}

export interface McpTokenAuth { id: string; userId: string; scopes: McpScope[] }

/**
 * Validate a raw bearer token. Returns the owning user + granted scopes, or null
 * when the token is unknown, revoked or expired. Bumps last_used_at on success.
 * `mcp:write` grants `mcp:read` too, and `*` grants everything.
 */
export function authenticateMcpToken(raw: string): McpTokenAuth | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hash = hashToken(trimmed);
  const row = getDb().prepare(
    `SELECT id,user_id,scopes FROM mcp_tokens
       WHERE token_hash=? AND revoked_at IS NULL
         AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))`
  ).get(hash) as { id: string; user_id: string; scopes: string } | undefined;
  if (!row) return null;
  getDb().prepare("UPDATE mcp_tokens SET last_used_at=datetime('now') WHERE token_hash=?").run(hash);

  const stored = parseScopes(row.scopes);
  const scopes = new Set<McpScope>();
  if (stored.includes('*') || stored.includes('mcp:read') || stored.includes('mcp:write')) scopes.add('mcp:read');
  if (stored.includes('*') || stored.includes('mcp:write')) scopes.add('mcp:write');
  return { id: row.id, userId: row.user_id, scopes: [...scopes] };
}

/** True when the authenticated token carries the required scope. */
export function tokenHasScope(auth: McpTokenAuth, scope: McpScope): boolean {
  return auth.scopes.includes(scope);
}
