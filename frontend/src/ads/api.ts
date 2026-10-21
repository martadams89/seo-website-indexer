// ads/api.ts — Google Ads contracts and calls for the dashboard.
import { apiFetch } from '../api/client';

export type GuardrailMode = 'read_only' | 'review' | 'guarded';

export interface AdsGuardrails {
  mode: GuardrailMode;
  max_budget_increase_pct: number;
  max_bid_change_pct: number;
  max_operations: number;
  budget_tolerance_pct: number;
  allow_removals: boolean;
  allow_enable_campaigns: boolean;
  allow_bidding_changes: boolean;
}

export interface AdsBrief {
  goal?: string;
  target_cpa?: number | null;
  target_roas?: number | null;
  website?: string;
  offer?: string;
  audience?: string;
  markets?: string;
  competitors?: string[];
  brand_voice?: string;
  never_do?: string;
  notes?: string;
}

export interface AdsAccount {
  id: string;
  workspace_id: string;
  google_account_id: string | null;
  customer_id: string;
  customer_id_formatted: string;
  login_customer_id: string | null;
  name: string | null;
  currency: string | null;
  time_zone: string | null;
  is_manager: boolean;
  test_account: boolean;
  monthly_budget: number | null;
  brief: AdsBrief;
  guardrails: AdsGuardrails;
  enabled: boolean;
  last_error: string | null;
  pending_approvals: number;
  /** Its Google connection was disconnected; relink it from "Find and link client accounts". */
  connection_lost?: boolean;
}

export type ApiState = 'ok' | 'no_scope' | 'api_disabled' | 'access_level' | 'needs_reauth' | 'error' | 'unchecked';

export interface AdsConnectionStatus {
  id: string;
  email: string | null;
  project: string | null;
  has_ads_scope: boolean;
  has_cloud_scope: boolean;
  needs_reauth: boolean;
  api: ApiState;
  access: ApiState;
  accessible_customers: number | null;
  message: string | null;
  hint: string | null;
}

export interface AdsSetup {
  builtin_oauth_client: boolean;
  project: string | null;
  links: { enable_api: string; access_level: string; oauth_consent: string; credentials: string; billing: string; new_project: string };
  connections: AdsConnectionStatus[];
  linked_accounts: number;
  clients_without_budget: number;
  steps: { google_connected: boolean; ads_scope: boolean; api_enabled: boolean; production_access: boolean; accounts_linked: boolean; budgets_set: boolean };
  ready: boolean;
}

export interface DiscoveredCustomer {
  customer_id: string;
  name: string | null;
  currency: string | null;
  time_zone: string | null;
  manager: boolean;
  test_account: boolean;
  status: string | null;
  login_customer_id: string | null;
  level: number;
  error?: string;
  linked_account_id: string | null;
  /** Already linked, but its Google connection was disconnected: selectable to relink. */
  needs_relink?: boolean;
}

export interface DiscoveryResult {
  connections: Array<{ google_account_id: string; email: string | null; customers: DiscoveredCustomer[]; errors: string[]; kind?: string; hint?: string | null }>;
}

export interface Kpis {
  cost: number; impressions: number; clicks: number; conversions: number; conversion_value: number;
  ctr: number | null; avg_cpc: number | null; cpa: number | null; roas: number | null; conversion_rate: number | null;
}

export interface Pacing {
  currency: string | null;
  monthly_budget: number | null;
  month_to_date_spend: number;
  expected_spend_by_now: number | null;
  day_of_month: number;
  days_in_month: number;
  remaining_days_including_today: number;
  enabled_daily_budgets: number;
  average_daily_spend_last_7_days: number;
  projected_month_spend: number;
  recommended_daily_budget_total: number | null;
  status: 'no_budget' | 'under' | 'on_track' | 'over';
  note: string;
}

export interface CampaignRow {
  id: string; name: string; status: string; channel: string | null; bidding: string | null;
  budget_resource: string | null; daily_budget: number | null; budget_shared: boolean;
  search_impression_share: number | null; lost_is_budget: number | null; lost_is_rank: number | null;
  kpis: Kpis;
}

export interface AdsOverview {
  account: { id: string; customer_id: string; name: string | null; currency: string | null; time_zone: string | null };
  period: { days: number; start: string; end: string; previous_start: string; previous_end: string };
  totals: Kpis;
  previous: Kpis;
  change_pct: Partial<Record<keyof Kpis, number | null>>;
  daily: Array<Kpis & { date: string }>;
  campaigns: CampaignRow[];
  pacing: Pacing;
  fetched_at: string;
}

export interface AuditFinding {
  check: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'ok';
  title: string;
  detail: string;
  evidence?: unknown;
  suggested_action?: string;
}

export interface SearchTermRow extends Kpis {
  search_term: string; status: string; campaign_id: string; campaign: string; ad_group_id: string; ad_group: string;
}

export type ChangeStatus = 'pending' | 'needs_approval' | 'blocked' | 'applying' | 'applied' | 'rejected' | 'failed' | 'expired';

export interface AdsChange {
  id: string;
  ads_account_id: string;
  source: 'mcp' | 'ui';
  kind: string;
  summary: string;
  rationale: string | null;
  operations: unknown[];
  impact: {
    currency?: string | null;
    daily_budget_before?: number; daily_budget_after?: number; month_to_date_spend?: number; monthly_budget?: number | null;
    remaining_days?: number; projected_month_spend?: number;
    budget_changes?: Array<{ resource: string; before: number | null; after: number }>;
    bid_changes?: Array<{ resource: string; before: number | null; after: number }>;
    status_changes?: Array<{ resource: string; before: string | null; after: string }>;
  };
  findings: Array<{ code: string; severity: 'info' | 'approval' | 'block'; message: string }>;
  status: ChangeStatus;
  decided_at: string | null;
  applied_at: string | null;
  error: string | null;
  reverts_change_id: string | null;
  created_at: string;
}

export interface RoutineRun {
  id: string;
  ads_account_id: string | null;
  summary: string;
  findings: string[];
  actions: string[];
  next_steps: string[];
  market_notes: string | null;
  created_at: string;
}

export interface RoutineSettings {
  cadence: 'daily' | 'weekdays' | 'twice_weekly' | 'weekly';
  time: string;
  timezone: string;
  mode: 'autopilot' | 'propose';
  lookback_days: number;
  research: 'light' | 'standard' | 'deep';
  focus: string[];
  extra_instructions?: string;
}

export interface RoutineConfig {
  settings: RoutineSettings;
  account_ids: string[];
  connector_name: string;
  focus_areas: Record<string, string>;
  endpoint: string;
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const adsApi = {
  setup: (fresh = false) => apiFetch<AdsSetup>(`/api/ads/setup${fresh ? '?fresh=1' : ''}`),
  enableApi: (googleAccountId: string) => apiFetch<{ ok: boolean; project: string | null; message: string }>('/api/ads/setup/enable-api', { method: 'POST', ...json({ googleAccountId }) }),
  discover: (googleAccountId?: string) => apiFetch<DiscoveryResult>(`/api/ads/discover${googleAccountId ? `?googleAccountId=${encodeURIComponent(googleAccountId)}` : ''}`),
  accounts: () => apiFetch<AdsAccount[]>('/api/ads/accounts'),
  link: (data: { googleAccountId: string; customerId: string; loginCustomerId?: string | null; monthlyBudget?: number | null }) =>
    apiFetch<AdsAccount>('/api/ads/accounts', { method: 'POST', ...json(data) }),
  update: (id: string, data: { monthlyBudget?: number | null; brief?: AdsBrief; guardrails?: Partial<AdsGuardrails>; enabled?: boolean }) =>
    apiFetch<AdsAccount>(`/api/ads/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', ...json(data) }),
  unlink: (id: string) => apiFetch<{ ok: boolean }>(`/api/ads/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  overview: (id: string, days: number, fresh = false) => apiFetch<AdsOverview>(`/api/ads/accounts/${encodeURIComponent(id)}/overview?days=${days}${fresh ? '&fresh=1' : ''}`),
  audit: (id: string) => apiFetch<{ findings: AuditFinding[]; errors: string[]; checked_at: string }>(`/api/ads/accounts/${encodeURIComponent(id)}/audit`),
  searchTerms: (id: string, wasteOnly: boolean) => apiFetch<{ terms: SearchTermRow[]; period: { start: string; end: string } }>(`/api/ads/accounts/${encodeURIComponent(id)}/search-terms?days=30${wasteOnly ? '&wasteOnly=1' : ''}`),
  changes: (params: { accountId?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.accountId) q.set('accountId', params.accountId);
    if (params.status) q.set('status', params.status);
    return apiFetch<AdsChange[]>(`/api/ads/changes${q.size ? `?${q}` : ''}`);
  },
  approve: (id: string) => apiFetch<AdsChange>(`/api/ads/changes/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
  reject: (id: string) => apiFetch<AdsChange>(`/api/ads/changes/${encodeURIComponent(id)}/reject`, { method: 'POST' }),
  revert: (id: string) => apiFetch<AdsChange>(`/api/ads/changes/${encodeURIComponent(id)}/revert`, { method: 'POST' }),
  routineRuns: (accountId?: string) => apiFetch<RoutineRun[]>(`/api/ads/routine-runs${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`),
  routine: () => apiFetch<RoutineConfig>('/api/ads/routine'),
  buildPrompt: (data: { settings: RoutineSettings; accountIds: string[]; connectorName: string; clients: Record<string, { monthlyBudget: number | null; brief: AdsBrief }> }) =>
    apiFetch<{ prompt: string; schedule: string; cron: string }>('/api/ads/routine/prompt', { method: 'POST', ...json(data) }),
};

/** Format an amount in the account currency. */
export function money(value: number | null | undefined, currency: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'GBP', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
  } catch {
    return value.toFixed(digits);
  }
}

export function errorMessage(e: unknown): string {
  const err = e as { message?: string; body?: { hint?: string | null } };
  const base = (err?.message ?? String(e)).replace(/^Error: /, '');
  return err?.body?.hint ? `${base} — ${err.body.hint}` : base;
}
