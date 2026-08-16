import { useCallback, useEffect, useState } from 'react';
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Bell, Bot, CheckCircle2,
  CircleAlert, Cloud, Globe2, MousePointerClick, Play, PlugZap, RefreshCw,
  Search, ShieldCheck, Sparkles, Trash2, Unlock, XCircle, Zap,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Link, useLocation } from 'react-router-dom';
import { api, type CommandCenter, type PlatformOverview, type UrlFailureCheck, type UrlFailureRecord, type WorkItem } from '../api';
import { useApp, useToast } from '../AppContext';
import { useAuth } from '../auth/AuthGate';
import { QuotaWidget } from '../components/QuotaWidget';
import { useWorkspace } from '../workspace/WorkspaceContext';

const PROVIDER_LABEL: Record<string, string> = {
  openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini',
  perplexity: 'Perplexity', xai: 'Grok', brave: 'Brave Search',
};

function ScoreRing({ value }: { value: number }) {
  return (
    <div className="command-score-ring" style={{ '--score': `${value * 3.6}deg` } as React.CSSProperties}>
      <div><strong>{value}</strong><span>health</span></div>
    </div>
  );
}

function Delta({ value, suffix = '%' }: { value: number | null; suffix?: string }) {
  if (value === null) return <span className="metric-delta neutral">Awaiting history</span>;
  const up = value >= 0;
  return (
    <span className={`metric-delta ${up ? 'up' : 'down'}`}>
      {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{Math.abs(value)}{suffix}
    </span>
  );
}

function VisibilitySparkline({ points }: { points: Array<{ visibility: number }> }) {
  if (points.length < 2) return <div className="spark-empty">Run checks again to build a trend</div>;
  const width = 320; const height = 84;
  const path = points.map((point, index) => {
    const x = index / Math.max(points.length - 1, 1) * width;
    const y = height - point.visibility / 100 * (height - 10) - 5;
    return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg className="visibility-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="AI visibility trend">
      <defs><linearGradient id="visibility-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--violet)" stopOpacity=".35" /><stop offset="1" stopColor="var(--violet)" stopOpacity="0" /></linearGradient></defs>
      <path d={`${path} L${width},${height} L0,${height} Z`} fill="url(#visibility-fill)" />
      <path d={path} fill="none" stroke="var(--violet)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function Dashboard() {
  const [renderedAt] = useState(() => Date.now());
  const { status, sites, runs, logs, refresh } = useApp();
  const { user } = useAuth();
  const { active } = useWorkspace();
  const location = useLocation();
  const canOperate = !!active?.permissions?.manage_sites;
  const toast = useToast();
  const [center, setCenter] = useState<CommandCenter | null>(null);
  const [platform, setPlatform] = useState<PlatformOverview | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [activation, setActivation] = useState({ prompts: 0, reports: 0 });
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [runError, setRunError] = useState('');
  const [failures, setFailures] = useState<UrlFailureRecord[]>([]);
  const [failureChecks, setFailureChecks] = useState<Record<string, UrlFailureCheck>>({});
  const [failureBusy, setFailureBusy] = useState<string | null>(null);

  const loadCenter = useCallback(async () => {
    const [nextCenter, nextFailures, nextPlatform, nextWork, prompts, reports] = await Promise.all([api.getCommandCenter(), api.getUrlFailures(), api.getPlatformOverview(), api.getWorkItems({ limit: 20 }), api.getAiPrompts(), api.getReportTemplates()]);
    setCenter(nextCenter); setFailures(nextFailures); setPlatform(nextPlatform); setWorkItems(nextWork);
    setActivation({ prompts: prompts.length, reports: reports.length });
  }, []);

  useEffect(() => { loadCenter().catch(() => null); }, [loadCenter, active?.id]);
  useEffect(() => {
    if (new URLSearchParams(location.search).get('focus') === 'failures') {
      setTimeout(() => document.getElementById('submission-failures')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    }
  }, [location.search, failures.length]);

  const failureKey = (failure: UrlFailureRecord) => `${failure.site_id}\n${failure.api}\n${failure.url}`;
  const siteNames = Object.fromEntries(sites.map(site => [site.id, site.name]));

  async function checkFailure(failure: UrlFailureRecord) {
    const key = failureKey(failure); setFailureBusy(key);
    try { const result = await api.checkUrlFailure(failure); setFailureChecks(value => ({ ...value, [key]: result })); }
    catch (error) { toast('error', String(error).replace('Error: ', '')); }
    setFailureBusy(null);
  }

  async function clearFailure(failure?: UrlFailureRecord) {
    if (!confirm(failure ? 'Clear this failure so the next indexing run can retry it?' : `Clear all ${failures.length} failure records in this workspace?`)) return;
    const key = failure ? failureKey(failure) : 'all'; setFailureBusy(key);
    try {
      const result = await api.clearUrlFailures(failure ? { siteId: failure.site_id, url: failure.url, api: failure.api } : {});
      toast('success', `${result.cleared} failure record${result.cleared === 1 ? '' : 's'} cleared; the next run can retry them.`);
      setFailureChecks({}); await loadCenter();
    } catch (error) { toast('error', String(error).replace('Error: ', '')); }
    setFailureBusy(null);
  }

  async function triggerRun(dryRun = false) {
    setRunError(''); setRunning(true);
    try {
      await api.triggerRun(dryRun ? { skipGoogle: true, skipIndexNow: true } : {});
      toast('success', dryRun ? 'Audit run started' : 'Submission run started');
      setTimeout(() => { refresh(); loadCenter().catch(() => null); }, 1500);
    } catch (error) { const message = String(error).replace('Error: ', ''); setRunError(message); toast('error', message); }
    setRunning(false);
  }

  async function stopRun() {
    setStopping(true); setRunError('');
    try { await api.stopRun(); toast('info', 'Stop requested'); setTimeout(refresh, 1200); }
    catch (error) { const message = String(error).replace('Error: ', ''); setRunError(message); toast('error', message); }
    setStopping(false);
  }

  async function releaseLock() {
    if (!confirm('Release the persistent run lock? Only do this if a previous run crashed.')) return;
    setUnlocking(true);
    try { await api.releaseLock(); toast('success', 'Run lock released'); setTimeout(refresh, 800); }
    catch (error) { toast('error', String(error).replace('Error: ', '')); }
    setUnlocking(false);
  }

  const isRunning = !!status?.scheduler.running;
  const showReleaseLock = !!status?.scheduler.lock && !isRunning;
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';
  const metrics = center?.metrics;
  const integrations = center?.integrations;
  const priorityAction = center?.actions[0];
  const activeWork = workItems.filter(item => !['done', 'dismissed'].includes(item.status));
  const freshSources = platform?.freshness.filter(row => renderedAt - new Date(row.observed_at).getTime() < 2 * 86_400_000).length ?? 0;
  const activationSteps = [
    { done: !!status?.auth.authenticated, label: 'Connect a Google account', to: '/settings?tab=accounts' },
    { done: sites.length > 0, label: 'Add your first site', to: '/sites' },
    { done: !!platform?.integrations.length, label: 'Connect outcome or delivery evidence', to: '/integrations' },
    { done: activation.prompts > 0, label: 'Define your buyer-question set', to: '/citations' },
    { done: activation.reports > 0, label: 'Create a client-ready report', to: '/reports' },
  ];

  return (
    <div className="command-center">
      <section className="command-hero">
        <div className="command-hero-copy">
          <div className="eyebrow"><Sparkles size={13} /> {active?.name ?? 'Workspace'} command centre</div>
          <h1>{greeting}, {user.name?.split(' ')[0] || 'there'}.</h1>
          <p>One operating view for indexation, search demand, answer-engine visibility and the work that matters next.</p>
          <div className="command-actions">
            {isRunning ? (
              <button className="btn btn-danger" disabled={stopping || !canOperate} onClick={stopRun}>
                {stopping ? <><span className="spinner" /> Stopping…</> : <><XCircle size={15} /> Stop active run</>}
              </button>
            ) : (
              <button className="btn btn-primary btn-command" disabled={running || !status?.auth.authenticated || sites.length === 0 || !canOperate} onClick={() => triggerRun(false)}><Play size={15} /> Run workspace</button>
            )}
            <button className="btn btn-secondary" disabled={running || sites.length === 0 || !canOperate} onClick={() => triggerRun(true)}><Zap size={14} /> Audit only</button>
            <button className="btn btn-ghost" onClick={() => { refresh(); loadCenter().catch(() => null); }}><RefreshCw size={14} /> Refresh</button>
            {showReleaseLock && <button className="btn btn-ghost" disabled={unlocking || !canOperate} onClick={releaseLock}><Unlock size={14} /> Release lock</button>}
          </div>
        </div>
        <div className="command-score-block">
          <ScoreRing value={center?.score.overall ?? 0} />
          <div className="score-breakdown">
            <span><i style={{ width: `${center?.score.indexation ?? 0}%` }} />Indexation <b>{center?.score.indexation ?? '—'}</b></span>
            <span><i style={{ width: `${center?.score.aiVisibility ?? 0}%` }} />AI visibility <b>{center?.score.aiVisibility ?? '—'}</b></span>
            <span><i style={{ width: `${center?.score.agentReadiness ?? 0}%` }} />Agent ready <b>{center?.score.agentReadiness ?? '—'}</b></span>
            <span><i style={{ width: `${center?.score.operations ?? 0}%` }} />Operations <b>{center?.score.operations ?? '—'}</b></span>
          </div>
        </div>
      </section>

      {runError && <div className="alert alert-error mb-4"><div className="alert-content">{runError}</div></div>}
      {!status?.auth.authenticated && <div className="alert alert-warn mb-4"><div className="alert-content"><strong>Connect Google to start operating.</strong> Add a workspace or personal account in <Link to="/settings?tab=accounts">Settings</Link>.</div></div>}

      {activationSteps.some(step => !step.done) && <details className="onboarding-checklist" open={activationSteps.filter(step=>step.done).length<3}><summary><span><Sparkles size={14}/><strong>First useful loop</strong><small>{activationSteps.filter(step=>step.done).length}/{activationSteps.length} ready</small></span><div><i style={{width:`${activationSteps.filter(step=>step.done).length/activationSteps.length*100}%`}}/></div></summary><div>{activationSteps.map((step,index)=><Link key={step.label} to={step.to} className={step.done?'done':''}><span>{step.done?<CheckCircle2/>:index+1}</span><strong>{step.label}</strong><ArrowRight/></Link>)}</div></details>}

      <section className="command-metrics" aria-label="Workspace metrics">
        <Link to="/analytics" className="command-metric"><span className="metric-icon cyan"><Globe2 size={17} /></span><div><small>Index coverage</small><strong>{metrics?.indexedRate ?? '—'}{metrics?.indexedRate != null ? '%' : ''}</strong><span>{(metrics?.indexed ?? 0).toLocaleString()} of {(metrics?.urls ?? 0).toLocaleString()} URLs</span></div></Link>
        <Link to="/analytics" className="command-metric"><span className="metric-icon green"><MousePointerClick size={17} /></span><div><small>Organic clicks · 7d</small><strong>{(metrics?.clicks7d ?? 0).toLocaleString()}</strong><Delta value={metrics?.clicksChange ?? null} /></div></Link>
        <Link to="/citations" className="command-metric"><span className="metric-icon violet"><Bot size={17} /></span><div><small>AI visibility</small><strong>{metrics?.aiVisibility ?? '—'}{metrics?.aiVisibility != null ? '%' : ''}</strong><Delta value={metrics?.aiChange ?? null} /></div></Link>
        <Link to="/actions" className="command-metric"><span className={`metric-icon ${activeWork.length ? 'amber' : 'green'}`}><ShieldCheck size={17} /></span><div><small>Owned actions</small><strong>{activeWork.length}</strong><span>{activeWork.filter(item => item.severity === 'critical').length ? `${activeWork.filter(item => item.severity === 'critical').length} critical now` : 'No critical actions'}</span></div></Link>
      </section>

      <section className="command-grid command-main-grid">
        <div className="command-panel action-panel">
          <div className="command-panel-head"><div><span className="eyebrow">Prioritized work</span><h2>Action centre</h2></div><Link to="/actions">{activeWork.length} owned <ArrowRight size={13} /></Link></div>
          {activeWork.length ? (
            <div className="action-stack">
              {activeWork.slice(0, 7).map((action, index) => (
                <Link to={action.deep_link || '/actions'} key={action.id} className={`action-row priority-${action.severity}`}><span className="action-rank">{String(index + 1).padStart(2, '0')}</span><span className="action-copy"><strong>{action.title}</strong><small>{action.description || `${action.source.replaceAll('_', ' ')} evidence`}</small></span><span className="action-count">{action.status === 'in_progress' ? '→' : '!'}</span><ArrowRight size={15} /></Link>
              ))}
            </div>
          ) : <div className="command-empty"><CheckCircle2 size={26} /><strong>You’re clear to grow</strong><span>No urgent operational actions. Keep monitoring movement and expanding prompt coverage.</span></div>}
        </div>

        <div className="command-panel ai-pulse-panel">
          <div className="command-panel-head"><div><span className="eyebrow">Generative discovery</span><h2>AI visibility pulse</h2></div><Link to="/citations">Open intelligence <ArrowRight size={13} /></Link></div>
          <div className="visibility-headline"><strong>{metrics?.aiVisibility ?? '—'}{metrics?.aiVisibility != null ? '%' : ''}</strong><div><span>of current answers cite you</span><Delta value={metrics?.aiChange ?? null} /></div></div>
          <VisibilitySparkline points={center?.ai.trend ?? []} />
          <div className="provider-pills">
            {(center?.ai.providers ?? []).map(provider => <span key={provider.provider}><i style={{ '--provider-score': `${provider.visibility}%` } as React.CSSProperties} />{PROVIDER_LABEL[provider.provider] ?? provider.provider}<b>{provider.visibility}%</b></span>)}
            {!center?.ai.providers.length && <span className="muted-pill">Connect a provider to establish your baseline</span>}
          </div>
        </div>
      </section>

      <section className="command-grid command-secondary-grid">
        <div className="command-panel">
          <div className="command-panel-head"><div><span className="eyebrow">Search demand</span><h2>Portfolio momentum</h2></div><Link to="/analytics">All analytics <ArrowRight size={13} /></Link></div>
          <div className="momentum-list">
            {center?.movers.length ? center.movers.map(site => <Link to={`/analytics/${site.site_id}`} key={site.site_id} className="momentum-row"><span className="site-monogram">{site.name.slice(0, 1).toUpperCase()}</span><span><strong>{site.name}</strong><small>{site.clicks.current.toLocaleString()} clicks · {site.impressions.current.toLocaleString()} impressions</small></span><Delta value={Math.round(site.clicks.changePct)} /></Link>) : <div className="command-empty compact"><Activity size={22} /><strong>No performance history yet</strong><span>Run the workspace to pull Search Console and Bing rollups.</span></div>}
          </div>
        </div>

        <div className="command-panel">
          <div className="command-panel-head"><div><span className="eyebrow">Data plane</span><h2>Connections</h2></div><Link to="/integrations">Manage <ArrowRight size={13} /></Link></div>
          <div className="connection-grid">
            <Link to="/settings?tab=accounts" className={integrations?.google ? 'connected' : ''}><Cloud size={17} /><span><strong>Google</strong><small>{integrations?.google ? `${integrations.google} account${integrations.google === 1 ? '' : 's'}` : 'Connect account'}</small></span><i /></Link>
            <Link to="/settings?tab=keys" className={integrations?.bing ? 'connected' : ''}><Globe2 size={17} /><span><strong>Bing</strong><small>{integrations?.bing ? `${integrations.bing} account${integrations.bing === 1 ? '' : 's'}` : 'Not connected'}</small></span><i /></Link>
            <Link to="/settings?tab=keys" className={integrations?.aiProviders ? 'connected' : ''}><Sparkles size={17} /><span><strong>Answer engines</strong><small>{integrations?.aiProviders ? `${integrations.aiProviders} live` : 'Add API keys'}</small></span><i /></Link>
            <Link to="/settings?tab=notifications" className={integrations?.notifications ? 'connected' : ''}><Bell size={17} /><span><strong>Notifications</strong><small>{integrations?.notifications ? `${integrations.notifications} channels` : 'Choose a route'}</small></span><i /></Link>
          </div>
          {!!platform?.integrations.length && <div className="connection-tip"><PlugZap size={14} /><span>{platform.integrations.filter(item => item.status === 'connected').reduce((sum, item) => sum + item.count, 0)} operational connections · {freshSources}/{platform.freshness.length} evidence sources fresh</span></div>}
          {priorityAction?.kind === 'integration' && <div className="connection-tip"><PlugZap size={14} /><span>{priorityAction.description}</span></div>}
        </div>
      </section>

      {failures.length > 0 && (
        <section className="command-panel failure-panel" id="submission-failures">
          <div className="command-panel-head"><div><span className="eyebrow danger">Needs intervention</span><h2>Submission failures</h2><p>Check live reachability, clear repaired records, then retry on the next run.</p></div><button className="btn btn-secondary btn-sm" disabled={failureBusy === 'all' || !canOperate} onClick={() => clearFailure()}><Trash2 size={12} /> Clear all</button></div>
          <div className="failure-list">
            {failures.slice(0, 20).map(failure => {
              const key = failureKey(failure); const result = failureChecks[key];
              return <div className="failure-row" key={key}><CircleAlert size={16} /><span><strong title={failure.url}>{failure.url}</strong><small>{siteNames[failure.site_id] ?? failure.site_id} · {failure.api.replaceAll('_', ' ')} · {failure.fail_count} attempts{result && <> · <b className={result.ok ? 'text-ok' : 'text-error'}>{result.ok ? `${result.status} reachable` : result.status ? `${result.status} ${result.statusText ?? ''}` : result.error ?? 'unreachable'}</b></>}</small></span><div><button className="btn btn-secondary btn-sm" disabled={failureBusy === key || !canOperate} onClick={() => checkFailure(failure)}><Search size={12} /> Check</button><button className="btn btn-ghost btn-sm" disabled={failureBusy === key || !canOperate} onClick={() => clearFailure(failure)}><Trash2 size={12} /></button></div></div>;
            })}
          </div>
        </section>
      )}

      <section className="command-grid command-secondary-grid">
        <div className="command-panel">
          <div className="command-panel-head"><div><span className="eyebrow">Operations</span><h2>Recent runs</h2></div><span className="schedule-chip"><Zap size={11} /> {status?.scheduler.cronSchedule ?? 'Not scheduled'}</span></div>
          <div className="run-timeline">
            {runs.slice(0, 5).map(run => <div key={run.id}><span className={`run-dot ${run.status}`} /><span><strong>{run.total_submitted} submitted</strong><small>{formatDistanceToNow(new Date(run.started_at), { addSuffix: true })} · {run.trigger}{run.total_failed ? ` · ${run.total_failed} failed` : ''}</small></span></div>)}
            {!runs.length && <div className="command-empty compact"><Play size={20} /><strong>No runs yet</strong><span>Your first audit will appear here.</span></div>}
          </div>
        </div>
        <div className="command-panel">
          <div className="command-panel-head"><div><span className="eyebrow">Live system</span><h2>Activity stream</h2></div><Link to="/logs">View all <ArrowRight size={13} /></Link></div>
          <div className="activity-stream">{logs.slice(0, 8).map((log, index) => <div key={log.id ?? index}><span className={`activity-dot ${log.level}`} /><time>{log.created_at?.slice(11, 16) ?? 'now'}</time><p>{log.message}</p></div>)}{!logs.length && <div className="command-empty compact">Waiting for activity…</div>}</div>
        </div>
      </section>

      <div className="command-quota"><QuotaWidget siteNames={siteNames} /></div>
    </div>
  );
}
