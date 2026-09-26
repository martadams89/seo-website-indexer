import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Compute → persist → Action Centre → people's decisions → results, against a
// seeded database. The detectors themselves are covered in playbook-detectors.test.ts.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-playbook-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'playbook-secret-1234567890';

let db: typeof import('../db/database.js');
let playbook: typeof import('../analytics/playbook.js');
let store: typeof import('../platform/store.js');
let users: typeof import('../auth/users.js');
let workspaces: typeof import('../auth/workspaces.js');

beforeAll(async () => {
  db = await import('../db/database.js');
  playbook = await import('../analytics/playbook.js');
  store = await import('../platform/store.js');
  users = await import('../auth/users.js');
  workspaces = await import('../auth/workspaces.js');
});

const NOW = Date.parse('2026-09-26T12:00:00Z');
const DAY = 86400000;
const O = 'https://pb.example';

function seedSite() {
  const user = users.createUser({ email: `pb-${randomUUID()}@x.com`, password: 'password123' });
  const ws = workspaces.bootstrapUserWorkspace(user, false);
  const id = randomUUID();
  db.upsertSite({ id, name: 'Playbook Co', domain: `${id}.example`, sitemap_url: `${O}/sitemap.xml`, gsc_url: `${O}/`, enabled: 1, workspace_id: ws.id });
  return { site: db.getSiteById(id)!, ws };
}

/** Daily page rows for the 84 days before the data lag, with per-window click levels. */
function seedDaily(siteId: string, page: string, levels: { w28: number; p28: number; b28: number }, impressions = 120, position = 6) {
  const insert = db.getDb().prepare('INSERT OR REPLACE INTO perf_page_daily(site_id, day, page, clicks, impressions, position) VALUES(?,?,?,?,?,?)');
  for (let d = 3; d < 87; d++) {
    const level = d < 31 ? levels.w28 : d < 59 ? levels.p28 : levels.b28;
    insert.run(siteId, new Date(NOW - d * DAY).toISOString().slice(0, 10), `${O}${page}`, level, impressions, position);
  }
}

function seedQueryRows(siteId: string, rows: Array<[string, string, number, number, number]>) {
  const insert = db.getDb().prepare('INSERT OR REPLACE INTO perf_query_page(site_id, query, page, clicks, impressions, position) VALUES(?,?,?,?,?,?)');
  for (const [q, p, c, i, pos] of rows) insert.run(siteId, q, `${O}${p}`, c, i, pos);
  db.getDb().prepare('INSERT OR REPLACE INTO perf_query_page_sync(site_id, identity, checked_at, success_at, error, truncated, period_start, period_end, row_count) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(siteId, 'id', new Date(NOW).toISOString(), new Date(NOW).toISOString(), null, 0, '2026-08-27', '2026-09-23', rows.length);
}

describe('computePlaybook', () => {
  it('persists opportunities, raises capped work items, keeps decisions across recomputes and measures results', () => {
    const { site, ws } = seedSite();
    // A snippet problem (many impressions, few clicks at page one), a striking-distance page and a decaying page.
    seedDaily(site.id, '/boots', { w28: 1, p28: 1, b28: 1 }, 150, 4.5);
    seedQueryRows(site.id, [
      ['waterproof boots', '/boots', 8, 1500, 4.2], ['best hiking boots', '/boots', 6, 1200, 5.0], ['boots for winter', '/boots', 4, 900, 6.1],
      ['hiking socks', '/socks', 20, 1500, 7.2], ['merino socks', '/socks', 8, 900, 9.4],
    ]);
    seedDaily(site.id, '/socks', { w28: 3, p28: 3, b28: 3 }, 100, 8);
    seedDaily(site.id, '/repair', { w28: 2, p28: 7, b28: 7 }, 90, 9);
    for (const p of ['/boots', '/socks', '/repair']) {
      db.getDb().prepare('INSERT INTO page_inventory(site_id, url, status, title, meta_description, h1, robots, words, links, fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(site.id, `${O}${p}`, 200, `${p.slice(1)} | Playbook Co`, null, p.slice(1), null, 700, '[]', new Date(NOW).toISOString());
    }

    const first = playbook.computePlaybook(site, NOW)!;
    expect(first.summary.counted).toBeGreaterThanOrEqual(2);
    expect(first.raised).toBeLessThanOrEqual(3);
    const kinds = new Set(playbook.listOpportunities(site.id).map(o => o.kind));
    expect(kinds).toEqual(new Set(['ctr_gap', 'striking_distance', 'content_decay']));
    const items = store.listWorkItems(ws.id).filter(i => i.source === 'playbook');
    expect(items.length).toBe(first.raised);
    expect(items[0].deep_link).toMatch(/\/insights\/playbook\?site=/);

    // Dismiss the decay item; recompute keeps it dismissed and does not re-raise it.
    const decay = playbook.listOpportunities(site.id).find(o => o.kind === 'content_decay')!;
    playbook.setOpportunityStatus(site, decay.id, 'dismissed', NOW);
    const second = playbook.computePlaybook(site, NOW + DAY)!;
    expect(playbook.getOpportunity(site.id, decay.id)?.status).toBe('dismissed');
    expect(second.raised).toBe(0); // nothing new: every counted item already has an item or is dismissed
    expect(playbook.getOpportunity(site.id, decay.id)?.first_seen).toBe(new Date(NOW).toISOString());

    // A person finishes the /boots item in the Action Centre → the opportunity is done with a baseline, and gets measured after 31 days.
    const snippet = playbook.listOpportunities(site.id).find(o => o.page === `${O}/boots` && o.work_item_id)!;
    expect(snippet.kind).toBe('striking_distance'); // it outranks the page's snippet item, which is "also on this page"
    expect(playbook.listOpportunities(site.id).find(o => o.kind === 'ctr_gap')?.counted).toBe(0);
    const item = items.find(i => i.evidence.opportunity_id === snippet.id)!;
    store.updateWorkItem(ws.id, item.id, { status: 'done' });
    playbook.computePlaybook(site, NOW + 2 * DAY);
    const done = playbook.getOpportunity(site.id, snippet.id)!;
    expect(done.status).toBe('done');
    expect(done.baseline_clicks).toBe(27); // the window has moved two days past the seeded rows
    expect(playbook.playbookResults(site, NOW + 3 * DAY)[0]).toMatchObject({ id: snippet.id, status: 'measuring' });
    // Clicks double after the change while the rest of the site holds: the realised gain is site-adjusted.
    const future = db.getDb().prepare('INSERT OR REPLACE INTO perf_page_daily(site_id, day, page, clicks, impressions, position) VALUES(?,?,?,?,?,?)');
    for (let d = 9; d <= 37; d++) {
      const day = new Date(NOW + d * DAY).toISOString().slice(0, 10);
      future.run(site.id, day, `${O}/boots`, 2, 150, 3.5);
      future.run(site.id, day, `${O}/socks`, 3, 100, 8);
      future.run(site.id, day, `${O}/repair`, 2, 90, 9);
    }
    const measured = playbook.playbookResults(site, NOW + 40 * DAY);
    expect(measured[0].status).toBe('measured');
    expect(measured[0].realised).toBeGreaterThan(0);

    // The striking-distance signal disappears → resolved, and its work item auto-closes.
    db.getDb().prepare('DELETE FROM perf_query_page WHERE site_id = ? AND page = ?').run(site.id, `${O}/socks`);
    playbook.computePlaybook(site, NOW + 41 * DAY);
    const striking = playbook.listOpportunities(site.id, { status: ['resolved'] }).find(o => o.kind === 'striking_distance');
    expect(striking).toBeTruthy();
    const closed = store.listWorkItems(ws.id, { status: 'done', includeSnoozed: true }).find(i => i.evidence.opportunity_id === striking!.id);
    expect(closed?.evidence.auto_resolved_at).toBeTruthy();

    const view = playbook.getPlaybook(site.id, NOW + 41 * DAY)!;
    expect(view.data.searchConsoleDays).toBe(84 + 29);
    expect(view.summary?.brandTerms).toContain('playbook');
    expect(view.opportunities.every(o => o.status !== 'resolved')).toBe(true);
  });

  it('returns null without Search Console history and never throws on an empty site', () => {
    const { site } = seedSite();
    expect(playbook.computePlaybook(site, NOW)).toBeNull();
    expect(playbook.getPlaybook(site.id, NOW)?.computedAt).toBeNull();
  });
});
