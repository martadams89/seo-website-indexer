import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import { getDb } from '../db/database.js';
import { decrypt, encrypt } from '../utils/crypto.js';

export const INTEGRATION_PROVIDERS = [
  'ga4', 'pagespeed', 'cloudflare', 'plausible', 'matomo',
  'wordpress', 'shopify', 'webflow', 'log_ingest', 'rank_feed',
] as const;
export type IntegrationProvider = typeof INTEGRATION_PROVIDERS[number];

export interface Integration {
  id: string;
  workspace_id: string;
  site_id: string | null;
  provider: IntegrationProvider;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  status: 'pending' | 'connected' | 'error' | 'disabled';
  cadence_minutes: number;
  next_sync_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface IntegrationRow extends Omit<Integration, 'config' | 'enabled'> {
  config: string;
  enabled: number;
}

const SECRET_KEY = /(secret|token|password|api[_-]?key|app[_-]?password|authorization)/i;
const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
};

function integrationFromRow(row: IntegrationRow): Integration {
  return {
    ...row,
    enabled: !!row.enabled,
    config: parseJson(decrypt(row.config), {}),
  };
}

export function publicIntegration(integration: Integration): Integration & { configured_secrets: string[] } {
  const config: Record<string, unknown> = {};
  const configured_secrets: string[] = [];
  for (const [key, value] of Object.entries(integration.config)) {
    if (SECRET_KEY.test(key)) {
      if (value) configured_secrets.push(key);
    } else config[key] = value;
  }
  return { ...integration, config, configured_secrets };
}

export function createIntegration(input: {
  workspaceId: string; siteId?: string | null; provider: IntegrationProvider;
  name?: string; config?: Record<string, unknown>; cadenceMinutes?: number; createdBy?: string | null;
}): Integration {
  if (!INTEGRATION_PROVIDERS.includes(input.provider)) throw new Error('Unsupported integration provider.');
  const id = randomUUID();
  const cadence = Math.min(Math.max(Number(input.cadenceMinutes ?? 1440), 60), 43_200);
  getDb().prepare(`
    INSERT INTO integrations(id, workspace_id, site_id, provider, name, config, cadence_minutes, next_sync_at, created_by)
    VALUES(?,?,?,?,?,?,?,datetime('now'),?)
  `).run(id, input.workspaceId, input.siteId ?? null, input.provider,
    input.name?.trim() || providerLabel(input.provider), encrypt(JSON.stringify(input.config ?? {})), cadence, input.createdBy ?? null);
  return getIntegration(input.workspaceId, id)!;
}

export function listIntegrations(workspaceId: string): Integration[] {
  return (getDb().prepare('SELECT * FROM integrations WHERE workspace_id = ? ORDER BY provider, name').all(workspaceId) as IntegrationRow[])
    .map(integrationFromRow);
}

export function getIntegration(workspaceId: string, id: string): Integration | null {
  const row = getDb().prepare('SELECT * FROM integrations WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as IntegrationRow | undefined;
  return row ? integrationFromRow(row) : null;
}

export function updateIntegration(workspaceId: string, id: string, input: {
  siteId?: string | null; name?: string; config?: Record<string, unknown>;
  enabled?: boolean; cadenceMinutes?: number;
}): Integration | null {
  const current = getIntegration(workspaceId, id);
  if (!current) return null;
  const config = input.config ? { ...current.config, ...input.config } : current.config;
  // Empty secret fields mean "leave the write-only value alone".
  if (input.config) {
    for (const [key, value] of Object.entries(input.config)) {
      if (SECRET_KEY.test(key) && (value === '' || value === null)) config[key] = current.config[key];
    }
  }
  const cadence = Math.min(Math.max(Number(input.cadenceMinutes ?? current.cadence_minutes), 60), 43_200);
  const enabled = input.enabled ?? current.enabled;
  getDb().prepare(`
    UPDATE integrations SET site_id=?, name=?, config=?, enabled=?, cadence_minutes=?,
      status=CASE WHEN ? = 0 THEN 'disabled' WHEN enabled = 0 THEN 'pending' ELSE status END,
      next_sync_at=CASE WHEN ? = 1 AND enabled = 0 THEN datetime('now') ELSE next_sync_at END,
      updated_at=datetime('now') WHERE workspace_id=? AND id=?
  `).run(input.siteId === undefined ? current.site_id : input.siteId,
    input.name?.trim() || current.name, encrypt(JSON.stringify(config)), enabled ? 1 : 0, cadence,
    enabled ? 1 : 0, enabled ? 1 : 0, workspaceId, id);
  return getIntegration(workspaceId, id);
}

export function deleteIntegration(workspaceId: string, id: string): boolean {
  return getDb().prepare('DELETE FROM integrations WHERE workspace_id = ? AND id = ?').run(workspaceId, id).changes > 0;
}

export function updateIntegrationSync(id: string, result: { ok: boolean; error?: string | null; synced?: boolean }): void {
  const row = getDb().prepare('SELECT cadence_minutes FROM integrations WHERE id = ?').get(id) as { cadence_minutes: number } | undefined;
  if (!row) return;
  const next = new Date(Date.now() + row.cadence_minutes * 60_000).toISOString();
  getDb().prepare(`UPDATE integrations SET status=?, last_error=?, last_sync_at=CASE WHEN ? THEN datetime('now') ELSE last_sync_at END,
    next_sync_at=?, updated_at=datetime('now') WHERE id=?`)
    .run(result.ok ? 'connected' : 'error', result.error ?? null, result.synced === false ? 0 : 1, next, id);
}

export function dueIntegrations(limit = 20): Integration[] {
  return (getDb().prepare(`SELECT * FROM integrations WHERE enabled=1
    AND (next_sync_at IS NULL OR julianday(next_sync_at) <= julianday('now'))
    ORDER BY COALESCE(next_sync_at, created_at) LIMIT ?`).all(limit) as IntegrationRow[]).map(integrationFromRow);
}

export function providerLabel(provider: IntegrationProvider): string {
  return ({ ga4: 'Google Analytics 4', pagespeed: 'PageSpeed + CrUX', cloudflare: 'Cloudflare',
    plausible: 'Plausible', matomo: 'Matomo', wordpress: 'WordPress', shopify: 'Shopify',
    webflow: 'Webflow', log_ingest: 'Server log ingest', rank_feed: 'External rank feed' })[provider];
}

export interface MetricObservation {
  id: number; workspace_id: string; site_id: string | null; source: string; metric: string;
  dimension: string; value: number; unit: string | null; observed_at: string;
  provenance: Record<string, unknown>; created_at: string;
}

export function recordMetric(input: Omit<MetricObservation, 'id' | 'created_at' | 'provenance'> & { provenance?: Record<string, unknown> }): void {
  getDb().prepare(`INSERT INTO metric_observations(workspace_id, site_id, source, metric, dimension, value, unit, observed_at, provenance)
    VALUES(@workspace_id,@site_id,@source,@metric,@dimension,@value,@unit,@observed_at,@provenance)
    ON CONFLICT(workspace_id,site_id,source,metric,dimension,observed_at) DO UPDATE SET
      value=excluded.value, unit=excluded.unit, provenance=excluded.provenance`)
    .run({ ...input, site_id: input.site_id ?? null, dimension: input.dimension ?? '', unit: input.unit ?? null,
      provenance: JSON.stringify(input.provenance ?? {}) });
}

export interface MetricSiteScope {
  siteId?: string;
  workspaceOnly?: boolean;
}

export function listMetrics(workspaceId: string, filters: MetricSiteScope & {
  source?: string; metric?: string; from?: string; to?: string; limit?: number;
} = {}): MetricObservation[] {
  const clauses = ['workspace_id = ?']; const params: unknown[] = [workspaceId];
  if (filters.source) { clauses.push('source = ?'); params.push(filters.source); }
  if (filters.metric) { clauses.push('metric = ?'); params.push(filters.metric); }
  if (filters.workspaceOnly) clauses.push('site_id IS NULL');
  else if (filters.siteId) { clauses.push('site_id = ?'); params.push(filters.siteId); }
  if (filters.from) { clauses.push('observed_at >= ?'); params.push(filters.from); }
  if (filters.to) { clauses.push('observed_at <= ?'); params.push(filters.to); }
  params.push(Math.min(Math.max(filters.limit ?? 500, 1), 5000));
  return (getDb().prepare(`SELECT * FROM metric_observations WHERE ${clauses.join(' AND ')} ORDER BY observed_at DESC, id DESC LIMIT ?`)
    .all(...params) as Array<Omit<MetricObservation, 'provenance'> & { provenance: string }>).map(row => ({ ...row, provenance: parseJson(row.provenance, {}) }));
}

export interface MetricForecast {
  source: string; metric: string; unit: string | null; history_days: number; horizon_days: number;
  current: number; forecast: number; lower: number; upper: number; daily_slope: number;
  method: string; generated_at: string;
}

/** Transparent baseline forecast: ordinary least squares over daily totals,
 * with a 90% residual band. It is intentionally explainable and is hidden
 * until at least seven observations exist. */
export function forecastMetrics(workspaceId: string, horizonDays = 30, scope: MetricSiteScope = {}): MetricForecast[] {
  const horizon = Math.min(Math.max(Math.round(horizonDays), 7), 90);
  // Only additive operational totals are meaningful when dimensions are
  // summed. Scores, positions, rates and latency snapshots must never be
  // projected as if adding mobile + desktop or page-level readings made a KPI.
  const siteClause = scope.workspaceOnly ? 'AND site_id IS NULL' : scope.siteId ? 'AND site_id=?' : '';
  const params: unknown[] = [workspaceId];
  if (scope.siteId && !scope.workspaceOnly) params.push(scope.siteId);
  const rows = getDb().prepare(`SELECT source,metric,unit,substr(observed_at,1,10) day,SUM(value) value
    FROM metric_observations WHERE workspace_id=? ${siteClause} AND observed_at>=datetime('now','-120 days')
    AND metric IN ('sessions','conversions','revenue','visits','pageviews','edge_requests','edge_bytes','edge_visits','requests','bytes')
    GROUP BY source,metric,unit,substr(observed_at,1,10) ORDER BY source,metric,unit,day`).all(...params) as Array<{ source: string; metric: string; unit: string | null; day: string; value: number }>;
  const groups = new Map<string, typeof rows>();
  for (const row of rows) { const key = `${row.source}\n${row.metric}\n${row.unit ?? ''}`; groups.set(key, [...(groups.get(key) ?? []), row]); }
  const forecasts: MetricForecast[] = [];
  for (const series of groups.values()) {
    if (series.length < 7) continue;
    const n = series.length; const meanX = (n - 1) / 2; const meanY = series.reduce((sum, row) => sum + Number(row.value), 0) / n;
    let numerator = 0; let denominator = 0;
    series.forEach((row, index) => { numerator += (index - meanX) * (Number(row.value) - meanY); denominator += (index - meanX) ** 2; });
    const slope = denominator ? numerator / denominator : 0; const intercept = meanY - slope * meanX;
    const residuals = series.map((row, index) => Number(row.value) - (intercept + slope * index));
    const sigma = Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / Math.max(n - 2, 1));
    const projected = Math.max(0, intercept + slope * (n - 1 + horizon)); const band = 1.645 * sigma * Math.sqrt(1 + horizon / n);
    forecasts.push({ source: series[0].source, metric: series[0].metric, unit: series[0].unit, history_days: n, horizon_days: horizon,
      current: Number(series[n - 1].value), forecast: projected, lower: Math.max(0, projected - band), upper: projected + band,
      daily_slope: slope, method: 'Linear trend over additive daily totals; 90% residual confidence band.', generated_at: new Date().toISOString() });
  }
  return forecasts.sort((a, b) => Math.abs(b.daily_slope) - Math.abs(a.daily_slope)).slice(0, 12);
}

export interface WorkItem {
  id: string; workspace_id: string; site_id: string | null; source: string; source_ref: string | null;
  title: string; description: string | null; evidence: Record<string, unknown>; severity: string;
  status: string; assignee_user_id: string | null; assignee_name?: string | null; assignee_email?: string | null;
  due_at: string | null; snoozed_until: string | null; deep_link: string | null;
  created_at: string; updated_at: string; resolved_at: string | null;
}

export function createWorkItem(input: {
  workspaceId: string; siteId?: string | null; source: string; sourceRef?: string | null; title: string;
  description?: string | null; evidence?: Record<string, unknown>; severity?: string; assigneeUserId?: string | null;
  dueAt?: string | null; deepLink?: string | null;
}): WorkItem {
  if (input.sourceRef) {
    const existing = getDb().prepare(`SELECT id FROM work_items WHERE workspace_id=? AND source=? AND source_ref=?
      AND status NOT IN ('done','dismissed') LIMIT 1`).get(input.workspaceId, input.source, input.sourceRef) as { id: string } | undefined;
    if (existing) return getWorkItem(input.workspaceId, existing.id)!;
  }
  const id = randomUUID();
  getDb().prepare(`INSERT INTO work_items(id,workspace_id,site_id,source,source_ref,title,description,evidence,severity,assignee_user_id,due_at,deep_link)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.workspaceId, input.siteId ?? null, input.source, input.sourceRef ?? null,
      input.title.trim(), input.description ?? null, JSON.stringify(input.evidence ?? {}), input.severity ?? 'medium',
      input.assigneeUserId ?? null, input.dueAt ?? null, input.deepLink ?? null);
  void dispatchWorkspaceEvent(input.workspaceId, 'work_item.created', { id, title: input.title, severity: input.severity ?? 'medium' });
  return getWorkItem(input.workspaceId, id)!;
}

export function getWorkItem(workspaceId: string, id: string): WorkItem | null {
  const row = getDb().prepare(`SELECT wi.*,u.name assignee_name,u.email assignee_email FROM work_items wi
    LEFT JOIN users u ON u.id=wi.assignee_user_id WHERE wi.workspace_id=? AND wi.id=?`).get(workspaceId, id) as (Omit<WorkItem, 'evidence'> & { evidence: string }) | undefined;
  return row ? { ...row, evidence: parseJson(row.evidence, {}) } : null;
}

export function listWorkItems(workspaceId: string, filters: { status?: string; assignee?: string; includeSnoozed?: boolean; limit?: number } = {}): WorkItem[] {
  const clauses = ['wi.workspace_id=?']; const params: unknown[] = [workspaceId];
  if (filters.status) { clauses.push('wi.status=?'); params.push(filters.status); }
  if (filters.assignee) { clauses.push('wi.assignee_user_id=?'); params.push(filters.assignee); }
  if (!filters.includeSnoozed) clauses.push("(wi.snoozed_until IS NULL OR julianday(wi.snoozed_until) <= julianday('now'))");
  params.push(Math.min(Math.max(filters.limit ?? 200, 1), 500));
  return (getDb().prepare(`SELECT wi.*,u.name assignee_name,u.email assignee_email FROM work_items wi
    LEFT JOIN users u ON u.id=wi.assignee_user_id WHERE ${clauses.join(' AND ')}
    ORDER BY CASE wi.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, wi.created_at DESC LIMIT ?`)
    .all(...params) as Array<Omit<WorkItem, 'evidence'> & { evidence: string }>).map(row => ({ ...row, evidence: parseJson(row.evidence, {}) }));
}

export function updateWorkItem(workspaceId: string, id: string, changes: {
  status?: string; assigneeUserId?: string | null; dueAt?: string | null; snoozedUntil?: string | null; severity?: string;
}): WorkItem | null {
  const item = getWorkItem(workspaceId, id); if (!item) return null;
  const status = changes.status ?? item.status;
  getDb().prepare(`UPDATE work_items SET status=?,assignee_user_id=?,due_at=?,snoozed_until=?,severity=?,
    resolved_at=CASE WHEN ? IN ('done','dismissed') THEN datetime('now') ELSE NULL END,updated_at=datetime('now')
    WHERE workspace_id=? AND id=?`).run(status, changes.assigneeUserId === undefined ? item.assignee_user_id : changes.assigneeUserId,
      changes.dueAt === undefined ? item.due_at : changes.dueAt, changes.snoozedUntil === undefined ? item.snoozed_until : changes.snoozedUntil,
      changes.severity ?? item.severity, status, workspaceId, id);
  void dispatchWorkspaceEvent(workspaceId, 'work_item.updated', { id, status });
  return getWorkItem(workspaceId, id);
}

export function bulkUpdateWorkItems(workspaceId: string, ids: string[], changes: Parameters<typeof updateWorkItem>[2]): WorkItem[] {
  return getDb().transaction(() => ids.slice(0, 200).map(id => updateWorkItem(workspaceId, id, changes)).filter((v): v is WorkItem => !!v))();
}

export function addAnnotation(input: { workspaceId: string; siteId?: string | null; userId?: string | null; kind?: string; title: string; note?: string | null; eventAt?: string; metadata?: Record<string, unknown> }): string {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO annotations(id,workspace_id,site_id,user_id,kind,title,note,event_at,metadata) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id, input.workspaceId, input.siteId ?? null, input.userId ?? null, input.kind ?? 'note', input.title.trim(), input.note ?? null,
      input.eventAt ?? new Date().toISOString(), JSON.stringify(input.metadata ?? {}));
  return id;
}

export function listTimeline(workspaceId: string, limit = 200): Array<Record<string, unknown>> {
  const notes = getDb().prepare(`SELECT id,site_id,user_id,kind,title,note,event_at,metadata,created_at FROM annotations
    WHERE workspace_id=? ORDER BY event_at DESC LIMIT ?`).all(workspaceId, limit) as Array<Record<string, unknown>>;
  return notes.map(row => ({ ...row, metadata: parseJson(String(row.metadata ?? ''), {}) }));
}

export function saveDashboardView(input: { workspaceId: string; userId: string; id?: string; name: string; config: Record<string, unknown>; isDefault?: boolean }): string {
  const id = input.id ?? randomUUID();
  const db = getDb();
  db.transaction(() => {
    if (input.id) {
      const owned = db.prepare('SELECT 1 FROM dashboard_views WHERE id=? AND workspace_id=? AND user_id=?').get(id, input.workspaceId, input.userId);
      if (!owned) throw new Error('Saved view not found.');
    }
    if (input.isDefault) db.prepare('UPDATE dashboard_views SET is_default=0 WHERE workspace_id=? AND user_id=?').run(input.workspaceId, input.userId);
    db.prepare(`INSERT INTO dashboard_views(id,workspace_id,user_id,name,config,is_default) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,config=excluded.config,is_default=excluded.is_default,updated_at=datetime('now')`)
      .run(id, input.workspaceId, input.userId, input.name.trim(), JSON.stringify(input.config), input.isDefault ? 1 : 0);
  })();
  return id;
}

export function listDashboardViews(workspaceId: string, userId: string): Array<Record<string, unknown>> {
  return (getDb().prepare('SELECT * FROM dashboard_views WHERE workspace_id=? AND user_id=? ORDER BY is_default DESC,name').all(workspaceId, userId) as Array<Record<string, unknown>>)
    .map(row => ({ ...row, config: parseJson(String(row.config), {}) }));
}

export function deleteDashboardView(workspaceId: string, userId: string, id: string): boolean {
  return getDb().prepare('DELETE FROM dashboard_views WHERE workspace_id=? AND user_id=? AND id=?').run(workspaceId, userId, id).changes > 0;
}

export interface UsageEntry {
  id: string; workspace_id: string; user_id: string | null; provider: string; operation: string;
  quantity: number; unit: string; estimated_cost: number; metadata: Record<string, unknown>; occurred_at: string;
}

export function recordUsage(input: Omit<UsageEntry, 'id' | 'metadata' | 'occurred_at'> & { metadata?: Record<string, unknown>; occurredAt?: string }): string {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO usage_ledger(id,workspace_id,user_id,provider,operation,quantity,unit,estimated_cost,metadata,occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, input.workspace_id, input.user_id ?? null, input.provider, input.operation,
      input.quantity, input.unit, input.estimated_cost ?? 0, JSON.stringify(input.metadata ?? {}), input.occurredAt ?? new Date().toISOString());
  return id;
}

export function usageSummary(workspaceId: string, from?: string, to?: string): { total_cost: number; rows: Array<Record<string, unknown>> } {
  const start = from ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  const end = to ?? new Date().toISOString();
  const rows = getDb().prepare(`SELECT provider,operation,unit,SUM(quantity) quantity,SUM(estimated_cost) estimated_cost,COUNT(*) events
    FROM usage_ledger WHERE workspace_id=? AND occurred_at BETWEEN ? AND ? GROUP BY provider,operation,unit ORDER BY estimated_cost DESC,quantity DESC`)
    .all(workspaceId, start, end) as Array<Record<string, unknown>>;
  return { total_cost: rows.reduce((sum, row) => sum + Number(row.estimated_cost ?? 0), 0), rows };
}

export function listUsage(workspaceId: string, limit = 1000): UsageEntry[] {
  return (getDb().prepare('SELECT * FROM usage_ledger WHERE workspace_id=? ORDER BY occurred_at DESC LIMIT ?').all(workspaceId, Math.min(limit, 5000)) as Array<Omit<UsageEntry, 'metadata'> & { metadata: string }>)
    .map(row => ({ ...row, metadata: parseJson(row.metadata, {}) }));
}

export function upsertBudget(input: { id?: string; workspaceId: string; userId?: string | null; provider?: string | null; period?: string; limitValue: number; limitUnit?: string; warningPct?: number; hardLimit?: boolean }): string {
  const id = input.id ?? randomUUID();
  if (input.id && !getDb().prepare('SELECT 1 FROM budget_policies WHERE id=? AND workspace_id=?').get(id, input.workspaceId)) {
    throw new Error('Budget policy not found.');
  }
  getDb().prepare(`INSERT INTO budget_policies(id,workspace_id,user_id,provider,period,limit_value,limit_unit,warning_pct,hard_limit)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,provider=excluded.provider,period=excluded.period,
      limit_value=excluded.limit_value,limit_unit=excluded.limit_unit,warning_pct=excluded.warning_pct,hard_limit=excluded.hard_limit,updated_at=datetime('now')`)
    .run(id, input.workspaceId, input.userId ?? null, input.provider ?? null, input.period ?? 'monthly', Math.max(input.limitValue, 0),
      input.limitUnit ?? 'cost', Math.min(Math.max(input.warningPct ?? 80, 1), 100), input.hardLimit ? 1 : 0);
  return id;
}

export function listBudgets(workspaceId: string): Array<Record<string, unknown>> {
  return getDb().prepare(`SELECT bp.*,u.name user_name,u.email user_email FROM budget_policies bp LEFT JOIN users u ON u.id=bp.user_id
    WHERE bp.workspace_id=? ORDER BY bp.provider,bp.user_id`).all(workspaceId) as Array<Record<string, unknown>>;
}

export function deleteBudget(workspaceId: string, id: string): boolean {
  return getDb().prepare('DELETE FROM budget_policies WHERE workspace_id=? AND id=?').run(workspaceId, id).changes > 0;
}

export function budgetStatus(workspaceId: string): Array<Record<string, unknown>> {
  const policies = listBudgets(workspaceId);
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  return policies.map(policy => {
    const from = policy.period === 'daily' ? dayStart.toISOString() : monthStart.toISOString();
    const providerClause = policy.provider ? 'AND provider=@provider' : '';
    const userClause = policy.user_id ? 'AND user_id=@user_id' : '';
    const row = getDb().prepare(`SELECT COALESCE(SUM(CASE WHEN @unit='cost' THEN estimated_cost ELSE quantity END),0) used
      FROM usage_ledger WHERE workspace_id=@workspace_id AND occurred_at>=@from ${providerClause} ${userClause}`)
      .get({ workspace_id: workspaceId, from, provider: policy.provider, user_id: policy.user_id, unit: policy.limit_unit }) as { used: number };
    const pct = Number(policy.limit_value) ? row.used / Number(policy.limit_value) * 100 : 0;
    return { ...policy, used: row.used, percentage: Math.round(pct * 10) / 10, exceeded: pct >= 100, warning: pct >= Number(policy.warning_pct) };
  });
}

/**
 * Enforce only explicit hard-stop policies. Metering remains useful without a
 * policy, while warnings stay advisory and visible in the governance UI.
 */
export function assertWithinBudget(input: { workspaceId: string; userId?: string | null; provider: string; quantity?: number; estimatedCost?: number }): void {
  const policies = budgetStatus(input.workspaceId).filter(policy => Boolean(policy.hard_limit)
    && (!policy.provider || policy.provider === input.provider)
    && (!policy.user_id || policy.user_id === (input.userId ?? null)));
  for (const policy of policies) {
    const projected = Number(policy.used) + (policy.limit_unit === 'cost' ? Number(input.estimatedCost ?? 0) : Number(input.quantity ?? 1));
    if (projected > Number(policy.limit_value)) {
      const target = policy.user_id ? 'user' : 'workspace';
      throw Object.assign(new Error(`${target[0].toUpperCase()}${target.slice(1)} ${policy.period} ${policy.limit_unit} budget reached for ${policy.provider || 'all providers'}.`), {
        statusCode: 429, code: 'BUDGET_EXCEEDED', policyId: policy.id,
      });
    }
  }
}

export function createWebhook(input: { workspaceId: string; name: string; url: string; events: string[] }): { id: string; signingSecret: string } {
  const id = randomUUID(); const signingSecret = randomBytes(32).toString('base64url');
  getDb().prepare('INSERT INTO outbound_webhooks(id,workspace_id,name,url,secret,events) VALUES(?,?,?,?,?,?)')
    .run(id, input.workspaceId, input.name.trim(), input.url.trim(), encrypt(signingSecret), JSON.stringify(input.events));
  return { id, signingSecret };
}

export function listWebhooks(workspaceId: string): Array<Record<string, unknown>> {
  return (getDb().prepare('SELECT id,workspace_id,name,url,events,enabled,failure_count,last_delivery_at,last_error,created_at FROM outbound_webhooks WHERE workspace_id=? ORDER BY name').all(workspaceId) as Array<Record<string, unknown>>)
    .map(row => ({ ...row, enabled: !!row.enabled, events: parseJson(String(row.events), []) }));
}

export function deleteWebhook(workspaceId: string, id: string): boolean {
  return getDb().prepare('DELETE FROM outbound_webhooks WHERE workspace_id=? AND id=?').run(workspaceId, id).changes > 0;
}

export async function dispatchWorkspaceEvent(workspaceId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  const hooks = getDb().prepare('SELECT * FROM outbound_webhooks WHERE workspace_id=? AND enabled=1').all(workspaceId) as Array<{ id: string; url: string; secret: string; events: string }>;
  await Promise.allSettled(hooks.filter(hook => {
    const events = parseJson<string[]>(hook.events, []); return events.includes('*') || events.includes(event);
  }).map(async hook => {
    const body = JSON.stringify({ id: randomUUID(), event, workspace_id: workspaceId, occurred_at: new Date().toISOString(), data: payload });
    const secret = decrypt(hook.secret) ?? '';
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    try {
      const res = await fetch(hook.url, { method: 'POST', headers: { 'Content-Type': 'application/json',
        'X-Organic-Event': event, 'X-Organic-Signature': `sha256=${signature}` }, body, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      getDb().prepare("UPDATE outbound_webhooks SET failure_count=0,last_delivery_at=datetime('now'),last_error=NULL WHERE id=?").run(hook.id);
    } catch (error) {
      getDb().prepare('UPDATE outbound_webhooks SET failure_count=failure_count+1,last_delivery_at=datetime(\'now\'),last_error=? WHERE id=?')
        .run(error instanceof Error ? error.message : String(error), hook.id);
    }
  }));
}

export function createServiceToken(input: { workspaceId: string; userId: string; name: string; scopes: string[]; expiresAt?: string | null }): { id: string; token: string } {
  const id = randomUUID(); const token = `oc_${randomBytes(32).toString('base64url')}`;
  getDb().prepare('INSERT INTO service_tokens(id,workspace_id,user_id,name,token_hash,scopes,expires_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, input.workspaceId, input.userId, input.name.trim(), createHash('sha256').update(token).digest('hex'), JSON.stringify(input.scopes), input.expiresAt ?? null);
  return { id, token };
}

export function listServiceTokens(workspaceId: string): Array<Record<string, unknown>> {
  return (getDb().prepare('SELECT id,workspace_id,user_id,name,scopes,expires_at,last_used_at,revoked_at,created_at FROM service_tokens WHERE workspace_id=? ORDER BY created_at DESC').all(workspaceId) as Array<Record<string, unknown>>)
    .map(row => ({ ...row, scopes: parseJson(String(row.scopes), []) }));
}

export function revokeServiceToken(workspaceId: string, id: string): boolean {
  return getDb().prepare("UPDATE service_tokens SET revoked_at=datetime('now') WHERE workspace_id=? AND id=? AND revoked_at IS NULL").run(workspaceId, id).changes > 0;
}

export function authenticateServiceToken(raw: string, requiredScope: string): { id: string; workspaceId: string; userId: string | null; scopes: string[] } | null {
  const hash = createHash('sha256').update(raw).digest('hex');
  const row = getDb().prepare(`SELECT id,workspace_id,user_id,scopes FROM service_tokens WHERE token_hash=? AND revoked_at IS NULL
    AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))`).get(hash) as { id: string; workspace_id: string; user_id: string | null; scopes: string } | undefined;
  if (!row) return null;
  const scopes = parseJson<string[]>(row.scopes, []);
  if (!scopes.includes('*') && !scopes.includes(requiredScope)) return null;
  getDb().prepare("UPDATE service_tokens SET last_used_at=datetime('now') WHERE token_hash=?").run(hash);
  return { id: row.id, workspaceId: row.workspace_id, userId: row.user_id, scopes };
}

export interface LocalEntity {
  id: string; workspace_id: string; site_id: string | null; name: string; market: string; locale: string; entity_type: string;
  primary_url: string | null; address: string | null; phone: string | null; identifiers: Record<string, string>;
  listings: Array<{ provider: string; url?: string; status?: string; rating?: number; review_count?: number }>;
  knowledge: Record<string, unknown>; review_rating: number | null; review_count: number | null;
  consistency_score: number; created_at: string; updated_at: string;
}

function entityFromRow(row: Record<string, unknown>): LocalEntity {
  const identifiers = parseJson<Record<string, string>>(String(row.identifiers ?? ''), {});
  const listings = parseJson<LocalEntity['listings']>(String(row.listings ?? ''), []);
  const knowledge = parseJson<Record<string, unknown>>(String(row.knowledge ?? ''), {});
  const core = [row.name, row.market, row.primary_url, row.address, row.phone].filter(Boolean).length / 5 * 50;
  const verifiedListings = listings.filter(item => item.status === 'consistent' || item.status === 'verified').length;
  const listing = listings.length ? verifiedListings / listings.length * 25 : 0;
  const knowledgeScore = Math.min((Object.keys(identifiers).length + Object.keys(knowledge).length) * 5, 15);
  const reviewScore = (row.review_rating != null ? 5 : 0) + (row.review_count != null ? 5 : 0);
  return { ...row, identifiers, listings, knowledge, consistency_score: Math.round(core + listing + knowledgeScore + reviewScore) } as unknown as LocalEntity;
}

export function listLocalEntities(workspaceId: string): LocalEntity[] {
  return (getDb().prepare('SELECT * FROM local_entities WHERE workspace_id=? ORDER BY market,name').all(workspaceId) as Array<Record<string, unknown>>).map(entityFromRow);
}

export function saveLocalEntity(input: { id?: string; workspaceId: string; siteId?: string | null; name: string; market: string; locale?: string; entityType?: string; primaryUrl?: string | null; address?: string | null; phone?: string | null; identifiers?: Record<string, string>; listings?: LocalEntity['listings']; knowledge?: Record<string, unknown>; reviewRating?: number | null; reviewCount?: number | null }): LocalEntity {
  const id = input.id ?? randomUUID(); const db = getDb();
  if (input.id && !db.prepare('SELECT 1 FROM local_entities WHERE id=? AND workspace_id=?').get(id, input.workspaceId)) throw new Error('Entity not found.');
  db.prepare(`INSERT INTO local_entities(id,workspace_id,site_id,name,market,locale,entity_type,primary_url,address,phone,identifiers,listings,knowledge,review_rating,review_count)
    VALUES(@id,@workspace_id,@site_id,@name,@market,@locale,@entity_type,@primary_url,@address,@phone,@identifiers,@listings,@knowledge,@review_rating,@review_count)
    ON CONFLICT(id) DO UPDATE SET site_id=excluded.site_id,name=excluded.name,market=excluded.market,locale=excluded.locale,
      entity_type=excluded.entity_type,primary_url=excluded.primary_url,address=excluded.address,phone=excluded.phone,
      identifiers=excluded.identifiers,listings=excluded.listings,knowledge=excluded.knowledge,review_rating=excluded.review_rating,
      review_count=excluded.review_count,updated_at=datetime('now')`).run({ id, workspace_id: input.workspaceId, site_id: input.siteId ?? null,
        name: input.name.trim(), market: input.market.trim(), locale: input.locale ?? 'en-GB', entity_type: input.entityType ?? 'brand',
        primary_url: input.primaryUrl ?? null, address: input.address ?? null, phone: input.phone ?? null,
        identifiers: JSON.stringify(input.identifiers ?? {}), listings: JSON.stringify(input.listings ?? []), knowledge: JSON.stringify(input.knowledge ?? {}),
        review_rating: input.reviewRating ?? null, review_count: input.reviewCount ?? null });
  return entityFromRow(db.prepare('SELECT * FROM local_entities WHERE id=? AND workspace_id=?').get(id, input.workspaceId) as Record<string, unknown>);
}

export function deleteLocalEntity(workspaceId: string, id: string): boolean {
  return getDb().prepare('DELETE FROM local_entities WHERE workspace_id=? AND id=?').run(workspaceId, id).changes > 0;
}

export interface ContentAction {
  id: string; workspace_id: string; site_id: string | null; integration_id: string | null;
  created_by: string | null; approved_by: string | null; kind: string; title: string;
  rationale: string | null; evidence: Record<string, unknown>; payload: Record<string, unknown>;
  rollback_payload: Record<string, unknown>; remote_id: string | null; preview_url: string | null;
  status: string; last_error: string | null; created_at: string; updated_at: string;
  published_at: string | null; verified_at: string | null;
}

function actionFromRow(row: Record<string, unknown>): ContentAction {
  return { ...row, evidence: parseJson(String(row.evidence ?? ''), {}), payload: parseJson(String(row.payload ?? ''), {}),
    rollback_payload: parseJson(String(row.rollback_payload ?? ''), {}) } as unknown as ContentAction;
}

export function createContentAction(input: { workspaceId: string; siteId?: string | null; integrationId?: string | null; userId: string; kind: string; title: string; rationale?: string | null; evidence?: Record<string, unknown>; payload: Record<string, unknown> }): ContentAction {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO content_actions(id,workspace_id,site_id,integration_id,created_by,kind,title,rationale,evidence,payload,rollback_payload)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.workspaceId, input.siteId ?? null, input.integrationId ?? null, input.userId,
      input.kind, input.title.trim(), input.rationale ?? null, JSON.stringify(input.evidence ?? {}), JSON.stringify(input.payload), '{}');
  addAnnotation({ workspaceId: input.workspaceId, siteId: input.siteId, userId: input.userId, kind: 'proposal', title: `Proposed: ${input.title}`, metadata: { action_id: id } });
  return getContentAction(input.workspaceId, id)!;
}

export function getContentAction(workspaceId: string, id: string): ContentAction | null {
  const row = getDb().prepare('SELECT * FROM content_actions WHERE workspace_id=? AND id=?').get(workspaceId, id) as Record<string, unknown> | undefined;
  return row ? actionFromRow(row) : null;
}

export function listContentActions(workspaceId: string): ContentAction[] {
  return (getDb().prepare('SELECT * FROM content_actions WHERE workspace_id=? ORDER BY created_at DESC').all(workspaceId) as Array<Record<string, unknown>>).map(actionFromRow);
}

export function updateContentAction(workspaceId: string, id: string, changes: { status?: string; approvedBy?: string | null; remoteId?: string | null; previewUrl?: string | null; rollbackPayload?: Record<string, unknown>; error?: string | null }): ContentAction | null {
  const current = getContentAction(workspaceId, id); if (!current) return null;
  const status = changes.status ?? current.status;
  getDb().prepare(`UPDATE content_actions SET status=?,approved_by=?,remote_id=?,preview_url=?,rollback_payload=?,last_error=?,
    published_at=CASE WHEN ?='published' THEN datetime('now') ELSE published_at END,
    verified_at=CASE WHEN ?='verified' THEN datetime('now') ELSE verified_at END,updated_at=datetime('now') WHERE workspace_id=? AND id=?`)
    .run(status, changes.approvedBy === undefined ? current.approved_by : changes.approvedBy,
      changes.remoteId === undefined ? current.remote_id : changes.remoteId, changes.previewUrl === undefined ? current.preview_url : changes.previewUrl,
      JSON.stringify(changes.rollbackPayload ?? current.rollback_payload), changes.error ?? null, status, status, workspaceId, id);
  if (status !== current.status) {
    addAnnotation({ workspaceId, siteId: current.site_id, userId: changes.approvedBy ?? current.approved_by, kind: 'content_change',
      title: `${current.title}: ${status.replaceAll('_',' ')}`, metadata: { action_id: id, from: current.status, to: status } });
    void dispatchWorkspaceEvent(workspaceId, `content.${status}`, { id, title: current.title, from: current.status, to: status });
  }
  return getContentAction(workspaceId, id);
}

export function platformOverview(workspaceId: string, scope: MetricSiteScope = {}): Record<string, unknown> {
  const db = getDb();
  const siteClause = scope.workspaceOnly ? 'AND site_id IS NULL' : scope.siteId ? 'AND site_id=?' : '';
  const scopedParams = () => scope.siteId && !scope.workspaceOnly ? [workspaceId, scope.siteId] : [workspaceId];
  const integrationRows = db.prepare(`SELECT provider,status,COUNT(*) count,MAX(last_sync_at) last_sync_at FROM integrations
    WHERE workspace_id=? ${siteClause} GROUP BY provider,status ORDER BY provider`).all(...scopedParams());
  const work = db.prepare(`SELECT status,severity,COUNT(*) count FROM work_items WHERE workspace_id=? ${siteClause} GROUP BY status,severity`).all(...scopedParams());
  const freshness = db.prepare(`SELECT source,MAX(observed_at) observed_at,COUNT(*) observations FROM metric_observations
    WHERE workspace_id=? ${siteClause} GROUP BY source ORDER BY source`).all(...scopedParams());
  const actions = db.prepare(`SELECT status,COUNT(*) count FROM content_actions WHERE workspace_id=? ${siteClause} GROUP BY status`).all(...scopedParams());
  return { generated_at: new Date().toISOString(), integrations: integrationRows, work_items: work, freshness, content_actions: actions,
    budgets: budgetStatus(workspaceId), usage: usageSummary(workspaceId), forecasts: forecastMetrics(workspaceId, 30, scope),
    scope: { mode: scope.workspaceOnly ? 'workspace' : scope.siteId ? 'site' : 'all', site_id: scope.siteId ?? null } };
}
