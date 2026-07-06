/**
 * scheduler.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Round-robin multi-site scheduler with lastmod change detection.
 *
 * Strategy:
 *  1. Fetch all enabled sites' live sitemaps in parallel.
 *  2. Diff against stored lastmod values → identify new/changed URLs per site.
 *  3. Interleave changed URLs across sites: [A₀, B₀, C₀, A₁, B₁, C₁ ...]
 *     so no single site monopolises the Google Indexing API quota.
 *  4. For URLs with no lastmod, fall back to rotating position (same as old script).
 *  5. Google Indexing API: 200 URLs/day/project hard limit — enforced here.
 *  6. IndexNow: no hard quota but we only submit changed URLs.
 *  7. Progress and logs stream via SSE to the frontend.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import cron from 'node-cron';
import { randomUUID } from 'crypto';
import {
  getAllSites,
  getSetting,
  getUrlState,
  upsertUrlState,
  upsertSite,
  getSiteById,
  getUrlsBySite,
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
  type Site,
  type LogEntry,
  type UrlState,
} from './db/database.js';
import { emitLog, subscribeToLogs } from './utils/logger.js';
import { fetchAllSitemaps, filterChangedEntries, isNonHtmlUrl, type SitemapEntry } from './indexer/sitemap.js';
import { notifyGoogle, submitSitemapToGSC, inspectGoogleUrl } from './indexer/google.js';
import { submitToIndexNowInBatches, getOrCreateIndexNowKey } from './indexer/indexnow.js';
import { submitToBingInBatches, getBingQuota, deriveBingSiteUrl } from './indexer/bing.js';
import { bingKeyForSite } from './auth/workspaces.js';
import { auditRobotsTxt, probeLlmsTxt, parseSemanticSchema } from './indexer/geo.js';
import { deployGeoFiles } from './indexer/geo-deploy.js';
import { snapshotAllSites } from './analytics/stats.js';
import { snapshotAllPerformance } from './analytics/perf-store.js';
import { snapshotAllAgentReadiness } from './analytics/agent-readiness-store.js';
import { sendWorkspaceNotification, configuredChannels } from './utils/notify.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// Google Indexing API: 200 URLs/day per Google Cloud project (i.e. per OAuth client_id).
// Multiple OAuth accounts that share the same client_id share the same 200/day budget.
const GOOGLE_DAILY_LIMIT_PER_PROJECT = 200;

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

// Polite pacing
const GOOGLE_INDEXING_DELAY_MS = 200;
const GSC_INSPECTION_DELAY_MS = 350;

export { subscribeToLogs };

// ── Run State ─────────────────────────────────────────────────────────────────

let _running = false;
let _stopRequested = false;
let _currentRunId: string | null = null;
let _scheduledTask: ReturnType<typeof cron.schedule> | null = null;

export function isRunning(): boolean { return _running; }
export function getCurrentRunId(): string | null { return _currentRunId; }

export function forceStopRun(): void {
  if (_running) {
    _stopRequested = true;
  }
}

// ── Log Helper ────────────────────────────────────────────────────────────────

function log(
  runId: string,
  level: LogEntry['level'],
  message: string,
  siteId?: string,
  url?: string
): void {
  const entry: LogEntry = { run_id: runId, level, message, site_id: siteId, url };
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
  trigger?: 'manual' | 'scheduled';
  /** Override per-project Google Indexing daily limit for this run (testing only) */
  googleLimit?: number;
  /** Only run for specific site IDs */
  siteIds?: string[];
  /** Skip Google Indexing API */
  skipGoogle?: boolean;
  /** Skip IndexNow */
  skipIndexNow?: boolean;
  /** Skip Bing Webmaster URL submission */
  skipBing?: boolean;
  /** Skip GSC sitemap submission */
  skipSitemaps?: boolean;
  /** Override per-property URL Inspection daily limit for this run */
  gscLimit?: number;
}

export async function runIndexing(options: RunOptions = {}): Promise<string> {
  if (_running) throw new Error('An indexing run is already in progress.');

  const runId    = randomUUID();
  const trigger  = options.trigger ?? 'manual';
  const googleLimitPerProject = options.googleLimit ?? GOOGLE_DAILY_LIMIT_PER_PROJECT;

  // Acquire persistent lock with TTL so a crashed run doesn't block forever.
  if (!acquireRunLock(runId)) {
    throw new Error('Another run holds the persistent lock. Wait for it to expire (max 60 min) or restart the server.');
  }

  _running = true;
  _stopRequested = false;
  _currentRunId = runId;

  const run = {
    id: runId,
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
  _doRun(runId, run, options, googleLimitPerProject).finally(() => {
    _running = false;
    _currentRunId = null;
    releaseRunLock();
  });

  return runId;
}

async function _doRun(
  runId: string,
  run: { total_submitted: number; total_skipped: number; total_failed: number },
  options: RunOptions,
  googleLimitPerProject: number
): Promise<void> {
  let allSites = getAllSites();
  if (options.siteIds?.length) {
    allSites = allSites.filter(s => options.siteIds!.includes(s.id));
  }

  if (allSites.length === 0) {
    log(runId, 'warn', 'No enabled sites configured. Add sites via the dashboard.');
    updateRun(runId, { status: 'completed', finished_at: new Date().toISOString(), ...run });
    return;
  }

  // Compute total Google budget = 200/day per distinct OAuth project (client_id).
  // Each Google account that has its own OAuth client_id grants a separate 200/day quota.
  const allAccounts = getAllGoogleAccounts();
  const distinctProjects = new Set(allAccounts.map(a => a.client_id)).size;
  const totalGoogleBudget = googleLimitPerProject * Math.max(distinctProjects, 1);

  log(runId, 'info', `Starting indexing run — ${allSites.length} site(s) | Google budget: ${googleLimitPerProject} URLs/account × ${distinctProjects || 1} project(s) = ${totalGoogleBudget} max | trigger: ${options.trigger ?? 'manual'}`);

  // ── Step 1: Fetch & diff sitemaps ─────────────────────────────────────────

  log(runId, 'info', '── Step 1: Fetching live sitemaps and detecting changes ──');

  type SiteData = {
    site: Site;
    changed: SitemapEntry[];
    newUrls: SitemapEntry[];
    noLastmod: SitemapEntry[];
    /** Non-HTML URLs (e.g. llms.txt) from robots.txt secondary sitemaps — IndexNow only. */
    extraChanged: SitemapEntry[];
    extraNewUrls: SitemapEntry[];
    extraNoLastmod: SitemapEntry[];
    error?: string;
  };

  const siteDataMap = new Map<string, SiteData>();

  await Promise.all(allSites.map(async (site) => {
    if (_stopRequested) return;
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

      // Audit JSON-LD schemas for new, modified, or never-audited pages
      const allUrlStates = getUrlsBySite(site.id);
      const neverAudited = htmlEntries.filter(e => {
        const state = allUrlStates.find(s => s.url === e.url);
        return state && state.has_schema === null;
      });
      const targets = [...newUrls, ...changed, ...neverAudited];
      if (targets.length > 0) {
        log(runId, 'info', `${site.domain} — auditing JSON-LD schemas for ${targets.length} pages`, site.id);
        for (const entry of targets) {
          if (_stopRequested) break;
          try {
            const res = await fetch(entry.url, {
              headers: { 'User-Agent': 'SEOWebsiteIndexer/1.0 (schema-crawler)' },
              signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
              const html = await res.text();
              const audit = parseSemanticSchema(html);
              upsertUrlState({
                url: entry.url,
                site_id: site.id,
                has_schema: audit.hasSchema,
                schema_types: audit.schemaTypes
              });
              if (audit.hasSchema) {
                log(runId, 'dim', `Schema detected: [${audit.schemaTypes}] on ${entry.url}`, site.id, entry.url);
              }
            }
          } catch { /* ignore parsing errors */ }
        }
      }

      siteDataMap.set(site.id, { site, changed, newUrls, noLastmod, extraChanged, extraNewUrls, extraNoLastmod });
    } catch (e) {
      log(runId, 'error', `${site.domain} — failed to fetch sitemap: ${String(e)}`, site.id);
      siteDataMap.set(site.id, { site, changed: [], newUrls: [], noLastmod: [], extraChanged: [], extraNewUrls: [], extraNoLastmod: [], error: String(e) });
    }
  }));

  // ── Step 2: GSC Sitemap Re-submission (Delta-Triggered) ───────────────────

  if (!options.skipSitemaps) {
    log(runId, 'info', '── Step 2: Re-submitting sitemaps to Google Search Console (delta-triggered) ──');
    for (const site of allSites) {
      if (_stopRequested) break;
      const data = siteDataMap.get(site.id);
      if (!data || data.error) continue;

      const hasDelta = data.newUrls.length > 0 || data.changed.length > 0;
      if (!hasDelta) {
        log(runId, 'info', `${site.domain} — sitemap re-submission skipped: No new or changed pages detected`, site.id);
        continue;
      }

      try {
        const accountId = site.google_account_id || getAllGoogleAccounts()[0]?.id;
        if (!accountId) {
          log(runId, 'error', `${site.domain} — GSC submission skipped: No Google Account linked to this site.`, site.id);
          continue;
        }
        if (!site.google_account_id) {
          log(runId, 'warn', `${site.domain} — No Google Account explicitly linked; falling back to first available account. Edit the site to set this.`, site.id);
        }
        const result = await submitSitemapToGSC(accountId, site.gsc_url, site.sitemap_url);
        if (result.success) {
          log(runId, 'ok', `${site.domain} — sitemap re-submitted to GSC due to detected content changes`, site.id);
        } else {
          log(runId, 'warn', `${site.domain} — GSC sitemap submission: HTTP ${result.statusCode} (${result.message ?? 'may already be registered'})`, site.id);
        }
      } catch (e) {
        log(runId, 'warn', `${site.domain} — GSC sitemap error: ${String(e)}`, site.id);
      }
    }
  }

  // ── Step 3: Google Indexing API (round-robin, per-project budget) ────────

  if (!options.skipGoogle) {
    log(runId, 'info', `── Step 3: Google Indexing API (round-robin, per-project budget: ${googleLimitPerProject}) ──`);

    // Pre-fetch URLs that are in long-term failure backoff for this API.
    const backedOff = getRecentlyBackedOffUrls('google_indexing', 3, 30);
    if (backedOff.size > 0) {
      log(runId, 'info', `Google: ${backedOff.size} URL(s) are in 30-day failure backoff — skipping.`);
    }

    // Build per-site URL queues: priority = new > changed > no-lastmod (rotation)
    type SiteQueue = { site: Site; queue: SitemapEntry[]; pos: number; fallbackWarned?: boolean };
    const queues: SiteQueue[] = [];

    for (const site of allSites) {
      const data = siteDataMap.get(site.id);
      if (!data || data.error) continue;

      // Sort no-lastmod URLs by oldest last_submitted timestamp from database to ensure a fair rotation
      const noLastmodSorted = [...data.noLastmod].sort((a, b) => {
        const stateA = getUrlState(a.url, site.id);
        const stateB = getUrlState(b.url, site.id);
        const timeA = stateA?.last_submitted ? new Date(stateA.last_submitted).getTime() : 0;
        const timeB = stateB?.last_submitted ? new Date(stateB.last_submitted).getTime() : 0;
        return timeA - timeB; // oldest first (0/never submitted first)
      });

      // Drop URLs that are in the 30-day backoff list (3+ recent failures)
      const filtered = [...data.newUrls, ...data.changed, ...noLastmodSorted]
        .filter(e => !backedOff.has(`${e.url}::${site.id}`));

      if (filtered.length === 0) {
        log(runId, 'info', `${site.domain} — nothing to submit to Google (no changes detected)`, site.id);
      }
      queues.push({ site, queue: filtered, pos: 0 });
    }

    // Per-account submission counters; per-project quota is enforced by counting
    // submissions made by accounts sharing the same client_id.
    const accountSubmitted = new Map<string, number>();          // accountId -> count
    const accountToProject = new Map<string, string>();           // accountId -> client_id
    const projectSubmitted = new Map<string, number>();          // client_id -> count
    const exhaustedAccounts = new Set<string>();                  // accountIds that 4xx'd or hit budget
    const projectBackoffUntil = new Map<string, number>();       // client_id -> ms timestamp

    for (const acc of allAccounts) accountToProject.set(acc.id, acc.client_id);

    function projectIdFor(accountId: string): string {
      return accountToProject.get(accountId) ?? `account:${accountId}`;
    }

    // Seed counters from persistent storage so we never overshoot a daily limit
    // even if the process was restarted today.
    for (const [accountId, projectId] of accountToProject) {
      const used = getQuotaUsage('google_indexing', `project:${projectId}`);
      if (used > 0) {
        projectSubmitted.set(projectId, Math.max(projectSubmitted.get(projectId) ?? 0, used));
      }
      const accUsed = getQuotaUsage('google_indexing', `account:${accountId}`);
      if (accUsed > 0) accountSubmitted.set(accountId, accUsed);
      if ((projectSubmitted.get(projectId) ?? 0) >= googleLimitPerProject) {
        for (const [aid, pid] of accountToProject) if (pid === projectId) exhaustedAccounts.add(aid);
      }
    }

    let googleSubmitted = 0;

    while (queues.some(q => q.pos < q.queue.length)) {
      if (_stopRequested) break;
      let progressedThisRound = false;

      for (const sq of queues) {
        if (_stopRequested) break;
        if (sq.pos >= sq.queue.length) continue;

        const accountId = sq.site.google_account_id || allAccounts[0]?.id;
        if (!accountId) {
          // No account at all → log once per site and drain its queue
          log(runId, 'error', `Google Submission skipped: No Google Account linked for site ${sq.site.domain}.`, sq.site.id, sq.queue[sq.pos]?.url);
          run.total_failed += 1;
          sq.pos = sq.queue.length;
          continue;
        }
        if (!sq.site.google_account_id && !sq.fallbackWarned) {
          log(runId, 'warn', `${sq.site.domain} — No Google Account explicitly linked; falling back to first available account.`, sq.site.id);
          sq.fallbackWarned = true;
        }

        if (exhaustedAccounts.has(accountId)) {
          // Skip — this account is done for the day
          continue;
        }

        const projectId = projectIdFor(accountId);
        const projectBackoff = projectBackoffUntil.get(projectId) ?? 0;
        if (projectBackoff > Date.now()) {
          // Honor a server-suggested cool-down on this project
          continue;
        }
        const usedInProject = projectSubmitted.get(projectId) ?? 0;
        if (usedInProject >= googleLimitPerProject) {
          // Mark all accounts under this project exhausted
          for (const [aid, pid] of accountToProject) if (pid === projectId) exhaustedAccounts.add(aid);
          continue;
        }

        const entry = sq.queue[sq.pos++];
        progressedThisRound = true;

        const result = await notifyGoogle(accountId, entry.url);

        if (result.statusCode === 429) {
          // Respect Retry-After if reasonable (< 1 hour). Beyond that, treat as
          // day-exhausted for the project.
          const wait = result.retryAfterMs ?? 0;
          if (wait > 0 && wait < 60 * 60 * 1000) {
            projectBackoffUntil.set(projectId, Date.now() + wait);
            log(runId, 'warn', `Google 429 on ${projectId} — backing off ${Math.round(wait / 1000)}s (Retry-After).`);
            // Put the entry back so we retry after cooldown
            sq.queue.splice(sq.pos - 1, 0, entry);
            sq.pos--;
          } else {
            for (const [aid, pid] of accountToProject) if (pid === projectId) exhaustedAccounts.add(aid);
            log(runId, 'warn', `Google quota exhausted for OAuth project (account ${accountId}). Submitted ${usedInProject} via this project this run; other accounts continue.`);
          }
          run.total_failed++;
          recordUrlFailure(entry.url, sq.site.id, 'google_indexing');
          continue;
        }

        if (result.statusCode === 401 || result.statusCode === 403) {
          // Auth failed for this account; don't keep hammering.
          exhaustedAccounts.add(accountId);
          log(runId, 'error', `Google auth/permission failure for account ${accountId} on ${entry.url} — ${result.message}. Skipping this account for the rest of the run.`, sq.site.id, entry.url);
          run.total_failed++;
          recordUrlFailure(entry.url, sq.site.id, 'google_indexing');
          continue;
        }

        if (result.success) {
          googleSubmitted++;
          accountSubmitted.set(accountId, (accountSubmitted.get(accountId) ?? 0) + 1);
          projectSubmitted.set(projectId, usedInProject + 1);
          incrementQuota('google_indexing', `project:${projectId}`);
          incrementQuota('google_indexing', `account:${accountId}`);
          run.total_submitted++;
          clearUrlFailure(entry.url, sq.site.id, 'google_indexing');
          log(runId, 'ok', `Google ✓ [project ${usedInProject + 1}/${googleLimitPerProject}] ${entry.url}`, sq.site.id, entry.url);
          upsertUrlState({
            url: entry.url,
            site_id: sq.site.id,
            last_submitted: new Date().toISOString(),
            last_seen_lastmod: entry.lastmod ?? null,
            submission_count: (getUrlState(entry.url, sq.site.id)?.submission_count ?? 0) + 1,
            google_submitted: 1,
          });
        } else {
          run.total_failed++;
          recordUrlFailure(entry.url, sq.site.id, 'google_indexing');
          log(runId, 'error', `Google ✗ ${entry.url} — ${result.message}`, sq.site.id, entry.url);
        }

        await sleep(GOOGLE_INDEXING_DELAY_MS);
      }

      // If we made no progress this whole pass (every account exhausted or no-quota),
      // there's nothing more we can do.
      if (!progressedThisRound) break;
    }

    const projectSummary = [...projectSubmitted.entries()]
      .map(([pid, n]) => `${pid.slice(0, 14)}…=${n}`)
      .join(', ') || '0';
    log(runId, 'ok', `Google Indexing API: ${googleSubmitted} URLs submitted this run (per-project today: ${projectSummary}).`);
  }

  // ── Step 4: IndexNow ──────────────────────────────────────────────────────

  if (!options.skipIndexNow) {
    log(runId, 'info', '── Step 4: IndexNow (Bing / Yandex / Yahoo) ──');

    // URLs in long-term failure backoff for IndexNow are dropped.
    const indexNowBackedOff = getRecentlyBackedOffUrls('indexnow', 3, 30);

    for (const site of allSites) {
      if (_stopRequested) break;
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
        if (_stopRequested) break;
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

  // ── Step 4b: Bing Webmaster URL Submission (direct; complements IndexNow) ──

  if (!options.skipBing) {
    // Bing keys are per-workspace now (resolved per site), so the step always
    // runs; each site without a resolvable key is skipped individually below.
    {
      log(runId, 'info', '── Step 4b: Bing Webmaster URL Submission ──');
      const BING_DAILY_LIMIT_FALLBACK = 100; // used only if the live quota lookup fails

      for (const site of allSites) {
        if (_stopRequested) break;
        const data = siteDataMap.get(site.id);
        if (!data || data.error) continue;

        const bingApiKey = (bingKeyForSite(site.id) ?? '').trim();
        if (!bingApiKey) {
          log(runId, 'dim', `${site.domain} — Bing submission skipped (no API key for this workspace).`, site.id);
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
        const quota = await getBingQuota(bingApiKey, siteUrl);
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

        const results = await submitToBingInBatches(bingApiKey, siteUrl, toSubmit);
        let cursor = 0;
        for (const r of results) {
          if (_stopRequested) break;
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
      if (_stopRequested) break;
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

      // Sort by gsc_last_inspected (null first, then oldest) and take per-property budget
      const oldestInspected = [...urlStates]
        .sort((a: UrlState, b: UrlState) => {
          const timeA = a.gsc_last_inspected ? new Date(a.gsc_last_inspected).getTime() : 0;
          const timeB = b.gsc_last_inspected ? new Date(b.gsc_last_inspected).getTime() : 0;
          return timeA - timeB;
        })
        .slice(0, thisRunLimit);

      log(runId, 'info', `${site.domain} — checking real-time index status for ${oldestInspected.length} URLs (today ${usedToday}/${GSC_INSPECTION_DAILY_LIMIT_PER_PROPERTY})`, site.id);

      let propertyConsecutive429 = 0;

      for (const state of oldestInspected) {
        if (_stopRequested) break;
        if (inspectExhaustedAccount.has(accountId)) break;

        try {
          const result = await inspectGoogleUrl(accountId, site.gsc_url, state.url);
          if (result.success) {
            propertyConsecutive429 = 0;
            incrementQuota('gsc_inspection', propertyBucket);
            log(runId, 'ok', `GSC Inspection verdict: [${result.indexingState}] for ${state.url}`, site.id, state.url);
            upsertUrlState({
              url: state.url,
              site_id: site.id,
              gsc_indexing_state: result.indexingState,
              gsc_last_inspected: new Date().toISOString()
            });
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
    }
  }

  // ── Step 6: GEO file deployment (robots.txt + llms.txt) ───────────────────

  for (const site of allSites) {
    if (_stopRequested) break;
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

  const isStopped = _stopRequested;
  const status = isStopped ? 'failed' : (run.total_failed > 0 && run.total_submitted === 0 ? 'failed' : 'completed');

  if (isStopped) {
    log(runId, 'error', `Run force-stopped by user request — ${run.total_submitted} submitted, ${run.total_failed} failed.`);
  } else {
    log(runId, 'ok', `Run complete — ${run.total_submitted} submitted, ${run.total_skipped} skipped, ${run.total_failed} failed.`);
  }

  // Analytics: snapshot every site's daily stats (also raises regression alerts),
  // then push the run summary to the configured webhook, if any.
  try {
    snapshotAllSites();
  } catch (e) {
    log(runId, 'warn', `Stats snapshot failed: ${e instanceof Error ? e.message : e}`);
  }
  // Search-performance rollups (GSC + Bing) — cached for WoW deltas + query
  // trends, and drives per-query drop alerts. Network-bound, so awaited but
  // never allowed to fail the run.
  try {
    const n = await snapshotAllPerformance();
    if (n > 0) log(runId, 'dim', `Search-performance rollups refreshed for ${n} site(s)`);
  } catch (e) {
    log(runId, 'warn', `Perf snapshot failed: ${e instanceof Error ? e.message : e}`);
  }
  // Agent-readiness re-score (isitagentready-style): discovery/protocol/identity
  // surfaces per site. Network-bound, best-effort, never fails the run.
  try {
    const n = await snapshotAllAgentReadiness();
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
      const body = `${agg.sites} site${agg.sites === 1 ? '' : 's'} processed — ${agg.urls} new/changed URL${agg.urls === 1 ? '' : 's'}${agg.errors ? `, ${agg.errors} with errors` : ''}.`;
      sendWorkspaceNotification(wsId, title, body).catch(() => null);
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
    try {
      await runIndexing({ trigger: 'scheduled' });
    } catch (e) {
      console.error('[scheduler] Run failed:', e);
    }
  });

  console.log(`[scheduler] Started — schedule: "${cronExpr}"`);
}

export function stopScheduler(): void {
  if (_scheduledTask) {
    _scheduledTask.stop();
    _scheduledTask = null;
    console.log('[scheduler] Stopped.');
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
