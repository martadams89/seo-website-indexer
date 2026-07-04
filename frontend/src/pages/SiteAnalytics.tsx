import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Activity, FileText, Gauge, Radar, Send, Stethoscope, UploadCloud, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, type SiteAnalytics, type LlmsAudit, type HygieneReport } from '../api';
import { Sparkline, FunnelBar, StatCard } from '../components/Charts';
import { SearchPerformance } from '../components/SearchPerformance';
import { useApp } from '../AppContext';

export default function SiteAnalyticsPage() {
  const { siteId = '' } = useParams();
  const { toast, status } = useApp();
  const [data, setData] = useState<SiteAnalytics | null>(null);
  const [llms, setLlms] = useState<LlmsAudit | null>(null);
  const [llmsLoading, setLlmsLoading] = useState(false);
  const [llmsTab, setLlmsTab] = useState<'live' | 'generated' | 'robots'>('live');
  const [hygiene, setHygiene] = useState<HygieneReport | null>(null);
  const [hygieneLoading, setHygieneLoading] = useState(false);
  const [crawl, setCrawl] = useState<{ available: boolean; reason?: string; issues: Array<{ url: string; code?: number; issues: string[] }> } | null>(null);
  const [crawlLoading, setCrawlLoading] = useState(false);
  const [bingQuota, setBingQuota] = useState<{ DailyQuota: number; MonthlyQuota: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cruxMsg, setCruxMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await api.getSiteAnalytics(siteId)); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Failed to load'); }
  }, [siteId, toast]);

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
                : !site.google_account_id ? 'This site has no linked Google account (IndexNow only) — assign one in the site’s Configuration tab'
                : 'Submit new & changed URLs to the Google Indexing API'
            }
            onClick={() => act('google-submit',
              () => api.triggerRun({ siteIds: [siteId], skipIndexNow: true, skipBing: true }),
              'Google submission run triggered — watch Live Logs for progress')}>
            <Send size={12} /> <span className="hide-mobile">Submit to Google</span>
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy === 'bing-submit'}
            onClick={() => act('bing-submit', () => api.bingSubmit(siteId), 'Submitted to Bing Webmaster')}>
            <Send size={12} /> <span className="hide-mobile">Submit to Bing</span>
          </button>
          <button className="btn btn-primary btn-sm" disabled={busy === 'submit-both'}
            title="Submit to Google (Indexing API run) and Bing (Webmaster) in one action"
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
        <StatCard label="Google-submitted" value={snapshot.urls_google} />
        <StatCard label="IndexNow-submitted" value={snapshot.urls_indexnow} />
        <StatCard label="Stale" value={snapshot.urls_stale} tone={snapshot.urls_stale ? 'warn' : undefined} />
        <StatCard label="With schema" value={snapshot.urls_with_schema} />
      </div>

      <div className="two-col">
        <div className="panel">
          <h3 className="panel-title">Coverage funnel</h3>
          <FunnelBar stages={[
            { label: 'Sitemap', value: snapshot.urls_total, color: 'var(--info)' },
            { label: 'Submitted', value: snapshot.urls_submitted, color: 'var(--accent, #7c6cf5)' },
            { label: 'Google', value: snapshot.urls_google, color: 'var(--warn)' },
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
              <thead><tr><th>URL</th><th>Changed</th><th>Last inspected</th><th>State</th></tr></thead>
              <tbody>
                {freshness.map(f => (
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
          <h3 className="panel-title" style={{ color: 'var(--error)' }}>Failing URLs ({failures.length})</h3>
          <div className="table-scroll" style={{ maxHeight: 220, overflowY: 'auto' }}>
            <table className="mini-table">
              <thead><tr><th>URL</th><th>API</th><th>Fails</th><th>Last failure</th></tr></thead>
              <tbody>
                {failures.map((f, i) => (
                  <tr key={i}>
                    <td className="cell-url">{f.url.replace(/^https?:\/\/[^/]+/, '')}</td>
                    <td><span className="badge badge-warn">{f.api}</span></td>
                    <td style={{ fontWeight: 600 }}>{f.fail_count}</td>
                    <td>{new Date(f.last_failed_at + 'Z').toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-dim" style={{ fontSize: 11, marginTop: 6 }}>
            Details of each failure are in the run logs around the timestamp shown.
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
                <thead><tr><th>URL</th><th>HTTP</th><th>Issues</th></tr></thead>
                <tbody>
                  {crawl.issues.map((c, i) => (
                    <tr key={i}>
                      <td className="cell-url">{c.url.replace(/^https?:\/\/[^/]+/, '') || '/'}</td>
                      <td>{c.code ?? '—'}</td>
                      <td>{c.issues.length ? c.issues.map(x => <span key={x} className="badge badge-warn" style={{ marginRight: 3 }}>{x}</span>) : <span className="text-dim">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : <div className="empty-note" style={{ marginTop: 10 }}>{crawl.reason}</div>)}
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
                <thead><tr><th>URL</th><th>Issue</th><th>Detail</th></tr></thead>
                <tbody>
                  {hygiene.issues.map((i, n) => (
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
