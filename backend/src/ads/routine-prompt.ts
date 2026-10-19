/**
 * ads/routine-prompt.ts — turn the routine questionnaire into a copy-and-paste
 * prompt for a scheduled task in any MCP-capable AI assistant or agent CLI.
 *
 * The prompt carries the client briefs, budgets and cadence, and tells the
 * assistant exactly which MCP tools to call in which order. Guardrails are
 * enforced by the server regardless of what the prompt says; the prompt only
 * shapes how the assistant works within them.
 */
import { formatCustomerId } from './client.js';
import type { AdsAccount } from './store.js';

export type RoutineCadence = 'daily' | 'weekdays' | 'twice_weekly' | 'weekly';
export type RoutineMode = 'autopilot' | 'propose';
export type ResearchDepth = 'light' | 'standard' | 'deep';

export interface RoutineSettings {
  cadence: RoutineCadence;
  time: string;
  timezone: string;
  mode: RoutineMode;
  lookback_days: number;
  research: ResearchDepth;
  focus: string[];
  extra_instructions?: string;
}

export const DEFAULT_ROUTINE: RoutineSettings = {
  cadence: 'daily',
  time: '07:00',
  timezone: 'Europe/London',
  mode: 'autopilot',
  lookback_days: 30,
  research: 'standard',
  focus: ['pacing', 'waste', 'budget_shift', 'ads', 'keywords'],
};

export const FOCUS_AREAS: Record<string, string> = {
  pacing: 'Pace spend to each client\'s monthly budget — aim to spend it fully by month end without going over.',
  waste: 'Cut waste: add irrelevant or non-converting search terms as negatives; pause keywords and ads that keep spending without results.',
  budget_shift: 'Move daily budget from weak campaigns to campaigns that are limited by budget and convert at or better than target.',
  bids: 'Adjust keyword bids and CPA/ROAS targets gradually (within the guardrail percentages) based on at least two weeks of data.',
  ads: 'Keep every ad group with at least one strong responsive search ad; draft new ads (paused) from competitor and market insight.',
  keywords: 'Find new keyword opportunities from search terms, keyword ideas and competitor research; add them to the right ad groups.',
  recommendations: 'Review Google\'s recommendations critically; dismiss ones that only raise spend or broaden matching without evidence.',
  new_campaigns: 'Where research shows a clear opportunity, build a new search campaign (always created paused) for approval.',
};

const CADENCE_TEXT: Record<RoutineCadence, string> = {
  daily: 'every day',
  weekdays: 'every weekday (Monday–Friday)',
  twice_weekly: 'twice a week (Monday and Thursday)',
  weekly: 'once a week (Monday)',
};

export function cadenceLabel(settings: Pick<RoutineSettings, 'cadence' | 'time' | 'timezone'>): string {
  return `${CADENCE_TEXT[settings.cadence] ?? settings.cadence} at ${settings.time} (${settings.timezone})`;
}

/** Cron expression for schedulers that accept one (minute hour dom month dow), in the chosen time zone. */
export function cadenceCron(settings: Pick<RoutineSettings, 'cadence' | 'time'>): string {
  const [h, m] = settings.time.split(':').map(v => Number(v));
  const hour = Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 7;
  const minute = Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 0;
  const dow = settings.cadence === 'weekdays' ? '1-5' : settings.cadence === 'twice_weekly' ? '1,4' : settings.cadence === 'weekly' ? '1' : '*';
  return `${minute} ${hour} * * ${dow}`;
}

export function normalizeRoutine(raw: unknown): RoutineSettings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof RoutineSettings, unknown>>;
  const cadence = ['daily', 'weekdays', 'twice_weekly', 'weekly'].includes(String(v.cadence)) ? v.cadence as RoutineCadence : DEFAULT_ROUTINE.cadence;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v.time)) ? String(v.time) : DEFAULT_ROUTINE.time;
  let timezone = typeof v.timezone === 'string' && v.timezone.trim() ? v.timezone.trim() : DEFAULT_ROUTINE.timezone;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { timezone = DEFAULT_ROUTINE.timezone; }
  const mode = v.mode === 'propose' ? 'propose' : 'autopilot';
  const lookback = Number(v.lookback_days);
  const research = ['light', 'standard', 'deep'].includes(String(v.research)) ? v.research as ResearchDepth : DEFAULT_ROUTINE.research;
  const focus = Array.isArray(v.focus) ? v.focus.map(String).filter(f => f in FOCUS_AREAS) : DEFAULT_ROUTINE.focus;
  return {
    cadence, time, timezone, mode,
    lookback_days: [7, 14, 30, 60, 90].includes(lookback) ? lookback : DEFAULT_ROUTINE.lookback_days,
    research,
    focus: focus.length ? [...new Set(focus)] : DEFAULT_ROUTINE.focus,
    extra_instructions: typeof v.extra_instructions === 'string' ? v.extra_instructions.trim().slice(0, 4000) : undefined,
  };
}

function money(value: number | null | undefined, currency: string | null): string {
  if (value === null || value === undefined) return 'not set';
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP', maximumFractionDigits: 2 }).format(value); }
  catch { return `${value} ${currency ?? ''}`.trim(); }
}

function clientBlock(account: AdsAccount, index: number): string {
  const b = account.brief;
  const lines = [
    `${index + 1}. ${account.name ?? 'Unnamed account'} — account id \`${account.id}\`, Google Ads customer ${formatCustomerId(account.customer_id)}${account.currency ? ` (${account.currency})` : ''}`,
    `   - Monthly budget: ${money(account.monthly_budget, account.currency)}`,
    `   - Goal: ${b.goal ?? 'not specified — infer from conversion actions and confirm in your report'}${b.target_cpa ? `; target CPA ${money(b.target_cpa, account.currency)}` : ''}${b.target_roas ? `; target ROAS ${b.target_roas}` : ''}`,
  ];
  if (b.website) lines.push(`   - Website: ${b.website}`);
  if (b.offer) lines.push(`   - Offer / USPs: ${b.offer}`);
  if (b.audience) lines.push(`   - Audience: ${b.audience}`);
  if (b.markets) lines.push(`   - Markets / locations: ${b.markets}`);
  lines.push(`   - Known competitors: ${b.competitors?.length ? b.competitors.join(', ') : 'none yet — find the main ones'}`);
  if (b.brand_voice) lines.push(`   - Brand voice: ${b.brand_voice}`);
  if (b.never_do) lines.push(`   - Never do: ${b.never_do}`);
  if (b.notes) lines.push(`   - Notes: ${b.notes}`);
  lines.push(`   - Guardrails (enforced by the server): ${account.guardrails.mode === 'read_only' ? 'read-only' : account.guardrails.mode === 'review' ? 'every change needs my approval' : `budget increases up to ${account.guardrails.max_budget_increase_pct}% and bid changes up to ±${account.guardrails.max_bid_change_pct}% per change apply automatically; projected spend may not exceed the monthly budget${account.guardrails.budget_tolerance_pct ? ` + ${account.guardrails.budget_tolerance_pct}%` : ''}`}`);
  return lines.join('\n');
}

const RESEARCH_TEXT: Record<ResearchDepth, string> = {
  light: 'Do a quick web search for notable news, seasonality or offers in this client\'s market since your last run.',
  standard: 'Use web search to check the client\'s market and up to 5 competitors: their current search ads and offers (search the client\'s main keywords), landing-page messaging, pricing/promotions and any seasonal or news-driven demand shifts. If no competitors are listed, identify the top 3–5 advertisers on the main keywords and save them with ads_update_client_brief.',
  deep: 'Use web search and browsing for a thorough market review: up to 8 competitors\' ads, offers, landing pages and pricing; category demand trends and seasonality; new entrants; and how the client\'s proposition compares. Save new competitors and a short market summary with ads_update_client_brief and in the routine log.',
};

export function buildRoutinePrompt(input: {
  settings: RoutineSettings;
  accounts: AdsAccount[];
  connectorName: string;
  endpoint: string;
  dashboardUrl: string;
  workspaceName?: string | null;
}): { prompt: string; schedule: string; cron: string } {
  const s = input.settings;
  const autopilot = s.mode === 'autopilot';
  const schedule = cadenceLabel(s);
  const focus = s.focus.map(f => `- ${FOCUS_AREAS[f]}`).join('\n');
  const clients = input.accounts.length
    ? input.accounts.map(clientBlock).join('\n\n')
    : '(No client accounts selected — call ads_list_clients and work through every enabled client.)';

  const prompt = `You are my Google Ads optimisation agent${input.workspaceName ? ` for ${input.workspaceName}` : ''}. This task runs ${schedule}.

Use the "${input.connectorName}" MCP server (${input.endpoint}). Its Google Ads tools start with "ads_". If the server isn't connected or its tools fail to authenticate, stop and tell me — do not try to work around it. Use your web search (and browsing, if available) for the market and competitor research.

## Clients in scope
${clients}

## Each run, for every client above
1. Context: call ads_get_client_brief, then ads_budget_pacing. Read the last routine notes in the brief so you continue from where you left off, and check whether earlier changes that were waiting for approval have been decided (ads_list_changes).
2. Performance: call ads_account_overview with days=${s.lookback_days} (and days=7 for the recent trend). Note what changed versus the previous period and why.
3. Health: call ads_audit_account and ads_search_terms (withoutConversionsOnly=true). Use ads_search / ads_query (GAQL) for anything else you need — look up fields with ads_get_resource_metadata instead of guessing them.
4. Market and competitors: ${RESEARCH_TEXT[s.research]}
5. Decide on changes. Priorities for this client:
${focus}
   Base every change on numbers you can quote (spend, conversions, CPA/ROAS, impression share, search terms) and on the brief. Prefer several small, reversible changes over one big one. Never contradict the "Never do" notes.
6. Make changes only with the ads_* change tools (ads_update_budget, ads_update_bids, ads_add_negative_keywords, ads_add_keywords, ads_set_status, ads_create_responsive_search_ad, ads_update_bidding_strategy, ads_create_search_campaign, ads_recommendations, or ads_mutate for anything else). Always include a clear rationale. Each tool validates the change with Google and returns a change plan with a status:
   - "pending": ${autopilot ? 'it is inside the guardrails — apply it with ads_apply_change.' : 'do NOT apply it. Leave it for me to approve on the dashboard.'}
   - "needs_approval": leave it. I approve or reject it on the dashboard. Do not try to split or reshape a change to get around a guardrail.
   - "blocked" or "failed": read the message, fix the request if it was a mistake, otherwise report it.
7. Log the run: call ads_record_routine_run for the client with a short summary, key findings, the changes you made or proposed (with change ids), market/competitor notes, and what to check next time.

## Rules
- Spend: keep each client's projected month spend at or below its monthly budget. When a client is under-pacing and has campaigns that convert well and are limited by budget, raise budgets toward the recommended daily total from ads_budget_pacing.
- New campaigns, ads and keywords are created paused or inside paused campaigns unless the guardrails allow otherwise; say in the log what needs switching on.
- Never change billing, account access, conversion settings or remove things unless I asked for it — those need my approval anyway.
- Don't act on Google's automatic recommendations without checking the data behind them.
- If an API call fails because of access (Google Ads access level, API disabled, reconnect needed), stop working on that client and include the error and its hint in your report.

## Report back
Finish with a short report per client: performance headline (spend vs budget, conversions, CPA/ROAS vs target), what you changed (applied), what is waiting for my approval (link: ${input.dashboardUrl}), market/competitor notes, and anything that needs a human decision.${s.extra_instructions ? `\n\n## Extra instructions\n${s.extra_instructions}` : ''}`;

  return { prompt, schedule, cron: cadenceCron(s) };
}
