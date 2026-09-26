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

beforeAll(async () => {
  db = await import('../db/database.js');
  scheduler = await import('../scheduler.js');
  users = await import('../auth/users.js');
  workspaces = await import('../auth/workspaces.js');
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
};

function mockNetwork(pages: Array<[string, string]>) {
  const calls = { sitemapSubmits: [] as string[], published: [] as string[], inspected: [] as string[] };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === SITEMAP) return new Response(sitemapXml(pages), { status: 200 });
    if (url.startsWith('https://www.googleapis.com/webmasters/v3/sites/') && init?.method === 'PUT') {
      calls.sitemapSubmits.push(decodeURIComponent(url.split('/sitemaps/')[1]));
      return new Response(null, { status: 204 });
    }
    if (url.includes('urlInspection/index:inspect')) {
      const target = JSON.parse(String(init?.body)).inspectionUrl as string;
      calls.inspected.push(target);
      const r = INSPECTION[new URL(target).pathname];
      return Response.json({ inspectionResult: { indexStatusResult: { indexingState: 'INDEXING_ALLOWED', pageFetchState: 'SUCCESSFUL', ...r } } });
    }
    if (url.startsWith('https://indexing.googleapis.com/')) {
      calls.published.push(JSON.parse(String(init?.body)).url);
      return Response.json({ urlNotificationMetadata: {} });
    }
    if (url.startsWith('https://api.indexnow.org/')) return new Response(null, { status: 200 });
    if (url.startsWith(ORIGIN) && !url.endsWith('.txt')) return new Response('<html><body>page</body></html>', { status: 200 });
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
    ];

    // Run 1: first sitemap submission; inspection finds one unindexed page and
    // one changed after its last crawl.
    let calls = mockNetwork(pages);
    await runAndWait(ws.id, siteId);
    expect(calls.sitemapSubmits).toEqual([SITEMAP]);
    expect(calls.inspected).toHaveLength(4);
    expect(calls.published).toEqual([`${ORIGIN}/discovered`, `${ORIGIN}/changed`]);
    expect(db.getUrlState(`${ORIGIN}/discovered`, siteId)?.gsc_coverage_state).toBe('Discovered - currently not indexed');
    expect(db.getQuotaUsage('google_indexing', 'project:123456789')).toBe(2);

    // Run 2: nothing changed — no sitemap resubmission, no repeat notifications.
    calls = mockNetwork(pages);
    await runAndWait(ws.id, siteId);
    expect(calls.sitemapSubmits).toEqual([]);
    expect(calls.published).toEqual([]);

    // Run 3: a lastmod changes, so the sitemap is re-submitted.
    pages[2] = ['/fresh', '2026-09-26T00:00:00Z'];
    calls = mockNetwork(pages);
    await runAndWait(ws.id, siteId);
    expect(calls.sitemapSubmits).toEqual([SITEMAP]);

    // A plain edit that omits the opt-in keeps it.
    const site = db.getSiteById(siteId)!;
    const { google_indexing_api: _omit, created_at: _created, ...rest } = site;
    db.upsertSite({ ...rest, name: 'Renamed' });
    expect(db.getSiteById(siteId)?.google_indexing_api).toBe(1);
  }, 30_000);
});
