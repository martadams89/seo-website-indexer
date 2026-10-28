/**
 * ads/store.ts — persistence for Google Ads client accounts, change plans and
 * AI routine history. An "ads account" links one Google Ads customer to one
 * workspace (the client), together with the client's monthly budget, brief and
 * guardrails. Every change made through the app — by a person or by an AI
 * assistant over MCP — is recorded as a change plan, so the change history is
 * also the audit log.
 */
import { randomUUID } from 'crypto';
import { getDb, getGoogleAccountsForWorkspace } from '../db/database.js';
import { GOOGLE_ADS_SCOPE } from '../auth/google-oauth.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type GuardrailMode = 'read_only' | 'review' | 'guarded' | 'auto';

export interface AdsGuardrails {
  /**
   * read_only: no changes. review: every change waits for a person. guarded:
   * changes inside the limits apply straight away. auto: every change is
   * approved automatically; the limits are noted on it but don't hold it.
   */
  mode: GuardrailMode;
  /** Largest daily-budget increase one change may make without approval (percent). */
  max_budget_increase_pct: number;
  /** Largest bid change (up or down) one change may make without approval (percent). */
  max_bid_change_pct: number;
  /** Changes with more operations than this need approval. */
  max_operations: number;
  /** How far projected monthly spend may exceed the monthly budget before approval is needed (percent). */
  budget_tolerance_pct: number;
  /** Removing campaigns, ad groups, ads, keywords or assets without approval. */
  allow_removals: boolean;
  /** Turning paused campaigns on without approval (still subject to the monthly budget). */
  allow_enable_campaigns: boolean;
  /** Changing bid strategies or CPA/ROAS targets without approval. */
  allow_bidding_changes: boolean;
  /** auto mode: a change that takes projected spend past the monthly budget (or raises spend with none set) still waits for a person. */
  auto_keep_budget: boolean;
}

export const DEFAULT_GUARDRAILS: AdsGuardrails = {
  mode: 'guarded',
  max_budget_increase_pct: 20,
  max_bid_change_pct: 25,
  max_operations: 50,
  budget_tolerance_pct: 0,
  allow_removals: false,
  allow_enable_campaigns: true,
  allow_bidding_changes: false,
  auto_keep_budget: true,
};

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
  last_checked_at: string | null;
  last_error: string | null;
  /** Linked GA4 property (numeric ID) the AI reads alongside this Ads account. */
  ga4_property_id: string | null;
  ga4_property_name: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type ChangeStatus = 'pending' | 'needs_approval' | 'blocked' | 'applying' | 'applied' | 'rejected' | 'failed' | 'expired';

export interface GuardrailFinding {
  code: string;
  severity: 'info' | 'approval' | 'block';
  message: string;
}

export interface AdsChange {
  id: string;
  workspace_id: string;
  ads_account_id: string;
  created_by: string | null;
  source: 'mcp' | 'ui';
  kind: string;
  summary: string;
  rationale: string | null;
  operations: unknown[];
  before_state: Record<string, unknown>;
  impact: Record<string, unknown>;
  findings: GuardrailFinding[];
  validation: unknown;
  status: ChangeStatus;
  decided_by: string | null;
  decided_at: string | null;
  applied_at: string | null;
  result: unknown;
  error: string | null;
  reverts_change_id: string | null;
  expires_at: string;
  created_at: string;
}

export interface RoutineRun {
  id: string;
  workspace_id: string;
  ads_account_id: string | null;
  user_id: string | null;
  summary: string;
  findings: string[];
  actions: string[];
  next_steps: string[];
  market_notes: string | null;
  created_at: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Fill in defaults and clamp limits so a malformed or partial value is always safe. */
export function normalizeGuardrails(raw: unknown): AdsGuardrails {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AdsGuardrails, unknown>>;
  const mode: GuardrailMode = value.mode === 'read_only' || value.mode === 'review' || value.mode === 'guarded' || value.mode === 'auto' ? value.mode : DEFAULT_GUARDRAILS.mode;
  const bool = (v: unknown, fallback: boolean) => typeof v === 'boolean' ? v : fallback;
  return {
    mode,
    max_budget_increase_pct: clampNumber(value.max_budget_increase_pct, 0, 500, DEFAULT_GUARDRAILS.max_budget_increase_pct),
    max_bid_change_pct: clampNumber(value.max_bid_change_pct, 0, 500, DEFAULT_GUARDRAILS.max_bid_change_pct),
    max_operations: Math.round(clampNumber(value.max_operations, 1, 1000, DEFAULT_GUARDRAILS.max_operations)),
    budget_tolerance_pct: clampNumber(value.budget_tolerance_pct, 0, 100, DEFAULT_GUARDRAILS.budget_tolerance_pct),
    allow_removals: bool(value.allow_removals, DEFAULT_GUARDRAILS.allow_removals),
    allow_enable_campaigns: bool(value.allow_enable_campaigns, DEFAULT_GUARDRAILS.allow_enable_campaigns),
    allow_bidding_changes: bool(value.allow_bidding_changes, DEFAULT_GUARDRAILS.allow_bidding_changes),
    auto_keep_budget: bool(value.auto_keep_budget, DEFAULT_GUARDRAILS.auto_keep_budget),
  };
}

const text = (v: unknown, max = 2000) => typeof v === 'string' ? v.trim().slice(0, max) : undefined;
const optionalNumber = (v: unknown): number | null | undefined => {
  if (v === null || v === '') return null;
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Keep only known brief fields with sane lengths. */
export function normalizeBrief(raw: unknown): AdsBrief {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const brief: AdsBrief = {};
  for (const key of ['goal', 'website', 'offer', 'audience', 'markets', 'brand_voice', 'never_do', 'notes'] as const) {
    const v = text(value[key]);
    if (v) brief[key] = v;
  }
  const cpa = optionalNumber(value.target_cpa); if (cpa !== undefined) brief.target_cpa = cpa;
  const roas = optionalNumber(value.target_roas); if (roas !== undefined) brief.target_roas = roas;
  const competitors = Array.isArray(value.competitors)
    ? value.competitors
    : typeof value.competitors === 'string' ? value.competitors.split(/[\n,]/) : [];
  const cleaned = competitors.map(c => String(c).trim()).filter(Boolean).slice(0, 25).map(c => c.slice(0, 200));
  if (cleaned.length) brief.competitors = [...new Set(cleaned)];
  return brief;
}

function rowToAccount(row: Record<string, unknown>): AdsAccount {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    google_account_id: (row.google_account_id as string) ?? null,
    customer_id: String(row.customer_id),
    login_customer_id: (row.login_customer_id as string) ?? null,
    name: (row.name as string) ?? null,
    currency: (row.currency as string) ?? null,
    time_zone: (row.time_zone as string) ?? null,
    is_manager: !!row.is_manager,
    test_account: !!row.test_account,
    monthly_budget: row.monthly_budget === null || row.monthly_budget === undefined ? null : Number(row.monthly_budget),
    brief: normalizeBrief(parseJson(row.brief, {})),
    guardrails: normalizeGuardrails(parseJson(row.guardrails, {})),
    enabled: !!row.enabled,
    last_checked_at: (row.last_checked_at as string) ?? null,
    last_error: (row.last_error as string) ?? null,
    ga4_property_id: (row.ga4_property_id as string) ?? null,
    ga4_property_name: (row.ga4_property_name as string) ?? null,
    created_by: (row.created_by as string) ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToChange(row: Record<string, unknown>): AdsChange {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    ads_account_id: String(row.ads_account_id),
    created_by: (row.created_by as string) ?? null,
    source: row.source === 'ui' ? 'ui' : 'mcp',
    kind: String(row.kind),
    summary: String(row.summary),
    rationale: (row.rationale as string) ?? null,
    operations: parseJson(row.operations, []),
    before_state: parseJson(row.before_state, {}),
    impact: parseJson(row.impact, {}),
    findings: parseJson(row.findings, []),
    validation: parseJson(row.validation, null),
    status: String(row.status) as ChangeStatus,
    decided_by: (row.decided_by as string) ?? null,
    decided_at: (row.decided_at as string) ?? null,
    applied_at: (row.applied_at as string) ?? null,
    result: parseJson(row.result, null),
    error: (row.error as string) ?? null,
    reverts_change_id: (row.reverts_change_id as string) ?? null,
    expires_at: String(row.expires_at),
    created_at: String(row.created_at),
  };
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export function listAdsAccounts(workspaceIds: string | string[]): AdsAccount[] {
  const ids = Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds];
  if (!ids.length) return [];
  const rows = getDb().prepare(`SELECT * FROM ads_accounts WHERE workspace_id IN (${ids.map(() => '?').join(',')}) ORDER BY COALESCE(name, customer_id) COLLATE NOCASE`)
    .all(...ids) as Array<Record<string, unknown>>;
  return rows.map(rowToAccount);
}

export function getAdsAccount(id: string): AdsAccount | null {
  const row = getDb().prepare('SELECT * FROM ads_accounts WHERE id=?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToAccount(row) : null;
}

export function linkAdsAccount(input: {
  workspaceId: string; googleAccountId: string; customerId: string; loginCustomerId?: string | null;
  name?: string | null; currency?: string | null; timeZone?: string | null; isManager?: boolean; testAccount?: boolean;
  monthlyBudget?: number | null; createdBy?: string | null;
}): AdsAccount {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM ads_accounts WHERE workspace_id=? AND customer_id=?').get(input.workspaceId, input.customerId) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  if (existing) {
    db.prepare(`UPDATE ads_accounts SET google_account_id=?, login_customer_id=?, name=COALESCE(?, name), currency=COALESCE(?, currency),
      time_zone=COALESCE(?, time_zone), is_manager=?, test_account=?, enabled=1, last_error=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(input.googleAccountId, input.loginCustomerId ?? null, input.name ?? null, input.currency ?? null, input.timeZone ?? null,
        input.isManager ? 1 : 0, input.testAccount ? 1 : 0, id);
  } else {
    db.prepare(`INSERT INTO ads_accounts(id, workspace_id, google_account_id, customer_id, login_customer_id, name, currency, time_zone,
      is_manager, test_account, monthly_budget, brief, guardrails, created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.workspaceId, input.googleAccountId, input.customerId, input.loginCustomerId ?? null, input.name ?? null,
        input.currency ?? null, input.timeZone ?? null, input.isManager ? 1 : 0, input.testAccount ? 1 : 0,
        input.monthlyBudget ?? null, '{}', JSON.stringify(DEFAULT_GUARDRAILS), input.createdBy ?? null);
  }
  return getAdsAccount(id)!;
}

export function updateAdsAccount(id: string, patch: {
  monthlyBudget?: number | null; brief?: unknown; guardrails?: unknown; enabled?: boolean; name?: string | null;
}): AdsAccount | null {
  const current = getAdsAccount(id);
  if (!current) return null;
  const monthly = patch.monthlyBudget === undefined ? current.monthly_budget : patch.monthlyBudget;
  if (monthly !== null && (!Number.isFinite(monthly) || monthly < 0)) throw Object.assign(new Error('Monthly budget must be zero or more.'), { statusCode: 400 });
  const brief = patch.brief === undefined ? current.brief : normalizeBrief(patch.brief);
  const guardrails = patch.guardrails === undefined ? current.guardrails : normalizeGuardrails({ ...current.guardrails, ...(patch.guardrails as object) });
  getDb().prepare(`UPDATE ads_accounts SET monthly_budget=?, brief=?, guardrails=?, enabled=?, name=?, updated_at=datetime('now') WHERE id=?`)
    .run(monthly, JSON.stringify(brief), JSON.stringify(guardrails), (patch.enabled ?? current.enabled) ? 1 : 0,
      patch.name === undefined ? current.name : patch.name, id);
  return getAdsAccount(id);
}

/** Link (or with null, unlink) the GA4 property this Ads client reads. Validation is the caller's job. */
export function setAdsGa4Property(id: string, propertyId: string | null, propertyName: string | null = null): AdsAccount | null {
  getDb().prepare("UPDATE ads_accounts SET ga4_property_id=?, ga4_property_name=?, updated_at=datetime('now') WHERE id=?")
    .run(propertyId, propertyId ? propertyName : null, id);
  return getAdsAccount(id);
}

export function recordAccountCheck(id: string, error: string | null): void {
  getDb().prepare("UPDATE ads_accounts SET last_checked_at=datetime('now'), last_error=? WHERE id=?").run(error, id);
}

export function unlinkAdsAccount(id: string): boolean {
  return getDb().prepare('DELETE FROM ads_accounts WHERE id=?').run(id).changes > 0;
}

/**
 * Disconnecting a Google connection nulls ads_accounts.google_account_id
 * (ON DELETE SET NULL). Reconnecting the same Google login creates a fresh
 * connection row, but nothing points the Ads account back at it, so every
 * Ads call then fails with "No Google connection is linked". Re-attach an
 * orphaned Ads account to its workspace's Google connection with Google Ads
 * access, but only when there is exactly one such connection, so we never
 * guess between logins (the link modal offers a manual relink otherwise).
 * Returns the healed account, or null when it isn't orphaned or can't be
 * decided.
 */
export function healOrphanedAdsAccount(id: string): AdsAccount | null {
  const db = getDb();
  const orphan = db.prepare(`
    SELECT a.workspace_id FROM ads_accounts a
    LEFT JOIN google_accounts g ON g.id = a.google_account_id
    WHERE a.id = ? AND g.id IS NULL
  `).get(id) as { workspace_id: string } | undefined;
  if (!orphan) return null;
  const candidates = getGoogleAccountsForWorkspace(orphan.workspace_id)
    .filter(a => (a.granted_scopes ?? '').split(' ').includes(GOOGLE_ADS_SCOPE));
  if (candidates.length !== 1) return null;
  db.prepare("UPDATE ads_accounts SET google_account_id=?, last_error=NULL, updated_at=datetime('now') WHERE id=?")
    .run(candidates[0].id, id);
  return getAdsAccount(id);
}

/** True when the Ads account's Google connection is missing (disconnected). */
export function isOrphanedAdsAccount(account: AdsAccount): boolean {
  if (!account.google_account_id) return true;
  return !getDb().prepare('SELECT 1 FROM google_accounts WHERE id=?').get(account.google_account_id);
}

/** Heal every orphaned Ads account in these workspaces; returns how many were re-attached. */
export function healOrphanedAdsAccounts(workspaceIds: string | string[]): number {
  let healed = 0;
  for (const account of listAdsAccounts(workspaceIds)) {
    if (isOrphanedAdsAccount(account) && healOrphanedAdsAccount(account.id)) healed++;
  }
  return healed;
}

// ── Change plans ─────────────────────────────────────────────────────────────

export const CHANGE_TTL_MS = 24 * 3_600_000;

export function createChange(input: {
  workspaceId: string; adsAccountId: string; createdBy?: string | null; source: 'mcp' | 'ui'; kind: string;
  summary: string; rationale?: string | null; operations: unknown[]; beforeState?: Record<string, unknown>;
  impact?: Record<string, unknown>; findings: GuardrailFinding[]; validation?: unknown; status: ChangeStatus;
  error?: string | null; revertsChangeId?: string | null;
}): AdsChange {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO ads_changes(id, workspace_id, ads_account_id, created_by, source, kind, summary, rationale, operations,
    before_state, impact, findings, validation, status, error, reverts_change_id, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, input.workspaceId, input.adsAccountId, input.createdBy ?? null, input.source, input.kind,
      input.summary.slice(0, 500), input.rationale?.slice(0, 4000) ?? null, JSON.stringify(input.operations),
      JSON.stringify(input.beforeState ?? {}), JSON.stringify(input.impact ?? {}), JSON.stringify(input.findings),
      input.validation === undefined ? null : JSON.stringify(input.validation), input.status, input.error ?? null,
      input.revertsChangeId ?? null, new Date(Date.now() + CHANGE_TTL_MS).toISOString());
  return getChange(id)!;
}

export function getChange(id: string): AdsChange | null {
  const row = getDb().prepare('SELECT * FROM ads_changes WHERE id=?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToChange(row) : null;
}

/** Plans that were never applied expire after a day; their validation is stale by then. */
export function expireStaleChanges(): number {
  return getDb().prepare(`UPDATE ads_changes SET status='expired'
    WHERE status IN ('pending','needs_approval') AND julianday(expires_at) < julianday('now')`).run().changes;
}

export function listChanges(filter: { workspaceIds: string[]; adsAccountId?: string; status?: ChangeStatus | ChangeStatus[]; limit?: number }): AdsChange[] {
  if (!filter.workspaceIds.length) return [];
  expireStaleChanges();
  const where = [`workspace_id IN (${filter.workspaceIds.map(() => '?').join(',')})`];
  const params: unknown[] = [...filter.workspaceIds];
  if (filter.adsAccountId) { where.push('ads_account_id=?'); params.push(filter.adsAccountId); }
  const statuses = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : [];
  if (statuses.length) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
  params.push(Math.max(1, Math.min(500, filter.limit ?? 100)));
  return (getDb().prepare(`SELECT * FROM ads_changes WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>)
    .map(rowToChange);
}

export function updateChange(id: string, patch: Partial<{
  status: ChangeStatus; findings: GuardrailFinding[]; validation: unknown; decidedBy: string | null; result: unknown; error: string | null;
  applied: boolean; decided: boolean; impact: Record<string, unknown>;
}>): AdsChange | null {
  const sets: string[] = []; const params: unknown[] = [];
  if (patch.status) { sets.push('status=?'); params.push(patch.status); }
  if (patch.findings) { sets.push('findings=?'); params.push(JSON.stringify(patch.findings)); }
  if (patch.validation !== undefined) { sets.push('validation=?'); params.push(JSON.stringify(patch.validation)); }
  if (patch.impact) { sets.push('impact=?'); params.push(JSON.stringify(patch.impact)); }
  if (patch.decidedBy !== undefined) { sets.push('decided_by=?'); params.push(patch.decidedBy); }
  if (patch.decided) sets.push("decided_at=datetime('now')");
  if (patch.applied) sets.push("applied_at=datetime('now')");
  if (patch.result !== undefined) { sets.push('result=?'); params.push(JSON.stringify(patch.result)); }
  if (patch.error !== undefined) { sets.push('error=?'); params.push(patch.error); }
  if (!sets.length) return getChange(id);
  params.push(id);
  getDb().prepare(`UPDATE ads_changes SET ${sets.join(', ')} WHERE id=?`).run(...params);
  return getChange(id);
}

/**
 * Atomically move a change from one of `from` to `to`. Returns false when
 * another request already moved it — the guard against applying twice.
 */
export function transitionChange(id: string, from: ChangeStatus[], to: ChangeStatus): boolean {
  return getDb().prepare(`UPDATE ads_changes SET status=? WHERE id=? AND status IN (${from.map(() => '?').join(',')})`)
    .run(to, id, ...from).changes > 0;
}

// ── Routine history ──────────────────────────────────────────────────────────

const stringList = (value: unknown, max = 50) => (Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [])
  .map(v => String(v).trim()).filter(Boolean).slice(0, max).map(v => v.slice(0, 1000));

export function recordRoutineRun(input: {
  workspaceId: string; adsAccountId?: string | null; userId?: string | null; summary: string;
  findings?: unknown; actions?: unknown; nextSteps?: unknown; marketNotes?: string | null;
}): RoutineRun {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO ads_routine_runs(id, workspace_id, ads_account_id, user_id, summary, findings, actions, next_steps, market_notes)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, input.workspaceId, input.adsAccountId ?? null, input.userId ?? null, input.summary.trim().slice(0, 8000),
    JSON.stringify(stringList(input.findings)), JSON.stringify(stringList(input.actions)), JSON.stringify(stringList(input.nextSteps)),
    input.marketNotes?.trim().slice(0, 8000) || null);
  // Keep the history bounded per workspace.
  getDb().prepare(`DELETE FROM ads_routine_runs WHERE workspace_id=? AND id NOT IN (
    SELECT id FROM ads_routine_runs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 500)`).run(input.workspaceId, input.workspaceId);
  return listRoutineRuns({ workspaceIds: [input.workspaceId], limit: 1 })[0];
}

export function listRoutineRuns(filter: { workspaceIds: string[]; adsAccountId?: string; limit?: number }): RoutineRun[] {
  if (!filter.workspaceIds.length) return [];
  const where = [`workspace_id IN (${filter.workspaceIds.map(() => '?').join(',')})`];
  const params: unknown[] = [...filter.workspaceIds];
  if (filter.adsAccountId) { where.push('ads_account_id=?'); params.push(filter.adsAccountId); }
  params.push(Math.max(1, Math.min(200, filter.limit ?? 20)));
  return (getDb().prepare(`SELECT * FROM ads_routine_runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>)
    .map(row => ({
      id: String(row.id), workspace_id: String(row.workspace_id), ads_account_id: (row.ads_account_id as string) ?? null,
      user_id: (row.user_id as string) ?? null, summary: String(row.summary),
      findings: parseJson(row.findings, []), actions: parseJson(row.actions, []), next_steps: parseJson(row.next_steps, []),
      market_notes: (row.market_notes as string) ?? null, created_at: String(row.created_at),
    }));
}
