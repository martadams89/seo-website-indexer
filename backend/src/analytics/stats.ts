/**
 * Analytics engine: daily per-site rollups computed from url_state +
 * run_history + quota tables, alert generation on day-over-day regressions,
 * and the aggregate queries behind the dashboard.
 */
import { getDb, getAllSites, getEnabledSitesForWorkspace, type Site } from '../db/database.js';

export interface SiteSnapshot {
  site_id: string;
  day: string;
  urls_total: number;
  urls_submitted: number;
  urls_google: number;
  urls_indexnow: number;
  urls_indexed: number;
  urls_not_indexed: number;
  urls_with_schema: number;
  urls_stale: number;
  failures: number;
}

const INDEXED_STATES = ['Submitted and indexed', 'Indexed, not submitted in sitemap', 'INDEXING_ALLOWED'];

function computeSnapshot(siteId: string): SiteSnapshot {
  const db = getDb();
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`
    SELECT
      COUNT(*) AS urls_total,
      SUM(CASE WHEN last_submitted IS NOT NULL THEN 1 ELSE 0 END) AS urls_submitted,
      SUM(CASE WHEN gsc_last_inspected IS NOT NULL THEN 1 ELSE 0 END) AS urls_google,
      SUM(indexnow_submitted) AS urls_indexnow,
      SUM(CASE WHEN has_schema = 1 THEN 1 ELSE 0 END) AS urls_with_schema,
      SUM(CASE WHEN last_seen_lastmod IS NOT NULL AND gsc_last_inspected IS NOT NULL
                AND last_seen_lastmod > gsc_last_inspected THEN 1 ELSE 0 END) AS urls_stale
    FROM url_state WHERE site_id = ? AND COALESCE(indexnow_only, 0) = 0
  `).get(siteId) as Record<string, number | null>;

  const idx = db.prepare(`
    SELECT
      SUM(CASE WHEN gsc_indexing_state IN (${INDEXED_STATES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS indexed,
      SUM(CASE WHEN gsc_indexing_state IS NOT NULL AND gsc_indexing_state NOT IN (${INDEXED_STATES.map(() => '?').join(',')}) THEN 1 ELSE 0 END) AS not_indexed
    FROM url_state WHERE site_id = ? AND COALESCE(indexnow_only, 0) = 0
  `).get(...INDEXED_STATES, ...INDEXED_STATES, siteId) as { indexed: number | null; not_indexed: number | null };

  const failures = (db.prepare(`
    SELECT COUNT(*) AS c FROM url_failures f
    WHERE f.site_id = ? AND EXISTS (
      SELECT 1 FROM url_state s
      WHERE s.site_id = f.site_id AND s.url = f.url
        AND COALESCE(s.indexnow_only, 0) = 0
    )
  `).get(siteId) as { c: number } | undefined)?.c ?? 0;

  return {
    site_id: siteId,
    day,
    urls_total: row.urls_total ?? 0,
    urls_submitted: row.urls_submitted ?? 0,
    urls_google: row.urls_google ?? 0,
    urls_indexnow: row.urls_indexnow ?? 0,
    urls_indexed: idx.indexed ?? 0,
    urls_not_indexed: idx.not_indexed ?? 0,
    urls_with_schema: row.urls_with_schema ?? 0,
    urls_stale: row.urls_stale ?? 0,
    failures,
  };
}

export function recordAlert(
  siteId: string | null,
  kind: string,
  message: string,
  severity: 'info' | 'warn' | 'error' = 'warn',
  detail?: string,
  workspaceId?: string | null,
): void {
  const inferredWorkspace = workspaceId ?? (siteId
    ? (getDb().prepare('SELECT workspace_id FROM sites WHERE id = ?').get(siteId) as { workspace_id: string | null } | undefined)?.workspace_id
    : null);
  getDb().prepare(
    'INSERT INTO alerts(site_id, workspace_id, kind, severity, message, detail) VALUES(?,?,?,?,?,?)'
  ).run(siteId, inferredWorkspace ?? null, kind, severity, message, detail ?? null);
}

/** Snapshot enabled sites in one workspace (or all sites for maintenance jobs). */
export function snapshotAllSites(workspaceId: string | null = null): SiteSnapshot[] {
  const db = getDb();
  const out: SiteSnapshot[] = [];
  const targetSites = workspaceId ? getEnabledSitesForWorkspace(workspaceId) : getAllSites();
  for (const site of targetSites) {
    const snap = computeSnapshot(site.id);
    const prev = db.prepare(
      'SELECT * FROM site_stats_daily WHERE site_id = ? AND day < ? ORDER BY day DESC LIMIT 1'
    ).get(site.id, snap.day) as SiteSnapshot | undefined;

    db.prepare(`
      INSERT INTO site_stats_daily(site_id, day, urls_total, urls_submitted, urls_google, urls_indexnow,
        urls_indexed, urls_not_indexed, urls_with_schema, urls_stale, failures)
      VALUES(@site_id, @day, @urls_total, @urls_submitted, @urls_google, @urls_indexnow,
        @urls_indexed, @urls_not_indexed, @urls_with_schema, @urls_stale, @failures)
      ON CONFLICT(site_id, day) DO UPDATE SET
        urls_total=excluded.urls_total, urls_submitted=excluded.urls_submitted,
        urls_google=excluded.urls_google, urls_indexnow=excluded.urls_indexnow,
        urls_indexed=excluded.urls_indexed, urls_not_indexed=excluded.urls_not_indexed,
        urls_with_schema=excluded.urls_with_schema, urls_stale=excluded.urls_stale,
        failures=excluded.failures
    `).run(snap);

    if (prev) {
      if (prev.urls_indexed > 0 && snap.urls_indexed < prev.urls_indexed) {
        recordAlert(site.id, 'index_drop', `${site.domain}: indexed pages fell ${prev.urls_indexed} → ${snap.urls_indexed}`, 'error');
      }
      if (prev.urls_with_schema > 0 && snap.urls_with_schema < prev.urls_with_schema * 0.9) {
        recordAlert(site.id, 'schema_drop', `${site.domain}: pages with structured data fell ${prev.urls_with_schema} → ${snap.urls_with_schema}`, 'warn');
      }
    }
    out.push(snap);
  }
  return out;
}

export interface SiteOverview extends SiteSnapshot {
  name: string;
  domain: string;
  trend: Array<{ day: string; urls_indexed: number; urls_total: number }>;
}

// Scoped to one workspace's sites (the tenant boundary). A null workspace
// (user with no workspace) yields an empty overview.
export function getOverview(workspaceId: string | null): {
  sites: SiteOverview[];
  totals: { sites: number; urls_total: number; urls_indexed: number; urls_stale: number; failures: number; open_alerts: number };
} {
  const db = getDb();
  const sites: SiteOverview[] = [];
  const wsSites = workspaceId ? getAllSites().filter(s => s.workspace_id === workspaceId) : [];
  for (const site of wsSites) {
    const snap = computeSnapshot(site.id);
    const trend = db.prepare(
      'SELECT day, urls_indexed, urls_total FROM site_stats_daily WHERE site_id = ? ORDER BY day DESC LIMIT 30'
    ).all(site.id).reverse() as Array<{ day: string; urls_indexed: number; urls_total: number }>;
    sites.push({ ...snap, name: site.name, domain: site.domain, trend });
  }
  const openAlerts = workspaceId
    ? (db.prepare('SELECT COUNT(*) AS c FROM alerts WHERE acked = 0 AND workspace_id = ?').get(workspaceId) as { c: number }).c
    : 0;
  return {
    sites,
    totals: {
      sites: sites.length,
      urls_total: sites.reduce((s, x) => s + x.urls_total, 0),
      urls_indexed: sites.reduce((s, x) => s + x.urls_indexed, 0),
      urls_stale: sites.reduce((s, x) => s + x.urls_stale, 0),
      failures: sites.reduce((s, x) => s + x.failures, 0),
      open_alerts: openAlerts,
    },
  };
}

export interface FreshnessEntry {
  url: string;
  last_seen_lastmod: string;
  gsc_last_inspected: string | null;
  gsc_indexing_state: string | null;
}

/** Pages whose content changed after Google last looked — the resubmission worklist. */
export function getFreshnessRadar(siteId: string, limit = 100): FreshnessEntry[] {
  return getDb().prepare(`
    SELECT url, last_seen_lastmod, gsc_last_inspected, gsc_indexing_state
    FROM url_state
    WHERE site_id = ? AND COALESCE(indexnow_only, 0) = 0
      AND last_seen_lastmod IS NOT NULL AND gsc_last_inspected IS NOT NULL
      AND last_seen_lastmod > gsc_last_inspected
    ORDER BY last_seen_lastmod DESC LIMIT ?
  `).all(siteId, limit) as FreshnessEntry[];
}

export function getSiteDetail(siteId: string): {
  site: Site;
  snapshot: SiteSnapshot;
  trend: SiteSnapshot[];
  states: Array<{ state: string; count: number }>;
  freshness: FreshnessEntry[];
  failures: Array<{ url: string; api: string; fail_count: number; last_failed_at: string }>;
  crux: Array<{ day: string; lcp_ms: number | null; inp_ms: number | null; cls: number | null }>;
} | null {
  const db = getDb();
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId) as Site | undefined;
  if (!site) return null;
  return {
    site,
    snapshot: computeSnapshot(siteId),
    trend: db.prepare('SELECT * FROM site_stats_daily WHERE site_id = ? ORDER BY day DESC LIMIT 60').all(siteId).reverse() as SiteSnapshot[],
    states: db.prepare(`
      SELECT COALESCE(gsc_indexing_state, 'Never inspected') AS state, COUNT(*) AS count
      FROM url_state WHERE site_id = ? AND COALESCE(indexnow_only, 0) = 0
      GROUP BY gsc_indexing_state ORDER BY count DESC
    `).all(siteId) as Array<{ state: string; count: number }>,
    freshness: getFreshnessRadar(siteId, 50),
    failures: db.prepare(`
      SELECT f.url, f.api, f.fail_count, f.last_failed_at FROM url_failures f
      WHERE f.site_id = ? AND EXISTS (
        SELECT 1 FROM url_state s
        WHERE s.site_id = f.site_id AND s.url = f.url
          AND COALESCE(s.indexnow_only, 0) = 0
      )
      ORDER BY f.last_failed_at DESC LIMIT 50
    `).all(siteId) as Array<{ url: string; api: string; fail_count: number; last_failed_at: string }>,
    crux: db.prepare('SELECT day, lcp_ms, inp_ms, cls FROM crux_snapshots WHERE site_id = ? ORDER BY day DESC LIMIT 60').all(siteId).reverse() as Array<{ day: string; lcp_ms: number | null; inp_ms: number | null; cls: number | null }>,
  };
}

// Alerts for one workspace, including portfolio-level alerts with no site.
export function getAlerts(workspaceId: string | null, limit = 100): Array<Record<string, unknown>> {
  return getDb().prepare(`
    SELECT a.*, s.domain FROM alerts a
    LEFT JOIN sites s ON s.id = a.site_id
    WHERE COALESCE(a.workspace_id, s.workspace_id) = ?
    ORDER BY a.created_at DESC LIMIT ?
  `).all(workspaceId, limit) as Array<Record<string, unknown>>;
}

// Authorize an ack against the alert's explicit or inferred workspace.
export function alertInWorkspace(id: number, workspaceId: string | null): boolean {
  const row = getDb().prepare(`
    SELECT COALESCE(a.workspace_id, s.workspace_id) AS ws
    FROM alerts a LEFT JOIN sites s ON s.id = a.site_id WHERE a.id = ?
  `).get(id) as { ws: string | null } | undefined;
  return !!row && row.ws === workspaceId;
}

export function ackAlert(id: number): void {
  getDb().prepare('UPDATE alerts SET acked = 1 WHERE id = ?').run(id);
}
