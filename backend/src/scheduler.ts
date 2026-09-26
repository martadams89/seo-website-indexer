/**
 * scheduler.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Round-robin multi-site scheduler with lastmod change detection.
 *
 * Strategy:
 *  1. Fetch all enabled sites' live sitemaps in parallel.
 *  2. Diff against stored lastmod values → identify new/changed URLs per site.
 *  3. Re-submit each sitemap whose URLs or lastmod values changed through the
 *     Search Console Sitemaps API (the supported replacement for the retired
 *     sitemap ping endpoint).
 *  4. Send new/changed URLs to IndexNow and Bing Webmaster.
 *  5. Inspect URLs, unknown and needs-attention pages first.
 *  6. For sites that opt in, spend the Indexing API's daily quota only on pages
 *     inspection shows are not indexed or changed after Google's last crawl.
 *  7. Progress and logs stream via SSE to the frontend.
 *
 * Google documents the Indexing API for JobPosting and livestream
 * BroadcastEvent pages only; its effect on other pages is not guaranteed, so
 * step 6 is off unless a site enables it. Sitemaps remain the primary signal.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import cron from 'node-cron';
import { randomUUID } from 'crypto';
import {
  getAllSites,
  getEnabledSitesForWorkspace,
  getWorkspaceIdsWithSites,
  getSetting,
  getUrlState,
  upsertUrlState,
  upsertSite,
  getSiteById,
  getUrlsBySite,
  pruneHtmlUrlStateForSite,
  insertLog,
  insertRun,
  updateRun,
  getAllGoogleAccounts,
  incrementQuota,
  getQuotaUsage,
  recordUrlFailure,
  clearUrlFailure,
  getRecentlyBackedOffUrls,
  acquireRunLock,
  releaseRunLock,
  pruneOldQuotaUsage,
  getDb,
  getSitemapState,
  recordSitemapSubmitted,
  getGoogleAccountById,
  recordSitemapFeedback,
  type Site,
  type LogEntry,
} from './db/database.js';
import { emitLog, subscribeToLogs } from './utils/logger.js';
import { fetchAllSitemaps, filterChangedEntries, isNonHtmlUrl, type SitemapEntry } from './indexer/sitemap.js';
import { submitSitemapToGSC, inspectGoogleUrl, listGSCSitemaps } from './indexer/google.js';
import {
  inspectionFinding,
  INSPECTION_FINDING_CODES,
  contentFingerprint,
  lastmodQuality,
} from './indexer/google-feedback.js';
import { createWorkItem, resolveWorkItemsBySourceRef, countOpenWorkItems, getOpenWorkItemRefs, addAnnotation } from './platform/store.js';
import { parsePage, host as pageHost } from './platform/page-evidence.js';
import {
  analyseInternalLinks,
  listInventory,
  inventoryFetchTimes,
  getInventoryPage,
  upsertInventoryPage,
  type InternalLinkReport,
} from './analytics/internal-links.js';
import { pagePerformance, recordSnippetChange } from './analytics/page-performance.js';
import { refreshPageVitals } from './analytics/page-vitals.js';
import { computePlaybook, listOpportunities } from './analytics/playbook.js';
import {
  sitemapGroups,
  prioritiseInspections,
  selectIndexingCandidates,
  indexingQuotaBucket,
  hasIndexingScope,
  publishUrlUpdated,
  publishUrlDeleted,
  type SitemapGroup,
} from './indexer/google-indexing.js';
import { submitToIndexNowInBatches, getOrCreateIndexNowKey } from './indexer/indexnow.js';
import { submitToBingInBatches, getBingQuota, deriveBingSiteUrl } from './indexer/bing.js';
import { bingCredentialForSite } from './auth/workspaces.js';
import { auditRobotsTxt, probeLlmsTxt, parseSemanticSchema } from './indexer/geo.js';
import { deployGeoFiles } from './indexer/geo-deploy.js';
import { snapshotAllSites } from './analytics/stats.js';
import { snapshotAllPerformance } from './analytics/perf-store.js';
import { snapshotAllAgentReadiness } from './analytics/agent-readiness-store.js';
import { sendWorkspaceNotification, configuredChannels, notificationEventEnabled } from './utils/notify.js';
import { runPlatformAutomation } from './platform/automation.js';
import { readResponseText, safeFetch } from './security/outbound-url.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// Google URL Inspection API: 2000 inspections/day per Search Console property.
// (https://developers.google.com/webmaster-tools/limits)
const parsedGscInspectionLimit = parseInt(process.env.GSC_INSPECTION_DAILY_LIMIT ?? '', 10);
const GSC_INSPECTION_DAILY_LIMIT_PER_PROPERTY = Number.isFinite(parsedGscInspectionLimit)
  ? Math.max(1, parsedGscInspectionLimit)
  : 2000;

// IndexNow: no public daily cap, but >10k URLs/site/day risks soft-throttling.
// We submit changed URLs immediately + rolling batches for no-lastmod sites.
const INDEXNOW_DAILY_LIMIT_PER_SITE = 10_000;
const INDEXNOW_NO_LASTMOD_BATCH = 500;

// Google Indexing API: default publish quota is 200 URL notifications/day per
// Cloud project. Override when Google has granted a higher quota.
const parsedIndexingLimit = parseInt(process.env.GOOGLE_INDEXING_DAILY_LIMIT ?? '', 10);
export const GOOGLE_INDEXING_DAILY_LIMIT = Number.isFinite(parsedIndexingLimit)
  ? Math.max(0, parsedIndexingLimit)
  : 200;

// Polite pacing
const GSC_INSPECTION_DELAY_MS = 350;
const GOOGLE_INDEXING_DELAY_MS = 250;

export { subscribeToLogs };

// ── Run State ─────────────────────────────────────────────────────────────────

// Runs are PER-WORKSPACE: different tenants run concurrently, each with its own
// state + persistent lock, and a run shows as "running" only in its workspace.
interface ActiveRun { runId: string; workspaceId: string; stopRequested: boolean; }
const _activeRuns = new Map<string, ActiveRun>(); // keyed by workspaceId
let _scheduledTask: ReturnType<typeof cron.schedule> | null = null;
let _platformTask: ReturnType<typeof cron.schedule> | null = null;

/** Is a run active? For a specific workspace, or (no arg) anywhere. */
export function isRunning(workspaceId?: string | null): boolean {
  return workspaceId ? _activeRuns.has(workspaceId) : _activeRuns.size > 0;
}
export function getCurrentRunId(workspaceId?: string | null): string | null {
  if (workspaceId) return _activeRuns.get(workspaceId)?.runId ?? null;
  const first = _activeRuns.values().next().value as ActiveRun | undefined;
  return first?.runId ?? null;
}
export function forceStopRun(workspaceId: string): void {
  const r = _activeRuns.get(workspaceId);
  if (r) r.stopRequested = true;
}

/** Which workspace owns a given run (for tagging its logs). */
function workspaceForRun(runId: string): string | null {
  for (const r of _activeRuns.values()) if (r.runId === runId) return r.workspaceId;
  return null;
}

// ── Log Helper ────────────────────────────────────────────────────────────────

function log(
  runId: string,
  level: LogEntry['level'],
  message: string,
  siteId?: string,
  url?: string
): void {
  const entry: LogEntry = { run_id: runId, workspace_id: workspaceForRun(runId), level, message, site_id: siteId, url };
  insertLog(entry);
  emitLog(entry);

  const prefix = `[${level.toUpperCase()}]`;
  if (level === 'error') {
    console.error(`${prefix} [Run: ${runId}] ${message} ${url ? `(${url})` : ''}`);
  } else {
    console.log(`${prefix} [Run: ${runId}] ${message} ${url ? `(${url})` : ''}`);
  }
}

// ── Main Run ──────────────────────────────────────────────────────────────────

export interface RunOptions {
  /** The workspace (tenant) to run. Required — runs are per-workspace. */
  workspaceId?: string;
  trigger?: 'manual' | 'scheduled';
  /** Only run for specific site IDs */
  siteIds?: string[];
  /** Skip Google URL Inspection (sitemap submission is controlled separately) */
  skipGoogle?: boolean;
  /** Skip IndexNow */
  skipIndexNow?: boolean;
  /** Skip Bing Webmaster URL submission */
  skipBing?: boolean;
  /** Skip GSC sitemap submission */
  skipSitemaps?: boolean;
  /** Skip Google Indexing API notifications (only runs for opted-in sites anyway) */
  skipIndexingApi?: boolean;
  /** Override per-property URL Inspection daily limit for this run */
  gscLimit?: number;
}

export async function runIndexing(options: RunOptions = {}): Promise<string> {
  const workspaceId = options.workspaceId;
  if (!workspaceId) throw new Error('runIndexing requires a workspaceId (runs are per-workspace).');
  if (_activeRuns.has(workspaceId)) throw new Error('An indexing run is already in progress for this workspace.');

  const runId    = randomUUID();
  const trigger  = options.trigger ?? 'manual';

  // Per-workspace persistent lock with TTL so a crashed run doesn't block forever.
  if (!acquireRunLock(runId, workspaceId)) {
    throw new Error("Another run holds this workspace's lock. Wait for it to expire (max 60 min) or restart the server.");
  }

  const activeRun: ActiveRun = { runId, workspaceId, stopRequested: false };
  _activeRuns.set(workspaceId, activeRun);

  const run = {
    id: runId,
    workspace_id: workspaceId,
    started_at: new Date().toISOString(),
    finished_at: null,
    status: 'running' as const,
    total_submitted: 0,
    total_skipped: 0,
    total_failed: 0,
    trigger,
  };
  insertRun(run);

  // Run async, don't await here — caller can track via SSE
  _doRun(runId, run, options, activeRun).finally(() => {
    _activeRuns.delete(workspaceId);
    releaseRunLock(workspaceId);
  });

  return runId;
}

// ── Action Centre findings ───────────────────────────────────────────────────

const LASTMOD_ISSUE_CODES = ['future_lastmod', 'uniform_lastmod', 'lastmod_without_change'] as const;
// Cap open per-page inspection items per site so a large backlog fills the
// Action Centre as earlier items are fixed rather than all at once.
const MAX_OPEN_INSPECTION_ITEMS_PER_SITE = 50;

interface SiteFinding {
  code: string;
  title: string;
  description: string;
  severity: string;
  evidence: Record<string, unknown>;
  deepLink?: string;
}

const GSC_UI = 'https://search.google.com/search-console';
const gscInspectLink = (site: Site, url: string) =>
  `${GSC_UI}/inspect?resource_id=${encodeURIComponent(site.gsc_url)}&id=${encodeURIComponent(url)}`;
const gscSitemapsLink = (site: Site) => `${GSC_UI}/sitemaps?resource_id=${encodeURIComponent(site.gsc_url)}`;

/**
 * Raise an Action Centre item per current finding and close open items for
 * codes that no longer apply. `url` scopes findings to one page. Never throws —
 * work-item bookkeeping must not fail an indexing run.
 */
function syncSiteFindings(site: Site, source: string, codes: readonly string[], findings: SiteFinding[], url?: string): void {
  if (!site.workspace_id) return;
  const ref = (code: string) => (url ? `${site.id}:${code}:${url}` : `${site.id}:${code}`);
  try {
    for (const f of findings) {
      createWorkItem({
        workspaceId: site.workspace_id, siteId: site.id, source, sourceRef: ref(f.code),
        title: f.title, description: f.description, severity: f.severity, evidence: f.evidence,
        deepLink: f.deepLink ?? '/sites',
      });
    }
    const current = new Set(findings.map(f => f.code));
    resolveWorkItemsBySourceRef(site.workspace_id, source, codes.filter(c => !current.has(c)).map(ref));
  } catch (e) {
    console.error(`[scheduler] Work item sync failed for ${site.domain}:`, e instanceof Error ? e.message : e);
  }
}

/** Per-site result of Step 1, shared by the later submission steps. */
interface RunSiteData {
  site: Site;
  changed: SitemapEntry[];
  newUrls: SitemapEntry[];
  noLastmod: SitemapEntry[];
  /** Non-HTML URLs (e.g. llms.txt) from robots.txt secondary sitemaps — IndexNow only. */
  extraChanged: SitemapEntry[];
  extraNewUrls: SitemapEntry[];
  extraNoLastmod: SitemapEntry[];
  /** Per-sitemap signatures of indexable HTML pages, for Sitemaps API resubmission. */
  sitemapGroups: SitemapGroup[];
  /** Current sitemap lastmod for every live HTML page. */
  lastmodByUrl: Map<string, string | undefined>;
  /** URLs that left the sitemap this run, with what they now return. */
  removed: RemovedUrl[];
  error?: string;
}

// ── Page fetch, removals and internal-link helpers ───────────────────────────

const PAGE_FETCH_CONCURRENCY = 4;
// Page inventory for the internal link map: refresh the stalest slice each run
// so a site is fully re-mapped about weekly without a crawl spike.
const INVENTORY_REFRESH_PER_RUN = 150;
const INVENTORY_MAX_AGE_DAYS = 7;
const MAX_REMOVAL_PROBES = 200;
const MAX_OPEN_INTERNAL_LINK_ITEMS_PER_SITE = 30;

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

interface RemovedUrl {
  url: string;
  /** gone = 404/410, moved = redirect, live = still 200, unknown = could not tell. */
  state: 'gone' | 'moved' | 'live' | 'unknown';
  status: number;
}

/** What URLs that just left the sitemap now return (no redirects followed). */
async function probeRemovedUrls(urls: string[]): Promise<RemovedUrl[]> {
  const out: RemovedUrl[] = [];
  await mapWithConcurrency(urls, PAGE_FETCH_CONCURRENCY, async (url) => {
    try {
      let res = await safeFetch(url, {
        method: 'HEAD', headers: { 'User-Agent': 'SEOWebsiteIndexer/1.0 (removal-check)' }, signal: AbortSignal.timeout(10_000),
      }, { label: 'Removed URL', maxRedirects: 0 });
      if (res.status === 405 || res.status === 501) {
        res = await safeFetch(url, {
          headers: { 'User-Agent': 'SEOWebsiteIndexer/1.0 (removal-check)' }, signal: AbortSignal.timeout(10_000),
        }, { label: 'Removed URL', maxRedirects: 0 });
      }
      await res.body?.cancel().catch(() => undefined);
      const state = res.status === 404 || res.status === 410 ? 'gone'
        : res.status >= 300 && res.status < 400 ? 'moved'
        : res.status >= 200 && res.status < 300 ? 'live' : 'unknown';
      out.push({ url, state, status: res.status });
    } catch {
      out.push({ url, state: 'unknown', status: 0 });
    }
  });
  return out;
}

/** Action Centre items for confirmed orphans and weakly linked page-two pages. */
function syncInternalLinkItems(site: Site, report: InternalLinkReport): void {
  if (!site.workspace_id || !report.orphansConfirmed) return;
  const ref = (url: string) => `${site.id}:${url}`;
  try {
    const flagged = new Set(report.weakOrOrphanUrls);
    for (const target of report.targets) {
      if (target.kind !== 'orphan' && !target.pageTwo) continue;
      if (countOpenWorkItems(site.workspace_id, site.id, 'internal_links') >= MAX_OPEN_INTERNAL_LINK_ITEMS_PER_SITE) break;
      const suggestions = target.suggestions.slice(0, 3)
        .map(sg => `• ${sg.source}${sg.sharedTerms.length ? ` (shared topic: ${sg.sharedTerms.slice(0, 3).join(', ')})` : ''}`).join('\n');
      const ranking = target.pageTwo ? ` It already ranks around position ${target.position} with ${target.impressions} impressions in 28 days, so stronger internal links have real upside.` : '';
      createWorkItem({
        workspaceId: site.workspace_id, siteId: site.id, source: 'internal_links', sourceRef: ref(target.url),
        title: target.kind === 'orphan' ? 'Page has no internal links pointing to it' : `Page-two page has only ${target.inbound} internal link${target.inbound === 1 ? '' : 's'}`,
        description: `${target.kind === 'orphan' ? 'No other page on the site links here, so Google can only find it through the sitemap and treats it as unimportant.' : 'Few pages link here, which limits how much importance Google assigns to it.'}${ranking}` +
          (suggestions ? `\n\nAdd a contextual link${target.anchorHint ? ` (e.g. anchor text "${target.anchorHint}")` : ''} from:\n${suggestions}` : ''),
        severity: target.kind === 'orphan' || target.pageTwo ? 'high' : 'medium',
        evidence: { url: target.url, inbound: target.inbound, kind: target.kind, page_two: target.pageTwo, position: target.position, impressions: target.impressions, suggestions: target.suggestions },
        deepLink: `/insights/search/${encodeURIComponent(site.id)}#internal-links`,
      });
    }
    const open = getOpenWorkItemRefs(site.workspace_id, site.id, 'internal_links');
    resolveWorkItemsBySourceRef(site.workspace_id, 'internal_links',
      open.filter(r => !flagged.has(r.slice(site.id.length + 1))));
  } catch (e) {
    console.error(`[scheduler] Internal link item sync failed for ${site.domain}:`, e instanceof Error ? e.message : e);
  }
}

async function _doRun(
  runId: string,
  run: { total_submitted: number; total_skipped: number; total_failed: number },
  options: RunOptions,
  activeRun: ActiveRun
): Promise<void> {
  // Only this workspace's enabled sites (tenant isolation for runs).
  let allSites = getEnabledSitesForWorkspace(activeRun.workspaceId);
  if (options.siteIds?.length) {
    allSites = allSites.filter(s => options.siteIds!.includes(s.id));
  }

  if (allSites.length === 0) {
    log(runId, 'warn', 'No enabled sites configured. Add sites via the dashboard.');
    updateRun(runId, { status: 'completed', finished_at: new Date().toISOString(), ...run });
    return;
  }

  const allAccounts = getAllGoogleAccounts();
  log(runId, 'info', `Starting indexing run — ${allSites.length} site(s) | sitemap + Search Console + IndexNow + Bing | trigger: ${options.trigger ?? 'manual'}`);

  // ── Step 1: Fetch & diff sitemaps ─────────────────────────────────────────

  log(runId, 'info', '── Step 1: Fetching live sitemaps and detecting changes ──');

  const siteDataMap = new Map<string, RunSiteData>();

  await Promise.all(allSites.map(async (site) => {
    if (activeRun.stopRequested) return;
    try {
      // Fetch the primary sitemap PLUS any sitemaps declared in robots.txt
      // (e.g. llms-sitemap.xml). Partition into indexable HTML pages and
      // non-HTML URLs (llms.txt, feeds…) which are routed to IndexNow only.
      const { entries: allEntries, sitemapsUsed } = await fetchAllSitemaps(site.sitemap_url, site.domain);
      const htmlEntries = allEntries.filter(e => !isNonHtmlUrl(e.url));
      const nonHtmlEntries = allEntries.filter(e => isNonHtmlUrl(e.url));
      log(runId, 'info',
        `${site.domain} — fetched ${allEntries.length} URLs from ${sitemapsUsed.length} sitemap(s): ${htmlEntries.length} pages, ${nonHtmlEntries.length} non-HTML (IndexNow only)`,
        site.id
      );

      // url_state is the current sitemap inventory, not an append-only URL
      // history. Remove retired HTML URLs and their failures after a successful
      // fetch so coverage percentages and failure badges use the live sitemap.
      const pruned = pruneHtmlUrlStateForSite(site.id, htmlEntries.map(e => e.url));
      // Check what each URL that left the sitemap now returns, so search
      // engines can be told it is gone or moved (Step 3b).
      const removed = await probeRemovedUrls(pruned.retired.slice(0, MAX_REMOVAL_PROBES));
      const stillLive = removed.filter(r => r.state === 'live');
      if (stillLive.length > 0) {
        log(runId, 'warn',
          `${site.domain} — ${stillLive.length} URL(s) left the sitemap but still return 200 (e.g. ${stillLive[0].url}). If they should be gone, return 404/410 or redirect them; otherwise add them back to the sitemap.`,
          site.id
        );
      }
      if (pruned.states > 0 || pruned.failures > 0) {
        log(runId, 'info',
          `${site.domain} — pruned ${pruned.states} retired URL state(s) and ${pruned.failures} stale failure record(s)`,
          site.id
        );
      }

      // Build map of known lastmods from DB (HTML pages)
      const knownLastmods = new Map<string, string | null>();
      for (const entry of htmlEntries) {
        const state = getUrlState(entry.url, site.id);
        if (state) knownLastmods.set(entry.url, state.last_seen_lastmod);
      }

      const { changed, unchanged, newUrls } = filterChangedEntries(htmlEntries, knownLastmods);
      const noLastmod = htmlEntries.filter(e => !e.lastmod);

      // Change-detect the non-HTML (IndexNow-only) URLs separately.
      const knownExtra = new Map<string, string | null>();
      for (const entry of nonHtmlEntries) {
        const state = getUrlState(entry.url, site.id);
        if (state) knownExtra.set(entry.url, state.last_seen_lastmod);
      }
      const extraDiff = filterChangedEntries(nonHtmlEntries, knownExtra);
      const extraChanged = extraDiff.changed;
      const extraNewUrls = extraDiff.newUrls;
      const extraNoLastmod = nonHtmlEntries.filter(e => !e.lastmod);

      // Increment skipped statistics
      run.total_skipped += unchanged.length;

      log(runId, 'info',
        `${site.domain} — ${newUrls.length} new, ${changed.length} changed, ${unchanged.length} unchanged, ${noLastmod.length} no-lastmod` +
        (nonHtmlEntries.length ? ` | non-HTML: ${extraNewUrls.length} new, ${extraChanged.length} changed` : ''),
        site.id
      );

      if (noLastmod.length > 0 && noLastmod.length === htmlEntries.length) {
        log(runId, 'warn',
          `${site.domain} — sitemap has no <lastmod> tags. Add lastmod to your sitemap for smarter change detection. All URLs will be submitted on rotation.`,
          site.id
        );
      }

      // Run AI crawler checks
      try {
        const robotsStatus = await auditRobotsTxt(site.domain);
        const llmsStatus = await probeLlmsTxt(site.domain);
        const latestSite = getSiteById(site.id);
        if (!latestSite) {
          log(runId, 'warn', `${site.domain} — site record disappeared during run; skipping GEO status update to avoid overwriting changes.`, site.id);
          return;
        }
        upsertSite({
          ...latestSite,
          robots_txt_status: robotsStatus,
          llms_txt_status: llmsStatus
        });
        log(runId, 'info', `${site.domain} — GEO audit: robots.txt: [${robotsStatus}] | llms.txt: [${llmsStatus}]`, site.id);
      } catch (e) {
        log(runId, 'warn', `${site.domain} — GEO audit failed: ${String(e)}`, site.id);
      }

      // One pass over new, changed and never-audited pages plus the stalest
      // slice of the page inventory: JSON-LD audit, content fingerprint,
      // title/description change tracking and the internal link map.
      const allUrlStates = getUrlsBySite(site.id);
      const stateByUrl = new Map(allUrlStates.map(s => [s.url, s]));
      const neverAudited = htmlEntries.filter(e => stateByUrl.has(e.url) && stateByUrl.get(e.url)!.has_schema === null);
      const priority = [...newUrls, ...changed, ...neverAudited];
      const prioritySet = new Set(priority.map(e => e.url));
      const inventoryTimes = inventoryFetchTimes(site.id);
      const staleBefore = new Date(Date.now() - INVENTORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const stale = htmlEntries
        .filter(e => !prioritySet.has(e.url) && (inventoryTimes.get(e.url) ?? '') < staleBefore)
        .sort((a, b) => (inventoryTimes.get(a.url) ?? '').localeCompare(inventoryTimes.get(b.url) ?? ''))
        .slice(0, INVENTORY_REFRESH_PER_RUN);
      const targets = [...new Map([...priority, ...stale].map(e => [e.url, e])).values()];
      const previousHash = new Map(allUrlStates.map(s => [s.url, s.content_hash ?? null]));
      const lastmodChanged = new Set(changed.filter(e => e.lastmod).map(e => e.url));
      let checkedChanged = 0;
      let bumpedWithoutChange = 0;
      let snippetChanges = 0;
      if (targets.length > 0) {
        log(runId, 'info', `${site.domain} — fetching ${targets.length} pages (${prioritySet.size} new/changed, ${stale.length} inventory refresh)`, site.id);
        await mapWithConcurrency(targets, PAGE_FETCH_CONCURRENCY, async (entry) => {
          if (activeRun.stopRequested) return;
          try {
            const res = await safeFetch(entry.url, {
              headers: { 'User-Agent': 'SEOWebsiteIndexer/1.0 (page-audit)' },
              signal: AbortSignal.timeout(10_000)
            }, { label: 'Page audit URL' });
            if (!res.ok) {
              await res.body?.cancel().catch(() => undefined);
              upsertInventoryPage(site.id, { url: entry.url, status: res.status, title: null, meta_description: null, h1: null, robots: null, words: 0, links: [] });
              return;
            }
            const html = await readResponseText(res, 2_000_000, 'Page audit page');
            const audit = parseSemanticSchema(html);
            // Fingerprint the visible text so a lastmod change can be checked
            // against a real content change (see Step 6 and lastmodQuality).
            const hash = contentFingerprint(html);
            const before = previousHash.get(entry.url) ?? null;
            if (before && lastmodChanged.has(entry.url)) {
              checkedChanged++;
              if (before === hash) bumpedWithoutChange++;
            }
            upsertUrlState({
              url: entry.url,
              site_id: site.id,
              has_schema: audit.hasSchema,
              schema_types: audit.schemaTypes,
              content_hash: hash,
              ...(before && before !== hash ? { content_changed_at: new Date().toISOString() } : {}),
            });
            if (audit.hasSchema && prioritySet.has(entry.url)) {
              log(runId, 'dim', `Schema detected: [${audit.schemaTypes}] on ${entry.url}`, site.id, entry.url);
            }

            const page = parsePage({ url: entry.url, finalUrl: res.url || entry.url, status: res.status, html, robots: res.headers.get('x-robots-tag') ?? '', maxLinks: 1000 });
            const title = page.title || null;
            const description = page.description || null;
            const previous = getInventoryPage(site.id, entry.url);
            if (previous && previous.status === 200 && ((previous.title ?? '') !== (title ?? '') || (previous.meta_description ?? '') !== (description ?? ''))) {
              snippetChanges++;
              const changedAt = new Date().toISOString();
              recordSnippetChange({
                site_id: site.id, url: entry.url, changed_at: changedAt,
                old_title: previous.title, new_title: title,
                old_description: previous.meta_description, new_description: description,
              });
              if (site.workspace_id) {
                addAnnotation({
                  workspaceId: site.workspace_id, siteId: site.id, kind: 'snippet_change',
                  title: `Search snippet changed: ${new URL(entry.url).pathname}`,
                  note: previous.title !== title ? `Title: "${previous.title ?? ''}" → "${title ?? ''}"` : 'Meta description changed',
                  eventAt: changedAt, metadata: { url: entry.url },
                });
              }
            }
            upsertInventoryPage(site.id, {
              url: entry.url, status: 200, title, meta_description: description, h1: page.h1[0] ?? null,
              robots: page.robots || null, words: page.words,
              links: page.links.filter(l => pageHost(l.url) === pageHost(page.finalUrl))
                .map(l => ({ url: l.url, anchor: l.anchor.slice(0, 120), rel: l.rel })),
            });
          } catch { /* unreachable page: retried on a later run */ }
        });
        if (snippetChanges > 0) {
          log(runId, 'info', `${site.domain} — ${snippetChanges} title/meta description change(s) recorded; click-through is compared before and after once 14 days of data exist.`, site.id);
        }
      }

      // Google only uses lastmod when it is consistently accurate; flag the
      // patterns that make it ignore the sitemap's dates.
      const lastmodIssues = lastmodQuality(htmlEntries, { bumpedWithoutChange, checkedChanged });
      for (const issue of lastmodIssues) {
        log(runId, 'warn', `${site.domain} — ${issue.title}: ${issue.detail}`, site.id);
      }
      syncSiteFindings(site, 'sitemap_quality', LASTMOD_ISSUE_CODES, lastmodIssues.map(issue => ({
        code: issue.code,
        title: issue.title,
        description: issue.detail,
        severity: 'high',
        evidence: { code: issue.code, sitemap_url: site.sitemap_url },
        deepLink: gscSitemapsLink(site),
      })));

      // Internal links: orphaned and weakly linked pages, prioritising pages
      // already ranking on page one/two, with suggested linking pages.
      try {
        const report = analyseInternalLinks({
          sitemapUrls: htmlEntries.map(e => e.url),
          pages: listInventory(site.id),
          perf: pagePerformance(site.id),
          indexed: new Set(getUrlsBySite(site.id).filter(s => s.gsc_verdict === 'PASS').map(s => s.url)),
        });
        const orphans = report.targets.filter(t => t.kind === 'orphan').length;
        log(runId, 'info',
          `${site.domain} — internal links: ${report.inventoried}/${report.sitemapPages} pages mapped` +
          (report.orphansConfirmed
            ? `; ${report.weakOrOrphanUrls.length} orphaned or weakly linked (${orphans} orphan(s) in the top ${report.targets.length})`
            : ' — orphan detection starts once 90% of pages are mapped'),
          site.id
        );
        syncInternalLinkItems(site, report);
      } catch (e) {
        log(runId, 'warn', `${site.domain} — internal link analysis failed: ${e instanceof Error ? e.message : e}`, site.id);
      }

      siteDataMap.set(site.id, {
        site, changed, newUrls, noLastmod, extraChanged, extraNewUrls, extraNoLastmod,
        // Only sitemaps that list HTML pages are re-submitted to Search Console;
        // llms-sitemap.xml and similar stay IndexNow-only.
        sitemapGroups: sitemapGroups(htmlEntries, site.sitemap_url),
        lastmodByUrl: new Map(htmlEntries.map(e => [e.url, e.lastmod])),
        removed,
      });
    } catch (e) {
      log(runId, 'error', `${site.domain} — failed to fetch sitemap: ${String(e)}`, site.id);
      siteDataMap.set(site.id, {
        site, changed: [], newUrls: [], noLastmod: [], extraChanged: [], extraNewUrls: [], extraNoLastmod: [],
        sitemapGroups: [], lastmodByUrl: new Map(), removed: [], error: String(e),
      });
    }
  }));

  // ── Step 2: GSC Sitemap Re-submission (per-sitemap signature) ─────────────
  //
  // Google retired the anonymous sitemap ping endpoint; the Search Console
  // Sitemaps API (`sitemaps.submit`) is the supported "fetch this again"
  // signal. Each sitemap is fingerprinted by its URL + lastmod set and
  // re-submitted only when that fingerprint differs from the last accepted
  // submission, so a lastmod change in any sitemap (primary or robots.txt
  // declared) prompts Google to re-read exactly that sitemap.

  if (!options.skipSitemaps) {
    log(runId, 'info', '── Step 2: Re-submitting changed sitemaps to Google Search Console ──');
    for (const site of allSites) {
      if (activeRun.stopRequested) break;
      const data = siteDataMap.get(site.id);
      if (!data || data.error) continue;

      const pending = data.sitemapGroups
        .map(group => ({ group, previous: getSitemapState(site.id, group.sitemapUrl) }))
        .filter(({ group, previous }) => previous?.signature !== group.signature);
      if (pending.length === 0) {
        log(runId, 'info', `${site.domain} — sitemap re-submission skipped: no URL or lastmod changes in ${data.sitemapGroups.length} sitemap(s)`, site.id);
        continue;
      }

      const accountId = site.google_account_id || allAccounts[0]?.id;
      if (!accountId) {
        log(runId, 'error', `${site.domain} — GSC submission skipped: No Google Account linked to this site.`, site.id);
        continue;
      }
      if (!site.google_account_id) {
        log(runId, 'warn', `${site.domain} — No Google Account explicitly linked; falling back to first available account. Edit the site to set this.`, site.id);
      }

      for (const { group, previous } of pending) {
        if (activeRun.stopRequested) break;
        const why = previous ? 'URLs or lastmod changed' : 'first submission from this tool';
        try {
          const result = await submitSitemapToGSC(accountId, site.gsc_url, group.sitemapUrl);
          if (result.success) {
            recordSitemapSubmitted(site.id, group.sitemapUrl, group.signature, group.urlCount);
            log(runId, 'ok', `${site.domain} — sitemap re-submitted to GSC (${why}, ${group.urlCount} pages): ${group.sitemapUrl}`, site.id);
          } else {
            // Signature is not recorded, so the next run retries.
            log(runId, 'warn', `${site.domain} — GSC sitemap submission for ${group.sitemapUrl}: HTTP ${result.statusCode} (${result.message ?? 'unknown error'})`, site.id);
          }
        } catch (e) {
          log(runId, 'warn', `${site.domain} — GSC sitemap error for ${group.sitemapUrl}: ${String(e)}`, site.id);
        }
      }
    }
  }

  // ── Step 2b: Read back Search Console's sitemap processing report ─────────
  //
  // A submitted sitemap that Google cannot parse, or has not downloaded,
  // silently loses every page's recrawl signal. Record Google's errors,
  // warnings and last download, and raise an Action Centre item on errors.

  if (!options.skipSitemaps) {
    for (const site of allSites) {
      if (activeRun.stopRequested) break;
      const data = siteDataMap.get(site.id);
      const accountId = site.google_account_id || allAccounts[0]?.id;
      if (!data || data.error || !accountId || data.sitemapGroups.length === 0) continue;
      let reports: Awaited<ReturnType<typeof listGSCSitemaps>>;
      try {
        reports = await listGSCSitemaps(accountId, site.gsc_url);
      } catch (e) {
        log(runId, 'dim', `${site.domain} — could not read Search Console sitemap report: ${e instanceof Error ? e.message : e}`, site.id);
        continue;
      }
      for (const group of data.sitemapGroups) {
        const report = reports.find(r => r.path === group.sitemapUrl);
        if (!report) continue;
        recordSitemapFeedback(site.id, group.sitemapUrl, {
          errors: report.errors, warnings: report.warnings,
          lastDownloaded: report.lastDownloaded ?? null, isPending: !!report.isPending,
        });
        const downloaded = report.lastDownloaded ? `last downloaded ${report.lastDownloaded.slice(0, 10)}` : 'not downloaded yet';
        const level = report.errors > 0 ? 'warn' : 'dim';
        log(runId, level,
          `${site.domain} — Google sitemap report for ${group.sitemapUrl}: ${downloaded}, ${report.errors} error(s), ${report.warnings} warning(s)${report.isPending ? ', processing pending' : ''}`,
          site.id
        );
        const findings: SiteFinding[] = report.errors > 0 ? [{
          code: `sitemap_errors:${group.sitemapUrl}`,
          title: `Google reports ${report.errors} error(s) in a submitted sitemap`,
          description: `Open Search Console → Sitemaps → ${group.sitemapUrl} to see the errors. Common causes: invalid XML, URLs on a different host or protocol than the property, or a sitemap Google cannot fetch. Until fixed, Google may ignore the sitemap's URLs and lastmod values.`,
          severity: 'high',
          evidence: { sitemap_url: group.sitemapUrl, errors: report.errors, warnings: report.warnings, last_downloaded: report.lastDownloaded ?? null },
          deepLink: gscSitemapsLink(site),
        }] : [];
        syncSiteFindings(site, 'gsc_sitemap', [`sitemap_errors:${group.sitemapUrl}`], findings);
      }
    }
  }

  // ── Step 3: IndexNow ──────────────────────────────────────────────────────

  if (!options.skipIndexNow) {
    log(runId, 'info', '── Step 3: IndexNow (Bing / Yandex / Yahoo) ──');

    // URLs in long-term failure backoff for IndexNow are dropped.
    const indexNowBackedOff = getRecentlyBackedOffUrls('indexnow', 3, 30);

    for (const site of allSites) {
      if (activeRun.stopRequested) break;
      const data = siteDataMap.get(site.id);
      if (!data || data.error) continue;

      // Priority order:
      // 1. New URLs (sorted: most recent lastmod first; missing lastmod last)
      // 2. Changed URLs (sorted: most recent lastmod first; missing lastmod last)
      // 3. Rolling batch of no-lastmod URLs (when there are no priority targets)
      const byRecentLastmod = (a: SitemapEntry, b: SitemapEntry) => {
        const ta = a.lastmod ? Date.parse(a.lastmod) : 0;
        const tb = b.lastmod ? Date.parse(b.lastmod) : 0;
        return tb - ta; // newest first; 0 (missing) sorts last
      };

      // Set of all non-HTML (llms.txt etc.) URLs for this site, so we can flag
      // them as indexnow_only when we persist their state after submission.
      const extraUrlSet = new Set<string>([
        ...data.extraNewUrls.map(e => e.url),
        ...data.extraChanged.map(e => e.url),
        ...data.extraNoLastmod.map(e => e.url),
      ]);

      // Priority targets: new + changed HTML pages, then new + changed non-HTML
      // (llms.txt) URLs discovered via robots.txt.
      const prioritised = [
        ...[...data.newUrls].sort(byRecentLastmod),
        ...[...data.changed].sort(byRecentLastmod),
        ...[...data.extraNewUrls].sort(byRecentLastmod),
        ...[...data.extraChanged].sort(byRecentLastmod),
      ].map(e => e.url);

      let indexNowUrls = prioritised;

      const allNoLastmod = [...data.noLastmod, ...data.extraNoLastmod];
      if (allNoLastmod.length > 0 && indexNowUrls.length === 0) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const rollingBatch = allNoLastmod
          .filter(e => {
            const state = getUrlState(e.url, site.id);
            if (!state) return true; // never submitted
            if (!state.last_submitted) return true; // never submitted
            return state.last_submitted < sevenDaysAgo; // not submitted in last 7 days
          })
          .slice(0, INDEXNOW_NO_LASTMOD_BATCH)
          .map(e => e.url);

        if (rollingBatch.length > 0) {
          indexNowUrls = rollingBatch;
          log(runId, 'info', `${site.domain} — sitemap has no <lastmod>; submitting rolling batch of ${rollingBatch.length} older URLs to IndexNow`, site.id);
        }
      }

      // Drop URLs in 30-day backoff
      const beforeBackoff = indexNowUrls.length;
      indexNowUrls = indexNowUrls.filter(u => !indexNowBackedOff.has(`${u}::${site.id}`));
      const droppedByBackoff = beforeBackoff - indexNowUrls.length;
      if (droppedByBackoff > 0) {
        log(runId, 'info', `${site.domain} — dropped ${droppedByBackoff} URL(s) in 30-day IndexNow backoff`, site.id);
      }

      // Honor daily persistent quota
      const usedToday = getQuotaUsage('indexnow', `site:${site.id}`);
      const remainingToday = Math.max(0, INDEXNOW_DAILY_LIMIT_PER_SITE - usedToday);
      if (remainingToday <= 0) {
        log(runId, 'warn', `${site.domain} — IndexNow daily cap reached (${usedToday}/${INDEXNOW_DAILY_LIMIT_PER_SITE}). Skipping.`, site.id);
        continue;
      }
      if (indexNowUrls.length > remainingToday) {
        log(runId, 'warn', `${site.domain} — capping IndexNow submission at ${remainingToday} URLs (daily remaining; had ${indexNowUrls.length}).`, site.id);
        indexNowUrls = indexNowUrls.slice(0, remainingToday);
      }

      if (indexNowUrls.length === 0) {
        log(runId, 'info', `${site.domain} — no changed URLs to submit to IndexNow`, site.id);
        continue;
      }

      const key = getOrCreateIndexNowKey(site.id);
      log(runId, 'info',
        `${site.domain} — submitting ${indexNowUrls.length} URLs to IndexNow (key: ${key.slice(0, 8)}...) [today: ${usedToday}/${INDEXNOW_DAILY_LIMIT_PER_SITE}]`,
        site.id
      );

      const results = await submitToIndexNowInBatches(site.id, site.domain, indexNowUrls);

      // Track which URLs we've claimed as submitted so we can clear/record failures.
      let cursor = 0;
      for (const r of results) {
        if (activeRun.stopRequested) break;
        const batchUrls = indexNowUrls.slice(cursor, cursor + r.urlCount);
        cursor += r.urlCount;

        if (r.success) {
          run.total_submitted += r.urlCount;
          incrementQuota('indexnow', `site:${site.id}`, r.urlCount);
          log(runId, 'ok', `IndexNow ✓ ${site.domain} — ${r.urlCount} URLs accepted${r.statusCode === 202 ? ' (queued, key verification pending)' : ''}`, site.id);
          for (const url of batchUrls) {
            clearUrlFailure(url, site.id, 'indexnow');
            const isExtra = extraUrlSet.has(url);
            upsertUrlState({
              url,
              site_id: site.id,
              last_submitted: new Date().toISOString(),
              last_seen_lastmod: data.changed.find(e => e.url === url)?.lastmod
                ?? data.newUrls.find(e => e.url === url)?.lastmod
                ?? data.extraChanged.find(e => e.url === url)?.lastmod
                ?? data.extraNewUrls.find(e => e.url === url)?.lastmod
                ?? null,
              indexnow_submitted: 1,
              indexnow_only: isExtra ? 1 : 0,
            });
          }
        } else {
          run.total_failed++;
          for (const url of batchUrls) recordUrlFailure(url, site.id, 'indexnow');
          log(runId, 'error', `IndexNow ✗ ${site.domain} — ${r.message}`, site.id);
          if (r.retryAfterMs && r.retryAfterMs > 0) {
            const waitSec = Math.round(r.retryAfterMs / 1000);
            log(runId, 'warn', `IndexNow Retry-After: ${waitSec}s — skipping further batches for this site.`, site.id);
            break;
          }
          if (r.verificationRequired) {
            log(runId, 'warn',
              `⚠️  IndexNow key verification required for ${site.domain}. ` +
              `The file https://${site.domain}/${key}.txt must be publicly accessible. ` +
              `See the Sites page in the dashboard for setup instructions.`,
              site.id
            );
          }
        }
      }
    }
  }

  // ── Step 3b: Removal notices (IndexNow) ──────────────────────────────────
  //
  // A URL that left the sitemap and now returns 404/410 or redirects is sent
  // to IndexNow so Bing, Yandex and the other engines recrawl it and drop it
  // (or transfer it to the redirect target) instead of showing a dead result.

  if (!options.skipIndexNow) {
    for (const site of allSites) {
      if (activeRun.stopRequested) break;
      const data = siteDataMap.get(site.id);
      if (!data || data.error) continue;
      const notify = data.removed.filter(r => r.state === 'gone' || r.state === 'moved').map(r => r.url);
      if (notify.length === 0) continue;
      const usedToday = getQuotaUsage('indexnow', `site:${site.id}`);
      const batch = notify.slice(0, Math.max(0, INDEXNOW_DAILY_LIMIT_PER_SITE - usedToday));
      if (batch.length === 0) continue;
      const results = await submitToIndexNowInBatches(site.id, site.domain, batch);
      const accepted = results.filter(r => r.success).reduce((n, r) => n + r.urlCount, 0);
      if (accepted > 0) {
        incrementQuota('indexnow', `site:${site.id}`, accepted);
        run.total_submitted += accepted;
      }
      const gone = data.removed.filter(r => r.state === 'gone').length;
      log(runId, accepted > 0 ? 'ok' : 'warn',
        `${site.domain} — removal notices: ${accepted}/${batch.length} removed URL(s) sent to IndexNow (${gone} now 404/410, ${batch.length - gone} redirected)`,
        site.id
      );
    }
  }

  // ── Step 4: Bing Webmaster URL Submission (direct; complements IndexNow) ──

  if (!options.skipBing) {
    // Bing keys are per-workspace now (resolved per site), so the step always
    // runs; each site without a resolvable key is skipped individually below.
    {
      log(runId, 'info', '── Step 4: Bing Webmaster URL Submission ──');
      const BING_DAILY_LIMIT_FALLBACK = 100; // used only if the live quota lookup fails

      for (const site of allSites) {
        if (activeRun.stopRequested) break;
        const data = siteDataMap.get(site.id);
        if (!data || data.error) continue;

        const bingCredential = await bingCredentialForSite(site.id);
        if (!bingCredential) {
          log(runId, 'dim', `${site.domain} — Bing submission skipped (no OAuth account or API key for this workspace).`, site.id);
          continue;
        }

        // HTML pages only (new + changed). Non-HTML/llms.txt goes via IndexNow.
        const bingUrls = [...data.newUrls, ...data.changed].map(e => e.url);
        if (bingUrls.length === 0) {
          log(runId, 'info', `${site.domain} — no changed pages to submit to Bing`, site.id);
          continue;
        }

        const siteUrl = deriveBingSiteUrl(site.gsc_url, site.domain);

        // Respect Bing's daily quota: prefer the live quota, else a local counter.
        const usedToday = getQuotaUsage('bing_submission', `site:${site.id}`);
        const quota = await getBingQuota(bingCredential, siteUrl);
        const dailyAllowance = quota?.dailyQuota ?? Math.max(0, BING_DAILY_LIMIT_FALLBACK - usedToday);
        if (dailyAllowance <= 0) {
          log(runId, 'warn', `${site.domain} — Bing daily quota exhausted${quota ? '' : ` (local counter ${usedToday}/${BING_DAILY_LIMIT_FALLBACK})`}. Skipping.`, site.id);
          continue;
        }

        let toSubmit = bingUrls;
        if (toSubmit.length > dailyAllowance) {
          log(runId, 'warn', `${site.domain} — capping Bing submission at ${dailyAllowance} URLs (daily quota; had ${toSubmit.length}).`, site.id);
          toSubmit = toSubmit.slice(0, dailyAllowance);
        }

        log(runId, 'info', `${site.domain} — submitting ${toSubmit.length} URLs to Bing (siteUrl: ${siteUrl}${quota ? `, quota: ${quota.dailyQuota}/day left` : ''})`, site.id);

        const results = await submitToBingInBatches(bingCredential, siteUrl, toSubmit);
        let cursor = 0;
        for (const r of results) {
          if (activeRun.stopRequested) break;
          const batchUrls = toSubmit.slice(cursor, cursor + r.urlCount);
          cursor += r.urlCount;
          if (r.success) {
            run.total_submitted += r.urlCount;
            incrementQuota('bing_submission', `site:${site.id}`, r.urlCount);
            for (const url of batchUrls) clearUrlFailure(url, site.id, 'bing_submission');
            log(runId, 'ok', `Bing ✓ ${site.domain} — ${r.urlCount} URLs accepted`, site.id);
          } else {
            run.total_failed++;
            for (const url of batchUrls) recordUrlFailure(url, site.id, 'bing_submission');
            log(runId, r.quotaExceeded ? 'warn' : 'error', `Bing ✗ ${site.domain} — ${r.message}`, site.id);
            if (r.quotaExceeded) break;
          }
        }
      }
    }
  }

  // ── Step 5: Google URL Inspection (per-property budget) ──────────────────

  if (!options.skipGoogle) {
    // Per-property budget: 2000 inspections/day per Search Console property.
    // Manual runs default to a smaller per-property budget to stay snappy.
    const defaultPerProperty = options.trigger === 'manual' ? 100 : GSC_INSPECTION_DAILY_LIMIT_PER_PROPERTY;
    const perPropertyLimit = options.gscLimit ?? defaultPerProperty;

    log(runId, 'info', `── Step 5: Google URL Inspection (per-property budget: ${perPropertyLimit}, ${allSites.length} site(s)) ──`);

    // Track per-account submission count to politely back off if we see 429.
    const inspectExhaustedAccount = new Set<string>();

    for (const site of allSites) {
      if (activeRun.stopRequested) break;
      const accountId = site.google_account_id || allAccounts[0]?.id;
      if (!accountId) {
        log(runId, 'warn', `URL Inspection skipped: No Google Account linked for site ${site.domain}.`, site.id);
        continue;
      }
      if (!site.google_account_id) {
        log(runId, 'warn', `URL Inspection for ${site.domain} — No Google Account explicitly linked; falling back to first available account.`, site.id);
      }
      if (inspectExhaustedAccount.has(accountId)) {
        log(runId, 'info', `URL Inspection skipped for ${site.domain}: account ${accountId} already exhausted this run.`, site.id);
        continue;
      }

      // Exclude IndexNow-only URLs (llms.txt etc.) — they aren't indexable pages.
      const urlStates = getUrlsBySite(site.id).filter(s => s.indexnow_only !== 1);
      if (urlStates.length === 0) continue;

      // Per-property persistent quota — never exceed it across runs in the same day.
      const propertyBucket = `property:${site.gsc_url}`;
      const usedToday = getQuotaUsage('gsc_inspection', propertyBucket);
      const remaining = Math.max(0, GSC_INSPECTION_DAILY_LIMIT_PER_PROPERTY - usedToday);
      const thisRunLimit = Math.min(perPropertyLimit, remaining);
      if (thisRunLimit <= 0) {
        log(runId, 'warn', `${site.domain} — GSC Inspection daily cap reached (${usedToday}/${GSC_INSPECTION_DAILY_LIMIT_PER_PROPERTY}). Skipping.`, site.id);
        continue;
      }

      // Never-inspected URLs first, then not-indexed / changed-since-crawl pages
      // due a re-check, then the oldest inspections — within the property budget.
      const lastmodByUrl = siteDataMap.get(site.id)?.lastmodByUrl ?? new Map<string, string | undefined>();
      const oldestInspected = prioritiseInspections(urlStates, lastmodByUrl).slice(0, thisRunLimit);

      log(runId, 'info', `${site.domain} — checking real-time index status for ${oldestInspected.length} URLs (today ${usedToday}/${GSC_INSPECTION_DAILY_LIMIT_PER_PROPERTY})`, site.id);

      let propertyConsecutive429 = 0;
      let findingsDeferred = 0;

      for (const state of oldestInspected) {
        if (activeRun.stopRequested) break;
        if (inspectExhaustedAccount.has(accountId)) break;

        try {
          const result = await inspectGoogleUrl(accountId, site.gsc_url, state.url);
          if (result.success) {
            propertyConsecutive429 = 0;
            incrementQuota('gsc_inspection', propertyBucket);
            log(runId, 'ok', `GSC Inspection verdict: [${result.verdict}${result.coverageState ? ` · ${result.coverageState}` : ''}] for ${state.url}`, site.id, state.url);
            upsertUrlState({
              url: state.url,
              site_id: site.id,
              gsc_indexing_state: result.indexingState,
              gsc_verdict: result.verdict,
              gsc_coverage_state: result.coverageState ?? null,
              gsc_page_fetch_state: result.pageFetchState ?? null,
              gsc_last_crawl_time: result.lastCrawlTime ?? null,
              gsc_google_canonical: result.googleCanonical ?? null,
              gsc_user_canonical: result.userCanonical ?? null,
              gsc_robots_state: result.robotsTxtState ?? null,
              gsc_last_inspected: new Date().toISOString()
            });
            const finding = inspectionFinding(state.url, result);
            if (finding) log(runId, 'warn', `${finding.title}: ${state.url}`, site.id, state.url);
            const atCap = !!finding && !!site.workspace_id
              && countOpenWorkItems(site.workspace_id, site.id, 'gsc_inspection') >= MAX_OPEN_INSPECTION_ITEMS_PER_SITE;
            if (atCap) {
              findingsDeferred++;
            } else {
              syncSiteFindings(site, 'gsc_inspection', INSPECTION_FINDING_CODES, finding ? [{
                code: finding.code,
                title: finding.title,
                description: finding.fix,
                severity: finding.severity,
                evidence: {
                  url: state.url, code: finding.code, verdict: result.verdict, coverage_state: result.coverageState ?? null,
                  page_fetch_state: result.pageFetchState ?? null, google_canonical: result.googleCanonical ?? null,
                  user_canonical: result.userCanonical ?? null, last_crawl_time: result.lastCrawlTime ?? null,
                },
                deepLink: gscInspectLink(site, state.url),
              }] : [], state.url);
            }
          } else if (result.statusCode === 429) {
            propertyConsecutive429++;
            const wait = result.retryAfterMs && result.retryAfterMs > 0 && result.retryAfterMs < 30_000
              ? result.retryAfterMs
              : 5000;
            // After two consecutive 429s, give up on this account for the rest of the run.
            if (propertyConsecutive429 >= 2) {
              inspectExhaustedAccount.add(accountId);
              log(runId, 'warn', `GSC Inspection: account ${accountId} appears rate-limited (429) — skipping remaining inspections this run.`, site.id);
              break;
            }
            log(runId, 'warn', `GSC Inspection 429 for ${state.url} — backing off ${Math.round(wait / 1000)}s.`, site.id, state.url);
            await sleep(wait);
          } else {
            log(runId, 'warn', `GSC Inspection failed for ${state.url}: ${result.message}`, site.id, state.url);
            upsertUrlState({
              url: state.url,
              site_id: site.id,
              gsc_last_inspected: new Date().toISOString()
            });
          }
        } catch (e) {
          log(runId, 'warn', `GSC Inspection error for ${state.url}: ${String(e)}`, site.id, state.url);
        }
        await sleep(GSC_INSPECTION_DELAY_MS);
      }
      if (findingsDeferred > 0) {
        log(runId, 'info',
          `${site.domain} — ${findingsDeferred} inspection finding(s) logged but not added to the Action Centre (${MAX_OPEN_INSPECTION_ITEMS_PER_SITE} open already); they are raised as earlier items are fixed.`,
          site.id
        );
      }
    }
  }

  // ── Step 6: Google Indexing API (opt-in, inspection-targeted) ────────────

  if (!options.skipIndexingApi) {
    const optedIn = allSites.filter(s => s.google_indexing_api === 1);
    if (optedIn.length > 0) {
      await runIndexingApiStep(runId, run, optedIn, siteDataMap, allAccounts, activeRun);
    }
  }

  // ── Step 7: GEO file deployment (robots.txt + llms.txt) ───────────────────

  for (const site of allSites) {
    if (activeRun.stopRequested) break;
    // Monitor-only sites keep their hand-maintained files — never overwrite.
    if (!site.geo_manage) continue;
    // Only deploy if a target is configured.
    if (!site.deploy_webhook_url && !site.ftp_host) continue;
    try {
      await deployGeoFiles(site);
    } catch (e) {
      log(runId, 'warn', `${site.domain} — GEO file deploy failed: ${String(e)}`, site.id);
    }
  }

  // Prune old quota usage rows (>90d) once per run.
  try { pruneOldQuotaUsage(90); } catch { /* ignore */ }

  // ── Finalize ──────────────────────────────────────────────────────────────

  const isStopped = activeRun.stopRequested;
  const status = isStopped ? 'failed' : (run.total_failed > 0 && run.total_submitted === 0 ? 'failed' : 'completed');

  if (isStopped) {
    log(runId, 'error', `Run force-stopped by user request — ${run.total_submitted} submitted, ${run.total_failed} failed.`);
  } else {
    log(runId, 'ok', `Run complete — ${run.total_submitted} submitted, ${run.total_skipped} skipped, ${run.total_failed} failed.`);
  }

  // Analytics: snapshot every site's daily stats (also raises regression alerts),
  // then push the run summary to the configured webhook, if any.
  try {
    snapshotAllSites(activeRun.workspaceId);
  } catch (e) {
    log(runId, 'warn', `Stats snapshot failed: ${e instanceof Error ? e.message : e}`);
  }
  // Search-performance rollups (GSC + Bing) — cached for WoW deltas + query
  // trends, and drives per-query drop alerts. Network-bound, so awaited but
  // never allowed to fail the run.
  try {
    const n = await snapshotAllPerformance(activeRun.workspaceId);
    if (n > 0) log(runId, 'dim', `Search-performance rollups refreshed for ${n} site(s)`);
  } catch (e) {
    log(runId, 'warn', `Perf snapshot failed: ${e instanceof Error ? e.message : e}`);
  }
  // Page-level Core Web Vitals for the most-clicked pages (weekly, needs a
  // CrUX key). Raises Action Centre items ordered by the traffic at stake.
  for (const site of allSites) {
    if (activeRun.stopRequested) break;
    try {
      const vitals = await refreshPageVitals(site);
      if (vitals && vitals.checked > 0) {
        log(runId, vitals.failing > 0 ? 'warn' : 'dim',
          `${site.domain} — page Core Web Vitals checked for ${vitals.checked} top page(s); ${vitals.failing} failing`, site.id);
      }
    } catch (e) {
      log(runId, 'warn', `${site.domain} — page Core Web Vitals check failed: ${e instanceof Error ? e.message : e}`, site.id);
    }
  }
  // Ranking playbook: recompute each site's ranked opportunities from the
  // refreshed windows (no network), then a weekly summary notification.
  await runPlaybookStep(runId, allSites, activeRun);

  // Agent-readiness re-score (isitagentready-style): discovery/protocol/identity
  // surfaces per site. Network-bound, best-effort, never fails the run.
  try {
    const n = await snapshotAllAgentReadiness(activeRun.workspaceId);
    if (n > 0) log(runId, 'dim', `Agent-readiness re-scored for ${n} site(s)`);
  } catch (e) {
    log(runId, 'warn', `Agent-readiness snapshot failed: ${e instanceof Error ? e.message : e}`);
  }
  // Notifications are per-workspace: each workspace with configured channels
  // gets a summary of ITS OWN sites from this run (never other tenants' data).
  try {
    const byWs = new Map<string, { sites: number; urls: number; errors: number }>();
    for (const data of siteDataMap.values()) {
      const wsId = data.site.workspace_id;
      if (!wsId) continue; // unassigned sites have no workspace to notify
      const agg = byWs.get(wsId) ?? { sites: 0, urls: 0, errors: 0 };
      agg.sites += 1;
      agg.urls += data.newUrls.length + data.changed.length + data.extraNewUrls.length + data.extraChanged.length;
      if (data.error) agg.errors += 1;
      byWs.set(wsId, agg);
    }
    const title = isStopped ? 'Indexing run stopped' : 'Indexing run complete';
    for (const [wsId, agg] of byWs) {
      if (configuredChannels(wsId).length === 0) continue;
      const event = status === 'failed' ? 'run_failed' : 'run_complete';
      if (!notificationEventEnabled(wsId, event)) continue;
      const body = `${agg.sites} site${agg.sites === 1 ? '' : 's'} processed — ${agg.urls} new/changed URL${agg.urls === 1 ? '' : 's'}${agg.errors ? `, ${agg.errors} with errors` : ''}.`;
      sendWorkspaceNotification(wsId, title, body, event).catch(() => null);
    }
  } catch (e) {
    log(runId, 'warn', `Notification dispatch failed: ${e instanceof Error ? e.message : e}`);
  }

  updateRun(runId, {
    status,
    finished_at: new Date().toISOString(),
    total_submitted: run.total_submitted,
    total_skipped: run.total_skipped,
    total_failed: run.total_failed,
  });
}

// ── Ranking playbook step ───────────────────────────────────────────────────

const PLAYBOOK_NOTIFY_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

async function runPlaybookStep(runId: string, sites: Site[], activeRun: ActiveRun): Promise<void> {
  const digest: string[] = [];
  let totalLow = 0; let totalHigh = 0; let totalCounted = 0;
  for (const site of sites) {
    if (activeRun.stopRequested) break;
    if (!site.google_account_id) continue;
    try {
      const outcome = computePlaybook(site);
      if (!outcome) continue;
      const s = outcome.summary;
      log(runId, s.counted > 0 ? 'info' : 'dim',
        `${site.domain} — ranking playbook: ${s.counted} opportunit${s.counted === 1 ? 'y' : 'ies'} (estimated +${Math.round(s.low)}–${Math.round(s.high)} clicks/month${s.capped ? ', capped' : ''}), ${s.blockers} blocker(s), ${outcome.raised} sent to the Action Centre`,
        site.id);
      if (s.counted > 0) {
        totalCounted += s.counted; totalLow += s.low; totalHigh += s.high;
        const top = listOpportunities(site.id, { status: ['open'] }).find(o => o.counted && !o.hidden);
        if (top) digest.push(`${site.domain}: ${top.headline} (+${Math.round(top.low)}–${Math.round(top.high)}/mo)`);
      }
    } catch (e) {
      log(runId, 'warn', `${site.domain} — ranking playbook failed: ${e instanceof Error ? e.message : e}`, site.id);
    }
  }
  const ws = activeRun.workspaceId;
  if (totalCounted === 0 || configuredChannels(ws).length === 0 || !notificationEventEnabled(ws, 'playbook_ready')) return;
  const last = getDb().prepare('SELECT MAX(notified_at) at FROM playbook_runs WHERE site_id IN (SELECT id FROM sites WHERE workspace_id = ?)').get(ws) as { at: string | null };
  if (last.at && Date.now() - Date.parse(last.at) < PLAYBOOK_NOTIFY_EVERY_MS) return;
  const body = `${totalCounted} ranking opportunit${totalCounted === 1 ? 'y' : 'ies'} worth an estimated +${Math.round(totalLow).toLocaleString()}–${Math.round(totalHigh).toLocaleString()} Google clicks a month. Top: ${digest.slice(0, 3).join(' · ')}`;
  sendWorkspaceNotification(ws, 'Ranking playbook ready', body, 'playbook_ready').catch(() => null);
  getDb().prepare('UPDATE playbook_runs SET notified_at = ? WHERE site_id IN (SELECT id FROM sites WHERE workspace_id = ?)').run(new Date().toISOString(), ws);
}

// ── Google Indexing API step ─────────────────────────────────────────────────

/**
 * Spends the Indexing API's daily publish quota only on pages that URL
 * Inspection shows need a recrawl: not indexed (and not excluded for a
 * structural reason such as noindex or a canonical), or modified after
 * Google's last crawl. Quota is per Google Cloud project, so opted-in sites
 * sharing a project split what is left today evenly.
 */
async function runIndexingApiStep(
  runId: string,
  run: { total_submitted: number; total_failed: number },
  sites: Site[],
  siteDataMap: Map<string, RunSiteData>,
  allAccounts: Array<{ id: string }>,
  activeRun: ActiveRun,
): Promise<void> {
  log(runId, 'info', `── Step 6: Google Indexing API (opt-in, ${sites.length} site(s), ${GOOGLE_INDEXING_DAILY_LIMIT}/day per Cloud project) ──`);
  log(runId, 'dim', 'Google documents the Indexing API for job-posting and livestream pages only; its effect on other pages is not guaranteed. Sitemaps remain the primary signal.');
  if (GOOGLE_INDEXING_DAILY_LIMIT === 0) {
    log(runId, 'info', 'Indexing API skipped: GOOGLE_INDEXING_DAILY_LIMIT is 0.');
    return;
  }

  const plans: Array<{ site: Site; data: RunSiteData; accountId: string; bucket: string }> = [];
  for (const site of sites) {
    const data = siteDataMap.get(site.id);
    if (!data || data.error) {
      log(runId, 'info', `${site.domain} — Indexing API skipped: sitemap unavailable this run.`, site.id);
      continue;
    }
    const accountId = site.google_account_id || allAccounts[0]?.id;
    const account = accountId ? getGoogleAccountById(accountId) : null;
    if (!accountId || !account) {
      log(runId, 'warn', `${site.domain} — Indexing API skipped: no Google Account linked to this site.`, site.id);
      continue;
    }
    if (hasIndexingScope(account) === false) {
      log(runId, 'warn',
        `${site.domain} — Indexing API skipped: ${account.email ?? 'the linked Google account'} has not granted Indexing API access. Reconnect it under Accounts to grant the new permission.`,
        site.id
      );
      continue;
    }
    plans.push({ site, data, accountId, bucket: indexingQuotaBucket(account) });
  }

  const sitesLeft = new Map<string, number>();
  for (const p of plans) sitesLeft.set(p.bucket, (sitesLeft.get(p.bucket) ?? 0) + 1);
  const exhausted = new Set<string>();

  for (const { site, data, accountId, bucket } of plans) {
    if (activeRun.stopRequested) break;
    const sharers = sitesLeft.get(bucket) ?? 1;
    sitesLeft.set(bucket, sharers - 1);
    if (exhausted.has(bucket)) {
      log(runId, 'info', `${site.domain} — Indexing API skipped: quota for this Cloud project is exhausted.`, site.id);
      continue;
    }

    // Pages that left the sitemap and now return 404/410: URL_DELETED first,
    // so Google drops dead results promptly. Shares the same daily quota.
    const deletions = data.removed.filter(r => r.state === 'gone').map(r => r.url);
    let deleted = 0;
    for (const url of deletions) {
      if (activeRun.stopRequested) break;
      if (getQuotaUsage('google_indexing', bucket) >= GOOGLE_INDEXING_DAILY_LIMIT) break;
      const result = await publishUrlDeleted(accountId, url);
      if (result.success) {
        deleted++;
        run.total_submitted++;
        incrementQuota('google_indexing', bucket);
      } else if (result.statusCode === 429) {
        exhausted.add(bucket);
        break;
      } else {
        run.total_failed++;
        log(runId, 'warn', `Indexing API URL_DELETED ✗ ${url}: ${result.message}`, site.id, url);
        if (result.statusCode === 403) break;
      }
      await sleep(GOOGLE_INDEXING_DELAY_MS);
    }
    if (deleted > 0) log(runId, 'ok', `${site.domain} — Indexing API: URL_DELETED sent for ${deleted} removed page(s) now returning 404/410.`, site.id);
    if (exhausted.has(bucket)) continue;

    const candidates = selectIndexingCandidates(getUrlsBySite(site.id), data.lastmodByUrl);
    if (candidates.length === 0) {
      log(runId, 'info', `${site.domain} — Indexing API: no inspected pages are unindexed or changed since Google's last crawl.`, site.id);
      continue;
    }

    const usedToday = getQuotaUsage('google_indexing', bucket);
    const remaining = Math.max(0, GOOGLE_INDEXING_DAILY_LIMIT - usedToday);
    if (remaining <= 0) {
      log(runId, 'warn', `${site.domain} — Indexing API daily quota reached (${usedToday}/${GOOGLE_INDEXING_DAILY_LIMIT}); ${candidates.length} page(s) wait for tomorrow.`, site.id);
      continue;
    }
    const batch = candidates.slice(0, Math.ceil(remaining / Math.max(1, sharers)));
    const notIndexed = candidates.filter(c => c.reason === 'not_indexed').length;
    log(runId, 'info',
      `${site.domain} — Indexing API: ${notIndexed} not indexed, ${candidates.length - notIndexed} changed since last crawl; notifying ${batch.length} (today ${usedToday}/${GOOGLE_INDEXING_DAILY_LIMIT})`,
      site.id
    );

    for (const candidate of batch) {
      if (activeRun.stopRequested) break;
      const result = await publishUrlUpdated(accountId, candidate.url);
      if (result.success) {
        run.total_submitted++;
        incrementQuota('google_indexing', bucket);
        upsertUrlState({
          url: candidate.url,
          site_id: site.id,
          google_submitted: 1,
          google_indexing_notified_at: new Date().toISOString(),
          google_indexing_lastmod: candidate.lastmod,
        });
        const why = candidate.reason === 'not_indexed'
          ? `not indexed${candidate.coverageState ? `: ${candidate.coverageState}` : ''}`
          : 'changed since last crawl';
        log(runId, 'ok', `Indexing API ✓ URL_UPDATED (${why}) ${candidate.url}`, site.id, candidate.url);
      } else if (result.statusCode === 429) {
        exhausted.add(bucket);
        log(runId, 'warn', `Indexing API 429 for ${site.domain} — quota exhausted for this Cloud project; stopping until tomorrow.`, site.id, candidate.url);
        break;
      } else if (result.statusCode === 403) {
        run.total_failed++;
        log(runId, 'warn',
          `Indexing API 403 for ${site.domain}: ${result.message}. The Google account must be a verified owner of ${site.gsc_url} and the Indexing API must be enabled on the OAuth client's Cloud project.`,
          site.id, candidate.url
        );
        break;
      } else {
        run.total_failed++;
        log(runId, 'warn', `Indexing API ✗ ${candidate.url}: ${result.message}`, site.id, candidate.url);
      }
      await sleep(GOOGLE_INDEXING_DELAY_MS);
    }
  }
}

// ── Cron Scheduler ────────────────────────────────────────────────────────────

export function startScheduler(): void {
  const cronExpr = getSetting('cron_schedule') ?? '0 3 * * *'; // default: 3am daily

  if (_scheduledTask) {
    _scheduledTask.stop();
    _scheduledTask = null;
  }

  if (!cron.validate(cronExpr)) {
    console.error(`[scheduler] Invalid cron expression: "${cronExpr}" — using default "0 3 * * *"`);
    return;
  }

  _scheduledTask = cron.schedule(cronExpr, async () => {
    console.log(`[scheduler] Cron triggered (${cronExpr})`);
    // Runs are per-workspace: kick off an independent run for each tenant that
    // has enabled sites. They run concurrently and never block one another.
    for (const workspaceId of getWorkspaceIdsWithSites()) {
      try {
        await runIndexing({ trigger: 'scheduled', workspaceId });
      } catch (e) {
        console.error(`[scheduler] Scheduled run skipped for workspace ${workspaceId}:`, e instanceof Error ? e.message : e);
      }
    }
  });

  // Lightweight orchestration loop for connector refreshes, scheduled AI
  // visibility, digests, reports and content inventory. Each subsystem owns
  // its own next-run timestamp, so the loop is safe and inexpensive.
  if (_platformTask) _platformTask.stop();
  _platformTask = cron.schedule('*/15 * * * *', async () => {
    try { await runPlatformAutomation(); }
    catch (error) { console.error('[platform] Automation cycle failed:', error instanceof Error ? error.message : error); }
  });

  console.log(`[scheduler] Started — schedule: "${cronExpr}"`);
}

export function stopScheduler(): void {
  if (_scheduledTask) {
    _scheduledTask.stop();
    _scheduledTask = null;
    console.log('[scheduler] Stopped.');
  }
  if (_platformTask) {
    _platformTask.stop();
    _platformTask = null;
  }
}

export function restartScheduler(): void {
  stopScheduler();
  startScheduler();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
