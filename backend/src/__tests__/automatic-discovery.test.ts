import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { getDb, getSiteById, upsertSite, setWorkspaceSetting, type Site } from '../db/database.js';
import { createUser } from '../auth/users.js';
import { bootstrapUserWorkspace, bingCredentialForSite } from '../auth/workspaces.js';
import { safeFetch } from '../security/outbound-url.js';
import { gscQuery } from '../indexer/performance.js';
import { getAccessTokenForAccount } from '../auth/google-oauth.js';
import { loadSearchOpportunities } from '../platform/search-sync.js';
import { searchOpportunities } from '../platform/search-opportunities.js';
import { discoverLinks, parseSearchFeed } from '../platform/link-discovery.js';
import {
  parsePlaySearch,
  parsePlayListing,
  searchStore,
  fetchStoreListing,
} from '../platform/app-store-search.js';
import { listBacklinks, backlinkHistory } from '../platform/backlinks.js';
import {
  listCrawlCandidates,
  importCrawlCandidates,
  reviewCrawlCandidate,
} from '../platform/crawl-candidates.js';
vi.hoisted(() => {
  process.env.DATA_DIR = process.getBuiltinModule('node:fs').mkdtempSync('/tmp/automatic-discovery-');
  process.env.APP_SECRET = 'auto-test-secret';
});
vi.mock('../security/outbound-url.js', async (original) => ({
  ...(await original<typeof import('../security/outbound-url.js')>()),
  safeFetch: vi.fn(),
}));
vi.mock('../indexer/performance.js', () => ({ gscQuery: vi.fn() }));
vi.mock('../auth/google-oauth.js', () => ({ getAccessTokenForAccount: vi.fn() }));
vi.mock('../auth/workspaces.js', async (original) => ({
  ...(await original<typeof import('../auth/workspaces.js')>()),
  bingCredentialForSite: vi.fn(async () => null),
}));
let ws: string, other: string;
let n = 0;
const site = () => getSiteById('auto-site')!;
const newWorkspace = () =>
  bootstrapUserWorkspace(createUser({ email: `auto-${++n}@example.com`, password: 'testing12345' }), false)
    .id;
const html = (value: string) => new Response(value, { headers: { 'content-type': 'text/html' } });
const feed = (...urls: string[]) =>
  `<rss><channel>${urls.map((url) => `<item><link>${url}</link></item>`).join('')}</channel></rss>`;
beforeAll(() => {
  ws = newWorkspace();
  other = newWorkspace();
  upsertSite({
    id: 'auto-site',
    workspace_id: ws,
    name: 'Example',
    domain: 'example.com',
    gsc_url: 'sc-domain:example.com',
    sitemap_url: 'https://example.com/sitemap.xml',
    enabled: 0,
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  getDb().prepare('DELETE FROM discovery_search_sync').run();
  getDb().prepare('DELETE FROM perf_query_daily').run();
  getDb().prepare('DELETE FROM backlinks').run();
  getDb().prepare('DELETE FROM crawl_candidates').run();
  vi.mocked(getAccessTokenForAccount).mockResolvedValue('test-token');
});
it('aggregates low daily impressions correctly and exposes low-volume queries', () => {
  const window = searchOpportunities(ws, site().id);
  const insert = getDb().prepare("INSERT INTO perf_query_daily VALUES(?,'google',?,?,?,?,?)");
  for (let i = 0; i < 20; i++)
    insert.run(
      site().id,
      new Date(Date.parse(window.from) + i * 86400000).toISOString().slice(0, 10),
      'Useful query',
      1,
      6,
      8,
    );
  insert.run(site().id, window.from, 'Tiny query', 0, 2, 30);
  const result = searchOpportunities(ws, site().id);
  expect(result.opportunities[0]).toMatchObject({ query: 'Useful query', impressions: 120 });
  expect(result.queries).toHaveLength(2);
});
it('automatically fetches the complete query window and coalesces concurrent requests', async () => {
  const linked = { ...site(), google_account_id: 'mock-account' };
  const window = searchOpportunities(ws, site().id);
  vi.mocked(gscQuery).mockResolvedValue([
    { keys: [window.from, 'Fetched query'], clicks: 1, impressions: 25, ctr: 0.04, position: 12 },
  ]);
  const [a, b] = await Promise.all([
    loadSearchOpportunities(ws, linked),
    loadSearchOpportunities(ws, linked),
  ]);
  expect(a.queries[0].query).toBe('Fetched query');
  expect(b.sync.error).toBeNull();
  expect(gscQuery).toHaveBeenCalledOnce();
  expect(gscQuery).toHaveBeenCalledWith(
    'test-token',
    'sc-domain:example.com',
    expect.objectContaining({
      startDate: window.previousFrom,
      dimensions: ['date', 'query'],
      rowLimit: 25000,
    }),
  );
  await loadSearchOpportunities(ws, linked);
  expect(gscQuery).toHaveBeenCalledOnce();
});
it('surfaces Google failures while preserving cached evidence and enforces site scope', async () => {
  const window = searchOpportunities(ws, site().id);
  getDb()
    .prepare("INSERT INTO perf_query_daily VALUES(?,'google',?,?,?,?,?)")
    .run(site().id, window.from, 'Cached query', 1, 120, 10);
  vi.mocked(getAccessTokenForAccount).mockRejectedValue(new Error('Reconnect Google account'));
  const result = await loadSearchOpportunities(ws, { ...site(), google_account_id: 'mock-account' });
  expect(result.sync.error).toContain('Reconnect');
  expect(result.queries).toHaveLength(1);
  await expect(loadSearchOpportunities(other, site())).rejects.toThrow('Site not found');
  expect((await loadSearchOpportunities(ws, site())).sync.error).toContain('Link a Google account');
});
it('extracts public Play links and full description with line breaks', () => {
  expect(
    parsePlaySearch(
      '<a href="/store/apps/details?id=com.example.app">Example App</a><a href="https://attacker.example/">Bad</a>',
    ),
  ).toEqual([expect.objectContaining({ id: 'com.example.app', name: 'Example App' })]);
  const result = parsePlayListing(
    '<script type="application/ld+json">{"@type":"SoftwareApplication","name":"Example","description":"Short summary","author":{"name":"Publisher"}}</script><meta property="og:description" content="Short summary"><div data-g-id="description">Full description<br>Second line</div>',
  );
  expect(result).toMatchObject({
    description: 'Full description\nSecond line',
    subtitle: 'Short summary',
    publisher: 'Publisher',
    descriptionComplete: true,
  });
  expect(() => parsePlayListing('<p>Consent required</p>')).toThrow('readable listing');
});
it('looks up Apple app metadata without inventing private keywords', async () => {
  vi.mocked(safeFetch).mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              trackId: 123456,
              trackName: 'Fixture App',
              artistName: 'Publisher',
              description: 'Full public description',
            },
          ],
        }),
      ),
  );
  expect((await searchStore('apple', 'Fixture App', 'GB', 'en'))[0].id).toBe('123456');
  const result = await fetchStoreListing('apple', '123456', 'GB', 'en');
  expect(result.draft).toMatchObject({
    description: 'Full public description',
    keywords: '',
    source_id: '123456',
  });
  expect(result.unavailable).toContain('keywords');
  await expect(fetchStoreListing('apple', 'https://127.0.0.1', 'GB', 'en')).rejects.toThrow('identifier');
});
it('discovers, verifies and monitors real anchors without recording search-only mentions as backlinks', async () => {
  const tenant = newWorkspace();
  const owned = { ...site(), workspace_id: tenant, id: 'scan-site', domain: 'scan.example.com' };
  upsertSite(owned);
  vi.mocked(safeFetch).mockImplementation(async (url) =>
    String(url).startsWith('https://www.bing.com/')
      ? new Response(
          feed('https://publisher.example/story', 'https://mention.example/', 'https://127.0.0.1/private'),
        )
      : html(
          String(url).includes('publisher.example')
            ? '<a rel="nofollow" href="https://scan.example.com/guide">Useful guide</a>'
            : 'A mere mention of example.com',
        ),
  );
  const result = await discoverLinks(tenant, owned, '', true);
  expect(result).toMatchObject({ added: 1, monitored: 1, checked: 2 });
  const backlink = listBacklinks(tenant, owned.id)[0];
  expect(backlink.status).toBe('present');
  expect(backlink.evidence.rel).toEqual(['nofollow']);
  expect(backlinkHistory(tenant, backlink.id)).toHaveLength(1);
  expect(listCrawlCandidates(tenant, owned.id)[0].state).toBe('promoted');
  expect(safeFetch).not.toHaveBeenCalledWith(
    expect.stringContaining('127.0.0.1'),
    expect.anything(),
    expect.anything(),
  );
});
it('uses configured Brave and preserves dismissed candidates during discovery', async () => {
  const tenant = newWorkspace();
  const owned = { ...site(), workspace_id: tenant, id: 'brave-site', domain: 'brave.example.com' };
  upsertSite(owned);
  setWorkspaceSetting(tenant, 'brave_api_key', 'fixture-brave');
  importCrawlCandidates(
    tenant,
    owned,
    JSON.stringify({
      source_url: 'https://publisher.example/story',
      target_url: 'https://brave.example.com/',
    }),
    'Previous',
    false,
  );
  reviewCrawlCandidate(tenant, owned, listCrawlCandidates(tenant, owned.id)[0].id, 'dismissed');
  vi.mocked(safeFetch).mockImplementation(async (url) =>
    String(url).includes('api.search.brave.com')
      ? new Response(JSON.stringify({ web: { results: [{ url: 'https://publisher.example/story' }] } }))
      : html('<a href="https://brave.example.com/">Example</a>'),
  );
  const result = await discoverLinks(tenant, owned, '', true);
  expect(result.sources).toContain('Brave Search');
  expect(listBacklinks(tenant, owned.id)).toEqual([]);
  expect(listCrawlCandidates(tenant, owned.id)[0].state).toBe('dismissed');
});
it('rejects cross-tenant discovery and blocked public feeds', async () => {
  await expect(discoverLinks(other, site())).rejects.toThrow('Site not found');
  expect(safeFetch).not.toHaveBeenCalled();
  expect(() => parseSearchFeed('<html>Blocked</html>')).toThrow('readable feed');
});

it('does not attribute old cached queries to a changed Search Console property', async () => {
  const old = { ...site(), google_account_id: 'mock-account' };
  const window = searchOpportunities(ws, site().id);
  vi.mocked(gscQuery).mockResolvedValue([
    { keys: [window.from, 'Old property query'], clicks: 1, impressions: 25, ctr: 0.04, position: 12 },
  ]);
  await loadSearchOpportunities(ws, old);
  vi.mocked(getAccessTokenForAccount).mockRejectedValue(new Error('Property access denied'));
  const result = await loadSearchOpportunities(ws, { ...old, gsc_url: 'https://www.example.com/' });
  expect(result.queries).toEqual([]);
  expect(result.sync.last_success).toBeNull();
  expect(result.sync.error).toBe('Property access denied');
});
it('keeps Bing-reported pairs unverified when their source cannot be reached', async () => {
  const tenant = newWorkspace();
  const owned = {
    ...site(),
    workspace_id: tenant,
    id: 'bing-site',
    domain: 'bing.example.com',
    gsc_url: 'https://bing.example.com/',
  };
  upsertSite(owned);
  vi.mocked(bingCredentialForSite).mockResolvedValueOnce({ type: 'api_key', value: 'fixture-bing' });
  vi.mocked(safeFetch).mockImplementation(async (url) => {
    const value = String(url);
    if (value.includes('www.bing.com/search')) return new Response(feed());
    if (value.includes('GetLinkCounts'))
      return new Response(
        JSON.stringify({ d: { Links: [{ Url: 'https://bing.example.com/guide' }], TotalPages: 1 } }),
      );
    if (value.includes('GetUrlLinks'))
      return new Response(
        JSON.stringify({
          d: { Details: [{ Url: 'https://unavailable.example/story', AnchorText: 'Guide' }] },
        }),
      );
    throw new Error('Source timed out');
  });
  const result = await discoverLinks(tenant, owned, '', true);
  expect(result).toMatchObject({ reported: 1, observed: 0, monitored: 1 });
  expect(result.sources).toContain('Bing Webmaster');
  const backlink = listBacklinks(tenant, owned.id)[0];
  expect(backlink.status).toBe('unverified');
  expect(backlinkHistory(tenant, backlink.id)).toEqual([]);
});
