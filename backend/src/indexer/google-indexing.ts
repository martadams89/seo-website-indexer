/**
 * google-indexing.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Recrawl signals for Google beyond the plain sitemap:
 *
 *  - Per-sitemap signatures, so a sitemap is re-submitted through the Search
 *    Console Sitemaps API exactly when its URLs or `lastmod` values change.
 *    (Google retired the anonymous sitemap "ping" endpoint; `sitemaps.submit`
 *    is the supported "go look again" signal.)
 *  - URL Inspection prioritisation, so the inspection budget goes to URLs whose
 *    status is unknown or needs re-checking before the long-tail rotation.
 *  - Opt-in Indexing API targeting. The ~200/day publish quota is spent only on
 *    pages URL Inspection reports as not indexed, or whose sitemap `lastmod`
 *    is newer than Google's last crawl. Google documents the Indexing API for
 *    JobPosting and livestream BroadcastEvent pages only, so its effect on
 *    other pages is not guaranteed; that is why it is off unless a site opts in.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'crypto';
import { getAccessTokenForAccount } from '../auth/google-oauth.js';
import type { GoogleAccount, UrlState } from '../db/database.js';
import type { SitemapEntry } from './sitemap.js';

export const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';

const INDEXING_PUBLISH_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Sitemap signatures ───────────────────────────────────────────────────────

export interface SitemapGroup {
  /** Top-level sitemap the URLs were read from (primary or a robots.txt `Sitemap:`). */
  sitemapUrl: string;
  signature: string;
  urlCount: number;
}

/**
 * Groups entries by the top-level sitemap they came from and fingerprints each
 * group's URL + lastmod set. A changed fingerprint means that sitemap has new,
 * removed or re-dated URLs and should be re-submitted to Search Console.
 */
export function sitemapGroups(entries: SitemapEntry[], fallbackSitemapUrl: string): SitemapGroup[] {
  const bySource = new Map<string, string[]>();
  for (const entry of entries) {
    const source = entry.source ?? fallbackSitemapUrl;
    const lines = bySource.get(source) ?? [];
    lines.push(`${entry.url}\t${entry.lastmod ?? ''}`);
    bySource.set(source, lines);
  }
  return [...bySource.entries()].map(([sitemapUrl, lines]) => ({
    sitemapUrl,
    signature: createHash('sha256').update(lines.sort().join('\n')).digest('hex'),
    urlCount: lines.length,
  }));
}

// ── Time helpers ─────────────────────────────────────────────────────────────

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** True when the sitemap lastmod is strictly newer than Google's last crawl. */
export function changedSinceCrawl(lastmod: string | null | undefined, lastCrawlTime: string | null | undefined): boolean {
  const modified = toMs(lastmod);
  const crawled = toMs(lastCrawlTime);
  return modified !== null && crawled !== null && modified > crawled;
}

// ── Inspection outcome classification ───────────────────────────────────────

// Fetch outcomes the Indexing API cannot fix: the page itself must be repaired.
const HARD_FETCH_FAILURES = new Set([
  'SOFT_404', 'BLOCKED_ROBOTS_TXT', 'NOT_FOUND', 'ACCESS_DENIED', 'SERVER_ERROR',
  'REDIRECT_ERROR', 'ACCESS_FORBIDDEN', 'BLOCKED_4XX', 'INTERNAL_CRAWL_ERROR', 'INVALID_URL',
]);

// Coverage states that are a deliberate or structural exclusion (noindex,
// canonicalised, redirected, missing), not a crawl-backlog problem.
const STRUCTURAL_EXCLUSION = /canonical|duplicate|redirect|not found|404|noindex|blocked|robots\.txt|access denied|forbidden|server error|alternate/i;

/** Would a recrawl request plausibly help this not-indexed page? */
export function isRecrawlable(state: Pick<UrlState, 'gsc_indexing_state' | 'gsc_coverage_state' | 'gsc_page_fetch_state'>): boolean {
  if (state.gsc_indexing_state && state.gsc_indexing_state.startsWith('BLOCKED')) return false;
  if (state.gsc_page_fetch_state && HARD_FETCH_FAILURES.has(state.gsc_page_fetch_state)) return false;
  if (state.gsc_coverage_state && STRUCTURAL_EXCLUSION.test(state.gsc_coverage_state)) return false;
  return true;
}

function isNotIndexed(state: UrlState): boolean {
  return !!state.gsc_verdict && state.gsc_verdict !== 'PASS';
}

// ── URL Inspection prioritisation ────────────────────────────────────────────

/**
 * Orders URLs for this run's inspection budget:
 *   0. never inspected (or inspected before crawl detail was recorded);
 *   1. last seen not indexed, or changed after Google's last crawl, and not
 *      re-checked in the past day — these feed the Indexing API decision;
 *   2. everything else, oldest inspection first.
 */
export function prioritiseInspections(
  states: UrlState[],
  lastmodByUrl: Map<string, string | undefined>,
  now: number = Date.now(),
): UrlState[] {
  const tier = (s: UrlState): number => {
    if (!s.gsc_last_inspected || !s.gsc_verdict) return 0;
    const inspected = toMs(s.gsc_last_inspected) ?? 0;
    const needsAttention = (isNotIndexed(s) && isRecrawlable(s))
      || changedSinceCrawl(lastmodByUrl.get(s.url), s.gsc_last_crawl_time);
    return needsAttention && now - inspected >= DAY_MS ? 1 : 2;
  };
  return states
    .map(s => ({ s, tier: tier(s), inspected: toMs(s.gsc_last_inspected) ?? 0 }))
    .sort((a, b) => a.tier - b.tier || a.inspected - b.inspected || a.s.url.localeCompare(b.s.url))
    .map(x => x.s);
}

// ── Indexing API candidate selection ─────────────────────────────────────────

export type IndexingReason = 'not_indexed' | 'changed_since_crawl';

export interface IndexingCandidate {
  url: string;
  reason: IndexingReason;
  lastmod: string | null;
  coverageState: string | null;
}

export interface CandidateOptions {
  now?: number;
  /** Ignore inspection results older than this; re-inspect first. */
  maxInspectionAgeDays?: number;
  /** Do not re-notify an unchanged URL within this window. */
  renotifyAfterDays?: number;
}

/**
 * Picks the URLs worth spending Indexing API quota on, most valuable first:
 * pages Google has never crawled, then pages changed since Google's last crawl
 * (unless their visible text last changed before that crawl), then
 * crawled-but-not-indexed pages that have been updated since that crawl. URLs already notified for the same
 * lastmod within the re-notify window, URLs whose inspection is stale, and
 * pages excluded for structural reasons (noindex, canonical, 404…) are skipped.
 */
export function selectIndexingCandidates(
  states: UrlState[],
  lastmodByUrl: Map<string, string | undefined>,
  opts: CandidateOptions = {},
): IndexingCandidate[] {
  const now = opts.now ?? Date.now();
  const maxAge = (opts.maxInspectionAgeDays ?? 7) * DAY_MS;
  const renotify = (opts.renotifyAfterDays ?? 14) * DAY_MS;

  const ranked: Array<IndexingCandidate & { rank: number; modified: number }> = [];
  for (const state of states) {
    if (state.indexnow_only === 1) continue;
    if (!lastmodByUrl.has(state.url)) continue; // no longer in the live sitemap
    const inspected = toMs(state.gsc_last_inspected);
    if (inspected === null || !state.gsc_verdict || now - inspected > maxAge) continue;

    const lastmod = lastmodByUrl.get(state.url) ?? null;
    const notified = toMs(state.google_indexing_notified_at);
    if (notified !== null && (state.google_indexing_lastmod ?? null) === lastmod && now - notified < renotify) continue;

    let reason: IndexingReason | null = null;
    let rank = 0;
    if (isNotIndexed(state)) {
      if (!isRecrawlable(state)) continue;
      if (state.gsc_last_crawl_time) {
        // Crawled but not indexed is Google's quality decision; asking again
        // only helps once the page has changed since that crawl.
        const improved = changedSinceCrawl(lastmod, state.gsc_last_crawl_time)
          || changedSinceCrawl(state.content_changed_at, state.gsc_last_crawl_time);
        if (!improved) continue;
      }
      reason = 'not_indexed';
      rank = state.gsc_last_crawl_time ? 2 : 0;
    } else if (changedSinceCrawl(lastmod, state.gsc_last_crawl_time)) {
      // lastmod says changed, but the last observed change in visible text
      // predates Google's crawl: a lastmod bump, not new content.
      if (state.content_changed_at && !changedSinceCrawl(state.content_changed_at, state.gsc_last_crawl_time)) continue;
      // Already notified after this change? Wait for Google to act on it.
      if (notified !== null && notified >= (toMs(lastmod) ?? 0) && now - notified < renotify) continue;
      reason = 'changed_since_crawl';
      rank = 1;
    }
    if (!reason) continue;
    ranked.push({ url: state.url, reason, lastmod, coverageState: state.gsc_coverage_state ?? null, rank, modified: toMs(lastmod) ?? 0 });
  }

  return ranked
    .sort((a, b) => a.rank - b.rank || b.modified - a.modified || a.url.localeCompare(b.url))
    .map(({ url, reason, lastmod, coverageState }) => ({ url, reason, lastmod, coverageState }));
}

// ── Quota + scope helpers ────────────────────────────────────────────────────

/**
 * Indexing API quota belongs to the Google Cloud project that owns the OAuth
 * client (encoded as the numeric client-id prefix), so every account connected
 * through the same client shares one daily budget.
 */
export function indexingQuotaBucket(account: Pick<GoogleAccount, 'id' | 'client_id'>): string {
  const project = /^(\d{6,})-/.exec(account.client_id ?? '')?.[1];
  return project ? `project:${project}` : `account:${account.id}`;
}

/** true / false when Google reported granted scopes; null when unknown (older connections). */
export function hasIndexingScope(account: Pick<GoogleAccount, 'granted_scopes'>): boolean | null {
  if (!account.granted_scopes) return null;
  return account.granted_scopes.split(/\s+/).includes(INDEXING_SCOPE);
}

// ── API call ─────────────────────────────────────────────────────────────────

export interface IndexingPublishResult {
  url: string;
  success: boolean;
  statusCode: number;
  message?: string;
  retryAfterMs?: number;
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const asInt = parseInt(headerValue, 10);
  if (Number.isFinite(asInt) && asInt >= 0) return asInt * 1000;
  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

/** Sends a URL_UPDATED notification. The account must be a verified owner of the property. */
export function publishUrlUpdated(accountId: string, url: string): Promise<IndexingPublishResult> {
  return publishUrlNotification(accountId, url, 'URL_UPDATED');
}

/** Sends a URL_DELETED notification for a page that now returns 404/410. */
export function publishUrlDeleted(accountId: string, url: string): Promise<IndexingPublishResult> {
  return publishUrlNotification(accountId, url, 'URL_DELETED');
}

async function publishUrlNotification(accountId: string, url: string, type: 'URL_UPDATED' | 'URL_DELETED'): Promise<IndexingPublishResult> {
  let token: string;
  try {
    token = await getAccessTokenForAccount(accountId);
  } catch (e) {
    return { url, success: false, statusCode: 0, message: `Auth error: ${String(e)}` };
  }

  let res: Response;
  try {
    res = await fetch(INDEXING_PUBLISH_URL, {
      signal: AbortSignal.timeout(30_000),
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, type }),
    });
  } catch (e) {
    return { url, success: false, statusCode: 0, message: `Network error: ${String(e)}` };
  }

  if (res.ok) return { url, success: true, statusCode: res.status };

  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json() as { error?: { message?: string } };
    message = body?.error?.message ?? message;
  } catch { /* ignore */ }
  const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined;
  return { url, success: false, statusCode: res.status, message, retryAfterMs };
}
