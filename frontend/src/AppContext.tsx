import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { api, type AppStatus, type Site, type RunRecord, type LogEntry } from './api';

// ── Toast subsystem ───────────────────────────────────────────────────────────

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export type Theme = 'light' | 'dark';

// ── App Context ───────────────────────────────────────────────────────────────

interface AppContextValue {
  status: AppStatus | null;
  sites: Site[];
  runs: RunRecord[];
  logs: LogEntry[];
  loading: boolean;
  refresh: () => Promise<void>;
  appendLog: (entry: LogEntry) => void;

  // Toasts
  toasts: Toast[];
  toast: (kind: ToastKind, message: string) => void;
  dismissToast: (id: number) => void;

  // Theme
  theme: Theme;
  toggleTheme: () => void;

  // SSE connection health
  sseConnected: boolean;
  sseLastEventAt: number | null;
  setSseConnected: (v: boolean) => void;
  markSseAlive: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus]  = useState<AppStatus | null>(null);
  const [sites, setSites]    = useState<Site[]>([]);
  const [runs, setRuns]      = useState<RunRecord[]>([]);
  const [logs, setLogs]      = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(1);
  const toast = useCallback((kind: ToastKind, message: string) => {
    const id = toastIdRef.current++;
    setToasts(t => [...t, { id, kind, message }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts(t => t.filter(x => x.id !== id));
  }, []);

  // Theme
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'dark';
    const saved = window.localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { window.localStorage.setItem('theme', theme); } catch { /* ignore */ }
  }, [theme]);
  const toggleTheme = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), []);

  // SSE health
  const [sseConnected, setSseConnected] = useState(false);
  const [sseLastEventAt, setSseLastEventAt] = useState<number | null>(null);

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

  // Any SSE traffic (connected/ping/log) proves the stream is alive.
  const markSseAlive = useCallback(() => {
    setSseLastEventAt(Date.now());
    setSseConnected(true);
  }, []);

  const appendLog = useCallback((entry: LogEntry) => {
    setSseLastEventAt(Date.now());
    setSseConnected(true);
    setLogs(prev => [entry, ...prev].slice(0, 1000));
    if (entry.message.includes('Run complete')) {
      setTimeout(() => api.getRuns().then(setRuns).catch(() => null), 1000);
      setTimeout(() => api.getStatus().then(setStatus).catch(() => null), 1000);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll status every 15s
  useEffect(() => {
    const id = setInterval(() => {
      api.getStatus().then(setStatus).catch(() => null);
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  // SSE watchdog: mark disconnected if quiet for >45s
  useEffect(() => {
    const id = setInterval(() => {
      if (sseLastEventAt && Date.now() - sseLastEventAt > 45_000) {
        setSseConnected(false);
      }
    }, 5_000);
    return () => clearInterval(id);
  }, [sseLastEventAt]);

  return (
    <AppContext.Provider value={{
      status, sites, runs, logs, loading, refresh, appendLog,
      markSseAlive,
      toasts, toast, dismissToast,
      theme, toggleTheme,
      sseConnected, sseLastEventAt, setSseConnected,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

export function useToast() {
  const { toast } = useApp();
  return toast;
}
