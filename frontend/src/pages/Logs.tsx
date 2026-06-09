import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Filter, Download, Pause, Play, ArrowDown, Search, X } from 'lucide-react';
import { List, type RowComponentProps } from 'react-window';
import { useApp } from '../AppContext';
import { createLogStream, type LogEntry } from '../api';

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

// ── Virtualized row for react-window v2 ──────────────────────────────────────
// Heavy lists (>200 entries) render via this row. Fixed height for performance.
const ROW_HEIGHT = 26;
function VirtualLogRow({ index, style, items }: RowComponentProps<{ items: LogEntry[] }>) {
  const log = items[index];
  if (!log) return null;
  return (
    <div style={style} className={`log-vlist-row log-${log.level}`}>
      <span className="log-ts">{log.created_at ? new Date(log.created_at).toLocaleTimeString() : '--:--:--'}</span>
      <span className="log-lvl">{log.level.toUpperCase()}</span>
      <span className="log-msg">{log.message}{log.url ? `  ${log.url}` : ''}</span>
    </div>
  );
}

function VirtualizedLogs({ items }: { items: LogEntry[] }) {
  return (
    <List
      rowComponent={VirtualLogRow}
      rowCount={items.length}
      rowHeight={ROW_HEIGHT}
      rowProps={{ items }}
      defaultHeight={400}
      overscanCount={10}
      style={{ width: '100%', height: '100%', minHeight: 240 }}
    />
  );
}

export default function LogsPage() {
  const { logs: initialLogs, appendLog, status } = useApp();
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>(initialLogs);
  const [filter, setFilter]     = useState<string>('all');
  const [search, setSearch]     = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // Keep local live logs updated from context
  useEffect(() => {
    setLiveLogs(initialLogs);
  }, [initialLogs]);

  // SSE subscription on this page (duplicates might arrive from context — that's fine)
  useEffect(() => {
    const unsub = createLogStream((entry) => {
      appendLog(entry);
      setLiveLogs(prev => [entry, ...prev].slice(0, 1000));
    });
    return unsub;
  }, [appendLog]);

  // Detect when the user manually scrolls up — pause auto-scroll
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distanceFromBottom > 80;
    userScrolledUp.current = scrolledUp;
    setShowJump(scrolledUp);
  }, []);

  // Auto-scroll to bottom when new logs arrive (unless user scrolled up)
  useEffect(() => {
    if (autoScroll && !userScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [liveLogs, autoScroll]);

  function jumpToBottom() {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      userScrolledUp.current = false;
      setShowJump(false);
    }
  }

  const filtered = liveLogs.filter(l => {
    if (filter !== 'all' && l.level !== filter) return false;
    if (search) {
      const needle = search.toLowerCase();
      if (!l.message.toLowerCase().includes(needle) && !(l.url ?? '').toLowerCase().includes(needle)) {
        return false;
      }
    }
    return true;
  });

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

  const counts = {
    all:   liveLogs.length,
    ok:    liveLogs.filter(l => l.level === 'ok').length,
    info:  liveLogs.filter(l => l.level === 'info').length,
    warn:  liveLogs.filter(l => l.level === 'warn').length,
    error: liveLogs.filter(l => l.level === 'error').length,
  };

  // Reversed (oldest → newest) memoized list used by the virtualized renderer.
  const virtualItems = useMemo(() => [...filtered].reverse(), [filtered]);

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
          ) : filtered.length > 200 ? (
            <VirtualizedLogs items={virtualItems} />
          ) : (
            [...filtered].reverse().map((log, i) => <LogLine key={`${log.id ?? 'x'}-${i}`} log={log} />)
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
