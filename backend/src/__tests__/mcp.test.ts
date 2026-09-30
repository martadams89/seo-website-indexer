import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// MCP server: per-user account-wide tokens (hashed, scoped, revocable) plus a
// tenant-fenced tool surface. We seed two users in two workspaces and assert a
// token only ever sees its owner's data, that scopes gate read vs write, and
// that revocation/expiry kill a token.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-mcp-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'mcp-test-secret-1234567890';

type DbMod = typeof import('../db/database.js');
type UsersMod = typeof import('../auth/users.js');
type WsMod = typeof import('../auth/workspaces.js');
type TokensMod = typeof import('../mcp/tokens.js');
type ToolsMod = typeof import('../mcp/tools.js');

let db: DbMod; let users: UsersMod; let ws: WsMod; let tokens: TokensMod; let tools: ToolsMod;

beforeAll(async () => {
  db = await import('../db/database.js');
  users = await import('../auth/users.js');
  ws = await import('../auth/workspaces.js');
  tokens = await import('../mcp/tokens.js');
  tools = await import('../mcp/tools.js');
});

function seedUserWithSite(label: string) {
  const user = users.createUser({ email: `${label}-${randomUUID()}@x.com`, password: 'password123' });
  const workspace = ws.bootstrapUserWorkspace(user, false);
  const siteId = `site-${randomUUID().slice(0, 8)}`;
  db.upsertSite({
    id: siteId, name: `${label} site`, domain: `${label}.example.com`,
    sitemap_url: `https://${label}.example.com/sitemap.xml`, gsc_url: `https://${label}.example.com/`,
    enabled: 1, workspace_id: workspace.id,
  });
  return { user, workspace, siteId };
}

describe('MCP tokens', () => {
  it('stores only a hash, authenticates the plaintext once, and expands write→read', () => {
    const { user } = seedUserWithSite('alice');
    const { id, token } = tokens.createMcpToken({ userId: user.id, name: 'Cowork', scopes: ['mcp:write'] });
    expect(token.startsWith('seomcp_')).toBe(true);

    // Plaintext is never persisted.
    const stored = db.getDb().prepare('SELECT token_hash FROM mcp_tokens WHERE id=?').get(id) as { token_hash: string };
    expect(stored.token_hash).not.toContain(token);

    const auth = tokens.authenticateMcpToken(token);
    expect(auth?.userId).toBe(user.id);
    expect(auth?.scopes.sort()).toEqual(['mcp:read', 'mcp:write']); // write implies read
    expect(tokens.authenticateMcpToken('seomcp_wrong')).toBeNull();
  });

  it('defaults an unknown/empty scope request to read-only', () => {
    expect(tokens.normalizeScopes([])).toEqual(['mcp:read']);
    expect(tokens.normalizeScopes(['bogus'])).toEqual(['mcp:read']);
    expect(tokens.normalizeScopes(['mcp:write'])).toEqual(['mcp:write']);
  });

  it('revocation and expiry both reject the token', () => {
    const { user } = seedUserWithSite('bob');
    const live = tokens.createMcpToken({ userId: user.id, name: 'live', scopes: ['mcp:read'] });
    expect(tokens.revokeMcpToken(user.id, live.id)).toBe(true);
    expect(tokens.authenticateMcpToken(live.token)).toBeNull();
    // A different user can't revoke someone else's token.
    const other = tokens.createMcpToken({ userId: user.id, name: 'x', scopes: ['mcp:read'] });
    expect(tokens.revokeMcpToken('someone-else', other.id)).toBe(false);

    const expired = tokens.createMcpToken({ userId: user.id, name: 'expired', scopes: ['mcp:read'], expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(tokens.authenticateMcpToken(expired.token)).toBeNull();
  });
});

describe('MCP tools', () => {
  it('list_sites is fenced to the token owner across workspaces', async () => {
    const alice = seedUserWithSite('carol');
    const bob = seedUserWithSite('dave');

    const aCtx = tools.buildContext(tokens.authenticateMcpToken(tokens.createMcpToken({ userId: alice.user.id, name: 't', scopes: ['mcp:read'] }).token)!)!;
    const sites = await tools.runTool(aCtx, 'list_sites', {}) as Array<{ id: string }>;
    const ids = sites.map(s => s.id);
    expect(ids).toContain(alice.siteId);
    expect(ids).not.toContain(bob.siteId); // no cross-tenant leak

    // Cross-tenant site access is refused even by explicit id.
    await expect(tools.runTool(aCtx, 'get_site', { siteId: bob.siteId })).rejects.toThrow(/not found or not accessible/i);
  });

  it('read-only tokens cannot call write tools; the site projection hides FTP secrets', async () => {
    const { user, siteId } = seedUserWithSite('erin');
    db.upsertSite({
      id: siteId, name: 'erin site', domain: 'erin.example.com', sitemap_url: 'https://erin.example.com/sitemap.xml',
      gsc_url: 'https://erin.example.com/', enabled: 1, workspace_id: (ws.accessibleWorkspaces(user)[0].id),
      ftp_pass: 'super-secret-ftp',
    });
    const readCtx = tools.buildContext(tokens.authenticateMcpToken(tokens.createMcpToken({ userId: user.id, name: 'ro', scopes: ['mcp:read'] }).token)!)!;

    // Write tool blocked for a read-only token.
    await expect(tools.runTool(readCtx, 'trigger_indexing_run', { siteId })).rejects.toThrow(/mcp:write/);

    // Only read tools are exposed to a read-only context.
    expect(tools.toolsForContext(readCtx).some(t => t.scope === 'mcp:write')).toBe(false);

    const site = await tools.runTool(readCtx, 'get_site', { siteId }) as Record<string, unknown>;
    expect(JSON.stringify(site)).not.toContain('super-secret-ftp');
    expect(site.domain).toBe('erin.example.com');
  });

  it('a write token exposes action tools and builds a server without throwing', async () => {
    const { user } = seedUserWithSite('frank');
    const writeCtx = tools.buildContext(tokens.authenticateMcpToken(tokens.createMcpToken({ userId: user.id, name: 'rw', scopes: ['mcp:write'] }).token)!)!;
    const names = tools.toolsForContext(writeCtx).map(t => t.name);
    expect(names).toContain('submit_urls_for_indexing');
    expect(names).toContain('trigger_indexing_run');
    expect(names).toContain('list_sites'); // read tools still present (write implies read)
    expect(() => tools.buildMcpServer(writeCtx)).not.toThrow();
  });
});
