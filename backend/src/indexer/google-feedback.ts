/**
 * google-feedback.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns what Google reports back into repair work:
 *
 *  - URL Inspection findings: Google picked a different canonical, a sitemap
 *    URL Google cannot fetch or is blocked from indexing, a redirecting
 *    sitemap URL, or "Crawled – currently not indexed" (a quality signal).
 *  - Content fingerprints, so a lastmod change can be checked against a real
 *    content change. Google ignores lastmod on sites where it is not
 *    "consistently and verifiably accurate", so inflated lastmod values cost
 *    every page its recrawl signal.
 *  - Sitemap lastmod quality checks (future dates, one timestamp everywhere,
 *    lastmod bumped without content changes).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'crypto';
import type { SitemapEntry } from './sitemap.js';

// ── URL Inspection findings ──────────────────────────────────────────────────

export type InspectionFindingCode =
  | 'canonical_mismatch'
  | 'fetch_error'
  | 'blocked'
  | 'redirect'
  | 'duplicate_no_canonical'
  | 'crawled_not_indexed';

export const INSPECTION_FINDING_CODES: InspectionFindingCode[] = [
  'canonical_mismatch', 'fetch_error', 'blocked', 'redirect', 'duplicate_no_canonical', 'crawled_not_indexed',
];

export interface InspectionFinding {
  code: InspectionFindingCode;
  severity: 'high' | 'medium';
  title: string;
  fix: string;
}

export interface InspectionSignals {
  verdict?: string | null;
  indexingState?: string | null;
  coverageState?: string | null;
  pageFetchState?: string | null;
  robotsTxtState?: string | null;
  googleCanonical?: string | null;
  userCanonical?: string | null;
}

const FETCH_FAILURES: Record<string, string> = {
  SOFT_404: 'a soft 404',
  NOT_FOUND: 'a 404',
  ACCESS_DENIED: 'a 401 (access denied)',
  ACCESS_FORBIDDEN: 'a 403 (forbidden)',
  BLOCKED_4XX: 'a 4xx error',
  SERVER_ERROR: 'a 5xx server error',
  REDIRECT_ERROR: 'a redirect error',
  INTERNAL_CRAWL_ERROR: 'an internal crawl error',
  INVALID_URL: 'an invalid URL',
};

/** Normalise for canonical comparison: scheme/host case, default port, trailing slash, fragment. */
export function normaliseUrl(value: string): string {
  try {
    const u = new URL(value);
    u.hash = '';
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return value.trim().replace(/\/+$/, '');
  }
}

/**
 * The single most important problem URL Inspection reports for a sitemap URL,
 * or null when nothing needs fixing (indexed, or merely waiting in the queue).
 */
export function inspectionFinding(url: string, s: InspectionSignals): InspectionFinding | null {
  const coverage = s.coverageState ?? '';

  const fetchFailure = s.pageFetchState ? FETCH_FAILURES[s.pageFetchState] : undefined;
  if (fetchFailure) {
    return {
      code: 'fetch_error', severity: 'high',
      title: `Google gets ${fetchFailure} for a sitemap URL`,
      fix: `Google's last fetch of this URL returned ${fetchFailure}. Fix the response so it returns 200 with the page content, or remove the URL from the sitemap. Sitemaps listing broken URLs lose Google's trust.`,
    };
  }

  if ((s.indexingState ?? '').startsWith('BLOCKED') || s.robotsTxtState === 'DISALLOWED') {
    const how = s.robotsTxtState === 'DISALLOWED' ? 'robots.txt'
      : s.indexingState === 'BLOCKED_BY_HTTP_HEADER' ? 'an X-Robots-Tag noindex header' : 'a noindex robots meta tag';
    return {
      code: 'blocked', severity: 'high',
      title: `Sitemap URL is blocked from Google by ${how}`,
      fix: `The sitemap asks Google to index this page but ${how} forbids it. Remove the block if the page should rank, otherwise take it out of the sitemap.`,
    };
  }

  const google = s.googleCanonical ? normaliseUrl(s.googleCanonical) : null;
  const declared = s.userCanonical ? normaliseUrl(s.userCanonical) : null;
  const self = normaliseUrl(url);
  if (google && google !== self && (!declared || declared === self)) {
    return {
      code: 'canonical_mismatch', severity: 'high',
      title: 'Google chose a different canonical than this page',
      fix: `Google treats ${s.googleCanonical} as the canonical version, so ranking signals for this URL are credited there. Make the content clearly distinct, or consolidate: keep one URL, 301 the other, and point canonicals and internal links at the one you keep.`,
    };
  }

  if (/redirect/i.test(coverage)) {
    return {
      code: 'redirect', severity: 'medium',
      title: 'Sitemap lists a redirecting URL',
      fix: 'List the final destination URL in the sitemap and update internal links to it, so Google does not spend crawls on redirects.',
    };
  }

  if (/duplicate without user-selected canonical/i.test(coverage)) {
    return {
      code: 'duplicate_no_canonical', severity: 'medium',
      title: 'Google sees this page as a duplicate with no canonical',
      fix: 'Add a self-referencing rel="canonical" on the preferred URL (and point duplicates at it), or make the content substantially unique.',
    };
  }

  if (/crawled\s*-\s*currently not indexed/i.test(coverage)) {
    return {
      code: 'crawled_not_indexed', severity: 'medium',
      title: 'Google crawled this page but chose not to index it',
      fix: 'This is usually a quality or duplication signal, not a crawl problem, so resubmitting will not fix it. Expand thin content, add original detail, merge near-duplicates, and link to the page from relevant, already-indexed pages.',
    };
  }

  return null;
}

// ── Content fingerprints ─────────────────────────────────────────────────────

/**
 * Hash of the page's visible text. Scripts, styles, comments, markup and
 * whitespace are removed so nonces, build ids and asset hashes do not count as
 * a content change.
 */
export function contentFingerprint(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return createHash('sha256').update(text).digest('hex');
}

// ── Sitemap lastmod quality ──────────────────────────────────────────────────

export interface LastmodIssue {
  code: 'future_lastmod' | 'uniform_lastmod' | 'lastmod_without_change';
  title: string;
  detail: string;
}

/**
 * Checks whether a sitemap's lastmod values look trustworthy to Google.
 * `bumpedWithoutChange` / `checkedChanged` come from comparing content
 * fingerprints of pages whose lastmod changed this run.
 */
export function lastmodQuality(
  entries: SitemapEntry[],
  opts: { now?: number; bumpedWithoutChange?: number; checkedChanged?: number } = {},
): LastmodIssue[] {
  const now = opts.now ?? Date.now();
  const issues: LastmodIssue[] = [];
  const dated = entries.filter(e => e.lastmod && Number.isFinite(Date.parse(e.lastmod)));

  const future = dated.filter(e => Date.parse(e.lastmod!) > now + 24 * 60 * 60 * 1000);
  if (future.length > 0) {
    issues.push({
      code: 'future_lastmod',
      title: 'Sitemap has lastmod dates in the future',
      detail: `${future.length} URL(s), e.g. ${future[0].url} (${future[0].lastmod}). Future dates are invalid and make Google distrust the sitemap's lastmod values.`,
    });
  }

  if (dated.length >= 20) {
    const counts = new Map<string, number>();
    for (const e of dated) counts.set(e.lastmod!, (counts.get(e.lastmod!) ?? 0) + 1);
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n / dated.length >= 0.9) {
      issues.push({
        code: 'uniform_lastmod',
        title: 'Almost every sitemap URL has the same lastmod',
        detail: `${n} of ${dated.length} URLs share lastmod ${top}. This usually means the build time is written instead of each page's real modification time, so Google cannot tell which pages changed.`,
      });
    }
  }

  const checked = opts.checkedChanged ?? 0;
  const bumped = opts.bumpedWithoutChange ?? 0;
  if (checked >= 5 && bumped / checked >= 0.5) {
    issues.push({
      code: 'lastmod_without_change',
      title: 'Sitemap lastmod changes without page content changing',
      detail: `${bumped} of ${checked} pages with a new lastmod this run have identical visible text to the previous check. Only update lastmod when the main content changes; Google ignores lastmod on sites where it is not accurate.`,
    });
  }

  return issues;
}
