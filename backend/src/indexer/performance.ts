/**
 * Unified search-performance: pulls Google Search Console Search Analytics and
 * Bing Webmaster rank/traffic/query stats into one shape the dashboard renders
 * as time-series charts + top-query/page tables, for a caller-chosen date range.
 *
 * Honest limits (surfaced to the UI, not hidden):
 *  - GSC data lags ~2 days and only goes back ~16 months.
 *  - Bing traffic history is ~6 months and buckets are coarser.
 *  - Neither exposes a full "Coverage report" API; per-URL index state comes
 *    from the URL Inspection path the tool already runs.
 */
import { getAccessTokenForAccount } from '../auth/google-oauth.js';
import { type Site } from '../db/database.js';
import { bingKeyForSite } from '../auth/workspaces.js';
import { deriveBingSiteUrl } from './bing.js';

const GSC_BASE = 'https://www.googleapis.com/webmasters/v3';
const BING_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';

export interface SeriesPoint { date: string; clicks: number; impressions: number; ctr: number; position: number }
export interface QueryRow { query: string; clicks: number; impressions: number; ctr: number; position: number }
export interface PageRow { page: string; clicks: number; impressions: number; ctr: number; position: number }

export interface EnginePerformance {
  available: boolean;
  reason?: string;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  series: SeriesPoint[];
  queries: QueryRow[];
  pages: PageRow[];
}

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

function rangeDates(days: number): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  return { startDate: ymd(start), endDate: ymd(end) };
}

// ── Google Search Console — searchAnalytics.query ────────────────────────────

async function gscQuery(
  token: string, gscUrl: string, body: Record<string, unknown>
): Promise<Array<{ keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }>> {
  const res = await fetch(`${GSC_BASE}/sites/${encodeURIComponent(gscUrl)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GSC ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json() as { rows?: Array<{ keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }> };
  return data.rows ?? [];
}

export async function getGooglePerformance(site: Site, days: number): Promise<EnginePerformance> {
  const empty: EnginePerformance = {
    available: false, totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 }, series: [], queries: [], pages: [],
  };
  if (!site.google_account_id) return { ...empty, reason: 'No Google account linked to this site.' };
  let token: string;
  try {
    token = await getAccessTokenForAccount(site.google_account_id);
  } catch (e) {
    return { ...empty, reason: `Google auth error: ${e instanceof Error ? e.message : e}` };
  }
  const { startDate, endDate } = rangeDates(days);
  const base = { startDate, endDate };
  try {
    const [byDate, byQuery, byPage] = await Promise.all([
      gscQuery(token, site.gsc_url, { ...base, dimensions: ['date'], rowLimit: 400 }),
      gscQuery(token, site.gsc_url, { ...base, dimensions: ['query'], rowLimit: 25 }),
      gscQuery(token, site.gsc_url, { ...base, dimensions: ['page'], rowLimit: 25 }),
    ]);
    const series: SeriesPoint[] = byDate.map(r => ({
      date: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
    }));
    const totals = series.reduce((a, s) => ({
      clicks: a.clicks + s.clicks, impressions: a.impressions + s.impressions, ctr: 0, position: 0,
    }), { clicks: 0, impressions: 0, ctr: 0, position: 0 });
    totals.ctr = totals.impressions ? totals.clicks / totals.impressions : 0;
    totals.position = series.length ? series.reduce((a, s) => a + s.position, 0) / series.length : 0;
    return {
      available: true,
      totals,
      series,
      queries: byQuery.map(r => ({ query: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
      pages: byPage.map(r => ({ page: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
    };
  } catch (e) {
    return { ...empty, reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface DimensionRow { key: string; clicks: number; impressions: number; ctr: number; position: number }

// GSC country/device breakdown. (Bing has no comparable public traffic-by-
// country/device API, so this is Google-only — the UI says so.)
export async function getGoogleDimension(
  site: Site, days: number, dimension: 'country' | 'device'
): Promise<{ available: boolean; reason?: string; rows: DimensionRow[] }> {
  if (!site.google_account_id) return { available: false, reason: 'No Google account linked to this site.', rows: [] };
  let token: string;
  try {
    token = await getAccessTokenForAccount(site.google_account_id);
  } catch (e) {
    return { available: false, reason: `Google auth error: ${e instanceof Error ? e.message : e}`, rows: [] };
  }
  const { startDate, endDate } = rangeDates(days);
  try {
    const rows = await gscQuery(token, site.gsc_url, { startDate, endDate, dimensions: [dimension], rowLimit: 50 });
    return {
      available: true,
      rows: rows.map(r => ({ key: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
    };
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : String(e), rows: [] };
  }
}

export interface DailyQueryRow { date: string; query: string; clicks: number; impressions: number; position: number }

// Per-day, per-query GSC rows — the raw material for query-position-over-time
// trends and per-query alerting. (Bing exposes only aggregated query stats, no
// per-day breakdown, so trends/alerts are Google-sourced.)
export async function getGoogleDailyQueries(site: Site, days: number): Promise<DailyQueryRow[]> {
  if (!site.google_account_id) return [];
  let token: string;
  try {
    token = await getAccessTokenForAccount(site.google_account_id);
  } catch {
    return [];
  }
  const { startDate, endDate } = rangeDates(days);
  try {
    const rows = await gscQuery(token, site.gsc_url, { startDate, endDate, dimensions: ['date', 'query'], rowLimit: 5000 });
    return rows.map(r => ({
      date: r.keys?.[0] ?? '', query: r.keys?.[1] ?? '',
      clicks: r.clicks, impressions: r.impressions, position: r.position,
    })).filter(r => r.date && r.query);
  } catch {
    return [];
  }
}

// ── Bing Webmaster — rank/traffic + query/page stats ─────────────────────────

async function bingCall<T>(method: string, apiKey: string, siteUrl: string): Promise<T> {
  const res = await fetch(`${BING_BASE}/${method}?apikey=${encodeURIComponent(apiKey)}&siteUrl=${encodeURIComponent(siteUrl)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Bing ${method} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json() as { d: T }).d;
}

// Bing serialises dates as "/Date(1719705600000)/".
function parseBingDate(s: string | undefined): string {
  const m = /\/Date\((\d+)/.exec(s ?? '');
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : '';
}

export async function getBingPerformance(site: Site, days: number): Promise<EnginePerformance> {
  const empty: EnginePerformance = {
    available: false, totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 }, series: [], queries: [], pages: [],
  };
  const apiKey = bingKeyForSite(site.id);
  if (!apiKey) return { ...empty, reason: 'No Bing Webmaster API key configured (Settings).' };
  const siteUrl = deriveBingSiteUrl(site.gsc_url, site.domain);
  const cutoff = rangeDates(days).startDate;
  try {
    const [traffic, queries, pages] = await Promise.all([
      bingCall<Array<{ Date: string; Impressions: number; Clicks: number }>>('GetRankAndTrafficStats', apiKey, siteUrl),
      bingCall<Array<{ Query: string; Impressions: number; Clicks: number; AvgImpressionPosition: number }>>('GetQueryStats', apiKey, siteUrl).catch(() => []),
      bingCall<Array<{ Query: string; Impressions: number; Clicks: number }>>('GetPageStats', apiKey, siteUrl).catch(() => []),
    ]);
    const series: SeriesPoint[] = traffic
      .map(r => ({ date: parseBingDate(r.Date), clicks: r.Clicks ?? 0, impressions: r.Impressions ?? 0, ctr: 0, position: 0 }))
      .filter(p => p.date >= cutoff)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(p => ({ ...p, ctr: p.impressions ? p.clicks / p.impressions : 0 }));
    const totals = series.reduce((a, s) => ({
      clicks: a.clicks + s.clicks, impressions: a.impressions + s.impressions, ctr: 0, position: 0,
    }), { clicks: 0, impressions: 0, ctr: 0, position: 0 });
    totals.ctr = totals.impressions ? totals.clicks / totals.impressions : 0;
    return {
      available: true,
      totals,
      series,
      queries: (queries as Array<{ Query: string; Impressions: number; Clicks: number; AvgImpressionPosition?: number }>)
        .sort((a, b) => b.Clicks - a.Clicks).slice(0, 25)
        .map(r => ({ query: r.Query, clicks: r.Clicks, impressions: r.Impressions, ctr: r.Impressions ? r.Clicks / r.Impressions : 0, position: r.AvgImpressionPosition ?? 0 })),
      pages: (pages as Array<{ Query: string; Impressions: number; Clicks: number }>)
        .sort((a, b) => b.Clicks - a.Clicks).slice(0, 25)
        .map(r => ({ page: r.Query, clicks: r.Clicks, impressions: r.Impressions, ctr: r.Impressions ? r.Clicks / r.Impressions : 0, position: 0 })),
    };
  } catch (e) {
    return { ...empty, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── Bing crawl issues (the "errors they find" surface) ───────────────────────

export interface CrawlIssue { url: string; issues: string[]; code?: number }

export async function getBingCrawlIssues(site: Site): Promise<{ available: boolean; reason?: string; issues: CrawlIssue[] }> {
  const apiKey = bingKeyForSite(site.id);
  if (!apiKey) return { available: false, reason: 'No Bing Webmaster API key configured.', issues: [] };
  const siteUrl = deriveBingSiteUrl(site.gsc_url, site.domain);
  // Bit flags Bing uses in CrawlIssues.Issues.
  const FLAGS: Array<[number, string]> = [
    [1, 'HTTP 400/500'], [2, 'Malware'], [4, 'Blocked by robots.txt'], [8, 'Redirect'],
    [16, 'Contains malware'], [32, 'Not master (canonical)'], [64, 'Excluded by REP'], [128, 'DNS failure'],
  ];
  try {
    const rows = await bingCall<Array<{ Url: string; HttpCode?: number; Issues?: number }>>('GetCrawlIssues', apiKey, siteUrl);
    return {
      available: true,
      issues: rows.slice(0, 200).map(r => ({
        url: r.Url,
        code: r.HttpCode,
        issues: FLAGS.filter(([bit]) => (r.Issues ?? 0) & bit).map(([, label]) => label),
      })),
    };
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : String(e), issues: [] };
  }
}
