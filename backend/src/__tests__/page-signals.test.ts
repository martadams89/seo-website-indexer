import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { analyseInternalLinks, linkKey, terms, type InventoryPage } from '../analytics/internal-links.js';
import { assessVitals } from '../analytics/page-vitals.js';
import type { PageTotals } from '../analytics/page-performance.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-page-signals-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'page-signals-secret-1234567890';

let db: typeof import('../db/database.js');
let perf: typeof import('../analytics/page-performance.js');

beforeAll(async () => {
  db = await import('../db/database.js');
  perf = await import('../analytics/page-performance.js');
});

const O = 'https://shop.example';
function page(p: string, title: string, links: string[], extra: Partial<InventoryPage> = {}): InventoryPage {
  return {
    url: `${O}${p}`, status: 200, title, meta_description: null, h1: title, robots: null, words: 500,
    links: links.map(l => ({ url: `${O}${l}`, anchor: '', rel: [] })), fetched_at: '2026-09-26T00:00:00Z', ...extra,
  };
}
const totals = (clicks: number, impressions: number, position: number): PageTotals =>
  ({ clicks, impressions, ctr: impressions ? clicks / impressions : 0, position, days: 28 });

describe('linkKey and terms', () => {
  it('normalises hosts and trailing slashes', () => {
    expect(linkKey('https://www.Shop.example/a/')).toBe(linkKey('https://shop.example/a'));
    expect(linkKey('https://shop.example/a?x=1#top')).toBe('shop.example/a?x=1');
  });
  it('drops stopwords and short tokens', () => {
    expect(terms('The Best Waterproof Hiking Boots for Winter')).toEqual(['waterproof', 'hiking', 'boots', 'winter']);
  });
});

describe('analyseInternalLinks', () => {
  const pages = [
    page('/', 'Shop | Acme', ['/boots', '/jackets']),
    page('/boots', 'Hiking boots | Acme', ['/jackets']),
    page('/jackets', 'Waterproof jackets | Acme', ['/boots']),
    page('/boots/waterproof', 'Waterproof hiking boots guide | Acme', []),
    page('/socks', 'Hiking socks | Acme', ['/boots/waterproof'], { links: [{ url: `${O}/boots/waterproof`, anchor: 'x', rel: ['nofollow'] }] }),
    page('/private', 'Private hiking page | Acme', [], { robots: 'noindex' }),
  ];
  const sitemap = pages.map(p => p.url);

  it('finds orphans, ignores nofollow, noindex and the homepage, and suggests related linkers', () => {
    const report = analyseInternalLinks({
      sitemapUrls: sitemap, pages,
      perf: new Map([[`${O}/boots/waterproof`, totals(10, 900, 11.4)], [`${O}/boots`, totals(300, 5000, 3)]]),
      indexed: new Set([`${O}/boots`]),
    });
    expect(report.coverage).toBe(1);
    expect(report.orphansConfirmed).toBe(true);
    const target = report.targets[0];
    expect(target.url).toBe(`${O}/boots/waterproof`);
    expect(target.kind).toBe('orphan'); // the only link to it is nofollow
    expect(target.pageTwo).toBe(true);
    expect(target.anchorHint).toBe('Waterproof hiking boots guide');
    // /boots shares "hiking boots", is indexed and has traffic: best linker.
    expect(target.suggestions[0].source).toBe(`${O}/boots`);
    expect(target.suggestions.map(s => s.source)).not.toContain(`${O}/private`);
    expect(report.weakOrOrphanUrls).not.toContain(`${O}/`);
    expect(report.weakOrOrphanUrls).not.toContain(`${O}/private`);
    // The brand term appears on every page, so it never counts as a shared topic.
    expect(target.suggestions.flatMap(s => s.sharedTerms)).not.toContain('acme');
  });

  it('does not confirm orphans until 90% of pages are mapped', () => {
    const report = analyseInternalLinks({ sitemapUrls: [...sitemap, ...Array.from({ length: 10 }, (_, i) => `${O}/new-${i}`)], pages });
    expect(report.orphansConfirmed).toBe(false);
  });
});

describe('assessVitals', () => {
  it('rates each metric against the Core Web Vitals thresholds', () => {
    expect(assessVitals({ lcp_ms: 2000, inp_ms: 150, cls: 0.05 }).rating).toBe('good');
    const ni = assessVitals({ lcp_ms: 3000, inp_ms: 150, cls: null });
    expect(ni.rating).toBe('needs_improvement');
    expect(ni.failing.map(f => f.label)).toEqual(['LCP']);
    expect(assessVitals({ lcp_ms: 2000, inp_ms: 600, cls: 0.3 }).failing.map(f => [f.label, f.rating])).toEqual([
      ['INP', 'poor'], ['CLS', 'poor'],
    ]);
  });
});

describe('evaluateSnippetChange', () => {
  it('compares CTR before and after a title change', () => {
    const siteId = randomUUID();
    db.upsertSite({ id: siteId, name: 's', domain: `${siteId}.example`, sitemap_url: `${O}/sitemap.xml`, gsc_url: `${O}/`, enabled: 1 });
    const url = `${O}/boots`;
    const insert = db.getDb().prepare('INSERT INTO perf_page_daily(site_id, day, page, clicks, impressions, position) VALUES(?,?,?,?,?,?)');
    const changed = Date.parse('2026-08-01T10:00:00Z');
    for (let d = 1; d <= 28; d++) {
      const before = new Date(changed - d * 86400000).toISOString().slice(0, 10);
      const after = new Date(changed + d * 86400000).toISOString().slice(0, 10);
      insert.run(siteId, before, url, 2, 100, 8);   // 2% CTR
      insert.run(siteId, after, url, 4, 100, 8);    // 4% CTR
    }
    const change = { id: 1, site_id: siteId, url, changed_at: new Date(changed).toISOString(), old_title: 'Boots', new_title: 'Waterproof hiking boots', old_description: null, new_description: null };

    const done = perf.evaluateSnippetChange(change, Date.parse('2026-09-26T00:00:00Z'));
    expect(done.verdict).toBe('improved');
    expect(Math.round(done.ctrChangePct!)).toBe(100);
    expect(done.positionChange).toBe(0);

    const early = perf.evaluateSnippetChange(change, changed + 5 * 86400000);
    expect(early.verdict).toBe('collecting');
  });
});
