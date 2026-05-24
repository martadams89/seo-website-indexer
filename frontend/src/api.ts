// api.ts — typed API client for the SEO Website Indexer backend

const BASE = import.meta.env.VITE_API_URL ?? '';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Site {
  id: string;
  name: string;
  domain: string;
  sitemap_url: string;
  gsc_url: string;
  enabled: number;
  created_at: string;
  indexNowKey: string;
  indexNowVerified: boolean;
}

export interface AuthStatus {
  authenticated: boolean;
  hasBuiltinCredentials: boolean;
  expiresAt?: string;
  error?: string;
}

export interface AppStatus {
  auth: AuthStatus;
  scheduler: {
    running: boolean;
    currentRunId: string | null;
    cronSchedule: string;
  };
  sites: number;
}

export interface RunRecord {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'completed' | 'failed';
  total_submitted: number;
  total_skipped: number;
  total_failed: number;
  trigger: 'manual' | 'scheduled';
}

export interface LogEntry {
  id?: number;
  run_id: string;
  level: 'info' | 'ok' | 'warn' | 'error' | 'dim';
  message: string;
  site_id?: string;
  url?: string;
  created_at?: string;
}

export interface DeviceFlowState {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export interface SiteProbe {
  sitemap: { ok: boolean; urlCount: number; hasLastmod: boolean; error?: string };
  indexNowKey: string;
  indexNowVerified: boolean;
}

export interface KeyVerification {
  reachable: boolean;
  keyMatch: boolean;
  url: string;
  error?: string;
}

export interface GSCSite {
  siteUrl: string;
  permissionLevel: string;
}

// ── API Functions ──────────────────────────────────────────────────────────────

export const api = {
  // Status
  getStatus: () => apiFetch<AppStatus>('/api/status'),

  // Auth
  startDeviceFlow: (clientId?: string, clientSecret?: string) =>
    apiFetch<DeviceFlowState>('/api/auth/device-flow/start', {
      method: 'POST', body: JSON.stringify({ clientId, clientSecret }),
    }),
  pollDeviceFlow: (deviceCode: string, interval: number, expiresIn: number) =>
    apiFetch<{ ok: boolean; message: string }>('/api/auth/device-flow/poll', {
      method: 'POST', body: JSON.stringify({ deviceCode, interval, expiresIn }),
    }),
  clearAuth: () => apiFetch<{ ok: boolean }>('/api/auth/clear', { method: 'POST' }),
  listGSCSites: () => apiFetch<GSCSite[]>('/api/auth/gsc-sites'),

  // Sites
  getSites: () => apiFetch<Site[]>('/api/sites'),
  addSite: (data: { name: string; domain: string; sitemapUrl: string; gscUrl: string }) =>
    apiFetch<{ ok: boolean; id: string; indexNowKey: string }>('/api/sites', {
      method: 'POST', body: JSON.stringify(data),
    }),
  updateSite: (id: string, data: Partial<Site>) =>
    apiFetch<{ ok: boolean }>(`/api/sites/${id}`, {
      method: 'PUT', body: JSON.stringify(data),
    }),
  deleteSite: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/sites/${id}`, { method: 'DELETE' }),
  probeSite: (id: string) => apiFetch<SiteProbe>(`/api/sites/${id}/probe`),
  verifyIndexNow: (id: string) =>
    apiFetch<KeyVerification>(`/api/sites/${id}/verify-indexnow`, { method: 'POST' }),

  // Runs
  getRuns: () => apiFetch<RunRecord[]>('/api/runs'),
  triggerRun: (opts?: { siteIds?: string[]; skipGoogle?: boolean; skipIndexNow?: boolean }) =>
    apiFetch<{ ok: boolean; runId: string }>('/api/runs', {
      method: 'POST', body: JSON.stringify(opts ?? {}),
    }),
  getRunLogs: (id: string) => apiFetch<LogEntry[]>(`/api/runs/${id}/logs`),

  // Logs
  getRecentLogs: (limit = 200) => apiFetch<LogEntry[]>(`/api/logs?limit=${limit}`),

  // Settings
  getSettings: () => apiFetch<Record<string, string>>('/api/settings'),
  updateSettings: (data: Record<string, string>) =>
    apiFetch<{ ok: boolean }>('/api/settings', {
      method: 'PUT', body: JSON.stringify(data),
    }),
};

// ── SSE Log Stream ────────────────────────────────────────────────────────────

export function createLogStream(onMessage: (entry: LogEntry) => void, onConnected?: () => void): () => void {
  const es = new EventSource(`${BASE}/api/logs/stream`);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as { type: string } & LogEntry;
      if (data.type === 'connected') { onConnected?.(); return; }
      if (data.type === 'log') onMessage(data);
    } catch { /* ignore */ }
  };
  return () => es.close();
}
