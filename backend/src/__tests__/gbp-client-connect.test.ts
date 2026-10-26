import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

// A client connects their own Google account's Business Profile through the
// agency's approved Cloud project, from a link: the sign-in asks for Business
// Profile only and uses the agency's OAuth client; the connection lands in the
// agency's workspace; only the browser that signed in can list and share the
// client's profiles; revoked links do nothing.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-gbp-connect-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'gbp-connect-test-secret-123456';

type Mods = {
  db: typeof import('../db/database.js');
  users: typeof import('../auth/users.js');
  ws: typeof import('../auth/workspaces.js');
  oauth: typeof import('../auth/google-oauth.js');
  client: typeof import('../reviews/client.js');
  store: typeof import('../reviews/store.js');
  invites: typeof import('../reviews/connect-invites.js');
  routes: typeof import('../reviews/connect-routes.js');
};
let m: Mods;
let app: FastifyInstance;
let agency: { id: string; email: string };
let WS: string;
const AGENCY_CLIENT = '123456789012-agency.apps.googleusercontent.com';
const CLIENT_EMAIL = 'owner@brightsmiles.test';

const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
async function fakeBusinessProfile(url: string): Promise<Response> {
  const u = new URL(url);
  if (u.pathname === '/v1/accounts') return respond({ accounts: [{ name: 'accounts/900', accountName: 'Bright Smiles', type: 'PERSONAL' }] });
  if (u.pathname === '/v1/accounts/900/locations') {
    return respond({ locations: [
      { name: 'locations/1', title: 'Bright Smiles Leeds', storefrontAddress: { addressLines: ['1 Park Row'], locality: 'Leeds' }, metadata: { hasVoiceOfMerchant: true } },
      { name: 'locations/2', title: 'Bright Smiles York', storefrontAddress: { addressLines: ['2 Stonegate'], locality: 'York' }, metadata: { hasVoiceOfMerchant: true } },
    ] });
  }
  if (/^\/v4\/accounts\/900\/locations\/\d\/reviews$/.test(u.pathname)) return respond({ reviews: [], totalReviewCount: 0 });
  return respond({ error: { code: 404, message: 'not found' } }, 404);
}

const ctxHeader = 'x-test-user';
async function call(method: 'GET' | 'POST' | 'DELETE', url: string, opts: { body?: unknown; cookie?: string; asAgency?: boolean } = {}) {
  const res = await app.inject({
    method, url, payload: opts.body as Record<string, unknown> | undefined,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.asAgency ? { [ctxHeader]: agency.id } : {}) },
  });
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, cookie: [res.headers['set-cookie']].flat()[0] as string | undefined };
}

beforeAll(async () => {
  m = {
    db: await import('../db/database.js'),
    users: await import('../auth/users.js'),
    ws: await import('../auth/workspaces.js'),
    oauth: await import('../auth/google-oauth.js'),
    client: await import('../reviews/client.js'),
    store: await import('../reviews/store.js'),
    invites: await import('../reviews/connect-invites.js'),
    routes: await import('../reviews/connect-routes.js'),
  };
  m.client.__setBusinessTransportForTests({ fetcher: fakeBusinessProfile, token: async () => 'test-access-token' });
  const user = m.users.createUser({ email: `agency-${randomUUID()}@agency.test`, password: 'password123' });
  agency = { id: user.id, email: user.email };
  WS = m.ws.bootstrapUserWorkspace(user, false).id;
  // The agency's own connection, through the Cloud project Google approved for Business Profile.
  m.db.upsertGoogleAccount({
    id: 'martflix@agency.test', email: 'martflix@agency.test', client_id: AGENCY_CLIENT, client_secret: 'agency-secret',
    access_token: 'x', refresh_token: 'r', token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    granted_scopes: m.client.BUSINESS_SCOPE, workspace_id: WS, owner_user_id: user.id,
  });
  m.db.shareGoogleAccountWithWorkspace('martflix@agency.test', WS, user.id);

  app = Fastify();
  // Stand-in for the server's session hook: the agency's requests carry a signed-in user.
  app.addHook('preHandler', async (req) => {
    const id = req.headers[ctxHeader];
    if (typeof id === 'string') (req as unknown as { ctx: unknown }).ctx = { user: m.users.getUserById(id), impersonator: null, workspaceId: WS };
  });
  m.routes.registerConnectRoutes(app, { redirectOrigin: () => 'https://seo.agency.test', publicOrigin: () => 'https://seo.agency.test', secureCookies: () => true });
  await app.ready();
});

afterEach(() => { vi.unstubAllGlobals(); });

/** Google's side of the sign-in: the code exchange and the userinfo lookup. */
function stubGoogleSignIn(email: string, scope: string) {
  const seen: Array<{ url: string; body: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    seen.push({ url: String(url), body: String(init.body ?? '') });
    if (String(url) === 'https://oauth2.googleapis.com/token') return respond({ access_token: 'client-access', refresh_token: 'client-refresh', expires_in: 3600, scope });
    if (String(url).startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) return respond({ email });
    return respond({}, 404);
  }));
  return seen;
}

async function finishSignIn(authorizationUrl: string) {
  const state = new URL(authorizationUrl).searchParams.get('state')!;
  const pending = m.oauth.consumeGoogleOAuthState(state)!;
  return m.routes.completeConnectInvite(pending, 'auth-code');
}

describe('client connect links for Business Profile', () => {
  let token = '';
  let cookie = '';

  it('refuses a project the workspace does not have', async () => {
    const res = await call('POST', '/api/reviews/connect-invites', { asAgency: true, body: { projectFrom: 'someone-else@x.test' } });
    expect(res.status).toBe(400);
  });

  it('creates a link through the agency\'s approved project', async () => {
    const res = await call('POST', '/api/reviews/connect-invites', { asAgency: true, body: { projectFrom: 'martflix@agency.test', clientName: 'Bright Smiles Dental', days: 14 } });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'open', client_name: 'Bright Smiles Dental', project: '123456789012', emailed: false });
    expect(res.json.url).toMatch(/^https:\/\/seo\.agency\.test\/connect\/[\w-]{20,}$/);
    token = res.json.url.split('/connect/')[1];
    const page = await call('GET', `/api/connect/${token}`);
    expect(page.json).toMatchObject({ status: 'open', client_name: 'Bright Smiles Dental', can_start: true, can_pick: false, connected_email: null });
    expect(page.json.from).toBe(agency.email);
  });

  it('signs the client in through the agency\'s OAuth client, asking for Business Profile only', async () => {
    const res = await call('POST', `/api/connect/${token}/start`);
    expect(res.status).toBe(200);
    cookie = res.cookie!.split(';')[0];
    expect(res.cookie).toMatch(/HttpOnly; Path=\/api\/connect; SameSite=Lax; .*Secure/);
    const url = new URL(res.json.authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe(AGENCY_CLIENT);
    expect(url.searchParams.get('redirect_uri')).toBe('https://seo.agency.test/api/auth/google/callback');
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toContain(m.client.BUSINESS_SCOPE);
    expect(scopes.some(s => s.includes('webmasters') || s.includes('analytics') || s.includes('adwords'))).toBe(false);

    const seen = stubGoogleSignIn(CLIENT_EMAIL, `${m.client.BUSINESS_SCOPE} https://www.googleapis.com/auth/userinfo.email`);
    const html = await finishSignIn(res.json.authorizationUrl);
    expect(html).toContain(`Connected ${CLIENT_EMAIL}`);
    expect(html).toContain(`/connect/${token}`);
    expect(seen[0].body).toContain(`client_id=${encodeURIComponent(AGENCY_CLIENT)}`);

    // The client's own Google account, owned by the person who made the link, usable in the workspace.
    const conn = m.db.getGoogleAccountsForWorkspace(WS).find(a => a.email === CLIENT_EMAIL)!;
    expect(conn).toBeTruthy();
    expect(conn.client_id).toBe(AGENCY_CLIENT);
    expect(conn.owner_user_id).toBe(agency.id);
  });

  it('lets only the browser that signed in see and share the client\'s profiles', async () => {
    const elsewhere = await call('GET', `/api/connect/${token}`);
    expect(elsewhere.json).toMatchObject({ status: 'connected', can_pick: false, can_start: false, connected_email: null });
    expect((await call('GET', `/api/connect/${token}/locations`)).status).toBe(403);
    expect((await call('GET', `/api/connect/${token}/locations`, { cookie: 'sei_connect=wrong.cookie' })).status).toBe(403);

    const mine = await call('GET', `/api/connect/${token}`, { cookie });
    expect(mine.json).toMatchObject({ can_pick: true, can_start: true, connected_email: CLIENT_EMAIL });
    const listed = await call('GET', `/api/connect/${token}/locations`, { cookie });
    expect(listed.json.locations.map((l: { title: string }) => l.title)).toEqual(['Bright Smiles Leeds', 'Bright Smiles York']);

    const shared = await call('POST', `/api/connect/${token}/locations`, { cookie, body: { locations: [
      { accountName: 'accounts/900', locationName: 'locations/2' },
      { accountName: 'accounts/111', locationName: 'locations/222' },
    ] } });
    expect(shared.json.shared).toEqual(['Bright Smiles York']);
    expect(shared.json.errors).toHaveLength(1);
    const linked = m.store.listLocations(WS);
    expect(linked.map(l => l.title)).toEqual(['Bright Smiles York']);
    expect(linked[0].google_account_id).toBe(m.db.getGoogleAccountsForWorkspace(WS).find(a => a.email === CLIENT_EMAIL)!.id);

    // Once something is shared the link can't start another sign-in.
    expect((await call('GET', `/api/connect/${token}`, { cookie })).json).toMatchObject({ can_start: false, shared: ['Bright Smiles York'] });
    expect((await call('POST', `/api/connect/${token}/start`, { cookie })).status).toBe(409);

    const list = await call('GET', '/api/reviews/connect-invites', { asAgency: true });
    expect(list.json[0]).toMatchObject({ status: 'connected', google_email: CLIENT_EMAIL, shared_locations: ['Bright Smiles York'], url: null });
  });

  it('does nothing for a revoked link, even mid sign-in', async () => {
    const created = await call('POST', '/api/reviews/connect-invites', { asAgency: true, body: { projectFrom: 'martflix@agency.test' } });
    const t = created.json.url.split('/connect/')[1];
    const started = await call('POST', `/api/connect/${t}/start`);
    expect((await call('DELETE', `/api/reviews/connect-invites/${created.json.id}`, { asAgency: true })).status).toBe(200);
    expect((await call('GET', `/api/connect/${t}`)).json).toMatchObject({ status: 'revoked', can_start: false });
    expect((await call('POST', `/api/connect/${t}/start`)).status).toBe(409);

    stubGoogleSignIn('someone@else.test', m.client.BUSINESS_SCOPE);
    const html = await finishSignIn(started.json.authorizationUrl);
    expect(html).toContain('This link no longer works');
    expect(m.db.getGoogleAccountsForWorkspace(WS).some(a => a.email === 'someone@else.test')).toBe(false);
  });

  it('rejects unknown links and stops working when the person who made it loses access', async () => {
    expect((await call('GET', '/api/connect/not-a-real-token')).status).toBe(404);
    const { token: t } = m.invites.createConnectInvite({ workspaceId: WS, userId: agency.id, projectSource: 'martflix@agency.test' });
    m.users.setUserDisabled(agency.id, true);
    try {
      expect((await call('GET', `/api/connect/${t}`)).status).toBe(410);
    } finally {
      m.users.setUserDisabled(agency.id, false);
    }
  });
});
