/**
 * Page-level Core Web Vitals, prioritised by search traffic.
 *
 * Site-level CrUX says whether the origin passes; it cannot say which pages to
 * fix first. Weekly, this queries CrUX (mobile, as Google indexes mobile-first)
 * for the pages with the most Google clicks and raises an Action Centre item
 * for each page failing a Core Web Vital, ordered by the traffic at stake.
 */
import { getDb, effectiveSetting, type Site } from '../db/database.js';
import { queryCruxRecord, type CruxResult } from '../ai/crux.js';
import { pagePerformance } from './page-performance.js';
import { createWorkItem, resolveWorkItemsBySourceRef } from '../platform/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_DAYS = 7;       // CrUX is a 28-day rolling dataset; weekly is plenty
const TOP_PAGES = 25;

// https://web.dev/articles/vitals — "good" / "poor" p75 thresholds.
export const THRESHOLDS = {
  lcp_ms: { good: 2500, poor: 4000, label: 'LCP', unit: 'ms' },
  inp_ms: { good: 200, poor: 500, label: 'INP', unit: 'ms' },
  cls: { good: 0.1, poor: 0.25, label: 'CLS', unit: '' },
} as const;

export type VitalRating = 'good' | 'needs_improvement' | 'poor';

export interface VitalAssessment {
  rating: VitalRating;
  failing: Array<{ metric: keyof typeof THRESHOLDS; label: string; value: number; rating: VitalRating }>;
}

export function assessVitals(r: CruxResult): VitalAssessment {
  const failing: VitalAssessment['failing'] = [];
  for (const metric of Object.keys(THRESHOLDS) as Array<keyof typeof THRESHOLDS>) {
    const value = r[metric];
    if (value === null || value === undefined) continue;
    const t = THRESHOLDS[metric];
    if (value > t.good) failing.push({ metric, label: t.label, value, rating: value > t.poor ? 'poor' : 'needs_improvement' });
  }
  const rating: VitalRating = failing.some(f => f.rating === 'poor') ? 'poor' : failing.length ? 'needs_improvement' : 'good';
  return { rating, failing };
}

const fmt = (metric: keyof typeof THRESHOLDS, v: number) =>
  metric === 'cls' ? v.toFixed(2) : `${Math.round(v)} ms`;

export interface PageVitalsRow {
  url: string;
  day: string;
  has_data: number;
  lcp_ms: number | null;
  inp_ms: number | null;
  cls: number | null;
  rating: VitalRating | null;
  clicks: number;
  impressions: number;
  position: number | null;
}

/** Latest measurement per page, most clicked first. */
export function listPageVitals(siteId: string): PageVitalsRow[] {
  const rows = getDb().prepare(`
    SELECT v.* FROM page_vitals v
    JOIN (SELECT url, MAX(day) day FROM page_vitals WHERE site_id = ? GROUP BY url) latest
      ON latest.url = v.url AND latest.day = v.day
    WHERE v.site_id = ?
  `).all(siteId, siteId) as Array<Omit<PageVitalsRow, 'rating' | 'clicks' | 'impressions' | 'position'>>;
  const perf = pagePerformance(siteId);
  return rows.map(r => {
    const p = perf.get(r.url);
    return {
      ...r,
      rating: r.has_data ? assessVitals(r).rating : null,
      clicks: p?.clicks ?? 0,
      impressions: p?.impressions ?? 0,
      position: p ? Math.round(p.position * 10) / 10 : null,
    };
  }).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

/**
 * Refresh page vitals for the site's most-clicked pages if the last check is
 * older than a week. Needs a CrUX API key and page-level Search Console data.
 */
export async function refreshPageVitals(site: Site, now: number = Date.now(), force = false): Promise<{ checked: number; failing: number } | null> {
  const key = effectiveSetting(site.workspace_id ?? null, 'crux_api_key');
  if (!key) return null;
  const last = (getDb().prepare('SELECT MAX(day) day FROM page_vitals WHERE site_id = ?').get(site.id) as { day: string | null }).day;
  if (!force && last && now - Date.parse(last) < REFRESH_DAYS * DAY_MS) return null;

  const perf = pagePerformance(site.id, 28, now);
  const top = [...perf.entries()].filter(([, p]) => p.clicks > 0)
    .sort((a, b) => b[1].clicks - a[1].clicks).slice(0, TOP_PAGES);
  if (top.length === 0) return { checked: 0, failing: 0 };

  const day = new Date(now).toISOString().slice(0, 10);
  const insert = getDb().prepare(`
    INSERT INTO page_vitals(site_id, url, day, has_data, lcp_ms, inp_ms, cls) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(site_id, url, day) DO UPDATE SET has_data=excluded.has_data, lcp_ms=excluded.lcp_ms, inp_ms=excluded.inp_ms, cls=excluded.cls
  `);
  let failing = 0;
  const passingRefs: string[] = [];
  for (const [url, p] of top) {
    let result: CruxResult | null;
    try {
      result = await queryCruxRecord(key, { url, formFactor: 'PHONE' });
    } catch {
      continue; // quota or transient error: try again next week
    }
    insert.run(site.id, url, day, result ? 1 : 0, result?.lcp_ms ?? null, result?.inp_ms ?? null, result?.cls ?? null);
    const ref = `${site.id}:${url}`;
    if (!result) continue; // not enough real-user data for this page
    const assessment = assessVitals(result);
    if (assessment.rating === 'good') { passingRefs.push(ref); continue; }
    failing++;
    if (!site.workspace_id) continue;
    const detail = assessment.failing.map(f => `${f.label} ${fmt(f.metric, f.value)} (${f.rating === 'poor' ? 'poor' : 'needs improvement'})`).join(', ');
    createWorkItem({
      workspaceId: site.workspace_id, siteId: site.id, source: 'page_vitals', sourceRef: ref,
      title: `Core Web Vitals failing on a page with ${p.clicks.toLocaleString()} Google clicks/28 days`,
      description: `Mobile real-user p75: ${detail}. This page earns ${p.clicks} clicks from ${p.impressions} impressions at average position ${p.position.toFixed(1)}, so it is among the pages where page experience matters most. Run PageSpeed Insights on it for the specific causes.`,
      severity: assessment.rating === 'poor' ? 'high' : 'medium',
      evidence: { url, ...result, rating: assessment.rating, clicks: p.clicks, impressions: p.impressions, position: p.position, day },
      deepLink: `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(url)}&form_factor=mobile`,
    });
  }
  if (site.workspace_id) resolveWorkItemsBySourceRef(site.workspace_id, 'page_vitals', passingRefs);
  return { checked: top.length, failing };
}
