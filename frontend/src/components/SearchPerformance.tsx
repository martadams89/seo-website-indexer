import { useEffect, useState, useCallback } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import { api, type PerformanceResponse, type EnginePerformance } from '../api';
import { MetricChart, StatCard } from './Charts';
import { useApp } from '../AppContext';

const RANGES = [
  { label: '7d', days: 7 },
  { label: '28d', days: 28 },
  { label: '90d', days: 90 },
  { label: '365d', days: 365 },
];

type Metric = 'clicks' | 'impressions' | 'ctr' | 'position';
const METRICS: Array<{ id: Metric; label: string }> = [
  { id: 'clicks', label: 'Clicks' },
  { id: 'impressions', label: 'Impressions' },
  { id: 'ctr', label: 'CTR' },
  { id: 'position', label: 'Avg position' },
];

const fmtInt = (n: number) => Math.round(n).toLocaleString();
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtPos = (n: number) => n.toFixed(1);

function EngineView({ data, metric }: { data: EnginePerformance; metric: Metric }) {
  if (!data.available) {
    return <div className="empty-note">{data.reason ?? 'No data available.'}</div>;
  }
  if (data.series.length === 0) {
    return <div className="empty-note">No search data returned for this range yet (Google lags ~2 days; new properties take time to populate).</div>;
  }
  const points = data.series.map(s => ({ date: s.date, value: s[metric] }));
  const fmt = metric === 'ctr' ? fmtPct : metric === 'position' ? fmtPos : fmtInt;
  const color = metric === 'position' ? 'var(--warn)' : 'var(--accent, #7c6cf5)';

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: 12 }}>
        <StatCard label="Clicks" value={fmtInt(data.totals.clicks)} />
        <StatCard label="Impressions" value={fmtInt(data.totals.impressions)} />
        <StatCard label="CTR" value={fmtPct(data.totals.ctr)} />
        <StatCard label="Avg position" value={fmtPos(data.totals.position)} />
      </div>
      <MetricChart points={points} format={fmt} color={color} />
      <div className="two-col" style={{ marginTop: 14 }}>
        <div>
          <h4 className="panel-title">Top queries</h4>
          {data.queries.length === 0 ? <div className="empty-note">No query data.</div> : (
            <div className="table-scroll" style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table className="mini-table">
                <thead><tr><th>Query</th><th>Clicks</th><th>Impr.</th><th>CTR</th><th>Pos.</th></tr></thead>
                <tbody>
                  {data.queries.map((q, i) => (
                    <tr key={i}>
                      <td>{q.query}</td><td>{fmtInt(q.clicks)}</td><td>{fmtInt(q.impressions)}</td>
                      <td>{fmtPct(q.ctr)}</td><td>{q.position ? fmtPos(q.position) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <h4 className="panel-title">Top pages</h4>
          {data.pages.length === 0 ? <div className="empty-note">No page data.</div> : (
            <div className="table-scroll" style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table className="mini-table">
                <thead><tr><th>Page</th><th>Clicks</th><th>Impr.</th><th>CTR</th></tr></thead>
                <tbody>
                  {data.pages.map((p, i) => (
                    <tr key={i}>
                      <td className="cell-url">{p.page.replace(/^https?:\/\/[^/]+/, '') || '/'}</td>
                      <td>{fmtInt(p.clicks)}</td><td>{fmtInt(p.impressions)}</td><td>{fmtPct(p.ctr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function SearchPerformance({ siteId }: { siteId: string }) {
  const { toast } = useApp();
  const [days, setDays] = useState(28);
  const [engine, setEngine] = useState<'google' | 'bing'>('google');
  const [metric, setMetric] = useState<Metric>('clicks');
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    try { setData(await api.getPerformance(siteId, d)); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Failed to load performance'); }
    setLoading(false);
  }, [siteId, toast]);

  useEffect(() => { load(days); }, [load, days]);

  const active = data ? (engine === 'google' ? data.google : data.bing) : null;

  return (
    <div className="panel">
      <div className="flex items-center gap-2" style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 className="panel-title" style={{ margin: 0 }}><BarChart3 size={14} /> Search performance</h3>
        <div className="flex gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="seg">
            {RANGES.map(r => (
              <button key={r.days} className={`seg-btn${days === r.days ? ' active' : ''}`} onClick={() => setDays(r.days)}>{r.label}</button>
            ))}
          </div>
          <div className="seg">
            <button className={`seg-btn${engine === 'google' ? ' active' : ''}`} onClick={() => setEngine('google')}>
              Google{data && !data.google.available ? ' ·' : ''}
            </button>
            <button className={`seg-btn${engine === 'bing' ? ' active' : ''}`} onClick={() => setEngine('bing')}>
              Bing{data && !data.bing.available ? ' ·' : ''}
            </button>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => load(days)} disabled={loading} title="Refresh">
            <RefreshCw size={12} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      <div className="seg" style={{ marginBottom: 12 }}>
        {METRICS.map(m => (
          <button key={m.id} className={`seg-btn${metric === m.id ? ' active' : ''}`} onClick={() => setMetric(m.id)}>{m.label}</button>
        ))}
      </div>

      {loading ? <div className="empty-note">Loading {engine === 'google' ? 'Search Console' : 'Bing Webmaster'} data…</div>
        : active ? <EngineView data={active} metric={metric} />
        : <div className="empty-note">No data.</div>}

      <p className="text-dim" style={{ fontSize: 11, marginTop: 10 }}>
        Google data lags ~2 days and covers ~16 months; Bing history is shorter. Metrics come straight from the
        Search Console and Bing Webmaster APIs — this is the same data as their dashboards, in one place.
      </p>
    </div>
  );
}
