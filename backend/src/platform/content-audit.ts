import { getDb, getSitesForWorkspace, getUrlsBySite, type Site } from '../db/database.js';
import { createWorkItem, recordMetric, recordUsage } from './store.js';

interface PageAudit {
  url: string; status: number; title: string; description: string; canonical: string;
  words: number; internalLinks: number; externalLinks: number; schemas: number;
}

const textContent = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const attr = (html: string, re: RegExp) => (re.exec(html)?.[1] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

async function inspectPage(url: string, site: Site): Promise<PageAudit> {
  const res = await fetch(url, { headers: { 'User-Agent': 'OrganicCommandAudit/1.0' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  const html = (await res.text()).slice(0, 2_000_000);
  const title = attr(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = attr(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || attr(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const canonical = attr(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)/i) || attr(html, /<link[^>]+href=["']([^"']*)["'][^>]+rel=["']canonical["']/i);
  const origin = new URL(site.domain.startsWith('http') ? site.domain : `https://${site.domain}`).hostname.replace(/^www\./, '');
  const links = [...html.matchAll(/<a\b[^>]+href=["']([^"'#]+)["']/gi)].map(match => match[1]);
  let internalLinks = 0; let externalLinks = 0;
  for (const href of links) { try { const host = new URL(href, url).hostname.replace(/^www\./, ''); if (host === origin) internalLinks++; else externalLinks++; } catch { /* malformed href */ } }
  const words = textContent(html).split(/\s+/).filter(Boolean).length;
  return { url, status: res.status, title, description, canonical, words, internalLinks, externalLinks,
    schemas: (html.match(/<script[^>]+type=["']application\/ld\+json["']/gi) ?? []).length };
}

export async function auditContentInventory(workspaceId: string, siteId?: string, force = false): Promise<{ sites: number; pages: number; issues: number }> {
  const sites = getSitesForWorkspace(workspaceId).filter(site => !siteId || site.id === siteId); let pages = 0; let issues = 0;
  for (const site of sites) {
    if (!force) {
      const latest = getDb().prepare("SELECT MAX(observed_at) at FROM metric_observations WHERE workspace_id=? AND site_id=? AND source='content_audit'").get(workspaceId, site.id) as { at: string | null };
      if (latest.at && Date.now() - new Date(latest.at).getTime() < 6 * 86_400_000) continue;
    }
    const urls = getUrlsBySite(site.id).filter(row => !row.indexnow_only && /^https?:/.test(row.url)).slice(0, 50).map(row => row.url);
    if (!urls.length) urls.push(site.domain.startsWith('http') ? site.domain : `https://${site.domain}`);
    const results: PageAudit[] = [];
    for (let index = 0; index < urls.length; index += 5) {
      const batch = await Promise.allSettled(urls.slice(index, index + 5).map(url => inspectPage(url, site)));
      for (const result of batch) if (result.status === 'fulfilled') results.push(result.value);
    }
    const observedAt = new Date().toISOString(); const titleMap = new Map<string, string[]>();
    for (const page of results) {
      pages++; const dimension = page.url;
      for (const [metric, value, unit] of [
        ['http_status', page.status, 'status'], ['word_count', page.words, 'count'], ['internal_links', page.internalLinks, 'count'],
        ['external_links', page.externalLinks, 'count'], ['schema_blocks', page.schemas, 'count'], ['title_length', page.title.length, 'characters'],
        ['description_length', page.description.length, 'characters'], ['canonical_present', page.canonical ? 1 : 0, 'boolean'],
      ] as Array<[string, number, string]>) recordMetric({ workspace_id: workspaceId, site_id: site.id, source: 'content_audit', metric, dimension, value, unit, observed_at: observedAt, provenance: { url: page.url, sampled: true } });
      if (page.title) titleMap.set(page.title.toLowerCase(), [...(titleMap.get(page.title.toLowerCase()) ?? []), page.url]);
      const pageIssues: string[] = [];
      if (page.status >= 400) pageIssues.push(`HTTP ${page.status}`);
      if (!page.title) pageIssues.push('missing title'); else if (page.title.length > 65) pageIssues.push('long title');
      if (!page.description) pageIssues.push('missing description');
      if (!page.canonical) pageIssues.push('missing canonical');
      if (page.words < 120) pageIssues.push('thin content');
      if (page.internalLinks === 0) pageIssues.push('no internal links');
      if (pageIssues.length) { issues++; createWorkItem({ workspaceId, siteId: site.id, source: 'content_audit', sourceRef: page.url,
        title: `Content issue on ${new URL(page.url).pathname || '/'}`, description: pageIssues.join(', '), severity: page.status >= 500 ? 'critical' : page.status >= 400 ? 'high' : 'medium',
        deepLink: `/intelligence?source=content_audit`, evidence: { ...page, issues: pageIssues } }); }
    }
    for (const [title, duplicateUrls] of titleMap) if (duplicateUrls.length > 1) { issues++; createWorkItem({ workspaceId, siteId: site.id, source: 'content_audit',
      sourceRef: `duplicate:${title}`, title: 'Duplicate page titles found', description: `${duplicateUrls.length} sampled pages use the same title.`, severity: 'medium',
      deepLink: '/intelligence?source=content_audit', evidence: { title, urls: duplicateUrls } }); }
    recordUsage({ workspace_id: workspaceId, user_id: null, provider: 'internal', operation: 'content.audit', quantity: results.length, unit: 'page', estimated_cost: 0, metadata: { site_id: site.id, sampled: true } });
  }
  return { sites: sites.length, pages, issues };
}
