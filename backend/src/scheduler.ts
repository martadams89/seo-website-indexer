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
  insertLog,
  insertRun,
  updateRun,
  type Site,
  type LogEntry,
} from './db/database.js';
import { fetchSitemap, filterChangedEntries, type SitemapEntry } from './indexer/sitemap.js';
import { notifyGoogle, submitSitemapToGSC } from './indexer/google.js';
import { submitToIndexNowInBatches, getOrCreateIndexNowKey } from './indexer/indexnow.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const GOOGLE_DAILY_LIMIT = 200; // hard per-project limit

// ── SSE Event Bus ─────────────────────────────────────────────────────────────

type LogListener = (entry: LogEntry) => void;
const _listeners = new Set<LogListener>();

export function subscribeToLogs(fn: LogListener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function emit(entry: LogEntry): void {
  for (const fn of _listeners) {
    try { fn(entry); } catch { /* ignore dead listeners */ }
  }
}

// ── Run State ─────────────────────────────────────────────────────────────────

let _running = false;
let _currentRunId: string | null = null;
let _scheduledTask: cron.ScheduledTask | null = null;

export function isRunning(): boolean { return _running; }
export function getCurrentRunId(): string | null { return _currentRunId; }

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
  emit(entry);
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
}

export async function runIndexing(options: RunOptions = {}): Promise<string> {
  if (_running) throw new Error('An indexing run is already in progress.');

  const runId    = randomUUID();
  const trigger  = options.trigger ?? 'manual';
  const googleLimit = options.googleLimit ?? GOOGLE_DAILY_LIMIT;

  _running = true;
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

  // ── Step 1: Submit Sitemaps to GSC ────────────────────────────────────────

  if (!options.skipSitemaps) {
    log(runId, 'info', '── Step 1: Submitting sitemaps to Google Search Console ──');
    for (const site of allSites) {
      try {
        const result = await submitSitemapToGSC(site.gsc_url, site.sitemap_url);
        if (result.success) {
          log(runId, 'ok', `${site.domain} — sitemap submitted to GSC`, site.id);
        } else {
          log(runId, 'warn', `${site.domain} — GSC sitemap submission: HTTP ${result.statusCode} (${result.message ?? 'may already be registered'})`, site.id);
        }
      } catch (e) {
        log(runId, 'warn', `${site.domain} — GSC sitemap error: ${String(e)}`, site.id);
      }
    }
  }

  // ── Step 2: Fetch & diff sitemaps ─────────────────────────────────────────

  log(runId, 'info', '── Step 2: Fetching live sitemaps and detecting changes ──');

  type SiteData = {
    site: Site;
    changed: SitemapEntry[];
    newUrls: SitemapEntry[];
    noLastmod: SitemapEntry[];
    error?: string;
  };

  const siteDataMap = new Map<string, SiteData>();

  await Promise.all(allSites.map(async (site) => {
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

      siteDataMap.set(site.id, { site, changed, newUrls, noLastmod });
    } catch (e) {
      log(runId, 'error', `${site.domain} — failed to fetch sitemap: ${String(e)}`, site.id);
      siteDataMap.set(site.id, { site, changed: [], newUrls: [], noLastmod: [], error: String(e) });
    }
  }));

  // ── Step 3: Google Indexing API (round-robin) ─────────────────────────────

  if (!options.skipGoogle) {
    log(runId, 'info', `── Step 3: Google Indexing API (round-robin, budget: ${googleLimit}) ──`);

    // Build per-site URL queues: priority = new > changed > no-lastmod (rotation)
    type SiteQueue = { site: Site; queue: SitemapEntry[]; pos: number };
    const queues: SiteQueue[] = [];

    for (const site of allSites) {
      const data = siteDataMap.get(site.id);
      if (!data || data.error) continue;
      const queue = [...data.newUrls, ...data.changed, ...data.noLastmod];
      if (queue.length === 0) {
        log(runId, 'info', `${site.domain} — nothing to submit to Google (no changes detected)`, site.id);
      }
      queues.push({ site, queue, pos: 0 });
    }

    // Round-robin interleave
    let googleSubmitted = 0;
    let quotaHit = false;

    while (!quotaHit && queues.some(q => q.pos < q.queue.length)) {
      for (const sq of queues) {
        if (sq.pos >= sq.queue.length || quotaHit) continue;

        const entry = sq.queue[sq.pos++];
        const result = await notifyGoogle(entry.url);

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
      const data = siteDataMap.get(site.id);
      if (!data || data.error) continue;

      const indexNowUrls = [...data.newUrls, ...data.changed].map(e => e.url);
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
        if (r.success) {
          run.total_submitted += r.urlCount;
          log(runId, 'ok', `IndexNow ✓ ${site.domain} — ${r.urlCount} URLs accepted${r.statusCode === 202 ? ' (queued, key verification pending)' : ''}`, site.id);
          // Mark URLs as indexnow-submitted
          for (const url of indexNowUrls.slice(0, r.urlCount)) {
            upsertUrlState({
              url,
              site_id: site.id,
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

  // ── Finalize ──────────────────────────────────────────────────────────────

  log(runId, 'ok',
    `Run complete — ${run.total_submitted} submitted, ${run.total_skipped} skipped, ${run.total_failed} failed.`
  );
  updateRun(runId, {
    status: run.total_failed > 0 && run.total_submitted === 0 ? 'failed' : 'completed',
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
