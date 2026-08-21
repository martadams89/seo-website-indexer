/**
 * Light site-hygiene check: samples URLs from url_state and reports non-200
 * responses and redirect chains — the "own goal" errors that waste crawl
 * budget and dilute canonicals.
 */
import { getDb, type Site } from '../db/database.js';
import { safeFetch } from '../security/outbound-url.js';

export interface HygieneIssue {
  url: string;
  kind: 'broken' | 'redirect_chain' | 'redirect';
  detail: string;
}

async function probe(url: string): Promise<HygieneIssue | null> {
  const hops: string[] = [];
  let current = url;
  for (let i = 0; i < 6; i++) {
    let res: Response;
    try {
      res = await safeFetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'User-Agent': 'SEOWebsiteIndexer/1.0 (hygiene)' },
        signal: AbortSignal.timeout(15_000),
      }, { label: 'Site hygiene URL', maxRedirects: 0 });
    } catch (e) {
      return { url, kind: 'broken', detail: `fetch failed: ${e instanceof Error ? e.message : e}` };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { url, kind: 'broken', detail: `HTTP ${res.status} without Location` };
      hops.push(`${res.status} → ${loc}`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (res.status >= 400) {
      return { url, kind: 'broken', detail: `HTTP ${res.status}${hops.length ? ` (after ${hops.length} redirect${hops.length > 1 ? 's' : ''})` : ''}` };
    }
    // 2xx
    if (hops.length >= 2) return { url, kind: 'redirect_chain', detail: hops.join('  ') };
    if (hops.length === 1) return { url, kind: 'redirect', detail: hops[0] };
    return null;
  }
  return { url, kind: 'redirect_chain', detail: `>5 hops: ${hops.slice(0, 3).join('  ')}…` };
}

const CONCURRENCY = 6;

export async function checkSiteHygiene(site: Site, limit = 40): Promise<{ checked: number; issues: HygieneIssue[] }> {
  const urls = (getDb().prepare(
    'SELECT url FROM url_state WHERE site_id = ? ORDER BY last_seen_lastmod DESC LIMIT ?'
  ).all(site.id, limit) as Array<{ url: string }>).map(r => r.url);

  const issues: HygieneIssue[] = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(probe));
    for (const r of results) if (r) issues.push(r);
  }
  return { checked: urls.length, issues };
}
