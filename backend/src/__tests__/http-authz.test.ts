import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// The real security boundary is the wired-up authorization pre-handler, not just
// the helper functions. This spins up the actual server and proves, over HTTP,
// that a user cannot reach another workspace's site through any site-scoped
// route (they get a 404, indistinguishable from "doesn't exist"). If a future
// refactor drops the guard on a route, this fails loudly.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-httpauthz-'));
const PORT = 8813;
const BASE = `http://localhost:${PORT}`;
let proc: ChildProcess;

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'seo-indexer-ui' };

function sidFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  const m = raw && /sid=([^;]+)/.exec(raw);
  return m ? m[1] : null;
}
async function req(method: string, pathname: string, opts: { sid?: string; ws?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (opts.sid) headers['Cookie'] = `sid=${opts.sid}`;
  if (opts.ws) headers['X-Workspace-Id'] = opts.ws;
  return fetch(`${BASE}${pathname}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
}
async function json<T>(res: Response): Promise<T> { return (await res.json()) as T; }

beforeAll(async () => {
  proc = spawn('node', ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: TMP, APP_SECRET: 'http-authz-secret-123', PORT: String(PORT), LOG_LEVEL: 'silent' },
    stdio: 'ignore',
  });
  // Wait for the server to accept connections.
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/healthz`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('server did not start in time');
}, 30_000);

afterAll(() => { proc?.kill('SIGKILL'); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('cross-tenant HTTP authorization', () => {
  it('404s a user hitting another workspace\'s site across every scoped route', async () => {
    // Admin (first user / super-admin).
    const adminEmail = `admin-${randomUUID()}@x.com`;
    const signup = await req('POST', '/api/auth/signup', { body: { email: adminEmail, password: 'password123' } });
    expect(signup.status).toBe(200);
    const adminSid = sidFrom(signup)!;
    const adminUser = await json<{ id: string }>(signup);
    expect(adminSid).toBeTruthy();

    const adminWs = (await json<Array<{ id: string }>>(await req('GET', '/api/workspaces', { sid: adminSid })))[0].id;

    // Admin creates a site in their workspace.
    const create = await req('POST', '/api/sites', {
      sid: adminSid, ws: adminWs,
      body: { name: 'Admin Site', domain: 'adminsite.com', sitemapUrl: 'https://adminsite.com/sitemap.xml', gscUrl: 'https://adminsite.com/' },
    });
    expect(create.status).toBe(200);
    const siteId = (await json<{ id: string }>(create)).id;

    // Admin adds a second, regular user, who logs in and gets their own workspace.
    const userEmail = `user-${randomUUID()}@x.com`;
    const mk = await req('POST', '/api/users', { sid: adminSid, body: { email: userEmail, password: 'password123' } });
    expect(mk.status).toBe(200);
    const createdUser = await json<{ id: string }>(mk);
    const login = await req('POST', '/api/auth/login', { body: { email: userEmail, password: 'password123' } });
    expect(login.status).toBe(200);
    const userSid = sidFrom(login)!;
    expect((await req('POST', '/api/auth/set-required-password', { sid: userSid, body: { newPassword: 'password456' } })).status).toBe(200);
    const userWs = (await json<Array<{ id: string }>>(await req('GET', '/api/workspaces', { sid: userSid })))[0].id;
    expect(userWs).not.toBe(adminWs);

    // The regular user must NOT be able to touch the admin's site via any route.
    for (const route of [
      { method: 'GET', path: `/api/sites/${siteId}/urls` },
      { method: 'GET', path: `/api/analytics/site/${siteId}` },
      { method: 'GET', path: `/api/performance/${siteId}?days=7` },
      { method: 'PUT', path: `/api/sites/${siteId}`, body: { name: 'hijacked' } },
      { method: 'DELETE', path: `/api/sites/${siteId}` },
    ]) {
      const res = await req(route.method, route.path, { sid: userSid, ws: userWs, body: (route as { body?: unknown }).body });
      expect(res.status, `${route.method} ${route.path} should be 404 for a foreign tenant`).toBe(404);
    }

    // …and the site is untouched + still visible to its owner.
    const ownerView = await req('GET', `/api/analytics/site/${siteId}`, { sid: adminSid, ws: adminWs });
    expect(ownerView.status).toBe(200);
    const stillThere = await json<Array<{ id: string; name: string }>>(await req('GET', '/api/sites', { sid: adminSid, ws: adminWs }));
    expect(stillThere.find(s => s.id === siteId)?.name).toBe('Admin Site');

    // The user's own workspace remains empty (no leakage the other way).
    const userSites = await json<unknown[]>(await req('GET', '/api/sites', { sid: userSid, ws: userWs }));
    expect(userSites).toHaveLength(0);

    // AI provider configuration and prompt conversations are tenant data too.
    expect((await req('PUT', '/api/workspace/keys', { sid: adminSid, ws: adminWs, body: { openai_api_key: 'admin-only-key' } })).status).toBe(200);
    const adminProviders = await json<{ configured: string[] }>(await req('GET', '/api/ai/providers', { sid: adminSid, ws: adminWs }));
    const userProviders = await json<{ configured: string[] }>(await req('GET', '/api/ai/providers', { sid: userSid, ws: userWs }));
    expect(adminProviders.configured).toContain('openai');
    expect(userProviders.configured).not.toContain('openai');
    const createPrompt = await req('POST', '/api/ai/prompts', { sid: adminSid, ws: adminWs, body: { prompt: 'private agency prompt', site_id: siteId, category: 'commercial' } });
    expect(createPrompt.status).toBe(200);
    const promptId = (await json<{ id: number }>(createPrompt)).id;
    expect(await json<unknown[]>(await req('GET', `/api/ai/prompts/${promptId}/thread/openai`, { sid: userSid, ws: userWs }))).toEqual([]);
    expect((await req('POST', `/api/ai/run/${promptId}`, { sid: userSid, ws: userWs })).status).toBe(404);
    expect((await req('POST', `/api/ai/prompts/${promptId}/reply`, { sid: userSid, ws: userWs, body: { provider: 'openai', message: 'leak it' } })).status).toBe(404);

    // Super-admin can attach an existing user to another workspace and inspect
    // their complete tenant/security profile.
    const addMember = await req('POST', `/api/workspaces/${adminWs}/members`, {
      sid: adminSid, ws: adminWs, body: { email: userEmail, role: 'editor', ai_citations: true },
    });
    expect(addMember.status).toBe(200);
    const detail = await json<{ workspaces: Array<{ workspace_id: string; role: string; permissions: Record<string, boolean> }> }>(
      await req('GET', `/api/admin/users/${createdUser.id}`, { sid: adminSid, ws: adminWs }),
    );
    const adminAccess = detail.workspaces.find(w => w.workspace_id === adminWs);
    expect(adminAccess?.role).toBe('editor');
    expect(adminAccess?.permissions.manage_integrations).toBe(true);

    // Editors operate normal workspace features by default; route-local owner
    // checks must not accidentally override their granted capabilities.
    expect((await req('PUT', '/api/workspace/keys', { sid: userSid, ws: adminWs, body: { perplexity_api_key: 'editor-key' } })).status).toBe(200);
    expect((await req('PUT', '/api/notifications/config', { sid: userSid, ws: adminWs, body: { notify_run_complete: 'false' } })).status).toBe(200);
    expect((await req('PUT', '/api/ai/models', { sid: userSid, ws: adminWs, body: { model_openai: 'gpt-test' } })).status).toBe(200);
    expect((await json<{ metrics: { sites: number } }>(await req('GET', '/api/command-center', { sid: userSid, ws: adminWs }))).metrics.sites).toBe(1);

    // The normalized platform APIs preserve the same tenancy boundary. An
    // editor can operate the workspace, while secrets and records never leak
    // to the user's separate workspace.
    const integration = await req('POST', '/api/platform/integrations', {
      sid: userSid, ws: adminWs,
      body: { provider: 'cloudflare', name: 'Admin edge', config: { api_token: 'edge-secret', zone_id: 'zone-1' } },
    });
    expect(integration.status).toBe(200);
    const publicConnector = await json<{ config: Record<string, unknown>; configured_secrets: string[] }>(integration);
    expect(publicConnector.config).toEqual({ zone_id: 'zone-1' });
    expect(publicConnector.configured_secrets).toEqual(['api_token']);
    expect(await json<unknown[]>(await req('GET', '/api/platform/integrations', { sid: userSid, ws: userWs }))).toHaveLength(0);

    const work = await req('POST', '/api/platform/work-items', {
      sid: userSid, ws: adminWs, body: { site_id: siteId, page_url: 'https://adminsite.com/pricing',
        title: 'Review organic visibility movement', severity: 'high', assignee_user_id: createdUser.id },
    });
    expect(work.status).toBe(200);
    const workItem = await json<{ id: string; status: string; site_name: string; page_url: string; evidence: Record<string, unknown> }>(work);
    expect(workItem).toMatchObject({ site_name: 'Admin Site', page_url: 'https://adminsite.com/pricing' });
    const fixed = await req('POST', `/api/platform/work-items/${workItem.id}/remediation`, {
      sid: userSid, ws: adminWs, body: { action: 'mark_fixed', note: 'Production change deployed' },
    });
    expect(fixed.status).toBe(200);
    const fixedItem = (await json<{ item: { status: string; evidence: { remediation: { fix_status: string; note: string } } } }>(fixed)).item;
    expect(fixedItem.status).toBe('in_progress');
    expect(fixedItem.evidence.remediation).toMatchObject({ fix_status: 'deployed', note: 'Production change deployed' });
    expect((await req('POST', `/api/platform/work-items/${workItem.id}/remediation`, {
      sid: userSid, ws: adminWs, body: { action: 'google_validate' },
    })).status).toBe(422);
    expect((await req('POST', `/api/platform/work-items/${workItem.id}/remediation`, {
      sid: userSid, ws: userWs, body: { action: 'resolve' },
    })).status).toBe(404);
    expect(await json<unknown[]>(await req('GET', '/api/platform/work-items', { sid: userSid, ws: userWs }))).toHaveLength(0);

    // Service tokens are one-time plaintext credentials, scoped to both a
    // workspace and operation. They never inherit the caller's other tenants.
    const tokenResult = await json<{ id: string; token: string }>(await req('POST', '/api/platform/tokens', {
      sid: userSid, ws: adminWs, body: { name: 'Reporting automation', scopes: ['workspace:read', 'events:write'] },
    }));
    expect((await req('POST', '/api/platform/tokens', {
      sid: userSid, ws: adminWs, body: { name: 'Over-broad token', scopes: ['*'] },
    })).status).toBe(400);
    const tokenHeaders = { Authorization: `Bearer ${tokenResult.token}`, 'Content-Type': 'application/json' };
    const tokenOverview = await fetch(`${BASE}/api/v1/workspace`, { headers: tokenHeaders });
    expect(tokenOverview.status).toBe(200);
    expect((await json<{ integrations: Array<{ provider: string }> }>(tokenOverview)).integrations.some(row => row.provider === 'cloudflare')).toBe(true);
    expect((await fetch(`${BASE}/api/v1/metrics`, { headers: tokenHeaders })).status).toBe(401);
    expect((await fetch(`${BASE}/api/v1/events`, { method: 'POST', headers: tokenHeaders,
      body: JSON.stringify({ source: 'rank_feed', metric: 'position', dimension: 'commercial keyword', value: 3 }) })).status).toBe(202);

    // Individual capability changes take effect immediately at the HTTP
    // boundary without removing the member from the workspace.
    expect((await req('PATCH', `/api/workspaces/${adminWs}/members/${createdUser.id}`, {
      sid: adminSid, ws: adminWs, body: { permissions: { manage_content: false } },
    })).status).toBe(200);
    expect((await req('POST', '/api/platform/work-items', { sid: userSid, ws: adminWs, body: { title: 'Blocked mutation' } })).status).toBe(403);
    expect((await req('PATCH', `/api/workspaces/${adminWs}/members/${createdUser.id}`, {
      sid: adminSid, ws: adminWs, body: { permissions: { manage_content: true } },
    })).status).toBe(200);
    expect((await req('POST', '/api/platform/work-items', { sid: userSid, ws: adminWs, body: { title: 'Allowed mutation' } })).status).toBe(200);

    // A per-member override is enforced by the HTTP pre-handler.
    expect((await req('PATCH', `/api/workspaces/${adminWs}/members/${createdUser.id}`, { sid: adminSid, ws: adminWs, body: { permissions: { manage_notifications: false } } })).status).toBe(200);
    expect((await req('PUT', '/api/notifications/config', { sid: userSid, ws: adminWs, body: { notify_run_complete: 'true' } })).status).toBe(403);
    expect((await req('PATCH', `/api/workspaces/${adminWs}/members/${createdUser.id}`, { sid: adminSid, ws: adminWs, body: { ai_citations: false } })).status).toBe(200);
    expect((await req('POST', '/api/ai/prompts', { sid: userSid, ws: adminWs, body: { prompt: 'should be blocked' } })).status).toBe(403);

    // Impersonation uses a dedicated session that remembers the actor and can
    // safely return to the super-admin without knowing either password.
    const impersonate = await req('POST', `/api/admin/users/${createdUser.id}/impersonate`, { sid: adminSid, ws: adminWs });
    expect(impersonate.status).toBe(200);
    const impersonatedSid = sidFrom(impersonate)!;
    const asUser = await json<{ id: string; impersonation: { actor: { id: string } } }>(await req('GET', '/api/auth/me', { sid: impersonatedSid, ws: adminWs }));
    expect(asUser.id).toBe(createdUser.id);
    expect(asUser.impersonation.actor.id).toBe(adminUser.id);
    const stop = await req('POST', '/api/auth/impersonation/stop', { sid: impersonatedSid, ws: adminWs });
    expect(stop.status).toBe(200);
    const restoredSid = sidFrom(stop)!;
    expect((await req('GET', '/api/users', { sid: restoredSid, ws: adminWs })).status).toBe(200);

    // Generated passwords revoke old sessions and require replacement.
    const generated = await req('POST', `/api/admin/users/${createdUser.id}/generate-password`, { sid: restoredSid, ws: adminWs });
    expect(generated.status).toBe(200);
    const temporaryPassword = (await json<{ temporaryPassword: string }>(generated)).temporaryPassword;
    expect((await req('GET', '/api/auth/me', { sid: userSid, ws: userWs })).status).toBe(401);
    const tempLogin = await req('POST', '/api/auth/login', { body: { email: userEmail, password: temporaryPassword } });
    expect(tempLogin.status).toBe(200);
    expect((await json<{ must_change_password: boolean }>(tempLogin)).must_change_password).toBe(true);
  });

  it('rate-limits repeated bad logins', async () => {
    let sawTooMany = false;
    for (let i = 0; i < 25; i++) {
      const r = await req('POST', '/api/auth/login', { body: { email: 'nobody@x.com', password: 'wrong' } });
      if (r.status === 429) { sawTooMany = true; break; }
    }
    expect(sawTooMany).toBe(true);
  });
});
