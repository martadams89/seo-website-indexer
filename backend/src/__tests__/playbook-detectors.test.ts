import { describe, it, expect } from 'vitest';
import {
  computeOpportunities, buildCtrCurve, brandTermsFor, isBrandQuery, sig2, bucketIndex, FALLBACK_CTR,
  type PlaybookInput, type PageHistory, type Window,
} from '../analytics/playbook-detectors.js';
import type { QueryPageRow } from '../analytics/query-page-performance.js';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const O = 'https://acme.example';

const win = (clicks: number, impressions: number, position: number, days = 28): Window => ({ clicks, impressions, position, days });
const row = (query: string, page: string, clicks: number, impressions: number, position: number): QueryPageRow =>
  ({ query, page: `${O}${page}`, clicks, impressions, position });

function history(page: string, w28: Window, p28: Window = w28, b28: Window | null = null, extra: Partial<PageHistory> = {}): [string, PageHistory] {
  const half = (w: Window): Window => ({ clicks: w.clicks / 2, impressions: w.impressions / 2, position: w.position, days: 14 });
  return [`${O}${page}`, {
    url: `${O}${page}`, w28, p28, b28, halves: [half(w28), half(w28)],
    weeks: [w28.clicks / 4, w28.clicks / 4, w28.clicks / 4, w28.clicks / 4], first21: w28.clicks * 0.75, ...extra,
  }];
}

function input(partial: Partial<PlaybookInput> & { pages: Array<[string, PageHistory]> }): PlaybookInput {
  const pages = new Map(partial.pages);
  const site = partial.site ?? {
    w28: [...pages.values()].reduce((s, p) => win(s.clicks + p.w28.clicks, s.impressions + p.w28.impressions, 5), win(0, 0, 5)),
    p28: [...pages.values()].reduce((s, p) => win(s.clicks + p.p28.clicks, s.impressions + p.p28.impressions, 5), win(0, 0, 5)),
  };
  return {
    now: NOW, siteName: 'Acme Boots', domain: 'acme.example', rows: [], truncated: false,
    meta: new Map(), index: new Map(), links: new Map(), snippetChanges: [], vitals: [],
    ...partial, pages, site,
  };
}

describe('helpers', () => {
  it('rounds to two significant figures and buckets positions', () => {
    expect(sig2(1234)).toBe(1200);
    expect(sig2(0.0456)).toBe(0.046);
    expect(sig2(7)).toBe(7);
    expect([1, 1.4, 1.6, 10, 12, 18].map(bucketIndex)).toEqual([0, 0, 1, 9, 10, 11]);
  });

  it('derives brand terms from the domain, name, titles and extras', () => {
    const t = brandTermsFor('Acme Boots', 'www.acme-boots.co.uk', ['Hiking boots | Acme Boots', 'Socks | Acme Boots', 'Jackets - Acme Boots'], ['ACME']);
    expect(t).toEqual(expect.arrayContaining(['acmeboots', 'acme', 'acme boots']));
    expect(t).not.toContain('boots'); // the category word stays searchable
    expect(isBrandQuery('acme boots sale', t)).toBe(true);
    expect(isBrandQuery('acmeboots returns', t)).toBe(true);
    expect(isBrandQuery('waterproof hiking boots', t)).toBe(false);
    expect(brandTermsFor('Acme', 'shop.acme.co.uk', [], [])).toContain('acme');
  });
});

describe('buildCtrCurve', () => {
  it('falls back to the industry curve with no data and stays non-increasing with data', () => {
    const empty = buildCtrCurve([], []);
    expect(empty.buckets.map(b => Math.round(b * 1000) / 1000)).toEqual(FALLBACK_CTR);
    expect(empty.labels.every(l => l === 'industry')).toBe(true);
    // A site whose position-3 CTR is genuinely high pulls bucket 3 up, but never above bucket 2.
    const rows = Array.from({ length: 20 }, (_, i) => row(`q${i}`, '/p', 60, 200, 3));
    const c = buildCtrCurve(rows, []);
    expect(c.labels[2]).toBe('site');
    expect(c.buckets[2]).toBeGreaterThan(FALLBACK_CTR[2]);
    for (let i = 1; i < c.buckets.length; i++) expect(c.buckets[i]).toBeLessThanOrEqual(c.buckets[i - 1] + 1e-12);
    expect(c.at(2.5)).toBeCloseTo((c.buckets[1] + c.buckets[2]) / 2, 6);
    expect(c.width([{ position: 3, impressions: 100 }])).toBe(0.15);
  });

  it('ignores brand queries and thin rows', () => {
    const c = buildCtrCurve([row('acme boots', '/', 500, 600, 1), row('x', '/a', 1, 10, 1)], ['acme']);
    expect(c.samples[0]).toEqual({ impressions: 0, clicks: 0 });
  });
});

describe('ctr_gap', () => {
  const rows = [
    row('waterproof boots', '/boots', 6, 1200, 4.2),
    row('best hiking boots', '/boots', 4, 900, 5.1),
    row('boots for winter', '/boots', 2, 600, 6.0),
  ];
  const meta = new Map([['acme.example/boots', { status: 200, title: 'Boots', h1: 'Boots', words: 800, robots: null, fetchedAt: new Date(NOW).toISOString() }]]);

  it('flags a page earning far below the curve, with an honest range', () => {
    const r = computeOpportunities(input({ rows, meta, pages: [history('/boots', win(12, 3000, 5), win(12, 3000, 5))] }));
    const item = r.opportunities.find(o => o.kind === 'ctr_gap');
    expect(item).toBeTruthy();
    expect(item!.subtype).toBe('query');
    expect(item!.effort).toBe('S');
    expect(item!.low).toBeGreaterThan(0);
    expect(item!.high).toBeGreaterThan(item!.low);
    // Expected ≈ 1200×0.07 + 900×0.055 + 600×0.045 ≈ 160 clicks/28d vs 12 observed → gap ≈ 148;
    // low = 0.25 × gap × 30/28 × (1 − 0.4) ≈ 24, high = 0.6 × gap × 30/28 × 1.4 ≈ 130.
    expect(item!.low).toBeGreaterThanOrEqual(15);
    expect(item!.high).toBeLessThanOrEqual(160);
    expect(item!.headline).toMatch(/Rewrite the title and description/);
    expect(item!.steps[0].copy).toBe('waterproof boots');
    // The page also has a striking-distance item; exactly one of them is counted.
    expect(r.opportunities.filter(o => o.page === `${O}/boots` && o.counted)).toHaveLength(1);
  });

  it('does not fire when clicks are near expectation, only in one half, or right after a snippet change', () => {
    const ok = computeOpportunities(input({ rows: rows.map(q => ({ ...q, clicks: Math.round(q.impressions * 0.06) })), meta, pages: [history('/boots', win(160, 3000, 5))] }));
    expect(ok.opportunities.filter(o => o.kind === 'ctr_gap')).toHaveLength(0);
    const [url, h] = history('/boots', win(12, 3000, 5));
    const noisy = computeOpportunities(input({ rows, meta, pages: [[url, { ...h, halves: [win(2, 1500, 5, 14), win(90, 1500, 5, 14)] }]] }));
    expect(noisy.opportunities.filter(o => o.kind === 'ctr_gap')).toHaveLength(0);
    const changed = computeOpportunities(input({ rows, meta, pages: [history('/boots', win(12, 3000, 5))], snippetChanges: [{
      id: 1, site_id: 's', url: `${O}/boots`, changed_at: new Date(NOW - 5 * 86400000).toISOString(), old_title: 'a', new_title: 'b', old_description: null, new_description: null,
      before: win(0, 0, 0), after: win(0, 0, 0), ctrChangePct: null, positionChange: null, verdict: 'collecting', readyOn: '2026-10-10',
    }] }));
    expect(changed.opportunities.filter(o => o.kind === 'ctr_gap')).toHaveLength(0);
  });

  it('raises a regression item when a measured title change cut CTR without a ranking loss', () => {
    const r = computeOpportunities(input({ pages: [history('/boots', win(40, 2000, 4))], snippetChanges: [{
      id: 1, site_id: 's', url: `${O}/boots`, changed_at: '2026-08-20T10:00:00Z', old_title: 'Waterproof hiking boots', new_title: 'Boots', old_description: null, new_description: null,
      before: { clicks: 120, impressions: 2000, ctr: 0.06, position: 4.1, days: 28 }, after: { clicks: 60, impressions: 2000, ctr: 0.03, position: 4.3, days: 28 },
      ctrChangePct: -50, positionChange: 0.2, verdict: 'worse', readyOn: '2026-09-10',
    }] }));
    const item = r.opportunities.find(o => o.subtype === 'regression');
    expect(item).toBeTruthy();
    expect(item!.steps[0].copy).toBe('Waterproof hiking boots');
    expect(item!.confidence).toBe('high');
    expect(item!.low).toBeGreaterThanOrEqual(25);
  });
});

describe('striking_distance', () => {
  const rows = [
    row('hiking socks', '/socks', 20, 1500, 7.2),
    row('merino socks', '/socks', 8, 900, 9.4),
    row('warm socks', '/socks', 1, 400, 13.0),
    row('acme socks', '/socks', 50, 300, 1.2),      // brand: excluded
    row('socks', '/socks', 10, 250, 12.0),           // page holds only 250 of 2000 → cannibalisation's query
    row('socks', '/shop', 40, 1750, 4.0),
  ];
  const meta = new Map([['acme.example/socks', { status: 200, title: 'Socks | Acme Boots', h1: 'Socks', words: 900, robots: null, fetchedAt: new Date(NOW).toISOString() }]]);

  it('prices the queries within reach, spots missing terms and folds in link suggestions', () => {
    const links = new Map([['acme.example/socks', { inbound: 1, suggestions: [{ source: `${O}/boots`, sourceTitle: 'Boots', sharedTerms: ['hiking'], sourceClicks: 300 }], anchorHint: 'Hiking socks', orphansConfirmed: true }]]);
    const r = computeOpportunities(input({ rows, meta, links, pages: [history('/socks', win(90, 3400, 7)), history('/shop', win(40, 1750, 4))] }));
    const item = r.opportunities.find(o => o.kind === 'striking_distance' && o.page === `${O}/socks`);
    expect(item).toBeTruthy();
    expect((item!.evidence.queries as Array<{ query: string }>).map(q => q.query)).toEqual(['hiking socks', 'merino socks', 'warm socks']);
    expect(item!.subtype).toBe('on_page_gap'); // "hiking" is missing from title and H1
    expect(item!.steps.some(s => /Link to it from \/boots/.test(s.text) && s.copy === 'Hiking socks')).toBe(true);
    expect(item!.high).toBeGreaterThan(item!.low);
    expect(item!.effort).toBe('M');
  });

  it('needs enough searches and skips pages Google cannot index', () => {
    const thin = computeOpportunities(input({ rows: [row('hiking socks', '/socks', 2, 120, 8)], meta, pages: [history('/socks', win(2, 200, 8))] }));
    expect(thin.opportunities.filter(o => o.kind === 'striking_distance')).toHaveLength(0);
    const index = new Map([['acme.example/socks', { verdict: 'FAIL', coverage: 'Not found (404)', indexingState: null, pageFetchState: 'NOT_FOUND', googleCanonical: null, contentChangedAt: null }]]);
    const blocked = computeOpportunities(input({ rows, meta, index, pages: [history('/socks', win(90, 3400, 7))] }));
    expect(blocked.opportunities.filter(o => o.kind === 'striking_distance')).toHaveLength(0);
    expect(blocked.blockers.map(b => b.kind)).toContain('index_blocker');
  });
});

describe('cannibalisation', () => {
  const shared = (query: string, impr: number, posA: number, posB: number, clicksA: number, clicksB: number) => [
    row(query, '/guides/tents', clicksA, impr, posA), row(query, '/blog/tents-old', clicksB, Math.round(impr * 0.8), posB),
  ];
  const rows = [
    ...shared('best tents', 800, 6.1, 8.3, 12, 8),
    ...shared('family tents', 500, 7.0, 9.0, 8, 5),
    ...shared('tent buying guide', 300, 5.5, 11.0, 6, 3),
    row('tent pegs', '/blog/tents-old', 4, 200, 9),
  ];

  it('pairs the pages, picks the primary, prices with max() searches and recommends consolidation', () => {
    const r = computeOpportunities(input({ rows, pages: [history('/guides/tents', win(90, 3000, 6.5)), history('/blog/tents-old', win(20, 2000, 9))] }));
    const item = r.opportunities.find(o => o.kind === 'cannibalisation');
    expect(item).toBeTruthy();
    expect(item!.page).toBe(`${O}/guides/tents`);
    expect(item!.secondaryPage).toBe(`${O}/blog/tents-old`);
    expect(item!.subtype).toBe('consolidate'); // the old post earns 4 of its 20 clicks outside the shared queries
    expect(item!.hidden).toBe(false);
    expect(item!.evidence.sharedQueries).toBe(3);
    expect(item!.evidence.sharedSearches).toBe(1600); // max(impr) per query, never the sum
    expect(item!.effort).toBe('L');
    expect(item!.steps.some(s => /301-redirect \/blog\/tents-old to \/guides\/tents/.test(s.text))).toBe(true);
    // The secondary page carries no other items.
    expect(r.opportunities.filter(o => o.page === `${O}/blog/tents-old`)).toHaveLength(0);
  });

  it('ignores double listings in the top three, dominant leaders and canonical pairs', () => {
    const top = computeOpportunities(input({ rows: [...shared('best tents', 800, 1.2, 2.5, 200, 90), ...shared('family tents', 500, 2.0, 3.0, 100, 40), ...shared('tent guide', 400, 1.5, 2.9, 90, 30)], pages: [history('/guides/tents', win(400, 2000, 2)), history('/blog/tents-old', win(160, 1600, 3))] }));
    expect(top.opportunities.filter(o => o.kind === 'cannibalisation')).toHaveLength(0);
    const dominant = computeOpportunities(input({ rows: [...shared('best tents', 800, 6, 8, 100, 5), ...shared('family tents', 500, 7, 9, 60, 3), ...shared('tent guide', 400, 6, 9, 50, 2)], pages: [history('/guides/tents', win(210, 3000, 6)), history('/blog/tents-old', win(10, 1400, 9))] }));
    expect(dominant.opportunities.filter(o => o.kind === 'cannibalisation')).toHaveLength(0);
    const index = new Map([['acme.example/blog/tents-old', { verdict: 'NEUTRAL', coverage: 'Alternate page with proper canonical tag', indexingState: null, pageFetchState: null, googleCanonical: `${O}/guides/tents`, contentChangedAt: null }]]);
    const canonical = computeOpportunities(input({ rows, index, pages: [history('/guides/tents', win(90, 3000, 6.5)), history('/blog/tents-old', win(20, 2000, 9))] }));
    expect(canonical.opportunities.filter(o => o.kind === 'cannibalisation')).toHaveLength(0);
  });
});

describe('content_decay', () => {
  it('flags a sustained ranking loss against a conservative baseline, with a refresh plan', () => {
    const r = computeOpportunities(input({
      rows: [row('tent repair', '/repair', 10, 600, 9.5), row('fix tent pole', '/repair', 5, 300, 11)],
      pages: [
        history('/repair', win(60, 2400, 9.3), win(200, 2600, 4.8), win(180, 2500, 5.0), { weeks: [18, 15, 14, 13], first21: 46 }),
        history('/stable', win(500, 8000, 3), win(500, 8000, 3)),
      ],
    }));
    const item = r.opportunities.find(o => o.kind === 'content_decay');
    expect(item).toBeTruthy();
    expect(item!.subtype).toBe('rank');
    // baseline = min(P28, mean(P28, B28)) = min(200, 190) = 190; lost = 130/28d ≈ 139/month → low ≈ 42 × 0.8, high ≈ 97 × 1.2 (industry width capped at 0.2)
    expect(item!.evidence.baselineClicks).toBe(190);
    expect(item!.low).toBeGreaterThanOrEqual(30);
    expect(item!.high).toBeLessThanOrEqual(130);
    expect(item!.steps.some(s => /"tent repair" \(position 9\.5\)/.test(s.text))).toBe(true);
  });

  it('does not fire for regression to the mean, a site-wide decline, or a drop in the last week only', () => {
    // P28 was a spike (120) over B28 (40): baseline = min(120, 80) = 80; W28 60 → ratio 0.75 > 0.7.
    const spike = computeOpportunities(input({ pages: [history('/x', win(60, 2000, 5), win(120, 2400, 4.5), win(40, 1800, 5.2), { weeks: [15, 15, 15, 15] }), history('/stable', win(500, 8000, 3))] }));
    expect(spike.opportunities.filter(o => o.kind === 'content_decay')).toHaveLength(0);

    const siteWide = computeOpportunities(input({
      site: { w28: win(300, 20000, 6), p28: win(600, 22000, 5) },
      pages: [history('/x', win(70, 2400, 9), win(200, 2600, 5), null, { weeks: [18, 18, 17, 17], first21: 52 })],
    }));
    expect(siteWide.blockers.map(b => b.kind)).toContain('site_wide_decline');
    expect(siteWide.opportunities.filter(o => o.kind === 'content_decay')).toHaveLength(0); // 0.35 vs site 0.50: not 20 points worse

    const recent = computeOpportunities(input({ pages: [history('/x', win(60, 2400, 9), win(200, 2600, 5), null, { weeks: [50, 45, 40, -75].map(v => Math.max(v, 0)), first21: 135 }), history('/stable', win(500, 8000, 3))] }));
    expect(recent.opportunities.filter(o => o.kind === 'content_decay')).toHaveLength(0);
  });

  it('records demand loss without surfacing it', () => {
    const r = computeOpportunities(input({ pages: [history('/x', win(60, 900, 4.9), win(200, 3000, 4.8), null, { weeks: [15, 15, 15, 15], first21: 45 }), history('/stable', win(500, 8000, 3))] }));
    const item = r.opportunities.find(o => o.kind === 'content_decay');
    expect(item?.subtype).toBe('demand');
    expect(item?.hidden).toBe(true);
    expect(item?.counted).toBe(false);
  });
});

describe('ranking and summary', () => {
  it('counts one item per page, orders by point, and caps the site total', () => {
    const rows = [
      row('waterproof boots', '/boots', 6, 1200, 4.2), row('best hiking boots', '/boots', 4, 900, 5.1), row('boots for winter', '/boots', 2, 600, 6.0),
      row('boot care', '/boots', 3, 800, 8.5),
    ];
    const meta = new Map([['acme.example/boots', { status: 200, title: 'Boots', h1: 'Boots', words: 800, robots: null, fetchedAt: new Date(NOW).toISOString() }]]);
    const r = computeOpportunities(input({ rows, meta, pages: [history('/boots', win(15, 3500, 5.5))] }));
    const kinds = r.opportunities.map(o => o.kind);
    expect(kinds).toEqual(expect.arrayContaining(['ctr_gap', 'striking_distance']));
    expect(r.opportunities.filter(o => o.counted)).toHaveLength(1);
    expect(r.opportunities[0].point).toBeGreaterThanOrEqual(r.opportunities[1].point);
    // 15 clicks/28d → 16/month; a counted high above 60% of that is capped.
    expect(r.summary.capped).toBe(true);
    expect(r.summary.high).toBeLessThanOrEqual(10);
    const striking = r.opportunities.find(o => o.kind === 'striking_distance')!;
    expect(striking.steps[0].text).toMatch(/Rewrite the title and description first/);
  });

  it('lists Core Web Vitals failures as protect items ranked by clicks at stake', () => {
    const r = computeOpportunities(input({
      pages: [history('/a', win(280, 5000, 3)), history('/b', win(28, 900, 6))],
      vitals: [{ url: `${O}/b`, rating: 'poor', lcp_ms: 4800, inp_ms: 100, cls: 0.02 }, { url: `${O}/a`, rating: 'needs_improvement', lcp_ms: 3000, inp_ms: null, cls: null }],
    }));
    expect(r.blockers.map(b => [b.kind, b.atStake])).toEqual([['vitals', 300], ['vitals', 30]]);
    expect(r.summary.counted).toBe(0);
  });
});
