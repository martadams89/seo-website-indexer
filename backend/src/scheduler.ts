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
  type Site,
  type LogEntry,
  type UrlState,
} from './db/database.js';
import { emitLog, subscribeToLogs } from './utils/logger.js';
import { fetchSitemap, filterChangedEntries, type SitemapEntry } from './indexer/sitemap.js';
import { notifyGoogle, submitSitemapToGSC, inspectGoogleUrl } from './indexer/google.js';
import { submitToIndexNowInBatches, getOrCreateIndexNowKey } from './indexer/indexnow.js';
import { auditRobotsTxt, probeLlmsTxt, parseSemanticSchema } from './indexer/geo.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const GOOGLE_DAILY_LIMIT = 200; // hard per-project limit
const parsedGscInspectionLimit = parseInt(process.env.GSC_INSPECTION_DAILY_LIMIT ?? '', 10);
const GSC_INSPECTION_DAILY_LIMIT = Number.isFinite(parsedGscInspectionLimit)
  ? Math.max(1, parsedGscInspectionLimit)
  : 2000;

export { subscribeToLogs };

// ── Run State ─────────────────────────────────────────────────────────────────

let _running = false;
let _stopRequested = false;
let _currentRunId: string | null = null;
let _scheduledTask: cron.ScheduledTask | null = null;

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
  /** Override Google daily limit for this run (useful for testing) */
  googleLimit?: number;
  /** Only run for specific site IDs */
  siteIds?: string[];
  /** Skip Google Indexing API */
  skipGoogle?: boolean;
  /** Skip IndexNow */
  skipIndexNow?: boolean;
  /** Skip GSC sitemap submission */
  skipSitemaps?: boolean;
  /** Override Google Search Console URL inspection limit for this run */
  gscLimit?: number;
}

export async function runIndexing(options: RunOptions = {}): Promise<string> {
  if (_running) throw new Error('An indexing run is already in progress.');

  const runId    = randomUUID();
  const trigger  = options.trigger ?? 'manual';
  const googleLimit = options.googleLimit ?? GOOGLE_DAILY_LIMIT;

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
  _doRun(runId, run, options, googleLimit).finally(() => {
    _running = false;
    _currentRunId = null;
  });

  return runId;
}

async function _doRun(
  runId: string,
  run: { total_submitted: number; total_skipped: number; total_failed: number },
  options: RunOptions,
  googleLimit: number
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

  log(runId, 'info', `Starting indexing run — ${allSites.length} site(s) | Google limit: ${googleLimit} URLs | trigger: ${options.trigger ?? 'manual'}`);

  // ── Step 1: Fetch & diff sitemaps ─────────────────────────────────────────

  log(runId, 'info', '── Step 1: Fetching live sitemaps and detecting changes ──');

  type SiteData = {
    site: Site;
    changed: SitemapEntry[];
    newUrls: SitemapEntry[];
    noLastmod: SitemapEntry[];
    error?: string;
  };

  const siteDataMap = new Map<string, SiteData>();

  await Promise.all(allSites.map(async (site) => {
    if (_stopRequested) return;
    try {
      const entries = await fetchSitemap(site.sitemap_url);
      log(runId, 'info', `${site.domain} — fetched ${entries.length} URLs from sitemap`, site.id);

      // Build map of known lastmods from DB
      const knownLastmods = new Map<string, string | null>();
      for (const entry of entries) {
        const state = getUrlState(entry.url, site.id);
        if (state) knownLastmods.set(entry.url, state.last_seen_lastmod);
      }

      const { changed, unchanged, newUrls } = filterChangedEntries(entries, knownLastmods);
      const noLastmod = entries.filter(e => !e.lastmod);

      // Increment skipped statistics
      run.total_skipped += unchanged.length;

      log(runId, 'info',
        `${site.domain} — ${newUrls.length} new, ${changed.length} changed, ${unchanged.length} unchanged, ${noLastmod.length} no-lastmod`,
        site.id
      );

      if (noLastmod.length > 0 && noLastmod.length === entries.length) {
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
          continue;
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
      const neverAudited = entries.filter(e => {
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

      siteDataMap.set(site.id, { site, changed, newUrls, noLastmod });
    } catch (e) {
      log(runId, 'error', `${site.domain} — failed to fetch sitemap: ${String(e)}`, site.id);
      siteDataMap.set(site.id, { site, changed: [], newUrls: [], noLastmod: [], error: String(e) });
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

  // ── Step 3: Google Indexing API (round-robin) ─────────────────────────────

  if (!options.skipGoogle) {
    log(runId, 'info', `── Step 3: Google Indexing API (round-robin, budget: ${googleLimit}) ──`);

    // Build per-site URL queues: priority = new > changed > no-lastmod (rotation)
    type SiteQueue = { site: Site; queue: SitemapEntry[]; pos: number };
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

      const queue = [...data.newUrls, ...data.changed, ...noLastmodSorted];
      if (queue.length === 0) {
        log(runId, 'info', `${site.domain} — nothing to submit to Google (no changes detected)`, site.id);
      }
      queues.push({ site, queue, pos: 0 });
    }

    // Round-robin interleave
    let googleSubmitted = 0;
    let quotaHit = false;

    while (!quotaHit && queues.some(q => q.pos < q.queue.length)) {
      if (_stopRequested) break;
      for (const sq of queues) {
        if (_stopRequested) break;
        if (sq.pos >= sq.queue.length || quotaHit) continue;

        const entry = sq.queue[sq.pos++];
        const accountId = sq.site.google_account_id || getAllGoogleAccounts()[0]?.id;
        if (!accountId) {
          log(runId, 'error', `Google Submission skipped: No Google Account linked for site ${sq.site.domain}.`, sq.site.id, entry.url);
          run.total_failed++;
          continue;
        }
        const result = await notifyGoogle(accountId, entry.url);

        if (result.statusCode === 429) {
          log(runId, 'warn', `Google daily quota exhausted after ${googleSubmitted} URLs this run. Remaining URLs will be picked up on the next run.`);
          quotaHit = true;
          run.total_failed++;
          break;
        }

        if (result.success) {
          googleSubmitted++;
          run.total_submitted++;
          log(runId, 'ok', `Google ✓ [${googleSubmitted}/${googleLimit}] ${entry.url}`, sq.site.id, entry.url);
          // Update DB state
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
          log(runId, 'error', `Google ✗ ${entry.url} — ${result.message}`, sq.site.id, entry.url);
        }

        if (googleSubmitted >= googleLimit) {
          log(runId, 'info', `Google budget of ${googleLimit} URLs reached for this run.`);
          quotaHit = true;
          break;
        }

        await sleep(250); // Be polite to the API
      }
    }

    log(runId, 'ok', `Google Indexing API: ${googleSubmitted} URLs submitted this run.`);
  }

  // ── Step 4: IndexNow ──────────────────────────────────────────────────────

  if (!options.skipIndexNow) {
    log(runId, 'info', '── Step 4: IndexNow (Bing / Yandex / Yahoo) ──');

    for (const site of allSites) {
      if (_stopRequested) break;
      const data = siteDataMap.get(site.id);
      if (!data || data.error) continue;

      // Build IndexNow queue: prioritise new and changed. If sitemap has no lastmod tags at all,
      // submit a rolling batch of up to 100 URLs that haven't been submitted in the last 7 days.
      let indexNowUrls = [...data.newUrls, ...data.changed].map(e => e.url);
      
      if (data.noLastmod.length > 0 && indexNowUrls.length === 0) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const rollingBatch = data.noLastmod
          .filter(e => {
            const state = getUrlState(e.url, site.id);
            if (!state) return true; // never submitted
            if (!state.last_submitted) return true; // never submitted
            return state.last_submitted < sevenDaysAgo; // not submitted in last 7 days
          })
          .slice(0, 100)
          .map(e => e.url);
          
        if (rollingBatch.length > 0) {
          indexNowUrls = rollingBatch;
          log(runId, 'info', `${site.domain} — sitemap has no <lastmod>; submitting rolling batch of ${rollingBatch.length} older URLs to IndexNow`, site.id);
        }
      }

      if (indexNowUrls.length === 0) {
        log(runId, 'info', `${site.domain} — no changed URLs to submit to IndexNow`, site.id);
        continue;
      }

      const key = getOrCreateIndexNowKey(site.id);
      log(runId, 'info',
        `${site.domain} — submitting ${indexNowUrls.length} URLs to IndexNow (key: ${key.slice(0, 8)}...)`,
        site.id
      );

      const results = await submitToIndexNowInBatches(site.id, site.domain, indexNowUrls);

      for (const r of results) {
        if (_stopRequested) break;
        if (r.success) {
          run.total_submitted += r.urlCount;
          log(runId, 'ok', `IndexNow ✓ ${site.domain} — ${r.urlCount} URLs accepted${r.statusCode === 202 ? ' (queued, key verification pending)' : ''}`, site.id);
          // Mark URLs as indexnow-submitted and update last_submitted date
          for (const url of indexNowUrls.slice(0, r.urlCount)) {
            upsertUrlState({
              url,
              site_id: site.id,
              last_submitted: new Date().toISOString(),
              last_seen_lastmod: data.changed.find(e => e.url === url)?.lastmod
                ?? data.newUrls.find(e => e.url === url)?.lastmod
                ?? null,
              indexnow_submitted: 1,
            });
          }
        } else {
          run.total_failed++;
          log(runId, 'error', `IndexNow ✗ ${site.domain} — ${r.message}`, site.id);
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

  // ── Step 5: Google URL Inspection & Real-Time Status Verification ────────

  if (!options.skipGoogle) {
    const defaultInspectionBudget = options.trigger === 'manual' ? 100 : GSC_INSPECTION_DAILY_LIMIT;
    let inspectionBudgetRemaining = options.gscLimit ?? defaultInspectionBudget;
    log(runId, 'info', `── Step 5: Google URL Inspection (separate budget: ${inspectionBudgetRemaining}) ──`);

    for (const site of allSites) {
      if (_stopRequested) break;
      if (inspectionBudgetRemaining <= 0) {
        log(runId, 'info', 'Google URL Inspection budget reached for this run.');
        break;
      }
      const accountId = site.google_account_id || getAllGoogleAccounts()[0]?.id;
      if (!accountId) {
        log(runId, 'warn', `URL Inspection skipped: No Google Account linked for site ${site.domain}.`, site.id);
        continue;
      }

      const urlStates = getUrlsBySite(site.id);
      if (urlStates.length === 0) continue;

      // URL Inspection API quota is separate from Indexing API publish quota.
      // Keep a single run-level budget so scheduled runs can use the available quota.
      const inspectLimit = Math.min(inspectionBudgetRemaining, urlStates.length);

      // Sort by gsc_last_inspected (null first, then oldest)
      const oldestInspected = urlStates
        .sort((a: UrlState, b: UrlState) => {
          const timeA = a.gsc_last_inspected ? new Date(a.gsc_last_inspected).getTime() : 0;
          const timeB = b.gsc_last_inspected ? new Date(b.gsc_last_inspected).getTime() : 0;
          return timeA - timeB;
        })
        .slice(0, inspectLimit);

      log(runId, 'info', `${site.domain} — checking real-time index status for ${oldestInspected.length} URLs (remaining inspection budget: ${inspectionBudgetRemaining})`, site.id);

      for (const state of oldestInspected) {
        if (_stopRequested) break;
        try {
          const result = await inspectGoogleUrl(accountId, site.gsc_url, state.url);
          if (result.success) {
            log(runId, 'ok', `GSC Inspection verdict: [${result.indexingState}] for ${state.url}`, site.id, state.url);
            upsertUrlState({
              url: state.url,
              site_id: site.id,
              gsc_indexing_state: result.indexingState,
              gsc_last_inspected: new Date().toISOString()
            });
          } else {
            log(runId, 'warn', `GSC Inspection failed for ${state.url}: ${result.message}`, site.id, state.url);
            // Update timestamp so we cycle to other pages
            upsertUrlState({
              url: state.url,
              site_id: site.id,
              gsc_last_inspected: new Date().toISOString()
            });
          }
        } catch (e) {
          log(runId, 'warn', `GSC Inspection error for ${state.url}: ${String(e)}`, site.id, state.url);
        }
        inspectionBudgetRemaining--;
        if (inspectionBudgetRemaining <= 0) break;
        await sleep(500); // Be polite
      }
    }
  }

  // ── Finalize ──────────────────────────────────────────────────────────────

  const isStopped = _stopRequested;
  const status = isStopped ? 'failed' : (run.total_failed > 0 && run.total_submitted === 0 ? 'failed' : 'completed');

  if (isStopped) {
    log(runId, 'error', `Run force-stopped by user request — ${run.total_submitted} submitted, ${run.total_failed} failed.`);
  } else {
    log(runId, 'ok', `Run complete — ${run.total_submitted} submitted, ${run.total_skipped} skipped, ${run.total_failed} failed.`);
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
