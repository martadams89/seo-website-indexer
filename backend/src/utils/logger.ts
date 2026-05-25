import { insertLog, type LogEntry } from '../db/database.js';

type LogListener = (entry: LogEntry) => void;
const _listeners = new Set<LogListener>();

export function subscribeToLogs(fn: LogListener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function emitLog(entry: LogEntry): void {
  for (const fn of _listeners) {
    try { fn(entry); } catch { /* ignore dead listeners */ }
  }
}

export function logSystem(
  level: LogEntry['level'],
  message: string,
  siteId?: string,
  url?: string
): void {
  const entry: LogEntry = {
    run_id: 'system',
    level,
    message,
    site_id: siteId,
    url,
    created_at: new Date().toISOString()
  };
  insertLog(entry);
  emitLog(entry);

  const prefix = `[${level.toUpperCase()}]`;
  if (level === 'error') {
    console.error(`${prefix} ${message} ${url ? `(${url})` : ''}`);
  } else {
    console.log(`${prefix} ${message} ${url ? `(${url})` : ''}`);
  }
}
