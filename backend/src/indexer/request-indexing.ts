/**
 * indexer/request-indexing.ts — what Google lets software do about indexing,
 * and help for the one thing it doesn't: the Search Console "Request indexing"
 * button. There is no API for that button, so the app builds a prioritised
 * queue of pages worth requesting and a prompt for any AI browser agent that
 * works through the queue in the person's own, already signed-in browser, at a
 * human pace and within Google's small daily quota.
 */
import { getDb, getUrlsBySite, type Site, type UrlState } from '../db/database.js';
import { changedSinceCrawl, isRecrawlable } from './google-indexing.js';

export interface IndexingCapability {
  action: string;
  via: string;
  support: 'automatic' | 'available' | 'limited' | 'not_available' | 'not_google';
  notes: string;
}

/** The honest list. Kept here so the dashboard, the MCP server and the docs agree. */
export const GOOGLE_INDEXING_CAPABILITIES: IndexingCapability[] = [
  { action: 'Submit or resubmit a sitemap', via: 'Search Console Sitemaps API', support: 'automatic', notes: 'Done for you whenever a sitemap\'s URLs or lastmod values change. Google treats it as a signal to look again, not a guarantee.' },
  { action: 'Check whether a page is indexed', via: 'URL Inspection API', support: 'automatic', notes: 'Read-only status (verdict, coverage, last crawl, canonical). 2,000 inspections per property per day, 600 per minute.' },
  { action: 'Request indexing of a specific page', via: 'Search Console website only', support: 'not_available', notes: 'The "Request indexing" button has no API. Google doesn\'t publish its quota; it is small (typically around 10 pages per property per day). Use the browser prompt below for pages that matter.' },
  { action: 'Notify Google that a page changed or was removed', via: 'Indexing API', support: 'limited', notes: 'Google supports it only for job-posting and livestream (BroadcastEvent) pages; 200 URLs a day per Cloud project by default. Opt in per site; its effect on other pages is not guaranteed.' },
  { action: 'Validate a fix in the Page indexing report', via: 'Search Console website only', support: 'not_available', notes: 'No API. A browser agent can click "Validate fix" the same way it requests indexing.' },
  { action: 'Temporarily hide a URL from results', via: 'Search Console Removals tool', support: 'not_available', notes: 'Website only, and only for urgent removals — not for indexing.' },
  { action: 'Ping a sitemap URL', via: 'google.com/ping', support: 'not_available', notes: 'Retired by Google in 2023; sitemap resubmission replaces it.' },
  { action: 'IndexNow', via: 'IndexNow protocol', support: 'not_google', notes: 'Instantly notifies Bing, Yandex, Seznam, Naver and others (including for llms.txt). Google does not take part.' },
];

export type RequestReason = 'not_indexed' | 'changed_since_crawl' | 'never_inspected';

export interface RequestCandidate {
  url: string;
  reason: RequestReason;
  coverage: string | null;
  last_crawl: string | null;
  lastmod: string | null;
  last_requested: string | null;
  inspect_url: string;
}

/** Deep link to the URL Inspection tool for one page of a property. */
export function inspectUrl(property: string, url: string): string {
  return `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(property)}&id=${encodeURIComponent(url)}`;
}

const DAY_MS = 86_400_000;
const REQUEST_COOLDOWN_DAYS = 7;

/**
 * Pages most worth a manual request, best first:
 *   1. inspected, not indexed, and a recrawl could help (not noindex/canonical/404…);
 *   2. changed (sitemap lastmod) after Google's last crawl;
 *   3. never inspected yet (usually brand-new pages).
 * Pages requested in the past week are skipped unless they changed since.
 */
export function requestCandidates(site: Pick<Site, 'id' | 'gsc_url'>, states: UrlState[], opts: { limit?: number; now?: number } = {}): RequestCandidate[] {
  const now = opts.now ?? Date.now();
  const tier = (s: UrlState): { tier: number; reason: RequestReason } | null => {
    if (s.indexnow_only) return null;
    const requested = s.manual_index_requested_at ? Date.parse(s.manual_index_requested_at) : NaN;
    const recentlyRequested = Number.isFinite(requested) && now - requested < REQUEST_COOLDOWN_DAYS * DAY_MS
      && !(s.last_seen_lastmod && Date.parse(s.last_seen_lastmod) > requested);
    if (recentlyRequested) return null;
    if (s.gsc_verdict && s.gsc_verdict !== 'PASS' && isRecrawlable(s)) return { tier: 0, reason: 'not_indexed' };
    if (changedSinceCrawl(s.last_seen_lastmod, s.gsc_last_crawl_time)) return { tier: 1, reason: 'changed_since_crawl' };
    if (!s.gsc_verdict) return { tier: 2, reason: 'never_inspected' };
    return null;
  };
  return states
    .map(s => ({ s, t: tier(s) }))
    .filter((x): x is { s: UrlState; t: { tier: number; reason: RequestReason } } => !!x.t)
    .sort((a, b) => a.t.tier - b.t.tier
      || (Date.parse(b.s.last_seen_lastmod ?? '') || 0) - (Date.parse(a.s.last_seen_lastmod ?? '') || 0)
      || a.s.url.localeCompare(b.s.url))
    .slice(0, Math.max(1, Math.min(500, opts.limit ?? 50)))
    .map(({ s, t }) => ({
      url: s.url,
      reason: t.reason,
      coverage: s.gsc_coverage_state ?? null,
      last_crawl: s.gsc_last_crawl_time ?? null,
      lastmod: s.last_seen_lastmod ?? null,
      last_requested: s.manual_index_requested_at ?? null,
      inspect_url: inspectUrl(site.gsc_url, s.url),
    }));
}

export function siteRequestCandidates(site: Site, limit = 50): RequestCandidate[] {
  return requestCandidates(site, getUrlsBySite(site.id), { limit });
}

export type RequestOutcome = 'requested' | 'already_indexed' | 'quota_exceeded' | 'not_allowed' | 'error';

/** Record what the person or browser agent did, so the queue skips recent requests. */
export function recordRequestOutcomes(siteId: string, results: Array<{ url: string; outcome: RequestOutcome; note?: string }>): number {
  const db = getDb();
  const update = db.prepare(`UPDATE url_state SET manual_index_outcome=?,
    manual_index_requested_at=CASE WHEN ? = 'requested' THEN ? ELSE manual_index_requested_at END
    WHERE url=? AND site_id=?`);
  let changed = 0;
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const r of results.slice(0, 200)) {
      const outcome = `${r.outcome}${r.note ? `: ${r.note.slice(0, 200)}` : ''}`;
      changed += update.run(outcome, r.outcome, now, r.url, siteId).changes;
    }
  })();
  return changed;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const SIGN_IN = (property: string) => `Before you start: this uses my own Chrome, where I am already signed in to Google Search Console (https://search.google.com/search-console) with a Google account that has Owner or Full permission on the property ${property}. Never type a password, a 2-step code or approve a sign-in prompt. If you see a Google sign-in page, an account chooser for the wrong account, or a "You don't have access to this property" message, stop and tell me so I can sign in myself.`;

const PER_PAGE = `For each page:
1. Open its URL Inspection link (given below). Wait until the inspection result has loaded.
2. If it says "URL is on Google" and nothing indicates the page changed since the last crawl, don't request it — note "already indexed" and move on.
3. Otherwise click "Request indexing". Google runs a live test that can take a minute or two; wait for it.
4. When the "Indexing requested" dialog appears, note "requested" and close the dialog.
5. If a dialog says the quota was exceeded ("Quota exceeded" / try again tomorrow), stop immediately — note "quota_exceeded" for that page and do not try the rest.
6. If the live test reports a problem (e.g. blocked by robots.txt, noindex, server error), don't request it; note the problem.
Work one page at a time at a normal human pace. Don't open several inspections in parallel and don't retry a page more than once.`;

export function oneOffPrompt(input: { siteName: string; property: string; candidates: RequestCandidate[]; maxPerRun: number }): string {
  const pages = input.candidates.slice(0, input.maxPerRun);
  return `Please request indexing in Google Search Console for up to ${input.maxPerRun} pages of ${input.siteName}.

${SIGN_IN(input.property)}

${PER_PAGE}

Pages, most important first:
${pages.map((p, i) => `${i + 1}. ${p.url}\n   Inspect: ${p.inspect_url}`).join('\n')}

Finish with a table: page, result (requested / already indexed / quota exceeded / problem), and any message Google showed.`;
}

export function routinePrompt(input: { siteName: string; siteId: string; property: string; maxPerRun: number; connectorName: string; endpoint: string; schedule?: string }): string {
  return `You are my Search Console indexing assistant for ${input.siteName}${input.schedule ? `. This task runs ${input.schedule}` : ''}.

Tools: the "${input.connectorName}" MCP server (${input.endpoint}) and control of my browser (a browser extension or AI browser that acts in my own signed-in session). If either is missing, stop and tell me.

${SIGN_IN(input.property)}

Each run:
1. Call get_indexing_request_queue with siteId "${input.siteId}" and limit ${input.maxPerRun}. It returns the pages most worth requesting (not indexed, changed since Google's last crawl, or never inspected), each with its URL Inspection link. Pages requested in the last 7 days are already left out.
2. Request indexing for those pages, best first, up to ${input.maxPerRun} in this run.
${PER_PAGE}
3. Call record_indexing_requests with siteId "${input.siteId}" and one result per page you handled (outcome: requested, already_indexed, quota_exceeded, not_allowed or error, plus a short note). This keeps the queue honest for the next run.
4. Report: how many pages you requested, any problems Google's live test found (these need fixing on the site — requesting again won't help), and whether the daily quota ran out.`;
}
