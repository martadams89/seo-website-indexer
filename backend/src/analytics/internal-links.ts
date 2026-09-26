/**
 * Internal-link analysis.
 *
 * The scheduler keeps a rolling inventory of every sitemap page (title, H1,
 * meta description, outgoing links), refreshing a slice each run. From it we
 * build the site's internal link graph and find pages that are orphaned (no
 * internal links at all) or weakly linked, prioritising pages that already
 * rank on page one/two where a stronger internal link has the most upside,
 * and suggest topically related, indexed pages that should link to them.
 */
import { getDb } from '../db/database.js';
import type { PageTotals } from './page-performance.js';

export interface InventoryLink { url: string; anchor: string; rel: string[] }

export interface InventoryPage {
  url: string;
  status: number;
  title: string | null;
  meta_description: string | null;
  h1: string | null;
  robots: string | null;
  words: number;
  links: InventoryLink[];
  fetched_at: string;
}

// ── Storage ──────────────────────────────────────────────────────────────────

export function getInventoryPage(siteId: string, url: string): InventoryPage | null {
  const row = getDb().prepare('SELECT * FROM page_inventory WHERE site_id = ? AND url = ?').get(siteId, url) as
    (Omit<InventoryPage, 'links'> & { links: string }) | undefined;
  return row ? { ...row, links: JSON.parse(row.links) as InventoryLink[] } : null;
}

export function listInventory(siteId: string): InventoryPage[] {
  return (getDb().prepare('SELECT * FROM page_inventory WHERE site_id = ?').all(siteId) as Array<Omit<InventoryPage, 'links'> & { links: string }>)
    .map(row => ({ ...row, links: JSON.parse(row.links) as InventoryLink[] }));
}

/** fetched_at per URL, to pick the stalest pages for this run's refresh slice. */
export function inventoryFetchTimes(siteId: string): Map<string, string> {
  const rows = getDb().prepare('SELECT url, fetched_at FROM page_inventory WHERE site_id = ?').all(siteId) as Array<{ url: string; fetched_at: string }>;
  return new Map(rows.map(r => [r.url, r.fetched_at]));
}

export function upsertInventoryPage(siteId: string, page: Omit<InventoryPage, 'fetched_at'>): void {
  getDb().prepare(`
    INSERT INTO page_inventory(site_id, url, status, title, meta_description, h1, robots, words, links, fetched_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(site_id, url) DO UPDATE SET status=excluded.status, title=excluded.title,
      meta_description=excluded.meta_description, h1=excluded.h1, robots=excluded.robots, words=excluded.words,
      links=excluded.links, fetched_at=excluded.fetched_at
  `).run(siteId, page.url, page.status, page.title, page.meta_description, page.h1, page.robots, page.words,
    JSON.stringify(page.links), new Date().toISOString());
}

// ── Analysis ─────────────────────────────────────────────────────────────────

/** Comparable key: host without www, path without trailing slash, query kept, fragment dropped. */
export function linkKey(value: string): string {
  try {
    const u = new URL(value);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '/';
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path}${u.search}`;
  } catch {
    return value;
  }
}

const STOPWORDS = new Set(`a an and are as at be but by can do does for from how i if in into is it its of on or our
  so than that the their them then there these they this to too us was we what when where which who why will with
  you your yours about after all also any best more most new not now only other over some such very vs get got
  guide page home www com html`.split(/\s+/));

export function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(t => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t)))];
}

const isNoindex = (robots: string | null) => /(?:^|[\s,])(?:noindex|none)(?:$|[\s,;])/i.test(robots ?? '');

export interface LinkSuggestion {
  source: string;
  sourceTitle: string | null;
  sharedTerms: string[];
  sourceClicks: number;
}

export interface LinkTarget {
  url: string;
  title: string | null;
  inbound: number;
  kind: 'orphan' | 'weak';
  /** Ranks 4-20 with real impressions: a stronger internal link has the most upside here. */
  pageTwo: boolean;
  clicks: number;
  impressions: number;
  position: number | null;
  anchorHint: string | null;
  suggestions: LinkSuggestion[];
}

export interface InternalLinkReport {
  sitemapPages: number;
  inventoried: number;
  /** Share of sitemap pages inventoried; orphan claims need near-complete coverage. */
  coverage: number;
  orphansConfirmed: boolean;
  targets: LinkTarget[];
  /** Every orphaned or weakly linked page (targets holds the top-priority subset). */
  weakOrOrphanUrls: string[];
}

export interface AnalyseOptions {
  sitemapUrls: string[];
  pages: InventoryPage[];
  perf?: Map<string, PageTotals>;
  /** Pages Google reports as indexed (URL Inspection PASS). */
  indexed?: Set<string>;
  maxTargets?: number;
  weakThreshold?: number;
}

export function analyseInternalLinks(opts: AnalyseOptions): InternalLinkReport {
  const perf = opts.perf ?? new Map<string, PageTotals>();
  const indexed = opts.indexed ?? new Set<string>();
  const weakThreshold = opts.weakThreshold ?? 2;
  const sitemapKeys = new Map(opts.sitemapUrls.map(u => [linkKey(u), u]));
  const live = opts.pages.filter(p => p.status === 200 && sitemapKeys.has(linkKey(p.url)));
  const coverage = opts.sitemapUrls.length ? live.length / opts.sitemapUrls.length : 0;

  // Inbound: unique live source pages with a followed link to the target.
  const inbound = new Map<string, Set<string>>();
  const linksFrom = new Map<string, Set<string>>();
  for (const page of live) {
    const own = linkKey(page.url);
    const targets = new Set(page.links.filter(l => !l.rel.includes('nofollow')).map(l => linkKey(l.url)));
    linksFrom.set(own, targets);
    for (const t of targets) {
      if (t === own || !sitemapKeys.has(t)) continue;
      if (!inbound.has(t)) inbound.set(t, new Set());
      inbound.get(t)!.add(own);
    }
  }

  // Term weights: rare terms (a topic) count more than words on every page (the brand).
  const pageTerms = new Map(live.map(p => [linkKey(p.url), terms(`${p.title ?? ''} ${p.h1 ?? ''}`)]));
  const df = new Map<string, number>();
  for (const ts of pageTerms.values()) for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(1, live.length);
  const weight = (t: string) => {
    const d = df.get(t) ?? 0;
    return d / n > 0.5 ? 0 : Math.log(1 + n / Math.max(1, d));
  };
  const perfFor = (url: string) => perf.get(url) ?? perf.get(sitemapKeys.get(linkKey(url)) ?? '') ?? null;

  const candidates: LinkTarget[] = [];
  for (const page of live) {
    const key = linkKey(page.url);
    if (new URL(page.url).pathname === '/' || isNoindex(page.robots)) continue;
    const count = inbound.get(key)?.size ?? 0;
    if (count > weakThreshold) continue;
    const p = perfFor(page.url);
    const pageTwo = !!p && p.impressions >= 50 && p.position >= 4 && p.position <= 20;
    candidates.push({
      url: page.url, title: page.title, inbound: count, kind: count === 0 ? 'orphan' : 'weak', pageTwo,
      clicks: p?.clicks ?? 0, impressions: p?.impressions ?? 0, position: p ? Math.round(p.position * 10) / 10 : null,
      anchorHint: (page.h1 || page.title || '').replace(/\s*[|–—-]\s*[^|–—-]+$/, '').trim() || null,
      suggestions: [],
    });
  }

  const score = (t: LinkTarget) => (t.pageTwo ? 1000 : 0) + (t.kind === 'orphan' ? 500 : 0) + Math.log1p(t.impressions) * 10 - t.inbound;
  const targets = candidates.sort((a, b) => score(b) - score(a) || a.url.localeCompare(b.url)).slice(0, opts.maxTargets ?? 50);

  for (const target of targets) {
    const key = linkKey(target.url);
    const wanted = pageTerms.get(key) ?? [];
    const scored: Array<LinkSuggestion & { score: number }> = [];
    for (const source of live) {
      const sKey = linkKey(source.url);
      if (sKey === key || isNoindex(source.robots) || linksFrom.get(sKey)?.has(key)) continue;
      const shared = (pageTerms.get(sKey) ?? []).filter(t => wanted.includes(t) && weight(t) > 0);
      if (shared.length === 0) continue;
      const sourcePerf = perfFor(source.url);
      const relevance = shared.reduce((sum, t) => sum + weight(t), 0);
      // Prefer sources Google already indexes and sends traffic to: their links carry more weight.
      const authority = (indexed.has(source.url) ? 1 : 0) + Math.log1p(sourcePerf?.clicks ?? 0) / 3;
      scored.push({ source: source.url, sourceTitle: source.title, sharedTerms: shared, sourceClicks: sourcePerf?.clicks ?? 0, score: relevance + authority });
    }
    target.suggestions = scored.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source)).slice(0, 5)
      .map(({ score: _score, ...s }) => s);
  }

  return {
    sitemapPages: opts.sitemapUrls.length,
    inventoried: live.length,
    coverage: Math.round(coverage * 1000) / 1000,
    orphansConfirmed: coverage >= 0.9,
    targets,
    weakOrOrphanUrls: candidates.map(c => c.url),
  };
}
