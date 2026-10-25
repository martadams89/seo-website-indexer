import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Period comparison (pure parts) and content groups end to end: rules,
// group performance from retained page history, and the MCP tools.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-groups-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'groups-test-secret-1234567890';

// Loaded after DATA_DIR is set: these modules open the database on import.
let comparisonRange: typeof import('../analytics/compare.js')['comparisonRange'];
let diffRows: typeof import('../analytics/compare.js')['diffRows'];
let inGroup: typeof import('../analytics/content-groups.js')['inGroup'];
let normalizeRules: typeof import('../analytics/content-groups.js')['normalizeRules'];
let ruleMatches: typeof import('../analytics/content-groups.js')['ruleMatches'];
beforeAll(async () => {
  ({ comparisonRange, diffRows } = await import('../analytics/compare.js'));
  ({ inGroup, normalizeRules, ruleMatches } = await import('../analytics/content-groups.js'));
});

describe('period comparison', () => {
  it('picks the previous period of the same length, or the same dates last year', () => {
    expect(comparisonRange('2026-10-01', '2026-10-28', 'previous')).toEqual({ start: '2026-09-03', end: '2026-09-30' });
    expect(comparisonRange('2026-10-01', '2026-10-28', 'year')).toEqual({ start: '2025-10-01', end: '2025-10-28' });
  });

  it('joins rows, flags new and lost keys, and ranks by click change', () => {
    const rows = diffRows(
      [{ keys: ['boiler repair'], clicks: 50, impressions: 900, ctr: 0.055, position: 4.2 }, { keys: ['damp survey'], clicks: 12, impressions: 300, ctr: 0.04, position: 8 }],
      [{ keys: ['boiler repair'], clicks: 20, impressions: 700, ctr: 0.028, position: 7.5 }, { keys: ['mould removal'], clicks: 30, impressions: 400, ctr: 0.075, position: 3 }],
    );
    // Equal click swings are ordered by the larger impression swing.
    expect(rows.map(r => [r.key, r.click_change, r.status])).toEqual([
      ['mould removal', -30, 'lost'], ['boiler repair', 30, 'both'], ['damp survey', 12, 'new'],
    ]);
    expect(rows[1].position_change).toBe(-3.3);
    expect(rows[1].current.ctr).toBe(5.5);
    expect(rows[0].position_change).toBeNull();
  });
});

describe('content group rules', () => {
  it('matches paths, full URLs, exact pages and regular expressions', () => {
    expect(ruleMatches({ match: 'prefix', value: '/blog/' }, 'https://acme.example/blog/damp-guide')).toBe(true);
    expect(ruleMatches({ match: 'prefix', value: '/blog/' }, 'https://acme.example/services/blog/')).toBe(false);
    expect(ruleMatches({ match: 'contains', value: 'leeds' }, 'https://acme.example/areas/Leeds/')).toBe(true);
    expect(ruleMatches({ match: 'exact', value: '/contact' }, 'https://acme.example/contact/')).toBe(true);
    expect(ruleMatches({ match: 'regex', value: '/(damp|mould)-' }, 'https://acme.example/damp-proofing')).toBe(true);
    expect(inGroup({ include: [{ match: 'prefix', value: '/blog/' }], exclude: [{ match: 'contains', value: 'tag' }] }, 'https://acme.example/blog/tag/news')).toBe(false);
  });

  it('rejects broken regular expressions and drops empty rules', () => {
    expect(() => normalizeRules([{ match: 'regex', value: '(' }])).toThrow(/Invalid regular expression/);
    expect(normalizeRules([{ match: 'prefix', value: ' ' }, { match: 'nope', value: 'x' }])).toEqual([{ match: 'contains', value: 'x' }]);
  });
});

describe('content groups over MCP', () => {
  type Mods = {
    db: typeof import('../db/database.js'); users: typeof import('../auth/users.js'); ws: typeof import('../auth/workspaces.js');
    tokens: typeof import('../mcp/tokens.js'); tools: typeof import('../mcp/tools.js');
  };
  let m: Mods;
  let siteId = '';
  let ctx: ReturnType<Mods['tools']['buildContext']>;

  beforeAll(async () => {
    m = {
      db: await import('../db/database.js'), users: await import('../auth/users.js'), ws: await import('../auth/workspaces.js'),
      tokens: await import('../mcp/tokens.js'), tools: await import('../mcp/tools.js'),
    };
    const user = m.users.createUser({ email: `owner-${randomUUID()}@x.com`, password: 'password123' });
    const workspace = m.ws.bootstrapUserWorkspace(user, false);
    siteId = `site-${randomUUID().slice(0, 8)}`;
    m.db.upsertSite({ id: siteId, name: 'Weatherwise', domain: `${siteId}.example`, sitemap_url: 'https://acme.example/sitemap.xml', gsc_url: 'sc-domain:acme.example', enabled: 1, workspace_id: workspace.id });
    const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const insert = m.db.getDb().prepare('INSERT INTO perf_page_daily(site_id, day, page, clicks, impressions, position) VALUES(?,?,?,?,?,?)');
    // 10 days in the current 28-day window, 10 in the one before.
    for (let i = 0; i < 10; i++) {
      insert.run(siteId, day(5 + i), 'https://acme.example/blog/damp-guide', 6, 100, 5);
      insert.run(siteId, day(35 + i), 'https://acme.example/blog/damp-guide', 3, 80, 8);
      insert.run(siteId, day(5 + i), 'https://acme.example/services/damp-proofing', 4, 50, 3);
      insert.run(siteId, day(5 + i), 'https://acme.example/contact', 1, 10, 2);
    }
    ctx = m.tools.buildContext(m.tokens.authenticateMcpToken(m.tokens.createMcpToken({ userId: user.id, name: 't', scopes: ['mcp:write'] }).token)!)!;
  });

  it('saves groups, reports each one against the previous period, and keeps the rest as ungrouped', async () => {
    await m.tools.runTool(ctx!, 'save_content_group', { siteId, name: 'Blog', include: [{ match: 'prefix', value: '/blog/' }] });
    await m.tools.runTool(ctx!, 'save_content_group', { siteId, name: 'Services', include: [{ match: 'prefix', value: '/services/' }] });
    const result = await m.tools.runTool(ctx!, 'list_content_groups', { siteId, days: 28 }) as {
      groups: Array<{ name: string; pages: number; current: { clicks: number; position: number }; previous: { clicks: number }; clicks_change_pct: number | null; top_pages: Array<{ page: string }> }>;
      ungrouped: { current: { clicks: number } };
    };
    const blog = result.groups.find(g => g.name === 'Blog')!;
    expect(blog.current.clicks).toBe(60);
    expect(blog.previous.clicks).toBe(30);
    expect(blog.clicks_change_pct).toBe(100);
    expect(blog.current.position).toBe(5);
    expect(result.groups.find(g => g.name === 'Services')!.current.clicks).toBe(40);
    expect(result.ungrouped.current.clicks).toBe(10);
  });

  it('updates a group saved again under the same name, and deletes it', async () => {
    const updated = await m.tools.runTool(ctx!, 'save_content_group', { siteId, name: 'Blog', include: [{ match: 'contains', value: 'damp' }] }) as { id: string; include: unknown[] };
    expect(updated.include).toEqual([{ match: 'contains', value: 'damp' }]);
    expect((await m.tools.runTool(ctx!, 'list_content_groups', { siteId }) as { groups: unknown[] }).groups).toHaveLength(2);
    await m.tools.runTool(ctx!, 'delete_content_group', { siteId, groupId: updated.id });
    expect((await m.tools.runTool(ctx!, 'list_content_groups', { siteId }) as { groups: unknown[] }).groups).toHaveLength(1);
  });

  it('tracks and untracks keywords', async () => {
    await m.tools.runTool(ctx!, 'track_query', { siteId, query: 'damp proofing leeds' });
    expect((await m.tools.runTool(ctx!, 'list_tracked_queries', { siteId }) as { tracked: Array<{ query: string }> }).tracked.map(t => t.query)).toEqual(['damp proofing leeds']);
    await m.tools.runTool(ctx!, 'track_query', { siteId, query: 'Damp Proofing Leeds', track: false });
    expect((await m.tools.runTool(ctx!, 'list_tracked_queries', { siteId }) as { tracked: unknown[] }).tracked).toEqual([]);
  });
});
