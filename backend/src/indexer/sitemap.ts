import https from 'https';
import http from 'http';

export interface SitemapEntry {
  url: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

/**
 * Fetches a URL and returns the body as a string.
 * Follows redirects up to 5 times.
 */
function fetchUrl(url: string, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const client = url.startsWith('https') ? https : http;
    client
      .get(url, { headers: { 'User-Agent': 'SEOWebsiteIndexer/1.0 (sitemap-reader)' }, timeout: 20_000 }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchUrl(res.headers.location, redirects + 1));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      })
      .on('error', reject)
      // 'timeout' only fires an event — the socket must be destroyed to abort,
      // which then rejects through the 'error' handler above.
      .on('timeout', function (this: import('node:http').ClientRequest) {
        this.destroy(new Error(`Timeout fetching ${url}`));
      });
  });
}

/**
 * Parses XML sitemap content and extracts URL entries with optional lastmod.
 * Handles both regular sitemaps and sitemap index files.
 */
async function parseSitemapXml(content: string, baseUrl: string): Promise<SitemapEntry[]> {
  const entries: SitemapEntry[] = [];

  // Check if this is a sitemap index
  if (content.includes('<sitemapindex')) {
    const sitemapUrls = [...content.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/g)].map(m => m[1].trim());
    for (const sUrl of sitemapUrls) {
      try {
        const subContent = await fetchUrl(sUrl);
        const subEntries = await parseSitemapXml(subContent, sUrl);
        entries.push(...subEntries);
      } catch {
        // Skip inaccessible sub-sitemaps
      }
    }
    return entries;
  }

  // Regular sitemap — parse <url> blocks
  const urlBlocks = [...content.matchAll(/<url>([\s\S]*?)<\/url>/g)];
  for (const block of urlBlocks) {
    const inner = block[1];
    const locMatch = inner.match(/<loc>(https?:\/\/[^<]+)<\/loc>/);
    if (!locMatch) continue;

    const url = locMatch[1].trim();
    const lastmodMatch = inner.match(/<lastmod>([^<]+)<\/lastmod>/);
    const changefreqMatch = inner.match(/<changefreq>([^<]+)<\/changefreq>/);
    const priorityMatch = inner.match(/<priority>([^<]+)<\/priority>/);

    entries.push({
      url,
      lastmod: lastmodMatch?.[1]?.trim(),
      changefreq: changefreqMatch?.[1]?.trim(),
      priority: priorityMatch ? parseFloat(priorityMatch[1]) : undefined,
    });
  }

  return entries;
}

/**
 * Fetches and parses a remote sitemap, returning all URL entries.
 * Handles sitemap indexes transparently.
 */
export async function fetchSitemap(sitemapUrl: string): Promise<SitemapEntry[]> {
  const content = await fetchUrl(sitemapUrl);
  return parseSitemapXml(content, sitemapUrl);
}

/**
 * Discovers every sitemap a site declares in its robots.txt (`Sitemap:` lines).
 * This is how we pick up secondary sitemaps that are NOT referenced from the
 * primary sitemap — most importantly an `llms-sitemap.xml` (which lists
 * `llms.txt` / `llms-full.txt`). Returns absolute URLs, deduped. Never throws.
 */
export async function discoverSitemapsFromRobots(domain: string): Promise<string[]> {
  let host = domain;
  if (host.includes('://')) host = host.split('://')[1];
  if (host.includes('/')) host = host.split('/')[0];
  try {
    const body = await fetchUrl(`https://${host}/robots.txt`);
    const urls = [...body.matchAll(/^\s*sitemap:\s*(\S+)\s*$/gim)].map(m => m[1].trim());
    return [...new Set(urls)].filter(u => /^https?:\/\//i.test(u));
  } catch {
    return [];
  }
}

/**
 * True for URLs that are not crawlable HTML pages — `llms.txt`, sitemaps,
 * feeds, data files, assets. These are useful to push to IndexNow (so AI
 * answer engines re-crawl them) but should NOT be sent to the Google Indexing
 * API or Search Console (they aren't indexable pages and just create noise).
 */
export function isNonHtmlUrl(url: string): boolean {
  return /\.(txt|xml|json|pdf|rss|atom|csv|md|webmanifest|ya?ml)(?:$|[?#])/i.test(url);
}

/**
 * Fetches the primary sitemap plus any sitemaps declared in robots.txt, and
 * returns the merged, de-duplicated set of URL entries. Secondary sitemaps that
 * fail to load are skipped. The primary sitemap's entry wins on duplicate URLs.
 */
export async function fetchAllSitemaps(
  primarySitemapUrl: string,
  domain: string
): Promise<{ entries: SitemapEntry[]; sitemapsUsed: string[] }> {
  const seen = new Map<string, SitemapEntry>();
  const sitemapsUsed: string[] = [];

  // Primary first so it wins on duplicates.
  const primaryEntries = await fetchSitemap(primarySitemapUrl);
  sitemapsUsed.push(primarySitemapUrl);
  for (const e of primaryEntries) if (!seen.has(e.url)) seen.set(e.url, e);

  const discovered = await discoverSitemapsFromRobots(domain);
  const normalize = (u: string) => u.replace(/\/+$/, '');
  for (const sm of discovered) {
    if (normalize(sm) === normalize(primarySitemapUrl)) continue; // already fetched
    try {
      const extra = await fetchSitemap(sm);
      sitemapsUsed.push(sm);
      for (const e of extra) if (!seen.has(e.url)) seen.set(e.url, e);
    } catch {
      // Skip inaccessible secondary sitemaps (e.g. a robots Sitemap: line 404s).
    }
  }

  return { entries: [...seen.values()], sitemapsUsed };
}

/**
 * Returns entries that are new or have changed lastmod since we last saw them.
 * If an entry has no lastmod, it is always considered changed (will use rotation fallback).
 */
export function filterChangedEntries(
  entries: SitemapEntry[],
  knownLastmods: Map<string, string | null>
): { changed: SitemapEntry[]; unchanged: SitemapEntry[]; newUrls: SitemapEntry[] } {
  const changed: SitemapEntry[] = [];
  const unchanged: SitemapEntry[] = [];
  const newUrls: SitemapEntry[] = [];

  for (const entry of entries) {
    const known = knownLastmods.get(entry.url);
    if (known === undefined) {
      // URL not seen before
      newUrls.push(entry);
    } else if (!entry.lastmod) {
      // No lastmod — treat as changed so rotation handles it
      changed.push(entry);
    } else if (known !== entry.lastmod) {
      // lastmod changed
      changed.push(entry);
    } else {
      unchanged.push(entry);
    }
  }

  return { changed, unchanged, newUrls };
}

/**
 * Checks if a sitemap is reachable and returns basic stats.
 */
export async function probeSitemap(sitemapUrl: string): Promise<{ ok: boolean; urlCount: number; hasLastmod: boolean; error?: string }> {
  try {
    const entries = await fetchSitemap(sitemapUrl);
    const hasLastmod = entries.some(e => !!e.lastmod);
    return { ok: true, urlCount: entries.length, hasLastmod };
  } catch (e) {
    return { ok: false, urlCount: 0, hasLastmod: false, error: String(e) };
  }
}
