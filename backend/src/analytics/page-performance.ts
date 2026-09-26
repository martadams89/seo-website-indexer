/**
 * Page-level Search Console performance.
 *
 * Stores Google's per-day, per-page clicks / impressions / position so the
 * app can (a) measure whether a title or meta-description change moved
 * click-through rate, (b) prioritise internal links towards "page two" pages
 * and (c) rank Core Web Vitals problems by the traffic they put at risk.
 */
import { getDb, type Site } from '../db/database.js';
import { getGoogleDailyPages, type DailyPageRow } from '../indexer/performance.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TRAILING_DAYS = 5;     // GSC revises recent days; refresh them every snapshot
const BACKFILL_DAYS = 90;    // first sync: enough history for before/after comparisons
const RETENTION_DAYS = 480;  // GSC itself keeps ~16 months
/** Google's data lags ~2-3 days; later days are incomplete. */
const DATA_LAG_DAYS = 3;

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function upsertPageRows(siteId: string, rows: DailyPageRow[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO perf_page_daily(site_id, day, page, clicks, impressions, position)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(site_id, day, page) DO UPDATE SET
      clicks=excluded.clicks, impressions=excluded.impressions, position=excluded.position
  `);
  getDb().transaction((rs: DailyPageRow[]) => {
    for (const r of rs) stmt.run(siteId, r.date, r.page, r.clicks, r.impressions, r.position);
  })(rows);
}

/** Refresh page rows: a 90-day backfill the first time, then the trailing window. */
export async function syncPagePerformance(site: Site, now: number = Date.now()): Promise<number> {
  if (!site.google_account_id) return 0;
  const hasHistory = !!getDb().prepare('SELECT 1 FROM perf_page_daily WHERE site_id = ? LIMIT 1').get(site.id);
  const days = hasHistory ? TRAILING_DAYS : BACKFILL_DAYS;
  const rows = await getGoogleDailyPages(site, ymd(now - days * DAY_MS), ymd(now));
  if (rows.length) upsertPageRows(site.id, rows);
  getDb().prepare('DELETE FROM perf_page_daily WHERE site_id = ? AND day < ?').run(site.id, ymd(now - RETENTION_DAYS * DAY_MS));
  return rows.length;
}

export interface PageTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  /** Impression-weighted average position. */
  position: number;
  days: number;
}

function totalsFor(siteId: string, page: string | null, from: string, to: string): PageTotals {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions,
      SUM(position*impressions)/NULLIF(SUM(impressions),0) position, COUNT(DISTINCT day) days
    FROM perf_page_daily WHERE site_id = ? ${page ? 'AND page = ?' : ''} AND day >= ? AND day < ?
  `).get(...[siteId, ...(page ? [page] : []), from, to]) as { clicks: number; impressions: number; position: number | null; days: number };
  return {
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.impressions ? row.clicks / row.impressions : 0,
    position: row.position ?? 0,
    days: row.days,
  };
}

/** Per-page totals over the last `days` complete days, keyed by page URL. */
export function pagePerformance(siteId: string, days = 28, now: number = Date.now()): Map<string, PageTotals> {
  const to = ymd(now - DATA_LAG_DAYS * DAY_MS);
  const from = ymd(now - (DATA_LAG_DAYS + days) * DAY_MS);
  const rows = getDb().prepare(`
    SELECT page, SUM(clicks) clicks, SUM(impressions) impressions,
      SUM(position*impressions)/NULLIF(SUM(impressions),0) position, COUNT(DISTINCT day) days
    FROM perf_page_daily WHERE site_id = ? AND day >= ? AND day < ? GROUP BY page
  `).all(siteId, from, to) as Array<{ page: string; clicks: number; impressions: number; position: number | null; days: number }>;
  return new Map(rows.map(r => [r.page, {
    clicks: r.clicks, impressions: r.impressions, ctr: r.impressions ? r.clicks / r.impressions : 0,
    position: r.position ?? 0, days: r.days,
  }]));
}

// ── Title / meta description change tracking ─────────────────────────────────

export interface SnippetChange {
  id: number;
  site_id: string;
  url: string;
  changed_at: string;
  old_title: string | null;
  new_title: string | null;
  old_description: string | null;
  new_description: string | null;
}

export function recordSnippetChange(change: Omit<SnippetChange, 'id'>): void {
  getDb().prepare(`
    INSERT INTO page_snippet_changes(site_id, url, changed_at, old_title, new_title, old_description, new_description)
    VALUES(?,?,?,?,?,?,?)
  `).run(change.site_id, change.url, change.changed_at, change.old_title, change.new_title, change.old_description, change.new_description);
}

export type SnippetVerdict = 'improved' | 'worse' | 'no_change' | 'collecting' | 'insufficient_data';

export interface SnippetEvaluation extends SnippetChange {
  before: PageTotals;
  after: PageTotals;
  ctrChangePct: number | null;
  positionChange: number | null;
  verdict: SnippetVerdict;
  /** When a full comparison window will be available. */
  readyOn: string;
}

const WINDOW_DAYS = 28;
const MIN_AFTER_DAYS = 14;
const MIN_IMPRESSIONS = 100;

/**
 * Compares the page's CTR and position for up to 28 days before the change
 * with the same length after it (ignoring the change day and Google's data
 * lag). CTR is the metric a title/description change directly influences;
 * position is reported so a ranking move is not mistaken for a better snippet.
 */
export function evaluateSnippetChange(change: SnippetChange, now: number = Date.now()): SnippetEvaluation {
  const changed = Date.parse(change.changed_at);
  const dayAfter = changed + DAY_MS;
  const dataEnd = now - DATA_LAG_DAYS * DAY_MS;
  const afterDays = Math.max(0, Math.min(WINDOW_DAYS, Math.floor((dataEnd - dayAfter) / DAY_MS)));
  const windowDays = Math.max(afterDays, MIN_AFTER_DAYS);
  const before = totalsFor(change.site_id, change.url, ymd(changed - windowDays * DAY_MS), ymd(changed));
  const after = totalsFor(change.site_id, change.url, ymd(dayAfter), ymd(dayAfter + afterDays * DAY_MS));
  const readyOn = ymd(dayAfter + (MIN_AFTER_DAYS + DATA_LAG_DAYS) * DAY_MS);

  let verdict: SnippetVerdict;
  let ctrChangePct: number | null = null;
  let positionChange: number | null = null;
  if (afterDays < MIN_AFTER_DAYS) {
    verdict = 'collecting';
  } else if (before.impressions < MIN_IMPRESSIONS || after.impressions < MIN_IMPRESSIONS) {
    verdict = 'insufficient_data';
  } else {
    ctrChangePct = before.ctr > 0 ? ((after.ctr - before.ctr) / before.ctr) * 100 : null;
    positionChange = after.position - before.position; // negative = moved up
    // A relative CTR move under 10% is within normal week-to-week noise.
    verdict = ctrChangePct === null ? (after.ctr > 0 ? 'improved' : 'no_change')
      : ctrChangePct >= 10 ? 'improved' : ctrChangePct <= -10 ? 'worse' : 'no_change';
  }
  return { ...change, before, after, ctrChangePct, positionChange, verdict, readyOn };
}

export function listSnippetChanges(siteId: string, limit = 100, now: number = Date.now()): SnippetEvaluation[] {
  const rows = getDb().prepare('SELECT * FROM page_snippet_changes WHERE site_id = ? ORDER BY changed_at DESC LIMIT ?')
    .all(siteId, limit) as SnippetChange[];
  return rows.map(r => evaluateSnippetChange(r, now));
}
