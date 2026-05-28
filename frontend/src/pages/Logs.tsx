import { useState, useEffect, useRef } from 'react';
import { Filter, Download } from 'lucide-react';
import { useApp } from '../AppContext';
import { createLogStream, type LogEntry } from '../api';

const LEVEL_COLORS: Record<string, string> = {
  ok:    'var(--ok)',
  warn:  'var(--warn)',
  error: 'var(--error)',
  info:  'var(--text-secondary)',
  dim:   'var(--text-dim)',
};

function LogLine({ log }: { log: LogEntry }) {
  return (
    <div className={`log-line log-${log.level}`}>
      <span className="log-ts">
        {log.created_at
          ? new Date(log.created_at).toLocaleTimeString()
          : '--:--:--'}
      </span>
      <span className="log-msg" style={{ color: LEVEL_COLORS[log.level] }}>
        {log.message}
      </span>
      {log.url && (
        <span className="log-url text-dim text-xs">
          {log.url}
        </span>
      )}
    </div>
  );
}

export default function LogsPage() {
  const { logs: initialLogs, appendLog, status } = useApp();
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>(initialLogs);
  const [filter, setFilter]     = useState<string>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Keep local live logs updated from context
  useEffect(() => {
    setLiveLogs(initialLogs);
  }, [initialLogs]);

  // SSE subscription on this page (duplicates might arrive from context — that's fine, UI deduplicates by index)
  useEffect(() => {
    const unsub = createLogStream((entry) => {
      appendLog(entry);
      setLiveLogs(prev => [entry, ...prev].slice(0, 1000));
    });
    return unsub;
  }, [appendLog]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [liveLogs, autoScroll]);

  const filtered = filter === 'all'
    ? liveLogs
    : liveLogs.filter(l => l.level === filter);

  function downloadLogs() {
    const text = liveLogs.map(l =>
      `[${l.created_at ?? '?'}] [${l.level.toUpperCase()}] ${l.message}${l.url ? ' ' + l.url : ''}`
    ).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `seo-indexer-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
  }

  return (
    <div>
      <div className="page-header flex items-center justify-between">
        <div>
          <h1 className="page-title">Live Logs</h1>
          <p className="page-subtitle">
            Real-time stream of indexing activity
            {status?.scheduler.running && (
              <span className="badge badge-ok ml-3" style={{ verticalAlign: 'middle' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)', animation: 'pulse 1s infinite', display: 'inline-block', marginRight: 4 }} />
                Run in progress
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary btn-sm" onClick={downloadLogs}>
            <Download size={12} /> Export
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="logs-filter-row flex items-center gap-2 mb-3">
        <Filter size={13} className="text-dim" />
        {(['all', 'ok', 'info', 'warn', 'error'] as const).map(level => (
          <button
            key={level}
            className={`btn btn-sm ${filter === level ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setFilter(level)}
            style={{ textTransform: 'capitalize' }}
          >
            {level}
          </button>
        ))}
        <label className="logs-autoscroll-toggle flex items-center gap-2 ml-auto" style={{ fontSize: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={e => setAutoScroll(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          <span className="text-dim">Auto-scroll</span>
        </label>
      </div>

      <div className="log-panel logs-panel">
        {filtered.length === 0 ? (
          <div className="text-dim">No logs yet. Trigger a run from the Dashboard.</div>
        ) : (
          [...filtered].reverse().map((log, i) => <LogLine key={i} log={log} />)
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-center justify-between mt-2" style={{ fontSize: 11, color: 'var(--text-dim)' }}>
        <span>{filtered.length} entries{filter !== 'all' ? ` (filtered: ${filter})` : ''}</span>
        <span>Showing up to 1,000 recent entries</span>
      </div>
    </div>
  );
}
