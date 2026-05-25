import { useState } from 'react';
import { Play, RefreshCw, CheckCircle2, XCircle, Zap, Globe2, TrendingUp } from 'lucide-react';
import { useApp } from '../AppContext';
import { api } from '../api';
import { formatDistanceToNow } from 'date-fns';

export default function Dashboard() {
  const { status, sites, runs, logs, refresh } = useApp();
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [runError, setRunError] = useState('');

  const todayRuns = runs.filter(r => r.started_at.slice(0, 10) === new Date().toISOString().slice(0, 10));
  const totalSubmitted = todayRuns.reduce((s, r) => s + r.total_submitted, 0);
  const totalFailed    = todayRuns.reduce((s, r) => s + r.total_failed, 0);

  async function triggerRun() {
    setRunError('');
    setRunning(true);
    try {
      await api.triggerRun();
      setTimeout(refresh, 1500);
    } catch (e) {
      setRunError(String(e).replace('Error: ', ''));
    }
    setRunning(false);
  }

  async function stopRun() {
    setRunError('');
    setStopping(true);
    try {
      await api.stopRun();
      setTimeout(refresh, 1500);
    } catch (e) {
      setRunError(String(e).replace('Error: ', ''));
    }
    setStopping(false);
  }

  const isCurrentlyRunning = status?.scheduler.running;

  return (
    <div>
      <div className="page-header flex items-center justify-between">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Overview of your SEO indexing pipeline</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary btn-sm" onClick={refresh}>
            <RefreshCw size={13} /> Refresh
          </button>
          {isCurrentlyRunning ? (
            <button
              className="btn btn-danger"
              disabled={stopping}
              onClick={stopRun}
            >
              {stopping ? <><span className="spinner" /> Stopping…</> : <><XCircle size={13} /> Stop Run</>}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={running || !status?.auth.authenticated || sites.length === 0}
              onClick={triggerRun}
            >
              <Play size={13} /> Run Now
            </button>
          )}
        </div>
      </div>

      {runError && (
        <div className="alert alert-error mb-4">
          <div className="alert-content">{runError}</div>
        </div>
      )}

      {/* Setup prompts */}
      {!status?.auth.authenticated && (
        <div className="alert alert-warn mb-4">
          <div className="alert-content">
            <div className="alert-title">Authentication required</div>
            <div>Configure Google authentication in <a href="/setup" style={{ color: 'var(--warn)' }}>Setup</a>.</div>
          </div>
        </div>
      )}
      {status?.auth.authenticated && sites.length === 0 && (
        <div className="alert alert-info mb-4">
          <div className="alert-content">
            <div className="alert-title">No sites configured</div>
            <div>Add your first site on the <a href="/sites" style={{ color: 'var(--info)' }}>Sites</a> page.</div>
          </div>
        </div>
      )}

      {/* ── Stats ── */}
      <div className="grid-4 mb-4" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <div className="stat-card" style={{ '--accent-color': 'var(--accent)' } as React.CSSProperties}>
          <div className="stat-label">Sites</div>
          <div className="stat-value text-accent">{sites.length}</div>
          <div className="stat-sub">Enabled</div>
        </div>
        <div className="stat-card" style={{ '--accent-color': 'var(--ok)' } as React.CSSProperties}>
          <div className="stat-label">Submitted Today</div>
          <div className="stat-value text-ok">{totalSubmitted}</div>
          <div className="stat-sub">across {todayRuns.length} run{todayRuns.length !== 1 ? 's' : ''}</div>
        </div>
        <div className="stat-card" style={{ '--accent-color': 'var(--warn)' } as React.CSSProperties}>
          <div className="stat-label">Failed Today</div>
          <div className="stat-value" style={{ color: totalFailed > 0 ? 'var(--warn)' : 'var(--text-dim)' }}>{totalFailed}</div>
          <div className="stat-sub">{totalFailed > 0 ? 'Check logs' : 'All good'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Schedule</div>
          <div style={{ fontSize: 14, fontWeight: 700, marginTop: 6, fontFamily: 'JetBrains Mono' }}>
            {status?.scheduler.cronSchedule ?? '—'}
          </div>
          <div className="stat-sub">{isCurrentlyRunning ? '🟢 Running now' : 'Next run: scheduled'}</div>
        </div>
      </div>

      <div className="grid-2 mb-4">
        {/* ── Sites overview ── */}
        <div className="card">
          <div className="card-title flex items-center gap-2"><Globe2 size={13} /> Sites</div>
          {sites.length === 0 ? (
            <p className="text-dim text-sm">No sites added yet.</p>
          ) : (
            <div className="flex-col gap-3">
              {sites.map(site => (
                <div key={site.id} className="flex items-center gap-3">
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: site.indexNowVerified ? 'var(--ok)' : 'var(--warn)',
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{site.name}</div>
                    <div className="text-dim text-xs truncate">{site.domain}</div>
                  </div>
                  {site.indexNowVerified
                    ? <span className="badge badge-ok">IndexNow ✓</span>
                    : <span className="badge badge-warn">Key unverified</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Recent runs ── */}
        <div className="card">
          <div className="card-title flex items-center gap-2"><TrendingUp size={13} /> Recent Runs</div>
          {runs.length === 0 ? (
            <p className="text-dim text-sm">No runs yet. Click "Run Now" to start.</p>
          ) : (
            <div className="flex-col gap-2">
              {runs.slice(0, 6).map(run => (
                <div key={run.id} className="flex items-center gap-3" style={{ fontSize: 13 }}>
                  {run.status === 'completed'
                    ? <CheckCircle2 size={14} style={{ color: 'var(--ok)', flexShrink: 0 }} />
                    : run.status === 'failed'
                    ? <XCircle size={14} style={{ color: 'var(--error)', flexShrink: 0 }} />
                    : <span className="spinner" style={{ flexShrink: 0 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="flex items-center gap-2">
                      <span style={{ fontWeight: 600 }}>{run.total_submitted} submitted</span>
                      {run.total_failed > 0 && <span className="text-warn text-xs">{run.total_failed} failed</span>}
                      <span className="badge badge-info" style={{ fontSize: 10 }}>{run.trigger}</span>
                    </div>
                    <div className="text-dim text-xs">
                      {formatDistanceToNow(new Date(run.started_at), { addSuffix: true })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Recent logs preview ── */}
      <div className="card">
        <div className="card-title flex items-center justify-between">
          <span className="flex items-center gap-2"><Zap size={13} /> Recent Activity</span>
          <a href="/logs" style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}>View all →</a>
        </div>
        <div className="log-panel" style={{ maxHeight: 240 }}>
          {logs.length === 0 ? (
            <div className="text-dim">No activity yet.</div>
          ) : (
            logs.slice(0, 30).map((log, i) => (
              <div key={i} className={`log-line log-${log.level}`}>
                <span className="log-ts">{log.created_at?.slice(11, 19) ?? ''}</span>
                <span className="log-msg">{log.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
