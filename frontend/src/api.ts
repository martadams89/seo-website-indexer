// api.ts — typed API client for the SEO Website Indexer backend

const BASE = import.meta.env.VITE_API_URL ?? '';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (options?.body) {
    headers.set('Content-Type', 'application/json');
  }
  // CSRF-lite: marks the request as coming from our SPA. The backend enforces
  // this header on all state-changing requests.
  const method = (options?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    headers.set('X-Requested-With', 'seo-indexer-ui');
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GoogleAccount {
  id: string;
  email: string | null;
  client_id: string;
  created_at: string;
}

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
  google_account_id?: string | null;
  robots_txt_status?: string | null;
  llms_txt_status?: string | null;
  deploy_webhook_url?: string | null;
  ftp_host?: string | null;
  ftp_port?: number | null;
  ftp_user?: string | null;
  ftp_pass?: string | null;
  ftp_path?: string | null;
}

export interface UrlState {
  url: string;
  site_id: string;
  last_submitted: string | null;
  last_seen_lastmod: string | null;
  submission_count: number;
  google_submitted: number;
  indexnow_submitted: number;
  gsc_indexing_state?: string | null;
  gsc_last_inspected?: string | null;
  has_schema?: number | null;
  schema_types?: string | null;
}


export interface AuthStatus {
  authenticated: boolean;
  hasBuiltinCredentials: boolean;
  expiresAt?: string;
  clientId?: string;
  error?: string;
}

export interface AppStatus {
  auth: AuthStatus;
  scheduler: {
    running: boolean;
    currentRunId: string | null;
    cronSchedule: string;
    lock?: { runId: string; acquiredAt: string } | null;
  };
  sites: number;
  accounts?: number;
  version?: string;
}

export interface QuotaSummary {
  day: string;
  google_indexing: { used: number; limit: number; perProjectLimit: number; projects: Array<{ bucket: string; count: number }> };
  gsc_inspection:  { used: number; perPropertyLimit: number; properties: Array<{ bucket: string; count: number }> };
  indexnow:        { used: number; perSiteLimit: number; sites: Array<{ bucket: string; count: number }> };
}

export interface UrlFailureRecord {
  url: string;
  site_id: string;
  api: string;
  fail_count: number;
  last_failed_at: string;
  first_failed_at: string;
}

export interface BackupInfo {
  name: string;
  bytes: number;
  mtime: string;
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
  googleAccountId?: string;
}

// ── API Functions ──────────────────────────────────────────────────────────────

export const api = {
  // Status
  getStatus: () => apiFetch<AppStatus>('/api/status'),

  // Auth
  saveCredentials: (clientId: string, clientSecret: string) =>
    apiFetch<{ ok: boolean }>('/api/auth/save-credentials', {
      method: 'POST', body: JSON.stringify({ clientId, clientSecret }),
    }),
  startDeviceFlow: (clientId?: string, clientSecret?: string) =>
    apiFetch<DeviceFlowState>('/api/auth/device-flow/start', {
      method: 'POST', body: JSON.stringify({ clientId, clientSecret }),
    }),
  pollDeviceFlow: (deviceCode: string, interval: number, expiresIn: number) =>
    apiFetch<{ ok: boolean; message: string }>('/api/auth/device-flow/poll', {
      method: 'POST', body: JSON.stringify({ deviceCode, interval, expiresIn }),
    }),
  clearAuth: () => apiFetch<{ ok: boolean }>('/api/auth/clear', { method: 'POST' }),
  listGSCSites: (accountId?: string) => 
    apiFetch<GSCSite[]>(`/api/auth/gsc-sites${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`),
  getAccounts: () => apiFetch<GoogleAccount[]>('/api/auth/accounts'),
  disconnectAccount: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/auth/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Sites
  getSites: () => apiFetch<Site[]>('/api/sites'),
  addSite: (data: {
    name: string;
    domain: string;
    sitemapUrl: string;
    gscUrl: string;
    googleAccountId?: string | null;
    deploy_webhook_url?: string | null;
    ftp_host?: string | null;
    ftp_port?: number | null;
    ftp_user?: string | null;
    ftp_pass?: string | null;
    ftp_path?: string | null;
  }) =>
    apiFetch<{ ok: boolean; id: string; indexNowKey: string }>('/api/sites', {
      method: 'POST', body: JSON.stringify(data),
    }),
  updateSite: (id: string, data: Partial<Site & { googleAccountId: string | null; sitemapUrl?: string; gscUrl?: string }>) =>
    apiFetch<{ ok: boolean; site?: Site }>(`/api/sites/${id}`, {
      method: 'PUT', body: JSON.stringify(data),
    }),
  deleteSite: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/sites/${id}`, { method: 'DELETE' }),
  probeSite: (id: string) => apiFetch<SiteProbe>(`/api/sites/${id}/probe`),
  verifyIndexNow: (id: string) =>
    apiFetch<KeyVerification>(`/api/sites/${id}/verify-indexnow`, { method: 'POST' }),
  getSiteUrls: (id: string) =>
    apiFetch<UrlState[]>(`/api/sites/${id}/urls`),

  // Runs
  getRuns: () => apiFetch<RunRecord[]>('/api/runs'),
  triggerRun: (opts?: { siteIds?: string[]; skipGoogle?: boolean; skipIndexNow?: boolean; skipSitemaps?: boolean; gscLimit?: number; googleLimit?: number }) =>
    apiFetch<{ ok: boolean; runId: string }>('/api/runs', {
      method: 'POST', body: JSON.stringify(opts ?? {}),
    }),
  stopRun: () => apiFetch<{ ok: boolean }>('/api/runs/stop', { method: 'POST' }),
  getRunLogs: (id: string) => apiFetch<LogEntry[]>(`/api/runs/${id}/logs`),

  // Logs
  getRecentLogs: (limit = 200) => apiFetch<LogEntry[]>(`/api/logs?limit=${limit}`),

  // Settings
  getSettings: () => apiFetch<Record<string, string>>('/api/settings'),
  updateSettings: (data: Record<string, string>) =>
    apiFetch<{ ok: boolean }>('/api/settings', {
      method: 'PUT', body: JSON.stringify(data),
    }),

  // Quota & failures
  getQuotaToday: () => apiFetch<QuotaSummary>('/api/quota/today'),
  getUrlFailures: () => apiFetch<UrlFailureRecord[]>('/api/url-failures'),

  // Backups
  listBackups: () => apiFetch<BackupInfo[]>('/api/backups'),
  triggerBackup: () => apiFetch<{ ok: boolean; created?: string; reason?: string }>('/api/backups', { method: 'POST' }),

  // GEO files
  deployGeo: (siteId: string) =>
    apiFetch<{ ok: boolean; robots: string; llms: string }>(`/api/sites/${siteId}/deploy-geo`, { method: 'POST' }),

  // Admin: release stuck lock
  releaseLock: () => apiFetch<{ ok: boolean }>('/api/scheduler/release-lock', { method: 'POST' }),
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
