// api.ts — typed API client for the SEO Website Indexer backend

const BASE = import.meta.env.VITE_API_URL ?? '';

// ── Active workspace (the tenant scope for every request) ────────────────────
// The backend reads X-Workspace-Id to decide which workspace's data a request
// sees. We persist the choice in localStorage so a reload keeps the same tenant.
const WS_STORAGE_KEY = 'active-workspace-id';
let activeWorkspaceId: string | null =
  typeof localStorage !== 'undefined' ? localStorage.getItem(WS_STORAGE_KEY) : null;

export function getActiveWorkspaceId(): string | null { return activeWorkspaceId; }
export function setActiveWorkspaceId(id: string | null): void {
  activeWorkspaceId = id;
  try {
    if (id) localStorage.setItem(WS_STORAGE_KEY, id);
    else localStorage.removeItem(WS_STORAGE_KEY);
  } catch { /* storage unavailable — header still set for this session */ }
}

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
  // Tenant scope — the backend validates access and ignores an inaccessible id.
  if (activeWorkspaceId) headers.set('X-Workspace-Id', activeWorkspaceId);

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
    credentials: 'same-origin', // send the session cookie
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as Record<string, unknown>;
    const err = new Error((body.error as string) ?? `HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json() as Promise<T>;
}

export interface ApiError extends Error {
  status?: number;
  body?: Record<string, unknown>;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  is_super_admin: boolean;
  disabled: boolean;
  totp_enabled: boolean;
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
  impersonation?: { actor: CurrentUser } | null;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GoogleAccount {
  id: string;
  email: string | null;
  client_id: string;
  created_at: string;
  needs_reauth?: number;
  refresh_token_expiry?: string | null;
  last_refreshed_at?: string | null;
  last_refresh_error?: string | null;
  granted_scopes?: string | null;
  owner_email?: string | null;
  is_mine?: boolean;
  can_disconnect?: boolean;
  can_unshare?: boolean;
  available_in_workspace?: boolean;
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
  bing_account_id?: string | null;
  robots_txt_status?: string | null;
  llms_txt_status?: string | null;
  deploy_webhook_url?: string | null;
  ftp_host?: string | null;
  geo_manage?: number | null;
  ftp_port?: number | null;
  ftp_user?: string | null;
  ftp_pass?: string | null;
  ftp_path?: string | null;
  llms_txt_content?: string | null;
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
export interface UrlFailureCheck {
  ok: boolean;
  status: number | null;
  statusText?: string;
  finalUrl?: string;
  redirected?: boolean;
  contentType?: string | null;
  error?: string;
  checkedAt: string;
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

  // ── App authentication (users, sessions, 2FA) ──
  bootstrapStatus: () => apiFetch<{ needsBootstrap: boolean; emailEnabled: boolean }>('/api/auth/bootstrap-status'),
  forgotPassword: (email: string) =>
    apiFetch<{ ok: boolean; message: string }>('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
  resetPassword: (token: string, password: string) =>
    apiFetch<{ ok: boolean }>('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) }),
  me: () => apiFetch<CurrentUser>('/api/auth/me'),
  signup: (email: string, password: string, name?: string) =>
    apiFetch<CurrentUser>('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string, totp?: string) =>
    apiFetch<CurrentUser>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password, totp }) }),
  logout: () => apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    apiFetch<{ ok: boolean }>('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  setRequiredPassword: (newPassword: string) =>
    apiFetch<{ ok: boolean }>('/api/auth/set-required-password', { method: 'POST', body: JSON.stringify({ newPassword }) }),
  stopImpersonating: () => apiFetch<CurrentUser>('/api/auth/impersonation/stop', { method: 'POST' }),
  totpSetup: () => apiFetch<{ secret: string; uri: string; qr: string }>('/api/auth/totp/setup', { method: 'POST' }),
  totpEnable: (totp: string) => apiFetch<{ ok: boolean }>('/api/auth/totp/enable', { method: 'POST', body: JSON.stringify({ totp }) }),
  totpDisable: (password: string) => apiFetch<{ ok: boolean }>('/api/auth/totp/disable', { method: 'POST', body: JSON.stringify({ password }) }),

  // Auth
  saveCredentials: (clientId: string, clientSecret: string) =>
    apiFetch<{ ok: boolean }>('/api/auth/save-credentials', {
      method: 'POST', body: JSON.stringify({ clientId, clientSecret }),
    }),
  beginGoogleAuth: (data: { clientId?: string; clientSecret?: string; autoSetup?: boolean; accountId?: string } = {}) =>
    apiFetch<{ authorizationUrl: string }>('/api/auth/google/start', { method: 'POST', body: JSON.stringify(data) }),
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
  getMyAccounts: () => apiFetch<GoogleAccount[]>('/api/auth/accounts/mine'),
  shareAccountWithWorkspace: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/auth/accounts/${encodeURIComponent(id)}/share`, { method: 'POST' }),
  unshareAccountFromWorkspace: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/auth/accounts/${encodeURIComponent(id)}/workspace`, { method: 'DELETE' }),
  disconnectAccount: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/auth/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  reconnectAccount: (id: string) =>
    apiFetch<{ ok: boolean; clientId: string }>(`/api/auth/accounts/${encodeURIComponent(id)}/reconnect`, { method: 'POST' }),

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
  triggerRun: (opts?: { siteIds?: string[]; skipGoogle?: boolean; skipIndexNow?: boolean; skipBing?: boolean; skipSitemaps?: boolean; gscLimit?: number }) =>
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

  // Notifications (per-workspace)
  notificationsStatus: () => apiFetch<{ configured: NotifyChannel[] }>('/api/notifications/status'),
  getNotifyConfig: () => apiFetch<Record<string, string>>('/api/notifications/config'),
  saveNotifyConfig: (data: Record<string, string>) =>
    apiFetch<{ ok: boolean }>('/api/notifications/config', { method: 'PUT', body: JSON.stringify(data) }),
  testNotifications: () =>
    apiFetch<{ results: NotifyChannelResult[] }>('/api/notifications/test', { method: 'POST' }),
  getNotificationDeliveries: () => apiFetch<NotificationDelivery[]>('/api/notifications/deliveries'),

  // Per-workspace API-key overrides (layered over platform defaults)
  getWorkspaceKeys: () => apiFetch<{ keys: Record<string, { override: boolean; platform: boolean }> }>('/api/workspace/keys'),
  saveWorkspaceKeys: (data: Record<string, string>) =>
    apiFetch<{ ok: boolean }>('/api/workspace/keys', { method: 'PUT', body: JSON.stringify(data) }),

  // Quota & failures
  getQuotaToday: () => apiFetch<QuotaSummary>('/api/quota/today'),
  getUrlFailures: () => apiFetch<UrlFailureRecord[]>('/api/url-failures'),
  checkUrlFailure: (failure: Pick<UrlFailureRecord, 'site_id' | 'url' | 'api'>) =>
    apiFetch<UrlFailureCheck>('/api/url-failures/check', { method: 'POST', body: JSON.stringify({ siteId: failure.site_id, url: failure.url, api: failure.api }) }),
  clearUrlFailures: (filters: { siteId?: string; url?: string; api?: string } = {}) =>
    apiFetch<{ ok: boolean; cleared: number }>('/api/url-failures', { method: 'DELETE', body: JSON.stringify(filters) }),

  // Backups
  listBackups: () => apiFetch<BackupInfo[]>('/api/backups'),
  triggerBackup: () => apiFetch<{ ok: boolean; created?: string; reason?: string }>('/api/backups', { method: 'POST' }),

  // GEO files
  deployGeo: (siteId: string) =>
    apiFetch<{ ok: boolean; robots: string; llms: string }>(`/api/sites/${siteId}/deploy-geo`, { method: 'POST' }),

  // Admin: release stuck lock
  releaseLock: () => apiFetch<{ ok: boolean }>('/api/scheduler/release-lock', { method: 'POST' }),

  // ── Analytics ──
  getCommandCenter: () => apiFetch<CommandCenter>('/api/command-center'),
  getAnalyticsOverview: () => apiFetch<AnalyticsOverview>('/api/analytics/overview'),
  getSiteAnalytics: (siteId: string) => apiFetch<SiteAnalytics>(`/api/analytics/site/${siteId}`),
  snapshotStats: () => apiFetch<{ snapshots: number }>('/api/analytics/snapshot', { method: 'POST' }),
  getAlerts: () => apiFetch<AlertRow[]>('/api/analytics/alerts'),
  ackAlert: (id: number) => apiFetch<{ ok: boolean }>(`/api/analytics/alerts/${id}/ack`, { method: 'POST' }),
  getMovers: () => apiFetch<SiteMover[]>('/api/analytics/movers'),

  // ── llms.txt lifecycle ──
  getLlmsAudit: (siteId: string) => apiFetch<LlmsAudit>(`/api/sites/${siteId}/llms-audit`),
  generateLlms: (siteId: string) =>
    apiFetch<GeneratedLlms>(`/api/sites/${siteId}/llms/generate`, { method: 'POST' }),
  saveLlms: (siteId: string, content: string) =>
    apiFetch<{ ok: boolean }>(`/api/sites/${siteId}/llms`, { method: 'PUT', body: JSON.stringify({ content }) }),

  // ── Bing Webmaster ──
  getBingQuota: (siteId: string) => apiFetch<{ DailyQuota: number; MonthlyQuota: number }>(`/api/bing/quota/${siteId}`),
  bingSubmit: (siteId: string, urls?: string[]) =>
    apiFetch<{ submitted: number }>(`/api/bing/submit/${siteId}`, { method: 'POST', body: JSON.stringify({ urls }) }),

  // ── Unified search performance ──
  getPerformance: (siteId: string, days: number) =>
    apiFetch<PerformanceResponse>(`/api/performance/${siteId}?days=${days}`),
  getCrawlIssues: (siteId: string) =>
    apiFetch<{ available: boolean; reason?: string; issues: Array<{ url: string; code?: number; issues: string[] }> }>(`/api/sites/${siteId}/crawl-issues`),
  submitCombined: (siteId: string, engines: Array<'google' | 'bing'>) =>
    apiFetch<{ google?: { runId?: string; error?: string }; bing?: { submitted?: number; error?: string } }>(
      `/api/submit/${siteId}`, { method: 'POST', body: JSON.stringify({ engines }) }),
  getPerfDimension: (siteId: string, days: number, dimension: 'country' | 'device') =>
    apiFetch<{ available: boolean; reason?: string; rows: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number }> }>(
      `/api/performance/${siteId}/dimension?days=${days}&dimension=${dimension}`),
  getPerfDeltas: (siteId: string, engine: 'google' | 'bing') =>
    apiFetch<{ engine: string; deltas: Array<{ metric: string; current: number; previous: number; changePct: number }> }>(
      `/api/performance/${siteId}/deltas?engine=${engine}`),
  snapshotPerf: (siteId: string) =>
    apiFetch<{ ok: boolean }>(`/api/performance/${siteId}/snapshot`, { method: 'POST' }),
  getQueryTrend: (siteId: string, query: string) =>
    apiFetch<{ query: string; points: Array<{ day: string; clicks: number; impressions: number; position: number }> }>(
      `/api/performance/${siteId}/query-trend?query=${encodeURIComponent(query)}`),
  getTrackableQueries: (siteId: string) =>
    apiFetch<Array<{ query: string; clicks: number }>>(`/api/performance/${siteId}/trackable-queries`),
  getTrackedQueries: (siteId: string) =>
    apiFetch<Array<{ id: number; query: string; last_position: number | null }>>(`/api/performance/${siteId}/tracked-queries`),
  addTrackedQuery: (siteId: string, query: string) =>
    apiFetch<{ ok: boolean }>(`/api/performance/${siteId}/tracked-queries`, { method: 'POST', body: JSON.stringify({ query }) }),
  removeTrackedQuery: (id: number) =>
    apiFetch<{ ok: boolean }>(`/api/performance/tracked-queries/${id}`, { method: 'DELETE' }),

  // ── Agent readiness (isitagentready-style) ──
  getAgentReadiness: (siteId: string) => apiFetch<AgentReadiness>(`/api/sites/${siteId}/agent-readiness`),

  // ── Hygiene / CrUX ──
  runHygiene: (siteId: string) => apiFetch<HygieneReport>(`/api/sites/${siteId}/hygiene`),
  refreshCrux: (siteId: string) => apiFetch<CruxResult | { error: string }>(`/api/crux/${siteId}/refresh`, { method: 'POST' }),

  // ── AI citations ──
  getAiProviders: () => apiFetch<{ all: string[]; configured: string[] }>('/api/ai/providers'),
  getAiPrompts: () => apiFetch<AiPrompt[]>('/api/ai/prompts'),
  addAiPrompt: (prompt: string, site_id?: string | null, category: AiPromptCategory = 'discovery') =>
    apiFetch<AiPrompt>('/api/ai/prompts', { method: 'POST', body: JSON.stringify({ prompt, site_id, category }) }),
  deleteAiPrompt: (id: number) => apiFetch<{ ok: boolean }>(`/api/ai/prompts/${id}`, { method: 'DELETE' }),
  getAiResults: () => apiFetch<AiResult[]>('/api/ai/results'),
  getAiInsights: () => apiFetch<AiInsights>('/api/ai/insights'),
  getAiConfig: () => apiFetch<{ competitorDomains: string }>('/api/ai/config'),
  saveAiConfig: (competitorDomains: string) => apiFetch<{ ok: boolean }>('/api/ai/config', { method: 'PUT', body: JSON.stringify({ competitorDomains }) }),
  runAiPrompt: (id: number) => apiFetch<{ results: AiRunResult[] }>(`/api/ai/run/${id}`, { method: 'POST' }),
  runAllAiPrompts: () => apiFetch<{ ran: number }>('/api/ai/run-all', { method: 'POST' }),
  getAiThread: (promptId: number, provider: string) =>
    apiFetch<AiResult[]>(`/api/ai/prompts/${promptId}/thread/${provider}`),
  replyAiThread: (promptId: number, provider: string, message: string) =>
    apiFetch<AiResult>(`/api/ai/prompts/${promptId}/reply`, { method: 'POST', body: JSON.stringify({ provider, message }) }),
  provisionGeminiKey: () =>
    apiFetch<{ ok: boolean; error?: string; needsRelink?: boolean }>('/api/ai/provision/gemini', { method: 'POST', body: JSON.stringify({}) }),

  // AI model probing + selection (per workspace)
  getAiModels: () => apiFetch<{ providers: ProviderModels[] }>('/api/ai/models'),
  saveAiModels: (data: Record<string, string>) =>
    apiFetch<{ ok: boolean }>('/api/ai/models', { method: 'PUT', body: JSON.stringify(data) }),

  // ── Workspaces (tenant / client base) ──
  getWorkspaces: () => apiFetch<Workspace[]>('/api/workspaces'),
  createWorkspace: (name: string) =>
    apiFetch<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) }),
  renameWorkspace: (id: string, name: string) =>
    apiFetch<{ ok: boolean }>(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteWorkspace: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/workspaces/${id}`, { method: 'DELETE' }),
  getWorkspaceMembers: (id: string) =>
    apiFetch<WorkspaceMember[]>(`/api/workspaces/${id}/members`),
  addWorkspaceMember: (id: string, email: string, role?: 'admin' | 'editor' | 'viewer', aiCitations?: boolean) =>
    apiFetch<{ ok: boolean }>(`/api/workspaces/${id}/members`, { method: 'POST', body: JSON.stringify({ email, role, ai_citations: aiCitations }) }),
  removeWorkspaceMember: (id: string, userId: string) =>
    apiFetch<{ ok: boolean }>(`/api/workspaces/${id}/members/${userId}`, { method: 'DELETE' }),
  updateWorkspaceMember: (id: string, userId: string, data: { role?: 'admin' | 'editor' | 'viewer'; ai_citations?: boolean; disabled?: boolean; permissions?: Partial<Record<WorkspaceCapability, boolean>> }) =>
    apiFetch<{ ok: boolean }>(`/api/workspaces/${id}/members/${userId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  resetMemberPassword: (id: string, userId: string) =>
    apiFetch<{ ok: boolean; emailed: boolean; resetPath?: string }>(`/api/workspaces/${id}/members/${userId}/reset-password`, { method: 'POST' }),
  clearMember2fa: (id: string, userId: string) =>
    apiFetch<{ ok: boolean }>(`/api/workspaces/${id}/members/${userId}/clear-2fa`, { method: 'POST' }),

  // ── Workspace invites (email join links) ──
  getWorkspaceInvites: (id: string) => apiFetch<WorkspaceInvite[]>(`/api/workspaces/${id}/invites`),
  createWorkspaceInvite: (id: string, email: string, role: 'admin' | 'editor' | 'viewer', aiCitations = true) =>
    apiFetch<{ ok: boolean; emailed: boolean; inviteLink?: string }>(`/api/workspaces/${id}/invites`, { method: 'POST', body: JSON.stringify({ email, role, ai_citations: aiCitations }) }),
  revokeWorkspaceInvite: (id: string, inviteId: string) =>
    apiFetch<{ ok: boolean }>(`/api/workspaces/${id}/invites/${inviteId}`, { method: 'DELETE' }),
  getInvite: (token: string) => apiFetch<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, data: { password?: string; name?: string }) =>
    apiFetch<CurrentUser>(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', body: JSON.stringify(data) }),

  // ── Super-admin: all workspaces ──
  getAllWorkspaces: () => apiFetch<AdminWorkspaceSummary[]>('/api/admin/workspaces'),
  reassignWorkspaceOwner: (id: string, ownerUserId: string) =>
    apiFetch<{ ok: boolean }>(`/api/admin/workspaces/${id}/owner`, { method: 'PATCH', body: JSON.stringify({ ownerUserId }) }),

  // ── User management (super-admin) ──
  listUsers: () => apiFetch<CurrentUser[]>('/api/users'),
  createUser: (data: { email: string; password: string; name?: string; role?: string; superAdmin?: boolean; workspaceId?: string; workspaceRole?: 'admin' | 'editor' | 'viewer'; aiCitations?: boolean }) =>
    apiFetch<CurrentUser>('/api/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id: string, data: { password?: string; superAdmin?: boolean; disabled?: boolean; email?: string; name?: string | null; role?: string }) =>
    apiFetch<{ ok: boolean }>(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id: string) => apiFetch<{ ok: boolean }>(`/api/users/${id}`, { method: 'DELETE' }),
  getAdminUser: (id: string) => apiFetch<AdminUserDetail>(`/api/admin/users/${id}`),
  generateUserPassword: (id: string) =>
    apiFetch<{ ok: boolean; temporaryPassword: string; mustChangePassword: boolean }>(`/api/admin/users/${id}/generate-password`, { method: 'POST' }),
  sendUserPasswordReset: (id: string) =>
    apiFetch<{ ok: boolean; emailed: boolean; resetPath?: string }>(`/api/admin/users/${id}/send-password-reset`, { method: 'POST' }),
  clearUser2fa: (id: string) => apiFetch<{ ok: boolean }>(`/api/admin/users/${id}/clear-2fa`, { method: 'POST' }),
  impersonateUser: (id: string) => apiFetch<CurrentUser>(`/api/admin/users/${id}/impersonate`, { method: 'POST' }),
  getAuditEvents: (limit = 100) => apiFetch<AuditEvent[]>(`/api/admin/audit-events?limit=${limit}`),

  // ── Bing accounts (multiple per workspace) ──
  getBingAccounts: () => apiFetch<BingAccount[]>('/api/bing/accounts'),
  addBingAccount: (name: string, apiKey: string) =>
    apiFetch<BingAccount>('/api/bing/accounts', { method: 'POST', body: JSON.stringify({ name, apiKey }) }),
  removeBingAccount: (id: string) =>
    apiFetch<{ ok: boolean }>(`/api/bing/accounts/${id}`, { method: 'DELETE' }),

  // ── Passkeys (WebAuthn) ──
  passkeyRegisterStart: () => apiFetch<PublicKeyCredentialCreationOptionsJSON & { challengeId: string }>('/api/auth/passkeys/register/start', { method: 'POST' }),
  passkeyRegisterFinish: (name: string, challengeId: string, credential: unknown) =>
    apiFetch<{ ok: boolean }>('/api/auth/passkeys/register/finish', { method: 'POST', body: JSON.stringify({ name, challengeId, credential }) }),
  passkeyLoginStart: (email?: string) =>
    apiFetch<PublicKeyCredentialRequestOptionsJSON & { challengeId: string }>('/api/auth/passkeys/login/start', { method: 'POST', body: JSON.stringify({ email }) }),
  passkeyLoginFinish: (challengeId: string, credential: unknown) =>
    apiFetch<CurrentUser>('/api/auth/passkeys/login/finish', { method: 'POST', body: JSON.stringify({ challengeId, credential }) }),
  listPasskeys: () => apiFetch<PasskeyInfo[]>('/api/auth/passkeys'),
  deletePasskey: (id: string) => apiFetch<{ ok: boolean }>(`/api/auth/passkeys/${id}`, { method: 'DELETE' }),

  // ── SSO / OIDC ──
  ssoProviders: () => apiFetch<Array<{ id: string; name: string }>>('/api/auth/sso/providers'),
};

// ── Workspace / user / bing / passkey types ─────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  created_at?: string;
  is_owner: boolean;
  is_active?: boolean;
  role?: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  can_manage?: boolean;
  permissions?: Record<WorkspaceCapability, boolean>;
}
export interface WorkspaceMember {
  user_id: string; email: string; name: string | null; role: string; is_owner: boolean;
  ai_citations: boolean; disabled: boolean; permissions: Record<WorkspaceCapability, boolean>;
}
export type WorkspaceCapability = 'manage_sites' | 'manage_integrations' | 'manage_notifications';
export const WORKSPACE_CAPABILITIES: Array<{ id: WorkspaceCapability; label: string }> = [
  { id: 'manage_sites', label: 'Manage sites' },
  { id: 'manage_integrations', label: 'Manage integrations & API keys' },
  { id: 'manage_notifications', label: 'Manage notifications' },
];
export interface WorkspaceInvite {
  id: string; email: string; role: string; ai_citations: boolean; expires_at: string; created_at: string;
}
export interface InvitePreview {
  email: string; workspaceName: string; role: string; hasAccount: boolean;
}
export interface AdminWorkspaceSummary {
  id: string; name: string; owner_user_id: string | null; owner_email: string | null;
  member_count: number; site_count: number; created_at: string;
}
export interface UserWorkspaceAccess {
  workspace_id: string; workspace_name: string; role: 'owner' | 'admin' | 'editor' | 'viewer';
  is_owner: boolean; ai_citations: boolean; disabled: boolean;
  permissions: Record<WorkspaceCapability, boolean>;
}
export interface AuditEvent {
  id: number; actor_user_id: string | null; actor_email?: string | null;
  target_user_id: string | null; target_email?: string | null; workspace_id: string | null;
  action: string; detail: string | null; ip_address: string | null; created_at: string;
}
export interface AdminUserDetail {
  user: CurrentUser;
  workspaces: UserWorkspaceAccess[];
  google_accounts: Array<{ id: string; email: string | null; needs_reauth: boolean; workspace_ids: string[]; created_at?: string }>;
  audit: AuditEvent[];
}
export interface BingAccount { id: string; name: string; created_at: string }

export type NotifyChannel = 'slack' | 'discord' | 'ntfy' | 'telegram' | 'webhook' | 'email';
export interface NotifyChannelResult { channel: NotifyChannel; configured: boolean; ok: boolean; error?: string }
export interface NotificationDelivery {
  id: number; workspace_id: string; event_type: string; channel: NotifyChannel;
  status: 'sent' | 'failed'; title: string; error: string | null; created_at: string;
}

export interface CommandAction {
  id: string; priority: 'critical' | 'high' | 'medium' | 'low';
  kind: 'indexing' | 'search' | 'ai' | 'integration' | 'experience';
  title: string; description: string; to: string; count?: number;
}
export interface CommandCenter {
  generatedAt: string;
  score: { overall: number; indexation: number | null; aiVisibility: number | null; agentReadiness: number | null; operations: number };
  metrics: {
    sites: number; urls: number; indexed: number; indexedRate: number | null; stale: number;
    failures: number; openAlerts: number; clicks7d: number; clicksChange: number | null;
    aiPrompts: number; aiChecks: number; aiVisibility: number | null; aiChange: number | null;
  };
  integrations: { google: number; bing: number; aiProviders: number; notifications: number };
  actions: CommandAction[]; movers: SiteMover[]; ai: AiInsights;
}
export interface PasskeyInfo { id: string; name: string | null; created_at: string }

// Minimal shapes of the WebAuthn JSON options the backend returns (subset used
// by the browser's navigator.credentials calls after base64url→ArrayBuffer).
export interface PublicKeyCredentialCreationOptionsJSON { [k: string]: unknown }
export interface PublicKeyCredentialRequestOptionsJSON { [k: string]: unknown }

// ── Analytics types ───────────────────────────────────────────────────────────

export interface SiteSnapshot {
  site_id: string; day: string;
  urls_total: number; urls_submitted: number; urls_google: number; urls_indexnow: number;
  urls_indexed: number; urls_not_indexed: number; urls_with_schema: number; urls_stale: number;
  failures: number;
}
export interface SiteOverviewRow extends SiteSnapshot {
  name: string; domain: string;
  trend: Array<{ day: string; urls_indexed: number; urls_total: number }>;
}
export interface AnalyticsOverview {
  sites: SiteOverviewRow[];
  totals: { sites: number; urls_total: number; urls_indexed: number; urls_stale: number; failures: number; open_alerts: number };
}
export interface SiteAnalytics {
  site: Site;
  snapshot: SiteSnapshot;
  trend: SiteSnapshot[];
  states: Array<{ state: string; count: number }>;
  freshness: Array<{ url: string; last_seen_lastmod: string; gsc_last_inspected: string | null; gsc_indexing_state: string | null }>;
  failures: Array<{ url: string; api: string; fail_count: number; last_failed_at: string }>;
  crux: Array<{ day: string; lcp_ms: number | null; inp_ms: number | null; cls: number | null }>;
}
export interface AlertRow {
  id: number; site_id: string | null; domain?: string | null;
  kind: string; severity: 'info' | 'warn' | 'error'; message: string; detail?: string | null;
  acked: number; created_at: string;
}
export interface SiteMoverMetric { current: number; previous: number; changePct: number }
export interface SiteMover {
  site_id: string; name: string; domain: string;
  clicks: SiteMoverMetric; impressions: SiteMoverMetric; position: SiteMoverMetric;
}
export interface LlmsAudit {
  live: { status: number; text: string };
  liveFull: { status: number } | null;
  generated: string;
  robotsLive: { status: number; text: string };
  robotsGenerated: string;
  lint: { ok: boolean; issues: string[]; stats: { bytes: number; lines: number; links: number; sections: number } };
  drift: boolean;
  custom: string | null;
  aiProvider: string | null;
}
export interface GeneratedLlms { content: string; provider: string; model: string; pagesScanned: number }
export interface HygieneReport {
  checked: number;
  issues: Array<{ url: string; kind: string; detail: string }>;
}
export interface CruxResult { lcp_ms: number | null; inp_ms: number | null; cls: number | null }

export type AgentCheckStatus = 'pass' | 'fail' | 'neutral';
export interface AgentCheck {
  id: string; label: string; category: string;
  status: AgentCheckStatus; detail: string; fix?: string;
}
export interface AgentReadinessResult {
  source: 'isitagentready.com' | 'local';
  level: number | null; levelName: string | null;
  score: number; passed: number; total: number;
  checks: AgentCheck[]; scannedAt: string;
}
export interface AgentReadiness {
  current: AgentReadinessResult;
  history: Array<{ day: string; score: number; passed: number; total: number; level: number | null }>;
}

export interface PerfSeriesPoint { date: string; clicks: number; impressions: number; ctr: number; position: number }
export interface PerfQueryRow { query: string; clicks: number; impressions: number; ctr: number; position: number }
export interface PerfPageRow { page: string; clicks: number; impressions: number; ctr: number; position: number }
export interface EnginePerformance {
  available: boolean;
  reason?: string;
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  series: PerfSeriesPoint[];
  queries: PerfQueryRow[];
  pages: PerfPageRow[];
}
export interface PerformanceResponse { days: number; google: EnginePerformance; bing: EnginePerformance }
export type AiPromptCategory = 'discovery' | 'comparison' | 'commercial' | 'brand' | 'support';
export interface AiPrompt { id: number; site_id: string | null; prompt: string; category: AiPromptCategory; enabled: number; created_at: string }
export interface AiResult {
  id: number; prompt_id: number; prompt?: string; site_id?: string | null;
  provider: string; model: string | null; cited: number; domains: string; excerpt: string | null;
  error: string | null; created_at: string;
  parent_id?: number | null; citations?: string | null; user_prompt?: string | null;
}
export interface AiRunResult { provider: string; model: string | null; cited: boolean; domains: string[]; excerpt?: string; error?: string }
export interface AiInsights {
  overview: {
    prompts: number; configuredProviders: number; checks: number; cited: number; visibility: number;
    previousVisibility: number | null; change: number | null; sourceDomains: number;
  };
  providers: Array<{ provider: string; checks: number; cited: number; visibility: number }>;
  trend: Array<{ day: string; checks: number; cited: number; visibility: number }>;
  sources: Array<{ domain: string; citations: number; owned: boolean; competitor: boolean; providers: string[] }>;
  opportunities: Array<{
    promptId: number; prompt: string; category: AiPromptCategory; siteId: string | null;
    citedProviders: string[]; missingProviders: string[];
  }>;
  movements: Array<{
    promptId: number; prompt: string; provider: string; cited: boolean; previousCited: boolean; createdAt: string;
  }>;
}
export interface ProviderModels {
  provider: string; configured: boolean; models: string[];
  selected: string; recommended: string; isOverride: boolean;
}

// ── SSE Log Stream ────────────────────────────────────────────────────────────

export function createLogStream(onMessage: (entry: LogEntry) => void, onAlive?: () => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    // EventSource can't set headers, so pass the active workspace as a query
    // param — the stream only sends this workspace's logs.
    const ws = getActiveWorkspaceId();
    es = new EventSource(`${BASE}/api/logs/stream${ws ? `?workspace=${encodeURIComponent(ws)}` : ''}`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { type: string } & LogEntry;
        // 'connected' and 'ping' both prove liveness; pings flow every 15s.
        if (data.type === 'connected' || data.type === 'ping') { onAlive?.(); return; }
        if (data.type === 'log') { onAlive?.(); onMessage(data); }
      } catch { /* ignore */ }
    };
    // EventSource retries transient errors itself, but goes permanently CLOSED
    // when the server restarts or the response ends — recreate it ourselves.
    es.onerror = () => {
      if (closed) return;
      if (es?.readyState === EventSource.CLOSED) {
        es.close();
        retryTimer = setTimeout(connect, 3_000);
      }
    };
  }
  connect();

  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    es?.close();
  };
}
