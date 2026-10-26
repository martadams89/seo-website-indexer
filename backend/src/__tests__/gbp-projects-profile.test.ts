import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

// A Business Profile on its own Google account or Cloud project, and the
// Business Profile features beyond reviews: the same Google user connected
// through two projects, Business-Profile-only sign-in, moving a location to
// another connection, profile edits, posts, photos and Google-suggested edits
// — each through the location's AI rules — against a fake Google API.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-gbp-projects-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'gbp-projects-secret-1234567890';

type Mods = {
  db: typeof import('../db/database.js');
  users: typeof import('../auth/users.js');
  ws: typeof import('../auth/workspaces.js');
  oauth: typeof import('../auth/google-oauth.js');
  tokens: typeof import('../mcp/tokens.js');
  tools: typeof import('../mcp/tools.js');
  client: typeof import('../reviews/client.js');
  store: typeof import('../reviews/store.js');
  service: typeof import('../reviews/service.js');
  profile: typeof import('../reviews/profile-service.js');
};
let m: Mods;

interface Call { method: string; url: string; body: Record<string, unknown> | null; token: string }
let calls: Call[] = [];
const OLD_PROJECT = '111111111111';
const GBP_PROJECT = '222222222222';
const OLD_CLIENT = `${OLD_PROJECT}-old.apps.googleusercontent.com`;
const GBP_CLIENT = `${GBP_PROJECT}-gbp.apps.googleusercontent.com`;
/** Which connections may reach the location (by access token, see the token seam). */
let reachable = new Set<string>(['token:old', 'token:gbp']);
let location: Record<string, unknown>;
let google: { diffMask: string; pendingMask: string; location: Record<string, unknown> } | null = null;
let posts: Array<Record<string, unknown>> = [];
let media: Array<Record<string, unknown>> = [];

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fakeGoogle(url: string, init: RequestInit): Promise<Response> {
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
  const token = String((init.headers as Record<string, string>).Authorization).replace('Bearer ', '');
  calls.push({ method, url, body, token });
  const u = new URL(url);
  // A Google user who manages no profiles simply sees no accounts.
  if (u.pathname === '/v1/accounts') return respond({ accounts: reachable.has(token) ? [{ name: 'accounts/900', accountName: 'Acme Group', type: 'LOCATION_GROUP' }] : [] });
  if (!reachable.has(token)) return respond({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } }, 403);
  if (u.pathname === '/v1/accounts/900/locations') return respond({ locations: [{ name: 'locations/333', title: 'Acme Roofing', websiteUri: 'https://roof.example/' }] });
  if (u.pathname === '/v4/accounts/900/locations/333/reviews') return respond({ reviews: [], totalReviewCount: 0 });
  if (u.pathname === '/v1/locations/333' && method === 'GET') return respond(location);
  if (u.pathname === '/v1/locations/333' && method === 'PATCH') {
    for (const field of (u.searchParams.get('updateMask') ?? '').split(',')) (location as Record<string, unknown>)[field] = (body as Record<string, unknown>)[field];
    return respond(location);
  }
  if (u.pathname === '/v1/locations/333:getGoogleUpdated') return respond(google ?? { location, diffMask: '', pendingMask: '' });
  if (u.pathname === '/v4/accounts/900/locations/333/localPosts') {
    if (method === 'POST') {
      const created = { ...body, name: `accounts/900/locations/333/localPosts/p${posts.length + 1}`, state: 'LIVE', createTime: new Date().toISOString(), searchUrl: 'https://local.google.com/post' };
      posts.unshift(created);
      return respond(created);
    }
    return respond({ localPosts: posts });
  }
  if (/^\/v4\/accounts\/900\/locations\/333\/localPosts\/p\d+$/.test(u.pathname) && method === 'DELETE') {
    posts = posts.filter(p => p.name !== u.pathname.slice(4));
    return respond({});
  }
  if (u.pathname === '/v4/accounts/900/locations/333/media') {
    if (method === 'POST') {
      const created = { ...body, name: `accounts/900/locations/333/media/m${media.length + 1}`, googleUrl: 'https://lh3.googleusercontent.com/x', createTime: new Date().toISOString() };
      media.unshift(created);
      return respond(created);
    }
    return respond({ mediaItems: media, totalMediaItemCount: media.length });
  }
  return respond({ error: { code: 404, message: `not found: ${method} ${u.pathname}` } }, 404);
}

let owner: { user: ReturnType<Mods['users']['createUser']>; workspaceId: string };
let OLD_ID = '';
let GBP_ID = '';

function ctxFor(userId: string) {
  const { token } = m.tokens.createMcpToken({ userId, name: 't', scopes: ['mcp:read', 'reviews:write'] });
  return m.tools.buildContext(m.tokens.authenticateMcpToken(token)!, 'https://seo.example.com')!;
}

function connect(clientId: string, scopes: string): string {
  const id = m.oauth.connectionIdFor('owner@acme.test', clientId);
  m.db.upsertGoogleAccount({
    id, email: 'owner@acme.test', client_id: clientId, client_secret: 'secret', access_token: 'x', refresh_token: 'refresh',
    token_expiry: new Date(Date.now() + 3_600_000).toISOString(), granted_scopes: scopes, workspace_id: owner.workspaceId, owner_user_id: owner.user.id,
  });
  m.db.shareGoogleAccountWithWorkspace(id, owner.workspaceId, owner.user.id);
  return id;
}

beforeAll(async () => {
  m = {
    db: await import('../db/database.js'),
    users: await import('../auth/users.js'),
    ws: await import('../auth/workspaces.js'),
    oauth: await import('../auth/google-oauth.js'),
    tokens: await import('../mcp/tokens.js'),
    tools: await import('../mcp/tools.js'),
    client: await import('../reviews/client.js'),
    store: await import('../reviews/store.js'),
    service: await import('../reviews/service.js'),
    profile: await import('../reviews/profile-service.js'),
  };
  // Each connection gets its own token, so the fake can tell them apart.
  m.client.__setBusinessTransportForTests({ fetcher: fakeGoogle, token: async id => (id === GBP_ID ? 'token:gbp' : 'token:old') });
  const user = m.users.createUser({ email: `owner-${randomUUID()}@x.com`, password: 'password123' });
  owner = { user, workspaceId: m.ws.bootstrapUserWorkspace(user, false).id };
  location = {
    name: 'locations/333', title: 'Acme Roofing', websiteUri: 'https://roof.example/',
    phoneNumbers: { primaryPhone: '+44 113 496 0000', additionalPhones: ['+44 113 496 0001'] },
    categories: { primaryCategory: { name: 'categories/gcid:roofing_contractor', displayName: 'Roofing contractor' } },
    profile: { description: 'Roofers.' },
    regularHours: { periods: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map(d => ({ openDay: d, openTime: { hours: 8 }, closeDay: d, closeTime: { hours: 17 } })) },
    metadata: { hasVoiceOfMerchant: true, mapsUri: 'https://maps.google.com/?cid=1' },
  };
});

beforeEach(() => { calls = []; });

describe('one Google user, several Cloud projects', () => {
  it('drops the old unique email so a second project can be connected', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE google_accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE, client_id TEXT NOT NULL, client_secret TEXT NOT NULL, refresh_token TEXT NOT NULL, granted_scopes TEXT);
      CREATE TABLE sites (id TEXT PRIMARY KEY, google_account_id TEXT REFERENCES google_accounts(id) ON DELETE SET NULL);
      CREATE TABLE shares (account_id TEXT NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE);
      CREATE INDEX idx_scopes ON google_accounts(granted_scopes);
      INSERT INTO google_accounts VALUES ('a@x.com', 'a@x.com', 'c1', 's', 'r', NULL);
      INSERT INTO sites VALUES ('s1', 'a@x.com');
      INSERT INTO shares VALUES ('a@x.com');
    `);
    m.db.allowGoogleAccountPerProject(db);
    // Nothing that pointed at the account was lost to a cascade.
    expect(db.prepare('SELECT google_account_id FROM sites').get()).toEqual({ google_account_id: 'a@x.com' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM shares').get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_scopes'").get()).toBeTruthy();
    db.prepare("INSERT INTO google_accounts VALUES ('a@x.com~2', 'a@x.com', 'c2', 's', 'r', NULL)").run();
    expect(() => db.prepare("INSERT INTO google_accounts VALUES ('dup', 'a@x.com', 'c2', 's', 'r', NULL)").run()).toThrow(/UNIQUE/);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    m.db.allowGoogleAccountPerProject(db); // a second run is a no-op
  });

  it('keeps one connection per Google user per project', () => {
    OLD_ID = connect(OLD_CLIENT, `${m.oauth.OAUTH_SCOPES} ${m.oauth.GOOGLE_BUSINESS_SCOPE}`);
    expect(OLD_ID).toBe('owner@acme.test');
    expect(m.oauth.connectionIdFor('owner@acme.test', OLD_CLIENT)).toBe(OLD_ID);
    GBP_ID = connect(GBP_CLIENT, m.oauth.BUSINESS_ONLY_SCOPES);
    expect(GBP_ID).toBe(`owner@acme.test~${GBP_PROJECT}`);
    const both = m.db.getGoogleAccountsForWorkspace(owner.workspaceId).filter(a => a.email === 'owner@acme.test');
    expect(both.map(a => a.client_id).sort()).toEqual([OLD_CLIENT, GBP_CLIENT]);
  });

  it('signs a second project in as its own connection, and won\'t let Business-only replace a full one', async () => {
    const signIn = (scope: string) => vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => ({
      ok: true, status: 200,
      json: async () => String(input).includes('/token')
        ? { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope }
        : { email: 'owner@acme.test' },
    }) as unknown as Response));
    try {
      signIn(m.oauth.BUSINESS_ONLY_SCOPES);
      await expect(m.oauth.exchangeCodeForTokens('code', 'https://app.test/cb', owner.workspaceId, owner.user.id, { clientId: OLD_CLIENT, clientSecret: 'secret' }))
        .rejects.toThrow(/with Search Console access, and this sign-in would remove it/);
      expect(m.db.getGoogleAccountById(OLD_ID)!.granted_scopes).toContain('/auth/webmasters');
      const third = `333333333333-x.apps.googleusercontent.com`;
      await m.oauth.exchangeCodeForTokens('code', 'https://app.test/cb', owner.workspaceId, owner.user.id, { clientId: third, clientSecret: 'secret' });
      expect(m.db.getGoogleAccountById('owner@acme.test~333333333333')).toMatchObject({ client_id: third, granted_scopes: m.oauth.BUSINESS_ONLY_SCOPES });
      m.db.deleteGoogleAccount('owner@acme.test~333333333333');
    } finally { vi.unstubAllGlobals(); }
  });

  it('asks only for Business Profile on a Business-Profile-only sign-in', () => {
    const url = new URL(m.oauth.createGoogleOAuthAuthorization({
      userId: owner.user.id, workspaceId: owner.workspaceId, redirectUri: 'https://app.test/api/auth/google/callback',
      clientId: GBP_CLIENT, clientSecret: 'secret', only: ['business'],
    }));
    expect(url.searchParams.get('scope')!.split(' ').sort()).toEqual([m.oauth.GOOGLE_BUSINESS_SCOPE, 'https://www.googleapis.com/auth/userinfo.email'].sort());
  });

  it('shows each project and its approval links in setup', async () => {
    const setup = await m.service.setupStatus(owner.workspaceId, { fresh: true });
    const gbp = setup.connections.find(c => c.id === GBP_ID)!;
    expect(gbp).toMatchObject({ project: GBP_PROJECT, business_only: true, api: 'ok' });
    expect(gbp.links.quotas).toContain(`project=${GBP_PROJECT}`);
    expect(setup.connections.find(c => c.id === OLD_ID)!.business_only).toBe(false);
  });

  it('moves a linked location onto the approved project', async () => {
    const linked = await m.service.linkLocation({ workspaceId: owner.workspaceId, googleAccountId: OLD_ID, accountName: 'accounts/900', locationName: 'locations/333', userId: owner.user.id });
    expect(linked.google_account_id).toBe(OLD_ID);
    const moved = await m.service.moveLocation(linked, GBP_ID);
    expect(moved).toMatchObject({ google_account_id: GBP_ID, account_name: 'accounts/900', last_error: null });
    expect(calls.some(c => c.token === 'token:gbp' && c.url.includes('/reviews'))).toBe(true);
  });

  it('refuses to move a location to a connection that can\'t see it', async () => {
    const loc = m.store.listLocations(owner.workspaceId)[0];
    reachable = new Set(['token:gbp']);
    await expect(m.service.moveLocation(loc, OLD_ID)).rejects.toThrow(/can't see/);
    expect(m.store.getLocation(loc.id)!.google_account_id).toBe(GBP_ID);
    reachable = new Set(['token:old', 'token:gbp']);
  });
});

describe('Business Profile editing, posts and photos', () => {
  const loc = () => m.store.listLocations(owner.workspaceId)[0];

  it('shows the profile with a checklist', async () => {
    const ctx = ctxFor(owner.user.id);
    const result = await m.tools.runTool(ctx, 'business_get_profile', { location: loc().id, fresh: true }) as {
      profile: { primary_phone: string; regular_hours: Array<{ day: string; open: string; close: string }> }; checklist: { score: number; items: Array<{ id: string; status: string }> };
    };
    expect(result.profile.primary_phone).toBe('+44 113 496 0000');
    expect(result.profile.regular_hours[0]).toEqual({ day: 'MONDAY', open: '08:00', close: '17:00' });
    const status = Object.fromEntries(result.checklist.items.map(i => [i.id, i.status]));
    expect(status).toMatchObject({ verified: 'done', description: 'warn', phone: 'done', hours: 'done', photos: 'todo', posts: 'todo' });
    expect(result.checklist.score).toBeGreaterThan(0);
  });

  it('holds an assistant\'s profile edit for approval by default, then publishes it', async () => {
    const ctx = ctxFor(owner.user.id);
    const result = await m.tools.runTool(ctx, 'business_update_profile', {
      location: loc().id, description: 'Family-run roofers covering Leeds and Bradford since 1998.',
      special_hours_add: [{ date: '2026-12-25', closed: true }],
    }) as { status: string; change_id: string; summary: string };
    expect(result.status).toBe('needs_approval');
    expect(result.summary).toMatch(/2026-12-25 closed/);
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
    const approved = await m.profile.approveChange(result.change_id, owner.user);
    expect(approved.status).toBe('published');
    const patch = calls.find(c => c.method === 'PATCH')!;
    expect(new URL(patch.url).searchParams.get('updateMask')).toBe('profile,specialHours');
    expect(patch.body).toMatchObject({ profile: { description: expect.stringMatching(/^Family-run/) }, specialHours: { specialHourPeriods: [{ startDate: { year: 2026, month: 12, day: 25 }, closed: true }] } });
  });

  it('publishes hours in auto mode but always holds phone changes and newly closed days', async () => {
    m.store.updateLocation(loc().id, { profile_rules: { ...loc().profile_rules, profile: 'auto' } });
    const ctx = ctxFor(owner.user.id);
    const week = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map(day => ({ day, open: '08:00', close: '18:00' }));
    const hours = await m.tools.runTool(ctx, 'business_update_profile', { location: loc().id, regular_hours: [...week, { day: 'SATURDAY', open: '09:00', close: '13:00' }] }) as { status: string };
    expect(hours.status).toBe('published');
    const closing = await m.tools.runTool(ctx, 'business_update_profile', { location: loc().id, regular_hours: week.slice(0, 4) }) as { status: string; findings: Array<{ code: string }> };
    expect(closing.status).toBe('needs_approval');
    expect(closing.findings.map(f => f.code)).toContain('closes_days');
    const phone = await m.tools.runTool(ctx, 'business_update_profile', { location: loc().id, primary_phone: '+44 113 496 0999' }) as { status: string; findings: Array<{ code: string }> };
    expect(phone.findings.map(f => f.code)).toContain('phone');
  });

  it('rejects input Google would refuse before recording anything', async () => {
    const ctx = ctxFor(owner.user.id);
    await expect(m.tools.runTool(ctx, 'business_create_post', { location: loc().id, summary: 'Call us on 0113 496 0000 today!' })).rejects.toThrow(/phone number/);
    await expect(m.tools.runTool(ctx, 'business_create_post', { location: loc().id, topic: 'EVENT', summary: 'Open day' })).rejects.toThrow(/title/);
  });

  it('publishes posts in auto mode, always holds offers, and routes deletion through approval', async () => {
    m.store.updateLocation(loc().id, { profile_rules: { ...loc().profile_rules, posts: 'auto' } });
    const ctx = ctxFor(owner.user.id);
    const post = await m.tools.runTool(ctx, 'business_create_post', { location: loc().id, summary: 'Storm damage? We\'re booking repairs this week.', cta_type: 'CALL' }) as { status: string; result: { name: string } };
    expect(post.status).toBe('published');
    expect(calls.find(c => c.method === 'POST' && c.url.endsWith('/localPosts'))?.body).toMatchObject({ topicType: 'STANDARD', callToAction: { actionType: 'CALL' } });
    const offer = await m.tools.runTool(ctx, 'business_create_post', { location: loc().id, topic: 'OFFER', event_title: '10% off gutters', start_date: '2026-11-01', end_date: '2026-11-30' }) as { status: string };
    expect(offer.status).toBe('needs_approval');
    const del = await m.tools.runTool(ctx, 'business_delete_post', { location: loc().id, postName: post.result.name, rationale: 'Repairs fully booked' }) as { status: string; change_id: string };
    expect(del.status).toBe('needs_approval');
    await expect(m.tools.runTool(ctx, 'business_delete_post', { location: loc().id, postName: 'accounts/1/locations/9/localPosts/x', rationale: 'Not ours at all' })).rejects.toThrow(/doesn't belong/);
    expect((await m.profile.approveChange(del.change_id, owner.user)).status).toBe('published');
    expect(posts).toHaveLength(0);
  });

  it('adds photos within the rules and holds new logos', async () => {
    m.store.updateLocation(loc().id, { profile_rules: { ...loc().profile_rules, photos: 'auto' } });
    const ctx = ctxFor(owner.user.id);
    const team = await m.tools.runTool(ctx, 'business_add_photo', { location: loc().id, url: 'https://roof.example/team.jpg', category: 'TEAMS' }) as { status: string };
    expect(team.status).toBe('published');
    expect(calls.find(c => c.method === 'POST' && c.url.endsWith('/media'))?.body).toEqual({ mediaFormat: 'PHOTO', locationAssociation: { category: 'TEAMS' }, sourceUrl: 'https://roof.example/team.jpg' });
    const logo = await m.tools.runTool(ctx, 'business_add_photo', { location: loc().id, url: 'https://roof.example/logo.png', category: 'LOGO' }) as { status: string };
    expect(logo.status).toBe('needs_approval');
  });

  it('blocks everything when the location turns assistants off', async () => {
    m.store.updateLocation(loc().id, { profile_rules: { profile: 'off', posts: 'off', photos: 'off', alert_google_updates: true } });
    const ctx = ctxFor(owner.user.id);
    expect((await m.tools.runTool(ctx, 'business_create_post', { location: loc().id, summary: 'Hello' }) as { status: string }).status).toBe('blocked');
    expect((await m.tools.runTool(ctx, 'business_update_profile', { location: loc().id, description: 'New text for the profile.' }) as { status: string }).status).toBe('blocked');
  });

  it('lets a person on the dashboard publish directly whatever the AI rules say', async () => {
    const change = await m.profile.submitChange({ location: loc(), change: { kind: 'post', post: { summary: 'Now covering Wakefield.' } }, user: owner.user, source: 'dashboard' });
    expect(change.status).toBe('published');
  });

  it('notices Google-suggested edits once, and writes the business\'s version back on request', async () => {
    google = { diffMask: 'websiteUri,title', pendingMask: '', location: { ...location, websiteUri: 'https://spam.example/', title: 'Acme Roofing Leeds Cheap' } };
    location.metadata = { ...(location.metadata as object), hasGoogleUpdated: true };
    const first = await m.profile.checkGoogleUpdates(loc(), { notify: true });
    expect(first.fields).toEqual(['website', 'business name']);
    expect(first.google).toEqual({ website: 'https://spam.example/' });
    const overview = await m.profile.profileOverview(loc());
    expect(overview.checklist.items.find(i => i.id === 'google_updates')?.status).toBe('todo');
    const kept = await m.profile.resolveGoogleUpdates(m.store.getLocation(loc().id)!, 'mine', owner.user);
    expect(kept.status).toBe('published');
    const patch = calls.filter(c => c.method === 'PATCH').pop()!;
    expect(patch.body).toEqual({ websiteUri: 'https://roof.example/' });
  });
});
