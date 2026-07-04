/**
 * Search-performance rollup store: caches GSC + Bing daily metrics so we can
 * show week-over-week deltas and query-position-over-time without re-hitting
 * the APIs on every page load, and drives per-query alerting.
 *
 * GSC data is revised for ~2 days after the fact, so each snapshot re-fetches
 * a short trailing window and upserts (idempotent overwrite).
 */
import { getDb, getAllSites, type Site } from '../db/database.js';
import { getGooglePerformance, getBingPerformance, getGoogleDailyQueries } from '../indexer/performance.js';
import { recordAlert } from './stats.js';
import { logSystem } from '../utils/logger.js';

const TRAILING_DAYS = 5; // re-fetch this many recent days each snapshot (GSC lag)

type Engine = 'google' | 'bing';

function upsertDaily(siteId: string, engine: Engine, series: Array<{ date: string; clicks: number; impressions: number; ctr: number; position: number }>) {
  const stmt = getDb().prepare(`
    INSERT INTO perf_daily(site_id, engine, day, clicks, impressions, ctr, position)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(site_id, engine, day) DO UPDATE SET
      clicks=excluded.clicks, impressions=excluded.impressions, ctr=excluded.ctr, position=excluded.position
  `);
  const tx = getDb().transaction((rows: typeof series) => {
    for (const r of rows) if (r.date) stmt.run(siteId, engine, r.date, r.clicks, r.impressions, r.ctr, r.position);
  });
  tx(series);
}

function upsertQueryDaily(siteId: string, rows: Array<{ date: string; query: string; clicks: number; impressions: number; position: number }>) {
  const stmt = getDb().prepare(`
    INSERT INTO perf_query_daily(site_id, engine, day, query, clicks, impressions, position)
    VALUES(?, 'google', ?, ?, ?, ?, ?)
    ON CONFLICT(site_id, engine, day, query) DO UPDATE SET
      clicks=excluded.clicks, impressions=excluded.impressions, position=excluded.position
  `);
  const tx = getDb().transaction((rs: typeof rows) => {
    for (const r of rs) stmt.run(siteId, r.date, r.query, r.clicks, r.impressions, r.position);
  });
  tx(rows);
}

/** Snapshot one site: refresh trailing daily rollups + query rows, then alert. */
export async function snapshotSitePerformance(site: Site): Promise<void> {
  const [g, b, dailyQ] = await Promise.all([
    getGooglePerformance(site, TRAILING_DAYS),
    getBingPerformance(site, TRAILING_DAYS),
    getGoogleDailyQueries(site, TRAILING_DAYS),
  ]);
  if (g.available) upsertDaily(site.id, 'google', g.series);
  if (b.available) upsertDaily(site.id, 'bing', b.series);
  if (dailyQ.length) upsertQueryDaily(site.id, dailyQ);
  checkQueryAlerts(site);
}

/** Snapshot every site (called after each indexing run). Best-effort per site. */
export async function snapshotAllPerformance(): Promise<number> {
  let n = 0;
  for (const site of getAllSites()) {
    try { await snapshotSitePerformance(site); n++; }
    catch (e) { logSystem('warn', `Perf snapshot failed for ${site.domain}: ${e instanceof Error ? e.message : e}`); }
  }
  return n;
}

// ── Week-over-week deltas ────────────────────────────────────────────────────

export interface WowDelta {
  metric: 'clicks' | 'impressions' | 'ctr' | 'position';
  current: number;
  previous: number;
  changePct: number; // signed
}

function sumRange(siteId: string, engine: Engine, fromDaysAgo: number, toDaysAgo: number) {
  const end = new Date(); end.setDate(end.getDate() - toDaysAgo);
  const start = new Date(); start.setDate(start.getDate() - fromDaysAgo);
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(impressions),0) AS impressions,
           COALESCE(AVG(position),0) AS position
    FROM perf_daily WHERE site_id=? AND engine=? AND day >= ? AND day < ?
  `).get(siteId, engine, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)) as { clicks: number; impressions: number; position: number };
  return { clicks: row.clicks, impressions: row.impressions, ctr: row.impressions ? row.clicks / row.impressions : 0, position: row.position };
}

export function getWowDeltas(siteId: string, engine: Engine): WowDelta[] {
  const cur = sumRange(siteId, engine, 7, 0);
  const prev = sumRange(siteId, engine, 14, 7);
  const pct = (c: number, p: number) => p === 0 ? (c > 0 ? 100 : 0) : ((c - p) / p) * 100;
  return [
    { metric: 'clicks', current: cur.clicks, previous: prev.clicks, changePct: pct(cur.clicks, prev.clicks) },
    { metric: 'impressions', current: cur.impressions, previous: prev.impressions, changePct: pct(cur.impressions, prev.impressions) },
    { metric: 'ctr', current: cur.ctr, previous: prev.ctr, changePct: pct(cur.ctr, prev.ctr) },
    // position: lower is better, so invert the sign for display sanity downstream
    { metric: 'position', current: cur.position, previous: prev.position, changePct: pct(cur.position, prev.position) },
  ];
}

export interface SiteMover {
  site_id: string;
  name: string;
  domain: string;
  clicks: { current: number; previous: number; changePct: number };
  impressions: { current: number; previous: number; changePct: number };
  position: { current: number; previous: number; changePct: number };
}

/**
 * Portfolio-wide search movers: each site's Google WoW deltas (7d vs prior 7d)
 * from the cached rollups, for the Analytics landing page. Sites with no
 * cached perf data yet are omitted. Sorted by absolute clicks change so the
 * biggest movers (up or down) surface first.
 */
export function getPortfolioMovers(workspaceId: string | null): SiteMover[] {
  const pct = (c: number, p: number) => p === 0 ? (c > 0 ? 100 : 0) : ((c - p) / p) * 100;
  const movers: SiteMover[] = [];
  const wsSites = workspaceId ? getAllSites().filter(s => s.workspace_id === workspaceId) : [];
  for (const site of wsSites) {
    const cur = sumRange(site.id, 'google', 7, 0);
    const prev = sumRange(site.id, 'google', 14, 7);
    if (cur.clicks === 0 && cur.impressions === 0 && prev.clicks === 0 && prev.impressions === 0) continue;
    movers.push({
      site_id: site.id, name: site.name, domain: site.domain,
      clicks: { current: cur.clicks, previous: prev.clicks, changePct: pct(cur.clicks, prev.clicks) },
      impressions: { current: cur.impressions, previous: prev.impressions, changePct: pct(cur.impressions, prev.impressions) },
      position: { current: cur.position, previous: prev.position, changePct: pct(cur.position, prev.position) },
    });
  }
  return movers.sort((a, b) => Math.abs(b.clicks.changePct) - Math.abs(a.clicks.changePct));
}

// ── Query-position-over-time ─────────────────────────────────────────────────

export interface QueryTrendPoint { day: string; clicks: number; impressions: number; position: number }

export function getQueryTrend(siteId: string, query: string, days = 90): QueryTrendPoint[] {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  return getDb().prepare(`
    SELECT day, clicks, impressions, position FROM perf_query_daily
    WHERE site_id=? AND engine='google' AND query=? AND day >= ?
    ORDER BY day ASC
  `).all(siteId, query, cutoff.toISOString().slice(0, 10)) as QueryTrendPoint[];
}

/** Top queries we have history for (union of recent perf_query_daily). */
export function getTrackableQueries(siteId: string, limit = 100): Array<{ query: string; clicks: number }> {
  return getDb().prepare(`
    SELECT query, SUM(clicks) AS clicks FROM perf_query_daily
    WHERE site_id=? AND engine='google' AND day >= date('now','-28 days')
    GROUP BY query ORDER BY clicks DESC LIMIT ?
  `).all(siteId, limit) as Array<{ query: string; clicks: number }>;
}

// ── Tracked queries + alerting ───────────────────────────────────────────────

export interface TrackedQuery { id: number; site_id: string; query: string; last_position: number | null; created_at: string }

export function listTrackedQueries(siteId: string): TrackedQuery[] {
  return getDb().prepare('SELECT * FROM tracked_queries WHERE site_id=? ORDER BY query').all(siteId) as TrackedQuery[];
}

export function addTrackedQuery(siteId: string, query: string): void {
  getDb().prepare('INSERT OR IGNORE INTO tracked_queries(site_id, query) VALUES(?, ?)').run(siteId, query.trim());
}

export function removeTrackedQuery(id: number): void {
  getDb().prepare('DELETE FROM tracked_queries WHERE id=?').run(id);
}

const POSITION_DROP_ALERT = 3;   // avg positions worse to alert on
const MIN_IMPRESSIONS = 10;      // ignore noise from tiny-volume queries

/**
 * For each tracked query, compare the latest 3-day avg position to the stored
 * baseline; alert on a meaningful worsening, and refresh the baseline.
 */
export function checkQueryAlerts(site: Site): void {
  const db = getDb();
  const tracked = listTrackedQueries(site.id);
  for (const t of tracked) {
    const recent = db.prepare(`
      SELECT AVG(position) AS pos, SUM(impressions) AS impr FROM perf_query_daily
      WHERE site_id=? AND engine='google' AND query=? AND day >= date('now','-3 days')
    `).get(site.id, t.query) as { pos: number | null; impr: number | null };
    const pos = recent.pos;
    if (pos == null || (recent.impr ?? 0) < MIN_IMPRESSIONS) continue;
    if (t.last_position != null && pos - t.last_position >= POSITION_DROP_ALERT) {
      recordAlert(
        site.id, 'query_drop',
        `${site.domain}: "${t.query}" dropped ${t.last_position.toFixed(1)} → ${pos.toFixed(1)} in Google`,
        'warn',
      );
    }
    db.prepare('UPDATE tracked_queries SET last_position=? WHERE id=?').run(pos, t.id);
  }
}
