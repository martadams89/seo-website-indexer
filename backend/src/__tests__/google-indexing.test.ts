import { describe, it, expect } from 'vitest';
import {
  sitemapGroups,
  changedSinceCrawl,
  isRecrawlable,
  prioritiseInspections,
  selectIndexingCandidates,
  indexingQuotaBucket,
  hasIndexingScope,
  INDEXING_SCOPE,
} from '../indexer/google-indexing.js';
import type { UrlState } from '../db/database.js';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function state(url: string, extra: Partial<UrlState> = {}): UrlState {
  return {
    url, site_id: 's1', last_submitted: null, last_seen_lastmod: null,
    submission_count: 0, google_submitted: 0, indexnow_submitted: 0, indexnow_only: 0,
    ...extra,
  };
}

describe('sitemapGroups', () => {
  const primary = 'https://a.com/sitemap.xml';
  const blog = 'https://a.com/blog-sitemap.xml';

  it('fingerprints each source sitemap separately', () => {
    const groups = sitemapGroups([
      { url: 'https://a.com/1', lastmod: '2026-01-01', source: primary },
      { url: 'https://a.com/blog/1', lastmod: '2026-01-01', source: blog },
      { url: 'https://a.com/2' },
    ], primary);
    expect(groups.map(g => [g.sitemapUrl, g.urlCount])).toEqual([[primary, 2], [blog, 1]]);
  });

  it('changes the signature only when a URL or lastmod changes', () => {
    const base = [
      { url: 'https://a.com/1', lastmod: '2026-01-01', source: primary },
      { url: 'https://a.com/2', lastmod: '2026-01-02', source: primary },
    ];
    const [a] = sitemapGroups(base, primary);
    const [reordered] = sitemapGroups([...base].reverse(), primary);
    const [redated] = sitemapGroups([base[0], { ...base[1], lastmod: '2026-02-01' }], primary);
    const [removed] = sitemapGroups([base[0]], primary);
    expect(reordered.signature).toBe(a.signature);
    expect(redated.signature).not.toBe(a.signature);
    expect(removed.signature).not.toBe(a.signature);
  });
});

describe('changedSinceCrawl', () => {
  it('compares lastmod with the last crawl', () => {
    expect(changedSinceCrawl('2026-09-20T00:00:00Z', '2026-09-10T00:00:00Z')).toBe(true);
    expect(changedSinceCrawl('2026-09-01', '2026-09-10T00:00:00Z')).toBe(false);
    expect(changedSinceCrawl(undefined, '2026-09-10T00:00:00Z')).toBe(false);
    expect(changedSinceCrawl('2026-09-20', null)).toBe(false);
    expect(changedSinceCrawl('not a date', '2026-09-10T00:00:00Z')).toBe(false);
  });
});

describe('isRecrawlable', () => {
  it('rejects structural exclusions and hard fetch failures', () => {
    expect(isRecrawlable({ gsc_coverage_state: 'Discovered - currently not indexed' })).toBe(true);
    expect(isRecrawlable({ gsc_coverage_state: 'Crawled - currently not indexed' })).toBe(true);
    expect(isRecrawlable({ gsc_coverage_state: 'URL is unknown to Google' })).toBe(true);
    expect(isRecrawlable({ gsc_coverage_state: "Excluded by 'noindex' tag" })).toBe(false);
    expect(isRecrawlable({ gsc_coverage_state: 'Alternate page with proper canonical tag' })).toBe(false);
    expect(isRecrawlable({ gsc_coverage_state: 'Page with redirect' })).toBe(false);
    expect(isRecrawlable({ gsc_indexing_state: 'BLOCKED_BY_META_TAG' })).toBe(false);
    expect(isRecrawlable({ gsc_page_fetch_state: 'SOFT_404' })).toBe(false);
  });
});

describe('prioritiseInspections', () => {
  it('orders never-inspected, then needs-attention, then oldest', () => {
    const lastmods = new Map<string, string | undefined>([
      ['https://a.com/changed', ago(1)],
    ]);
    const ordered = prioritiseInspections([
      state('https://a.com/old-ok', { gsc_last_inspected: ago(20), gsc_verdict: 'PASS', gsc_last_crawl_time: ago(30) }),
      state('https://a.com/recent-ok', { gsc_last_inspected: ago(2), gsc_verdict: 'PASS' }),
      state('https://a.com/not-indexed', { gsc_last_inspected: ago(3), gsc_verdict: 'NEUTRAL', gsc_coverage_state: 'Discovered - currently not indexed' }),
      state('https://a.com/changed', { gsc_last_inspected: ago(2), gsc_verdict: 'PASS', gsc_last_crawl_time: ago(5) }),
      state('https://a.com/legacy', { gsc_last_inspected: ago(1), gsc_indexing_state: 'INDEXING_ALLOWED' }),
      state('https://a.com/new'),
      state('https://a.com/checked-today', { gsc_last_inspected: ago(0.1), gsc_verdict: 'NEUTRAL' }),
    ], lastmods, NOW);
    expect(ordered.map(s => s.url.slice('https://a.com/'.length))).toEqual([
      'new', 'legacy', 'not-indexed', 'changed', 'old-ok', 'recent-ok', 'checked-today',
    ]);
  });
});

describe('selectIndexingCandidates', () => {
  const lastmods = new Map<string, string | undefined>([
    ['https://a.com/unknown', '2026-09-20T00:00:00Z'],
    ['https://a.com/crawled-not-indexed', '2026-09-01T00:00:00Z'],
    ['https://a.com/changed', '2026-09-24T00:00:00Z'],
    ['https://a.com/fresh', '2026-09-01T00:00:00Z'],
    ['https://a.com/noindex', '2026-09-01T00:00:00Z'],
    ['https://a.com/stale-inspection', '2026-09-01T00:00:00Z'],
    ['https://a.com/uninspected', '2026-09-01T00:00:00Z'],
  ]);
  const states = [
    state('https://a.com/crawled-not-indexed', { gsc_last_inspected: ago(1), gsc_verdict: 'NEUTRAL', gsc_coverage_state: 'Crawled - currently not indexed', gsc_last_crawl_time: ago(10) }),
    state('https://a.com/unknown', { gsc_last_inspected: ago(1), gsc_verdict: 'NEUTRAL', gsc_coverage_state: 'URL is unknown to Google' }),
    state('https://a.com/changed', { gsc_last_inspected: ago(1), gsc_verdict: 'PASS', gsc_last_crawl_time: '2026-09-10T00:00:00Z' }),
    state('https://a.com/fresh', { gsc_last_inspected: ago(1), gsc_verdict: 'PASS', gsc_last_crawl_time: '2026-09-10T00:00:00Z' }),
    state('https://a.com/noindex', { gsc_last_inspected: ago(1), gsc_verdict: 'NEUTRAL', gsc_coverage_state: "Excluded by 'noindex' tag" }),
    state('https://a.com/stale-inspection', { gsc_last_inspected: ago(30), gsc_verdict: 'NEUTRAL', gsc_coverage_state: 'Discovered - currently not indexed' }),
    state('https://a.com/uninspected'),
    state('https://a.com/retired', { gsc_last_inspected: ago(1), gsc_verdict: 'NEUTRAL' }),
  ];

  it('targets only not-indexed and changed-after-crawl pages, most valuable first', () => {
    const picked = selectIndexingCandidates(states, lastmods, { now: NOW });
    expect(picked.map(c => [c.url.slice('https://a.com/'.length), c.reason])).toEqual([
      ['unknown', 'not_indexed'],
      ['changed', 'changed_since_crawl'],
      ['crawled-not-indexed', 'not_indexed'],
    ]);
  });

  it('does not re-notify an unchanged URL inside the window', () => {
    const notified = states.map(s => s.url === 'https://a.com/unknown'
      ? { ...s, google_indexing_notified_at: ago(3), google_indexing_lastmod: '2026-09-20T00:00:00Z' }
      : s);
    const urls = selectIndexingCandidates(notified, lastmods, { now: NOW }).map(c => c.url);
    expect(urls).not.toContain('https://a.com/unknown');

    const later = selectIndexingCandidates(notified, lastmods, { now: NOW + 20 * DAY, maxInspectionAgeDays: 30 }).map(c => c.url);
    expect(later).toContain('https://a.com/unknown');
  });

  it('re-notifies once the page changes again', () => {
    const notified = states.map(s => s.url === 'https://a.com/changed'
      ? { ...s, google_indexing_notified_at: '2026-09-25T00:00:00Z', google_indexing_lastmod: '2026-09-24T00:00:00Z' }
      : s);
    expect(selectIndexingCandidates(notified, lastmods, { now: NOW }).map(c => c.url)).not.toContain('https://a.com/changed');

    const edited = new Map(lastmods).set('https://a.com/changed', '2026-09-26T00:00:00Z');
    expect(selectIndexingCandidates(notified, edited, { now: NOW }).map(c => c.url)).toContain('https://a.com/changed');
  });
});

describe('Indexing API account helpers', () => {
  it('buckets quota by the Cloud project behind the OAuth client', () => {
    expect(indexingQuotaBucket({ id: 'acc1', client_id: '123456789-abc.apps.googleusercontent.com' })).toBe('project:123456789');
    expect(indexingQuotaBucket({ id: 'acc1', client_id: 'custom' })).toBe('account:acc1');
  });

  it('reads the granted scope list', () => {
    expect(hasIndexingScope({ granted_scopes: `https://www.googleapis.com/auth/webmasters ${INDEXING_SCOPE}` })).toBe(true);
    expect(hasIndexingScope({ granted_scopes: 'https://www.googleapis.com/auth/webmasters' })).toBe(false);
    expect(hasIndexingScope({ granted_scopes: null })).toBeNull();
  });
});
