import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Bell, BellOff, ChevronRight, TrendingUp, TrendingDown, Minus, Activity, ArrowDownRight } from 'lucide-react';
import { api, type AnalyticsOverview, type AlertRow, type SiteMover, type SiteMoverMetric } from '../api';
import { Sparkline, FunnelBar, StatCard } from '../components/Charts';
import { useApp } from '../AppContext';

const SEVERITY_COLOR: Record<string, string> = { info: 'var(--info)', warn: 'var(--warn)', error: 'var(--error)' };

const fmtInt = (n: number) => Math.round(n).toLocaleString();

// Metric-aware WoW delta cell. `lowerIsBetter` flips colour for position.
function MoverDelta({ m, lowerIsBetter = false, label }: { m: SiteMoverMetric; lowerIsBetter?: boolean; label: string }) {
  const flat = Math.abs(m.changePct) < 0.5 || (m.current === 0 && m.previous === 0);
  const improved = lowerIsBetter ? m.changePct < 0 : m.changePct > 0;
  const color = flat ? 'var(--text-dim)' : improved ? 'var(--ok)' : 'var(--error)';
  const Icon = flat ? Minus : m.changePct > 0 ? TrendingUp : TrendingDown;
  return (
    <div className="mover-metric">
      <span className="mover-metric-label">{label}</span>
      <span className="mover-metric-val">{lowerIsBetter ? m.current.toFixed(1) : fmtInt(m.current)}</span>
      <span className="mover-metric-delta" style={{ color }}><Icon size={10} /> {flat ? '—' : `${Math.abs(m.changePct).toFixed(0)}%`}</span>
    </div>
  );
}

export default function AnalyticsPage() {
  const { toast } = useApp();
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [movers, setMovers] = useState<SiteMover[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAcked, setShowAcked] = useState(false);

  const load = useCallback(async () => {
    try {
      const [overview, alertRows, moverRows] = await Promise.all([
        api.getAnalyticsOverview(),
        api.getAlerts(),
        api.getMovers().catch(() => [] as SiteMover[]),
      ]);
      setData(overview);
      setAlerts(alertRows);
      setMovers(moverRows);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to load analytics');
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  async function snapshot() {
    try {
      await api.snapshotStats();
      toast('success', 'Snapshot recorded');
      load();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Snapshot failed');
    }
  }

  async function ack(id: number) {
    await api.ackAlert(id).catch(() => null);
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, acked: 1 } : a));
  }

  const visibleAlerts = alerts.filter(a => showAcked || !a.acked);

  if (loading) return <div className="page-loading">Loading analytics…</div>;
  if (!data) return <div className="page-loading">No analytics data.</div>;

  const { totals, sites } = data;
  const indexRate = totals.urls_total ? Math.round((totals.urls_indexed / totals.urls_total) * 100) : 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Analytics</h1>
          <p className="page-subtitle">Index health across every site — funnels, trends and alerts</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={snapshot}>
          <RefreshCw size={12} /> <span className="hide-mobile">Snapshot now</span>
        </button>
      </div>

      {/* Portfolio totals */}
      <div className="stat-grid">
        <StatCard label="Sites" value={totals.sites} />
        <StatCard label="URLs tracked" value={totals.urls_total} />
        <StatCard label="Indexed" value={totals.urls_indexed} sub={`${indexRate}% of tracked`} tone="ok" />
        <StatCard label="Stale (changed since crawl)" value={totals.urls_stale} tone={totals.urls_stale > 0 ? 'warn' : undefined} />
        <StatCard label="Failing URLs" value={totals.failures} tone={totals.failures > 0 ? 'error' : undefined} />
        <StatCard label="Open alerts" value={totals.open_alerts} tone={totals.open_alerts > 0 ? 'warn' : undefined} />
      </div>

      {/* Per-site cards */}
      <h2 className="section-title"><TrendingUp size={14} /> Sites</h2>
      <div className="site-card-grid">
        {sites.map(s => {
          const rate = s.urls_total ? Math.round((s.urls_indexed / s.urls_total) * 100) : 0;
          return (
            <Link key={s.site_id} to={`/analytics/${s.site_id}`} className="site-card">
              <div className="site-card-head">
                <div>
                  <div className="site-card-name">{s.name}</div>
                  <div className="site-card-domain">{s.domain}</div>
                </div>
                <ChevronRight size={16} className="text-dim" />
              </div>
              <div className="site-card-body">
                <div className="site-card-rate">
                  <span className="site-card-rate-num" style={{ color: rate >= 70 ? 'var(--ok)' : rate >= 40 ? 'var(--warn)' : 'var(--error)' }}>{rate}%</span>
                  <span className="text-dim" style={{ fontSize: 11 }}>indexed</span>
                </div>
                <Sparkline points={s.trend.map(t => t.urls_indexed)} />
              </div>
              <FunnelBar stages={[
                { label: 'Sitemap', value: s.urls_total, color: 'var(--info)' },
                { label: 'Submitted', value: s.urls_submitted, color: 'var(--accent, #7c6cf5)' },
                { label: 'Indexed', value: s.urls_indexed, color: 'var(--ok)' },
              ]} />
              <div className="site-card-foot">
                {s.urls_stale > 0 && <span className="badge badge-warn">{s.urls_stale} stale</span>}
                {s.failures > 0 && <span className="badge badge-error">{s.failures} submission failures</span>}
                {s.urls_with_schema > 0 && <span className="badge">{s.urls_with_schema} with JSON-LD</span>}
              </div>
            </Link>
          );
        })}
      </div>

      {/* Search movers (WoW) */}
      {movers.length > 0 && (
        <>
          <h2 className="section-title" style={{ marginTop: 28 }}><Activity size={14} /> Search movers <span className="text-dim" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· Google, last 7d vs prior 7d</span></h2>
          <div className="movers-list">
            {movers.slice(0, 12).map(m => (
              <Link key={m.site_id} to={`/analytics/${m.site_id}`} className="mover-row">
                <div className="mover-site">
                  <div className="mover-site-name">{m.name}</div>
                  <div className="mover-site-domain">{m.domain}</div>
                </div>
                <div className="mover-metrics">
                  <MoverDelta m={m.clicks} label="Clicks" />
                  <MoverDelta m={m.impressions} label="Impr." />
                  <MoverDelta m={m.position} label="Pos." lowerIsBetter />
                </div>
                <ChevronRight size={15} className="text-dim mover-chevron" />
              </Link>
            ))}
          </div>
        </>
      )}

      {/* Alerts feed */}
      <div className="flex items-center gap-2" style={{ marginTop: 28, marginBottom: 10, justifyContent: 'space-between' }}>
        <h2 className="section-title" style={{ margin: 0 }}><Bell size={14} /> Alerts</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowAcked(s => !s)}>
          {showAcked ? <BellOff size={12} /> : <Bell size={12} />} {showAcked ? 'Hide acknowledged' : 'Show acknowledged'}
        </button>
      </div>
      {visibleAlerts.length === 0 ? (
        <div className="empty-note">No {showAcked ? '' : 'open '}alerts — all quiet.</div>
      ) : (
        <div className="alerts-list">
          {visibleAlerts.slice(0, 50).map(a => (
            <div key={a.id} className={`alert-row${a.acked ? ' acked' : ''}`}>
              <span className="alert-dot" style={{ background: SEVERITY_COLOR[a.severity] ?? 'var(--warn)' }} />
              <div className="alert-body">
                <div className="alert-msg">
                  {a.kind === 'query_drop' && <ArrowDownRight size={12} style={{ color: 'var(--error)', verticalAlign: 'middle', marginRight: 4 }} />}
                  {a.message}
                </div>
                <div className="alert-meta">{a.kind === 'query_drop' ? 'ranking drop' : a.kind} · {a.domain ?? 'all sites'} · {new Date(a.created_at + 'Z').toLocaleString()}</div>
              </div>
              {!a.acked && (
                <button className="btn btn-ghost btn-sm" onClick={() => ack(a.id)}>Ack</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
