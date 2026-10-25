/**
 * analytics/content-groups.ts — group a site's pages by URL rules (blog,
 * services, locations…) and report each group's Search Console clicks,
 * impressions, CTR and position against the period before. Built on the
 * retained page-level history (perf_page_daily), so it needs no extra
 * Search Console calls.
 */
import { randomUUID } from 'crypto';
import { getDb } from '../db/database.js';

export type RuleMatch = 'prefix' | 'contains' | 'exact' | 'regex';
export interface GroupRule { match: RuleMatch; value: string }

export interface ContentGroup {
  id: string;
  site_id: string;
  name: string;
  /** A page is in the group when it matches any include rule and no exclude rule. */
  include: GroupRule[];
  exclude: GroupRule[];
  created_at: string;
  updated_at: string;
}

const MATCHES: RuleMatch[] = ['prefix', 'contains', 'exact', 'regex'];

export function normalizeRules(raw: unknown): GroupRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap(r => {
    const rule = (r && typeof r === 'object' ? r : {}) as { match?: unknown; value?: unknown };
    const match = MATCHES.includes(rule.match as RuleMatch) ? rule.match as RuleMatch : 'contains';
    const value = String(rule.value ?? '').trim().slice(0, 300);
    if (!value) return [];
    if (match === 'regex') { try { new RegExp(value, 'i'); } catch { throw Object.assign(new Error(`Invalid regular expression: ${value}`), { statusCode: 400 }); } }
    return [{ match, value }];
  });
}

/** Paths ("/blog/") compare against the URL path; anything else against the full URL. Case-insensitive. */
export function ruleMatches(rule: GroupRule, url: string): boolean {
  let target = url.toLowerCase();
  const value = rule.value.toLowerCase();
  if (rule.match !== 'regex' && value.startsWith('/')) {
    try { target = new URL(url).pathname.toLowerCase(); } catch { /* keep the raw string */ }
  }
  switch (rule.match) {
    case 'prefix': return target.startsWith(value);
    case 'exact': return target.replace(/\/+$/, '') === value.replace(/\/+$/, '');
    case 'regex': try { return new RegExp(rule.value, 'i').test(url); } catch { return false; }
    default: return target.includes(value);
  }
}

export function inGroup(group: Pick<ContentGroup, 'include' | 'exclude'>, url: string): boolean {
  return group.include.some(r => ruleMatches(r, url)) && !group.exclude.some(r => ruleMatches(r, url));
}

type Row = Omit<ContentGroup, 'include' | 'exclude'> & { include_rules: string; exclude_rules: string };
const parse = (s: string): GroupRule[] => { try { return JSON.parse(s) as GroupRule[]; } catch { return []; } };
const toGroup = (r: Row): ContentGroup => ({ id: r.id, site_id: r.site_id, name: r.name, include: parse(r.include_rules), exclude: parse(r.exclude_rules), created_at: r.created_at, updated_at: r.updated_at });

export function listContentGroups(siteId: string): ContentGroup[] {
  return (getDb().prepare('SELECT * FROM content_groups WHERE site_id=? ORDER BY name').all(siteId) as Row[]).map(toGroup);
}

export function getContentGroup(siteId: string, id: string): ContentGroup | null {
  const row = getDb().prepare('SELECT * FROM content_groups WHERE site_id=? AND id=?').get(siteId, id) as Row | undefined;
  return row ? toGroup(row) : null;
}

/** Create, or update when `id` is given (or a group with the same name exists). */
export function saveContentGroup(siteId: string, input: { id?: string; name: string; include: unknown; exclude?: unknown; userId?: string | null }): ContentGroup {
  const name = String(input.name ?? '').trim().slice(0, 100);
  if (!name) throw Object.assign(new Error('Give the group a name.'), { statusCode: 400 });
  const include = normalizeRules(input.include);
  if (!include.length) throw Object.assign(new Error('Add at least one rule that pages must match.'), { statusCode: 400 });
  const exclude = normalizeRules(input.exclude);
  const db = getDb();
  const byName = db.prepare('SELECT * FROM content_groups WHERE site_id=? AND name=?').get(siteId, name) as Row | undefined;
  const existing = input.id ? getContentGroup(siteId, input.id) : byName ? toGroup(byName) : null;
  if (input.id && !existing) throw Object.assign(new Error('Content group not found.'), { statusCode: 404 });
  if (existing) {
    db.prepare("UPDATE content_groups SET name=?, include_rules=?, exclude_rules=?, updated_at=datetime('now') WHERE id=?").run(name, JSON.stringify(include), JSON.stringify(exclude), existing.id);
    return getContentGroup(siteId, existing.id)!;
  }
  const id = randomUUID();
  db.prepare('INSERT INTO content_groups(id, site_id, name, include_rules, exclude_rules, created_by) VALUES(?,?,?,?,?,?)').run(id, siteId, name, JSON.stringify(include), JSON.stringify(exclude), input.userId ?? null);
  return getContentGroup(siteId, id)!;
}

export function deleteContentGroup(siteId: string, id: string): boolean {
  return getDb().prepare('DELETE FROM content_groups WHERE site_id=? AND id=?').run(siteId, id).changes > 0;
}

interface Totals { clicks: number; impressions: number; ctr: number; position: number }
interface Acc { clicks: number; impressions: number; weighted: number }
const finish = (a: Acc): Totals => ({
  clicks: a.clicks, impressions: a.impressions,
  ctr: a.impressions ? Math.round((a.clicks / a.impressions) * 10_000) / 100 : 0,
  position: a.impressions ? Math.round((a.weighted / a.impressions) * 10) / 10 : 0,
});

/**
 * Each group's totals for the last `days` complete days vs the `days` before,
 * plus its top pages and an "Ungrouped" bucket. Search Console lags about
 * three days, so the window ends three days ago.
 */
export function contentGroupPerformance(siteId: string, days = 28, now = Date.now()) {
  const span = Math.max(1, Math.min(240, Math.round(days)));
  const DAY = 86_400_000;
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const end = now - 3 * DAY;
  const curFrom = ymd(end - (span - 1) * DAY);
  const prevFrom = ymd(end - (2 * span - 1) * DAY);
  const to = ymd(end + DAY);
  const rows = getDb().prepare(`SELECT page, day >= ? AS current, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position*impressions) weighted
    FROM perf_page_daily WHERE site_id=? AND day >= ? AND day < ? GROUP BY page, current`).all(curFrom, siteId, prevFrom, to) as Array<{ page: string; current: number; clicks: number; impressions: number; weighted: number }>;
  const groups = listContentGroups(siteId);
  const blank = (): Acc => ({ clicks: 0, impressions: 0, weighted: 0 });
  const buckets = new Map<string, { cur: Acc; prev: Acc; pages: Map<string, Acc>; pageCount: Set<string> }>();
  for (const g of [...groups.map(g => g.id), '__ungrouped']) buckets.set(g, { cur: blank(), prev: blank(), pages: new Map(), pageCount: new Set() });
  const add = (a: Acc, r: { clicks: number; impressions: number; weighted: number }) => { a.clicks += r.clicks; a.impressions += r.impressions; a.weighted += r.weighted ?? 0; };
  for (const r of rows) {
    const ids = groups.filter(g => inGroup(g, r.page)).map(g => g.id);
    for (const id of ids.length ? ids : ['__ungrouped']) {
      const b = buckets.get(id)!;
      b.pageCount.add(r.page);
      if (r.current) {
        add(b.cur, r);
        const p = b.pages.get(r.page) ?? blank();
        add(p, r);
        b.pages.set(r.page, p);
      } else add(b.prev, r);
    }
  }
  const pct = (a: number, b: number) => b ? Math.round(((a - b) / b) * 1000) / 10 : null;
  const present = (id: string, name: string, group: ContentGroup | null) => {
    const b = buckets.get(id)!;
    const current = finish(b.cur); const previous = finish(b.prev);
    return {
      id: group?.id ?? null, name, include: group?.include ?? [], exclude: group?.exclude ?? [], pages: b.pageCount.size,
      current, previous, clicks_change_pct: pct(current.clicks, previous.clicks), impressions_change_pct: pct(current.impressions, previous.impressions),
      position_change: current.impressions && previous.impressions ? Math.round((current.position - previous.position) * 10) / 10 : null,
      top_pages: [...b.pages.entries()].map(([page, a]) => ({ page, ...finish(a) })).sort((x, y) => y.clicks - x.clicks).slice(0, 10),
    };
  };
  return {
    period: { start: curFrom, end: ymd(end), days: span }, compared_with: { start: prevFrom, end: ymd(end - span * DAY) },
    groups: groups.map(g => present(g.id, g.name, g)),
    ungrouped: present('__ungrouped', 'Ungrouped pages', null),
    has_history: rows.length > 0,
  };
}
