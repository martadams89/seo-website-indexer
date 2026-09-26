import { describe, it, expect } from 'vitest';
import { inspectionFinding, contentFingerprint, lastmodQuality, normaliseUrl } from '../indexer/google-feedback.js';

const URL_A = 'https://a.com/guide';

describe('inspectionFinding', () => {
  it('returns nothing for indexed or queued pages', () => {
    expect(inspectionFinding(URL_A, { verdict: 'PASS', coverageState: 'Submitted and indexed', googleCanonical: URL_A, userCanonical: URL_A })).toBeNull();
    expect(inspectionFinding(URL_A, { verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed' })).toBeNull();
    expect(inspectionFinding(URL_A, { verdict: 'NEUTRAL', coverageState: 'URL is unknown to Google' })).toBeNull();
  });

  it('flags Google choosing another canonical', () => {
    const f = inspectionFinding(URL_A, { verdict: 'NEUTRAL', googleCanonical: 'https://a.com/other', userCanonical: URL_A });
    expect(f?.code).toBe('canonical_mismatch');
    expect(f?.severity).toBe('high');
    // Trailing slash / host case differences are not a mismatch.
    expect(inspectionFinding(URL_A, { verdict: 'PASS', googleCanonical: 'https://A.com/guide/', userCanonical: URL_A })).toBeNull();
    // Page deliberately canonicalised elsewhere: not Google overriding the site.
    expect(inspectionFinding(URL_A, { googleCanonical: 'https://a.com/other', userCanonical: 'https://a.com/other' })).toBeNull();
  });

  it('prioritises fetch errors and blocks', () => {
    expect(inspectionFinding(URL_A, { pageFetchState: 'SOFT_404', googleCanonical: 'https://a.com/x' })?.code).toBe('fetch_error');
    expect(inspectionFinding(URL_A, { indexingState: 'BLOCKED_BY_META_TAG' })?.title).toMatch(/noindex robots meta tag/);
    expect(inspectionFinding(URL_A, { robotsTxtState: 'DISALLOWED' })?.title).toMatch(/robots\.txt/);
  });

  it('classifies coverage states', () => {
    expect(inspectionFinding(URL_A, { coverageState: 'Page with redirect' })?.code).toBe('redirect');
    expect(inspectionFinding(URL_A, { coverageState: 'Duplicate without user-selected canonical' })?.code).toBe('duplicate_no_canonical');
    expect(inspectionFinding(URL_A, { coverageState: 'Crawled - currently not indexed' })?.code).toBe('crawled_not_indexed');
  });
});

describe('normaliseUrl', () => {
  it('ignores case of host, trailing slash and fragment', () => {
    expect(normaliseUrl('https://A.com/x/#top')).toBe('https://a.com/x');
    expect(normaliseUrl('https://a.com/')).toBe('https://a.com/');
  });
});

describe('contentFingerprint', () => {
  it('ignores scripts, markup and whitespace but not text', () => {
    const a = '<html><script nonce="1">x=1</script><body><h1>Title</h1>\n<p>Body text</p></body></html>';
    const b = '<html><script nonce="2">x=2</script><body><h1 class="big">Title</h1> <p>Body   text</p></body></html>';
    const c = '<html><body><h1>Title</h1><p>New body text</p></body></html>';
    expect(contentFingerprint(a)).toBe(contentFingerprint(b));
    expect(contentFingerprint(a)).not.toBe(contentFingerprint(c));
  });
});

describe('lastmodQuality', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');

  it('flags future dates', () => {
    const issues = lastmodQuality([{ url: 'https://a.com/1', lastmod: '2027-01-01' }], { now });
    expect(issues.map(i => i.code)).toEqual(['future_lastmod']);
  });

  it('flags one timestamp across the sitemap', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ url: `https://a.com/${i}`, lastmod: '2026-09-26T03:00:00Z' }));
    expect(lastmodQuality(entries, { now }).map(i => i.code)).toEqual(['uniform_lastmod']);
    const varied = entries.map((e, i) => ({ ...e, lastmod: `2026-09-${String((i % 25) + 1).padStart(2, '0')}` }));
    expect(lastmodQuality(varied, { now })).toEqual([]);
  });

  it('flags lastmod bumps without content changes', () => {
    expect(lastmodQuality([], { now, checkedChanged: 10, bumpedWithoutChange: 8 }).map(i => i.code)).toEqual(['lastmod_without_change']);
    expect(lastmodQuality([], { now, checkedChanged: 10, bumpedWithoutChange: 2 })).toEqual([]);
    expect(lastmodQuality([], { now, checkedChanged: 3, bumpedWithoutChange: 3 })).toEqual([]);
  });
});
