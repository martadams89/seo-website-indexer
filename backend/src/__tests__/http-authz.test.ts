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
    const login = await req('POST', '/api/auth/login', { body: { email: userEmail, password: 'password123' } });
    expect(login.status).toBe(200);
    const userSid = sidFrom(login)!;
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
