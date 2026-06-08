import { useEffect, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { api, type QuotaSummary } from '../api';

function bar(used: number, limit: number) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const level = pct >= 90 ? 'high' : pct >= 60 ? 'medium' : 'low';
  return { pct, level };
}

function shortBucket(_api: string, bucket: string): string {
  if (bucket.startsWith('project:')) return `Project ${bucket.slice(8, 16)}…`;
  if (bucket.startsWith('account:')) return `Account ${bucket.slice(8, 16)}…`;
  if (bucket.startsWith('property:')) return bucket.slice(9);
  if (bucket.startsWith('site:')) return `Site ${bucket.slice(5, 13)}…`;
  return bucket;
}

interface Props {
  siteNames?: Record<string, string>; // map site.id → name for nicer labels
}

export function QuotaWidget({ siteNames }: Props) {
  const [quota, setQuota] = useState<QuotaSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const q = await api.getQuotaToday();
      setQuota(q);
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  if (loading && !quota) {
    return (
      <div className="card">
        <div className="card-title flex items-center gap-2"><Activity size={13} /> Today's API Quota</div>
        <div className="text-dim text-sm">Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="card">
        <div className="card-title flex items-center gap-2"><Activity size={13} /> Today's API Quota</div>
        <div className="text-warn text-sm">{error}</div>
      </div>
    );
  }
  if (!quota) return null;

  const label = (bucket: string, api: string) => {
    if (api === 'indexnow' || api === 'google_indexing') {
      const id = bucket.split(':')[1];
      if (siteNames && siteNames[id]) return siteNames[id];
    }
    return shortBucket(api, bucket);
  };

  const giBar = bar(quota.google_indexing.used, quota.google_indexing.limit);

  return (
    <div className="card">
      <div className="card-title flex items-center justify-between">
        <span className="flex items-center gap-2"><Activity size={13} /> Today's API Quota</span>
        <button className="btn-icon" onClick={load} title="Refresh quota" aria-label="Refresh quota">
          <RefreshCw size={12} />
        </button>
      </div>

      {/* Google Indexing */}
      <div className="mb-3">
        <div className="flex items-center justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
          <span style={{ fontWeight: 600 }}>Google Indexing API</span>
          <span className="text-dim">
            {quota.google_indexing.used.toLocaleString()} / {quota.google_indexing.limit.toLocaleString()} ({quota.google_indexing.perProjectLimit}/project)
          </span>
        </div>
        <div className="quota-bar-track">
          <div className="quota-bar-fill" data-level={giBar.level} style={{ width: `${giBar.pct}%` }} />
        </div>
        {quota.google_indexing.projects.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 11 }} className="text-dim">
            {quota.google_indexing.projects.map((p, i) => {
              const b = bar(p.count, quota.google_indexing.perProjectLimit);
              return (
                <div key={i} className="flex items-center justify-between" style={{ marginTop: 2 }}>
                  <span className="truncate" style={{ maxWidth: 220 }}>{shortBucket('google_indexing', p.bucket)}</span>
                  <span style={{ color: b.level === 'high' ? 'var(--error)' : b.level === 'medium' ? 'var(--warn)' : 'inherit' }}>
                    {p.count} / {quota.google_indexing.perProjectLimit}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* GSC Inspection */}
      <div className="mb-3">
        <div className="flex items-center justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
          <span style={{ fontWeight: 600 }}>Search Console Inspection</span>
          <span className="text-dim">
            {quota.gsc_inspection.used.toLocaleString()} / {(quota.gsc_inspection.perPropertyLimit * Math.max(1, quota.gsc_inspection.properties.length)).toLocaleString()}
          </span>
        </div>
        {quota.gsc_inspection.properties.length === 0 ? (
          <div className="text-dim text-xs">No usage yet today.</div>
        ) : (
          quota.gsc_inspection.properties.map((p, i) => {
            const b = bar(p.count, quota.gsc_inspection.perPropertyLimit);
            return (
              <div key={i} style={{ marginTop: 4 }}>
                <div className="flex items-center justify-between" style={{ fontSize: 11 }}>
                  <span className="truncate text-dim" style={{ maxWidth: 240 }}>{label(p.bucket, 'gsc_inspection')}</span>
                  <span className="text-dim">{p.count} / {quota.gsc_inspection.perPropertyLimit}</span>
                </div>
                <div className="quota-bar-track" style={{ marginTop: 3, height: 6 }}>
                  <div className="quota-bar-fill" data-level={b.level} style={{ width: `${b.pct}%` }} />
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* IndexNow */}
      <div>
        <div className="flex items-center justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
          <span style={{ fontWeight: 600 }}>IndexNow</span>
          <span className="text-dim">
            {quota.indexnow.used.toLocaleString()} URLs submitted today
          </span>
        </div>
        {quota.indexnow.sites.length === 0 ? (
          <div className="text-dim text-xs">No usage yet today.</div>
        ) : (
          quota.indexnow.sites.map((p, i) => {
            const b = bar(p.count, quota.indexnow.perSiteLimit);
            return (
              <div key={i} style={{ marginTop: 4 }}>
                <div className="flex items-center justify-between" style={{ fontSize: 11 }}>
                  <span className="truncate text-dim" style={{ maxWidth: 240 }}>{label(p.bucket, 'indexnow')}</span>
                  <span className="text-dim">{p.count.toLocaleString()} / {quota.indexnow.perSiteLimit.toLocaleString()}</span>
                </div>
                <div className="quota-bar-track" style={{ marginTop: 3, height: 6 }}>
                  <div className="quota-bar-fill" data-level={b.level} style={{ width: `${b.pct}%` }} />
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="text-dim text-xs" style={{ marginTop: 10 }}>
        Auto-refreshes every 30 seconds · {quota.day}
      </div>
    </div>
  );
}
