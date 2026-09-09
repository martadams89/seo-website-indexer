import { getDb, effectiveSetting, type Site } from '../db/database.js';
import { bingCredentialForSite } from '../auth/workspaces.js';
import { deriveBingSiteUrl } from '../indexer/bing.js';
import {
  safeFetch,
  readResponseText,
  readResponseJson,
  validateOutboundUrl,
} from '../security/outbound-url.js';
import { normalizeUrl, parsePage, host } from './page-evidence.js';
import { targetBelongsToSite, importBacklinks, recordBacklinkCheck, type Backlink } from './backlinks.js';
import { importCrawlCandidates } from './crawl-candidates.js';
import { plainText } from './public-html.js';
const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
type Pair = { source_url: string; target_url: string; anchor: string; crawl_date: string | null };
export interface DiscoveryResult {
  searched: number;
  checked: number;
  observed: number;
  reported: number;
  added: number;
  duplicates: number;
  monitored: number;
  sources: string[];
  warnings: string[];
  pages: Array<{ url: string; status: string; links: number }>;
}
const running = new Set<string>();
const recent = new Map<string, number>();
export function parseSearchFeed(xml: string): string[] {
  if (!/<rss[\s>]/i.test(xml))
    throw bad(
      'Public search did not return a readable feed. Configure Brave Search in Settings or retry later.',
      502,
    );
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)]
    .flatMap((m) => {
      const link = /<link>([\s\S]*?)<\/link>/i.exec(m[1]);
      return link ? [plainText(link[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))] : [];
    })
    .slice(0, 20);
}
export async function discoverLinks(
  workspaceId: string,
  site: Site,
  terms: unknown = '',
  monitor = false,
): Promise<DiscoveryResult> {
  if (site.workspace_id !== workspaceId) throw bad('Site not found', 404);
  if (typeof terms !== 'string' || terms.length > 150) throw bad('Use up to 150 search characters.');
  if (running.has(workspaceId) || running.size >= 3)
    throw bad('A discovery scan is already running. Try again shortly.', 409);
  const now = Date.now();
  for (const [id, at] of recent) if (now - at > 60_000) recent.delete(id);
  if (now - (recent.get(workspaceId) ?? 0) < 30_000)
    throw bad('Wait 30 seconds between discovery scans.', 429);
  running.add(workspaceId);
  recent.set(workspaceId, now);
  try {
    const deadline = Date.now() + 55_000;
    const sources: string[] = [],
      warnings: string[] = [],
      urls = new Set<string>(),
      pairs = new Map<string, Pair>();
    const key = (p: Pair) => JSON.stringify([p.source_url, p.target_url]);
    const addUrl = (value: string) => {
      const url = normalizeUrl(value);
      if (!url || targetBelongsToSite(url, site)) return;
      try {
        validateOutboundUrl(url, { label: 'Discovery source' });
        urls.add(url);
      } catch {
        /* Private/unsupported source URLs never enter verification. */
      }
    };
    const req = async (url: string, headers: Record<string, string> = {}) => {
      const res = await safeFetch(
        url,
        { headers, signal: AbortSignal.timeout(Math.max(1, Math.min(12_000, deadline - Date.now()))) },
        { maxRedirects: 0 },
      );
      if (!res.ok) throw bad(`Discovery provider returned HTTP ${res.status}.`, 502);
      return res;
    };
    const domain = host(/^https?:/.test(site.domain) ? site.domain : `https://${site.domain}`);
    const q = `"${domain}" ${terms.trim()} -site:${domain}`.trim();
    // Search sources are suggestions. Each page is checked before claiming a live link.
    const search = async () => {
      const brave = effectiveSetting(workspaceId, 'brave_api_key');
      try {
        if (brave) {
          const data = await readResponseJson<{ web?: { results?: Array<{ url?: string }> } }>(
            await req(
              `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: '20' })}`,
              { Accept: 'application/json', 'X-Subscription-Token': brave },
            ),
            1_000_000,
            'Brave search',
          );
          for (const row of data.web?.results ?? []) if (row.url) addUrl(row.url);
          sources.push('Brave Search');
        } else {
          const xml = await readResponseText(
            await req(`https://www.bing.com/search?${new URLSearchParams({ q, format: 'rss' })}`),
            1_000_000,
            'Public search',
          );
          for (const url of parseSearchFeed(xml)) addUrl(url);
          sources.push('Bing public search');
        }
      } catch (e) {
        warnings.push(e instanceof Error ? e.message : 'Web search unavailable');
      }
    };
    const bing = async () => {
      try {
        const credential = await bingCredentialForSite(site.id);
        if (!credential) return;
        const siteUrl = deriveBingSiteUrl(site.gsc_url, site.domain);
        const call = async <T>(method: string, extra: Record<string, string>) => {
          const params = new URLSearchParams({ siteUrl, page: '0', ...extra });
          if (credential.type === 'api_key') params.set('apikey', credential.value);
          return (
            await readResponseJson<{ d: T }>(
              await req(
                `https://ssl.bing.com/webmaster/api.svc/json/${method}?${params}`,
                credential.type === 'oauth'
                  ? { Authorization: `Bearer ${credential.value}` }
                  : { Accept: 'application/json' },
              ),
              1_000_000,
              'Bing links',
            )
          ).d;
        };
        const counts = await call<{ Links?: Array<{ Url: string }>; TotalPages?: number }>(
          'GetLinkCounts',
          {},
        );
        sources.push('Bing Webmaster');
        if ((counts?.TotalPages ?? 0) > 1)
          warnings.push('Bing backlink discovery sampled its first result page.');
        for (const target of (counts?.Links ?? []).slice(0, 3)) {
          if (Date.now() > deadline - 15_000) break;
          if (!targetBelongsToSite(target.Url, site)) continue;
          const links = await call<{ Details?: Array<{ Url: string; AnchorText?: string }> }>('GetUrlLinks', {
            link: target.Url,
          });
          for (const link of (links?.Details ?? []).slice(0, 30)) {
            const source = normalizeUrl(link.Url),
              dest = normalizeUrl(target.Url);
            if (!source || !dest || targetBelongsToSite(source, site)) continue;
            try {
              validateOutboundUrl(source, { label: 'Bing source' });
            } catch {
              continue;
            }
            addUrl(source);
            const row = {
              source_url: source,
              target_url: dest,
              anchor: (link.AnchorText ?? '').slice(0, 300),
              crawl_date: null,
            };
            pairs.set(key(row), row);
          }
        }
      } catch {
        warnings.push(
          'Bing Webmaster backlink discovery was unavailable. Check that this site is verified and the connection can access link data.',
        );
      }
    };
    await Promise.all([search(), bing()]);
    const known = getDb()
      .prepare(
        `SELECT r.citations FROM ai_results r JOIN ai_prompts p ON p.id=r.prompt_id WHERE p.workspace_id=? AND p.site_id=? AND r.error IS NULL ORDER BY r.id DESC LIMIT 100`,
      )
      .all(workspaceId, site.id) as Array<{ citations: string }>;
    for (const row of known) {
      try {
        const values = JSON.parse(row.citations);
        if (Array.isArray(values)) for (const value of values) if (typeof value === 'string') addUrl(value);
      } catch {
        /* Ignore malformed legacy citation payloads. */
      }
    }
    if (known.length) sources.push('Saved AI citation sources');
    const live = new Map<
      string,
      { status: number; final_url: string; links: Backlink['evidence']['links'] }
    >();
    const reported = pairs.size;
    let checked = 0,
      observed = 0;
    const pages: DiscoveryResult['pages'] = [];
    const queue = [...urls].slice(0, 12);
    let next = 0;
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (next < queue.length) {
          const url = queue[next++];
          if (Date.now() > deadline) {
            pages.push({ url, status: 'Deferred by scan time budget', links: 0 });
            continue;
          }
          try {
            const res = await safeFetch(
              url,
              {
                signal: AbortSignal.timeout(Math.max(1, Math.min(8_000, deadline - Date.now()))),
                headers: { 'User-Agent': 'seo-website-indexer/1.0' },
              },
              { maxRedirects: 3 },
            );
            checked++;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const finalUrl = res.url || url;
            if (targetBelongsToSite(finalUrl, site)) throw new Error('Source redirects to the selected site');
            const page = parsePage({
              url,
              finalUrl,
              status: res.status,
              html: await readResponseText(res, 2_000_000, 'Discovered page'),
              contentType: res.headers.get('content-type') ?? '',
            });
            if (!page.html) throw new Error('Source did not return HTML');
            const matches = page.links.filter((link) => targetBelongsToSite(link.url, site)).slice(0, 20);
            if (matches.length) live.set(url, { status: res.status, final_url: finalUrl, links: matches });
            for (const link of matches) {
              const row = {
                source_url: url,
                target_url: link.url,
                anchor: link.anchor.slice(0, 300),
                crawl_date: new Date().toISOString(),
              };
              pairs.set(key(row), row);
              observed++;
            }
            pages.push({
              url,
              status: matches.length
                ? 'Link observed'
                : page.linksTruncated
                  ? 'Anchor limit reached; no matching link observed'
                  : 'No matching link observed',
              links: matches.length,
            });
          } catch (e) {
            pages.push({ url, status: e instanceof Error ? e.message : 'Page unavailable', links: 0 });
          }
        }
      }),
    );
    if (urls.size > queue.length)
      warnings.push(
        `Checked a sample of ${queue.length} of ${urls.size} discovered source pages. Refine the search to explore another set.`,
      );
    let added = 0,
      duplicates = 0,
      monitored = 0;
    if (pairs.size) {
      const list: Pair[] = [];
      let bytes = 0;
      for (const row of pairs.values()) {
        bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes > 450_000 || list.length >= 500) {
          warnings.push('Candidate storage budget reached; refine the search for more results.');
          break;
        }
        list.push(row);
      }
      const result = importCrawlCandidates(
        workspaceId,
        site,
        list.map((r) => JSON.stringify(r)).join('\n'),
        `Online discovery: ${sources.join(', ')}`.slice(0, 200),
        false,
      );
      added = result.added;
      duplicates = result.duplicates;
      if (monitor) {
        const eligible = list.filter(
          (row) =>
            (
              getDb()
                .prepare(
                  'SELECT state FROM crawl_candidates WHERE workspace_id=? AND site_id=? AND source_url=? AND target_url=?',
                )
                .get(workspaceId, site.id, row.source_url, row.target_url) as { state: string } | undefined
            )?.state !== 'dismissed',
        );
        const quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';
        const result = importBacklinks(
          workspaceId,
          site,
          'source_url,target_url\n' +
            eligible.map((r) => quote(r.source_url) + ',' + quote(r.target_url)).join('\n'),
          'Online link discovery',
        );
        monitored = result.added;
        for (const rejection of result.rejected) warnings.push(rejection.reason);
        // Matching historical observations become monitored candidates; live status remains verifier-owned.
        for (const row of eligible)
          getDb()
            .prepare(
              "UPDATE crawl_candidates SET state='promoted' WHERE workspace_id=? AND site_id=? AND source_url=? AND target_url=? AND state='pending' AND EXISTS(SELECT 1 FROM backlinks b WHERE b.workspace_id=crawl_candidates.workspace_id AND b.site_id=crawl_candidates.site_id AND b.source_url=crawl_candidates.source_url AND b.target_url=crawl_candidates.target_url)",
            )
            .run(workspaceId, site.id, row.source_url, row.target_url);
        for (const pair of eligible) {
          const observedPage = live.get(pair.source_url);
          if (!observedPage) continue;
          const links = observedPage.links?.filter((l) => l.url === pair.target_url) ?? [];
          if (!links.length) continue;
          const row = getDb()
            .prepare(
              'SELECT * FROM backlinks WHERE workspace_id=? AND site_id=? AND source_url=? AND target_url=? AND enabled=1',
            )
            .get(workspaceId, site.id, pair.source_url, pair.target_url) as
            | (Omit<Backlink, 'evidence'> & { evidence: string })
            | undefined;
          if (row)
            recordBacklinkCheck(workspaceId, site.id, row, 'present', {
              ...observedPage,
              links,
              anchors: [...new Set(links.map((l) => l.anchor))],
              rel: [...new Set(links.flatMap((l) => l.rel))],
              targets: [...new Set(links.map((l) => l.url))],
            });
        }
      }
    }
    return {
      searched: urls.size,
      checked,
      observed,
      reported,
      added,
      duplicates,
      monitored,
      sources,
      warnings,
      pages,
    };
  } finally {
    running.delete(workspaceId);
  }
}
