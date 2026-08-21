import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Bot, CheckCircle2, FileBarChart, Globe2, ShieldCheck, Sparkles, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, type CommandCenter, type PlatformOverview, type ReportRun, type Site } from '../api';
import { useWorkspace } from '../workspace/WorkspaceContext';

/**
 * A focused, authenticated summary for executives and stakeholders.
 *
 * The persisted governance key keeps its historical `client_portal_*` name for
 * backwards compatibility, but this is deliberately not presented as a public
 * client portal: it shares the same authenticated workspace boundary as the app.
 */
export default function ExecutiveViewPage() {
  const { active } = useWorkspace();
  const [center, setCenter] = useState<CommandCenter | null>(null);
  const [platform, setPlatform] = useState<PlatformOverview | null>(null);
  const [governance, setGovernance] = useState<Record<string, string>>({});
  const [reports, setReports] = useState<ReportRun[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    const [commandCenter, overview, policy, reportRuns, trackedSites] = await Promise.all([
      api.getCommandCenter(), api.getPlatformOverview(), api.getGovernance(), api.getReportRuns(), api.getSites(),
    ]);
    setCenter(commandCenter);
    setPlatform(overview);
    setGovernance(policy);
    setReports(reportRuns);
    setSites(trackedSites);
    setReady(true);
  }, []);

  useEffect(() => {
    setReady(false);
    load().catch(() => setReady(true));
  }, [load, active?.id]);

  const brand = governance.brand_name || active?.name || 'Organic intelligence';
  const accent = /^#[0-9a-f]{6}$/i.test(governance.brand_accent || '') ? governance.brand_accent : '#7c5cff';
  const activeWork = platform?.work_items
    .filter(row => !['done', 'dismissed'].includes(row.status))
    .reduce((sum, row) => sum + row.count, 0) || 0;

  if (!ready) return <div className="page-loading">Opening executive view…</div>;

  if (governance.client_portal_enabled !== 'true') {
    return (
      <main className="client-portal disabled">
        <ShieldCheck />
        <h1>Executive view is not enabled</h1>
        <p>A workspace administrator can enable and brand it in Governance.</p>
        <Link className="btn btn-secondary" to="/"><ArrowLeft size={13} /> Return to workspace</Link>
      </main>
    );
  }

  return (
    <main className="client-portal" style={{ '--portal-accent': accent } as React.CSSProperties}>
      <header>
        <div className="portal-brand">
          <span><Sparkles /></span>
          <div><strong>{brand}</strong><small>Executive organic view</small></div>
        </div>
        <div>
          <span>Evidence refreshed {platform?.generated_at ? new Date(platform.generated_at).toLocaleString() : '—'}</span>
          <Link to="/"><ArrowLeft size={12} /> Operating workspace</Link>
        </div>
      </header>

      <section className="portal-hero">
        <div>
          <span>Executive organic health</span>
          <strong>{center?.score.overall ?? '—'}</strong>
          <p>{center?.score.overall == null
            ? 'Complete an indexing, AI visibility or agent-readiness measurement to establish health.'
            : 'One accountable view of search visibility, answer-engine discovery, delivery quality and completed work.'}</p>
        </div>
        <div className="portal-score-detail">
          <span><i style={{ width: `${center?.score.indexation ?? 0}%` }} />Indexation <b>{center?.score.indexation ?? '—'}</b></span>
          <span><i style={{ width: `${center?.score.aiVisibility ?? 0}%` }} />AI visibility <b>{center?.score.aiVisibility ?? '—'}</b></span>
          <span><i style={{ width: `${center?.score.operations ?? 0}%` }} />Operations <b>{center?.score.operations ?? '—'}</b></span>
        </div>
      </section>

      <section className="portal-metrics">
        <article><Globe2 /><span>Tracked estate<strong>{sites.length} sites</strong><small>{center?.metrics.urls || 0} known URLs</small></span></article>
        <article><TrendingUp /><span>Organic demand<strong>{(center?.metrics.clicks7d || 0).toLocaleString()}</strong><small>clicks in the last 7 days</small></span></article>
        <article><Bot /><span>AI visibility<strong>{center?.metrics.aiVisibility == null ? '—' : `${center.metrics.aiVisibility}%`}</strong><small>current share of cited answers</small></span></article>
        <article><CheckCircle2 /><span>Operations<strong>{activeWork}</strong><small>active evidence-backed actions</small></span></article>
      </section>

      <div className="portal-grid">
        <section>
          <header><div><span>Portfolio movement</span><h2>Search momentum</h2></div><Globe2 /></header>
          {center?.movers.map(site => (
            <div className="portal-row" key={site.site_id}>
              <span>{site.name}</span>
              <strong>{site.clicks.current.toLocaleString()} clicks</strong>
              <i className={site.clicks.changePct >= 0 ? 'up' : 'down'}>
                {site.clicks.changePct >= 0 ? '+' : ''}{site.clicks.changePct.toFixed(1)}%
              </i>
            </div>
          ))}
          {!center?.movers.length && <p>No movement history yet.</p>}
        </section>
        <section>
          <header><div><span>Proof delivered</span><h2>Recent reports</h2></div><FileBarChart /></header>
          {reports.slice(0, 6).map(run => (
            <div className="portal-row" key={run.id}>
              <span>Organic intelligence snapshot<small>{new Date(run.period_start).toLocaleDateString()}–{new Date(run.period_end).toLocaleDateString()}</small></span>
              <strong>{run.status}</strong>
            </div>
          ))}
          {!reports.length && <p>No report snapshots yet.</p>}
        </section>
      </div>

      <footer>
        <span>Data provenance and tenant boundaries are retained by Organic Command.</span>
        <span>{active?.name}</span>
      </footer>
    </main>
  );
}
