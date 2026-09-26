/**
 * Ranking Playbook detectors (pure functions).
 *
 * Turns a site's Search Console data into ranked opportunities, each with the
 * page to change, the evidence, numbered steps and an ESTIMATED monthly click
 * range. Four priced detectors:
 *
 *   ctr_gap            the snippet earns far fewer clicks than its position
 *                      should (title / meta description rewrite)
 *   striking_distance  queries at positions 4-15 where one more push moves
 *                      the page up (on-page + internal links)
 *   cannibalisation    two pages split the same queries (consolidate or
 *                      differentiate)
 *   content_decay      a page that earned clicks is losing them because its
 *                      ranking slipped (refresh)
 *
 * plus unpriced blockers (not indexed, site-wide decline, Core Web Vitals on
 * traffic pages). Every range is a judgement, not a forecast: closure factors
 * are deliberately conservative and widen when the click-through curve is
 * thin. Time windows: W28 = the 28 complete days ending three days ago, P28
 * and B28 the two 28-day windows before it. Monthly = 28-day figure × 30/28.
 */

import { linkKey, terms, type LinkSuggestion } from './internal-links.js';
import type { QueryPageRow } from './query-page-performance.js';
import type { SnippetEvaluation } from './page-performance.js';

export const MONTHLY = 30 / 28;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Kind = 'ctr_gap' | 'striking_distance' | 'cannibalisation' | 'content_decay';
export type BlockerKind = 'index_blocker' | 'site_wide_decline' | 'vitals';
export type Effort = 'S' | 'M' | 'L';
export type Confidence = 'high' | 'medium' | 'low';

export interface Step { text: string; copy?: string }

export interface Opportunity {
  kind: Kind;
  subtype: string;
  page: string;
  secondaryPage: string | null;
  headline: string;
  steps: Step[];
  evidence: Record<string, unknown>;
  /** Estimated monthly clicks gained, low and high. */
  low: number;
  high: number;
  /** Ranking point: low + 0.35 × (high − low). */
  point: number;
  effort: Effort;
  confidence: Confidence;
  /** Low confidence or under 5 clicks/month: shown only on request. */
  hidden: boolean;
  /** Counts towards the site total (one item per page). */
  counted: boolean;
}

export interface Blocker {
  kind: BlockerKind;
  page: string | null;
  headline: string;
  detail: string;
  /** Monthly clicks at stake, when known. Never added to the upside total. */
  atStake: number | null;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface Window { clicks: number; impressions: number; position: number; days: number }

export interface PageHistory {
  url: string;
  w28: Window;
  p28: Window;
  b28: Window | null;
  /** First and second 14 days of W28. */
  halves: [Window, Window];
  /** Clicks per week inside W28, oldest first. */
  weeks: number[];
  /** Clicks in the first 21 days of W28 (a decline concentrated in the last week is held for a run). */
  first21: number;
}

export interface PageMeta { status: number | null; title: string | null; h1: string | null; words: number; robots: string | null; fetchedAt: string | null }

export interface PageIndex {
  verdict: string | null;
  coverage: string | null;
  indexingState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  contentChangedAt: string | null;
}

export interface PageLinks { inbound: number; suggestions: LinkSuggestion[]; anchorHint: string | null; orphansConfirmed: boolean }

export interface VitalsRow { url: string; rating: 'good' | 'needs_improvement' | 'poor' | null; lcp_ms: number | null; inp_ms: number | null; cls: number | null }

export interface PlaybookInput {
  now: number;
  siteName: string;
  domain: string;
  /** Extra brand terms configured by the user. */
  brandTerms?: string[];
  rows: QueryPageRow[];
  truncated: boolean;
  site: { w28: Window; p28: Window };
  /** Keyed by the page URL as Search Console reports it. */
  pages: Map<string, PageHistory>;
  /** The following maps are keyed by linkKey(url). */
  meta: Map<string, PageMeta>;
  index: Map<string, PageIndex>;
  links: Map<string, PageLinks>;
  snippetChanges: SnippetEvaluation[];
  vitals: VitalsRow[];
  /** Pagination / facet URLs never take part. */
  facetPattern?: RegExp;
}

export interface PlaybookResult {
  opportunities: Opportunity[];
  blockers: Blocker[];
  curve: CtrCurve;
  brandTerms: string[];
  smallSite: boolean;
  /** Counted items, summed. `capped` when the total was limited to 60% of site clicks. */
  summary: { counted: number; low: number; high: number; capped: boolean; siteMonthlyClicks: number };
}

export const DEFAULT_FACET_PATTERN = /[?&]page=|\/page\/\d+|[?&](sort|order|filter|utm_)/i;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Round to two significant figures (ranges are estimates, not forecasts). */
export function sig2(n: number): number {
  if (!Number.isFinite(n) || n === 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(n))) - 1);
  return Math.round(n / mag) * mag;
}

const pathOf = (url: string) => {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
};

const wSum = (a: Window, b: Window): Window => ({
  clicks: a.clicks + b.clicks, impressions: a.impressions + b.impressions,
  position: a.impressions + b.impressions ? (a.position * a.impressions + b.position * b.impressions) / (a.impressions + b.impressions) : 0,
  days: a.days + b.days,
});

const ctrOf = (w: { clicks: number; impressions: number }) => (w.impressions ? w.clicks / w.impressions : 0);

// ── Brand terms ──────────────────────────────────────────────────────────────

const GENERIC = new Set(['shop', 'store', 'blog', 'home', 'online', 'official', 'company', 'group', 'limited', 'ltd', 'inc', 'the', 'and']);

/**
 * Brand terms. Single tokens come only from the domain label and the first
 * word of the site name ("acme" for "Acme Boots"): later words are usually
 * the category ("boots") and must stay searchable. The full site name and
 * the dominant title suffix count as phrases. Brand queries already belong to
 * the site; they distort every CTR comparison.
 */
export function brandTermsFor(siteName: string, domain: string, titles: string[], extra: string[] = []): string[] {
  const out = new Set<string>();
  const host = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  const labels = host.split('.').filter(Boolean);
  // acme.example → acme; acme.co.uk → acme (two-part public suffixes)
  let label = labels.length >= 2 ? labels[labels.length - 2] : labels[0] ?? '';
  if (labels.length >= 3 && label.length <= 3 && labels[labels.length - 1].length === 2) label = labels[labels.length - 3];
  if (label.length >= 3) out.add(label.replace(/-/g, ''));
  const nameTokens = terms(siteName);
  if (nameTokens[0] && nameTokens[0].length >= 4 && !GENERIC.has(nameTokens[0])) out.add(nameTokens[0]);
  if (nameTokens.length >= 2) out.add(nameTokens.join(' '));
  for (const t of extra) { const n = t.trim().toLowerCase(); if (n.length >= 3) out.add(n); }
  // Dominant suffix: "Page title | Acme Boots" on at least 30% of titles.
  const suffixes = new Map<string, number>();
  for (const title of titles) {
    const m = /[|–—-]\s*([^|–—-]{2,40})\s*$/.exec(title ?? '');
    if (m) { const key = terms(m[1]).join(' '); if (key.length >= 4) suffixes.set(key, (suffixes.get(key) ?? 0) + 1); }
  }
  const top = [...suffixes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && titles.length > 0 && top[1] / titles.length >= 0.3) out.add(top[0]);
  return [...out];
}

export function isBrandQuery(query: string, brandTerms: string[]): boolean {
  const q = ` ${query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const compact = q.replace(/\s+/g, '');
  return brandTerms.some(t => q.includes(` ${t} `) || (t.length >= 6 && compact.includes(t.replace(/\s+/g, ''))));
}

// ── CTR curve ────────────────────────────────────────────────────────────────

/** Industry fallback click-through rate for positions 1-10, 11-15 and 16-20. */
export const FALLBACK_CTR = [0.28, 0.15, 0.10, 0.07, 0.055, 0.045, 0.035, 0.030, 0.025, 0.022, 0.012, 0.006];
const BEYOND_20 = 0.004;
const SHRINK_IMPRESSIONS = 500;
const WIDTH: Record<'site' | 'blended' | 'industry', number> = { site: 0.15, blended: 0.30, industry: 0.40 };

export interface CtrCurve {
  /** Shrunk, isotonic CTR per bucket (1..10, 11-15, 16-20). */
  buckets: number[];
  labels: Array<'site' | 'blended' | 'industry'>;
  samples: Array<{ impressions: number; clicks: number }>;
  at(position: number): number;
  /** Relative half-width to apply to a range priced at these positions (impression-weighted). */
  width(positions: Array<{ position: number; impressions: number }>): number;
}

export function bucketIndex(position: number): number {
  if (position <= 10.5) return Math.max(0, Math.round(position) - 1);
  if (position <= 15.5) return 10;
  return 11;
}

/** Pool-adjacent-violators: weighted non-increasing fit. */
function isotonicNonIncreasing(values: number[], weights: number[]): number[] {
  const blocks: Array<{ sum: number; w: number; n: number }> = [];
  for (let i = 0; i < values.length; i++) {
    blocks.push({ sum: values[i] * weights[i], w: weights[i], n: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.w >= last.sum / last.w) break;
      blocks.splice(blocks.length - 2, 2, { sum: prev.sum + last.sum, w: prev.w + last.w, n: prev.n + last.n });
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let i = 0; i < b.n; i++) out.push(b.sum / b.w);
  return out;
}

export function buildCtrCurve(rows: QueryPageRow[], brandTerms: string[]): CtrCurve {
  const samples = FALLBACK_CTR.map(() => ({ impressions: 0, clicks: 0 }));
  const perBucket: QueryPageRow[][] = FALLBACK_CTR.map(() => []);
  for (const r of rows) {
    if (r.impressions < 50 || r.position > 20 || isBrandQuery(r.query, brandTerms)) continue;
    perBucket[bucketIndex(r.position)].push(r);
  }
  perBucket.forEach((list, b) => {
    const total = list.reduce((s, r) => s + r.impressions, 0);
    for (const r of list) {
      // A single row dominating a bucket (one head query) is winsorised.
      const scale = total > 0 && r.impressions > 0.3 * total ? (0.3 * total) / r.impressions : 1;
      samples[b].impressions += r.impressions * scale;
      samples[b].clicks += r.clicks * scale;
    }
  });
  const raw = samples.map((s, b) => (s.clicks + SHRINK_IMPRESSIONS * FALLBACK_CTR[b]) / (s.impressions + SHRINK_IMPRESSIONS));
  const buckets = isotonicNonIncreasing(raw, samples.map(s => s.impressions + SHRINK_IMPRESSIONS));
  const labels = samples.map(s => (s.impressions >= 1000 && s.clicks >= 20 ? 'site' : s.impressions >= 200 ? 'blended' : 'industry') as 'site' | 'blended' | 'industry');
  const at = (position: number): number => {
    if (position <= 1) return buckets[0];
    if (position >= 20) return position >= 30 ? BEYOND_20 : buckets[11] + (BEYOND_20 - buckets[11]) * ((position - 20) / 10);
    const lo = Math.floor(position);
    const hi = Math.ceil(position);
    const vLo = buckets[bucketIndex(lo)];
    const vHi = buckets[bucketIndex(hi)];
    return vLo + (vHi - vLo) * (position - lo);
  };
  const width = (positions: Array<{ position: number; impressions: number }>): number => {
    let w = 0; let total = 0;
    for (const p of positions) { w += WIDTH[labels[bucketIndex(p.position)]] * p.impressions; total += p.impressions; }
    return total ? w / total : WIDTH.industry;
  };
  return { buckets, labels, samples, at, width };
}

// ── Shared scaffolding ───────────────────────────────────────────────────────

interface Ctx {
  input: PlaybookInput;
  curve: CtrCurve;
  brandTerms: string[];
  small: boolean;
  /** rows by page URL (all rows, brand included) */
  byPage: Map<string, QueryPageRow[]>;
  /** total impressions per query across pages */
  queryTotals: Map<string, { impressions: number; clicks: number; pages: QueryPageRow[] }>;
  facet: RegExp;
}

const floor = (ctx: Ctx, n: number) => (ctx.small ? n / 2 : n);
const isNoindex = (meta: PageMeta | undefined) => /(?:^|[\s,])(?:noindex|none)(?:$|[\s,;])/i.test(meta?.robots ?? '');
const notIndexed = (idx: PageIndex | undefined) => !!idx && idx.verdict === 'FAIL';

function finish(o: Omit<Opportunity, 'point' | 'hidden' | 'counted' | 'low' | 'high'> & { low: number; high: number }, width: number, truncated: boolean): Opportunity {
  let confidence = o.confidence;
  if (truncated && o.kind !== 'content_decay') confidence = confidence === 'high' ? 'medium' : 'low';
  const low = sig2(Math.max(0, o.low * (1 - width)));
  const high = sig2(Math.max(low, o.high * (1 + width)));
  return { ...o, confidence, low, high, point: low + 0.35 * (high - low), hidden: confidence === 'low' || high < 5, counted: true };
}

function roundPos(p: number): string { return p.toFixed(1); }
function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }

// ── ctr_gap ──────────────────────────────────────────────────────────────────

function detectCtrGap(ctx: Ctx): Opportunity[] {
  const { input, curve, brandTerms } = ctx;
  const out: Opportunity[] = [];
  const recentSnippetChange = new Set(input.snippetChanges.filter(c => input.now - Date.parse(c.changed_at) < 21 * DAY_MS).map(c => linkKey(c.url)));
  for (const [url, page] of input.pages) {
    const key = linkKey(url);
    if (ctx.facet.test(url) || page.w28.impressions <= 0) continue;
    const meta = input.meta.get(key);
    if (recentSnippetChange.has(key) || isNoindex(meta) || notIndexed(input.index.get(key))) continue;
    if (meta && !meta.title && meta.words < 50) continue; // no snippet to speak of

    const rows = ctx.byPage.get(url) ?? [];
    const nonBrand = rows.filter(r => !isBrandQuery(r.query, brandTerms));
    const brandImpr = rows.reduce((s, r) => s + r.impressions, 0) - nonBrand.reduce((s, r) => s + r.impressions, 0);
    const brandShare = page.w28.impressions ? brandImpr / page.w28.impressions : 0;
    if (brandShare > 0.5) continue;
    const priced = nonBrand.filter(r => r.position <= 10.5);
    const pricedImpr = priced.reduce((s, r) => s + r.impressions, 0);
    const coverage = page.w28.impressions ? rows.reduce((s, r) => s + r.impressions, 0) / page.w28.impressions : 0;

    let E = 0; let O = 0; let path: 'query' | 'scaled' | 'page'; let confidence: Confidence = 'medium'; let threshold = 0.65;
    let pricedPositions: Array<{ position: number; impressions: number }> = priced.map(r => ({ position: r.position, impressions: r.impressions }));
    if (coverage >= 0.4 && pricedImpr >= floor(ctx, 500)) {
      E = priced.reduce((s, r) => s + r.impressions * curve.at(r.position), 0);
      O = priced.reduce((s, r) => s + r.clicks, 0);
      path = 'query';
      if (coverage < 0.6) {
        const nonBrandPageImpr = page.w28.impressions * (1 - brandShare);
        const scale = Math.min(1.5, nonBrandPageImpr / Math.max(1, nonBrand.reduce((s, r) => s + r.impressions, 0)));
        E *= scale; O *= scale; path = 'scaled';
      }
    } else if (page.w28.position <= 8 && page.w28.impressions * (1 - brandShare) >= floor(ctx, 500)) {
      const impr = page.w28.impressions * (1 - brandShare);
      E = impr * curve.at(page.w28.position);
      O = page.w28.clicks * (1 - brandShare);
      path = 'page'; confidence = 'low'; threshold = 0.5;
      pricedPositions = [{ position: page.w28.position, impressions: impr }];
    } else continue;

    const gap = E - O;
    if (E <= 0 || O > threshold * E || gap < 10 || gap / Math.sqrt(E) < 2.5) continue;
    // Persistence: both halves of W28 below expectation, else it is noise.
    const expectedPageCtr = E / Math.max(1, path === 'page' ? page.w28.impressions * (1 - brandShare) : pricedImpr * (path === 'scaled' ? E / Math.max(1, priced.reduce((s, r) => s + r.impressions * curve.at(r.position), 0)) : 1));
    if (!page.halves.every(h => h.impressions === 0 || ctrOf(h) <= 0.8 * expectedPageCtr)) continue;

    const topShare = priced.filter(r => r.position <= 2.5).reduce((s, r) => s + r.impressions * curve.at(r.position) - r.clicks, 0) / Math.max(1, gap);
    if (path !== 'page') {
      confidence = pricedImpr >= 2000 && coverage >= 0.7 && pricedPositions.every(p => curve.labels[bucketIndex(p.position)] !== 'industry') ? 'high'
        : pricedImpr >= 500 ? 'medium' : 'low';
      if (path === 'scaled' && confidence === 'high') confidence = 'medium';
    }
    if (topShare > 0.6) confidence = 'low'; // SERP features at positions 1-2 explain low CTR as often as the snippet does

    const topQueries = [...priced].sort((a, b) => b.impressions - a.impressions).slice(0, 8);
    const expectedCtr = E / Math.max(1, pricedPositions.reduce((s, p) => s + p.impressions, 0));
    const actualCtr = O / Math.max(1, pricedPositions.reduce((s, p) => s + p.impressions, 0));
    out.push(finish({
      kind: 'ctr_gap', subtype: path, page: url, secondaryPage: null,
      headline: `Rewrite the title and description of ${pathOf(url)}: ${pct(actualCtr)} of searches click it, pages at its positions typically get ${pct(expectedCtr)}`,
      steps: [
        { text: `Lead the title with the main query "${topQueries[0]?.query ?? ''}" and a concrete benefit; keep it under 60 characters.`, copy: topQueries[0]?.query },
        { text: 'Write a meta description under 155 characters that answers what the searcher wants and includes the main query.' },
        { text: `Check what the current snippet promises against these queries: ${topQueries.slice(0, 5).map(q => `"${q.query}"`).join(', ')}.` },
        { text: 'Use Draft with AI for a title, description and H1 that use these queries, then review before publishing.' },
      ],
      evidence: {
        path, coverage: Math.round(coverage * 100) / 100, brandShare: Math.round(brandShare * 100) / 100,
        pricedImpressions: Math.round(pricedImpr), expectedClicks28d: Math.round(E), actualClicks28d: Math.round(O),
        expectedCtr: Math.round(expectedCtr * 10000) / 10000, actualCtr: Math.round(actualCtr * 10000) / 10000,
        currentTitle: meta?.title ?? null, currentDescription: null,
        queries: topQueries.map(q => ({ query: q.query, impressions: q.impressions, clicks: q.clicks, position: Math.round(q.position * 10) / 10, expectedCtr: Math.round(curve.at(q.position) * 10000) / 10000 })),
      },
      low: 0.25 * gap * MONTHLY, high: 0.6 * gap * MONTHLY, effort: 'S', confidence,
    }, curve.width(pricedPositions), input.truncated));
  }

  // Regression variant: a title/description change that measurably cut CTR.
  const seen = new Set<string>();
  for (const c of [...input.snippetChanges].sort((a, b) => b.changed_at.localeCompare(a.changed_at))) {
    const key = linkKey(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    if (c.verdict !== 'worse' || c.ctrChangePct === null || c.ctrChangePct > -10 || (c.positionChange ?? 0) > 0.5) continue;
    if (c.before.impressions < 300 || c.after.impressions < 300) continue;
    const gain = (c.before.ctr - c.after.ctr) * c.after.impressions * (28 / Math.max(1, c.after.days));
    out.push(finish({
      kind: 'ctr_gap', subtype: 'regression', page: c.url, secondaryPage: null,
      headline: `Revert the title change on ${pathOf(c.url)}: click-through fell from ${pct(c.before.ctr)} to ${pct(c.after.ctr)} after it changed on ${c.changed_at.slice(0, 10)}`,
      steps: [
        { text: `Restore the previous title: "${c.old_title ?? ''}"`, copy: c.old_title ?? undefined },
        ...(c.old_description !== c.new_description ? [{ text: `Restore the previous description: "${c.old_description ?? ''}"`, copy: c.old_description ?? undefined }] : []),
        { text: 'If the new wording must stay, keep the old title\'s main query at the start and re-measure after 14 days.' },
      ],
      evidence: { changedAt: c.changed_at, oldTitle: c.old_title, newTitle: c.new_title, before: c.before, after: c.after, ctrChangePct: c.ctrChangePct, positionChange: c.positionChange },
      low: 0.5 * gain * MONTHLY, high: 1.0 * gain * MONTHLY, effort: 'S',
      confidence: c.before.impressions >= 1000 && c.after.impressions >= 1000 ? 'high' : 'medium',
    }, 0.1, false));
  }
  return out;
}

// ── striking_distance ────────────────────────────────────────────────────────

function detectStrikingDistance(ctx: Ctx, ctrGapPages: Set<string>): Opportunity[] {
  const { input, curve, brandTerms } = ctx;
  const out: Opportunity[] = [];
  for (const [url, page] of input.pages) {
    const key = linkKey(url);
    if (ctx.facet.test(url)) continue;
    const meta = input.meta.get(key);
    const idx = input.index.get(key);
    if (notIndexed(idx) || isNoindex(meta) || (meta && meta.status !== null && meta.status !== 200)) continue;
    const rows = (ctx.byPage.get(url) ?? []).filter(r => {
      if (isBrandQuery(r.query, brandTerms) || r.position < 3.5 || r.position > 15.5) return false;
      const min = r.position <= 10.5 ? floor(ctx, 100) : floor(ctx, 200);
      if (r.impressions < min) return false;
      const total = ctx.queryTotals.get(r.query);
      return !total || r.impressions >= 0.8 * total.impressions; // else it is cannibalisation's query
    });
    const pricedImpr = rows.reduce((s, r) => s + r.impressions, 0);
    if (rows.length === 0 || pricedImpr < floor(ctx, 300)) continue;

    let low = 0; let high = 0; let pageTwoHigh = 0;
    const priced = rows.map(r => {
      const b = Math.round(r.position);
      const lowQ = 0.5 * r.impressions * Math.max(0, curve.at(b - 1) - curve.at(b));
      const c = b <= 10 ? 0.6 : 0.4;
      const mult = b >= 11 ? 1.2 : 1;
      const highQ = c * mult * r.impressions * Math.max(0, curve.at(Math.max(3, b - 3)) - curve.at(b));
      low += lowQ; high += highQ;
      if (b >= 11) pageTwoHigh += highQ;
      return { query: r.query, impressions: r.impressions, clicks: r.clicks, position: Math.round(r.position * 10) / 10, gainLow: Math.round(lowQ * MONTHLY), gainHigh: Math.round(highQ * MONTHLY) };
    }).sort((a, b) => b.gainHigh - a.gainHigh);
    if (high * MONTHLY < 10) continue;

    const primary = priced[0];
    const fresh = !!meta?.fetchedAt && input.now - Date.parse(meta.fetchedAt) < 14 * DAY_MS;
    const primaryTerms = terms(primary.query);
    const onPage = `${meta?.title ?? ''} ${meta?.h1 ?? ''}`.toLowerCase();
    const missing = fresh ? primaryTerms.filter(t => !onPage.includes(t)) : [];
    const subtype = !fresh ? 'unknown' : missing.length > 0 ? 'on_page_gap' : 'authority_gap';
    const links = input.links.get(key);
    const needsLinks = !!links && links.inbound <= 2;
    const thin = (meta?.words ?? 0) > 0 && (meta?.words ?? 0) < 300;
    const effort: Effort = thin ? 'L' : subtype === 'on_page_gap' ? 'M' : 'S';
    const share11 = high ? pageTwoHigh / high : 0;
    let confidence: Confidence = pricedImpr >= 3000 && rows.length >= 3 && share11 <= 0.3 ? 'high' : pricedImpr >= 1000 ? 'medium' : 'low';
    if (priced.length === 1 && primary.impressions < 500) confidence = 'low';
    if (share11 > 0.7) confidence = 'low';

    const steps: Step[] = [];
    if (ctrGapPages.has(key)) steps.push({ text: 'Rewrite the title and description first (see the snippet item for this page); it compounds every gain below.' });
    if (subtype === 'on_page_gap') steps.push({ text: `Put "${primary.query}" in the title and H1: the page ranks for it at position ${roundPos(primary.position)} without using the words ${missing.map(m => `"${m}"`).join(', ')}.`, copy: primary.query });
    steps.push({ text: `Add a section that directly answers: ${priced.slice(0, 5).map(q => `"${q.query}"`).join(', ')}. Use the query wording in the heading.`, copy: priced.slice(0, 5).map(q => q.query).join('\n') });
    if (thin) steps.push({ text: `The page has about ${meta?.words} words; expand it to cover these queries properly before expecting movement.` });
    if (needsLinks && links) {
      const from = links.suggestions.slice(0, 3);
      steps.push({ text: `Link to it from ${from.length ? from.map(s => pathOf(s.source)).join(', ') : 'related, indexed pages'}${links.anchorHint ? ` using anchor text like "${links.anchorHint}"` : ''} (it has ${links.inbound} internal link${links.inbound === 1 ? '' : 's'}).`, copy: links.anchorHint ?? undefined });
    } else {
      steps.push({ text: 'Add two or three internal links to it from pages that already rank, with the query in the anchor text.' });
    }
    steps.push({ text: 'Re-check in four weeks: the queries below should move up one to three positions.' });

    out.push(finish({
      kind: 'striking_distance', subtype, page: url, secondaryPage: null,
      headline: `Push ${pathOf(url)} up from position ${roundPos(page.w28.position)}: ${priced.length} quer${priced.length === 1 ? 'y' : 'ies'} within striking distance (${Math.round(pricedImpr * MONTHLY).toLocaleString()} searches a month)`,
      steps,
      evidence: { pricedImpressions: Math.round(pricedImpr), queries: priced.slice(0, 15), missingTerms: missing, inbound: links?.inbound ?? null, words: meta?.words ?? null, currentTitle: meta?.title ?? null, currentH1: meta?.h1 ?? null, pageTwoShare: Math.round(share11 * 100) / 100 },
      low: low * MONTHLY, high: high * MONTHLY, effort, confidence,
    }, curve.width(rows.map(r => ({ position: r.position, impressions: r.impressions }))), input.truncated));
  }
  return out;
}

// ── cannibalisation ──────────────────────────────────────────────────────────

function detectCannibalisation(ctx: Ctx): Opportunity[] {
  const { input, curve, brandTerms } = ctx;
  interface Contested { query: string; a: QueryPageRow; b: QueryPageRow; total: number }
  const pairs = new Map<string, Contested[]>();
  for (const [query, total] of ctx.queryTotals) {
    if (isBrandQuery(query, brandTerms) || total.impressions < floor(ctx, 200)) continue;
    const eligible = total.pages
      .filter(r => r.impressions >= 30 && r.impressions >= 0.15 * total.impressions && !ctx.facet.test(r.page))
      .filter(r => { const k = linkKey(r.page); return !isNoindex(input.meta.get(k)) && !notIndexed(input.index.get(k)); })
      .sort((x, y) => y.impressions - x.impressions);
    if (eligible.length < 2) continue;
    const [a, b] = eligible;
    const best = Math.min(a.position, b.position);
    if (best <= 3 || best > 20) continue; // two top-3 results is a double listing, not a problem
    const leaderClicks = Math.max(a.clicks, b.clicks);
    if (total.clicks > 0 && leaderClicks / total.clicks >= 0.7) continue;
    const ka = linkKey(a.page); const kb = linkKey(b.page);
    const canonA = input.index.get(ka)?.googleCanonical; const canonB = input.index.get(kb)?.googleCanonical;
    if ((canonA && linkKey(canonA) === kb) || (canonB && linkKey(canonB) === ka)) continue;
    const pairKey = [ka, kb].sort().join('|');
    const list = pairs.get(pairKey) ?? [];
    list.push({ query, a, b, total: total.impressions });
    pairs.set(pairKey, list);
  }

  const out: Opportunity[] = [];
  for (const shared of pairs.values()) {
    const S = shared.reduce((s, c) => s + Math.max(c.a.impressions, c.b.impressions), 0);
    if (shared.length < 3 && S < floor(ctx, 500)) continue;
    const pageA = shared[0].a.page; const pageB = shared[0].b.page;
    const clicksA = shared.reduce((s, c) => s + (c.a.page === pageA ? c.a.clicks : c.b.clicks), 0);
    const clicksB = shared.reduce((s, c) => s + (c.a.page === pageA ? c.b.clicks : c.a.clicks), 0);
    const posA = shared.reduce((s, c) => s + (c.a.page === pageA ? c.a.position : c.b.position), 0) / shared.length;
    const posB = shared.reduce((s, c) => s + (c.a.page === pageA ? c.b.position : c.a.position), 0) / shared.length;
    const inA = input.links.get(linkKey(pageA))?.inbound ?? 0; const inB = input.links.get(linkKey(pageB))?.inbound ?? 0;
    const aPrimary = clicksA !== clicksB ? clicksA > clicksB : posA !== posB ? posA < posB : inA >= inB;
    const primary = aPrimary ? pageA : pageB; const secondary = aPrimary ? pageB : pageA;
    const secondaryShared = aPrimary ? clicksB : clicksA;
    const secondaryOwn = input.pages.get(secondary)?.w28.clicks ?? secondaryShared;
    const outside = Math.max(0, secondaryOwn - secondaryShared);
    const subtype = secondaryOwn > 0 && outside / secondaryOwn < 0.25 ? 'consolidate' : 'differentiate';

    let low = 0; let high = 0;
    const evidenceQueries = shared.map(c => {
      const sq = Math.max(c.a.impressions, c.b.impressions);
      const cur = c.a.clicks + c.b.clicks;
      const best = Math.min(c.a.position, c.b.position);
      low += Math.max(0, sq * curve.at(best) - cur);
      high += Math.max(0, sq * curve.at(Math.max(1, best - 1)) - cur);
      const p = c.a.page === primary ? c.a : c.b; const s = c.a.page === primary ? c.b : c.a;
      return { query: c.query, impressions: sq, primaryPosition: Math.round(p.position * 10) / 10, primaryClicks: p.clicks, secondaryPosition: Math.round(s.position * 10) / 10, secondaryClicks: s.clicks };
    }).sort((x, y) => y.impressions - x.impressions);
    low *= 0.25; high *= 0.6;
    if (high * MONTHLY < 8) continue;
    const primaryClicks = input.pages.get(primary)?.w28.clicks ?? 0;
    let confidence: Confidence = 'medium';
    if (shared.length >= 5 && S >= 2000) confidence = 'high';
    if ((shared.length < 3 && S < 1000) || primaryClicks < 20 || secondaryOwn < 20) confidence = 'low';
    if (['Duplicate', 'canonical'].some(t => (input.index.get(linkKey(secondary))?.coverage ?? '').includes(t))) confidence = confidence === 'low' ? 'medium' : 'high';

    const p = pathOf(primary); const s = pathOf(secondary);
    const anchor = evidenceQueries[0].query;
    const steps: Step[] = subtype === 'consolidate' ? [
      { text: `Make ${p} the single page for these ${shared.length} queries (${Math.round(S * MONTHLY).toLocaleString()} searches a month).` },
      { text: `Move the sections of ${s} that ${p} lacks into ${p}.` },
      { text: `301-redirect ${s} to ${p} (or set its canonical to ${p} if it must stay live for users).`, copy: primary },
      { text: `Update internal links whose anchor mentions "${anchor}" so they point at ${p}.`, copy: anchor },
    ] : [
      { text: `Both pages are shown for "${anchor}" but serve different intents. Retitle ${s} for its own queries and remove "${anchor}" from its H1.`, copy: anchor },
      { text: `Link from ${s} to ${p} with anchor text like "${anchor}" so Google has one clear owner of these queries.`, copy: anchor },
      { text: `Keep ${p} as the page for: ${evidenceQueries.slice(0, 5).map(q => `"${q.query}"`).join(', ')}.` },
    ];
    out.push(finish({
      kind: 'cannibalisation', subtype, page: primary, secondaryPage: secondary,
      headline: `${subtype === 'consolidate' ? 'Consolidate' : 'Separate'} ${s} and ${p}: both rank for ${shared.length} of the same quer${shared.length === 1 ? 'y' : 'ies'}`,
      steps,
      evidence: { sharedQueries: shared.length, sharedSearches: Math.round(S), primaryClicksShared: aPrimary ? clicksA : clicksB, secondaryClicksShared: secondaryShared, secondaryClicksOutside: outside, primaryInbound: aPrimary ? inA : inB, secondaryInbound: aPrimary ? inB : inA, queries: evidenceQueries.slice(0, 15), primaryTitle: input.meta.get(linkKey(primary))?.title ?? null, secondaryTitle: input.meta.get(linkKey(secondary))?.title ?? null },
      low: low * MONTHLY, high: high * MONTHLY, effort: subtype === 'consolidate' ? 'L' : 'M', confidence,
    }, curve.width(shared.map(c => ({ position: Math.min(c.a.position, c.b.position), impressions: Math.max(c.a.impressions, c.b.impressions) }))), input.truncated));
  }
  return out;
}

// ── content_decay ────────────────────────────────────────────────────────────

function detectContentDecay(ctx: Ctx): { opportunities: Opportunity[]; blockers: Blocker[] } {
  const { input, curve } = ctx;
  const out: Opportunity[] = [];
  const blockers: Blocker[] = [];
  const siteRatio = input.site.p28.clicks > 0 ? input.site.w28.clicks / input.site.p28.clicks : 1;
  const siteWide = input.site.p28.clicks >= 100 && siteRatio <= 0.75;
  if (siteWide) {
    blockers.push({
      kind: 'site_wide_decline', page: null,
      headline: `Site-wide decline: Google clicks fell ${Math.round((1 - siteRatio) * 100)}% against the previous 28 days`,
      detail: `${input.site.w28.clicks.toLocaleString()} clicks in the last 28 days against ${input.site.p28.clicks.toLocaleString()} before. A drop this broad usually points to an algorithm update, a technical change (robots, canonicals, hosting) or lost indexing rather than individual pages. Check Search Console's coverage and manual actions before refreshing pages; page-level decay is only listed where a page fell at least 20 points further than the site.`,
      atStake: Math.round((input.site.p28.clicks - input.site.w28.clicks) * MONTHLY),
    });
  }
  for (const [url, page] of input.pages) {
    const key = linkKey(url);
    if (ctx.facet.test(url) || notIndexed(input.index.get(key))) continue;
    const baseline: Window = page.b28 && page.b28.days >= 20
      ? (page.p28.clicks <= (page.p28.clicks + page.b28.clicks) / 2 ? page.p28 : { ...wSum(page.p28, page.b28), clicks: (page.p28.clicks + page.b28.clicks) / 2, impressions: (page.p28.impressions + page.b28.impressions) / 2, days: Math.min(page.p28.days, page.b28.days) })
      : page.p28;
    if (baseline.clicks < floor(ctx, 50) || baseline.days < 20 || page.w28.days < 20) continue;
    const lost = baseline.clicks - page.w28.clicks;
    const ratio = page.w28.clicks / baseline.clicks;
    if (ratio > 0.7 || lost < 15) continue;
    if ((baseline.clicks - page.w28.clicks) / Math.sqrt(baseline.clicks + page.w28.clicks) < 3) continue;
    if (siteRatio > 0 && ratio / siteRatio > 0.8) continue; // the site moved as a whole
    if (siteWide && ratio > siteRatio - 0.2) continue;
    const weeklyBaseline = baseline.clicks / 4;
    if (page.weeks.filter(w => w <= 0.8 * weeklyBaseline).length < 3) continue; // not sustained
    if (page.first21 >= 0.85 * baseline.clicks * (21 / 28)) continue; // concentrated in the last week: Google restates recent days
    const changedAt = input.index.get(key)?.contentChangedAt;
    if (changedAt && input.now - Date.parse(changedAt) < 21 * DAY_MS) continue; // under observation

    const dPos = page.w28.position - baseline.position;
    const imprRatio = baseline.impressions ? page.w28.impressions / baseline.impressions : 1;
    const ctrDrop = ctrOf(baseline) > 0 ? 1 - ctrOf(page.w28) / ctrOf(baseline) : 0;
    let subtype: 'rank' | 'ctr' | 'demand';
    if (dPos >= 1.5) subtype = 'rank';
    else if (Math.abs(dPos) <= 1 && ctrDrop >= 0.3 && imprRatio >= 0.85) subtype = 'ctr';
    else if (imprRatio <= 0.7) subtype = 'demand';
    else subtype = 'rank';
    const rows = (ctx.byPage.get(url) ?? []).filter(r => !isBrandQuery(r.query, ctx.brandTerms)).sort((a, b) => b.impressions - a.impressions).slice(0, 8);
    const losing = rows.filter(r => r.position > 5);
    const p = pathOf(url);
    const lostMonthly = lost * MONTHLY;
    const steps: Step[] = subtype === 'ctr' ? [
      { text: `Rankings held (position ${roundPos(baseline.position)} → ${roundPos(page.w28.position)}) but click-through fell ${Math.round(ctrDrop * 100)}%: rewrite the title and description before touching the content.` },
      { text: `Check whether a competitor's snippet now answers ${rows[0] ? `"${rows[0].query}"` : 'the main query'} more directly, and match it.`, copy: rows[0]?.query },
    ] : [
      { text: `Refresh ${p}: update facts, dates, prices and screenshots, and show a visible "last updated" date.` },
      { text: `Add sections that answer the queries it is now losing: ${losing.slice(0, 4).map(r => `"${r.query}" (position ${roundPos(r.position)})`).join(', ') || 'see the queries below'}.`, copy: losing.slice(0, 4).map(r => r.query).join('\n') || undefined },
      { text: `Check the title still leads with the main query${input.meta.get(key)?.title ? ` (current: "${input.meta.get(key)!.title}")` : ''}.` },
      { text: 'Add two internal links from pages that gained clicks recently, with the main query in the anchor text.' },
    ];
    const meta = input.meta.get(key);
    const evidence = {
      subtype, baselineClicks: Math.round(baseline.clicks), currentClicks: page.w28.clicks, lostPerMonth: Math.round(lostMonthly),
      baselinePosition: Math.round(baseline.position * 10) / 10, currentPosition: Math.round(page.w28.position * 10) / 10,
      baselineImpressions: Math.round(baseline.impressions), currentImpressions: page.w28.impressions,
      weeks: page.weeks, seasonality: 'unchecked', siteRatio: Math.round(siteRatio * 100) / 100,
      queries: rows.map(r => ({ query: r.query, impressions: r.impressions, clicks: r.clicks, position: Math.round(r.position * 10) / 10 })),
      currentTitle: meta?.title ?? null, contentChangedAt: changedAt ?? null,
    };
    const item = finish({
      kind: 'content_decay', subtype, page: url, secondaryPage: null,
      headline: subtype === 'ctr'
        ? `${p} lost about ${Math.round(sig2(lostMonthly))} clicks a month to a weaker snippet: rankings held, click-through fell`
        : `Refresh ${p}: it lost about ${Math.round(sig2(lostMonthly))} clicks a month as its position slipped from ${roundPos(baseline.position)} to ${roundPos(page.w28.position)}`,
      steps, evidence,
      low: 0.3 * lostMonthly, high: 0.7 * lostMonthly, effort: subtype === 'ctr' ? 'S' : 'M',
      confidence: 'medium', // seasonality unchecked in this version
    }, Math.min(0.2, curve.width(rows.map(r => ({ position: r.position, impressions: r.impressions })))), false);
    if (subtype === 'demand') { item.hidden = true; item.counted = false; item.confidence = 'low'; }
    out.push(item);
  }
  return { opportunities: out, blockers };
}

// ── Blockers (unpriced) ─────────────────────────────────────────────────────

const RECRAWLABLE = /discovered|crawled - currently not indexed|unknown to google/i;

function detectBlockers(ctx: Ctx): Blocker[] {
  const { input } = ctx;
  const out: Blocker[] = [];
  const pageByKey = new Map([...input.pages.keys()].map(u => [linkKey(u), u]));
  for (const [key, idx] of input.index) {
    const url = pageByKey.get(key) ?? key;
    const meta = input.meta.get(key);
    const history = input.pages.get(url);
    const peak = history ? Math.max(history.p28.clicks, history.b28?.clicks ?? 0) : 0;
    const atStake = history && peak >= 10 && history.w28.clicks <= 0.2 * peak ? Math.round(peak * MONTHLY) : null;
    if (idx.verdict === 'FAIL' || (idx.verdict === 'NEUTRAL' && RECRAWLABLE.test(idx.coverage ?? '')) || (meta && meta.status !== null && meta.status >= 400)) {
      const why = meta && meta.status !== null && meta.status >= 400 ? `the page returns HTTP ${meta.status}` : `Google reports "${idx.coverage ?? idx.verdict}"`;
      out.push({
        kind: 'index_blocker', page: url,
        headline: `${pathOf(url)} is not indexed: ${why}`,
        detail: atStake ? `It earned about ${atStake.toLocaleString()} clicks a month before dropping out. Nothing else on this page matters until it is back in the index; see its Action Centre item for the fix.` : 'Sitemap pages that Google cannot index earn nothing. See the page\'s Action Centre item for the specific fix.',
        atStake,
      });
    }
  }
  for (const v of input.vitals) {
    if (!v.rating || v.rating === 'good') continue;
    const history = input.pages.get(v.url);
    if (!history || history.w28.clicks <= 0) continue;
    const failing = [v.lcp_ms !== null && v.lcp_ms > 2500 ? `LCP ${(v.lcp_ms / 1000).toFixed(1)} s` : null, v.inp_ms !== null && v.inp_ms > 200 ? `INP ${Math.round(v.inp_ms)} ms` : null, v.cls !== null && v.cls > 0.1 ? `CLS ${v.cls.toFixed(2)}` : null].filter(Boolean);
    out.push({
      kind: 'vitals', page: v.url,
      headline: `${pathOf(v.url)} fails Core Web Vitals on mobile (${failing.join(', ')})`,
      detail: 'Page experience is a tie-breaker, not a lever: fixing it protects the clicks this page already earns rather than adding new ones. Ranked by clicks at stake.',
      atStake: Math.round(history.w28.clicks * MONTHLY),
    });
  }
  return out.sort((a, b) => (b.atStake ?? 0) - (a.atStake ?? 0));
}

// ── Orchestration ────────────────────────────────────────────────────────────

const ORDER: Record<Effort, number> = { S: 0, M: 1, L: 2 };

export function computeOpportunities(input: PlaybookInput): PlaybookResult {
  const brandTerms = brandTermsFor(input.siteName, input.domain, [...input.meta.values()].map(m => m.title ?? '').filter(Boolean), input.brandTerms ?? []);
  const curve = buildCtrCurve(input.rows, brandTerms);
  const byPage = new Map<string, QueryPageRow[]>();
  const queryTotals = new Map<string, { impressions: number; clicks: number; pages: QueryPageRow[] }>();
  for (const r of input.rows) {
    byPage.set(r.page, [...(byPage.get(r.page) ?? []), r]);
    const t = queryTotals.get(r.query) ?? { impressions: 0, clicks: 0, pages: [] };
    t.impressions += r.impressions; t.clicks += r.clicks; t.pages.push(r);
    queryTotals.set(r.query, t);
  }
  const ctx: Ctx = { input, curve, brandTerms, small: input.site.w28.impressions < 20_000, byPage, queryTotals, facet: input.facetPattern ?? DEFAULT_FACET_PATTERN };

  const ctrGap = detectCtrGap(ctx);
  const ctrGapPages = new Set(ctrGap.map(o => linkKey(o.page)));
  const cannibal = detectCannibalisation(ctx);
  const secondaryPages = new Set(cannibal.map(o => linkKey(o.secondaryPage!)));
  const striking = detectStrikingDistance(ctx, ctrGapPages);
  const decay = detectContentDecay(ctx);
  const blockers = [...decay.blockers, ...detectBlockers(ctx)];
  const blockedPages = new Set(blockers.filter(b => b.kind === 'index_blocker' && b.page).map(b => linkKey(b.page!)));

  let all = [...ctrGap, ...striking, ...cannibal, ...decay.opportunities]
    .filter(o => !blockedPages.has(linkKey(o.page)))
    // A cannibalised secondary page gets no other items: the pair item owns it.
    .filter(o => o.kind === 'cannibalisation' || !secondaryPages.has(linkKey(o.page)));

  // One counted item per page: the highest-scoring kind; others are "also on this page".
  const bestByPage = new Map<string, Opportunity>();
  for (const o of all) {
    const k = linkKey(o.page);
    const cur = bestByPage.get(k);
    if (!cur || o.point > cur.point) bestByPage.set(k, o);
  }
  all = all.map(o => ({ ...o, counted: o.counted && !o.hidden && bestByPage.get(linkKey(o.page)) === o }))
    .sort((a, b) => b.point - a.point || ORDER[a.effort] - ORDER[b.effort] || a.page.localeCompare(b.page));

  const counted = all.filter(o => o.counted);
  const siteMonthlyClicks = input.site.w28.clicks * MONTHLY;
  const rawHigh = counted.reduce((s, o) => s + o.high, 0);
  const cap = 0.6 * siteMonthlyClicks;
  const capped = siteMonthlyClicks > 0 && rawHigh > cap;
  return {
    opportunities: all, blockers, curve, brandTerms, smallSite: ctx.small,
    summary: {
      counted: counted.length,
      low: sig2(Math.min(counted.reduce((s, o) => s + o.low, 0), capped ? cap : Infinity)),
      high: sig2(capped ? cap : rawHigh),
      capped, siteMonthlyClicks: Math.round(siteMonthlyClicks),
    },
  };
}
