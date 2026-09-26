import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// End-to-end scheduler run with Google, IndexNow and the site mocked: a sitemap
// is re-submitted through the Sitemaps API only when its URL/lastmod set
// changes, and Indexing API quota goes only to pages URL Inspection reports as
// not indexed or changed after Google's last crawl — once per change.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-recrawl-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'recrawl-run-secret-1234567890';

let db: typeof import('../db/database.js');
let scheduler: typeof import('../scheduler.js');
let users: typeof import('../auth/users.js');
let workspaces: typeof import('../auth/workspaces.js');
let store: typeof import('../platform/store.js');

beforeAll(async () => {
  db = await import('../db/database.js');
  scheduler = await import('../scheduler.js');
  users = await import('../auth/users.js');
  workspaces = await import('../auth/workspaces.js');
  store = await import('../platform/store.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ORIGIN = 'https://recrawl.example';
const SITEMAP = `${ORIGIN}/sitemap.xml`;

function sitemapXml(pages: Array<[string, string]>): string {
  return `<?xml version="1.0"?><urlset>${pages.map(([p, lastmod]) => `<url><loc>${ORIGIN}${p}</loc><lastmod>${lastmod}</lastmod></url>`).join('')}</urlset>`;
}

// URL Inspection results keyed by path.
const INSPECTION: Record<string, Record<string, string>> = {
  '/changed': { verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-09-10T00:00:00Z' },
  '/discovered': { verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed' },
  '/fresh': { verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-09-25T00:00:00Z' },
  '/noindex': { verdict: 'NEUTRAL', coverageState: "Excluded by 'noindex' tag", indexingState: 'BLOCKED_BY_META_TAG' },
  '/dupe': {
    verdict: 'NEUTRAL', coverageState: 'Duplicate, Google chose different canonical than user',
    googleCanonical: 'https://recrawl.example/changed', userCanonical: 'https://recrawl.example/dupe',
  },
};
let sitemapErrors = 2;
const TITLES: Record<string, string> = {};
const GONE = new Set<string>();

function mockNetwork(pages: Array<[string, string]>) {
  const calls = { sitemapSubmits: [] as string[], published: [] as string[], inspected: [] as string[], deleted: [] as string[], indexNow: [] as string[] };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === SITEMAP) return new Response(sitemapXml(pages), { status: 200 });
    if (url.startsWith('https://www.googleapis.com/webmasters/v3/sites/') && init?.method === 'PUT') {
      calls.sitemapSubmits.push(decodeURIComponent(url.split('/sitemaps/')[1]));
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('https://www.googleapis.com/webmasters/v3/sites/') && url.endsWith('/sitemaps')) {
      return Response.json({ sitemap: [{ path: SITEMAP, lastDownloaded: '2026-09-25T00:00:00Z', errors: String(sitemapErrors), warnings: '0' }] });
    }
    if (url.includes('urlInspection/index:inspect')) {
      const target = JSON.parse(String(init?.body)).inspectionUrl as string;
      calls.inspected.push(target);
      const r = INSPECTION[new URL(target).pathname];
      return Response.json({ inspectionResult: { indexStatusResult: { indexingState: 'INDEXING_ALLOWED', pageFetchState: 'SUCCESSFUL', ...r } } });
    }
    if (url.startsWith('https://indexing.googleapis.com/')) {
      const body = JSON.parse(String(init?.body)) as { url: string; type: string };
      (body.type === 'URL_DELETED' ? calls.deleted : calls.published).push(body.url);
      return Response.json({ urlNotificationMetadata: {} });
    }
    if (url.startsWith('https://api.indexnow.org/')) {
      calls.indexNow.push(...(JSON.parse(String(init?.body)).urlList as string[]));
      return new Response(null, { status: 200 });
    }
    if (url.startsWith(ORIGIN) && GONE.has(new URL(url).pathname)) return new Response(null, { status: 410 });
    if (url.startsWith(ORIGIN) && !url.endsWith('.txt')) {
      const p = new URL(url).pathname;
      return new Response(`<html><head><title>${TITLES[p] ?? p}</title></head><body><h1>${p}</h1><p>page</p></body></html>`, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

async function runAndWait(workspaceId: string, siteId: string) {
  await scheduler.runIndexing({ trigger: 'manual', workspaceId, siteIds: [siteId], skipBing: true });
  for (let i = 0; i < 400 && scheduler.isRunning(workspaceId); i++) await new Promise(r => setTimeout(r, 25));
  expect(scheduler.isRunning(workspaceId)).toBe(false);
}

describe('Google recrawl signals in a scheduler run', () => {
  it('re-submits changed sitemaps and targets Indexing API quota', async () => {
    const user = users.createUser({ email: `recrawl-${randomUUID()}@x.com`, password: 'password123' });
    const ws = workspaces.bootstrapUserWorkspace(user, false);
    const accountId = `${randomUUID().slice(0, 8)}@example.com`;
    db.upsertGoogleAccount({
      id: accountId, email: accountId, client_id: '123456789-abc.apps.googleusercontent.com', client_secret: 'shh',
      access_token: 'fresh-token', refresh_token: 'rt', token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
      workspace_id: ws.id, owner_user_id: user.id,
      granted_scopes: 'https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/indexing',
    });
    const siteId = randomUUID();
    db.upsertSite({
      id: siteId, name: 'Recrawl', domain: 'recrawl.example', sitemap_url: SITEMAP, gsc_url: `${ORIGIN}/`,
      enabled: 1, workspace_id: ws.id, google_account_id: accountId, google_indexing_api: 1,
    });

    const pages: Array<[string, string]> = [
      ['/changed', '2026-09-20T00:00:00Z'],
      ['/discovered', '2026-09-15T00:00:00Z'],
      ['/fresh', '2026-09-01T00:00:00Z'],
      ['/noindex', '2026-09-01T00:00:00Z'],
      ['/dupe', '2026-09-01T00:00:00Z'],
    ];
    const openItems = () => store.listWorkItems(ws.id).filter(i => i.status === 'open' && i.site_id === siteId);

    // Run 1: first sitemap submission; inspection finds one unindexed page and
    // one changed after its last crawl.
    let calls = mockNetwork(pages);
    await runAndWait(ws.id, siteId);
    expect(calls.sitemapSubmits).toEqual([SITEMAP]);
    expect(calls.inspected).toHaveLength(5);
    expect(calls.published).toEqual([`${ORIGIN}/discovered`, `${ORIGIN}/changed`]);
    expect(db.getUrlState(`${ORIGIN}/discovered`, siteId)?.gsc_coverage_state).toBe('Discovered - currently not indexed');
    expect(db.getQuotaUsage('google_indexing', 'project:123456789')).toBe(2);

    // Inspection and sitemap problems land in the Action Centre.
    const raised = openItems().filter(i => i.source.startsWith('gsc_')).map(i => `${i.source}:${i.evidence.code ?? ''}:${i.page_url ?? ''}`).sort();
    expect(raised).toEqual([
      'gsc_inspection:blocked:https://recrawl.example/noindex',
      'gsc_inspection:canonical_mismatch:https://recrawl.example/dupe',
      'gsc_sitemap::',
    ]);
    expect(db.getSitemapStatesForSite(siteId)[0]).toMatchObject({ gsc_errors: 2, gsc_last_downloaded: '2026-09-25T00:00:00Z' });
    // No page links to any other, and every page is mapped: all are orphans.
    expect(openItems().filter(i => i.source === 'internal_links')).toHaveLength(5);

    // Run 2: nothing changed — no sitemap resubmission, no repeat notifications.
    // Google now accepts the canonical and the sitemap errors are fixed, so
    // those items close themselves.
    INSPECTION['/dupe'] = { verdict: 'PASS', coverageState: 'Submitted and indexed', googleCanonical: `${ORIGIN}/dupe`, userCanonical: `${ORIGIN}/dupe` };
    sitemapErrors = 0;
    calls = mockNetwork(pages);
    await runAndWait(ws.id, siteId);
    expect(calls.sitemapSubmits).toEqual([]);
    expect(calls.published).toEqual([]);
    expect(openItems().filter(i => i.source.startsWith('gsc_')).map(i => i.evidence.code)).toEqual(['blocked']);

    // Run 3: a lastmod and its title change, and /dupe is retired (410), so
    // the sitemap is re-submitted, the title change is recorded, and removal
    // notices go to IndexNow and the Indexing API.
    pages[2] = ['/fresh', '2026-09-26T00:00:00Z'];
    TITLES['/fresh'] = 'Fresh: a better title';
    pages.splice(4, 1);
    GONE.add('/dupe');
    calls = mockNetwork(pages);
    await runAndWait(ws.id, siteId);
    expect(calls.sitemapSubmits).toEqual([SITEMAP]);
    expect(calls.indexNow).toContain(`${ORIGIN}/dupe`);
    expect(calls.deleted).toEqual([`${ORIGIN}/dupe`]);
    const snippet = db.getDb().prepare('SELECT * FROM page_snippet_changes WHERE site_id = ?').all(siteId) as Array<{ url: string; old_title: string; new_title: string }>;
    expect(snippet).toEqual([expect.objectContaining({ url: `${ORIGIN}/fresh`, old_title: '/fresh', new_title: 'Fresh: a better title' })]);
    expect(db.getDb().prepare('SELECT COUNT(*) n FROM page_inventory WHERE site_id = ?').get(siteId)).toEqual({ n: 4 });

    // A plain edit that omits the opt-in keeps it.
    const site = db.getSiteById(siteId)!;
    const { google_indexing_api: _omit, created_at: _created, ...rest } = site;
    db.upsertSite({ ...rest, name: 'Renamed' });
    expect(db.getSiteById(siteId)?.google_indexing_api).toBe(1);
  }, 30_000);
});
