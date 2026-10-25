/**
 * analytics/compare.ts — compare any Search Console period with the one
 * before it, or the same period last year: totals plus the queries, pages,
 * countries or devices that moved most. Queried live from Search Console, so
 * any range Google still holds (about 16 months) works.
 */
import { getAccessTokenForAccount } from '../auth/google-oauth.js';
import type { Site } from '../db/database.js';
import { gscQuery } from '../indexer/performance.js';

export type CompareDimension = 'query' | 'page' | 'country' | 'device';
export type CompareMode = 'previous' | 'year';

interface Totals { clicks: number; impressions: number; ctr: number; position: number }
export interface CompareRow {
  key: string;
  current: Totals;
  previous: Totals;
  click_change: number;
  impression_change: number;
  position_change: number | null;
  status: 'new' | 'lost' | 'both';
}

const DAY = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const EMPTY: Totals = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

/** The comparison window for [start, end] (inclusive dates, YYYY-MM-DD). */
export function comparisonRange(start: string, end: string, mode: CompareMode): { start: string; end: string } {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  if (mode === 'year') {
    const shift = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() - 1); return d.toISOString().slice(0, 10); };
    return { start: shift(start), end: shift(end) };
  }
  const span = Math.round((e - s) / DAY) + 1;
  return { start: ymd(s - span * DAY), end: ymd(s - DAY) };
}

/** Default range: the last N complete days (Search Console lags about two days). */
export function defaultRange(days: number, now = Date.now()): { start: string; end: string } {
  const end = now - 2 * DAY;
  return { start: ymd(end - (days - 1) * DAY), end: ymd(end) };
}

const toTotals = (r?: { clicks: number; impressions: number; ctr: number; position: number }): Totals =>
  r ? { clicks: r.clicks, impressions: r.impressions, ctr: round(r.ctr * 100, 2), position: round(r.position, 1) } : EMPTY;

/** Pure: join two periods' rows by key and rank by the size of the click change. */
export function diffRows(
  current: Array<{ keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }>,
  previous: Array<{ keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }>,
): CompareRow[] {
  const prev = new Map(previous.map(r => [r.keys?.[0] ?? '', r]));
  const cur = new Map(current.map(r => [r.keys?.[0] ?? '', r]));
  const keys = new Set([...cur.keys(), ...prev.keys()]);
  return [...keys].filter(Boolean).map(key => {
    const c = toTotals(cur.get(key));
    const p = toTotals(prev.get(key));
    return {
      key, current: c, previous: p,
      click_change: c.clicks - p.clicks,
      impression_change: c.impressions - p.impressions,
      // Lower is better for position, so a negative change is an improvement.
      position_change: cur.has(key) && prev.has(key) ? round(c.position - p.position, 1) : null,
      status: (!prev.has(key) ? 'new' : !cur.has(key) ? 'lost' : 'both') as CompareRow['status'],
    };
  }).sort((a, b) => Math.abs(b.click_change) - Math.abs(a.click_change) || Math.abs(b.impression_change) - Math.abs(a.impression_change));
}

/** Search Console's raw error bodies aren't readable; say what to do instead. */
function friendlyGscError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  const status = Number(/^GSC (\d{3})/.exec(message)?.[1]);
  const friendly = status === 401 ? 'Google rejected this site\'s Search Console sign-in. Reconnect the Google account under Settings → Google accounts.'
    : status === 403 ? 'The connected Google account can\'t read this Search Console property. Check it has access to the property set on the site.'
      : status === 429 ? 'Search Console\'s quota is used up for now. Try again in a few minutes.'
        : `Search Console couldn't answer: ${message.slice(0, 200)}`;
  return Object.assign(new Error(friendly), { statusCode: 502 });
}

export async function comparePeriods(site: Site, opts: { start?: string; end?: string; days?: number; mode?: CompareMode; dimension?: CompareDimension; limit?: number } = {}) {
  if (!site.google_account_id) throw Object.assign(new Error('Link a Google account and Search Console property to this site first.'), { statusCode: 400 });
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const range = opts.start && opts.end && iso.test(opts.start) && iso.test(opts.end) && opts.start <= opts.end
    ? { start: opts.start, end: opts.end }
    : defaultRange(Math.max(1, Math.min(480, opts.days ?? 28)));
  const mode = opts.mode === 'year' ? 'year' : 'previous';
  const against = comparisonRange(range.start, range.end, mode);
  const dimension = opts.dimension ?? 'query';
  const limit = Math.max(5, Math.min(200, opts.limit ?? 25));
  const token = await getAccessTokenForAccount(site.google_account_id);
  const q = (r: { start: string; end: string }, dimensions: string[], rowLimit: number) =>
    gscQuery(token, site.gsc_url, { startDate: r.start, endDate: r.end, dimensions, rowLimit });
  const [curTotal, prevTotal, curRows, prevRows] = await Promise.all([
    q(range, [], 1), q(against, [], 1), q(range, [dimension], 5000), q(against, [dimension], 5000),
  ]).catch((e: unknown) => { throw friendlyGscError(e); });
  const current = toTotals(curTotal[0]);
  const previous = toTotals(prevTotal[0]);
  const pct = (a: number, b: number) => b ? round(((a - b) / b) * 100, 1) : null;
  const rows = diffRows(curRows, prevRows);
  return {
    site: { id: site.id, name: site.name },
    period: range, compared_with: { ...against, mode }, dimension,
    totals: {
      current, previous,
      change: {
        clicks: current.clicks - previous.clicks, clicks_pct: pct(current.clicks, previous.clicks),
        impressions: current.impressions - previous.impressions, impressions_pct: pct(current.impressions, previous.impressions),
        ctr_points: round(current.ctr - previous.ctr, 2), position: round(current.position - previous.position, 1),
      },
    },
    gainers: rows.filter(r => r.click_change > 0).slice(0, limit),
    losers: rows.filter(r => r.click_change < 0).slice(0, limit),
    new_count: rows.filter(r => r.status === 'new').length,
    lost_count: rows.filter(r => r.status === 'lost').length,
    note: 'Search Console data lags about two days; anonymised queries are missing from query rows, so they sum to less than the totals.',
  };
}
