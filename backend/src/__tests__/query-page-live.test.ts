import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Search terms and pages together, live from Search Console, through MCP:
// any dates, contains-filters, paging, fresh data on request, and the usual
// workspace fence on the site.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-qp-live-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'qp-live-secret-1234567890';

let m: {
  db: typeof import('../db/database.js'); users: typeof import('../auth/users.js'); ws: typeof import('../auth/workspaces.js');
  tokens: typeof import('../mcp/tokens.js'); tools: typeof import('../mcp/tools.js');
};
let siteId = '';
let ctx: import('../mcp/tools.js').McpContext;
let outsider: import('../mcp/tools.js').McpContext;

function ctxFor(userId: string) {
  const { token } = m.tokens.createMcpToken({ userId, name: 't', scopes: ['mcp:read'] });
  return m.tools.buildContext(m.tokens.authenticateMcpToken(token)!, 'https://seo.example.com')!;
}

beforeAll(async () => {
  m = {
    db: await import('../db/database.js'), users: await import('../auth/users.js'), ws: await import('../auth/workspaces.js'),
    tokens: await import('../mcp/tokens.js'), tools: await import('../mcp/tools.js'),
  };
  const owner = m.users.createUser({ email: `qp-${randomUUID()}@x.com`, password: 'password123' });
  const wsId = m.ws.bootstrapUserWorkspace(owner, false).id;
  m.db.upsertGoogleAccount({
    id: 'gsc@agency.test', email: 'gsc@agency.test', client_id: '123456789012-a.apps.googleusercontent.com', client_secret: 's',
    access_token: 'live-token', refresh_token: 'r', token_expiry: new Date(Date.now() + 3_600_000).toISOString(), workspace_id: wsId, owner_user_id: owner.id,
  });
  siteId = randomUUID();
  m.db.upsertSite({ id: siteId, name: 'Roofing', domain: 'roof.example', sitemap_url: 'https://roof.example/sitemap.xml', gsc_url: 'sc-domain:roof.example', enabled: 1, google_account_id: 'gsc@agency.test', workspace_id: wsId });
  ctx = ctxFor(owner.id);
  const other = m.users.createUser({ email: `qp-other-${randomUUID()}@x.com`, password: 'password123' });
  m.ws.bootstrapUserWorkspace(other, false);
  outsider = ctxFor(other.id);
});

afterEach(() => { vi.unstubAllGlobals(); });

function stubSearchConsole(rows: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(String(url)).toContain(`/sites/${encodeURIComponent('sc-domain:roof.example')}/searchAnalytics/query`);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer live-token');
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ rows }), { status: 200 });
  }));
  return bodies;
}

describe('get_query_page_performance', () => {
  it('returns search terms with their pages for chosen dates, with filters and paging', async () => {
    const bodies = stubSearchConsole([
      { keys: ['roof repair leeds', 'https://roof.example/leeds'], clicks: 40, impressions: 900, ctr: 0.044, position: 3.1 },
      { keys: ['roof repair leeds', 'https://roof.example/repairs'], clicks: 6, impressions: 700, ctr: 0.009, position: 9.4 },
    ]);
    const result = await m.tools.runTool(ctx, 'get_query_page_performance', { siteId, start: '2026-09-28', end: '2026-10-24', query: 'repair', page: '/leeds', limit: 2, startRow: 2, fresh: true }) as {
      available: boolean; start: string; end: string; data: string; rows: Array<{ query: string; page: string; clicks: number }>; next_start_row: number | null;
    };
    expect(result).toMatchObject({ available: true, start: '2026-09-28', end: '2026-10-24', data: 'all', next_start_row: 4 });
    expect(result.rows[1]).toMatchObject({ query: 'roof repair leeds', page: 'https://roof.example/repairs', clicks: 6 });
    expect(bodies[0]).toEqual({
      startDate: '2026-09-28', endDate: '2026-10-24', dimensions: ['query', 'page'], rowLimit: 2, startRow: 2, dataState: 'all',
      dimensionFilterGroups: [{ groupType: 'and', filters: [
        { dimension: 'query', operator: 'contains', expression: 'repair' },
        { dimension: 'page', operator: 'contains', expression: '/leeds' },
      ] }],
    });
  });

  it('defaults to the last 28 days of final data and says when it was the last page', async () => {
    const bodies = stubSearchConsole([{ keys: ['roofer', 'https://roof.example/'], clicks: 3, impressions: 50, ctr: 0.06, position: 5 }]);
    const result = await m.tools.runTool(ctx, 'get_query_page_performance', { siteId }) as { data: string; next_start_row: number | null };
    expect(result).toMatchObject({ data: 'final', next_start_row: null });
    expect(bodies[0]).toMatchObject({ dimensions: ['query', 'page'], rowLimit: 500, startRow: 0, dataState: 'final' });
    expect(bodies[0]).not.toHaveProperty('dimensionFilterGroups');
  });

  it('breaks the numbers down by the dimensions asked for, or gives totals', async () => {
    let bodies = stubSearchConsole([
      { keys: ['2026-10-01'], clicks: 70, impressions: 11000, ctr: 0.0064, position: 12.1 },
      { keys: ['2026-10-02'], clicks: 78, impressions: 11758, ctr: 0.0066, position: 11.9 },
    ]);
    const byDay = await m.tools.runTool(ctx, 'get_query_page_performance', { siteId, dimensions: ['date'], start: '2026-10-01', end: '2026-10-02' }) as { dimensions: string[]; rows: Array<Record<string, unknown>> };
    expect(byDay.dimensions).toEqual(['date']);
    expect(byDay.rows[1]).toEqual({ date: '2026-10-02', clicks: 78, impressions: 11758, ctr: 0.0066, position: 11.9 });
    expect(bodies[0]).toMatchObject({ dimensions: ['date'] });

    bodies = stubSearchConsole([{ keys: ['https://roof.example/leeds', 'gbr', 'MOBILE'], clicks: 9, impressions: 120, ctr: 0.075, position: 4 }]);
    const mixed = await m.tools.runTool(ctx, 'get_query_page_performance', { siteId, dimensions: ['page', 'country', 'device'], country: 'GBR', device: 'mobile', searchType: 'image' }) as { rows: Array<Record<string, unknown>> };
    expect(mixed.rows[0]).toMatchObject({ page: 'https://roof.example/leeds', country: 'gbr', device: 'MOBILE', clicks: 9 });
    expect(bodies[0]).toMatchObject({
      dimensions: ['page', 'country', 'device'], type: 'image',
      dimensionFilterGroups: [{ groupType: 'and', filters: [
        { dimension: 'country', operator: 'equals', expression: 'gbr' },
        { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
      ] }],
    });

    bodies = stubSearchConsole([{ keys: [], clicks: 2104, impressions: 318000, ctr: 0.0066, position: 14.2 }] as never);
    const totals = await m.tools.runTool(ctx, 'get_query_page_performance', { siteId, dimensions: [], days: 28 }) as { rows: Array<Record<string, unknown>> };
    expect(totals.rows).toEqual([{ clicks: 2104, impressions: 318000, ctr: 0.0066, position: 14.2 }]);
    expect(bodies[0]).toMatchObject({ dimensions: [] });
    expect(bodies[0]).not.toHaveProperty('type');

    expect(await m.tools.runTool(ctx, 'get_query_page_performance', { siteId, dimensions: ['searchAppearance', 'date'] })).toMatchObject({ available: false, reason: expect.stringMatching(/on its own/) });
  });

  it("refuses a backwards range and other workspaces' sites", async () => {
    stubSearchConsole([]);
    expect(await m.tools.runTool(ctx, 'get_query_page_performance', { siteId, start: '2026-10-24', end: '2026-10-01' })).toMatchObject({ available: false, reason: 'start must be on or before end.' });
    await expect(m.tools.runTool(outsider, 'get_query_page_performance', { siteId })).rejects.toThrow();
  });
});
