import { describe, it, expect } from 'vitest';
import type { UrlState } from '../db/database.js';
import { GOOGLE_INDEXING_CAPABILITIES, inspectUrl, oneOffPrompt, requestCandidates, routinePrompt } from '../indexer/request-indexing.js';

// "Request indexing" has no API, so the queue decides which pages are worth a
// manual (browser-agent) request and the prompts must keep the agent safe:
// no credential entry, stop on quota, skip pages a request can't fix.

const site = { id: 's1', gsc_url: 'sc-domain:example.com' };
const NOW = Date.parse('2026-10-19T09:00:00Z');
const base = (url: string, extra: Partial<UrlState> = {}): UrlState => ({
  url, site_id: 's1', last_submitted: null, last_seen_lastmod: null, submission_count: 0, google_submitted: 0, indexnow_submitted: 0, ...extra,
});

describe('request indexing queue', () => {
  const states: UrlState[] = [
    base('https://example.com/indexed', { gsc_verdict: 'PASS', gsc_last_crawl_time: '2026-10-10T00:00:00Z', last_seen_lastmod: '2026-10-01T00:00:00Z' }),
    base('https://example.com/new'),
    base('https://example.com/changed', { gsc_verdict: 'PASS', gsc_last_crawl_time: '2026-10-01T00:00:00Z', last_seen_lastmod: '2026-10-15T00:00:00Z' }),
    base('https://example.com/discovered', { gsc_verdict: 'NEUTRAL', gsc_coverage_state: 'Discovered - currently not indexed' }),
    base('https://example.com/noindex', { gsc_verdict: 'NEUTRAL', gsc_coverage_state: "Excluded by 'noindex' tag" }),
    base('https://example.com/llms.txt', { indexnow_only: 1 }),
    base('https://example.com/asked', { gsc_verdict: 'NEUTRAL', gsc_coverage_state: 'Crawled - currently not indexed', manual_index_requested_at: '2026-10-17T00:00:00Z' }),
  ];

  it('ranks fixable not-indexed pages, then changed pages, then new pages', () => {
    const queue = requestCandidates(site, states, { now: NOW });
    expect(queue.map(c => [c.url.replace('https://example.com/', ''), c.reason])).toEqual([
      ['discovered', 'not_indexed'],
      ['changed', 'changed_since_crawl'],
      ['new', 'never_inspected'],
    ]);
    expect(queue[0].inspect_url).toBe(inspectUrl('sc-domain:example.com', 'https://example.com/discovered'));
    expect(queue[0].inspect_url).toContain('resource_id=sc-domain%3Aexample.com&id=https%3A%2F%2Fexample.com%2Fdiscovered');
  });

  it('brings a recently requested page back once it changes again', () => {
    const changed = states.map(s => s.url.endsWith('/asked') ? { ...s, last_seen_lastmod: '2026-10-18T00:00:00Z' } : s);
    expect(requestCandidates(site, changed, { now: NOW }).some(c => c.url.endsWith('/asked'))).toBe(true);
    expect(requestCandidates(site, states, { now: NOW + 8 * 86_400_000 }).some(c => c.url.endsWith('/asked'))).toBe(true);
  });

  it('builds prompts that never ask the agent to sign in and stop on quota', () => {
    const queue = requestCandidates(site, states, { now: NOW });
    const oneOff = oneOffPrompt({ siteName: 'Example', property: site.gsc_url, candidates: queue, maxPerRun: 2 });
    expect(oneOff).toContain('Never type a password');
    expect(oneOff).toContain('stop immediately');
    expect(oneOff).toContain('https://example.com/discovered');
    expect(oneOff).not.toContain('https://example.com/new'); // capped at 2
    const routine = routinePrompt({ siteName: 'Example', siteId: 's1', property: site.gsc_url, maxPerRun: 10, connectorName: 'SEO Website Indexer', endpoint: 'https://seo.example.com/mcp' });
    expect(routine).toContain('get_indexing_request_queue with siteId "s1"');
    expect(routine).toContain('record_indexing_requests');
  });

  it('is explicit that the Request indexing button has no API', () => {
    const button = GOOGLE_INDEXING_CAPABILITIES.find(c => c.action.startsWith('Request indexing'));
    expect(button?.support).toBe('not_available');
    expect(GOOGLE_INDEXING_CAPABILITIES.find(c => c.via === 'Indexing API')?.support).toBe('limited');
  });
});
