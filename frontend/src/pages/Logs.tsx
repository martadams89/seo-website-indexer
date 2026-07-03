import { useEffect, useMemo, useRef, useState } from 'react';
import { Filter, Download, Pause, Play, ArrowDown, Search, X } from 'lucide-react';
import { useApp } from '../AppContext';
import type { LogEntry } from '../api';

const LEVEL_COLORS: Record<string, string> = {
  ok:    'var(--ok)',
  warn:  'var(--warn)',
  error: 'var(--error)',
  info:  'var(--text-secondary)',
  dim:   'var(--text-dim)',
};

const LEVEL_PILL_BG: Record<string, string> = {
  ok:    'var(--ok-dim)',
  warn:  'var(--warn-dim)',
  error: 'var(--error-dim)',
  info:  'var(--info-dim)',
  dim:   'var(--bg-input)',
};

function LogLine({ log }: { log: LogEntry }) {
  return (
    <div className={`log-line log-${log.level}`}>
      <span className="log-level-pill" style={{ background: LEVEL_PILL_BG[log.level], color: LEVEL_COLORS[log.level] }}>
        {log.level.toUpperCase()}
      </span>
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
  // Layout already holds the single SSE subscription and feeds context — this
  // page just renders context state. (A second EventSource here used to
  // double-append every live entry.)
  const { logs, status } = useApp();
  const [filter, setFilter]     = useState<string>('all');
  const [search, setSearch]     = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // Pause auto-follow when the user scrolls away from the bottom.
  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distanceFromBottom > 80;
    userScrolledUp.current = scrolledUp;
    setShowJump(scrolledUp);
  }

  // Counts + filter in one memoised pass (recomputed once per log batch).
  const { counts, filtered } = useMemo(() => {
    const counts = { all: logs.length, ok: 0, info: 0, warn: 0, error: 0 } as Record<string, number>;
    const needle = search.toLowerCase();
    const filtered: LogEntry[] = [];
    // context stores newest-first; render oldest-first so the bottom is "latest"
    for (let i = logs.length - 1; i >= 0; i--) {
      const l = logs[i];
      if (l.level in counts) counts[l.level]++;
      if (filter !== 'all' && l.level !== filter) continue;
      if (needle && !l.message.toLowerCase().includes(needle) && !(l.url ?? '').toLowerCase().includes(needle)) continue;
      filtered.push(l);
    }
    return { counts, filtered };
  }, [logs, filter, search]);

  // Follow the tail as new entries arrive (unless paused or scrolled up).
  useEffect(() => {
    if (autoScroll && !userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  function jumpToBottom() {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      userScrolledUp.current = false;
      setShowJump(false);
    }
  }

  function downloadLogs() {
    const text = [...logs].reverse().map(l =>
      `[${l.created_at ?? '?'}] [${l.level.toUpperCase()}] ${l.message}${l.url ? ' ' + l.url : ''}`
    ).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `seo-indexer-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="logs-page">
      <div className="page-header logs-page-header">
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
        <div className="flex gap-2 logs-header-actions">
          <button className="btn btn-secondary btn-sm" onClick={downloadLogs}>
            <Download size={12} /> <span className="hide-mobile">Export</span>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="logs-toolbar">
        <div className="logs-filter-row">
          <Filter size={13} className="text-dim" style={{ flexShrink: 0 }} />
          {(['all', 'ok', 'info', 'warn', 'error'] as const).map(level => (
            <button
              key={level}
              className={`btn btn-sm logs-filter-pill ${filter === level ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setFilter(level)}
            >
              <span style={{ textTransform: 'capitalize' }}>{level}</span>
              <span className="logs-filter-count">{counts[level]}</span>
            </button>
          ))}
        </div>

        <div className="logs-search-wrap">
          <Search size={13} className="text-dim logs-search-icon" />
          <input
            className="input logs-search"
            placeholder="Search messages or URLs…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className="logs-search-clear btn-icon btn-icon-ghost"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              style={{ width: 28, height: 28, padding: 0 }}
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="logs-toolbar-actions">
          <button
            type="button"
            className={`btn btn-sm ${autoScroll ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setAutoScroll(s => !s)}
            title={autoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
            aria-pressed={autoScroll}
          >
            {autoScroll ? <Pause size={14} /> : <Play size={14} />}
            <span>{autoScroll ? 'Pause' : 'Resume'}</span>
          </button>
        </div>
      </div>

      <div className="logs-panel-wrap">
        <div className="log-panel logs-panel" ref={scrollRef} onScroll={onScroll}>
          {filtered.length === 0 ? (
            <div className="text-dim" style={{ padding: 16, textAlign: 'center' }}>
              {search || filter !== 'all'
                ? 'No matching logs. Adjust filter/search to see more.'
                : 'No logs yet. Trigger a run from the Dashboard.'}
            </div>
          ) : (
            filtered.map((log, i) => <LogLine key={log.id ?? `${log.created_at}-${i}`} log={log} />)
          )}
        </div>

        {showJump && (
          <button
            type="button"
            className="logs-jump-bottom btn btn-primary"
            onClick={jumpToBottom}
          >
            <ArrowDown size={14} /> Jump to latest
          </button>
        )}
      </div>

      <div className="logs-footer">
        <span>{filtered.length} entries{filter !== 'all' || search ? ` (filtered)` : ''}</span>
        <span className="text-dim">Up to 1,000 most recent</span>
      </div>
    </div>
  );
}
