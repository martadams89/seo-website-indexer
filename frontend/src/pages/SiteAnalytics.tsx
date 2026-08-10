import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Activity, FileText, Gauge, Radar, Send, Stethoscope, UploadCloud, CheckCircle2, AlertTriangle, Bot, XCircle, MinusCircle, ExternalLink } from 'lucide-react';
import { api, type SiteAnalytics, type LlmsAudit, type HygieneReport, type AgentReadiness, type ApiError } from '../api';
import { Sparkline, FunnelBar, StatCard } from '../components/Charts';
import { SearchPerformance } from '../components/SearchPerformance';
import { useSort, SortTh } from '../components/SortableTable';
import { useApp } from '../AppContext';

export default function SiteAnalyticsPage() {
  const { siteId = '' } = useParams();
  const navigate = useNavigate();
  const { toast, status } = useApp();
  const [data, setData] = useState<SiteAnalytics | null>(null);
  const [llms, setLlms] = useState<LlmsAudit | null>(null);
  const [llmsLoading, setLlmsLoading] = useState(false);
  const [llmsTab, setLlmsTab] = useState<'live' | 'generated' | 'robots'>('live');
  const [hygiene, setHygiene] = useState<HygieneReport | null>(null);
  const [hygieneLoading, setHygieneLoading] = useState(false);
  const [agent, setAgent] = useState<AgentReadiness | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [crawl, setCrawl] = useState<{ available: boolean; reason?: string; issues: Array<{ url: string; code?: number; issues: string[] }> } | null>(null);
  const [crawlLoading, setCrawlLoading] = useState(false);
  const [bingQuota, setBingQuota] = useState<{ DailyQuota: number; MonthlyQuota: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cruxMsg, setCruxMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.getSiteAnalytics(siteId)); }
    catch (e) {
      // A 404 here means this site doesn't belong to the currently active
      // workspace (most often: the user switched workspace while this page
      // was open) — bounce back to the list instead of showing a broken page.
      if ((e as ApiError).status === 404) { navigate('/analytics', { replace: true }); return; }
      toast('error', e instanceof Error ? e.message : 'Failed to load');
    }
  }, [siteId, toast, navigate]);

  useEffect(() => { load(); }, [load]);

  async function loadLlms() {
    setLlmsLoading(true);
    try { setLlms(await api.getLlmsAudit(siteId)); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'llms.txt audit failed'); }
    setLlmsLoading(false);
  }

  async function runHygiene() {
    setHygieneLoading(true);
    try { setHygiene(await api.runHygiene(siteId)); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Hygiene check failed'); }
    setHygieneLoading(false);
  }

  async function loadAgent() {
    setAgentLoading(true);
    try { setAgent(await api.getAgentReadiness(siteId)); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Agent-readiness check failed'); }
    setAgentLoading(false);
  }

  async function loadCrawlIssues() {
    setCrawlLoading(true);
    try { setCrawl(await api.getCrawlIssues(siteId)); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Crawl issues fetch failed'); }
    setCrawlLoading(false);
  }

  async function act(name: string, fn: () => Promise<unknown>, okMsg: string) {
    setBusy(name);
    try { await fn(); toast('success', okMsg); }
    catch (e) { toast('error', e instanceof Error ? e.message : `${name} failed`); }
    setBusy(null);
  }

  async function submitBoth() {
    setBusy('submit-both');
    try {
      const r = await api.submitCombined(siteId, ['google', 'bing']);
      const parts: string[] = [];
      if (r.google) parts.push(r.google.error ? `Google: ${r.google.error}` : 'Google run triggered');
      if (r.bing) parts.push(r.bing.error ? `Bing: ${r.bing.error}` : `Bing: ${r.bing.submitted ?? 0} submitted`);
      const anyError = !!(r.google?.error || r.bing?.error);
      toast(anyError ? 'warning' : 'success', parts.join(' · ') || 'Nothing submitted');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Combined submit failed');
    }
    setBusy(null);
  }

  // Sortable data tables (hooks must run before the early return below).
  const freshSort = useSort((data?.freshness ?? []) as unknown as Array<Record<string, unknown>>);
  const failSort = useSort((data?.failures ?? []) as unknown as Array<Record<string, unknown>>, { key: 'fail_count', dir: 'desc' });
  const crawlSort = useSort((crawl?.issues ?? []) as unknown as Array<Record<string, unknown>>);
  const hygieneSort = useSort((hygiene?.issues ?? []) as unknown as Array<Record<string, unknown>>);

  if (!data) return <div className="page-loading">Loading site analytics…</div>;
  const { site, snapshot, trend, states, freshness, failures, crux } = data;
  const rate = snapshot.urls_total ? Math.round((snapshot.urls_indexed / snapshot.urls_total) * 100) : 0;
  const lastCrux = crux[crux.length - 1];

  return (
    <div>
      <div className="page-header">
        <div>
          <Link to="/analytics" className="back-link"><ArrowLeft size={13} /> Analytics</Link>
          <h1 className="page-title">{site.name}</h1>
          <p className="page-subtitle">{site.domain}</p>
        </div>
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-secondary btn-sm" disabled={busy === 'crux'}
            onClick={() => act('crux', async () => {
              const r = await api.refreshCrux(siteId);
              setCruxMsg('error' in r ? r.error : null);
              await load();
            }, 'Core Web Vitals refreshed')}>
            <Gauge size={12} /> <span className="hide-mobile">Refresh CWV</span>
          </button>
          <button className="btn btn-secondary btn-sm" disabled={busy === 'bing'}
            onClick={() => act('bing', async () => {
              const q = await api.getBingQuota(siteId);
              setBingQuota(q);
            }, 'Bing quota fetched')}>
            <Activity size={12} /> <span className="hide-mobile">Bing quota</span>
          </button>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy === 'google-submit' || !status?.auth.authenticated || !site.google_account_id}
            title={
              !status?.auth.authenticated ? 'Connect a Google account in Settings first'
                : !site.google_account_id ? 'This site has no linked Google account — assign one in the site’s Configuration tab'
                : 'Re-submit a changed sitemap and refresh Search Console URL Inspection data'
            }
            onClick={() => act('google-submit',
              () => api.triggerRun({ siteIds: [siteId], skipIndexNow: true, skipBing: true }),
              'Google sitemap and inspection run triggered — watch Live Logs for progress')}>
            <Send size={12} /> <span className="hide-mobile">Refresh Google</span>
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy === 'bing-submit'}
            onClick={() => act('bing-submit', () => api.bingSubmit(siteId), 'Submitted to Bing Webmaster')}>
            <Send size={12} /> <span className="hide-mobile">Submit to Bing</span>
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy === 'submit-both'}
            title="Refresh Google sitemap/inspection data and submit changed URLs to Bing"
            onClick={submitBoth}>
            <Send size={12} /> <span className="hide-mobile">Submit to both</span>
          </button>
        </div>
      </div>

      <SearchPerformance siteId={siteId} />

      {bingQuota && (
        <div className="empty-note" style={{ marginBottom: 16 }}>
          Bing URL submission quota — daily: <strong>{bingQuota.DailyQuota}</strong>, monthly: <strong>{bingQuota.MonthlyQuota}</strong>
        </div>
      )}

      <div className="stat-grid">
        <StatCard label="URLs in sitemap" value={snapshot.urls_total} />
        <StatCard label="Indexed" value={snapshot.urls_indexed} sub={`${rate}%`} tone="ok" />
        <StatCard label="GSC-inspected" value={snapshot.urls_google} />
        <StatCard label="IndexNow-submitted" value={snapshot.urls_indexnow} />
        <StatCard label="Stale" value={snapshot.urls_stale} tone={snapshot.urls_stale ? 'warn' : undefined} />
        <StatCard label="JSON-LD detected" value={snapshot.urls_with_schema} />
      </div>

      <div className="two-col">
        <div className="panel">
          <h3 className="panel-title">Coverage funnel</h3>
          <FunnelBar stages={[
            { label: 'Sitemap', value: snapshot.urls_total, color: 'var(--info)' },
            { label: 'Submitted', value: snapshot.urls_submitted, color: 'var(--accent, #7c6cf5)' },
            { label: 'Inspected', value: snapshot.urls_google, color: 'var(--warn)' },
            { label: 'Indexed', value: snapshot.urls_indexed, color: 'var(--ok)' },
          ]} />
          <h3 className="panel-title" style={{ marginTop: 18 }}>Indexed trend (60d)</h3>
          <Sparkline points={trend.map(t => t.urls_indexed)} width={280} height={48} />
        </div>

        <div className="panel">
          <h3 className="panel-title">GSC indexing states</h3>
          {states.length === 0 ? <div className="empty-note">No inspection data yet.</div> : (
            <table className="mini-table">
              <tbody>
                {states.map(s => (
                  <tr key={s.state}><td>{s.state}</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{s.count}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <h3 className="panel-title" style={{ marginTop: 18 }}><Gauge size={13} /> Core Web Vitals (p75)</h3>
          {lastCrux ? (
            <div className="cwv-row">
              <span className={`badge ${lastCrux.lcp_ms != null && lastCrux.lcp_ms <= 2500 ? 'badge-ok' : 'badge-warn'}`}>LCP {lastCrux.lcp_ms != null ? `${(lastCrux.lcp_ms / 1000).toFixed(1)}s` : '—'}</span>
              <span className={`badge ${lastCrux.inp_ms != null && lastCrux.inp_ms <= 200 ? 'badge-ok' : 'badge-warn'}`}>INP {lastCrux.inp_ms != null ? `${lastCrux.inp_ms}ms` : '—'}</span>
              <span className={`badge ${lastCrux.cls != null && lastCrux.cls <= 0.1 ? 'badge-ok' : 'badge-warn'}`}>CLS {lastCrux.cls ?? '—'}</span>
            </div>
          ) : (
            <div className="empty-note">
              {cruxMsg
                ? cruxMsg
                : 'No CrUX data yet — add a CrUX API key in Settings (enable the Chrome UX Report API first), then hit "Refresh CWV" above. Low-traffic origins aren\u2019t in Google\u2019s dataset at all.'}
            </div>
          )}
        </div>
      </div>

      {/* Freshness radar */}
      <div className="panel">
        <h3 className="panel-title"><Radar size={13} /> Freshness radar — changed since Google last looked ({freshness.length})</h3>
        {freshness.length === 0 ? <div className="empty-note">Nothing stale — Google has seen every change.</div> : (
          <div className="table-scroll" style={{ maxHeight: 260, overflowY: 'auto' }}>
            <table className="mini-table">
              <thead><tr>
                <SortTh label="URL" sortKey="url" sort={freshSort.sort} onSort={freshSort.requestSort} />
                <SortTh label="Changed" sortKey="last_seen_lastmod" sort={freshSort.sort} onSort={freshSort.requestSort} />
                <SortTh label="Last inspected" sortKey="gsc_last_inspected" sort={freshSort.sort} onSort={freshSort.requestSort} />
                <SortTh label="State" sortKey="gsc_indexing_state" sort={freshSort.sort} onSort={freshSort.requestSort} />
              </tr></thead>
              <tbody>
                {(freshSort.sorted as unknown as typeof freshness).map(f => (
                  <tr key={f.url}>
                    <td className="cell-url">{f.url.replace(/^https?:\/\/[^/]+/, '')}</td>
                    <td>{f.last_seen_lastmod?.slice(0, 10)}</td>
                    <td>{f.gsc_last_inspected?.slice(0, 10) ?? '—'}</td>
                    <td>{f.gsc_indexing_state ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Failing URLs */}
      {failures.length > 0 && (
        <div className="panel">
          <h3 className="panel-title" style={{ color: 'var(--error)' }}>Submission failures ({failures.length})</h3>
          <div className="table-scroll" style={{ maxHeight: 220, overflowY: 'auto' }}>
            <table className="mini-table">
              <thead><tr>
                <SortTh label="URL" sortKey="url" sort={failSort.sort} onSort={failSort.requestSort} />
                <SortTh label="API" sortKey="api" sort={failSort.sort} onSort={failSort.requestSort} />
                <SortTh label="Fails" sortKey="fail_count" sort={failSort.sort} onSort={failSort.requestSort} align="right" />
                <SortTh label="Last failure" sortKey="last_failed_at" sort={failSort.sort} onSort={failSort.requestSort} />
              </tr></thead>
              <tbody>
                {(failSort.sorted as unknown as typeof failures).map((f, i) => (
                  <tr key={i}>
                    <td className="cell-url">{f.url.replace(/^https?:\/\/[^/]+/, '')}</td>
                    <td><span className="badge badge-warn">{f.api}</span></td>
                    <td style={{ fontWeight: 600, textAlign: 'right' }}>{f.fail_count}</td>
                    <td>{new Date(f.last_failed_at + 'Z').toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-dim" style={{ fontSize: 11, marginTop: 6 }}>
            These are IndexNow or Bing submission failures for URLs in the current sitemap. JSON-LD detection is reported separately and is not schema validation.
          </div>
        </div>
      )}

      {/* Bing crawl issues (the "errors they find" surface) */}
      <div className="panel">
        <div className="flex items-center gap-2" style={{ justifyContent: 'space-between' }}>
          <h3 className="panel-title" style={{ margin: 0 }}><AlertTriangle size={13} /> Bing crawl issues</h3>
          <button className="btn btn-secondary btn-sm" disabled={crawlLoading} onClick={loadCrawlIssues}>
            {crawlLoading ? 'Checking…' : 'Fetch'}
          </button>
        </div>
        {crawl && (crawl.available ? (
          crawl.issues.length === 0 ? (
            <div className="empty-note" style={{ marginTop: 10 }}><CheckCircle2 size={12} /> Bing reports no crawl issues.</div>
          ) : (
            <div className="table-scroll" style={{ maxHeight: 260, overflowY: 'auto', marginTop: 10 }}>
              <table className="mini-table">
                <thead><tr>
                  <SortTh label="URL" sortKey="url" sort={crawlSort.sort} onSort={crawlSort.requestSort} />
                  <SortTh label="HTTP" sortKey="code" sort={crawlSort.sort} onSort={crawlSort.requestSort} align="right" />
                  <th>Issues</th>
                </tr></thead>
                <tbody>
                  {(crawlSort.sorted as unknown as typeof crawl.issues).map((c, i) => (
                    <tr key={i}>
                      <td className="cell-url">{c.url.replace(/^https?:\/\/[^/]+/, '') || '/'}</td>
                      <td style={{ textAlign: 'right' }}>{c.code ?? '—'}</td>
                      <td>{c.issues.length ? c.issues.map(x => <span key={x} className="badge badge-warn" style={{ marginRight: 3 }}>{x}</span>) : <span className="text-dim">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : <div className="empty-note" style={{ marginTop: 10 }}>{crawl.reason}</div>)}
      </div>

      {/* Agent readiness (isitagentready-style) */}
      <div className="panel">
        <div className="flex items-center gap-2" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <h3 className="panel-title" style={{ margin: 0 }}><Bot size={13} /> Agent readiness</h3>
          <button className="btn btn-secondary btn-sm" onClick={loadAgent} disabled={agentLoading}>
            {agentLoading ? 'Scoring…' : agent ? 'Re-check' : 'Run check'}
          </button>
        </div>
        <div className="empty-note" style={{ marginTop: 10 }}>
          Live scan from <a href="https://isitagentready.com" target="_blank" rel="noopener noreferrer">isitagentready.com <ExternalLink size={10} /></a>
          {' '}— the actual tool, so the score never diverges from what you'd see there. Tracked over time; the local
          approximation is only used (and labelled) if that API is unreachable.
        </div>
        {agent && (() => {
          const cur = agent.current;
          const cats = [...new Set(cur.checks.map(c => c.category))];
          const failing = cur.checks.filter(c => c.status === 'fail');
          return (
          <div style={{ marginTop: 14 }}>
            <div className="agent-score-head">
              {cur.level !== null ? (
                <div className="agent-score-ring" style={{ ['--v' as string]: `${(cur.level / 5) * 100}%`, ['--c' as string]: levelColor(cur.level) }}>
                  <span className="agent-score-num">{cur.level}<small>/5</small></span>
                </div>
              ) : (
                <div className="agent-score-ring" style={{ ['--v' as string]: `${cur.score}%`, ['--c' as string]: scoreColor(cur.score) }}>
                  <span className="agent-score-num">{cur.score}<small>%</small></span>
                </div>
              )}
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{cur.levelName || `${cur.score}% ready`}</div>
                <div className="text-dim" style={{ fontSize: 12, marginBottom: 4 }}>
                  {cur.passed}/{cur.total} checks passing
                  {cur.source === 'local' && <span className="badge badge-warn" style={{ marginLeft: 8 }}>local fallback — isitagentready unreachable</span>}
                </div>
                <div className="agent-bar"><div className="agent-bar-fill" style={{ width: `${cur.score}%`, background: scoreColor(cur.score) }} /></div>
                {agent.history.length > 1 && (
                  <div style={{ marginTop: 8 }}>
                    <Sparkline points={agent.history.map(h => h.score)} width={280} height={40} stroke={scoreColor(cur.score)} />
                    <span className="text-dim" style={{ fontSize: 11 }}> score over {agent.history.length} snapshots</span>
                  </div>
                )}
              </div>
            </div>
            {failing.length > 0 && (
              <div className="agent-fix-note">
                <AlertTriangle size={12} /> {failing.length} check{failing.length === 1 ? '' : 's'} to fix: {failing.map(c => c.label).join(', ')}
              </div>
            )}
            {cats.map(cat => {
              const items = cur.checks.filter(c => c.category === cat);
              return (
                <div key={cat} style={{ marginTop: 14 }}>
                  <div className="agent-cat-label">{catLabel(cat)}</div>
                  <div className="agent-check-grid">
                    {items.map(c => (
                      <div key={c.id} className={`agent-check ${c.status}`}>
                        {c.status === 'pass' ? <CheckCircle2 size={13} /> : c.status === 'neutral' ? <MinusCircle size={13} /> : <XCircle size={13} />}
                        <div>
                          <div className="agent-check-label">{c.label}</div>
                          <div className="agent-check-detail">{c.detail || (c.status === 'neutral' ? 'Not applicable' : '')}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          );
        })()}
      </div>

      {/* llms.txt lifecycle */}
      <div className="panel">
        <div className="flex items-center gap-2" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <h3 className="panel-title" style={{ margin: 0 }}><FileText size={13} /> llms.txt &amp; robots.txt</h3>
          <div className="flex gap-2" style={{ alignItems: 'center' }}>
            <button className="btn btn-secondary btn-sm" onClick={loadLlms} disabled={llmsLoading}>
              {llmsLoading ? 'Auditing…' : 'Audit now'}
            </button>
            {!!site.geo_manage && (site.deploy_webhook_url || site.ftp_host) && (
              <button className="btn btn-primary btn-sm" disabled={busy === 'deploy'}
                onClick={() => {
                  if (!confirm('Deploy will REPLACE the live llms.txt and robots.txt with the generated versions shown below. If your live files are richer (hand-written), cancel and stay in monitor-only mode.')) return;
                  act('deploy', () => api.deployGeo(siteId).then(loadLlms), 'GEO files deployed');
                }}>
                <UploadCloud size={12} /> Deploy
              </button>
            )}
          </div>
        </div>
        <div className="empty-note" style={{ marginTop: 10 }}>
          {site.geo_manage
            ? ((site.deploy_webhook_url || site.ftp_host)
                ? 'Managed mode: the tool generates these files and deploys them on every run. Deploy replaces the live files.'
                : 'Managed mode, but no deployment method is set — edit this site on the Sites page and add a deploy webhook URL or FTP/SFTP credentials.')
            : 'Monitor-only (default): your live files are treated as the source of truth — the tool lints and freshness-checks them but never overwrites. If your llms.txt is hand-written and richer than the generated baseline, this is the mode you want. Enable managed mode in the site\u2019s settings only if you want the tool to own these files.'}
        </div>
        {llms && (
          <div style={{ marginTop: 12 }}>
            <div className="flex gap-2" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
              <span className={`badge ${llms.live.status === 200 ? 'badge-ok' : 'badge-error'}`}>llms.txt {llms.live.status === 200 ? 'live' : `HTTP ${llms.live.status || 'unreachable'}`}</span>
              <span className={`badge ${llms.liveFull ? 'badge-ok' : ''}`}>llms-full.txt {llms.liveFull ? 'live' : 'absent'}</span>
              <span className={`badge ${llms.robotsLive.status === 200 ? 'badge-ok' : 'badge-error'}`}>robots.txt {llms.robotsLive.status === 200 ? 'live' : 'missing'}</span>
              {site.geo_manage
                ? <span className={`badge ${llms.drift ? 'badge-warn' : 'badge-ok'}`}>{llms.drift ? 'DRIFT vs generated' : 'in sync'}</span>
                : <span className="badge">{llms.drift ? 'differs from generated baseline (expected — hand-maintained)' : 'matches generated baseline'}</span>}
              <span className={`badge ${llms.lint.ok ? 'badge-ok' : 'badge-warn'}`}>{llms.lint.ok ? <><CheckCircle2 size={11} /> lint clean</> : `${llms.lint.issues.length} lint issue${llms.lint.issues.length === 1 ? '' : 's'}`}</span>
            </div>
            {!llms.lint.ok && (
              <ul className="lint-issues">
                {llms.lint.issues.map((i, n) => <li key={n}><AlertTriangle size={11} /> {i}</li>)}
              </ul>
            )}
            <div className="flex gap-1" style={{ margin: '10px 0 6px' }}>
              {(['live', 'generated', 'robots'] as const).map(t => (
                <button key={t} className={`btn btn-sm ${llmsTab === t ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setLlmsTab(t)}>
                  {t === 'live' ? 'Live llms.txt' : t === 'generated' ? 'Generated' : 'robots.txt'}
                </button>
              ))}
            </div>
            <pre className="file-preview">{
              llmsTab === 'live' ? (llms.live.text || '(not served)') :
              llmsTab === 'generated' ? llms.generated :
              (llms.robotsLive.text || '(not served)')
            }</pre>
            <div className="text-dim" style={{ fontSize: 11, marginTop: 6 }}>
              {llms.lint.stats.bytes.toLocaleString()} bytes · {llms.lint.stats.links} links · {llms.lint.stats.sections} sections
            </div>
          </div>
        )}
      </div>

      {/* Hygiene */}
      <div className="panel">
        <div className="flex items-center gap-2" style={{ justifyContent: 'space-between' }}>
          <h3 className="panel-title" style={{ margin: 0 }}><Stethoscope size={13} /> Site hygiene</h3>
          <button className="btn btn-secondary btn-sm" onClick={runHygiene} disabled={hygieneLoading}>
            {hygieneLoading ? 'Checking…' : 'Run check'}
          </button>
        </div>
        {hygiene && (
          <div style={{ marginTop: 10 }}>
            {hygiene.issues.length === 0 ? (
              <div className="empty-note"><CheckCircle2 size={12} /> {hygiene.checked} URLs probed — no broken links or redirect chains.</div>
            ) : (
              <table className="mini-table">
                <thead><tr>
                  <SortTh label="URL" sortKey="url" sort={hygieneSort.sort} onSort={hygieneSort.requestSort} />
                  <SortTh label="Issue" sortKey="kind" sort={hygieneSort.sort} onSort={hygieneSort.requestSort} />
                  <th>Detail</th>
                </tr></thead>
                <tbody>
                  {(hygieneSort.sorted as unknown as typeof hygiene.issues).map((i, n) => (
                    <tr key={n}>
                      <td className="cell-url">{i.url.replace(/^https?:\/\/[^/]+/, '')}</td>
                      <td><span className={`badge ${i.kind === 'broken' ? 'badge-error' : 'badge-warn'}`}>{i.kind}</span></td>
                      <td style={{ fontSize: 11 }}>{i.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const AGENT_CAT_LABEL: Record<string, string> = {
  discoverability: 'Discoverability', discovery: 'Agent discovery',
  botAccessControl: 'Bot access control', contentAccessibility: 'Content accessibility',
  commerce: 'Commerce (agentic payments)', identity: 'Identity & auth',
  content: 'Structured content', protocol: 'Agent protocol', dns: 'DNS',
};
function catLabel(key: string): string {
  return AGENT_CAT_LABEL[key] || key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}
function scoreColor(score: number): string {
  if (score >= 80) return 'var(--ok)';
  if (score >= 50) return 'var(--warn)';
  return 'var(--error)';
}
// Level 0-5 ring uses the level fraction; the % score drives the bar/sparkline.
function levelColor(level: number | null): string {
  if (level === null) return 'var(--text-dim)';
  return level >= 4 ? 'var(--ok)' : level >= 2 ? 'var(--warn)' : 'var(--error)';
}
