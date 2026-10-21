import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// GA4 alongside Google Ads: linking a property to a client (verified against
// Google), the paid-search report the routine uses, the MCP tools and their
// fencing, and the routine prompt. Google is stubbed.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-ads-ga4-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'ads-ga4-secret-1234567890';

type Mods = {
  db: typeof import('../db/database.js');
  users: typeof import('../auth/users.js');
  ws: typeof import('../auth/workspaces.js');
  oauth: typeof import('../auth/google-oauth.js');
  store: typeof import('../ads/store.js');
  link: typeof import('../ads/ga4-link.js');
  tokens: typeof import('../mcp/tokens.js');
  tools: typeof import('../mcp/tools.js');
  routine: typeof import('../ads/routine-prompt.js');
};
let m: Mods;

beforeAll(async () => {
  m = {
    db: await import('../db/database.js'),
    users: await import('../auth/users.js'),
    ws: await import('../auth/workspaces.js'),
    oauth: await import('../auth/google-oauth.js'),
    store: await import('../ads/store.js'),
    link: await import('../ads/ga4-link.js'),
    tokens: await import('../mcp/tokens.js'),
    tools: await import('../mcp/tools.js'),
    routine: await import('../ads/routine-prompt.js'),
  };
});

afterEach(() => vi.unstubAllGlobals());

function seedClient(label: string) {
  const user = m.users.createUser({ email: `${label}-${randomUUID()}@x.com`, password: 'password123' });
  const workspaceId = m.ws.bootstrapUserWorkspace(user, false).id;
  const login = `${label}-${randomUUID().slice(0, 6)}@agency.test`;
  m.db.upsertGoogleAccount({
    id: login, email: login, client_id: '123456789012-abc.apps.googleusercontent.com', client_secret: 'secret',
    access_token: 'x', refresh_token: 'refresh', token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    granted_scopes: `${m.oauth.OAUTH_SCOPES} ${m.oauth.GOOGLE_ADS_SCOPE}`, workspace_id: workspaceId, owner_user_id: user.id,
  });
  m.db.shareGoogleAccountWithWorkspace(login, workspaceId, user.id);
  const account = m.store.linkAdsAccount({ workspaceId, googleAccountId: login, customerId: String(Math.floor(1e9 + Math.random() * 8e9)), name: `${label} client` });
  return { user, workspaceId, login, account };
}

function ctxFor(userId: string, scopes: Array<'mcp:read' | 'mcp:write' | 'ads:write'>) {
  const { token } = m.tokens.createMcpToken({ userId, name: 't', scopes });
  return m.tools.buildContext(m.tokens.authenticateMcpToken(token)!, 'https://seo.example.com')!;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/** A fake GA4: the property 449058214 is readable; anything else is 403. */
function fakeGa4(requests: Array<{ url: string; body: Record<string, unknown> | null }> = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, body });
    if (!url.includes('449058214')) return json({ error: { code: 403, message: 'User does not have sufficient permissions for this property.' } }, 403);
    if (url.includes('analyticsadmin')) return json({ name: 'properties/449058214', displayName: 'WeatherWise GA4' });
    const dims = ((body?.dimensions ?? []) as Array<{ name: string }>).map(d => d.name);
    const mets = ((body?.metrics ?? []) as Array<{ name: string }>).map(x => x.name);
    const previous = String((body?.dateRanges as Array<{ startDate: string }>)[0].startDate) === '56daysAgo';
    const value = (metric: string) => String(metric === 'sessions' ? (previous ? 100 : 150) : metric === 'keyEvents' ? (previous ? 10 : 12) : 1);
    return json({
      dimensionHeaders: dims.map(name => ({ name })), metricHeaders: mets.map(name => ({ name })),
      rows: [{ dimensionValues: dims.map(() => ({ value: 'Damp Keywords' })), metricValues: mets.map(x => ({ value: value(x) })) }],
      totals: [{ metricValues: mets.map(x => ({ value: value(x) })) }],
      rowCount: 1, metadata: { currencyCode: 'GBP', timeZone: 'Europe/London' },
    });
  }));
  return requests;
}

describe('linking GA4 to a Google Ads client', () => {
  it('verifies access, stores the id and name, and unlinks with null', async () => {
    const { account } = seedClient('link');
    fakeGa4();
    const linked = await m.link.linkGa4Property(account, 'properties/449058214');
    expect(linked.account.ga4_property_id).toBe('449058214');
    expect(linked.account.ga4_property_name).toBe('WeatherWise GA4');

    const unlinked = await m.link.linkGa4Property(linked.account, null);
    expect(unlinked.account.ga4_property_id).toBeNull();
    expect(unlinked.account.ga4_property_name).toBeNull();
  });

  it('refuses a property no connected login can read, and saves nothing', async () => {
    const { account } = seedClient('denied');
    fakeGa4();
    await expect(m.link.linkGa4Property(account, '123456789')).rejects.toMatchObject({ kind: 'PERMISSION' });
    await expect(m.link.linkGa4Property(account, 'G-XYZ')).rejects.toMatchObject({ kind: 'INVALID' });
    expect(m.store.getAdsAccount(account.id)!.ga4_property_id).toBeNull();
  });
});

describe('GA4 paid-search report for a client', () => {
  it('reads google / cpc traffic and compares it with the previous period', async () => {
    const { account } = seedClient('perf');
    const requests = fakeGa4();
    const linked = (await m.link.linkGa4Property(account, '449058214')).account;
    requests.length = 0;

    const report = await m.link.ga4AdsPerformance(linked, 28);
    expect(report.paid_search_google.totals.sessions).toBe(150);
    expect(report.paid_search_google.previous_period_totals.sessions).toBe(100);
    expect(report.paid_search_google.change_pct.sessions).toBe(50);
    expect(report.paid_search_google.by_campaign[0]).toMatchObject({ sessionCampaignName: 'Damp Keywords', sessions: 150 });
    const paid = requests.filter(r => JSON.stringify(r.body).includes('google / cpc'));
    expect(paid).toHaveLength(3); // campaigns, previous totals, landing pages
    expect(requests).toHaveLength(4); // + channel mix (unfiltered)
  });

  it('explains how to link a property when none is linked', async () => {
    const { account } = seedClient('none');
    await expect(m.link.ga4AdsPerformance(account)).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });
});

describe('GA4 MCP tools', () => {
  it('runs a report for a client\'s linked property and links properties only with ads:write', async () => {
    const { user, account } = seedClient('mcp');
    fakeGa4();
    const reader = ctxFor(user.id, ['mcp:read']);
    await expect(m.tools.runTool(reader, 'ads_link_ga4_property', { account: account.id, propertyId: '449058214' })).rejects.toThrow(/ads:write/);

    const writer = ctxFor(user.id, ['mcp:read', 'ads:write']);
    const linked = await m.tools.runTool(writer, 'ads_link_ga4_property', { account: account.id, propertyId: '449058214' }) as { ga4_property_id: string };
    expect(linked.ga4_property_id).toBe('449058214');

    const report = await m.tools.runTool(reader, 'ga4_run_report', { account: account.id, metrics: ['sessions'], dimensions: ['sessionCampaignName'] }) as { property_id: string; rows: unknown[] };
    expect(report.property_id).toBe('449058214');
    expect(report.rows).toHaveLength(1);

    const clients = await m.tools.runTool(reader, 'ads_list_clients', {}) as { clients: Array<{ ga4_property: { property_id: string } | null }> };
    expect(clients.clients[0].ga4_property?.property_id).toBe('449058214');
  });

  it('never reaches another workspace\'s client or its Google logins', async () => {
    const mine = seedClient('mine');
    const theirs = seedClient('theirs');
    fakeGa4();
    await m.link.linkGa4Property(theirs.account, '449058214');
    const ctx = ctxFor(mine.user.id, ['mcp:read', 'ads:write']);
    await expect(m.tools.runTool(ctx, 'ga4_ads_performance', { account: theirs.account.id })).rejects.toThrow();
    await expect(m.tools.runTool(ctx, 'ads_link_ga4_property', { account: theirs.account.id, propertyId: '449058214' })).rejects.toThrow();
    // A bare property ID only ever uses this user's own logins.
    const listed = await m.tools.runTool(ctx, 'ga4_list_properties', {}) as { logins: Array<{ google_login: string }> };
    expect(listed.logins.map(l => l.google_login)).toEqual([mine.login]);
  });
});

describe('routine prompt', () => {
  it('tells the daily run to read GA4 for linked clients and to link missing ones', async () => {
    const linkedClient = seedClient('routine');
    const bare = seedClient('routine-bare');
    fakeGa4();
    const linked = (await m.link.linkGa4Property(linkedClient.account, '449058214')).account;
    const { prompt } = m.routine.buildRoutinePrompt({
      settings: m.routine.DEFAULT_ROUTINE, accounts: [linked, bare.account],
      connectorName: 'SEO Website Indexer', endpoint: 'https://seo.example.com/mcp', dashboardUrl: 'https://seo.example.com/ads',
    });
    expect(prompt).toContain('GA4 property: 449058214 (WeatherWise GA4), read it with ga4_ads_performance');
    expect(prompt).toContain('GA4 property: not linked');
    expect(prompt).toContain('call ga4_ads_performance');
  });
});
