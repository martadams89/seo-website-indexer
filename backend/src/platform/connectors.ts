import { effectiveSetting, getSiteById, type Site } from '../db/database.js';
import { getAccessTokenForAccount } from '../auth/google-oauth.js';
import { logSystem } from '../utils/logger.js';
import {
  assertWithinBudget, createWorkItem, getIntegration, providerLabel, recordMetric, recordUsage,
  updateContentAction, updateIntegrationSync, type ContentAction, type Integration,
} from './store.js';

type SyncResult = { ok: boolean; observations: number; message: string; details?: Record<string, unknown> };

const asString = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const asNumber = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const day = (value = new Date()) => value.toISOString().slice(0, 10);
const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const dateDaysAgo = (days: number) => day(new Date(Date.now() - days * 86_400_000));

function baseUrl(value: unknown): string {
  const url = new URL(asString(value));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Integration URL must use HTTP or HTTPS.');
  url.username = ''; url.password = '';
  return url.toString().replace(/\/$/, '');
}

async function jsonFetch<T>(url: string, init: RequestInit = {}, timeout = 30_000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  return body as T;
}

function siteFor(integration: Integration): Site | null {
  return integration.site_id ? getSiteById(integration.site_id) : null;
}

function observe(integration: Integration, metric: string, value: number, options: {
  siteId?: string | null; dimension?: string; unit?: string; observedAt?: string; provenance?: Record<string, unknown>;
} = {}): void {
  recordMetric({ workspace_id: integration.workspace_id, site_id: options.siteId ?? integration.site_id,
    source: integration.provider, metric, dimension: options.dimension ?? '', value, unit: options.unit ?? null,
    observed_at: options.observedAt ?? new Date().toISOString(), provenance: { integration_id: integration.id, ...options.provenance } });
}

async function syncGa4(integration: Integration): Promise<SyncResult> {
  const propertyId = asString(integration.config.property_id).replace(/^properties\//, '');
  const accountId = asString(integration.config.google_account_id) || siteFor(integration)?.google_account_id || '';
  if (!propertyId || !accountId) throw new Error('GA4 property ID and Google account are required.');
  const token = await getAccessTokenForAccount(accountId);
  const body = {
    dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }, { name: 'landingPagePlusQueryString' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagedSessions' }, { name: 'keyEvents' }, { name: 'totalRevenue' }],
    dimensionFilter: integration.site_id ? undefined : undefined,
    limit: '10000',
  };
  const data = await jsonFetch<{
    rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }>;
    metadata?: { currencyCode?: string; timeZone?: string };
  }>(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  let observations = 0;
  for (const row of data.rows ?? []) {
    const dateRaw = row.dimensionValues?.[0]?.value ?? '';
    const date = /^\d{8}$/.test(dateRaw) ? `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}` : dateRaw;
    const landingPage = row.dimensionValues?.[1]?.value ?? '';
    const metrics = row.metricValues ?? [];
    const names = ['sessions', 'users', 'engaged_sessions', 'conversions', 'revenue'];
    names.forEach((name, index) => {
      observe(integration, name, asNumber(metrics[index]?.value), { dimension: landingPage, observedAt: `${date}T00:00:00.000Z`,
        unit: name === 'revenue' ? (data.metadata?.currencyCode ?? 'currency') : 'count', provenance: { property_id: propertyId, time_zone: data.metadata?.timeZone } });
      observations++;
    });
  }
  recordUsage({ workspace_id: integration.workspace_id, user_id: null, provider: 'google', operation: 'ga4.runReport', quantity: 1, unit: 'request', estimated_cost: 0, metadata: { integration_id: integration.id, property_id: propertyId, rows: data.rows?.length ?? 0 } });
  return { ok: true, observations, message: `Imported ${data.rows?.length ?? 0} GA4 landing-page rows.` };
}

async function syncPageSpeed(integration: Integration): Promise<SyncResult> {
  const site = siteFor(integration); if (!site) throw new Error('PageSpeed requires a site.');
  const key = asString(integration.config.api_key) || effectiveSetting(integration.workspace_id, 'crux_api_key') || '';
  const target = asString(integration.config.url) || (site.domain.startsWith('http') ? site.domain : `https://${site.domain}`);
  let observations = 0;
  const regressions: string[] = [];
  for (const strategy of ['mobile', 'desktop'] as const) {
    const params = new URLSearchParams({ url: target, strategy });
    for (const category of ['performance', 'accessibility', 'best-practices', 'seo']) params.append('category', category);
    if (key) params.set('key', key);
    const data = await jsonFetch<{
      lighthouseResult?: { fetchTime?: string; categories?: Record<string, { score?: number }>; audits?: Record<string, { numericValue?: number; score?: number; title?: string; displayValue?: string }> };
    }>(`https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {}, 90_000);
    const observedAt = data.lighthouseResult?.fetchTime ?? new Date().toISOString();
    for (const [category, result] of Object.entries(data.lighthouseResult?.categories ?? {})) {
      const score = Math.round((result.score ?? 0) * 100);
      observe(integration, `lighthouse_${category.replaceAll('-', '_')}`, score, { dimension: strategy, unit: 'score', observedAt, provenance: { url: target, strategy } });
      observations++;
      if (score < (category === 'performance' ? 70 : 85)) regressions.push(`${category} ${score}`);
    }
    const auditMap: Record<string, [string, string]> = {
      'largest-contentful-paint': ['lcp_ms', 'ms'], 'interaction-to-next-paint': ['inp_ms', 'ms'],
      'cumulative-layout-shift': ['cls', 'score'], 'total-blocking-time': ['tbt_ms', 'ms'],
      'speed-index': ['speed_index_ms', 'ms'], 'server-response-time': ['ttfb_ms', 'ms'],
    };
    for (const [audit, [metric, unit]] of Object.entries(auditMap)) {
      const value = data.lighthouseResult?.audits?.[audit]?.numericValue;
      if (value == null) continue;
      observe(integration, metric, value, { dimension: strategy, unit, observedAt, provenance: { url: target, audit } }); observations++;
    }
  }
  if (regressions.length) createWorkItem({ workspaceId: integration.workspace_id, siteId: site.id, source: 'pagespeed',
    sourceRef: `${integration.id}:${day()}`, title: 'Page experience is below budget',
    description: `${regressions.join(', ')}. Review the evidence before shipping a fix.`, severity: 'high', deepLink: `/intelligence?source=pagespeed`, evidence: { target, regressions } });
  recordUsage({ workspace_id: integration.workspace_id, user_id: null, provider: 'google', operation: 'pagespeed.runPagespeed', quantity: 2, unit: 'request', estimated_cost: 0, metadata: { integration_id: integration.id, url: target } });
  return { ok: true, observations, message: 'Audited mobile and desktop performance, accessibility, best practices and SEO.' };
}

async function cloudflareQuery(integration: Integration): Promise<Record<string, unknown>> {
  const zoneTag = asString(integration.config.zone_id); const token = asString(integration.config.api_token);
  if (!zoneTag || !token) throw new Error('Cloudflare zone ID and API token are required.');
  const query = `query Overview($zoneTag: string!, $start: Time!, $end: Time!) {
    viewer { zones(filter: { zoneTag: $zoneTag }) {
      total: httpRequestsAdaptiveGroups(filter: { datetime_geq: $start, datetime_lt: $end }, limit: 1) {
        count sum { edgeResponseBytes visits } ratio { status4xx status5xx }
      }
      cache: httpRequestsAdaptiveGroups(filter: { datetime_geq: $start, datetime_lt: $end }, limit: 20, orderBy: [count_DESC]) {
        count dimensions { cacheStatus }
      }
      paths: httpRequestsAdaptiveGroups(filter: { datetime_geq: $start, datetime_lt: $end }, limit: 20, orderBy: [count_DESC]) {
        count dimensions { clientRequestPath }
      }
    } }
  }`;
  const result = await jsonFetch<{ data?: Record<string, unknown>; errors?: Array<{ message?: string }> }>('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { zoneTag, start: isoDaysAgo(1), end: new Date().toISOString() } }),
  });
  if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
  return result.data ?? {};
}

async function syncCloudflare(integration: Integration): Promise<SyncResult> {
  const data = await cloudflareQuery(integration) as { viewer?: { zones?: Array<{
    total?: Array<{ count?: number; sum?: { edgeResponseBytes?: number; visits?: number }; ratio?: { status4xx?: number; status5xx?: number } }>;
    cache?: Array<{ count?: number; dimensions?: { cacheStatus?: string } }>;
    paths?: Array<{ count?: number; dimensions?: { clientRequestPath?: string } }>;
  }> } };
  const zone = data.viewer?.zones?.[0]; const total = zone?.total?.[0];
  const observedAt = new Date().toISOString(); let observations = 0;
  const metrics: Array<[string, number, string]> = [
    ['edge_requests', total?.count ?? 0, 'count'], ['edge_bytes', total?.sum?.edgeResponseBytes ?? 0, 'bytes'],
    ['edge_visits', total?.sum?.visits ?? 0, 'count'], ['edge_4xx_rate', (total?.ratio?.status4xx ?? 0) * 100, 'percent'],
    ['edge_5xx_rate', (total?.ratio?.status5xx ?? 0) * 100, 'percent'],
  ];
  for (const [metric, value, unit] of metrics) { observe(integration, metric, value, { unit, observedAt, provenance: { window: '24h', zone_id: integration.config.zone_id } }); observations++; }
  for (const row of zone?.cache ?? []) { observe(integration, 'cache_requests', row.count ?? 0, { dimension: row.dimensions?.cacheStatus ?? 'unknown', unit: 'count', observedAt }); observations++; }
  for (const row of zone?.paths ?? []) { observe(integration, 'edge_path_requests', row.count ?? 0, { dimension: row.dimensions?.clientRequestPath ?? '/', unit: 'count', observedAt }); observations++; }
  if ((total?.ratio?.status5xx ?? 0) >= 0.02) createWorkItem({ workspaceId: integration.workspace_id, siteId: integration.site_id,
    source: 'cloudflare', sourceRef: `${integration.id}:5xx:${day()}`, title: 'Origin error rate is elevated',
    description: `${((total?.ratio?.status5xx ?? 0) * 100).toFixed(1)}% of edge requests returned 5xx in the last 24 hours.`,
    severity: 'critical', deepLink: '/intelligence?source=cloudflare', evidence: { ratio: total?.ratio?.status5xx, window: '24h' } });
  recordUsage({ workspace_id: integration.workspace_id, user_id: null, provider: 'cloudflare', operation: 'graphql.analytics', quantity: 1, unit: 'request', estimated_cost: 0, metadata: { integration_id: integration.id } });
  return { ok: true, observations, message: 'Imported edge traffic, cache, error and top-path evidence for the last 24 hours.' };
}

async function syncPlausible(integration: Integration): Promise<SyncResult> {
  const token = asString(integration.config.api_token); const siteId = asString(integration.config.site_id);
  const endpoint = `${baseUrl(integration.config.base_url || 'https://plausible.io')}/api/v2/query`;
  if (!token || !siteId) throw new Error('Plausible site ID and Stats API token are required.');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const metrics = ['visitors', 'visits', 'pageviews', 'bounce_rate', 'visit_duration'];
  const [aggregate, pages] = await Promise.all([
    jsonFetch<{ results?: Array<{ metrics?: Array<number | { value?: number }> }> }>(endpoint, { method: 'POST', headers, body: JSON.stringify({ site_id: siteId, metrics, date_range: '30d' }) }),
    jsonFetch<{ results?: Array<{ dimensions?: string[]; metrics?: Array<number> }> }>(endpoint, { method: 'POST', headers, body: JSON.stringify({ site_id: siteId, metrics: ['visitors', 'pageviews'], date_range: '30d', dimensions: ['event:page'], order_by: [['visitors', 'desc']], pagination: { limit: 100, offset: 0 } }) }),
  ]);
  let observations = 0; const observedAt = new Date().toISOString();
  metrics.forEach((metric, i) => { const raw = aggregate.results?.[0]?.metrics?.[i]; const value = typeof raw === 'object' ? raw?.value : raw;
    observe(integration, metric === 'visitors' ? 'users' : metric, asNumber(value), { unit: metric.includes('rate') ? 'percent' : metric.includes('duration') ? 'seconds' : 'count', observedAt, provenance: { window: '30d', site_id: siteId } }); observations++; });
  for (const row of pages.results ?? []) { const path = row.dimensions?.[0] ?? '/';
    observe(integration, 'landing_page_users', asNumber(row.metrics?.[0]), { dimension: path, unit: 'count', observedAt });
    observe(integration, 'landing_page_views', asNumber(row.metrics?.[1]), { dimension: path, unit: 'count', observedAt }); observations += 2; }
  recordUsage({ workspace_id: integration.workspace_id, user_id: null, provider: 'plausible', operation: 'stats.query', quantity: 2, unit: 'request', estimated_cost: 0, metadata: { integration_id: integration.id } });
  return { ok: true, observations, message: 'Imported Plausible outcomes and top landing pages.' };
}

async function syncMatomo(integration: Integration): Promise<SyncResult> {
  const endpoint = `${baseUrl(integration.config.base_url)}/index.php`; const token = asString(integration.config.token_auth); const siteId = asString(integration.config.site_id);
  if (!token || !siteId) throw new Error('Matomo site ID and auth token are required.');
  const form = new URLSearchParams({ module: 'API', method: 'VisitsSummary.get', idSite: siteId, period: 'range',
    date: `${dateDaysAgo(30)},${day()}`, format: 'JSON', token_auth: token });
  const data = await jsonFetch<Record<string, number>>(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const map: Record<string, [string, string]> = { nb_visits: ['visits', 'count'], nb_uniq_visitors: ['users', 'count'], nb_actions: ['pageviews', 'count'],
    bounce_rate: ['bounce_rate', 'percent'], avg_time_on_site: ['visit_duration', 'seconds'], nb_visits_converted: ['conversions', 'count'] };
  let observations = 0;
  for (const [field, [metric, unit]] of Object.entries(map)) if (data[field] != null) {
    observe(integration, metric, asNumber(String(data[field]).replace('%', '')), { unit, provenance: { window: '30d', site_id: siteId } }); observations++;
  }
  recordUsage({ workspace_id: integration.workspace_id, user_id: null, provider: 'matomo', operation: 'VisitsSummary.get', quantity: 1, unit: 'request', estimated_cost: 0, metadata: { integration_id: integration.id } });
  return { ok: true, observations, message: 'Imported Matomo visits, engagement and conversion outcomes.' };
}

async function testCms(integration: Integration): Promise<Record<string, unknown>> {
  if (integration.provider === 'wordpress') {
    const root = `${baseUrl(integration.config.base_url)}/wp-json/wp/v2`;
    const auth = Buffer.from(`${asString(integration.config.username)}:${asString(integration.config.app_password)}`).toString('base64');
    return await jsonFetch<Record<string, unknown>>(`${root}/users/me?context=edit`, { headers: { Authorization: `Basic ${auth}` } });
  }
  if (integration.provider === 'shopify') {
    const shop = asString(integration.config.shop_domain).replace(/^https?:\/\//, '').replace(/\/$/, '');
    const version = asString(integration.config.api_version) || '2026-07';
    const result = await jsonFetch<{ data?: { shop?: Record<string, unknown> }; errors?: unknown }>(`https://${shop}/admin/api/${version}/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': asString(integration.config.access_token) },
      body: JSON.stringify({ query: '{ shop { name myshopifyDomain } }' }),
    });
    if (result.errors) throw new Error(JSON.stringify(result.errors)); return result.data?.shop ?? {};
  }
  if (integration.provider === 'webflow') {
    return await jsonFetch<Record<string, unknown>>('https://api.webflow.com/v2/sites', { headers: { Authorization: `Bearer ${asString(integration.config.access_token)}` } });
  }
  throw new Error('Not a CMS integration.');
}

export async function testIntegration(integration: Integration): Promise<SyncResult> {
  if (integration.provider === 'ga4') return syncGa4(integration);
  if (integration.provider === 'pagespeed') return syncPageSpeed(integration);
  if (integration.provider === 'cloudflare') { await cloudflareQuery(integration); return { ok: true, observations: 0, message: 'Cloudflare Analytics API connected.' }; }
  if (integration.provider === 'plausible') return syncPlausible(integration);
  if (integration.provider === 'matomo') return syncMatomo(integration);
  if (['wordpress', 'shopify', 'webflow'].includes(integration.provider)) { const details = await testCms(integration); return { ok: true, observations: 0, message: `${providerLabel(integration.provider)} connected.`, details }; }
  if (integration.provider === 'log_ingest') return { ok: true, observations: 0, message: 'Log ingest endpoint is ready.' };
  if (integration.provider === 'rank_feed') return { ok: true, observations: 0, message: 'Rank-data ingest endpoint is ready. Use a scoped events:write token.' };
  throw new Error('Unsupported integration provider.');
}

export async function syncIntegration(integration: Integration): Promise<SyncResult> {
  try {
    const meteredProvider = ['ga4', 'pagespeed'].includes(integration.provider) ? 'google' : integration.provider;
    if (!['wordpress', 'shopify', 'webflow', 'log_ingest', 'rank_feed'].includes(integration.provider)) {
      assertWithinBudget({ workspaceId: integration.workspace_id, provider: meteredProvider,
        quantity: integration.provider === 'pagespeed' || integration.provider === 'plausible' ? 2 : 1 });
    }
    let result: SyncResult;
    if (integration.provider === 'ga4') result = await syncGa4(integration);
    else if (integration.provider === 'pagespeed') result = await syncPageSpeed(integration);
    else if (integration.provider === 'cloudflare') result = await syncCloudflare(integration);
    else if (integration.provider === 'plausible') result = await syncPlausible(integration);
    else if (integration.provider === 'matomo') result = await syncMatomo(integration);
    else if (['wordpress', 'shopify', 'webflow'].includes(integration.provider)) {
      const details = await testCms(integration); result = { ok: true, observations: 0, message: `${providerLabel(integration.provider)} connection verified.`, details };
    } else result = { ok: true, observations: 0, message: 'Integration is ready for inbound events.' };
    updateIntegrationSync(integration.id, { ok: true });
    logSystem('ok', `${integration.name}: ${result.message}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateIntegrationSync(integration.id, { ok: false, error: message, synced: false });
    createWorkItem({ workspaceId: integration.workspace_id, siteId: integration.site_id, source: 'integration', sourceRef: integration.id,
      title: `${integration.name} needs attention`, description: message, severity: 'high', deepLink: '/integrations', evidence: { provider: integration.provider, integration_id: integration.id } });
    logSystem('warn', `${integration.name} sync failed: ${message}`);
    throw error;
  }
}

export async function syncIntegrationById(workspaceId: string, id: string): Promise<SyncResult> {
  const integration = getIntegration(workspaceId, id); if (!integration) throw new Error('Integration not found.');
  return syncIntegration(integration);
}

function cmsIntegration(action: ContentAction): Integration {
  if (!action.integration_id) throw new Error('A CMS integration is required.');
  const integration = getIntegration(action.workspace_id, action.integration_id);
  if (!integration || !['wordpress', 'shopify', 'webflow'].includes(integration.provider)) throw new Error('CMS integration not found.');
  return integration;
}

export async function stageContentAction(action: ContentAction): Promise<ContentAction> {
  if (action.status !== 'approved') throw new Error('Approve this proposal before staging it.');
  const integration = cmsIntegration(action); const payload = action.payload;
  try {
    if (integration.provider === 'wordpress') {
      const root = `${baseUrl(integration.config.base_url)}/wp-json/wp/v2`; const type = asString(payload.post_type) || 'posts';
      const auth = Buffer.from(`${asString(integration.config.username)}:${asString(integration.config.app_password)}`).toString('base64');
      const remoteId = asString(payload.remote_id); let rollback: Record<string, unknown> = {};
      if (remoteId) rollback = await jsonFetch<Record<string, unknown>>(`${root}/${type}/${remoteId}?context=edit`, { headers: { Authorization: `Basic ${auth}` } });
      const staged = await jsonFetch<{ id?: number; link?: string }>(`${root}/${type}${remoteId ? `/${remoteId}` : ''}`, {
        method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, status: 'draft', remote_id: undefined, post_type: undefined }),
      });
      return updateContentAction(action.workspace_id, action.id, { status: 'staged', remoteId: String(staged.id ?? remoteId), previewUrl: staged.link ?? null, rollbackPayload: rollback })!;
    }
    if (integration.provider === 'webflow') {
      const collectionId = asString(payload.collection_id || integration.config.collection_id); if (!collectionId) throw new Error('Webflow collection ID is required.');
      const itemId = asString(payload.remote_id); const url = `https://api.webflow.com/v2/collections/${collectionId}/items${itemId ? `/${itemId}` : ''}`;
      const rollback = itemId ? await jsonFetch<Record<string, unknown>>(url, { headers: { Authorization: `Bearer ${asString(integration.config.access_token)}` } }) : {};
      const staged = await jsonFetch<{ id?: string }>(url, { method: itemId ? 'PATCH' : 'POST', headers: { Authorization: `Bearer ${asString(integration.config.access_token)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDraft: true, fieldData: payload.fieldData ?? payload.fields ?? {} }) });
      return updateContentAction(action.workspace_id, action.id, { status: 'staged', remoteId: staged.id ?? itemId, rollbackPayload: rollback })!;
    }
    // Shopify changes are created as an unpublished article update. The
    // explicit publish step below flips publication only after approval.
    const shop = asString(integration.config.shop_domain).replace(/^https?:\/\//, '').replace(/\/$/, '');
    const version = asString(integration.config.api_version) || '2026-07'; const remoteId = asString(payload.remote_id);
    if (!remoteId) throw new Error('Shopify article GID is required for governed updates.');
    const prior = await jsonFetch<{ data?: { article?: Record<string, unknown> } }>(`https://${shop}/admin/api/${version}/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': asString(integration.config.access_token) },
      body: JSON.stringify({ query: `query Prior($id: ID!) { article(id: $id) { title body summary tags handle isPublished } }`, variables: { id: remoteId } }),
    });
    const query = `mutation Stage($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { id handle } userErrors { message } } }`;
    const result = await jsonFetch<{ data?: { articleUpdate?: { article?: { id?: string; handle?: string }; userErrors?: Array<{ message?: string }> } }; errors?: unknown }>(`https://${shop}/admin/api/${version}/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': asString(integration.config.access_token) },
      body: JSON.stringify({ query, variables: { id: remoteId, article: { ...(payload.article as object ?? {}), isPublished: false } } }),
    });
    const errors = result.data?.articleUpdate?.userErrors ?? []; if (errors.length || result.errors) throw new Error(JSON.stringify(errors.length ? errors : result.errors));
    return updateContentAction(action.workspace_id, action.id, { status: 'staged', remoteId, rollbackPayload: prior.data?.article ?? {} })!;
  } catch (error) {
    updateContentAction(action.workspace_id, action.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) }); throw error;
  }
}

export async function publishContentAction(action: ContentAction): Promise<ContentAction> {
  if (action.status !== 'staged') throw new Error('Stage and review this change before publishing it.');
  const integration = cmsIntegration(action); const payload = action.payload;
  assertWithinBudget({ workspaceId: action.workspace_id, userId: action.approved_by, provider: integration.provider, quantity: 1 });
  try {
    if (integration.provider === 'wordpress') {
      const type = asString(payload.post_type) || 'posts'; const root = `${baseUrl(integration.config.base_url)}/wp-json/wp/v2`;
      const auth = Buffer.from(`${asString(integration.config.username)}:${asString(integration.config.app_password)}`).toString('base64');
      const result = await jsonFetch<{ link?: string }>(`${root}/${type}/${action.remote_id}`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'publish' }) });
      return updateContentAction(action.workspace_id, action.id, { status: 'published', previewUrl: result.link ?? action.preview_url })!;
    }
    if (integration.provider === 'webflow') {
      const collectionId = asString(payload.collection_id || integration.config.collection_id);
      await jsonFetch(`https://api.webflow.com/v2/collections/${collectionId}/items/publish`, { method: 'POST', headers: { Authorization: `Bearer ${asString(integration.config.access_token)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ itemIds: [action.remote_id] }) });
      return updateContentAction(action.workspace_id, action.id, { status: 'published' })!;
    }
    const shop = asString(integration.config.shop_domain).replace(/^https?:\/\//, '').replace(/\/$/, ''); const version = asString(integration.config.api_version) || '2026-07';
    const query = `mutation Publish($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { id } userErrors { message } } }`;
    const result = await jsonFetch<{ data?: { articleUpdate?: { userErrors?: Array<{ message?: string }> } }; errors?: unknown }>(`https://${shop}/admin/api/${version}/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': asString(integration.config.access_token) }, body: JSON.stringify({ query, variables: { id: action.remote_id, article: { isPublished: true } } }),
    });
    const errors = result.data?.articleUpdate?.userErrors ?? []; if (errors.length || result.errors) throw new Error(JSON.stringify(errors.length ? errors : result.errors));
    return updateContentAction(action.workspace_id, action.id, { status: 'published' })!;
  } catch (error) { updateContentAction(action.workspace_id, action.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) }); throw error; }
}

export async function verifyContentAction(action: ContentAction): Promise<ContentAction> {
  if (action.status !== 'published') throw new Error('Only a published change can be verified.');
  if (action.preview_url) {
    const res = await fetch(action.preview_url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Published URL returned HTTP ${res.status}.`);
  }
  const next = updateContentAction(action.workspace_id, action.id, { status: 'verified' })!;
  recordUsage({ workspace_id: action.workspace_id, user_id: action.approved_by, provider: cmsIntegration(action).provider, operation: 'content.publish', quantity: 1, unit: 'change', estimated_cost: 0, metadata: { action_id: action.id } });
  return next;
}

export async function rollbackContentAction(action: ContentAction): Promise<ContentAction> {
  if (!['published','verified','failed'].includes(action.status)) throw new Error('Only a published or failed live change can be rolled back.');
  if (!Object.keys(action.rollback_payload).length) throw new Error('This change created new content and has no captured prior state to restore.');
  const integration = cmsIntegration(action); const payload = action.payload; const rollback = action.rollback_payload;
  if (integration.provider === 'wordpress') {
    const type = asString(payload.post_type) || 'posts'; const root = `${baseUrl(integration.config.base_url)}/wp-json/wp/v2`;
    const auth = Buffer.from(`${asString(integration.config.username)}:${asString(integration.config.app_password)}`).toString('base64');
    const value = (field: unknown) => typeof field === 'object' && field && 'raw' in field ? (field as {raw?:unknown}).raw : field;
    await jsonFetch(`${root}/${type}/${action.remote_id}`, { method:'POST', headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/json'},
      body:JSON.stringify({title:value(rollback.title),content:value(rollback.content),excerpt:value(rollback.excerpt),status:rollback.status||'publish'}) });
  } else if (integration.provider === 'webflow') {
    const collectionId=asString(payload.collection_id||integration.config.collection_id);
    await jsonFetch(`https://api.webflow.com/v2/collections/${collectionId}/items/${action.remote_id}`, {method:'PATCH',headers:{Authorization:`Bearer ${asString(integration.config.access_token)}`,'Content-Type':'application/json'},body:JSON.stringify({isDraft:false,fieldData:rollback.fieldData??rollback})});
    await jsonFetch(`https://api.webflow.com/v2/collections/${collectionId}/items/publish`, {method:'POST',headers:{Authorization:`Bearer ${asString(integration.config.access_token)}`,'Content-Type':'application/json'},body:JSON.stringify({itemIds:[action.remote_id]})});
  } else {
    const shop=asString(integration.config.shop_domain).replace(/^https?:\/\//,'').replace(/\/$/,'');const version=asString(integration.config.api_version)||'2026-07';
    const query=`mutation Rollback($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { userErrors { message } } }`;
    const result=await jsonFetch<{data?:{articleUpdate?:{userErrors?:Array<{message?:string}>}};errors?:unknown}>(`https://${shop}/admin/api/${version}/graphql.json`,{method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':asString(integration.config.access_token)},body:JSON.stringify({query,variables:{id:action.remote_id,article:rollback}})});
    const errors=result.data?.articleUpdate?.userErrors??[];if(errors.length||result.errors)throw new Error(JSON.stringify(errors.length?errors:result.errors));
  }
  recordUsage({workspace_id:action.workspace_id,user_id:action.approved_by,provider:integration.provider,operation:'content.rollback',quantity:1,unit:'change',estimated_cost:0,metadata:{action_id:action.id}});
  return updateContentAction(action.workspace_id,action.id,{status:'rolled_back'})!;
}
