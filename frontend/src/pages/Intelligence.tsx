import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownRight, ArrowUpRight, BarChart3, Braces, CircleHelp, Clock3, Cloud,
  Database, Download, Gauge, Globe2, Info, Lightbulb, Minus, Play, Radar, RefreshCw, Save,
  Search, ShieldCheck, Sparkles, TrendingUp, Waypoints,
} from 'lucide-react';
import { api, apiBlob, type MetricObservation, type PlatformOverview } from '../api';
import { useApp } from '../AppContext';
import { Modal } from '../components/Modal';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { useInsights, type InsightRange } from '../insights/InsightsContext';
import { Link, useSearchParams } from 'react-router-dom';
import { saveBlob } from '../utils/download';

type Direction = 'up' | 'down' | 'context';
type SiteScope = 'all' | 'workspace' | string;
interface MetricMeaning { label: string; meaning: string; action: string; direction: Direction }
interface SourceMeaning { label: string; icon: typeof Activity; color: string; meaning: string }

const SOURCE_META: Record<string, SourceMeaning> = {
  ga4: { label: 'Google Analytics 4', icon: Activity, color: 'green', meaning: 'Audience, landing-page, engagement, conversion and revenue outcomes imported from GA4.' },
  pagespeed: { label: 'PageSpeed', icon: Gauge, color: 'amber', meaning: 'Mobile and desktop Lighthouse lab tests for speed, stability, accessibility, SEO and best practices.' },
  cloudflare: { label: 'Cloudflare edge', icon: Cloud, color: 'orange', meaning: 'Requests, traffic, cache behaviour and HTTP error rates observed at the edge.' },
  plausible: { label: 'Plausible', icon: Radar, color: 'cyan', meaning: 'Privacy-focused traffic, engagement and landing-page outcomes from Plausible.' },
  matomo: { label: 'Matomo', icon: Globe2, color: 'violet', meaning: 'Visits, visitors, engagement and conversions collected by Matomo.' },
  content_audit: { label: 'Content inventory', icon: Search, color: 'blue', meaning: 'Page-level technical and content facts measured by the built-in site audit.' },
  server_log: { label: 'Crawl & server logs', icon: Braces, color: 'pink', meaning: 'Real requests, response time and transferred bytes from uploaded server-log events.' },
  rank_feed: { label: 'Rank feed', icon: TrendingUp, color: 'violet', meaning: 'Keyword or visibility measurements sent by an external rank-tracking service.' },
};

const METRIC_META: Record<string, MetricMeaning> = {
  sessions: { label: 'Sessions', meaning: 'Visits that began during the measured period.', action: 'Compare landing pages and investigate sustained drops or qualified growth.', direction: 'up' },
  users: { label: 'Users', meaning: 'Distinct visitors reported by the analytics source.', action: 'Use with sessions and conversions to distinguish reach from repeat use.', direction: 'up' },
  engaged_sessions: { label: 'Engaged sessions', meaning: 'GA4 sessions lasting over 10 seconds, with a key event, or with at least two page views.', action: 'Review landing pages where sessions rise but engagement does not.', direction: 'up' },
  conversions: { label: 'Conversions', meaning: 'Configured key events or converted visits reported by the source.', action: 'Validate tracking, then connect movement to the pages and campaigns that changed.', direction: 'up' },
  revenue: { label: 'Revenue', meaning: 'Revenue attributed by the connected analytics property.', action: 'Use as an outcome signal; confirm attribution before making budget decisions.', direction: 'up' },
  visits: { label: 'Visits', meaning: 'Visits reported across the source’s configured reporting window.', action: 'Compare with visitors and page views to understand repeat use.', direction: 'up' },
  pageviews: { label: 'Page views', meaning: 'Pages viewed during the source reporting window.', action: 'Look for important pages gaining or losing attention.', direction: 'up' },
  bounce_rate: { label: 'Bounce rate', meaning: 'The percentage of visits without meaningful onward engagement.', action: 'Review intent match, page speed and next-step clarity when this rises.', direction: 'down' },
  visit_duration: { label: 'Visit duration', meaning: 'Average time spent during a visit, in seconds.', action: 'Interpret with conversions: longer is useful only when it reflects successful engagement.', direction: 'context' },
  lighthouse_performance: { label: 'Performance score', meaning: 'Lighthouse lab performance score from 0–100 for the shown device.', action: 'Open PageSpeed evidence and prioritise the slowest user-facing bottleneck.', direction: 'up' },
  lighthouse_accessibility: { label: 'Accessibility score', meaning: 'Automated Lighthouse accessibility checks, scored from 0–100.', action: 'Treat this as a screening tool and manually verify flagged components.', direction: 'up' },
  lighthouse_best_practices: { label: 'Best-practices score', meaning: 'Lighthouse checks for browser safety and modern implementation practices.', action: 'Inspect failed audits before changing production code.', direction: 'up' },
  lighthouse_seo: { label: 'Technical SEO score', meaning: 'Lighthouse’s basic crawlability and on-page technical checks.', action: 'Use the failed audits as leads, not as a substitute for a full SEO audit.', direction: 'up' },
  lcp_ms: { label: 'Largest Contentful Paint', meaning: 'How long the main visible content took to render in this lab test.', action: 'Lower is better. Optimise the hero asset, critical CSS and server response.', direction: 'down' },
  inp_ms: { label: 'Interaction to Next Paint', meaning: 'How long the page took to visually respond to an interaction in the test.', action: 'Lower is better. Reduce long main-thread tasks and expensive event handlers.', direction: 'down' },
  cls: { label: 'Cumulative Layout Shift', meaning: 'How much visible content moved unexpectedly while the page loaded.', action: 'Lower is better. Reserve space for media, ads and late-loading UI.', direction: 'down' },
  tbt_ms: { label: 'Total Blocking Time', meaning: 'Time the main thread was blocked by long tasks during page load.', action: 'Lower is better. Split or defer heavy JavaScript work.', direction: 'down' },
  speed_index_ms: { label: 'Speed Index', meaning: 'How quickly visible page content appeared during the lab test.', action: 'Lower is better. Prioritise above-the-fold rendering.', direction: 'down' },
  ttfb_ms: { label: 'Server response time', meaning: 'Time until the server began returning the document.', action: 'Lower is better. Check origin, caching and backend latency.', direction: 'down' },
  edge_requests: { label: 'Edge requests', meaning: 'HTTP requests served through Cloudflare during the last 24 hours.', action: 'Use as traffic context and investigate unusual spikes by path or status.', direction: 'context' },
  edge_visits: { label: 'Edge visits', meaning: 'Cloudflare’s estimate of visits during the last 24 hours.', action: 'Compare with analytics sessions; large gaps can expose consent or bot effects.', direction: 'context' },
  edge_bytes: { label: 'Edge transfer', meaning: 'Response bytes delivered through Cloudflare during the last 24 hours.', action: 'Investigate sudden growth alongside request count and cache behaviour.', direction: 'down' },
  edge_4xx_rate: { label: '4xx error rate', meaning: 'Share of edge requests returning client-error responses.', action: 'Lower is better. Find broken internal links, missing assets and bad bot requests.', direction: 'down' },
  edge_5xx_rate: { label: '5xx error rate', meaning: 'Share of edge requests returning server-error responses.', action: 'Lower is better. Treat sustained movement as an availability incident.', direction: 'down' },
  cache_requests: { label: 'Cache-status requests', meaning: 'Requests grouped by Cloudflare cache status.', action: 'Compare HIT and MISS scopes to identify cache-policy opportunities.', direction: 'context' },
  edge_path_requests: { label: 'Path requests', meaning: 'Requests to the shown path during the Cloudflare window.', action: 'Use high-volume paths to prioritise performance and reliability work.', direction: 'context' },
  requests: { label: 'Server requests', meaning: 'Individual requests counted from ingested server logs.', action: 'Filter by bot, route or status to understand crawl and traffic behaviour.', direction: 'context' },
  bytes: { label: 'Transferred bytes', meaning: 'Response bytes recorded in ingested server logs.', action: 'Compare with request volume to find unexpectedly heavy routes.', direction: 'down' },
  response_ms: { label: 'Response time', meaning: 'Server response duration recorded for the shown request group.', action: 'Lower is better. Investigate slow routes by status and bot dimension.', direction: 'down' },
  http_status: { label: 'HTTP status', meaning: 'HTTP response code returned when the page was audited.', action: 'Anything outside 2xx/3xx needs review, especially important indexable URLs.', direction: 'context' },
  word_count: { label: 'Word count', meaning: 'Visible words found on the audited page.', action: 'Use as context for thin or bloated pages, not as a ranking target.', direction: 'context' },
  internal_links: { label: 'Internal links', meaning: 'Links from the audited page to the same site.', action: 'Check important pages with few useful paths in or out.', direction: 'context' },
  external_links: { label: 'External links', meaning: 'Links from the audited page to other domains.', action: 'Review relevance and maintain broken or untrusted destinations.', direction: 'context' },
  schema_blocks: { label: 'Schema blocks', meaning: 'JSON-LD structured-data blocks detected on the page.', action: 'Validate type and content; a higher count is not inherently better.', direction: 'context' },
  title_length: { label: 'Title length', meaning: 'Number of characters in the page title.', action: 'Review missing, duplicated or truncated titles rather than chasing one fixed length.', direction: 'context' },
  description_length: { label: 'Description length', meaning: 'Number of characters in the meta description.', action: 'Review missing or unhelpful descriptions on important pages.', direction: 'context' },
  canonical_present: { label: 'Canonical present', meaning: '1 means the audit found a canonical link; 0 means it did not.', action: 'Confirm the canonical target is valid and intentional, not merely present.', direction: 'up' },
  position: { label: 'Search position', meaning: 'Ranking position supplied for the shown keyword or dimension.', action: 'Lower is better. Verify movement with clicks, impressions and the live result.', direction: 'down' },
};

const pretty = (value: string) => value.replace(/^lighthouse_/, '').replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
const metricMeaning = (metric: string): MetricMeaning => METRIC_META[metric] ?? { label: pretty(metric), meaning: 'A measurement imported from the named source for the scope shown below.', action: 'Use its source, unit, scope and collection time before drawing a conclusion.', direction: 'context' };
const sourceMeaning = (source: string): SourceMeaning => SOURCE_META[source] ?? { label: pretty(source), icon: Database, color: 'neutral', meaning: 'Evidence supplied by a connected or custom data source.' };
const siteFilters = (scope: SiteScope): { site_id?: string; workspace_only?: boolean } => scope === 'all' ? {} : scope === 'workspace' ? { workspace_only: true } : { site_id: scope };
const metricSeriesKey = (metric: Pick<MetricObservation, 'site_id' | 'source' | 'metric'>) => `${metric.site_id ?? 'workspace'}:${metric.source}:${metric.metric}`;
const metricReadingKey = (metric: Pick<MetricObservation, 'site_id' | 'source' | 'metric' | 'dimension'>) => `${metricSeriesKey(metric)}:${metric.dimension}`;

function formatValue(metric: MetricObservation): string {
  if (metric.unit === 'percent') return `${metric.value.toFixed(1)}%`;
  if (metric.unit === 'bytes') return `${(metric.value / 1_000_000).toFixed(1)} MB`;
  if (metric.unit === 'ms') return `${Math.round(metric.value).toLocaleString()} ms`;
  if (metric.unit === 'seconds') return `${metric.value.toFixed(1)} sec`;
  if (metric.unit === 'boolean') return metric.value ? 'Yes' : 'No';
  if (metric.unit === 'status') return String(Math.round(metric.value));
  return metric.value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function formatForecastValue(value: number, unit: string | null): string {
  if (unit === 'bytes') return `${(value / 1_000_000).toFixed(1)} MB`;
  if (unit === 'percent') return `${value.toFixed(1)}%`;
  if (unit === 'ms') return `${Math.round(value).toLocaleString()} ms`;
  if (unit && /^[A-Z]{3}$/.test(unit)) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: unit, maximumFractionDigits: 0 }).format(value); } catch { /* render as a normal value */ }
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function Series({ rows, meaning }: { rows: MetricObservation[]; meaning: MetricMeaning }) {
  const points = [...rows].sort((a, b) => a.observed_at.localeCompare(b.observed_at)).slice(-30);
  if (points.length < 2) return <div className="series-empty"><BarChart3 size={15}/><span>One reading only</span><small>Refresh later to show a trend</small></div>;
  const values = points.map(point => point.value); const min = Math.min(...values); const max = Math.max(...values);
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${(index / (points.length - 1) * 280).toFixed(1)},${(70 - ((point.value - min) / (max - min || 1)) * 58).toFixed(1)}`).join(' ');
  const change = points.at(-1)!.value - points[0].value;
  const favourable = meaning.direction === 'context' ? null : meaning.direction === 'up' ? change >= 0 : change <= 0;
  const ChangeIcon = change > 0 ? ArrowUpRight : change < 0 ? ArrowDownRight : Minus;
  return <figure className="intel-series-wrap"><div className="series-scale"><span>{max.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span><span>{min.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span></div><svg className="intel-series" viewBox="0 0 280 78" preserveAspectRatio="none" role="img" aria-label={`${meaning.label} moved from ${points[0].value} to ${points.at(-1)!.value} across ${points.length} observations`}><path d={`${path} L280,78 L0,78Z`} className="fill"/><path d={path} className="line"/></svg><figcaption><span>{new Date(points[0].observed_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} → {new Date(points.at(-1)!.observed_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span><span className={favourable == null ? 'neutral' : favourable ? 'good' : 'bad'}><ChangeIcon size={12}/>{change > 0 ? '+' : ''}{change.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span></figcaption></figure>;
}

export default function IntelligencePage() {
  const { active } = useWorkspace(); const { toast, sites } = useApp(); const canManage = !!active?.permissions?.manage_integrations;
  const { siteScope, setSiteScope, range, setRange } = useInsights();
  const [searchParams] = useSearchParams();
  const [renderedAt] = useState(() => Date.now());
  const [overview, setOverview] = useState<PlatformOverview | null>(null); const [metrics, setMetrics] = useState<MetricObservation[]>([]);
  const [source, setSource] = useState(() => searchParams.get('source') || 'all'); const [query, setQuery] = useState(''); const [busy, setBusy] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [views, setViews] = useState<Array<{ id: string; name: string; config: Record<string, unknown>; is_default: number }>>([]);
  const load = useCallback(async () => { const from = new Date(Date.now() - range * 86_400_000).toISOString(); const scope = siteFilters(siteScope); const [nextOverview, nextMetrics, nextViews] = await Promise.all([api.getPlatformOverview(scope), api.getMetrics({ ...scope, limit: 3000, from }), api.getSavedViews()]); setOverview(nextOverview); setMetrics(nextMetrics); setViews(nextViews); }, [range, siteScope]);
  useEffect(() => { load().catch(() => null); }, [load, active?.id]);
  useEffect(() => { const requested = searchParams.get('source'); if (requested) setSource(requested); }, [searchParams]);
  const siteLabels = useMemo(() => new Map(sites.map(site => [site.id, site.name])), [sites]);
  const selectedSite = sites.find(site => site.id === siteScope);
  const siteScopeLabel = siteScope === 'all' ? 'All sites' : siteScope === 'workspace' ? 'Workspace-wide evidence' : selectedSite?.name || 'Selected site';
  const siteScopeDetail = siteScope === 'all'
    ? 'Portfolio view. Site-attached readings stay separate on every card; additive forecasts are summed across all sites.'
    : siteScope === 'workspace'
      ? 'Only evidence that is not assigned to a website. Site-attached readings are excluded.'
      : `Only evidence attached to ${selectedSite?.name || 'this site'}. Workspace-wide readings are excluded.`;
  const metricSiteLabel = (metric: MetricObservation) => metric.site_id ? siteLabels.get(metric.site_id) || 'Unknown site' : 'Workspace-wide';
  const latest = useMemo(() => { const map = new Map<string, MetricObservation>(); for (const metric of metrics) { const key = metricReadingKey(metric); if (!map.has(key)) map.set(key, metric); } return [...map.values()]; }, [metrics]);
  const filtered = latest.filter(metric => (source === 'all' || metric.source === source) && `${metric.metric} ${metric.dimension} ${metricMeaning(metric.metric).meaning} ${metricSiteLabel(metric)}`.toLowerCase().includes(query.toLowerCase()));
  const groups = useMemo(() => { const map = new Map<string, MetricObservation[]>(); for (const metric of metrics) { const key = metricSeriesKey(metric); map.set(key, [...(map.get(key) || []), metric]); } return map; }, [metrics]);
  async function run() { setBusy(true); try { const result = await api.runPlatformAutomation(); toast('success', `Refreshed ${result.integrations || 0} connections and ${result.audited || 0} audited pages`); await load(); } catch (error) { toast('error', String(error).replace('Error: ', '')); } setBusy(false); }
  async function saveCurrentView() { const name = prompt('Name this intelligence view'); if (!name?.trim()) return; try { await api.saveView({ name: name.trim(), config: { source, siteScope, query, range } }); await load(); toast('success', 'View saved'); } catch (error) { toast('error', String(error).replace('Error: ', '')); } }
  async function exportView() { setBusy(true); try { saveBlob(await apiBlob(`/api/platform/metrics/export.csv?${exportParams}`), 'organic-evidence.csv'); } catch (error) { toast('error', String(error).replace('Error: ', '')); } setBusy(false); }
  function applyView(id: string) { const view = views.find(item => item.id === id); if (!view) return; const savedScope = String(view.config.siteScope || 'all'); const savedRange = Number(view.config.range); setSource(String(view.config.source || 'all')); setSiteScope(savedScope === 'all' || savedScope === 'workspace' || sites.some(site => site.id === savedScope) ? savedScope : 'all'); setQuery(String(view.config.query || '')); setRange((savedRange === 7 || savedRange === 90 ? savedRange : 30) as InsightRange); }
  function changeSiteScope(next: SiteScope) { setSiteScope(next); setSource('all'); }
  const connected = overview?.integrations.filter(integration => integration.status === 'connected').reduce((sum, integration) => sum + integration.count, 0) || 0;
  const fresh = overview?.freshness.filter(row => renderedAt - new Date(row.observed_at).getTime() < 2 * 86_400_000).length || 0;
  const freshnessTotal = overview?.freshness.length || 0;
  const forecasts = overview?.forecasts.filter(item => source === 'all' || item.source === source) || [];
  const exportParams = new URLSearchParams({
    ...Object.fromEntries(Object.entries(siteFilters(siteScope)).map(([key, value]) => [key, String(value)])),
    ...(source === 'all' ? {} : { source }),
    from: new Date(renderedAt - range * 86_400_000).toISOString(),
  });

  return <div className="ops-page intelligence-page">
    <header className="ops-page-header"><div><span className="eyebrow"><Sparkles size={13}/> Evidence, joined</span><h1>Unified intelligence</h1><p>See what changed for one website or the whole workspace, what each signal measures and what to investigate next.</p></div><div className="header-actions"><button className="btn btn-secondary" onClick={() => setGuideOpen(true)}><CircleHelp size={14}/> How to read this</button><button className="btn btn-secondary" disabled={busy} onClick={exportView}><Download size={14}/> Export this view</button><button className="btn btn-primary" disabled={busy || !canManage} onClick={run}>{busy ? <RefreshCw className="spin" size={14}/> : <Play size={14}/>} Refresh sources</button></div></header>
    <section className="intelligence-reading-guide" aria-label="How to use unified intelligence"><div><Database/><span><strong>1. Check source and scope</strong><small>Every card names the system, page or segment and collection date.</small></span></div><div><BarChart3/><span><strong>2. Read direction in context</strong><small>The card explains whether higher, lower or simply different matters.</small></span></div><div><Lightbulb/><span><strong>3. Investigate, then act</strong><small>Use the suggested next step; a graph alone is not a recommendation.</small></span></div></section>
    <section className="intelligence-scope-panel" aria-label="Website scope"><div className="intelligence-scope-copy"><span><Waypoints size={16}/><small>Currently viewing</small><strong>{siteScopeLabel}</strong></span><p>{siteScopeDetail}</p></div><label><span>Filter by website</span><select value={siteScope} onChange={event => changeSiteScope(event.target.value)}><option value="all">All sites · portfolio view</option><optgroup label="Individual websites">{sites.map(site => <option key={site.id} value={site.id}>{site.name} · {site.domain}</option>)}</optgroup><option value="workspace">Workspace-wide / unassigned</option></select></label></section>
    <section className="intelligence-controls"><div className="ops-segment"><span>Date range</span>{([7, 30, 90] as InsightRange[]).map(days => <button key={days} className={range === days ? 'active' : ''} onClick={() => setRange(days)}>{days} days</button>)}</div><select aria-label="Saved view" value="" onChange={event => applyView(event.target.value)}><option value="">Saved views…</option>{views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}</select><button className="btn btn-ghost btn-sm" onClick={saveCurrentView}><Save size={12}/> Save view</button></section>
    <section className="intel-hero-grid"><div className="intel-score"><div className="orb"><Radar/><strong>{connected}</strong><span>live sources</span></div><div><span className="eyebrow">Data confidence</span><h2>{freshnessTotal > 0 && fresh === freshnessTotal ? 'All connected evidence is current' : freshnessTotal ? `${fresh} of ${freshnessTotal} sources are current` : 'No evidence sources have reported yet'}</h2><p>“Current” means the source reported within 48 hours. There are {metrics.length.toLocaleString()} observations in this {range}-day view; freshness does not guarantee accuracy.</p></div></div><div className="intel-proof"><ShieldCheck/><div><small>What this proves</small><strong>{overview?.content_actions.find(item => item.status === 'verified')?.count || 0} verified changes</strong><span>{overview?.work_items.filter(item => item.status === 'done').reduce((sum, item) => sum + item.count, 0) || 0} completed actions retain evidence. Other graphs show correlation, not proof of cause.</span></div></div></section>
    <section className="source-ribbon"><button className={source === 'all' ? 'active' : ''} onClick={() => setSource('all')}><Sparkles/><span><strong>All evidence</strong><small>{metrics.length.toLocaleString()} observations in {siteScopeLabel.toLowerCase()}</small></span></button>{overview?.freshness.map(row => { const meta = sourceMeaning(row.source); const Icon = meta.icon; const age = renderedAt - new Date(row.observed_at).getTime(); return <button key={row.source} className={`${source === row.source ? 'active' : ''} ${meta.color}`} onClick={() => setSource(row.source)} title={meta.meaning}><Icon/><span><strong>{meta.label}</strong><small>{age < 86_400_000 ? 'Reported today' : `Last reported ${Math.floor(age / 86_400_000)} days ago`} · {row.observations} readings</small></span><i className={age < 2 * 86_400_000 ? 'fresh' : 'stale'}/></button>; })}</section>
    {!!forecasts.length && <section><div className="section-heading intel-section-heading"><div><span className="eyebrow"><TrendingUp size={12}/> Explainable outlook · {siteScopeLabel}</span><h2>30-day baseline estimates</h2><p>A straight-line continuation of additive daily totals for this website scope—not a target or a promise. Rates, rankings and technical scores are deliberately excluded.</p></div><button className="btn btn-ghost btn-sm" onClick={() => setGuideOpen(true)}><Info size={13}/> Forecast method</button></div><div className="forecast-grid">{forecasts.slice(0, 4).map(item => { const meaning = metricMeaning(item.metric); return <article key={`${item.source}:${item.metric}`}><span>{sourceMeaning(item.source).label} · {siteScopeLabel}</span><h3>{meaning.label}</h3><div className="forecast-values"><span><small>Latest daily total</small><strong>{formatForecastValue(item.current, item.unit)}</strong></span><span><small>30-day estimate</small><strong>{formatForecastValue(item.forecast, item.unit)}</strong></span></div><p>{formatForecastValue(item.lower, item.unit)}–{formatForecastValue(item.upper, item.unit)} is the model’s 90% uncertainty band.</p><i className={item.daily_slope >= 0 ? 'up' : 'down'}>{item.daily_slope >= 0 ? '+' : ''}{formatForecastValue(item.daily_slope, item.unit)} per day in the fitted trend</i><footer><Clock3 size={12}/>{item.history_days} daily totals used · {siteScopeLabel}</footer></article>; })}</div></section>}
    <section className="ops-card"><div className="ops-card-head intel-metrics-head"><div><span className="eyebrow">Metric dictionary · {siteScopeLabel}</span><h2>Current signals and their meaning</h2><p>Each card shows the website, newest reading, source and measurement scope. Its mini-chart never mixes observations from different sites.</p></div><span>{filtered.length} current signals</span></div><div className="ops-toolbar"><div className="ops-search"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter metrics, websites, pages or definitions…"/></div><span className="result-count">Showing {Math.min(filtered.length, 36)} of {filtered.length}</span></div><div className="metric-gallery">{filtered.slice(0, 36).map(metric => { const series = groups.get(metricSeriesKey(metric)) || []; const sourceMeta = sourceMeaning(metric.source); const meaning = metricMeaning(metric.metric); const Icon = sourceMeta.icon; const website = metricSiteLabel(metric); return <article key={metricReadingKey(metric)}><header><span className={`metric-source ${sourceMeta.color}`}><Icon size={14}/>{sourceMeta.label}</span><time dateTime={metric.observed_at}>{new Date(metric.observed_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</time></header><h3>{meaning.label}</h3><strong>{formatValue(metric)}</strong><p className="metric-meaning">{meaning.meaning}</p><div className="metric-context"><div className="metric-scope"><span>Website</span><b title={website}>{website}</b></div><div className="metric-scope"><span>Measurement scope</span><b title={metric.dimension || 'Whole source'}>{metric.dimension || 'Whole source'}</b></div></div><Series rows={series.filter(row => row.dimension === metric.dimension)} meaning={meaning}/><div className="metric-next-step"><Lightbulb size={13}/><span><strong>What to do</strong>{meaning.action}</span></div><footer><span><ShieldCheck size={11}/> Source retained</span><span>{meaning.direction === 'up' ? 'Higher usually helps' : meaning.direction === 'down' ? 'Lower usually helps' : 'Interpret in context'}</span></footer></article>; })}{!filtered.length && <div className="ops-empty"><Activity/><h3>No observations for {siteScopeLabel}</h3><p>{siteScope === 'all' ? 'Connect a source or broaden the date and source filters.' : `No evidence is attached to ${siteScopeLabel}. Assign an integration to this website, or switch back to All sites.`}</p><div><Link className="btn btn-secondary btn-sm" to="/integrations">Manage integrations</Link>{siteScope !== 'all' && <button className="btn btn-ghost btn-sm" onClick={() => changeSiteScope('all')}>View all sites</button>}</div></div>}</div></section>
    {guideOpen && <Modal onClose={() => setGuideOpen(false)} size="xl" className="intelligence-guide-modal" eyebrow="Unified intelligence guide" title="Turn graphs into defensible decisions" description="A compact reference for freshness, scopes, trends, forecasts and every connected evidence source." icon={<CircleHelp/>} footer={<button className="btn btn-primary" onClick={() => setGuideOpen(false)}>Got it</button>}><div className="intelligence-guide-layout"><section><h3>Read every card in this order</h3><ol><li><strong>Source and date</strong><span>Confirm where the number came from and when it was collected.</span></li><li><strong>Metric and unit</strong><span>Read the plain-English definition. Similar names from different systems can mean different things.</span></li><li><strong>Scope</strong><span>A scope may be a page, device, keyword, cache status, bot or the whole source.</span></li><li><strong>Trend</strong><span>The mini-chart connects retained readings; its vertical scale changes per card and must not be compared visually across cards.</span></li><li><strong>Next step</strong><span>Investigate the suggested cause before publishing a fix. Movement does not prove causation.</span></li></ol></section><section><h3>Forecasts, honestly</h3><div className="forecast-explainer"><TrendingUp/><p><strong>What it is</strong>A linear fit through additive daily totals, projected 30 days forward after at least seven days of data. Rates, scores, rankings and latency are excluded because summing their scopes is misleading.</p><p><strong>What the band means</strong>The displayed lower–upper range is a 90% residual uncertainty band. Wider means less stable history.</p><p><strong>What it is not</strong>It is not seasonality-aware, a business target, or proof that the current direction will continue.</p></div></section><section className="guide-source-section"><h3>Evidence sources in this workspace</h3><div>{Object.entries(SOURCE_META).map(([key, meta]) => { const Icon = meta.icon; const connectedSource = overview?.freshness.find(row => row.source === key); return <article key={key}><Icon/><span><strong>{meta.label}</strong><small>{meta.meaning}</small></span><em className={connectedSource ? 'connected' : ''}>{connectedSource ? 'Has evidence' : 'No evidence yet'}</em></article>; })}</div></section></div></Modal>}
  </div>;
}
