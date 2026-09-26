/**
 * Query × page Search Console window.
 *
 * One 28-day aggregate per site of (query, page) → clicks, impressions,
 * position. It is the only data that says WHICH queries a page ranks for,
 * which the Ranking Playbook needs for keyword cannibalisation, striking
 * distance queries and AI drafts. Google anonymises low-volume queries, so
 * these rows undercount page totals: perf_page_daily stays the denominator.
 *
 * Synced once a day per site (after the perf rollups), replaced only after a
 * complete response, with a status row for the UI.
 */
import { getDb, type Site } from '../db/database.js';
import { getAccessTokenForAccount } from '../auth/google-oauth.js';
import { gscQuery } from '../indexer/performance.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const QUERY_PAGE_WINDOW_DAYS = 28;
const DATA_LAG_DAYS = 3;
const PAGE_SIZE = 25_000;
const MAX_PAGES = 3; // 75k rows: enough for sites well beyond 50k clicks/month
const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000;
const RETRY_AFTER_ERROR_MS = 30 * 60 * 1000;

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface QueryPageRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

export interface QueryPageSync {
  site_id: string;
  identity: string;
  checked_at: string;
  success_at: string | null;
  error: string | null;
  truncated: number;
  period_start: string | null;
  period_end: string | null;
  row_count: number;
}

export function getQueryPageSync(siteId: string): QueryPageSync | null {
  return (getDb().prepare('SELECT * FROM perf_query_page_sync WHERE site_id = ?').get(siteId) as QueryPageSync | undefined) ?? null;
}

/** The window's dates for `now`: 28 days ending 3 days ago (Google's data lag). */
export function queryPageWindow(now: number = Date.now()): { startDate: string; endDate: string } {
  const end = now - DATA_LAG_DAYS * DAY_MS;
  return { startDate: ymd(end - (QUERY_PAGE_WINDOW_DAYS - 1) * DAY_MS), endDate: ymd(end) };
}

const running = new Map<string, Promise<QueryPageSync | null>>();

/**
 * Refresh the site's query×page window when it is stale. Returns the status
 * row, or null when the site has no Google account. Never throws: errors are
 * recorded on the status row so the UI can explain a missing playbook.
 */
export function syncQueryPagePerformance(site: Site, opts: { now?: number; force?: boolean } = {}): Promise<QueryPageSync | null> {
  if (!site.google_account_id || !site.gsc_url) return Promise.resolve(null);
  const now = opts.now ?? Date.now();
  const identity = JSON.stringify([site.google_account_id, site.gsc_url]);
  let sync = getQueryPageSync(site.id);

  // The window belongs to one account/property: never keep a previous
  // property's rows after the site is re-pointed.
  if (sync && sync.identity !== identity) {
    getDb().transaction(() => {
      getDb().prepare('DELETE FROM perf_query_page WHERE site_id = ?').run(site.id);
      getDb().prepare('DELETE FROM perf_query_page_sync WHERE site_id = ?').run(site.id);
    })();
    sync = null;
  }
  const age = sync ? now - Date.parse(sync.checked_at) : Infinity;
  const due = !sync || opts.force || age > (sync.error ? RETRY_AFTER_ERROR_MS : REFRESH_AFTER_MS);
  if (!due) return Promise.resolve(sync);

  let task = running.get(site.id);
  if (!task) {
    task = fetchWindow(site, identity, now).finally(() => running.delete(site.id));
    running.set(site.id, task);
  }
  return task;
}

async function fetchWindow(site: Site, identity: string, now: number): Promise<QueryPageSync | null> {
  const at = new Date(now).toISOString();
  const { startDate, endDate } = queryPageWindow(now);
  const previous = getQueryPageSync(site.id);
  const status = getDb().prepare(`
    INSERT OR REPLACE INTO perf_query_page_sync(site_id, identity, checked_at, success_at, error, truncated, period_start, period_end, row_count)
    VALUES(?,?,?,?,?,?,?,?,?)
  `);
  try {
    const token = await getAccessTokenForAccount(site.google_account_id!);
    const rows: QueryPageRow[] = [];
    let truncated = false;
    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
      const batch = await gscQuery(token, site.gsc_url, {
        startDate, endDate, dimensions: ['query', 'page'], rowLimit: PAGE_SIZE, startRow: pageNo * PAGE_SIZE, dataState: 'final',
      });
      for (const r of batch) {
        const query = r.keys?.[0];
        const page = r.keys?.[1];
        if (!query || !page || ![r.clicks, r.impressions, r.position].every(Number.isFinite)) continue;
        rows.push({ query, page, clicks: r.clicks, impressions: r.impressions, position: r.position });
      }
      if (batch.length < PAGE_SIZE) break;
      if (pageNo === MAX_PAGES - 1) truncated = true;
    }
    getDb().transaction(() => {
      // Always replace the window. A truncated response still holds the busiest
      // rows (Google sorts by clicks); keeping an older tail alongside them
      // would feed stale positions into the detectors.
      getDb().prepare('DELETE FROM perf_query_page WHERE site_id = ?').run(site.id);
      const insert = getDb().prepare(`
        INSERT INTO perf_query_page(site_id, query, page, clicks, impressions, position) VALUES(?,?,?,?,?,?)
        ON CONFLICT(site_id, query, page) DO UPDATE SET clicks=excluded.clicks, impressions=excluded.impressions, position=excluded.position
      `);
      for (const r of rows) insert.run(site.id, r.query, r.page, r.clicks, r.impressions, r.position);
      status.run(site.id, identity, at, at, null, truncated ? 1 : 0, startDate, endDate, rows.length);
    })();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Google sync failed';
    status.run(site.id, identity, at, previous?.identity === identity ? previous.success_at : null, message.slice(0, 300),
      previous?.truncated ?? 0, previous?.period_start ?? null, previous?.period_end ?? null, previous?.row_count ?? 0);
  }
  return getQueryPageSync(site.id);
}

/** Every (query, page) row of the site's current window. */
export function queryPageRows(siteId: string): QueryPageRow[] {
  return getDb().prepare('SELECT query, page, clicks, impressions, position FROM perf_query_page WHERE site_id = ?').all(siteId) as QueryPageRow[];
}

/** A page's queries, most impressions first. */
export function queriesForPage(siteId: string, page: string, limit = 25): QueryPageRow[] {
  return getDb().prepare(
    'SELECT query, page, clicks, impressions, position FROM perf_query_page WHERE site_id = ? AND page = ? ORDER BY impressions DESC, clicks DESC LIMIT ?',
  ).all(siteId, page, limit) as QueryPageRow[];
}
