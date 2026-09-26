import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-query-page-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'query-page-secret-1234567890';

const gscQuery = vi.fn();
vi.mock('../indexer/performance.js', () => ({ gscQuery: (...args: unknown[]) => gscQuery(...args) }));
vi.mock('../auth/google-oauth.js', () => ({ getAccessTokenForAccount: vi.fn(async () => 'token') }));

let db: typeof import('../db/database.js');
let qp: typeof import('../analytics/query-page-performance.js');

beforeAll(async () => {
  db = await import('../db/database.js');
  qp = await import('../analytics/query-page-performance.js');
});

const NOW = Date.parse('2026-09-26T12:00:00Z');
const row = (query: string, page: string, clicks: number, impressions: number, position: number) =>
  ({ keys: [query, page], clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

function makeSite(gscUrl = 'https://qp.example/') {
  const id = randomUUID();
  const account = `${id.slice(0, 8)}@example.com`;
  db.upsertGoogleAccount({
    id: account, email: account, client_id: '123-abc.apps.googleusercontent.com', client_secret: 'shh',
    access_token: 't', refresh_token: 'rt', token_expiry: null, workspace_id: null, owner_user_id: null,
  });
  db.upsertSite({ id, name: 'qp', domain: `${id}.example`, sitemap_url: `${gscUrl}sitemap.xml`, gsc_url: gscUrl, enabled: 1, google_account_id: account });
  return db.getSiteById(id)!;
}

describe('syncQueryPagePerformance', () => {
  it('uses a 28-day window ending three days ago, final data, and paginates', async () => {
    const site = makeSite();
    gscQuery.mockReset();
    gscQuery.mockResolvedValueOnce([row('hiking boots', 'https://qp.example/boots', 10, 200, 3.2), row('boots', 'https://qp.example/boots', 4, 500, 8.1)]);
    const sync = await qp.syncQueryPagePerformance(site, { now: NOW });
    expect(sync).toMatchObject({ error: null, truncated: 0, row_count: 2, period_start: '2026-08-27', period_end: '2026-09-23' });
    expect(gscQuery).toHaveBeenCalledTimes(1);
    expect(gscQuery.mock.calls[0][2]).toMatchObject({ startDate: '2026-08-27', endDate: '2026-09-23', dimensions: ['query', 'page'], rowLimit: 25_000, startRow: 0, dataState: 'final' });
    expect(qp.queriesForPage(site.id, 'https://qp.example/boots').map(r => r.query)).toEqual(['boots', 'hiking boots']);

    // Within the day: no second call.
    await qp.syncQueryPagePerformance(site, { now: NOW + 3600_000 });
    expect(gscQuery).toHaveBeenCalledTimes(1);
    // Forced: refreshes and replaces the window.
    gscQuery.mockResolvedValueOnce([row('hiking boots', 'https://qp.example/boots', 12, 210, 3.0)]);
    await qp.syncQueryPagePerformance(site, { now: NOW + 3600_000, force: true });
    expect(qp.queryPageRows(site.id)).toHaveLength(1);
  });

  it('records errors without losing the last good window, and wipes rows when the property changes', async () => {
    const site = makeSite('https://qp2.example/');
    gscQuery.mockReset();
    gscQuery.mockResolvedValueOnce([row('q', 'https://qp2.example/a', 1, 10, 5)]);
    await qp.syncQueryPagePerformance(site, { now: NOW });
    gscQuery.mockRejectedValueOnce(new Error('GSC 429: quota'));
    const failed = await qp.syncQueryPagePerformance(site, { now: NOW + 2 * 24 * 3600_000 });
    expect(failed).toMatchObject({ error: 'GSC 429: quota', row_count: 1 });
    expect(failed?.success_at).toBeTruthy();
    expect(qp.queryPageRows(site.id)).toHaveLength(1);

    // Re-pointing the site to another property drops the old window immediately.
    db.upsertSite({ ...site, gsc_url: 'sc-domain:qp2.example' });
    gscQuery.mockResolvedValueOnce([]);
    const fresh = await qp.syncQueryPagePerformance(db.getSiteById(site.id)!, { now: NOW + 2 * 24 * 3600_000 });
    expect(fresh?.identity).toContain('sc-domain:qp2.example');
    expect(qp.queryPageRows(site.id)).toHaveLength(0);
  });

  it('marks a window truncated when Google keeps returning full pages', async () => {
    const site = makeSite('https://qp3.example/');
    gscQuery.mockReset();
    const full = Array.from({ length: 25_000 }, (_, i) => row(`q${i}`, 'https://qp3.example/p', 0, 1, 50));
    gscQuery.mockResolvedValue(full);
    const sync = await qp.syncQueryPagePerformance(site, { now: NOW });
    expect(gscQuery).toHaveBeenCalledTimes(3);
    expect(sync).toMatchObject({ truncated: 1, row_count: 75_000 });
  });
});
