import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// GA4 client: request building, response normalisation, Google error mapping
// and login fallback. Google is stubbed; tokens come from the seeded accounts.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-ga4-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'ga4-test-secret-1234567890';

type Ga4 = typeof import('../analytics/ga4.js');
let ga4: Ga4;
let db: typeof import('../db/database.js');
let users: typeof import('../auth/users.js');
let ws: typeof import('../auth/workspaces.js');
let oauth: typeof import('../auth/google-oauth.js');

beforeAll(async () => {
  ga4 = await import('../analytics/ga4.js');
  db = await import('../db/database.js');
  users = await import('../auth/users.js');
  ws = await import('../auth/workspaces.js');
  oauth = await import('../auth/google-oauth.js');
});

afterEach(() => vi.unstubAllGlobals());

function workspace() {
  const user = users.createUser({ email: `ga4-${randomUUID()}@x.com`, password: 'password123' });
  return { userId: user.id, workspaceId: ws.bootstrapUserWorkspace(user, false).id };
}

function login(owner: { userId: string; workspaceId: string }, scopes = oauth.OAUTH_SCOPES) {
  const id = `login-${randomUUID().slice(0, 8)}@agency.test`;
  db.upsertGoogleAccount({
    id, email: id, client_id: '123456789012-abc.apps.googleusercontent.com', client_secret: 'secret',
    access_token: `token-${id}`, refresh_token: 'refresh', token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    granted_scopes: scopes, workspace_id: owner.workspaceId, owner_user_id: owner.userId,
  });
  db.shareGoogleAccountWithWorkspace(id, owner.workspaceId, owner.userId);
  return db.getGoogleAccountById(id)!;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

describe('GA4 request building', () => {
  it('accepts "properties/123" or plain digits and rejects anything else', () => {
    expect(ga4.cleanPropertyId('properties/449058214')).toBe('449058214');
    expect(ga4.cleanPropertyId(' 449058214 ')).toBe('449058214');
    expect(() => ga4.cleanPropertyId('G-ABC123')).toThrow(/not a GA4 property ID/);
  });

  it('builds filters, ordering, limits and dates for the Data API', () => {
    const one = ga4.buildReportBody({ metrics: ['sessions'], filters: [{ dimension: 'sessionSourceMedium', value: 'google / cpc' }] });
    expect(one.dimensionFilter).toEqual({ filter: { fieldName: 'sessionSourceMedium', stringFilter: { matchType: 'EXACT', value: 'google / cpc', caseSensitive: false } } });
    expect(one.dateRanges).toEqual([{ startDate: '28daysAgo', endDate: 'yesterday' }]);
    expect(one.orderBys).toEqual([{ metric: { metricName: 'sessions' }, desc: true }]);

    const many = ga4.buildReportBody({
      metrics: ['sessions'], dimensions: ['landingPage'], limit: 50_000, orderBy: { field: 'landingPage' },
      filters: [{ dimension: 'country', value: 'United Kingdom' }, { dimension: 'landingPage', value: '/blog', match: 'begins_with', exclude: true }],
    });
    expect(many.dimensionFilter).toMatchObject({ andGroup: { expressions: [{ filter: { fieldName: 'country' } }, { notExpression: { filter: { stringFilter: { matchType: 'BEGINS_WITH' } } } }] } });
    expect(many.orderBys).toEqual([{ dimension: { dimensionName: 'landingPage' }, desc: false }]);
    expect(many.limit).toBe('10000'); // capped

    expect(() => ga4.buildReportBody({ metrics: [] })).toThrow(/at least one metric/);
    expect(() => ga4.buildReportBody({ metrics: ['sessions'], startDate: 'last month' })).toThrow(/not a GA4 date/);
  });
});

describe('GA4 reports', () => {
  it('normalises rows, dates and totals', async () => {
    const owner = workspace();
    const l = login(owner);
    const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('Authorization'), body: JSON.parse(String(init.body)) });
      return json({
        dimensionHeaders: [{ name: 'date' }, { name: 'sessionCampaignName' }],
        metricHeaders: [{ name: 'sessions' }, { name: 'keyEvents' }],
        rows: [{ dimensionValues: [{ value: '20261020' }, { value: 'Damp Keywords' }], metricValues: [{ value: '120' }, { value: '7' }] }],
        totals: [{ metricValues: [{ value: '120' }, { value: '7' }] }],
        rowCount: 3, metadata: { currencyCode: 'GBP', timeZone: 'Europe/London' },
      });
    }));
    const report = await ga4.runGa4Report(l, '449058214', { dimensions: ['date', 'sessionCampaignName'], metrics: ['sessions', 'keyEvents'], limit: 1 });
    expect(calls[0].url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/449058214:runReport');
    expect(calls[0].auth).toBe(`Bearer token-${l.id}`);
    expect(report.rows).toEqual([{ date: '2026-10-20', sessionCampaignName: 'Damp Keywords', sessions: 120, keyEvents: 7 }]);
    expect(report.totals).toEqual({ sessions: 120, keyEvents: 7 });
    expect(report.truncated).toBe(true);
    expect(report.currency).toBe('GBP');
  });

  it('turns Google errors into actionable ones', async () => {
    const owner = workspace();
    const l = login(owner);
    const cases: Array<[number, Record<string, unknown>, string]> = [
      [403, { error: { code: 403, message: 'User does not have sufficient permissions for this property.', status: 'PERMISSION_DENIED' } }, 'PERMISSION'],
      [403, { error: { code: 403, message: 'Google Analytics Data API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=123 then retry.', details: [{ reason: 'SERVICE_DISABLED' }] } }, 'API_DISABLED'],
      [403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 'SCOPE'],
      [400, { error: { code: 400, message: 'Field sesions is not a valid metric.' } }, 'INVALID'],
    ];
    for (const [status, body, kind] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => json(body, status)));
      const err = await ga4.runGa4Report(l, '449058214', { metrics: ['sessions'] }).catch(e => e);
      expect(err).toBeInstanceOf(ga4.Ga4Error);
      expect(err.kind).toBe(kind);
      expect(err.hint ?? '').not.toBe('');
      if (kind === 'API_DISABLED') expect(err.hint).toContain('https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=123');
    }
  });

  it('lists properties across pages of account summaries', async () => {
    const owner = workspace();
    const l = login(owner);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('pageToken=next')
      ? json({ accountSummaries: [{ account: 'accounts/2', displayName: 'Other', propertySummaries: [{ property: 'properties/222', displayName: 'Other site' }] }] })
      : json({ nextPageToken: 'next', accountSummaries: [{ account: 'accounts/1', displayName: 'WeatherWise', propertySummaries: [{ property: 'properties/449058214', displayName: 'WeatherWise GA4' }] }] })));
    const props = await ga4.listGa4Properties(l);
    expect(props.map(p => p.property_id)).toEqual(['449058214', '222']);
    expect(props[0]).toMatchObject({ property_name: 'WeatherWise GA4', account_name: 'WeatherWise' });
  });
});

describe('GA4 login resolution', () => {
  it('prefers the given login, skips logins without Analytics access, and stays in the workspace', () => {
    const owner = workspace();
    const other = workspace();
    const a = login(owner);
    const b = login(owner);
    login(owner, 'https://www.googleapis.com/auth/webmasters'); // no Analytics scope
    const foreign = login(other);
    const ids = ga4.analyticsLogins([owner.workspaceId], b.id).map(l => l.id);
    expect(ids[0]).toBe(b.id);
    expect(ids).toContain(a.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(foreign.id);
  });

  it('falls back to the next login on an access error, but not on a bad request', async () => {
    const owner = workspace();
    const denied = login(owner);
    const allowed = login(owner);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) =>
      new Headers(init.headers).get('Authorization') === `Bearer token-${denied.id}`
        ? json({ error: { code: 403, message: 'no access' } }, 403)
        : json({ dimensionHeaders: [], metricHeaders: [{ name: 'sessions' }], rows: [{ metricValues: [{ value: '5' }] }] })));
    const { login: used } = await ga4.withPropertyAccess([denied, allowed], l => ga4.runGa4Report(l, '449058214', { metrics: ['sessions'] }));
    expect(used.id).toBe(allowed.id);

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 400, message: 'bad metric' } }, 400)));
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>;
    await expect(ga4.withPropertyAccess([denied, allowed], l => ga4.runGa4Report(l, '449058214', { metrics: ['nope'] }))).rejects.toMatchObject({ kind: 'INVALID' });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // same for every login: no point retrying

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 403, message: 'no access' } }, 403)));
    await expect(ga4.withPropertyAccess([denied, allowed], l => ga4.runGa4Report(l, '449058214', { metrics: ['sessions'] })))
      .rejects.toThrow(new RegExp(`tried ${denied.email}, ${allowed.email}`));
    await expect(ga4.withPropertyAccess([], async () => 1)).rejects.toMatchObject({ kind: 'NO_LOGIN' });
  });
});
