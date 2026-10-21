/**
 * ads/changes.ts — the two-phase change flow for Google Ads.
 *
 *   propose → Google validates the operations (validate_only) and the client's
 *             guardrails decide: ready to apply, needs approval, or blocked.
 *   apply   → re-checks the guardrails against fresh account state, then sends
 *             the operations for real. Only "pending" changes can be applied by
 *             an assistant; "needs_approval" changes are applied when a person
 *             approves them in the dashboard.
 *
 * Every step is recorded on the change row, which doubles as the audit log.
 */
import {
  AdsApiError, applyRecommendations, cleanCustomerId, dismissRecommendations, mutate, searchGaql,
  type AdsCallContext, type MutateResult,
} from './client.js';
import { emptyState, evaluateChange, inspectOperations, stateNeeds, type AccountState, type InspectedOperation } from './guardrails.js';
import {
  createChange, getAdsAccount, getChange, healOrphanedAdsAccount, isOrphanedAdsAccount, transitionChange, updateChange,
  type AdsAccount, type AdsChange, type GuardrailFinding,
} from './store.js';
import { operationTypeFor, removeOperation, updateOperation, type Operation } from './operations.js';
import { recordAuditEvent } from '../auth/users.js';
import { recordUsage } from '../platform/store.js';
import { logSystem } from '../utils/logger.js';

export function callContext(account: AdsAccount): AdsCallContext {
  if (isOrphanedAdsAccount(account)) {
    // Its Google connection was disconnected; re-attach it to the workspace's
    // Google Ads connection when that is unambiguous.
    const healed = healOrphanedAdsAccount(account.id);
    if (healed?.google_account_id) account.google_account_id = healed.google_account_id;
  }
  if (!account.google_account_id || isOrphanedAdsAccount(account)) {
    throw new AdsApiError(
      `${account.name ?? account.customer_id} has lost its Google connection (it was disconnected). On the Google Ads page, open "Find and link client accounts" and select it to relink.`,
      'NEEDS_REAUTH',
    );
  }
  return { googleAccountId: account.google_account_id, loginCustomerId: account.login_customer_id };
}

const quote = (values: string[]) => values.map(v => `'${v.replace(/'/g, '')}'`).join(', ');

/** Current budgets, bids, campaign statuses and month-to-date spend for the guardrails. */
export async function fetchAccountState(account: AdsAccount, ops: InspectedOperation[]): Promise<AccountState> {
  const ctx = callContext(account);
  const cid = account.customer_id;
  const state = emptyState();
  const needs = stateNeeds(ops);

  const { rows: campaigns } = await searchGaql(ctx, cid, `
    SELECT campaign.resource_name, campaign.status, campaign_budget.resource_name, campaign_budget.amount_micros
    FROM campaign WHERE campaign.status != 'REMOVED'`, 10_000);
  for (const row of campaigns) {
    const c = row.campaign as Record<string, unknown> | undefined;
    const b = row.campaignBudget as Record<string, unknown> | undefined;
    if (!c?.resourceName) continue;
    const budgetName = (b?.resourceName as string) ?? null;
    const micros = Number(b?.amountMicros ?? 0);
    state.campaigns[String(c.resourceName)] = { status: String(c.status ?? ''), budget: budgetName, budgetMicros: micros };
    if (budgetName) state.budgets[budgetName] = micros;
  }

  const missingBudgets = needs.budgets.filter(name => state.budgets[name] === undefined);
  if (missingBudgets.length) {
    const { rows } = await searchGaql(ctx, cid, `SELECT campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign_budget
      WHERE campaign_budget.resource_name IN (${quote(missingBudgets)})`);
    for (const row of rows) {
      const b = row.campaignBudget as Record<string, unknown>;
      state.budgets[String(b.resourceName)] = Number(b.amountMicros ?? 0);
    }
  }
  if (needs.criteria.length) {
    const { rows } = await searchGaql(ctx, cid, `SELECT ad_group_criterion.resource_name, ad_group_criterion.effective_cpc_bid_micros FROM ad_group_criterion
      WHERE ad_group_criterion.resource_name IN (${quote(needs.criteria.slice(0, 1000))})`);
    for (const row of rows) {
      const c = row.adGroupCriterion as Record<string, unknown>;
      state.criterionBids[String(c.resourceName)] = Number(c.effectiveCpcBidMicros ?? 0);
    }
  }
  if (needs.adGroups.length) {
    const { rows } = await searchGaql(ctx, cid, `SELECT ad_group.resource_name, ad_group.cpc_bid_micros FROM ad_group
      WHERE ad_group.resource_name IN (${quote(needs.adGroups.slice(0, 1000))})`);
    for (const row of rows) {
      const g = row.adGroup as Record<string, unknown>;
      state.adGroupBids[String(g.resourceName)] = Number(g.cpcBidMicros ?? 0);
    }
  }
  const { rows: spend } = await searchGaql(ctx, cid, 'SELECT metrics.cost_micros FROM customer WHERE segments.date DURING THIS_MONTH');
  state.monthToDateMicros = spend.reduce((sum, row) => sum + Number((row.metrics as Record<string, unknown> | undefined)?.costMicros ?? 0), 0);
  return state;
}

/** Values to restore if the change is reverted later. */
function beforeStateFor(ops: InspectedOperation[], state: AccountState): Record<string, unknown> {
  const budgets: Record<string, number> = {};
  const bids: Record<string, number> = {};
  const statuses: Record<string, string> = {};
  for (const op of ops) {
    if (op.action !== 'update' || !op.resourceName) continue;
    if (op.type === 'campaignBudgetOperation' && op.mask.includes('amount_micros') && state.budgets[op.resourceName] !== undefined) budgets[op.resourceName] = state.budgets[op.resourceName];
    if (op.type === 'adGroupCriterionOperation' && op.mask.includes('cpc_bid_micros') && state.criterionBids[op.resourceName] !== undefined) bids[op.resourceName] = state.criterionBids[op.resourceName];
    if (op.type === 'adGroupOperation' && op.mask.includes('cpc_bid_micros') && state.adGroupBids[op.resourceName] !== undefined) bids[op.resourceName] = state.adGroupBids[op.resourceName];
    if (op.type === 'campaignOperation' && op.mask.includes('status') && state.campaigns[op.resourceName]) statuses[op.resourceName] = state.campaigns[op.resourceName].status;
  }
  return { budgets, bids, statuses };
}

function summariseMutateError(error: unknown): string {
  if (error instanceof AdsApiError) return error.hint ? `${error.message} — ${error.hint}` : error.message;
  return error instanceof Error ? error.message : String(error);
}

export interface ProposeInput {
  account: AdsAccount;
  userId: string | null;
  source: 'mcp' | 'ui';
  kind: string;
  summary: string;
  rationale?: string | null;
  operations: Operation[];
  /** Extra values to restore on revert (e.g. statuses captured by the caller). */
  beforeState?: Record<string, unknown>;
  revertsChangeId?: string | null;
}

/** Validate a change with Google and the guardrails, and store it as a plan. */
export async function proposeChange(input: ProposeInput): Promise<AdsChange> {
  const { account } = input;
  const { inspected, errors } = inspectOperations(input.operations);
  if (errors.length) throw new AdsApiError(errors.join(' '), 'INVALID_REQUEST');

  if (account.guardrails.mode === 'read_only') {
    return createChange({
      workspaceId: account.workspace_id, adsAccountId: account.id, createdBy: input.userId, source: input.source,
      kind: input.kind, summary: input.summary, rationale: input.rationale, operations: input.operations,
      findings: [{ severity: 'block', code: 'read_only', message: 'This client is set to read-only; no changes can be made.' }],
      status: 'blocked', revertsChangeId: input.revertsChangeId,
    });
  }

  const state = await fetchAccountState(account, inspected);
  const evaluation = evaluateChange({
    operations: inspected, state, guardrails: account.guardrails, monthlyBudget: account.monthly_budget,
    currency: account.currency, timeZone: account.time_zone,
  });
  const beforeState = { ...beforeStateFor(inspected, state), ...(input.beforeState ?? {}) };

  let validation: unknown = null;
  let status: AdsChange['status'] = evaluation.verdict;
  let error: string | null = null;
  try {
    validation = await mutate(callContext(account), account.customer_id, input.operations, { validateOnly: true });
  } catch (e) {
    status = 'failed';
    error = `Google rejected the change during validation: ${summariseMutateError(e)}`;
    validation = e instanceof AdsApiError ? e.details ?? null : null;
  }
  const change = createChange({
    workspaceId: account.workspace_id, adsAccountId: account.id, createdBy: input.userId, source: input.source,
    kind: input.kind, summary: input.summary, rationale: input.rationale, operations: input.operations,
    beforeState, impact: evaluation.impact as unknown as Record<string, unknown>, findings: evaluation.findings,
    validation, status, error, revertsChangeId: input.revertsChangeId,
  });
  logSystem(status === 'failed' ? 'warn' : 'info', `Google Ads change proposed for ${account.name ?? account.customer_id}: ${input.summary} (${status.replace('_', ' ')})`);
  return change;
}

function recordApplied(account: AdsAccount, change: AdsChange, userId: string | null, result: unknown) {
  updateChange(change.id, { status: 'applied', applied: true, result, error: null });
  recordUsage({ workspace_id: account.workspace_id, user_id: userId, provider: 'google_ads', operation: 'mutate', quantity: change.operations.length || 1, unit: 'operations', estimated_cost: 0, metadata: { changeId: change.id, customerId: account.customer_id } });
  recordAuditEvent({ actorUserId: userId, workspaceId: account.workspace_id, action: 'google_ads.change_applied', detail: { changeId: change.id, customerId: account.customer_id, summary: change.summary, source: change.source } });
  logSystem('ok', `Google Ads change applied for ${account.name ?? account.customer_id}: ${change.summary}`);
}

async function execute(account: AdsAccount, change: AdsChange): Promise<unknown> {
  if (change.kind === 'apply_recommendations' || change.kind === 'dismiss_recommendations') {
    const names = (change.operations as Array<{ recommendation?: string }>).map(op => String(op.recommendation ?? '')).filter(Boolean);
    return change.kind === 'apply_recommendations'
      ? applyRecommendations(callContext(account), account.customer_id, names)
      : dismissRecommendations(callContext(account), account.customer_id, names);
  }
  return mutate(callContext(account), account.customer_id, change.operations, { validateOnly: false });
}

/**
 * Apply a change. `approvedByPerson` is true only when a person approves it in
 * the dashboard; assistants can apply "pending" changes only.
 */
export async function applyChange(changeId: string, opts: { userId: string | null; approvedByPerson: boolean }): Promise<AdsChange> {
  const change = getChange(changeId);
  if (!change) throw new AdsApiError('Change not found.', 'NOT_FOUND');
  const account = getAdsAccount(change.ads_account_id);
  if (!account) throw new AdsApiError('The ad account for this change is no longer linked.', 'NOT_FOUND');
  if (change.status === 'applied') return change;
  if (new Date(change.expires_at).getTime() < Date.now() && ['pending', 'needs_approval'].includes(change.status)) {
    updateChange(change.id, { status: 'expired' });
    throw new AdsApiError('This change expired (changes must be applied within 24 hours). Propose it again so it is re-validated.', 'INVALID_REQUEST');
  }
  if (change.status === 'needs_approval' && !opts.approvedByPerson) {
    throw new AdsApiError('This change is waiting for a person to approve it on the Google Ads page. It will be applied when they approve.', 'PERMISSION');
  }
  if (!['pending', 'needs_approval'].includes(change.status)) {
    throw new AdsApiError(`This change is ${change.status.replace('_', ' ')} and can't be applied.`, 'INVALID_REQUEST');
  }
  if (account.guardrails.mode === 'read_only') {
    updateChange(change.id, { status: 'blocked', findings: [{ severity: 'block', code: 'read_only', message: 'This client is set to read-only.' }] });
    throw new AdsApiError('This client is set to read-only; no changes can be made.', 'PERMISSION');
  }

  // Re-check against fresh state for mutate changes: another change may have
  // moved budgets since this one was proposed.
  let findings: GuardrailFinding[] = change.findings;
  if (change.kind !== 'apply_recommendations' && change.kind !== 'dismiss_recommendations') {
    const { inspected } = inspectOperations(change.operations);
    const state = await fetchAccountState(account, inspected);
    const evaluation = evaluateChange({ operations: inspected, state, guardrails: account.guardrails, monthlyBudget: account.monthly_budget, currency: account.currency, timeZone: account.time_zone });
    findings = evaluation.findings;
    if (evaluation.verdict === 'blocked') {
      updateChange(change.id, { status: 'blocked', findings });
      throw new AdsApiError('Guardrails now block this change.', 'PERMISSION');
    }
    if (evaluation.verdict === 'needs_approval' && !opts.approvedByPerson) {
      updateChange(change.id, { status: 'needs_approval', findings, impact: evaluation.impact as unknown as Record<string, unknown> });
      throw new AdsApiError(`Account state changed and this now needs approval: ${findings.filter(f => f.severity !== 'info').map(f => f.message).join(' ')}`, 'PERMISSION');
    }
    updateChange(change.id, { findings, impact: evaluation.impact as unknown as Record<string, unknown> });
  }

  if (!transitionChange(change.id, [change.status], 'applying')) {
    throw new AdsApiError('This change is already being applied.', 'INVALID_REQUEST');
  }
  if (opts.approvedByPerson) updateChange(change.id, { decidedBy: opts.userId, decided: true });
  try {
    const result = await execute(account, { ...change, findings });
    recordApplied(account, change, opts.userId, result);
  } catch (e) {
    updateChange(change.id, { status: 'failed', error: summariseMutateError(e) });
    logSystem('error', `Google Ads change failed for ${account.name ?? account.customer_id}: ${summariseMutateError(e)}`);
    throw e;
  }
  return getChange(change.id)!;
}

export function rejectChange(changeId: string, userId: string | null): AdsChange {
  const change = getChange(changeId);
  if (!change) throw new AdsApiError('Change not found.', 'NOT_FOUND');
  if (!transitionChange(change.id, ['pending', 'needs_approval', 'blocked'], 'rejected')) {
    throw new AdsApiError(`This change is ${change.status.replace('_', ' ')} and can't be rejected.`, 'INVALID_REQUEST');
  }
  return updateChange(change.id, { decidedBy: userId, decided: true })!;
}

/** Inverse operations for an applied change, where the app knows the previous values. */
export function revertOperations(change: AdsChange): Operation[] {
  const ops: Operation[] = [];
  const before = change.before_state as { budgets?: Record<string, number>; bids?: Record<string, number>; statuses?: Record<string, string> };
  for (const [resource, micros] of Object.entries(before.budgets ?? {})) ops.push(updateOperation(resource, { amountMicros: String(micros) }, ['amountMicros']));
  for (const [resource, micros] of Object.entries(before.bids ?? {})) ops.push(updateOperation(resource, { cpcBidMicros: String(micros) }, ['cpcBidMicros']));
  for (const [resource, status] of Object.entries(before.statuses ?? {})) {
    if (status === 'ENABLED' || status === 'PAUSED') ops.push(updateOperation(resource, { status }, ['status']));
  }
  // Things this change created can be undone by removing them again. Mutate
  // responses line up one-to-one with the operations that were sent.
  const responses = (change.result as MutateResult | null)?.mutateOperationResponses ?? [];
  responses.forEach((response, index) => {
    const original = change.operations[index] as Record<string, Record<string, unknown>> | undefined;
    const inner = original ? Object.values(original)[0] : undefined;
    if (!inner || !('create' in inner)) return;
    const name = Object.values(response).map(value => (value as { resourceName?: string } | null)?.resourceName).find(Boolean);
    if (name && operationTypeFor(name)) ops.push(removeOperation(name));
  });
  // Remove children before parents (ad group before campaign, campaign before budget).
  const order = ['adGroupCriterionOperation', 'adGroupAdOperation', 'campaignCriterionOperation', 'adGroupOperation', 'campaignOperation', 'campaignBudgetOperation'];
  const rank = (op: Operation) => { const i = order.indexOf(Object.keys(op)[0]); return i === -1 ? -1 : i; };
  return ops.sort((a, b) => rank(a) - rank(b));
}

export async function revertChange(changeId: string, opts: { userId: string | null; source: 'mcp' | 'ui' }): Promise<AdsChange> {
  const change = getChange(changeId);
  if (!change) throw new AdsApiError('Change not found.', 'NOT_FOUND');
  if (change.status !== 'applied') throw new AdsApiError('Only applied changes can be reverted.', 'INVALID_REQUEST');
  const account = getAdsAccount(change.ads_account_id);
  if (!account) throw new AdsApiError('The ad account for this change is no longer linked.', 'NOT_FOUND');
  const ops = revertOperations(change);
  if (!ops.length) throw new AdsApiError('The app has no previous values recorded for this change, so it cannot be reverted automatically. Make the opposite change instead.', 'INVALID_REQUEST');
  return proposeChange({
    account, userId: opts.userId, source: opts.source, kind: 'revert', operations: ops,
    summary: `Revert: ${change.summary}`.slice(0, 500), rationale: `Undo change ${change.id}.`, revertsChangeId: change.id,
  });
}

// ── Recommendations ──────────────────────────────────────────────────────────

const SPEND_RECOMMENDATION = /BUDGET|CPA|ROAS|MAXIMIZE|BID|BROAD_MATCH|PERFORMANCE_MAX|SHOPPING|TARGET_|CPC/;

export async function proposeRecommendations(input: {
  account: AdsAccount; userId: string | null; source: 'mcp' | 'ui'; action: 'apply' | 'dismiss';
  resourceNames: string[]; rationale?: string | null;
}): Promise<AdsChange> {
  const { account } = input;
  const cid = cleanCustomerId(account.customer_id);
  const names = [...new Set(input.resourceNames.map(n => n.trim()))].filter(n => n.startsWith(`customers/${cid}/recommendations/`));
  if (!names.length) throw new AdsApiError(`Pass recommendation resource names for this account (customers/${cid}/recommendations/…).`, 'INVALID_REQUEST');
  const { rows } = await searchGaql(callContext(account), cid, `SELECT recommendation.resource_name, recommendation.type FROM recommendation
    WHERE recommendation.resource_name IN (${quote(names.slice(0, 500))})`);
  const types = new Map(rows.map(row => {
    const r = row.recommendation as Record<string, unknown>;
    return [String(r.resourceName), String(r.type ?? 'UNKNOWN')] as const;
  }));
  const findings: GuardrailFinding[] = [];
  const missing = names.filter(n => !types.has(n));
  if (missing.length) throw new AdsApiError(`These recommendations no longer exist: ${missing.join(', ')}`, 'NOT_FOUND');
  if (account.guardrails.mode === 'read_only') findings.push({ severity: 'block', code: 'read_only', message: 'This client is set to read-only; no changes can be made.' });
  else if (account.guardrails.mode === 'review') findings.push({ severity: 'approval', code: 'review_mode', message: 'This client is in review mode: every change waits for a person to approve it.' });
  if (input.action === 'apply') {
    for (const [name, type] of types) {
      if (SPEND_RECOMMENDATION.test(type)) findings.push({ severity: 'approval', code: 'spend_recommendation', message: `${type} recommendations change budgets, bidding or match types and need approval (${name}).` });
    }
  }
  const status = findings.some(f => f.severity === 'block') ? 'blocked' : findings.some(f => f.severity === 'approval') ? 'needs_approval' : 'pending';
  return createChange({
    workspaceId: account.workspace_id, adsAccountId: account.id, createdBy: input.userId, source: input.source,
    kind: `${input.action}_recommendations`,
    summary: `${input.action === 'apply' ? 'Apply' : 'Dismiss'} ${names.length} Google recommendation${names.length === 1 ? '' : 's'} (${[...new Set(types.values())].join(', ')})`,
    rationale: input.rationale, operations: names.map(name => ({ recommendation: name, type: types.get(name) })),
    findings, status,
  });
}
