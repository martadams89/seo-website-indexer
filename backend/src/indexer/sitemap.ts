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
