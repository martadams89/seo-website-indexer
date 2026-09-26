/**
 * Ranking Playbook: compute, persist and act.
 *
 * Feeds the pure detectors from the site's stored Search Console windows,
 * page inventory, URL Inspection results, internal-link map and page vitals;
 * keeps one row per opportunity across nightly recomputes (so a person's
 * dismiss / done survives); raises a capped number of Action Centre items;
 * and measures what happened 31 days after an item was done.
 */
import { createHash } from 'crypto';
import { getDb, getUrlsBySite, getSiteById, type Site } from '../db/database.js';
import { analyseInternalLinks, listInventory, linkKey } from './internal-links.js';
import { pagePerformance, listSnippetChanges } from './page-performance.js';
import { listPageVitals } from './page-vitals.js';
import { queryPageRows, getQueryPageSync, syncQueryPagePerformance, type QueryPageSync } from './query-page-performance.js';
import { isRecrawlable } from '../indexer/google-indexing.js';
import { cruxConfigured } from '../ai/crux.js';
import {
  computeOpportunities, MONTHLY, sig2,
  type Opportunity, type Blocker, type PageHistory, type PlaybookInput, type Window, type Kind, type Effort, type Confidence, type Step,
} from './playbook-detectors.js';
import { createWorkItem, getWorkItem, updateWorkItem, resolveWorkItemsBySourceRef, getOpenWorkItemRefs, countOpenWorkItems, listWorkItems } from '../platform/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATA_LAG_DAYS = 3;
const MAX_NEW_WORK_ITEMS_PER_RUN = 3;
const MAX_OPEN_WORK_ITEMS_PER_SITE = 8;
const MEASURE_AFTER_DAYS = 31;

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ── Page history from perf_page_daily ───────────────────────────────────────

interface DailyRow { day: string; page: string; clicks: number; impressions: number; position: number }

function window(rows: DailyRow[]): Window {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const position = impressions ? rows.reduce((s, r) => s + r.position * r.impressions, 0) / impressions : 0;
  return { clicks, impressions, position, days: new Set(rows.map(r => r.day)).size };
}

/** W28 / P28 / B28 windows, halves, weekly clicks and the first 21 days for every page. */
export function pageHistories(siteId: string, now: number): { pages: Map<string, PageHistory>; site: { w28: Window; p28: Window } } {
  const end = now - DATA_LAG_DAYS * DAY_MS;              // exclusive
  const w28From = end - 28 * DAY_MS;
  const p28From = w28From - 28 * DAY_MS;
  const b28From = p28From - 28 * DAY_MS;
  const rows = getDb().prepare('SELECT day, page, clicks, impressions, position FROM perf_page_daily WHERE site_id = ? AND day >= ? AND day < ?')
    .all(siteId, ymd(b28From), ymd(end)) as DailyRow[];
  const byPage = new Map<string, DailyRow[]>();
  for (const r of rows) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r]);
  const pages = new Map<string, PageHistory>();
  const siteW28: DailyRow[] = []; const siteP28: DailyRow[] = [];
  for (const [page, list] of byPage) {
    const w = list.filter(r => r.day >= ymd(w28From));
    const p = list.filter(r => r.day >= ymd(p28From) && r.day < ymd(w28From));
    const b = list.filter(r => r.day >= ymd(b28From) && r.day < ymd(p28From));
    siteW28.push(...w); siteP28.push(...p);
    const mid = ymd(w28From + 14 * DAY_MS);
    const weeks = [0, 1, 2, 3].map(i => w.filter(r => r.day >= ymd(w28From + i * 7 * DAY_MS) && r.day < ymd(w28From + (i + 1) * 7 * DAY_MS)).reduce((s, r) => s + r.clicks, 0));
    pages.set(page, {
      url: page, w28: window(w), p28: window(p), b28: b.length ? window(b) : null,
      halves: [window(w.filter(r => r.day < mid)), window(w.filter(r => r.day >= mid))],
      weeks, first21: w.filter(r => r.day < ymd(w28From + 21 * DAY_MS)).reduce((s, r) => s + r.clicks, 0),
    });
  }
  return { pages, site: { w28: window(siteW28), p28: window(siteP28) } };
}

// ── Input assembly ───────────────────────────────────────────────────────────

export function buildPlaybookInput(site: Site, now: number = Date.now()): PlaybookInput & { sync: QueryPageSync | null } {
  const { pages, site: totals } = pageHistories(site.id, now);
  const sync = getQueryPageSync(site.id);
  const rows = queryPageRows(site.id);
  const meta = new Map(listInventory(site.id).map(p => [linkKey(p.url), { status: p.status, title: p.title, h1: p.h1, words: p.words, robots: p.robots, fetchedAt: p.fetched_at }]));
  const states = getUrlsBySite(site.id).filter(s => s.indexnow_only !== 1);
  const index = new Map(states.filter(s => s.gsc_verdict || s.content_changed_at).map(s => [linkKey(s.url), {
    verdict: s.gsc_verdict ?? null, coverage: s.gsc_coverage_state ?? null, indexingState: s.gsc_indexing_state ?? null,
    pageFetchState: s.gsc_page_fetch_state ?? null, googleCanonical: s.gsc_google_canonical ?? null, contentChangedAt: s.content_changed_at ?? null,
  }]));
  // Not-indexed pages are only blockers when a recrawl could plausibly help; structural exclusions are handled elsewhere.
  for (const [key, idx] of index) {
    if (idx.verdict === 'NEUTRAL' && !isRecrawlable({ gsc_indexing_state: idx.indexingState, gsc_coverage_state: idx.coverage, gsc_page_fetch_state: idx.pageFetchState })) {
      index.set(key, { ...idx, verdict: 'NEUTRAL', coverage: null });
    }
  }
  const report = analyseInternalLinks({
    sitemapUrls: states.map(s => s.url), pages: listInventory(site.id), perf: pagePerformance(site.id, 28, now),
    indexed: new Set(states.filter(s => s.gsc_verdict === 'PASS').map(s => s.url)),
    maxTargets: 500,
  });
  const links = new Map(report.targets.map(t => [linkKey(t.url), { inbound: t.inbound, suggestions: t.suggestions, anchorHint: t.anchorHint, orphansConfirmed: report.orphansConfirmed }]));
  return {
    now, siteName: site.name, domain: site.domain, rows, truncated: !!sync?.truncated, site: totals, pages, meta, index, links,
    snippetChanges: listSnippetChanges(site.id, 200, now),
    vitals: listPageVitals(site.id).map(v => ({ url: v.url, rating: v.rating, lcp_ms: v.lcp_ms, inp_ms: v.inp_ms, cls: v.cls })),
    sync,
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

export interface StoredOpportunity {
  id: string; site_id: string; kind: Kind; subtype: string | null; page: string; secondary_page: string | null;
  headline: string; steps: Step[]; evidence: Record<string, unknown>; low: number; high: number; point: number;
  effort: Effort; confidence: Confidence; counted: number; hidden: number; status: 'open' | 'dismissed' | 'done' | 'resolved';
  changed: number; dismissed_high: number | null; first_seen: string; last_seen: string; computed_at: string;
  work_item_id: string | null; draft: Record<string, unknown> | null; draft_at: string | null; done_at: string | null;
  baseline_clicks: number | null; baseline_site_clicks: number | null;
}

type Row = Omit<StoredOpportunity, 'steps' | 'evidence' | 'draft'> & { steps: string; evidence: string; draft: string | null };

const hydrate = (r: Row): StoredOpportunity => ({
  ...r, steps: JSON.parse(r.steps) as Step[], evidence: JSON.parse(r.evidence) as Record<string, unknown>, draft: r.draft ? JSON.parse(r.draft) as Record<string, unknown> : null,
});

export function opportunityId(siteId: string, o: Pick<Opportunity, 'kind' | 'page' | 'secondaryPage'>): string {
  return createHash('sha1').update(`${siteId}|${o.kind}|${linkKey(o.page)}|${o.secondaryPage ? linkKey(o.secondaryPage) : ''}`).digest('hex').slice(0, 24);
}

export function getOpportunity(siteId: string, id: string): StoredOpportunity | null {
  const row = getDb().prepare('SELECT * FROM playbook_opportunities WHERE site_id = ? AND id = ?').get(siteId, id) as Row | undefined;
  return row ? hydrate(row) : null;
}

export function listOpportunities(siteId: string, opts: { status?: string[]; limit?: number } = {}): StoredOpportunity[] {
  const statuses = opts.status ?? ['open', 'dismissed', 'done'];
  return (getDb().prepare(`SELECT * FROM playbook_opportunities WHERE site_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY point DESC, page LIMIT ?`)
    .all(siteId, ...statuses, opts.limit ?? 500) as Row[]).map(hydrate);
}

export interface PlaybookSummary {
  counted: number; low: number; high: number; capped: boolean; siteMonthlyClicks: number;
  blockers: number; smallSite: boolean; curveLabels: string[]; brandTerms: string[];
  quickWins: { count: number; low: number; high: number };
  kinds: Record<string, number>;
  computedAt: string;
}

export function getPlaybookRun(siteId: string): { computed_at: string; summary: PlaybookSummary; notified_at: string | null } | null {
  const row = getDb().prepare('SELECT * FROM playbook_runs WHERE site_id = ?').get(siteId) as { computed_at: string; summary: string; notified_at: string | null } | undefined;
  return row ? { ...row, summary: JSON.parse(row.summary) as PlaybookSummary } : null;
}

/** Persist a computed result: upsert seen items, resolve unseen open ones, keep people's decisions. */
function persist(site: Site, result: ReturnType<typeof computeOpportunities>, now: number): { fresh: StoredOpportunity[]; resolvedRefs: string[] } {
  const db = getDb();
  const at = new Date(now).toISOString();
  const existing = new Map((db.prepare('SELECT * FROM playbook_opportunities WHERE site_id = ?').all(site.id) as Row[]).map(r => [r.id, hydrate(r)]));
  const seen = new Set<string>();
  const upsert = db.prepare(`
    INSERT INTO playbook_opportunities(id, site_id, kind, subtype, page, secondary_page, headline, steps, evidence, low, high, point, effort, confidence, counted, hidden, status, changed, dismissed_high, first_seen, last_seen, computed_at)
    VALUES(@id, @site_id, @kind, @subtype, @page, @secondary_page, @headline, @steps, @evidence, @low, @high, @point, @effort, @confidence, @counted, @hidden, @status, @changed, @dismissed_high, @first_seen, @last_seen, @computed_at)
    ON CONFLICT(id) DO UPDATE SET subtype=excluded.subtype, page=excluded.page, secondary_page=excluded.secondary_page, headline=excluded.headline, steps=excluded.steps,
      evidence=excluded.evidence, low=excluded.low, high=excluded.high, point=excluded.point, effort=excluded.effort, confidence=excluded.confidence,
      counted=excluded.counted, hidden=excluded.hidden, status=excluded.status, changed=excluded.changed, last_seen=excluded.last_seen, computed_at=excluded.computed_at
  `);
  const fresh: StoredOpportunity[] = [];
  db.transaction(() => {
    for (const o of result.opportunities) {
      const id = opportunityId(site.id, o);
      if (seen.has(id)) continue;
      seen.add(id);
      const prev = existing.get(id);
      // People's decisions survive: dismissed stays dismissed (flagged when the upside doubles), done stays done until measured; resolved reopens.
      let status: StoredOpportunity['status'] = 'open';
      let changed = 0;
      if (prev?.status === 'dismissed') { status = 'dismissed'; changed = prev.dismissed_high !== null && o.high >= 2 * prev.dismissed_high + 50 ? 1 : prev.changed; }
      else if (prev?.status === 'done') status = 'done';
      upsert.run({
        id, site_id: site.id, kind: o.kind, subtype: o.subtype, page: o.page, secondary_page: o.secondaryPage, headline: o.headline,
        steps: JSON.stringify(o.steps), evidence: JSON.stringify(o.evidence), low: o.low, high: o.high, point: o.point, effort: o.effort,
        confidence: o.confidence, counted: o.counted ? 1 : 0, hidden: o.hidden ? 1 : 0, status, changed, dismissed_high: prev?.dismissed_high ?? null,
        first_seen: prev?.first_seen ?? at, last_seen: at, computed_at: at,
      });
      if (!prev || prev.status === 'resolved') fresh.push(getOpportunity(site.id, id)!);
    }
    // Open items that no longer trigger are resolved (kept for the record); their work items close.
    db.prepare(`UPDATE playbook_opportunities SET status = 'resolved', computed_at = ? WHERE site_id = ? AND status = 'open' AND last_seen < ?`).run(at, site.id, at);
    db.prepare(`DELETE FROM playbook_opportunities WHERE site_id = ? AND status = 'resolved' AND last_seen < ?`).run(site.id, ymd(now - 120 * DAY_MS));
  })();
  const resolvedRefs = [...existing.values()].filter(p => p.status === 'open' && !seen.has(p.id)).map(p => workItemRef(site, p));
  return { fresh, resolvedRefs };
}

const workItemRef = (site: Site, o: Pick<StoredOpportunity, 'kind' | 'page'>) => `${site.id}:${o.kind}:${o.page}`;

const KIND_LABEL: Record<Kind, string> = { ctr_gap: 'Snippet', striking_distance: 'Striking distance', cannibalisation: 'Cannibalisation', content_decay: 'Content decay' };
const EFFORT_LABEL: Record<Effort, string> = { S: 'about an hour', M: 'about half a day', L: 'a day or more' };

function workItemFor(site: Site, o: StoredOpportunity, extra: Record<string, unknown> = {}) {
  return createWorkItem({
    workspaceId: site.workspace_id!, siteId: site.id, source: 'playbook', sourceRef: workItemRef(site, o),
    title: o.headline,
    description: `${KIND_LABEL[o.kind]} · estimated +${Math.round(o.low)}–${Math.round(o.high)} clicks a month · ${EFFORT_LABEL[o.effort]}\n\n${o.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}`,
    severity: o.high >= 100 ? 'high' : 'medium',
    evidence: { url: o.page, kind: o.kind, subtype: o.subtype, low: o.low, high: o.high, confidence: o.confidence, effort: o.effort, opportunity_id: o.id, ...o.evidence, ...extra },
    deepLink: `/insights/playbook?site=${encodeURIComponent(site.id)}&opportunity=${o.id}`,
  });
}

/** Raise a few new Action Centre items per run, close the ones that resolved, and pick up items people finished. */
function syncWorkItems(site: Site, now: number, resolvedRefs: string[]): { raised: number } {
  if (!site.workspace_id) return { raised: 0 };
  const ws = site.workspace_id;
  const db = getDb();
  if (resolvedRefs.length) resolveWorkItemsBySourceRef(ws, 'playbook', resolvedRefs);

  // Finished by a person (auto-closes carry evidence.auto_resolved_at): mark done and capture the baseline.
  for (const item of listWorkItems(ws, { status: 'done', includeSnoozed: true, limit: 500 })) {
    if (item.source !== 'playbook' || item.site_id !== site.id || item.evidence.auto_resolved_at) continue;
    const id = String(item.evidence.opportunity_id ?? '');
    const o = id ? getOpportunity(site.id, id) : null;
    if (o && o.status === 'open') markDone(site, o, now, item.resolved_at ?? undefined);
  }

  const open = new Set(getOpenWorkItemRefs(ws, site.id, 'playbook'));
  let raised = 0;
  for (const o of listOpportunities(site.id, { status: ['open'] })) {
    if (raised >= MAX_NEW_WORK_ITEMS_PER_RUN || countOpenWorkItems(ws, site.id, 'playbook') >= MAX_OPEN_WORK_ITEMS_PER_SITE) break;
    if (!o.counted || o.hidden || open.has(workItemRef(site, o))) continue;
    const item = workItemFor(site, o);
    db.prepare('UPDATE playbook_opportunities SET work_item_id = ? WHERE id = ?').run(item.id, o.id);
    open.add(workItemRef(site, o));
    raised++;
  }
  return { raised };
}

// ── Compute ──────────────────────────────────────────────────────────────────

export interface ComputeOutcome { summary: PlaybookSummary; blockers: Blocker[]; raised: number; fresh: number }

/**
 * Recompute a site's playbook from stored data (no network). Returns null when
 * the site has no Search Console page history yet.
 */
export function computePlaybook(site: Site, now: number = Date.now()): ComputeOutcome | null {
  const input = buildPlaybookInput(site, now);
  if (input.pages.size === 0) return null;
  const result = computeOpportunities(input);
  const { fresh, resolvedRefs } = persist(site, result, now);
  const { raised } = syncWorkItems(site, now, resolvedRefs);
  const stored = listOpportunities(site.id, { status: ['open'] });
  const quick = stored.filter(o => o.counted && !o.hidden && o.effort === 'S').slice(0, 20);
  const kinds: Record<string, number> = {};
  for (const o of stored) if (o.counted && !o.hidden) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
  const summary: PlaybookSummary = {
    ...result.summary, blockers: result.blockers.length, smallSite: result.smallSite,
    curveLabels: result.curve.labels, brandTerms: result.brandTerms,
    quickWins: { count: quick.length, low: sig2(quick.reduce((s, o) => s + o.low, 0)), high: sig2(quick.reduce((s, o) => s + o.high, 0)) },
    kinds, computedAt: new Date(now).toISOString(),
  };
  getDb().prepare(`
    INSERT INTO playbook_runs(site_id, computed_at, summary) VALUES(?,?,?)
    ON CONFLICT(site_id) DO UPDATE SET computed_at = excluded.computed_at, summary = excluded.summary
  `).run(site.id, summary.computedAt, JSON.stringify({ ...summary, blockerList: result.blockers }));
  return { summary, blockers: result.blockers, raised, fresh: fresh.length };
}

/** Force a fresh query×page window, then recompute. */
export async function refreshPlaybook(site: Site, now: number = Date.now()): Promise<ComputeOutcome | null> {
  await syncQueryPagePerformance(site, { now, force: true });
  return computePlaybook(site, now);
}

// ── People's actions ─────────────────────────────────────────────────────────

export function markDone(site: Site, o: StoredOpportunity, now: number, doneAt?: string): StoredOpportunity {
  const { pages, site: totals } = pageHistories(site.id, now);
  const page = pages.get(o.page);
  getDb().prepare(`UPDATE playbook_opportunities SET status = 'done', done_at = ?, baseline_clicks = ?, baseline_site_clicks = ? WHERE id = ?`)
    .run(doneAt ?? new Date(now).toISOString(), page?.w28.clicks ?? 0, totals.w28.clicks, o.id);
  return getOpportunity(site.id, o.id)!;
}

export function setOpportunityStatus(site: Site, id: string, status: 'open' | 'dismissed' | 'done', now: number = Date.now()): StoredOpportunity | null {
  const o = getOpportunity(site.id, id);
  if (!o) return null;
  if (status === 'done') {
    const done = markDone(site, o, now);
    if (site.workspace_id && o.work_item_id) {
      const item = getWorkItem(site.workspace_id, o.work_item_id);
      if (item && !['done', 'dismissed'].includes(item.status)) updateWorkItem(site.workspace_id, item.id, { status: 'done' });
    }
    return done;
  }
  if (status === 'dismissed') {
    getDb().prepare(`UPDATE playbook_opportunities SET status = 'dismissed', dismissed_high = ?, changed = 0 WHERE id = ?`).run(o.high, id);
    if (site.workspace_id) resolveWorkItemsBySourceRef(site.workspace_id, 'playbook', [workItemRef(site, o)]);
  } else {
    getDb().prepare(`UPDATE playbook_opportunities SET status = 'open', changed = 0, done_at = NULL, baseline_clicks = NULL, baseline_site_clicks = NULL WHERE id = ?`).run(id);
  }
  return getOpportunity(site.id, id);
}

/** Create (or reuse) the Action Centre item for an opportunity, attaching the AI draft when there is one. */
export function sendToWork(site: Site, id: string): StoredOpportunity | null {
  const o = getOpportunity(site.id, id);
  if (!o || !site.workspace_id) return null;
  const item = workItemFor(site, o, o.draft ? { draft: o.draft } : {});
  if (o.draft && !item.evidence.draft) updateWorkItem(site.workspace_id, item.id, { evidence: { draft: o.draft } });
  getDb().prepare('UPDATE playbook_opportunities SET work_item_id = ? WHERE id = ?').run(item.id, id);
  return getOpportunity(site.id, id);
}

export function saveDraft(siteId: string, id: string, draft: Record<string, unknown>, now: number = Date.now()): void {
  getDb().prepare('UPDATE playbook_opportunities SET draft = ?, draft_at = ? WHERE site_id = ? AND id = ?').run(JSON.stringify(draft), new Date(now).toISOString(), siteId, id);
}

// ── Results (what happened after "done") ─────────────────────────────────────

export interface Result {
  id: string; kind: Kind; page: string; headline: string; doneAt: string; low: number; high: number;
  status: 'measuring' | 'measured'; readyOn: string;
  /** Monthly clicks gained versus a site-adjusted baseline; null while measuring. */
  realised: number | null; withinRange: boolean | null;
}

export function playbookResults(site: Site, now: number = Date.now()): Result[] {
  const done = listOpportunities(site.id, { status: ['done'] }).filter(o => o.done_at);
  if (done.length === 0) return [];
  const { pages, site: totals } = pageHistories(site.id, now);
  return done.map(o => {
    const doneAt = Date.parse(o.done_at!);
    const ready = doneAt + (MEASURE_AFTER_DAYS + DATA_LAG_DAYS) * DAY_MS;
    const base: Result = { id: o.id, kind: o.kind, page: o.page, headline: o.headline, doneAt: o.done_at!, low: o.low, high: o.high, status: 'measuring', readyOn: ymd(ready), realised: null, withinRange: null };
    if (now < ready || o.baseline_clicks === null) return base;
    const page = pages.get(o.page);
    // Site-adjusted: what the page would have done had it moved with the rest of the site.
    const siteFactor = o.baseline_site_clicks ? totals.w28.clicks / o.baseline_site_clicks : 1;
    const expected = o.baseline_clicks * Math.min(2, Math.max(0.5, siteFactor));
    const realised = sig2(((page?.w28.clicks ?? 0) - expected) * MONTHLY);
    return { ...base, status: 'measured' as const, realised, withinRange: realised >= o.low };
  }).sort((a, b) => b.doneAt.localeCompare(a.doneAt));
}

// ── Read model for the API ───────────────────────────────────────────────────

export interface DataReadiness {
  searchConsoleDays: number;
  queryRows: number; querySync: QueryPageSync | null; inventoryCoverage: number; inspected: number; sitemapPages: number; cruxConfigured: boolean;
}

export function dataReadiness(site: Site, now: number = Date.now()): DataReadiness {
  const days = (getDb().prepare('SELECT COUNT(DISTINCT day) n FROM perf_page_daily WHERE site_id = ?').get(site.id) as { n: number }).n;
  const states = getUrlsBySite(site.id).filter(s => s.indexnow_only !== 1);
  const inventory = (getDb().prepare('SELECT COUNT(*) n FROM page_inventory WHERE site_id = ? AND status = 200').get(site.id) as { n: number }).n;
  const sync = getQueryPageSync(site.id);
  return {
    searchConsoleDays: days, queryRows: sync?.row_count ?? 0, querySync: sync,
    inventoryCoverage: states.length ? Math.min(1, inventory / states.length) : 0,
    inspected: states.filter(s => s.gsc_verdict).length, sitemapPages: states.length,
    cruxConfigured: cruxConfigured(site.workspace_id ?? null),
  };
}

export function getPlaybook(siteId: string, now: number = Date.now()) {
  const site = getSiteById(siteId);
  if (!site) return null;
  const run = getPlaybookRun(siteId);
  const summary = run ? (getDb().prepare('SELECT summary FROM playbook_runs WHERE site_id = ?').get(siteId) as { summary: string }) : null;
  const parsed = summary ? JSON.parse(summary.summary) as PlaybookSummary & { blockerList?: Blocker[] } : null;
  return {
    site: { id: site.id, name: site.name, domain: site.domain, googleConnected: !!site.google_account_id },
    computedAt: run?.computed_at ?? null,
    summary: parsed ? { ...parsed, blockerList: undefined } : null,
    blockers: parsed?.blockerList ?? [],
    opportunities: listOpportunities(siteId, { status: ['open', 'dismissed'] }),
    results: playbookResults(site, now),
    data: dataReadiness(site, now),
    methodology: 'Estimates are monthly Google clicks gained if the change works, shown as a range from conservative to optimistic closure of the measured gap; they are judgements from Search Console data, not forecasts. Windows are 28 complete days ending three days ago. Brand queries are excluded. Query-level rows undercount because Google anonymises low-volume queries.',
  };
}
