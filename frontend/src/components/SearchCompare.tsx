import { useEffect, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, GitCompare } from 'lucide-react';
import { apiFetch } from '../api/client';
import { StatCard } from './Charts';
import './search-extras.css';

type Dimension = 'query' | 'page' | 'country' | 'device';
interface Totals { clicks: number; impressions: number; ctr: number; position: number }
interface Row { key: string; current: Totals; previous: Totals; click_change: number; position_change: number | null; status: 'new' | 'lost' | 'both' }
interface Comparison {
  period: { start: string; end: string };
  compared_with: { start: string; end: string; mode: 'previous' | 'year' };
  totals: { current: Totals; previous: Totals; change: { clicks: number; clicks_pct: number | null; impressions: number; impressions_pct: number | null; ctr_points: number; position: number } };
  gainers: Row[]; losers: Row[]; new_count: number; lost_count: number; note: string;
}

const pct = (v: number | null) => v === null ? 'no earlier data' : `${v > 0 ? '+' : ''}${v}%`;
const signed = (v: number, digits = 0) => `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
const LABEL: Record<Dimension, string> = { query: 'Query', page: 'Page', country: 'Country', device: 'Device' };

/** Compare a period with the one before or the same dates last year (OpenGSC-style period comparison). */
export function SearchCompare({ siteId }: { siteId: string }) {
  const [days, setDays] = useState(28);
  const [mode, setMode] = useState<'previous' | 'year'>('previous');
  const [dimension, setDimension] = useState<Dimension>('query');
  const [data, setData] = useState<Comparison | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    apiFetch<Comparison>(`/api/performance/${siteId}/compare?days=${days}&mode=${mode}&dimension=${dimension}&limit=15`)
      .then(d => { if (live) { setData(d); setError(''); } })
      .catch(e => { if (live) { setData(null); setError(String(e?.message ?? e).replace(/^Error: /, '')); } });
    return () => { live = false; };
  }, [siteId, days, mode, dimension]);

  const t = data?.totals;
  return (
    <section className="ops-card search-compare">
      <div className="ops-card-head">
        <div><span className="eyebrow"><GitCompare size={12} /> Period comparison</span><h2>What changed</h2></div>
        <div className="search-compare-controls">
          <select className="input" aria-label="Period" value={days} onChange={e => setDays(Number(e.target.value))}>
            {[7, 28, 90, 180].map(d => <option key={d} value={d}>Last {d} days</option>)}
          </select>
          <select className="input" aria-label="Compare with" value={mode} onChange={e => setMode(e.target.value as 'previous' | 'year')}>
            <option value="previous">vs previous period</option>
            <option value="year">vs same period last year</option>
          </select>
          <select className="input" aria-label="Break down by" value={dimension} onChange={e => setDimension(e.target.value as Dimension)}>
            {(Object.keys(LABEL) as Dimension[]).map(d => <option key={d} value={d}>By {LABEL[d].toLowerCase()}</option>)}
          </select>
        </div>
      </div>
      {error && <div className="alert alert-info"><div className="alert-content">{error}</div></div>}
      {data && t && (
        <>
          <p className="card-intro">{data.period.start} to {data.period.end}, compared with {data.compared_with.start} to {data.compared_with.end}.</p>
          <div className="stat-grid">
            <StatCard label="Clicks" value={t.current.clicks} sub={`${signed(t.change.clicks)} (${pct(t.change.clicks_pct)})`} tone={(t.change.clicks_pct ?? 0) < -10 ? 'warn' : (t.change.clicks_pct ?? 0) > 10 ? 'ok' : undefined} />
            <StatCard label="Impressions" value={t.current.impressions} sub={`${signed(t.change.impressions)} (${pct(t.change.impressions_pct)})`} />
            <StatCard label="CTR" value={`${t.current.ctr.toFixed(2)}%`} sub={`${signed(t.change.ctr_points, 2)} points`} />
            <StatCard label="Average position" value={t.current.position.toFixed(1)} sub={t.change.position <= 0 ? `${Math.abs(t.change.position).toFixed(1)} places better` : `${t.change.position.toFixed(1)} places worse`} tone={t.change.position > 1 ? 'warn' : undefined} />
          </div>
          <div className="search-compare-tables">
            {([['Biggest gains', data.gainers, ArrowUpRight], ['Biggest losses', data.losers, ArrowDownRight]] as const).map(([title, rows, Icon]) => (
              <div key={title}>
                <h3><Icon size={14} /> {title}</h3>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>{LABEL[dimension]}</th><th>Clicks</th><th>Change</th><th>Position</th></tr></thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.key}>
                          <td className="search-compare-key" title={r.key}>{r.key}{r.status !== 'both' && <span className={`badge badge-${r.status === 'new' ? 'ok' : 'warn'}`}>{r.status}</span>}</td>
                          <td>{r.current.clicks.toLocaleString()} <small className="text-dim">from {r.previous.clicks.toLocaleString()}</small></td>
                          <td className={r.click_change >= 0 ? 'text-ok' : 'text-warn'}>{signed(r.click_change)}</td>
                          <td>{r.current.position ? r.current.position.toFixed(1) : '—'}{r.position_change !== null && <small className="text-dim"> ({signed(r.position_change, 1)})</small>}</td>
                        </tr>
                      ))}
                      {!rows.length && <tr><td colSpan={4}><small className="text-dim">Nothing to show.</small></td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
          <p className="ads-hint">{data.new_count} new and {data.lost_count} lost {LABEL[dimension].toLowerCase()} entries. {data.note}</p>
        </>
      )}
      {!data && !error && <div className="page-loading">Comparing periods…</div>}
    </section>
  );
}
