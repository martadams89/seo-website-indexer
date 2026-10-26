import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// One workspace, several Google users and Cloud projects for different jobs:
// limited (Ads-only or Business-Profile-only) sign-ins, reusing a project's
// OAuth client without re-entering it, refusing sign-ins that would strip
// access from an existing connection, and moving an Ads client onto the
// connection whose project has the access level and quota it needs.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-google-projects-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'google-projects-secret-1234567890';

type Mods = {
  db: typeof import('../db/database.js');
  users: typeof import('../auth/users.js');
  ws: typeof import('../auth/workspaces.js');
  oauth: typeof import('../auth/google-oauth.js');
  health: typeof import('../auth/google-health.js');
  client: typeof import('../ads/client.js');
  store: typeof import('../ads/store.js');
  setup: typeof import('../ads/setup.js');
};
let m: Mods;
let owner: { userId: string; workspaceId: string };

const SC_CLIENT = '111111111111-sc.apps.googleusercontent.com';
const ADS_CLIENT = '444444444444-ads.apps.googleusercontent.com';
const WEBMASTERS = 'https://www.googleapis.com/auth/webmasters';

function connect(email: string, clientId: string, scopes: string): string {
  const id = m.oauth.connectionIdFor(email, clientId);
  m.db.upsertGoogleAccount({
    id, email, client_id: clientId, client_secret: `secret-${clientId}`, access_token: 'x', refresh_token: 'r',
    token_expiry: new Date(Date.now() + 3_600_000).toISOString(), granted_scopes: scopes, workspace_id: owner.workspaceId, owner_user_id: owner.userId,
  });
  m.db.shareGoogleAccountWithWorkspace(id, owner.workspaceId, owner.userId);
  return id;
}

/** Which ad accounts each connection (by token) can query, and through which manager. */
const reach: Record<string, Record<string, string | null>> = {
  'token:sc': {},
  'token:ads': { '7777777777': '9999999999' },
};
let tokenFor: Record<string, string> = {};

async function fakeAds(url: string, init: RequestInit): Promise<Response> {
  const token = String((init.headers as Record<string, string>).Authorization).replace('Bearer ', '');
  const login = (init.headers as Record<string, string>)['login-customer-id'] ?? null;
  const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith('customers:listAccessibleCustomers')) {
    return respond({ resourceNames: [...new Set(Object.values(reach[token] ?? {}).map(m => m ?? ''))].filter(Boolean).map(id => `customers/${id}`) });
  }
  const customer = /customers\/(\d+)\/googleAds:search/.exec(url)?.[1];
  const body = init.body ? JSON.parse(String(init.body)) as { query: string } : { query: '' };
  if (customer && /FROM customer_client/.test(body.query)) {
    const clients = Object.entries(reach[token] ?? {}).filter(([, via]) => via === customer)
      .map(([id]) => ({ customerClient: { id, descriptiveName: 'Roofing Ads', level: 1, currencyCode: 'GBP' } }));
    return respond({ results: [{ customerClient: { id: customer, level: 0, manager: true } }, ...clients] });
  }
  if (customer && (reach[token]?.[customer] === undefined || reach[token][customer] !== login)) {
    return respond({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'User doesn\'t have permission to access customer.', details: [{ errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' } }] }] } }, 403);
  }
  return respond({ results: [{ customer: { id: customer, descriptiveName: 'Roofing Ads', currencyCode: 'GBP', timeZone: 'Europe/London' } }] });
}

beforeAll(async () => {
  m = {
    db: await import('../db/database.js'),
    users: await import('../auth/users.js'),
    ws: await import('../auth/workspaces.js'),
    oauth: await import('../auth/google-oauth.js'),
    health: await import('../auth/google-health.js'),
    client: await import('../ads/client.js'),
    store: await import('../ads/store.js'),
    setup: await import('../ads/setup.js'),
  };
  const user = m.users.createUser({ email: `owner-${randomUUID()}@x.com`, password: 'password123' });
  owner = { userId: user.id, workspaceId: m.ws.bootstrapUserWorkspace(user, false).id };
  m.client.__setAdsTransportForTests({ fetcher: fakeAds, token: async id => tokenFor[id] ?? 'token:none' });
});

describe('limited connections', () => {
  it('names what a grant is limited to', () => {
    expect(m.oauth.limitedTo(`${WEBMASTERS} ${m.oauth.GOOGLE_ADS_SCOPE}`)).toBeNull();
    expect(m.oauth.limitedTo(m.oauth.ADS_ONLY_SCOPES)).toEqual(['ads']);
    expect(m.oauth.limitedTo(m.oauth.limitedScopes(['business', 'ads']))).toEqual(['ads', 'business']);
    expect(m.oauth.limitedTo(null)).toBeNull();
  });

  it('asks only for Google Ads, and keeps a limit when another product is added', () => {
    const scopes = (opts: Parameters<typeof m.oauth.createGoogleOAuthAuthorization>[0]) => new URL(m.oauth.createGoogleOAuthAuthorization(opts)).searchParams.get('scope')!.split(' ').sort();
    const base = { userId: owner.userId, workspaceId: owner.workspaceId, redirectUri: 'https://app.test/cb', clientId: ADS_CLIENT, clientSecret: 's' };
    expect(scopes({ ...base, only: ['ads'] })).toEqual(m.oauth.ADS_ONLY_SCOPES.split(' ').sort());
    expect(scopes({ ...base, only: ['business'], ads: true })).toEqual(m.oauth.limitedScopes(['ads', 'business']).split(' ').sort());
    expect(scopes({ ...base, only: [] })).toContain(WEBMASTERS);
  });

  it('refuses a sign-in that would take Google Ads away from a connection', async () => {
    const id = connect('ads@agency.test', SC_CLIENT, `${m.oauth.OAUTH_SCOPES} ${m.oauth.GOOGLE_ADS_SCOPE}`);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => ({
      ok: true, status: 200,
      json: async () => String(input).includes('/token') ? { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: m.oauth.OAUTH_SCOPES } : { email: 'ads@agency.test' },
    }) as unknown as Response));
    try {
      await expect(m.oauth.exchangeCodeForTokens('code', 'https://app.test/cb', owner.workspaceId, owner.userId, { clientId: SC_CLIENT, clientSecret: 's' }))
        .rejects.toThrow(/with Google Ads access, and this sign-in would remove it/);
      expect(m.db.getGoogleAccountById(id)!.granted_scopes).toContain('/auth/adwords');
    } finally { vi.unstubAllGlobals(); m.db.deleteGoogleAccount(id); }
  });
});

describe('several projects in one workspace', () => {
  let SC_ID = '';
  let ADS_ID = '';

  it('lists each project once, with what its connections are used for', () => {
    SC_ID = connect('owner@acme.test', SC_CLIENT, `${m.oauth.OAUTH_SCOPES} ${m.oauth.GOOGLE_ADS_SCOPE}`);
    ADS_ID = connect('owner@acme.test', ADS_CLIENT, m.oauth.ADS_ONLY_SCOPES);
    tokenFor = { [SC_ID]: 'token:sc', [ADS_ID]: 'token:ads' };
    const projects = m.health.googleProjects(owner.workspaceId, owner.userId);
    expect(projects.map(p => p.project).sort()).toEqual(['111111111111', '444444444444']);
    const ads = projects.find(p => p.project === '444444444444')!;
    expect(ads.source_id).toBe(ADS_ID);
    expect(ads.connections[0]).toMatchObject({ email: 'owner@acme.test', limited_to: ['ads'], in_workspace: true });
  });

  it('moves an Ads client to the connection that can reach it through its manager', async () => {
    const acct = m.store.linkAdsAccount({ workspaceId: owner.workspaceId, googleAccountId: SC_ID, customerId: '7777777777', name: 'Roofing Ads' });
    const moved = await m.setup.moveAdsAccount(acct, ADS_ID, owner.userId);
    expect(moved).toMatchObject({ id: acct.id, google_account_id: ADS_ID, login_customer_id: '9999999999' });
    expect(m.health.connectionUsage(m.db.getGoogleAccountById(ADS_ID)!).ads_clients).toBe(1);
  });

  it('refuses to move a client to a connection that can\'t reach it', async () => {
    const acct = m.store.getAdsAccount(m.store.listAdsAccounts(owner.workspaceId)[0].id)!;
    await expect(m.setup.moveAdsAccount(acct, SC_ID, owner.userId)).rejects.toThrow(/can't reach ad account 777-777-7777/);
    expect(m.store.getAdsAccount(acct.id)!.google_account_id).toBe(ADS_ID);
  });

  it('shows the limit, client count and the project\'s own console links in Ads setup', async () => {
    const setup = await m.setup.setupStatus(owner.workspaceId, { fresh: true });
    const ads = setup.connections.find(c => c.id === ADS_ID)!;
    expect(ads).toMatchObject({ limited_to: ['ads'], clients: 1, project: '444444444444' });
    expect(ads.links.access_level).toContain('project=444444444444');
  });
});
