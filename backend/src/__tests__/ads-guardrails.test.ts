import { describe, it, expect } from 'vitest';
import { emptyState, evaluateChange, inspectOperations, monthPosition, stateNeeds, type AccountState } from '../ads/guardrails.js';
import { DEFAULT_GUARDRAILS, normalizeGuardrails, type AdsGuardrails } from '../ads/store.js';

// The guardrails decide whether an AI-proposed Google Ads change can apply on
// its own. These tests pin the money-moving rules: budget increase limits,
// monthly budget projection, removals, new campaigns, bidding changes, modes.

const C = 'customers/1234567890';
const NOW = new Date('2026-10-11T12:00:00Z'); // day 11 of a 31-day month → 21 days left incl. today

function state(overrides: Partial<AccountState> = {}): AccountState {
  return {
    ...emptyState(),
    campaigns: {
      [`${C}/campaigns/1`]: { status: 'ENABLED', budget: `${C}/campaignBudgets/10`, budgetMicros: 50_000_000 },
      [`${C}/campaigns/2`]: { status: 'ENABLED', budget: `${C}/campaignBudgets/20`, budgetMicros: 30_000_000 },
      [`${C}/campaigns/3`]: { status: 'PAUSED', budget: `${C}/campaignBudgets/30`, budgetMicros: 40_000_000 },
    },
    budgets: { [`${C}/campaignBudgets/10`]: 50_000_000, [`${C}/campaignBudgets/20`]: 30_000_000, [`${C}/campaignBudgets/30`]: 40_000_000 },
    monthToDateMicros: 800_000_000, // 800 spent so far
    ...overrides,
  };
}

const budgetOp = (id: number, micros: number) => ({ campaignBudgetOperation: { update: { resourceName: `${C}/campaignBudgets/${id}`, amountMicros: String(micros) }, updateMask: 'amountMicros' } });

function evaluate(ops: unknown[], opts: { guardrails?: Partial<AdsGuardrails>; monthlyBudget?: number | null; state?: AccountState } = {}) {
  const { inspected, errors } = inspectOperations(ops);
  expect(errors).toEqual([]);
  return evaluateChange({
    operations: inspected,
    state: opts.state ?? state(),
    guardrails: normalizeGuardrails({ ...DEFAULT_GUARDRAILS, ...opts.guardrails }),
    monthlyBudget: opts.monthlyBudget === undefined ? 3000 : opts.monthlyBudget,
    now: NOW,
    timeZone: 'UTC',
  });
}

describe('inspectOperations', () => {
  it('rejects malformed operations with a clear reason', () => {
    expect(inspectOperations([{}]).errors[0]).toMatch(/exactly one/);
    expect(inspectOperations([{ campaignOperation: { update: { resourceName: `${C}/campaigns/1`, status: 'PAUSED' } } }]).errors[0]).toMatch(/updateMask/);
    expect(inspectOperations([{ campaignOperation: { remove: 'nope' } }]).errors[0]).toMatch(/resource name/);
    expect(inspectOperations([{ campaignOperation: { create: {}, remove: `${C}/campaigns/1` } }]).errors[0]).toMatch(/exactly one of create/);
  });

  it('normalises camelCase masks to snake_case paths', () => {
    const { inspected } = inspectOperations([budgetOp(10, 1)]);
    expect(inspected[0]).toMatchObject({ type: 'campaignBudgetOperation', action: 'update', mask: ['amount_micros'] });
    expect(stateNeeds(inspected).budgets).toEqual([`${C}/campaignBudgets/10`]);
  });
});

describe('evaluateChange', () => {
  it('lets a small budget increase inside the monthly budget through', () => {
    const result = evaluate([budgetOp(10, 55_000_000)]); // +10%
    expect(result.verdict).toBe('pending');
    expect(result.impact.daily_budget_before).toBe(80);
    expect(result.impact.daily_budget_after).toBe(85);
    expect(result.impact.remaining_days).toBe(21);
    expect(result.impact.projected_month_spend).toBe(800 + 85 * 21);
  });

  it('needs approval when one change raises a budget by more than the limit', () => {
    const result = evaluate([budgetOp(10, 70_000_000)]); // +40%
    expect(result.verdict).toBe('needs_approval');
    expect(result.findings.map(f => f.code)).toContain('budget_increase_over_limit');
  });

  it('needs approval when projected spend would exceed the monthly budget', () => {
    const result = evaluate([budgetOp(10, 55_000_000)], { monthlyBudget: 2500 }); // 800 + 85×21 = 2585
    expect(result.verdict).toBe('needs_approval');
    expect(result.findings.map(f => f.code)).toContain('over_monthly_budget');
    // …unless the tolerance covers it.
    expect(evaluate([budgetOp(10, 55_000_000)], { monthlyBudget: 2500, guardrails: { budget_tolerance_pct: 5 } }).verdict).toBe('pending');
  });

  it('needs approval for any spend increase when no monthly budget is set', () => {
    expect(evaluate([budgetOp(10, 51_000_000)], { monthlyBudget: null }).findings.map(f => f.code)).toContain('no_monthly_budget');
    // Cutting spend is always fine.
    expect(evaluate([budgetOp(10, 40_000_000)], { monthlyBudget: null }).verdict).toBe('pending');
  });

  it('counts a paused campaign\'s budget once it is switched on', () => {
    const op = { campaignOperation: { update: { resourceName: `${C}/campaigns/3`, status: 'ENABLED' }, updateMask: 'status' } };
    const result = evaluate([op], { monthlyBudget: 4000 });
    expect(result.impact.daily_budget_after).toBe(120);
    expect(result.verdict).toBe('pending');
    // 800 + 120 × 21 = 3,320 is over a 3,000 budget.
    expect(evaluate([op]).findings.map(f => f.code)).toContain('over_monthly_budget');
    expect(evaluate([op], { monthlyBudget: 4000, guardrails: { allow_enable_campaigns: false } }).findings.map(f => f.code)).toContain('enable_campaign');
  });

  it('excludes a Local Services placeholder budget and projects it at its real run rate', () => {
    // Mirrors a real account: a Search campaign moving 375 → 425 a day next to
    // an enabled Local Services campaign whose budget Google reports as 16,000.
    const withLsa = state({
      campaigns: {
        [`${C}/campaigns/1`]: { status: 'ENABLED', budget: `${C}/campaignBudgets/10`, budgetMicros: 375_000_000, channel: 'SEARCH' },
        [`${C}/campaigns/9`]: { status: 'ENABLED', budget: `${C}/campaignBudgets/90`, budgetMicros: 16_000_000_000, channel: 'LOCAL_SERVICES' },
      },
      budgets: { [`${C}/campaignBudgets/10`]: 375_000_000, [`${C}/campaignBudgets/90`]: 16_000_000_000 },
      monthToDateMicros: 4_000_000_000,       // 4,000 spent so far this month…
      perLeadMonthToDateMicros: 1_100_000_000, // …1,100 of it by Local Services over 11 days → 100/day
    });
    const result = evaluate([budgetOp(10, 425_000_000)], { state: withLsa, monthlyBudget: 20_000 });
    expect(result.impact.daily_budget_before).toBe(375);
    expect(result.impact.daily_budget_after).toBe(425);
    expect(result.impact.per_lead_daily_spend).toBe(100);
    // 4,000 + (425 + 100) × 21 remaining days — not 4,000 + 16,425 × 21.
    expect(result.impact.projected_month_spend).toBe(15_025);
    expect(result.findings.map(f => f.code)).not.toContain('over_monthly_budget');
  });

  it('still holds a change whose real projection breaks the monthly budget', () => {
    const withLsa = state({
      campaigns: {
        [`${C}/campaigns/1`]: { status: 'ENABLED', budget: `${C}/campaignBudgets/10`, budgetMicros: 375_000_000, channel: 'SEARCH' },
        [`${C}/campaigns/9`]: { status: 'ENABLED', budget: `${C}/campaignBudgets/90`, budgetMicros: 16_000_000_000, channel: 'LOCAL_SERVICES' },
      },
      budgets: { [`${C}/campaignBudgets/10`]: 375_000_000, [`${C}/campaignBudgets/90`]: 16_000_000_000 },
      monthToDateMicros: 4_000_000_000,
      perLeadMonthToDateMicros: 1_100_000_000,
    });
    const result = evaluate([budgetOp(10, 425_000_000)], { state: withLsa, monthlyBudget: 15_000 });
    expect(result.impact.projected_month_spend).toBe(15_025);
    expect(result.findings.find(f => f.code === 'over_monthly_budget')?.message).toContain('15025.00');
  });

  it('adds no Local Services run rate once that campaign is paused', () => {
    const paused = state({
      campaigns: {
        [`${C}/campaigns/1`]: { status: 'ENABLED', budget: `${C}/campaignBudgets/10`, budgetMicros: 375_000_000, channel: 'SEARCH' },
        [`${C}/campaigns/9`]: { status: 'PAUSED', budget: `${C}/campaignBudgets/90`, budgetMicros: 16_000_000_000, channel: 'LOCAL_SERVICES' },
      },
      budgets: { [`${C}/campaignBudgets/10`]: 375_000_000, [`${C}/campaignBudgets/90`]: 16_000_000_000 },
      monthToDateMicros: 4_000_000_000,
      perLeadMonthToDateMicros: 1_100_000_000,
    });
    const result = evaluate([budgetOp(10, 425_000_000)], { state: paused, monthlyBudget: 20_000 });
    expect(result.impact.per_lead_daily_spend).toBe(0);
    expect(result.impact.projected_month_spend).toBe(4_000 + 425 * 21);
  });

  it('counts a shared budget only once', () => {
    const shared = state({
      campaigns: {
        [`${C}/campaigns/1`]: { status: 'ENABLED', budget: `${C}/campaignBudgets/10`, budgetMicros: 50_000_000 },
        [`${C}/campaigns/2`]: { status: 'ENABLED', budget: `${C}/campaignBudgets/10`, budgetMicros: 50_000_000 },
      },
      budgets: { [`${C}/campaignBudgets/10`]: 50_000_000 },
    });
    expect(evaluate([budgetOp(10, 50_000_000)], { state: shared }).impact.daily_budget_before).toBe(50);
  });

  it('sends removals, enabled new campaigns and bidding changes for approval', () => {
    expect(evaluate([{ adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/5~6` } }]).findings.map(f => f.code)).toContain('removal');
    expect(evaluate([{ adGroupCriterionOperation: { remove: `${C}/adGroupCriteria/5~6` } }], { guardrails: { allow_removals: true } }).verdict).toBe('pending');
    expect(evaluate([{ campaignOperation: { create: { name: 'New', status: 'ENABLED' } } }]).findings.map(f => f.code)).toContain('new_campaign_enabled');
    expect(evaluate([{ campaignOperation: { create: { name: 'New', status: 'PAUSED' } } }]).verdict).toBe('pending');
    const bidding = { campaignOperation: { update: { resourceName: `${C}/campaigns/1`, maximizeConversions: { targetCpaMicros: '30000000' } }, updateMask: 'maximizeConversions.targetCpaMicros' } };
    expect(evaluate([bidding]).findings.map(f => f.code)).toContain('bidding_change');
    expect(evaluate([bidding], { guardrails: { allow_bidding_changes: true } }).verdict).toBe('pending');
  });

  it('limits bid changes in both directions', () => {
    const crit = `${C}/adGroupCriteria/5~6`;
    const s = state({ criterionBids: { [crit]: 2_000_000 } });
    const bid = (micros: number) => ({ adGroupCriterionOperation: { update: { resourceName: crit, cpcBidMicros: String(micros) }, updateMask: 'cpcBidMicros' } });
    expect(evaluate([bid(2_400_000)], { state: s }).verdict).toBe('pending'); // +20%
    expect(evaluate([bid(1_000_000)], { state: s }).findings.map(f => f.code)).toContain('bid_change_over_limit'); // -50%
  });

  it('always routes account and conversion settings to a person', () => {
    const op = { conversionActionOperation: { update: { resourceName: `${C}/conversionActions/1`, status: 'REMOVED' }, updateMask: 'status' } };
    expect(evaluate([op]).findings.map(f => f.code)).toContain('sensitive_settings');
  });

  it('applies the client mode on top of everything', () => {
    expect(evaluate([budgetOp(10, 51_000_000)], { guardrails: { mode: 'review' } }).verdict).toBe('needs_approval');
    expect(evaluate([budgetOp(10, 51_000_000)], { guardrails: { mode: 'read_only' } }).verdict).toBe('blocked');
  });

  it('caps the number of operations per change', () => {
    const ops = Array.from({ length: 6 }, () => ({ adGroupCriterionOperation: { create: { adGroup: `${C}/adGroups/1`, keyword: { text: 'x', matchType: 'EXACT' } } } }));
    expect(evaluate(ops, { guardrails: { max_operations: 5 } }).findings.map(f => f.code)).toContain('too_many_operations');
  });
});

describe('guardrail settings', () => {
  it('fills defaults and clamps nonsense', () => {
    const g = normalizeGuardrails({ mode: 'yolo', max_budget_increase_pct: -5, max_operations: 99999, allow_removals: 'yes' });
    expect(g.mode).toBe('guarded');
    expect(g.max_budget_increase_pct).toBe(0);
    expect(g.max_operations).toBe(1000);
    expect(g.allow_removals).toBe(false);
  });

  it('works out the month position in the account time zone', () => {
    // 23:30 UTC on the 31st is already the 1st in Sydney.
    const late = new Date('2026-10-31T23:30:00Z');
    expect(monthPosition(late, 'UTC')).toMatchObject({ day: 31, daysInMonth: 31, remainingDays: 1 });
    expect(monthPosition(late, 'Australia/Sydney')).toMatchObject({ day: 1, daysInMonth: 30, remainingDays: 30 });
  });
});
