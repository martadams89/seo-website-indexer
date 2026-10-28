/**
 * ads/guardrails.ts — decide whether a proposed Google Ads change may be
 * applied automatically, needs a person to approve it, or is blocked.
 *
 * Everything here is pure: callers pass the operations, the client's
 * guardrails/monthly budget and a snapshot of the account's current state
 * (budgets, bids, campaign statuses, month-to-date spend). That keeps the
 * money-moving rules easy to test and to reason about.
 */
import type { AdsGuardrails, GuardrailFinding } from './store.js';

// ── Inspecting mutate operations ─────────────────────────────────────────────

export type OperationAction = 'create' | 'update' | 'remove';

export interface InspectedOperation {
  /** e.g. campaignBudgetOperation */
  type: string;
  action: OperationAction;
  /** Resource name for update/remove (and create when a temporary name is set). */
  resourceName: string | null;
  /** snake_case update-mask paths for updates. */
  mask: string[];
  /** The create/update payload. */
  payload: Record<string, unknown>;
}

const toSnake = (path: string) => path.trim().replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

/** Parse REST MutateOperation objects into a uniform shape, rejecting malformed ones. */
export function inspectOperations(operations: unknown[]): { inspected: InspectedOperation[]; errors: string[] } {
  const inspected: InspectedOperation[] = [];
  const errors: string[] = [];
  operations.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`Operation ${index + 1} is not an object.`); return; }
    const keys = Object.keys(raw);
    if (keys.length !== 1 || !keys[0].endsWith('Operation')) {
      errors.push(`Operation ${index + 1} must contain exactly one "<resource>Operation" key (for example campaignBudgetOperation).`);
      return;
    }
    const type = keys[0];
    const inner = (raw as Record<string, unknown>)[type] as Record<string, unknown> | undefined;
    if (!inner || typeof inner !== 'object') { errors.push(`Operation ${index + 1} (${type}) is empty.`); return; }
    const actions = (['create', 'update', 'remove'] as const).filter(a => inner[a] !== undefined);
    if (actions.length !== 1) { errors.push(`Operation ${index + 1} (${type}) must have exactly one of create, update or remove.`); return; }
    const action = actions[0];
    const body = inner[action];
    if (action === 'remove') {
      if (typeof body !== 'string' || !body.startsWith('customers/')) { errors.push(`Operation ${index + 1} (${type}) remove must be a resource name.`); return; }
      inspected.push({ type, action, resourceName: body, mask: [], payload: {} });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { errors.push(`Operation ${index + 1} (${type}) ${action} must be an object.`); return; }
    const payload = body as Record<string, unknown>;
    const maskRaw = inner.updateMask ?? inner.update_mask;
    const mask = typeof maskRaw === 'string' ? maskRaw.split(',').map(toSnake).filter(Boolean)
      : Array.isArray((maskRaw as { paths?: unknown })?.paths) ? ((maskRaw as { paths: string[] }).paths).map(toSnake) : [];
    if (action === 'update') {
      if (typeof payload.resourceName !== 'string') { errors.push(`Operation ${index + 1} (${type}) update needs resourceName.`); return; }
      if (!mask.length) { errors.push(`Operation ${index + 1} (${type}) update needs an updateMask listing the fields to change.`); return; }
    }
    inspected.push({ type, action, resourceName: typeof payload.resourceName === 'string' ? payload.resourceName : null, mask, payload });
  });
  return { inspected, errors };
}

// ── Account state the rules need ─────────────────────────────────────────────

export interface CampaignState {
  status: string;
  budget: string | null;
  budgetMicros: number;
  /** campaign.advertising_channel_type (SEARCH, LOCAL_SERVICES, …) when known. */
  channel?: string | null;
}

/**
 * Channels billed per lead whose campaign budget is a Google placeholder rather
 * than a spending commitment. Local Services campaigns report a large system
 * budget (e.g. 16,000/day) while spending a small fraction of it, so their
 * budget must never be added to daily totals or projected across the month.
 * Their real cost is in month-to-date spend and is projected at its run rate.
 */
export const PER_LEAD_CHANNELS = new Set(['LOCAL_SERVICES']);
export const isPerLeadChannel = (channel?: string | null) => !!channel && PER_LEAD_CHANNELS.has(channel);

/** Average daily spend so far this month (micros), with today counted as a day. */
export function perLeadDailyRunRate(monthToDateMicros: number, dayOfMonth: number): number {
  return monthToDateMicros > 0 ? monthToDateMicros / Math.max(1, dayOfMonth) : 0;
}

export interface AccountState {
  /** campaign resource name → status + budget. */
  campaigns: Record<string, CampaignState>;
  /** campaign_budget resource name → amount_micros. */
  budgets: Record<string, number>;
  /** ad_group_criterion resource name → effective CPC bid micros. */
  criterionBids: Record<string, number>;
  /** ad_group resource name → default CPC bid micros. */
  adGroupBids: Record<string, number>;
  /** Spend so far this calendar month in the account's time zone (micros). */
  monthToDateMicros: number;
  /** The part of monthToDateMicros spent by per-lead campaigns (Local Services). */
  perLeadMonthToDateMicros?: number;
}

export function emptyState(): AccountState {
  return { campaigns: {}, budgets: {}, criterionBids: {}, adGroupBids: {}, monthToDateMicros: 0, perLeadMonthToDateMicros: 0 };
}

/** Which resources the analyser needs current values for. */
export function stateNeeds(ops: InspectedOperation[]): { budgets: string[]; criteria: string[]; adGroups: string[] } {
  const budgets = new Set<string>(); const criteria = new Set<string>(); const adGroups = new Set<string>();
  for (const op of ops) {
    if (op.action !== 'update' || !op.resourceName) continue;
    if (op.type === 'campaignBudgetOperation' && op.mask.includes('amount_micros')) budgets.add(op.resourceName);
    if (op.type === 'adGroupCriterionOperation' && op.mask.includes('cpc_bid_micros')) criteria.add(op.resourceName);
    if (op.type === 'adGroupOperation' && op.mask.includes('cpc_bid_micros')) adGroups.add(op.resourceName);
  }
  return { budgets: [...budgets], criteria: [...criteria], adGroups: [...adGroups] };
}

// ── Calendar helpers ─────────────────────────────────────────────────────────

/** Day of month and month length in the account's time zone. */
export function monthPosition(now: Date, timeZone?: string | null): { day: number; daysInMonth: number; remainingDays: number } {
  let parts: { year: number; month: number; day: number };
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    const [y, m, d] = fmt.format(now).split('-').map(Number);
    parts = { year: y, month: m, day: d };
  } catch {
    parts = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  }
  const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  // Include today: budgets changed now still govern the rest of today.
  return { day: parts.day, daysInMonth, remainingDays: daysInMonth - parts.day + 1 };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

const BIDDING_PATHS = /^(bidding_strategy|bidding_strategy_type|manual_cpc|manual_cpm|manual_cpv|maximize_conversions|maximize_conversion_value|target_cpa|target_roas|target_spend|target_impression_share|percent_cpc|commission|target_cpm|fixed_cpm)/;
/** Checks an auto-approving client keeps when it still wants to stay inside the monthly budget. */
const BUDGET_CHECKS = new Set(['over_monthly_budget', 'no_monthly_budget']);
const SENSITIVE_TYPES = new Set([
  'customerOperation', 'conversionActionOperation', 'customerConversionGoalOperation', 'campaignConversionGoalOperation',
  'conversionGoalCampaignConfigOperation', 'conversionValueRuleOperation', 'conversionValueRuleSetOperation',
  'conversionCustomVariableOperation', 'customConversionGoalOperation',
]);

export interface ChangeImpact {
  currency?: string | null;
  daily_budget_before: number;
  daily_budget_after: number;
  month_to_date_spend: number;
  monthly_budget: number | null;
  remaining_days: number;
  /** Run-rate daily spend of enabled per-lead campaigns (Local Services), included in the projection. */
  per_lead_daily_spend: number;
  projected_month_spend: number;
  budget_changes: Array<{ resource: string; before: number | null; after: number }>;
  bid_changes: Array<{ resource: string; before: number | null; after: number }>;
  status_changes: Array<{ resource: string; before: string | null; after: string }>;
}

export interface Evaluation {
  findings: GuardrailFinding[];
  verdict: 'pending' | 'needs_approval' | 'blocked';
  impact: ChangeImpact;
}

const units = (micros: number) => Math.round(micros / 10_000) / 100;
const pct = (before: number, after: number) => before > 0 ? ((after - before) / before) * 100 : (after > 0 ? Infinity : 0);

/**
 * Apply the client's guardrails to a set of operations.
 *   • read_only blocks everything; review sends everything to a person.
 *   • guarded lets a change through only if every rule passes.
 *   • auto lets everything through, noting what the rules would have held;
 *     with auto_keep_budget the monthly-budget checks still hold.
 * Projected spend uses Google's monthly charging limit (daily budget × days):
 * month-to-date spend plus the enabled campaigns' daily budgets for every
 * remaining day, today included. Per-lead campaigns (Local Services) are the
 * exception: their budget is a placeholder, so they are projected at their
 * actual daily run rate this month instead.
 */
export function evaluateChange(input: {
  operations: InspectedOperation[];
  state: AccountState;
  guardrails: AdsGuardrails;
  monthlyBudget: number | null;
  currency?: string | null;
  now?: Date;
  timeZone?: string | null;
}): Evaluation {
  const { operations, state, guardrails } = input;
  const findings: GuardrailFinding[] = [];
  const add = (severity: GuardrailFinding['severity'], code: string, message: string) => {
    if (!findings.some(f => f.code === code && f.message === message)) findings.push({ severity, code, message });
  };
  const { day, remainingDays } = monthPosition(input.now ?? new Date(), input.timeZone);

  // Daily budget currently committed by enabled campaigns (shared budgets counted once).
  const enabledBudgets = (campaigns: Record<string, CampaignState>, budgets: Record<string, number>) => {
    const seen = new Map<string, number>();
    for (const [name, c] of Object.entries(campaigns)) {
      if (c.status !== 'ENABLED' || isPerLeadChannel(c.channel)) continue;
      const key = c.budget ?? `campaign:${name}`;
      seen.set(key, c.budget && budgets[c.budget] !== undefined ? budgets[c.budget] : c.budgetMicros);
    }
    return [...seen.values()].reduce((sum, v) => sum + v, 0);
  };
  const beforeBudgets: Record<string, number> = { ...state.budgets };
  for (const c of Object.values(state.campaigns)) if (c.budget && beforeBudgets[c.budget] === undefined) beforeBudgets[c.budget] = c.budgetMicros;
  const afterBudgets = { ...beforeBudgets };
  const afterCampaigns: Record<string, CampaignState> = Object.fromEntries(Object.entries(state.campaigns).map(([k, v]) => [k, { ...v }]));

  const impact: ChangeImpact = {
    currency: input.currency ?? null,
    daily_budget_before: 0, daily_budget_after: 0,
    month_to_date_spend: units(state.monthToDateMicros),
    monthly_budget: input.monthlyBudget,
    remaining_days: remainingDays,
    per_lead_daily_spend: 0,
    projected_month_spend: 0,
    budget_changes: [], bid_changes: [], status_changes: [],
  };

  if (operations.length > guardrails.max_operations) {
    add('approval', 'too_many_operations', `${operations.length} operations exceed this client's limit of ${guardrails.max_operations} per change.`);
  }

  for (const op of operations) {
    const label = op.resourceName ?? op.type.replace(/Operation$/, '');
    if (SENSITIVE_TYPES.has(op.type)) {
      add('approval', 'sensitive_settings', `${op.type.replace(/Operation$/, '')} changes affect account or conversion settings and always need approval.`);
    }
    if (op.action === 'remove') {
      if (!guardrails.allow_removals) add('approval', 'removal', `Removing ${label} is permanent and needs approval.`);
      continue;
    }

    if (op.type === 'campaignBudgetOperation' && op.action === 'update' && op.mask.includes('amount_micros') && op.resourceName) {
      const after = Number(op.payload.amountMicros ?? op.payload.amount_micros ?? 0);
      const before = state.budgets[op.resourceName] ?? beforeBudgets[op.resourceName];
      afterBudgets[op.resourceName] = after;
      impact.budget_changes.push({ resource: op.resourceName, before: before === undefined ? null : units(before), after: units(after) });
      if (before === undefined) add('approval', 'budget_unknown', `Couldn't read the current amount of ${op.resourceName}, so the increase can't be checked.`);
      else {
        const change = pct(before, after);
        if (change > guardrails.max_budget_increase_pct) {
          add('approval', 'budget_increase_over_limit', `Raising ${op.resourceName} from ${units(before)} to ${units(after)} a day (+${Number.isFinite(change) ? change.toFixed(0) : '∞'}%) is more than the ${guardrails.max_budget_increase_pct}% allowed per change.`);
        }
      }
    }

    if (op.type === 'adGroupCriterionOperation' && op.action === 'update' && op.mask.includes('cpc_bid_micros') && op.resourceName) {
      const after = Number(op.payload.cpcBidMicros ?? op.payload.cpc_bid_micros ?? 0);
      const before = state.criterionBids[op.resourceName];
      impact.bid_changes.push({ resource: op.resourceName, before: before === undefined ? null : units(before), after: units(after) });
      if (before !== undefined && before > 0 && Math.abs(pct(before, after)) > guardrails.max_bid_change_pct) {
        add('approval', 'bid_change_over_limit', `Changing the bid on ${op.resourceName} from ${units(before)} to ${units(after)} is more than ±${guardrails.max_bid_change_pct}%.`);
      }
    }
    if (op.type === 'adGroupOperation' && op.action === 'update' && op.mask.includes('cpc_bid_micros') && op.resourceName) {
      const after = Number(op.payload.cpcBidMicros ?? op.payload.cpc_bid_micros ?? 0);
      const before = state.adGroupBids[op.resourceName];
      impact.bid_changes.push({ resource: op.resourceName, before: before === undefined ? null : units(before), after: units(after) });
      if (before !== undefined && before > 0 && Math.abs(pct(before, after)) > guardrails.max_bid_change_pct) {
        add('approval', 'bid_change_over_limit', `Changing the default bid on ${op.resourceName} from ${units(before)} to ${units(after)} is more than ±${guardrails.max_bid_change_pct}%.`);
      }
    }

    if (op.type === 'campaignOperation') {
      if (op.action === 'create') {
        const status = String(op.payload.status ?? 'ENABLED');
        if (status !== 'PAUSED') add('approval', 'new_campaign_enabled', 'New campaigns must be created PAUSED; switching one on needs approval.');
      } else if (op.resourceName) {
        if (op.mask.includes('status')) {
          const next = String(op.payload.status ?? '');
          const current = state.campaigns[op.resourceName];
          impact.status_changes.push({ resource: op.resourceName, before: current?.status ?? null, after: next });
          if (current) afterCampaigns[op.resourceName] = { ...current, status: next };
          if (next === 'ENABLED' && current?.status !== 'ENABLED' && !guardrails.allow_enable_campaigns) {
            add('approval', 'enable_campaign', `Turning on ${op.resourceName} needs approval for this client.`);
          }
        }
        if (op.mask.some(path => BIDDING_PATHS.test(path)) && !guardrails.allow_bidding_changes) {
          add('approval', 'bidding_change', `Changing the bid strategy or targets of ${op.resourceName} needs approval.`);
        }
        if (op.mask.some(path => path.startsWith('campaign_budget'))) {
          add('approval', 'budget_reassignment', `Moving ${op.resourceName} to a different budget needs approval.`);
        }
      }
    }
    if (op.type === 'biddingStrategyOperation' && op.action === 'update' && !guardrails.allow_bidding_changes) {
      add('approval', 'bidding_change', `Changing portfolio bid strategy ${op.resourceName} needs approval.`);
    }
    for (const statusType of ['adGroupOperation', 'adGroupAdOperation', 'adGroupCriterionOperation', 'campaignCriterionOperation']) {
      if (op.type === statusType && op.action === 'update' && op.mask.includes('status') && op.resourceName) {
        impact.status_changes.push({ resource: op.resourceName, before: null, after: String(op.payload.status ?? '') });
      }
    }
  }

  impact.daily_budget_before = units(enabledBudgets(state.campaigns, beforeBudgets));
  impact.daily_budget_after = units(enabledBudgets(afterCampaigns, afterBudgets));
  const perLeadEnabled = Object.values(afterCampaigns).some(c => c.status === 'ENABLED' && isPerLeadChannel(c.channel));
  impact.per_lead_daily_spend = perLeadEnabled ? units(perLeadDailyRunRate(state.perLeadMonthToDateMicros ?? 0, day)) : 0;
  impact.projected_month_spend = Math.round((impact.month_to_date_spend + (impact.daily_budget_after + impact.per_lead_daily_spend) * remainingDays) * 100) / 100;

  const increasesSpend = impact.daily_budget_after > impact.daily_budget_before + 0.001;
  if (increasesSpend) {
    if (input.monthlyBudget === null || input.monthlyBudget === undefined) {
      add('approval', 'no_monthly_budget', 'This client has no monthly budget set, so changes that raise daily spend need approval. Set a monthly budget on the Google Ads page.');
    } else {
      const ceiling = input.monthlyBudget * (1 + guardrails.budget_tolerance_pct / 100);
      if (impact.projected_month_spend > ceiling) {
        add('approval', 'over_monthly_budget', `Projected spend this month would be ${impact.projected_month_spend.toFixed(2)} against a monthly budget of ${input.monthlyBudget.toFixed(2)}${guardrails.budget_tolerance_pct ? ` (+${guardrails.budget_tolerance_pct}% tolerance)` : ''}.`);
      }
    }
  }

  if (guardrails.mode === 'read_only') {
    findings.unshift({ severity: 'block', code: 'read_only', message: 'This client is set to read-only; no changes can be made.' });
  } else if (guardrails.mode === 'review') {
    findings.unshift({ severity: 'approval', code: 'review_mode', message: 'This client is in review mode: every change waits for a person to approve it.' });
  } else if (guardrails.mode === 'auto') {
    for (const f of findings) {
      if (f.severity !== 'approval' || (guardrails.auto_keep_budget && BUDGET_CHECKS.has(f.code))) continue;
      f.severity = 'info';
      f.message = `Auto-approved: ${f.message}`;
    }
  }

  const verdict = findings.some(f => f.severity === 'block') ? 'blocked'
    : findings.some(f => f.severity === 'approval') ? 'needs_approval' : 'pending';
  return { findings, verdict, impact };
}
