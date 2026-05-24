import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { api, type AppStatus, type Site, type RunRecord, type LogEntry } from './api';

// ── App Context ───────────────────────────────────────────────────────────────

interface AppContextValue {
  status: AppStatus | null;
  sites: Site[];
  runs: RunRecord[];
  logs: LogEntry[];
  loading: boolean;
  refresh: () => Promise<void>;
  appendLog: (entry: LogEntry) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus]  = useState<AppStatus | null>(null);
  const [sites, setSites]    = useState<Site[]>([]);
  const [runs, setRuns]      = useState<RunRecord[]>([]);
  const [logs, setLogs]      = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [s, si, r, l] = await Promise.all([
        api.getStatus(),
        api.getSites(),
        api.getRuns(),
        api.getRecentLogs(300),
      ]);
      setStatus(s);
      setSites(si);
      setRuns(r);
      setLogs(l);
    } catch (e) {
      console.error('Failed to refresh app data', e);
    }
    setLoading(false);
  }, []);

  const appendLog = useCallback((entry: LogEntry) => {
    setLogs(prev => [entry, ...prev].slice(0, 500));
    // Refresh run list when a run completes
    if (entry.message.includes('Run complete')) {
      setTimeout(() => api.getRuns().then(setRuns).catch(() => null), 1000);
      setTimeout(() => api.getStatus().then(setStatus).catch(() => null), 1000);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll status every 15s to update scheduler state
  useEffect(() => {
    const id = setInterval(() => {
      api.getStatus().then(setStatus).catch(() => null);
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <AppContext.Provider value={{ status, sites, runs, logs, loading, refresh, appendLog }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
