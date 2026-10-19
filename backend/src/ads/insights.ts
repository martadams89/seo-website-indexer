/**
 * ads/insights.ts — the read-only views the dashboard and the assistant share:
 * an account overview (KPIs vs the previous period, campaigns, daily series),
 * monthly budget pacing, a structured audit and search-term waste.
 */
import { microsToUnits, searchGaql, type AdsRow } from './client.js';
import { callContext } from './changes.js';
import { monthPosition } from './guardrails.js';
import type { AdsAccount } from './store.js';

// ── Dates ────────────────────────────────────────────────────────────────────

/** Today's date in the account's time zone, as YYYY-MM-DD. */
export function accountToday(timeZone: string | null | undefined, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The last `days` complete days (ending yesterday) and the period before it. */
export function comparisonWindow(days: number, timeZone: string | null | undefined, now = new Date()) {
  const end = addDays(accountToday(timeZone, now), -1);
  const start = addDays(end, -(days - 1));
  const previousEnd = addDays(start, -1);
  const previousStart = addDays(previousEnd, -(days - 1));
  return { start, end, previousStart, previousEnd };
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface Kpis {
  cost: number; impressions: number; clicks: number; conversions: number; conversion_value: number;
  ctr: number | null; avg_cpc: number | null; cpa: number | null; roas: number | null; conversion_rate: number | null;
}

const num = (v: unknown) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;

export function kpisFrom(metrics: Record<string, unknown> | undefined): Kpis {
  const m = metrics ?? {};
  const cost = microsToUnits(m.costMicros);
  const impressions = num(m.impressions);
  const clicks = num(m.clicks);
  const conversions = round(num(m.conversions));
  const conversion_value = round(num(m.conversionsValue));
  return {
    cost, impressions, clicks, conversions, conversion_value,
    ctr: impressions ? round((clicks / impressions) * 100) : null,
    avg_cpc: clicks ? round(cost / clicks) : null,
    cpa: conversions ? round(cost / conversions) : null,
    roas: cost && conversion_value ? round(conversion_value / cost) : null,
    conversion_rate: clicks ? round((conversions / clicks) * 100) : null,
  };
}

function sumMetrics(rows: AdsRow[]): Record<string, unknown> {
  const total: Record<string, number> = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries((row.metrics as Record<string, unknown>) ?? {})) total[key] = (total[key] ?? 0) + num(value);
  }
  return total;
}

const KPI_FIELDS = 'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value';

// ── Overview ─────────────────────────────────────────────────────────────────

export interface CampaignRow {
  id: string; name: string; status: string; channel: string | null; bidding: string | null;
  budget_resource: string | null; daily_budget: number | null; budget_shared: boolean;
  search_impression_share: number | null; lost_is_budget: number | null; lost_is_rank: number | null;
  kpis: Kpis;
}

const overviewCache = new Map<string, { at: number; value: unknown }>();
const CACHE_MS = 5 * 60_000;

export async function accountOverview(account: AdsAccount, days = 30, opts: { fresh?: boolean } = {}) {
  const period = Math.max(1, Math.min(365, Math.floor(days)));
  const key = `${account.id}:${period}`;
  const hit = overviewCache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value as Awaited<ReturnType<typeof buildOverview>>;
  const value = await buildOverview(account, period);
  overviewCache.set(key, { at: Date.now(), value });
  return value;
}

async function buildOverview(account: AdsAccount, days: number) {
  const ctx = callContext(account);
  const cid = account.customer_id;
  const w = comparisonWindow(days, account.time_zone);
  const between = (a: string, b: string) => `segments.date BETWEEN '${a}' AND '${b}'`;
  const [current, previous, daily, campaigns] = await Promise.all([
    searchGaql(ctx, cid, `SELECT ${KPI_FIELDS} FROM customer WHERE ${between(w.start, w.end)}`),
    searchGaql(ctx, cid, `SELECT ${KPI_FIELDS} FROM customer WHERE ${between(w.previousStart, w.previousEnd)}`),
    searchGaql(ctx, cid, `SELECT segments.date, ${KPI_FIELDS} FROM customer WHERE ${between(w.start, w.end)} ORDER BY segments.date`, 400),
    searchGaql(ctx, cid, `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type,
        campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared,
        metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share, ${KPI_FIELDS}
      FROM campaign WHERE campaign.status != 'REMOVED' AND ${between(w.start, w.end)} ORDER BY metrics.cost_micros DESC`, 500),
  ]);
  const campaignRows: CampaignRow[] = campaigns.rows.map(row => {
    const c = (row.campaign ?? {}) as Record<string, unknown>;
    const b = (row.campaignBudget ?? {}) as Record<string, unknown>;
    const m = (row.metrics ?? {}) as Record<string, unknown>;
    const share = (v: unknown) => v === undefined || v === null ? null : round(num(v) * 100, 1);
    return {
      id: String(c.id ?? ''), name: String(c.name ?? ''), status: String(c.status ?? ''),
      channel: (c.advertisingChannelType as string) ?? null, bidding: (c.biddingStrategyType as string) ?? null,
      budget_resource: (b.resourceName as string) ?? null, daily_budget: b.amountMicros !== undefined ? microsToUnits(b.amountMicros) : null,
      budget_shared: !!b.explicitlyShared,
      search_impression_share: share(m.searchImpressionShare), lost_is_budget: share(m.searchBudgetLostImpressionShare), lost_is_rank: share(m.searchRankLostImpressionShare),
      kpis: kpisFrom(m),
    };
  });
  const totals = kpisFrom(sumMetrics(current.rows));
  const before = kpisFrom(sumMetrics(previous.rows));
  const change = (a: number | null, b: number | null) => a === null || b === null || b === 0 ? null : round(((a - b) / b) * 100, 1);
  return {
    account: { id: account.id, customer_id: account.customer_id, name: account.name, currency: account.currency, time_zone: account.time_zone },
    period: { days, start: w.start, end: w.end, previous_start: w.previousStart, previous_end: w.previousEnd },
    totals,
    previous: before,
    change_pct: Object.fromEntries((Object.keys(totals) as Array<keyof Kpis>).map(k => [k, change(totals[k], before[k])])),
    daily: daily.rows.map(row => ({ date: String((row.segments as Record<string, unknown>)?.date ?? ''), ...kpisFrom(row.metrics as Record<string, unknown>) })),
    campaigns: campaignRows,
    pacing: await budgetPacing(account),
    fetched_at: new Date().toISOString(),
  };
}

// ── Pacing ───────────────────────────────────────────────────────────────────

export async function budgetPacing(account: AdsAccount, now = new Date()) {
  const ctx = callContext(account);
  const cid = account.customer_id;
  const [mtd, last7, enabled] = await Promise.all([
    searchGaql(ctx, cid, 'SELECT metrics.cost_micros FROM customer WHERE segments.date DURING THIS_MONTH'),
    searchGaql(ctx, cid, 'SELECT metrics.cost_micros FROM customer WHERE segments.date DURING LAST_7_DAYS'),
    searchGaql(ctx, cid, `SELECT campaign.resource_name, campaign_budget.resource_name, campaign_budget.amount_micros
      FROM campaign WHERE campaign.status = 'ENABLED'`, 5000),
  ]);
  const budgets = new Map<string, number>();
  for (const row of enabled.rows) {
    const b = (row.campaignBudget ?? {}) as Record<string, unknown>;
    const c = (row.campaign ?? {}) as Record<string, unknown>;
    budgets.set(String(b.resourceName ?? c.resourceName), num(b.amountMicros));
  }
  const pos = monthPosition(now, account.time_zone);
  const spent = microsToUnits(sumMetrics(mtd.rows).costMicros);
  const dailyBudgets = microsToUnits([...budgets.values()].reduce((a, b) => a + b, 0));
  const projected = round(spent + dailyBudgets * pos.remainingDays);
  const monthly = account.monthly_budget;
  const recommendedDaily = monthly === null ? null : round(Math.max(0, monthly - spent) / Math.max(1, pos.remainingDays));
  const expectedByNow = monthly === null ? null : round((monthly * (pos.day - 1)) / pos.daysInMonth);
  let status: 'no_budget' | 'under' | 'on_track' | 'over' = 'no_budget';
  if (monthly !== null) {
    const ratio = monthly > 0 ? projected / monthly : Infinity;
    status = ratio > 1.02 ? 'over' : ratio < 0.9 ? 'under' : 'on_track';
  }
  return {
    currency: account.currency,
    monthly_budget: monthly,
    month_to_date_spend: spent,
    expected_spend_by_now: expectedByNow,
    day_of_month: pos.day,
    days_in_month: pos.daysInMonth,
    remaining_days_including_today: pos.remainingDays,
    enabled_daily_budgets: dailyBudgets,
    average_daily_spend_last_7_days: round(microsToUnits(sumMetrics(last7.rows).costMicros) / 7),
    projected_month_spend: projected,
    recommended_daily_budget_total: recommendedDaily,
    status,
    note: 'Google may spend up to twice a campaign\'s daily budget on a single day but never charges more than 30.4× the daily budget in a month. Projection = month-to-date spend + enabled daily budgets × remaining days.',
  };
}

// ── Search terms ─────────────────────────────────────────────────────────────

export async function searchTerms(account: AdsAccount, opts: { days?: number; minCost?: number; withoutConversionsOnly?: boolean; limit?: number } = {}) {
  const days = Math.max(1, Math.min(90, Math.floor(opts.days ?? 30)));
  const w = comparisonWindow(days, account.time_zone);
  const conditions = [`segments.date BETWEEN '${w.start}' AND '${w.end}'`];
  if (opts.minCost) conditions.push(`metrics.cost_micros >= ${Math.round(opts.minCost * 1_000_000)}`);
  if (opts.withoutConversionsOnly) conditions.push('metrics.conversions = 0');
  const { rows, truncated } = await searchGaql(callContext(account), account.customer_id, `
    SELECT search_term_view.search_term, search_term_view.status, campaign.id, campaign.name, ad_group.id, ad_group.name, ${KPI_FIELDS}
    FROM search_term_view WHERE ${conditions.join(' AND ')} ORDER BY metrics.cost_micros DESC LIMIT ${Math.max(1, Math.min(1000, opts.limit ?? 200))}`, 1000);
  return {
    period: { start: w.start, end: w.end },
    truncated,
    terms: rows.map(row => ({
      search_term: (row.searchTermView as Record<string, unknown>)?.searchTerm,
      status: (row.searchTermView as Record<string, unknown>)?.status,
      campaign_id: String((row.campaign as Record<string, unknown>)?.id ?? ''),
      campaign: (row.campaign as Record<string, unknown>)?.name,
      ad_group_id: String((row.adGroup as Record<string, unknown>)?.id ?? ''),
      ad_group: (row.adGroup as Record<string, unknown>)?.name,
      ...kpisFrom(row.metrics as Record<string, unknown>),
    })),
  };
}

// ── Audit ────────────────────────────────────────────────────────────────────

export interface AuditFinding {
  check: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'ok';
  title: string;
  detail: string;
  evidence?: unknown;
  suggested_action?: string;
}

/**
 * A structured health check. Each check runs independently so one failing
 * query (e.g. a field not available for this account type) never hides the rest.
 */
export async function auditAccount(account: AdsAccount): Promise<{ account: string; checked_at: string; findings: AuditFinding[]; errors: string[] }> {
  const ctx = callContext(account);
  const cid = account.customer_id;
  const findings: AuditFinding[] = [];
  const errors: string[] = [];
  const run = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const w = comparisonWindow(30, account.time_zone);
  const last30 = `segments.date BETWEEN '${w.start}' AND '${w.end}'`;
  let accountCpa: number | null = null;

  await run('conversion tracking', async () => {
    const [actions, totals] = await Promise.all([
      searchGaql(ctx, cid, `SELECT conversion_action.name, conversion_action.type, conversion_action.primary_for_goal FROM conversion_action
        WHERE conversion_action.status = 'ENABLED'`, 200),
      searchGaql(ctx, cid, `SELECT ${KPI_FIELDS} FROM customer WHERE ${last30}`),
    ]);
    const kpis = kpisFrom(sumMetrics(totals.rows));
    accountCpa = kpis.cpa;
    const primary = actions.rows.filter(r => (r.conversionAction as Record<string, unknown>)?.primaryForGoal);
    if (!actions.rows.length) {
      findings.push({ check: 'conversion_tracking', severity: 'critical', title: 'No conversion tracking', detail: 'The account has no enabled conversion actions, so smart bidding and CPA/ROAS optimisation have nothing to optimise for.', suggested_action: 'Set up conversion tracking (Google tag, GA4 import or offline conversions) before scaling spend.' });
    } else if (!primary.length) {
      findings.push({ check: 'conversion_tracking', severity: 'high', title: 'No primary conversion actions', detail: `${actions.rows.length} conversion actions are enabled but none is primary, so bidding ignores them.`, suggested_action: 'Mark the conversion actions that represent real business outcomes as primary.' });
    } else if (kpis.cost > 0 && kpis.conversions === 0) {
      findings.push({ check: 'conversion_tracking', severity: 'high', title: 'Spend with zero conversions', detail: `${kpis.cost} spent in the last 30 days with no recorded conversions. Tracking may be broken.`, evidence: kpis, suggested_action: 'Check the Google tag and conversion action status before changing bids.' });
    } else {
      findings.push({ check: 'conversion_tracking', severity: 'ok', title: 'Conversion tracking active', detail: `${primary.length} primary conversion action(s); ${kpis.conversions} conversions in the last 30 days.` });
    }
  });

  await run('budget pacing', async () => {
    const pacing = await budgetPacing(account);
    if (pacing.status === 'no_budget') {
      findings.push({ check: 'pacing', severity: 'medium', title: 'No monthly budget set', detail: 'Set the client\'s monthly budget in the app so spend can be paced and guarded.' });
    } else if (pacing.status === 'over') {
      findings.push({ check: 'pacing', severity: 'high', title: 'Projected to overspend', detail: `Projected ${pacing.projected_month_spend} vs a monthly budget of ${pacing.monthly_budget}.`, evidence: pacing, suggested_action: `Reduce enabled daily budgets to about ${pacing.recommended_daily_budget_total} in total.` });
    } else if (pacing.status === 'under') {
      findings.push({ check: 'pacing', severity: 'medium', title: 'Projected to underspend', detail: `Projected ${pacing.projected_month_spend} vs a monthly budget of ${pacing.monthly_budget}.`, evidence: pacing, suggested_action: `There is room to raise daily budgets to about ${pacing.recommended_daily_budget_total} in total on the best-performing campaigns.` });
    } else {
      findings.push({ check: 'pacing', severity: 'ok', title: 'Spend on track', detail: `Projected ${pacing.projected_month_spend} vs ${pacing.monthly_budget}.` });
    }
  });

  await run('impression share', async () => {
    const { rows } = await searchGaql(ctx, cid, `SELECT campaign.id, campaign.name, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share, ${KPI_FIELDS}
      FROM campaign WHERE campaign.status = 'ENABLED' AND campaign.advertising_channel_type = 'SEARCH' AND ${last30}`, 500);
    for (const row of rows) {
      const c = row.campaign as Record<string, unknown>;
      const m = row.metrics as Record<string, unknown>;
      const k = kpisFrom(m);
      const lostBudget = num(m.searchBudgetLostImpressionShare) * 100;
      const lostRank = num(m.searchRankLostImpressionShare) * 100;
      const efficient = k.conversions > 0 && (!accountCpa || (k.cpa ?? Infinity) <= accountCpa * 1.1);
      if (lostBudget >= 10) {
        findings.push({ check: 'limited_by_budget', severity: efficient ? 'high' : 'medium', title: `${c.name}: losing ${lostBudget.toFixed(0)}% of impressions to budget`, detail: efficient ? 'This campaign converts at or better than the account average, so more budget is likely to pay back.' : 'Budget is limiting delivery; check efficiency before adding budget.', evidence: { campaign_id: c.id, ...k, lost_is_budget: round(lostBudget, 1) }, suggested_action: efficient ? 'Shift budget here from weaker campaigns, within the monthly budget.' : undefined });
      }
      if (lostRank >= 50 && k.impressions > 100) {
        findings.push({ check: 'limited_by_rank', severity: 'medium', title: `${c.name}: losing ${lostRank.toFixed(0)}% of impressions to ad rank`, detail: 'Low ad rank (bids, quality or ad relevance) is limiting delivery.', evidence: { campaign_id: c.id, lost_is_rank: round(lostRank, 1) }, suggested_action: 'Improve ad relevance and landing pages, or review bids/targets.' });
      }
    }
  });

  await run('search terms', async () => {
    const threshold = account.brief.target_cpa ?? accountCpa ?? 20;
    const { terms } = await searchTerms(account, { days: 30, minCost: threshold, withoutConversionsOnly: true, limit: 25 });
    if (terms.length) {
      const wasted = round(terms.reduce((sum, t) => sum + (t.cost ?? 0), 0));
      findings.push({ check: 'wasted_search_terms', severity: wasted > threshold * 3 ? 'high' : 'medium', title: `${terms.length} search terms spent ≥ ${threshold} with no conversions`, detail: `${wasted} spent in the last 30 days on these terms.`, evidence: terms.slice(0, 25).map(t => ({ term: t.search_term, cost: t.cost, clicks: t.clicks, campaign: t.campaign, ad_group: t.ad_group })), suggested_action: 'Add irrelevant terms as negative keywords (phrase or exact); keep relevant ones and improve their ads/landing pages.' });
    }
  });

  await run('quality score', async () => {
    const { rows } = await searchGaql(ctx, cid, `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.quality_info.quality_score, ad_group.id, ad_group.name, metrics.cost_micros
      FROM keyword_view WHERE ${last30} AND ad_group_criterion.status = 'ENABLED' AND ad_group_criterion.quality_info.quality_score <= 4 AND metrics.cost_micros > 0
      ORDER BY metrics.cost_micros DESC LIMIT 25`, 25);
    if (rows.length) {
      findings.push({ check: 'low_quality_score', severity: 'medium', title: `${rows.length} spending keywords have Quality Score ≤ 4`, detail: 'Low Quality Score raises CPCs and limits ad rank.', evidence: rows.map(r => ({ keyword: (r.adGroupCriterion as Record<string, unknown> & { keyword?: { text?: string }; qualityInfo?: { qualityScore?: number } })?.keyword?.text, quality_score: (r.adGroupCriterion as { qualityInfo?: { qualityScore?: number } })?.qualityInfo?.qualityScore, ad_group: (r.adGroup as Record<string, unknown>)?.name, cost: microsToUnits((r.metrics as Record<string, unknown>)?.costMicros) })), suggested_action: 'Tighten ad groups around these keywords, align headlines with the query and improve landing-page relevance; pause persistent poor performers.' });
    }
  });

  await run('ad policy', async () => {
    const { rows } = await searchGaql(ctx, cid, `SELECT ad_group_ad.ad.id, ad_group_ad.policy_summary.approval_status, ad_group.name, campaign.name FROM ad_group_ad
      WHERE ad_group_ad.status = 'ENABLED' AND campaign.status = 'ENABLED' AND ad_group_ad.policy_summary.approval_status IN ('DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY')`, 100);
    if (rows.length) {
      const disapproved = rows.filter(r => (r.adGroupAd as { policySummary?: { approvalStatus?: string } })?.policySummary?.approvalStatus === 'DISAPPROVED').length;
      findings.push({ check: 'ad_policy', severity: disapproved ? 'high' : 'low', title: `${rows.length} enabled ads have policy issues (${disapproved} disapproved)`, detail: 'Disapproved ads do not serve; limited ads serve less.', evidence: rows.slice(0, 25).map(r => ({ ad_id: (r.adGroupAd as { ad?: { id?: string } })?.ad?.id, status: (r.adGroupAd as { policySummary?: { approvalStatus?: string } })?.policySummary?.approvalStatus, ad_group: (r.adGroup as Record<string, unknown>)?.name, campaign: (r.campaign as Record<string, unknown>)?.name })), suggested_action: 'Fix the policy issue or replace the ads.' });
    }
  });

  await run('ad coverage', async () => {
    const [groups, ads] = await Promise.all([
      searchGaql(ctx, cid, `SELECT ad_group.id, ad_group.name, campaign.name FROM ad_group WHERE ad_group.status = 'ENABLED' AND campaign.status = 'ENABLED' AND campaign.advertising_channel_type = 'SEARCH'`, 5000),
      searchGaql(ctx, cid, `SELECT ad_group.id, ad_group_ad.ad_strength FROM ad_group_ad WHERE ad_group_ad.status = 'ENABLED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' AND campaign.status = 'ENABLED'`, 10_000),
    ]);
    const withAds = new Set(ads.rows.map(r => String((r.adGroup as Record<string, unknown>)?.id)));
    const missing = groups.rows.filter(r => !withAds.has(String((r.adGroup as Record<string, unknown>)?.id)));
    if (missing.length) {
      findings.push({ check: 'missing_ads', severity: 'high', title: `${missing.length} enabled ad groups have no enabled responsive search ad`, detail: 'These ad groups cannot serve on Search.', evidence: missing.slice(0, 25).map(r => ({ ad_group_id: (r.adGroup as Record<string, unknown>)?.id, ad_group: (r.adGroup as Record<string, unknown>)?.name, campaign: (r.campaign as Record<string, unknown>)?.name })), suggested_action: 'Create a responsive search ad for each.' });
    }
    const weak = ads.rows.filter(r => ['POOR', 'AVERAGE'].includes(String((r.adGroupAd as Record<string, unknown>)?.adStrength)));
    if (weak.length) {
      findings.push({ check: 'ad_strength', severity: 'low', title: `${weak.length} responsive search ads have Poor or Average ad strength`, detail: 'More distinct headlines and descriptions usually improve delivery.', suggested_action: 'Add unique headlines (keywords, offers, proof points, calls to action) and avoid pinning unless required.' });
    }
  });

  await run('optimisation score', async () => {
    const { rows } = await searchGaql(ctx, cid, 'SELECT customer.optimization_score FROM customer');
    const score = (rows[0]?.customer as Record<string, unknown>)?.optimizationScore;
    if (score !== undefined && score !== null) {
      findings.push({ check: 'optimization_score', severity: num(score) < 0.7 ? 'low' : 'ok', title: `Google optimisation score ${(num(score) * 100).toFixed(0)}%`, detail: 'Review Google\'s recommendations critically — many raise spend or broaden matching. Use ads_list_recommendations.' });
    }
  });

  const order = { critical: 0, high: 1, medium: 2, low: 3, ok: 4 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { account: account.name ?? account.customer_id, checked_at: new Date().toISOString(), findings, errors };
}

export async function listRecommendations(account: AdsAccount, limit = 100) {
  const { rows } = await searchGaql(callContext(account), account.customer_id, `
    SELECT recommendation.resource_name, recommendation.type, recommendation.campaign, recommendation.ad_group, recommendation.dismissed,
           recommendation.impact.base_metrics.cost_micros, recommendation.impact.potential_metrics.cost_micros,
           recommendation.impact.base_metrics.conversions, recommendation.impact.potential_metrics.conversions,
           recommendation.impact.base_metrics.clicks, recommendation.impact.potential_metrics.clicks
    FROM recommendation WHERE recommendation.dismissed = FALSE LIMIT ${Math.max(1, Math.min(500, limit))}`, 500);
  return rows.map(row => {
    const r = (row.recommendation ?? {}) as Record<string, unknown> & { impact?: { baseMetrics?: Record<string, unknown>; potentialMetrics?: Record<string, unknown> } };
    const base = r.impact?.baseMetrics ?? {}; const potential = r.impact?.potentialMetrics ?? {};
    return {
      resource_name: r.resourceName, type: r.type, campaign: r.campaign ?? null, ad_group: r.adGroup ?? null,
      impact: {
        cost: { base: microsToUnits(base.costMicros), potential: microsToUnits(potential.costMicros) },
        conversions: { base: num(base.conversions), potential: num(potential.conversions) },
        clicks: { base: num(base.clicks), potential: num(potential.clicks) },
      },
    };
  });
}
