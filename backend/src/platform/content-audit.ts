import { getDb, getSitesForWorkspace, getUrlsBySite } from '../db/database.js';
import { createWorkItem, recordMetric, recordUsage } from './store.js';
import { inventoryFindings, normalizeUrl, host, parsePage, type PageEvidence } from './page-evidence.js';
import { saveAudit } from './discovery-store.js';
import { readResponseText, safeFetch } from '../security/outbound-url.js';

export interface PageAudit {
  url: string;
  status: number;
  title: string;
  description: string;
  canonical: string;
  words: number;
  internalLinks: number;
  externalLinks: number;
  schemas: number;
}

const namedEntities: Record<string, string> = {
  amp: '&',
  apos: "'",
  copy: '©',
  gt: '>',
  hellip: '…',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  reg: '®',
  trade: '™',
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (entity, code: string) => {
    if (code[0] !== '#') return namedEntities[code.toLowerCase()] ?? entity;
    const numeric =
      code[1]?.toLowerCase() === 'x'
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
    try {
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity;
    } catch {
      return entity;
    }
  });
}

export async function inspectPage(url: string, signal?: AbortSignal): Promise<PageEvidence> {
  const res = await safeFetch(
    url,
    {
      headers: { 'User-Agent': 'OrganicCommandAudit/2.0' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    },
    { label: 'Content audit URL' },
  );
  const html = await readResponseText(res, 2_000_000, 'Content audit page');
  return parsePage({
    maxLinks: 500,
    url,
    finalUrl: res.url || url,
    status: res.status,
    html,
    contentType: res.headers.get('content-type') ?? '',
    robots: res.headers.get('x-robots-tag') ?? '',
  });
}

const runningSites = new Set<string>();
export async function auditContentInventory(
  workspaceId: string,
  siteId?: string,
  force = false,
  options: {
    signal?: AbortSignal;
    limit?: number;
    onProgress?: (completed: number, total: number) => void;
  } = {},
): Promise<{ sites: number; pages: number; issues: number }> {
  const sites = getSitesForWorkspace(workspaceId).filter(
    (site) => (!siteId || site.id === siteId) && (force || site.enabled),
  );
  let pages = 0;
  let issues = 0;
  for (const site of sites) {
    options.signal?.throwIfAborted();
    if (runningSites.has(site.id)) {
      if (force && siteId)
        throw Object.assign(new Error('An audit is already running for this site.'), { statusCode: 409 });
      continue;
    }
    const latest = getDb()
      .prepare(
        'SELECT observed_at FROM discovery_runs WHERE workspace_id=? AND site_id=? ORDER BY observed_at DESC LIMIT 1',
      )
      .get(workspaceId, site.id) as { observed_at: string } | undefined;
    if (!force && latest && Date.now() - new Date(latest.observed_at).getTime() < 6 * 86_400_000) continue;
    runningSites.add(site.id);
    try {
      const inventory = [
        ...new Set(
          getUrlsBySite(site.id)
            .filter((row) => !row.indexnow_only && /^https?:/.test(row.url))
            .map((row) => normalizeUrl(row.url))
            .filter((url) => {
              const root = host(site.domain.startsWith('http') ? site.domain : `https://${site.domain}`);
              return !!url && (host(url) === root || host(url).endsWith(`.${root}`));
            }),
        ),
      ].sort();
      const urls = inventory.slice(0, options.limit ?? 50);
      if (!urls.length) urls.push(site.domain.startsWith('http') ? site.domain : `https://${site.domain}`);
      options.onProgress?.(0, urls.length);
      const results: PageEvidence[] = [];
      const failures: Array<{ url: string; error: string }> = [];
      for (let index = 0; index < urls.length; index += 3) {
        const batch = await Promise.allSettled(
          urls.slice(index, index + 3).map((url) => inspectPage(url, options.signal)),
        );
        options.signal?.throwIfAborted();
        batch.forEach((result, offset) => {
          if (result.status === 'fulfilled') results.push(result.value);
          else
            failures.push({
              url: urls[index + offset],
              error: result.reason instanceof Error ? result.reason.message : 'Fetch failed',
            });
        });
        options.onProgress?.(Math.min(index + 3, urls.length), urls.length);
      }
      options.signal?.throwIfAborted();
      const findings = inventoryFindings(results);
      const observedAt = new Date().toISOString();
      saveAudit(
        {
          site_id: site.id,
          observed_at: observedAt,
          attempted: urls.length,
          inventory: inventory.length,
          pages: results,
          failures,
          findings,
          methodology:
            'Up to 50 sorted inventory URLs (selected sample recorded in attempted); up to 500 links extracted per page. Response HTML only, without JavaScript rendering. 2 MB response limit, 20 second request timeout. Findings are observations or review prompts, not ranking predictions. No word-count, llms.txt or schema-presence score.',
        },
        workspaceId,
      );
      for (const page of results) {
        pages++;
        for (const [metric, value, unit] of [
          ['http_status', page.status, 'status'],
          ['word_count', page.words, 'count'],
          ['internal_links', page.internalLinks, 'count'],
          ['external_links', page.externalLinks, 'count'],
          ['schema_blocks', page.schemas, 'count'],
          ['title_length', page.title.length, 'characters'],
          ['description_length', page.description.length, 'characters'],
          ['canonical_present', page.canonical ? 1 : 0, 'boolean'],
        ] as Array<[string, number, string]>)
          recordMetric({
            workspace_id: workspaceId,
            site_id: site.id,
            source: 'content_audit',
            metric,
            dimension: page.url,
            value,
            unit,
            observed_at: observedAt,
            provenance: { url: page.url, sampled: true },
          });
      }
      for (const finding of findings.filter((f) => f.severity !== 'low')) {
        issues++;
        createWorkItem({
          workspaceId,
          siteId: site.id,
          source: 'discovery_audit',
          sourceRef: `${site.id}:${finding.code}:${finding.url}`,
          title: finding.title,
          description: finding.fix,
          severity: finding.severity,
          deepLink: `/discovery?site=${encodeURIComponent(site.id)}`,
          evidence: { ...finding, observed_at: observedAt },
        });
      }
      recordUsage({
        workspace_id: workspaceId,
        user_id: null,
        provider: 'internal',
        operation: 'content.audit',
        quantity: urls.length,
        unit: 'page',
        estimated_cost: 0,
        metadata: { site_id: site.id, sampled: true, failures: failures.length },
      });
    } finally {
      runningSites.delete(site.id);
    }
  }
  return { sites: sites.length, pages, issues };
}
