import { useEffect, useState, useCallback } from 'react';
import { BarChart3, RefreshCw, TrendingUp, TrendingDown, Minus, Bell, X, LineChart } from 'lucide-react';
import { api, type PerformanceResponse, type EnginePerformance } from '../api';
import { MetricChart, StatCard } from './Charts';
import { useApp } from '../AppContext';

const RANGES = [
  { label: '7d', days: 7 }, { label: '28d', days: 28 }, { label: '90d', days: 90 }, { label: '365d', days: 365 },
];
type Metric = 'clicks' | 'impressions' | 'ctr' | 'position';
const METRICS: Array<{ id: Metric; label: string }> = [
  { id: 'clicks', label: 'Clicks' }, { id: 'impressions', label: 'Impressions' },
  { id: 'ctr', label: 'CTR' }, { id: 'position', label: 'Avg position' },
];
type Breakdown = 'query' | 'page' | 'country' | 'device';
const BREAKDOWNS: Array<{ id: Breakdown; label: string }> = [
  { id: 'query', label: 'Queries' }, { id: 'page', label: 'Pages' }, { id: 'country', label: 'Countries' }, { id: 'device', label: 'Devices' },
];

const fmtInt = (n: number) => Math.round(n).toLocaleString();
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtPos = (n: number) => n.toFixed(1);

type Delta = { metric: string; current: number; previous: number; changePct: number };

// For position, DOWN in number is GOOD — so colour logic is metric-aware.
function DeltaChip({ delta }: { delta?: Delta }) {
  if (!delta || (delta.previous === 0 && delta.current === 0)) return null;
  const isPosition = delta.metric === 'position';
  const improved = isPosition ? delta.changePct < 0 : delta.changePct > 0;
  const flat = Math.abs(delta.changePct) < 0.5;
  const color = flat ? 'var(--text-dim)' : improved ? 'var(--ok)' : 'var(--error)';
  const Icon = flat ? Minus : (delta.changePct > 0 ? TrendingUp : TrendingDown);
  return (
    <span className="delta-chip" style={{ color }} title="vs previous 7 days">
      <Icon size={10} /> {Math.abs(delta.changePct).toFixed(0)}%
    </span>
  );
}

export function SearchPerformance({ siteId }: { siteId: string }) {
  const { toast } = useApp();
  const [days, setDays] = useState(28);
  const [engine, setEngine] = useState<'google' | 'bing'>('google');
  const [metric, setMetric] = useState<Metric>('clicks');
  const [breakdown, setBreakdown] = useState<Breakdown>('query');
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [deltas, setDeltas] = useState<Delta[]>([]);
  const [dim, setDim] = useState<{ available: boolean; reason?: string; rows: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number }> } | null>(null);
  const [trendQuery, setTrendQuery] = useState<string | null>(null);
  const [trend, setTrend] = useState<Array<{ day: string; position: number; clicks: number }> | null>(null);
  const [tracked, setTracked] = useState<Array<{ id: number; query: string; last_position: number | null }>>([]);

  const load = useCallback(async (d: number, eng: 'google' | 'bing') => {
    setLoading(true);
    try {
      const [perf, del, trk] = await Promise.all([
        api.getPerformance(siteId, d),
        api.getPerfDeltas(siteId, eng).catch(() => ({ deltas: [] as Delta[] })),
        api.getTrackedQueries(siteId).catch(() => []),
      ]);
      setData(perf);
      setDeltas(del.deltas);
      setTracked(trk);
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Failed to load performance'); }
    setLoading(false);
  }, [siteId, toast]);

  useEffect(() => { load(days, engine); }, [load, days, engine]);

  // Country/device breakdowns come from a separate GSC dimension call.
  useEffect(() => {
    if (breakdown === 'country' || breakdown === 'device') {
      setDim(null);
      api.getPerfDimension(siteId, days, breakdown).then(setDim).catch(() => setDim({ available: false, reason: 'Failed to load', rows: [] }));
    }
  }, [breakdown, siteId, days]);

  async function openTrend(q: string) {
    setTrendQuery(q); setTrend(null);
    try { const r = await api.getQueryTrend(siteId, q); setTrend(r.points); }
    catch { setTrend([]); }
  }

  async function toggleTrack(q: string) {
    const existing = tracked.find(t => t.query === q);
    if (existing) await api.removeTrackedQuery(existing.id).catch(() => null);
    else await api.addTrackedQuery(siteId, q).catch(() => null);
    setTracked(await api.getTrackedQueries(siteId).catch(() => tracked));
  }

  async function refresh() {
    setLoading(true);
    try { await api.snapshotPerf(siteId); } catch { /* best effort */ }
    load(days, engine);
  }

  const active: EnginePerformance | null = data ? (engine === 'google' ? data.google : data.bing) : null;
  const deltaFor = (m: string) => deltas.find(d => d.metric === m);
  const isTracked = (q: string) => tracked.some(t => t.query === q);

  const fmt = metric === 'ctr' ? fmtPct : metric === 'position' ? fmtPos : fmtInt;
  const chartColor = metric === 'position' ? 'var(--warn)' : 'var(--accent, #7c6cf5)';

  return (
    <div className="panel">
      <div className="flex items-center gap-2" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 className="panel-title" style={{ margin: 0 }}><BarChart3 size={14} /> Search performance</h3>
        <div className="flex gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="seg">{RANGES.map(r => <button key={r.days} className={`seg-btn${days === r.days ? ' active' : ''}`} onClick={() => setDays(r.days)}>{r.label}</button>)}</div>
          <div className="seg">
            <button className={`seg-btn${engine === 'google' ? ' active' : ''}`} onClick={() => setEngine('google')}>Google</button>
            <button className={`seg-btn${engine === 'bing' ? ' active' : ''}`} onClick={() => setEngine('bing')}>Bing</button>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading} title="Refresh cached rollups"><RefreshCw size={12} className={loading ? 'spin' : ''} /></button>
        </div>
      </div>

      {loading ? <div className="empty-note">Loading {engine === 'google' ? 'Search Console' : 'Bing Webmaster'} data…</div>
        : !active?.available ? <div className="empty-note">{active?.reason ?? 'No data.'}</div>
        : active.series.length === 0 ? <div className="empty-note">No search data for this range yet (Google lags ~2 days; new properties take time).</div>
        : (
        <>
          <div className="stat-grid" style={{ marginBottom: 8 }}>
            <StatCard label="Clicks" value={fmtInt(active.totals.clicks)} />
            <StatCard label="Impressions" value={fmtInt(active.totals.impressions)} />
            <StatCard label="CTR" value={fmtPct(active.totals.ctr)} />
            <StatCard label="Avg position" value={fmtPos(active.totals.position)} />
          </div>
          <div className="wow-row">
            <span className="wow-label">vs prev 7d:</span>
            <span>Clicks <DeltaChip delta={deltaFor('clicks')} /></span>
            <span>Impr. <DeltaChip delta={deltaFor('impressions')} /></span>
            <span>CTR <DeltaChip delta={deltaFor('ctr')} /></span>
            <span>Pos. <DeltaChip delta={deltaFor('position')} /></span>
          </div>

          <div className="seg" style={{ margin: '12px 0' }}>
            {METRICS.map(m => <button key={m.id} className={`seg-btn${metric === m.id ? ' active' : ''}`} onClick={() => setMetric(m.id)}>{m.label}</button>)}
          </div>
          <MetricChart points={active.series.map(s => ({ date: s.date, value: s[metric] }))} format={fmt} color={chartColor} />

          {/* Breakdowns */}
          <div className="flex items-center gap-2" style={{ margin: '16px 0 8px', flexWrap: 'wrap' }}>
            <div className="seg">{BREAKDOWNS.map(b => <button key={b.id} className={`seg-btn${breakdown === b.id ? ' active' : ''}`} onClick={() => setBreakdown(b.id)}>{b.label}</button>)}</div>
            {(breakdown === 'country' || breakdown === 'device') && <span className="text-dim" style={{ fontSize: 11 }}>Google only — Bing exposes no public traffic-by-{breakdown} API.</span>}
          </div>

          {(breakdown === 'query' || breakdown === 'page') ? (
            <div className="table-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table className="mini-table">
                <thead><tr>
                  <th>{breakdown === 'query' ? 'Query' : 'Page'}</th><th>Clicks</th><th>Impr.</th><th>CTR</th><th>Pos.</th>{breakdown === 'query' && <th />}
                </tr></thead>
                <tbody>
                  {(breakdown === 'query' ? active.queries : active.pages).map((r, i) => {
                    const label = 'query' in r ? r.query : r.page.replace(/^https?:\/\/[^/]+/, '') || '/';
                    return (
                      <tr key={i}>
                        <td className={breakdown === 'page' ? 'cell-url' : undefined}>{label}</td>
                        <td>{fmtInt(r.clicks)}</td><td>{fmtInt(r.impressions)}</td><td>{fmtPct(r.ctr)}</td><td>{r.position ? fmtPos(r.position) : '—'}</td>
                        {breakdown === 'query' && 'query' in r && (
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="btn btn-ghost btn-sm" title="Position trend" onClick={() => openTrend(r.query)}><LineChart size={12} /></button>
                            <button className="btn btn-ghost btn-sm" title={isTracked(r.query) ? 'Untrack (stop alerts)' : 'Track for drop alerts'} onClick={() => toggleTrack(r.query)}>
                              <Bell size={12} style={{ color: isTracked(r.query) ? 'var(--accent, #7c6cf5)' : 'var(--text-dim)' }} />
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : dim === null ? <div className="empty-note">Loading…</div>
            : !dim.available ? <div className="empty-note">{dim.reason}</div>
            : dim.rows.length === 0 ? <div className="empty-note">No {breakdown} data for this range.</div>
            : (
            <div className="table-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table className="mini-table">
                <thead><tr><th style={{ textTransform: 'capitalize' }}>{breakdown}</th><th>Clicks</th><th>Impr.</th><th>CTR</th><th>Pos.</th></tr></thead>
                <tbody>
                  {dim.rows.map((r, i) => (
                    <tr key={i}><td style={{ textTransform: breakdown === 'country' ? 'uppercase' : 'capitalize' }}>{r.key}</td><td>{fmtInt(r.clicks)}</td><td>{fmtInt(r.impressions)}</td><td>{fmtPct(r.ctr)}</td><td>{fmtPos(r.position)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tracked.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <h4 className="panel-title"><Bell size={12} /> Tracked queries ({tracked.length})</h4>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                {tracked.map(t => (
                  <span key={t.id} className="tracked-chip">
                    <button className="tracked-chip-name" onClick={() => openTrend(t.query)}>{t.query}</button>
                    {t.last_position != null && <span className="text-dim" style={{ fontSize: 10 }}>#{t.last_position.toFixed(1)}</span>}
                    <button className="tracked-chip-x" onClick={() => toggleTrack(t.query)} title="Untrack"><X size={10} /></button>
                  </span>
                ))}
              </div>
              <p className="text-dim" style={{ fontSize: 11, marginTop: 6 }}>Tracked queries raise an alert if their Google position drops ≥3 places (checked after each run).</p>
            </div>
          )}
        </>
      )}

      <p className="text-dim" style={{ fontSize: 11, marginTop: 10 }}>
        Live from the Search Console &amp; Bing Webmaster APIs. Google lags ~2 days (~16 months history); Bing is shorter.
        Week-over-week deltas and query trends come from cached rollups, so they fill in over the first few days.
      </p>

      {/* Query position-over-time */}
      {trendQuery && (
        <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && setTrendQuery(null)}>
          <div className="modal" style={{ maxWidth: 560 }}>
            <div className="flex items-center gap-2" style={{ justifyContent: 'space-between' }}>
              <h3 className="modal-title" style={{ margin: 0 }}>Position trend — "{trendQuery}"</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setTrendQuery(null)}><X size={14} /></button>
            </div>
            {trend === null ? <div className="empty-note" style={{ marginTop: 12 }}>Loading…</div>
              : trend.length < 2 ? <div className="empty-note" style={{ marginTop: 12 }}>Not enough history yet — trends build over the days after this query first shows.</div>
              : (
              <div style={{ marginTop: 12 }}>
                <div className="text-dim" style={{ fontSize: 11, marginBottom: 4 }}>Average Google position (lower is better)</div>
                <MetricChart points={trend.map(p => ({ date: p.day, value: p.position }))} format={fmtPos} color="var(--warn)" height={160} />
                <div className="flex gap-2" style={{ marginTop: 10 }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => toggleTrack(trendQuery)}>
                    <Bell size={12} /> {isTracked(trendQuery) ? 'Untrack' : 'Track for alerts'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
