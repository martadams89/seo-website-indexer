import { useEffect, useState } from 'react';
import { BarChart3, MapPin, Phone, Search, Star } from 'lucide-react';
import { MetricChart, StatCard } from '../components/Charts';
import { errorMessage } from '../ads/api';
import { reviewsApi, type Performance, type ReviewLocation } from './api';

const METRICS: Array<{ id: keyof Performance['totals']; label: string }> = [
  { id: 'search_impressions', label: 'Search views' },
  { id: 'maps_impressions', label: 'Maps views' },
  { id: 'calls', label: 'Calls' },
  { id: 'website_clicks', label: 'Website clicks' },
  { id: 'direction_requests', label: 'Direction requests' },
  { id: 'messages', label: 'Messages' },
  { id: 'bookings', label: 'Bookings' },
];

const CHART: Array<{ id: 'impressions' | 'calls' | 'website_clicks' | 'direction_requests'; label: string }> = [
  { id: 'calls', label: 'Calls' },
  { id: 'website_clicks', label: 'Website clicks' },
  { id: 'direction_requests', label: 'Directions' },
  { id: 'impressions', label: 'Views' },
];

const change = (pct: number | null) => pct === null ? 'no earlier data' : `${pct > 0 ? '+' : ''}${pct}% vs previous period`;

export function ReviewsInsights({ locations, locationId, onPick }: { locations: ReviewLocation[]; locationId: string; onPick: (id: string) => void }) {
  const location = locations.find(l => l.id === locationId) ?? locations[0];
  const [days, setDays] = useState(28);
  const [perf, setPerf] = useState<Performance | null>(null);
  const [perfError, setPerfError] = useState('');
  const [metric, setMetric] = useState<(typeof CHART)[number]['id']>('calls');

  useEffect(() => {
    let live = true;
    reviewsApi.performance(location.id, days)
      .then(p => { if (live) { setPerf(p); setPerfError(''); } })
      .catch(e => { if (live) { setPerf(null); setPerfError(errorMessage(e)); } });
    return () => { live = false; };
  }, [location.id, days]);

  const s = location.stats;
  const maxBar = Math.max(1, ...Object.values(s.distribution));
  const trend = s.previous_30_days.average !== null && s.last_30_days.average !== null ? Math.round((s.last_30_days.average - s.previous_30_days.average) * 100) / 100 : null;

  return (
    <div className="ads-setup">
      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">Reputation</span><h2>{location.title ?? location.location_name}</h2></div>
          {locations.length > 1 && (
            <select className="input ads-account-select" aria-label="Location" value={location.id} onChange={e => onPick(e.target.value)}>
              {locations.map(l => <option key={l.id} value={l.id}>{l.title ?? l.location_name}</option>)}
            </select>
          )}
        </div>
        <div className="stat-grid">
          <StatCard label="Average rating" value={location.average_rating?.toFixed(2) ?? s.average?.toFixed(2) ?? '—'} sub={`${location.total_reviews ?? s.total} reviews on Google`} />
          <StatCard label="Last 30 days" value={s.last_30_days.reviews} sub={s.last_30_days.average !== null ? `avg ${s.last_30_days.average.toFixed(2)}${trend !== null ? ` (${trend >= 0 ? '+' : ''}${trend} vs prior 30)` : ''}` : 'no new reviews'} tone={trend !== null && trend < -0.2 ? 'warn' : undefined} />
          <StatCard label="Response rate (90 days)" value={s.response_rate_90d === null ? '—' : `${s.response_rate_90d}%`} sub={s.median_response_hours_90d !== null ? `median ${s.median_response_hours_90d < 48 ? `${s.median_response_hours_90d} h` : `${Math.round(s.median_response_hours_90d / 24)} days`} to reply` : undefined} tone={s.response_rate_90d !== null && s.response_rate_90d < 80 ? 'warn' : undefined} />
          <StatCard label="Unanswered" value={s.unreplied} sub={`${s.unreplied_negative} rated 1–3 stars`} tone={s.unreplied_negative ? 'warn' : undefined} />
        </div>
        <div className="review-distribution" aria-label="Star distribution">
          {(['5', '4', '3', '2', '1'] as const).map(n => (
            <div key={n}><span>{n} <Star size={11} /></span><i style={{ width: `${(s.distribution[n] / maxBar) * 100}%` }} /><small>{s.distribution[n]}</small></div>
          ))}
        </div>
      </section>

      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">Business Profile performance</span><h2>How people found and contacted {location.title ?? 'this business'}</h2></div>
          <select className="input ads-account-select" aria-label="Period" value={days} onChange={e => setDays(Number(e.target.value))}>
            {[7, 28, 90, 180].map(d => <option key={d} value={d}>Last {d} days</option>)}
          </select>
        </div>
        {perfError && <div className="alert alert-info"><div className="alert-content">{perfError}</div></div>}
        {perf && (
          <>
            <p className="card-intro">{perf.period.start} to {perf.period.end}. Google's figures lag about two days.</p>
            <div className="stat-grid">
              {METRICS.filter(m => m.id !== 'bookings' || perf.totals.bookings.current > 0).map(m => (
                <StatCard key={m.id} label={m.label} value={perf.totals[m.id].current} sub={change(perf.totals[m.id].change_pct)} tone={(perf.totals[m.id].change_pct ?? 0) < -20 ? 'warn' : undefined} />
              ))}
            </div>
            <div className="ops-tabs" role="group" aria-label="Chart metric">
              {CHART.map(c => <button key={c.id} type="button" className={metric === c.id ? 'active' : ''} aria-pressed={metric === c.id} onClick={() => setMetric(c.id)}>{c.id === 'calls' ? <Phone size={12} /> : c.id === 'direction_requests' ? <MapPin size={12} /> : <BarChart3 size={12} />} {c.label}</button>)}
            </div>
            <MetricChart label={`${CHART.find(c => c.id === metric)?.label} per day`} points={perf.daily.map(d => ({ date: d.date, value: d[metric] }))} />
            <h3 className="reviews-subhead"><Search size={14} /> Searches that showed the profile ({perf.search_keywords.months})</h3>
            {perf.search_keywords.error
              ? <p className="ads-hint">{perf.search_keywords.error}</p>
              : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Search term</th><th>Views</th></tr></thead>
                    <tbody>
                      {perf.search_keywords.keywords.slice(0, 20).map(k => <tr key={k.keyword}><td>{k.keyword}</td><td>{k.below_threshold ? `under ${k.impressions}` : k.impressions.toLocaleString()}</td></tr>)}
                      {!perf.search_keywords.keywords.length && <tr><td colSpan={2}><small className="text-dim">No search terms reported yet.</small></td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
          </>
        )}
        {!perf && !perfError && <div className="page-loading">Loading performance…</div>}
      </section>
    </div>
  );
}
