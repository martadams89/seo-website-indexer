/**
 * mcp/ads-tools.ts — Google Ads tools for the MCP server.
 *
 * Read tools (mcp:read) mirror Google's googleads/google-ads-mcp server
 * (search, get_resource_metadata, list_accessible_customers) and add client
 * context, pacing, audits and research. Change tools (ads:write) never touch
 * Google directly: they build a change plan that Google validates and the
 * client's guardrails judge. Plans inside the guardrails can be applied with
 * ads_apply_change; the rest wait for a person on the dashboard.
 *
 * Every tool is fenced to ad accounts linked in the token owner's workspaces.
 */
import { z } from 'zod';
import { getGoogleAccountsForWorkspace, type GoogleAccount } from '../db/database.js';
import {
  ADS_SCOPE, AdsApiError, buildGaql, discoverCustomers, flattenRow, formatCustomerId, generateKeywordIdeas,
  getResourceMetadata, listAccessibleCustomers, microsToUnits, searchGaql, suggestLocations, MAX_ROWS,
} from '../ads/client.js';
import { GAQL_RESOURCES } from '../ads/gaql-resources.js';
import { assertCanChangeAds, resolveAdsAccount } from '../ads/access.js';
import { accountOverview, auditAccount, budgetPacing, listRecommendations, searchTerms } from '../ads/insights.js';
import {
  applyChange, callContext, proposeChange, proposeRecommendations, revertChange,
} from '../ads/changes.js';
import {
  addKeywordOperations, adGroupBidOperation, budgetAmountOperation, campaignBiddingOperation, campaignNegativeOperations,
  keywordBidOperation, resourceName, responsiveSearchAdOperation, searchCampaignOperations, sharedSetNegativeOperations,
  statusOperations, type EntityKind, type Operation,
} from '../ads/operations.js';
import {
  getAdsAccount, getChange, listAdsAccounts, listChanges, listRoutineRuns, normalizeBrief, recordRoutineRun, updateAdsAccount,
  type AdsAccount, type AdsChange, type ChangeStatus,
} from '../ads/store.js';
import { verifyAndLinkAccount } from '../ads/setup.js';
import type { McpContext, ToolDef } from './tools.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCOUNT = z.string().describe('The client account: its id from ads_list_clients, or the Google Ads customer ID (e.g. 123-456-7890).');
const RATIONALE = z.string().min(10).max(4000).describe('Why this change: the evidence (numbers) and the expected effect. Shown to the person approving it.');
const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

function account(ctx: McpContext, ref: unknown): AdsAccount {
  return resolveAdsAccount(ctx.workspaceIds, ref);
}

function writableAccount(ctx: McpContext, ref: unknown): AdsAccount {
  const acc = account(ctx, ref);
  assertCanChangeAds(ctx.user, acc.workspace_id);
  return acc;
}

/** Google connections with the Ads scope that are shared with the caller's workspaces. */
function adsConnections(ctx: McpContext): Array<GoogleAccount & { workspace_ids: string[] }> {
  const byId = new Map<string, GoogleAccount & { workspace_ids: string[] }>();
  for (const ws of ctx.workspaceIds) {
    for (const acc of getGoogleAccountsForWorkspace(ws)) {
      if (!(acc.granted_scopes ?? '').split(' ').includes(ADS_SCOPE)) continue;
      const entry = byId.get(acc.id) ?? { ...acc, workspace_ids: [] };
      entry.workspace_ids.push(ws);
      byId.set(acc.id, entry);
    }
  }
  return [...byId.values()];
}

function connection(ctx: McpContext, ref?: unknown): GoogleAccount & { workspace_ids: string[] } {
  const all = adsConnections(ctx);
  if (!all.length) throw new AdsApiError('No Google connection with Google Ads access is shared with your workspaces. Use "Add Google Ads access" on the Google Ads page.', 'NO_ADS_SCOPE');
  if (ref === undefined || ref === null || ref === '') return all[0];
  const match = all.find(a => a.id === ref || a.email === ref);
  if (!match) throw new AdsApiError(`Google connection "${String(ref)}" is not available. Options: ${all.map(a => a.email ?? a.id).join(', ')}`, 'NOT_FOUND');
  return match;
}

function publicAccount(acc: AdsAccount) {
  return {
    id: acc.id, workspace_id: acc.workspace_id, name: acc.name, customer_id: formatCustomerId(acc.customer_id),
    manager_customer_id: acc.login_customer_id ? formatCustomerId(acc.login_customer_id) : null,
    currency: acc.currency, time_zone: acc.time_zone, is_manager: acc.is_manager, test_account: acc.test_account,
    enabled: acc.enabled, monthly_budget: acc.monthly_budget, brief: acc.brief, guardrails: acc.guardrails,
    ga4_property: acc.ga4_property_id
      ? { property_id: acc.ga4_property_id, name: acc.ga4_property_name, read_with: 'ga4_ads_performance or ga4_run_report (account=…)' }
      : null,
    last_error: acc.last_error,
  };
}

function dashboardLink(ctx: McpContext, change?: AdsChange): string | null {
  if (!ctx.origin) return null;
  return `${ctx.origin}/ads?tab=changes${change ? `&change=${change.id}` : ''}`;
}

/** What an assistant needs to know about a change plan, including what to do next. */
function presentChange(ctx: McpContext, change: AdsChange) {
  const next: Record<ChangeStatus, string> = {
    pending: 'Inside the guardrails. Call ads_apply_change with this change_id to apply it (unless your instructions say to leave changes for approval).',
    needs_approval: `Outside the guardrails — a person must approve it on the dashboard${dashboardLink(ctx, change) ? ` (${dashboardLink(ctx, change)})` : ''}. Do not resubmit it in smaller pieces.`,
    blocked: 'Blocked by this client\'s settings. Report it; a person must change the guardrails first.',
    applying: 'Being applied right now.',
    applied: 'Applied.',
    rejected: 'A person rejected this change.',
    failed: 'Google rejected the change. Read the error, fix the request if it was a mistake, or report it.',
    expired: 'Expired before it was applied. Propose it again if it is still needed.',
  };
  return {
    change_id: change.id,
    status: change.status,
    summary: change.summary,
    findings: change.findings,
    impact: change.impact,
    error: change.error,
    operations: change.operations.length,
    next_step: next[change.status],
  };
}

async function propose(ctx: McpContext, acc: AdsAccount, kind: string, summary: string, rationale: unknown, operations: Operation[], beforeState?: Record<string, unknown>) {
  const change = await proposeChange({
    account: acc, userId: ctx.user.id, source: 'mcp', kind, summary, rationale: String(rationale ?? ''), operations, beforeState,
  });
  return presentChange(ctx, change);
}

const quote = (values: string[]) => values.map(v => `'${v.replace(/'/g, '')}'`).join(', ');

/** Current statuses for non-campaign entities, so a status change can be reverted. */
async function currentStatuses(acc: AdsAccount, kind: EntityKind, names: string[]): Promise<Record<string, string>> {
  const table: Partial<Record<EntityKind, [string, string]>> = {
    ad_group: ['ad_group', 'adGroup'], ad_group_ad: ['ad_group_ad', 'adGroupAd'],
    ad_group_criterion: ['ad_group_criterion', 'adGroupCriterion'], asset_group: ['asset_group', 'assetGroup'],
  };
  const entry = table[kind];
  if (!entry || !names.length) return {};
  const [resource, key] = entry;
  const { rows } = await searchGaql(callContext(acc), acc.customer_id,
    `SELECT ${resource}.resource_name, ${resource}.status FROM ${resource} WHERE ${resource}.resource_name IN (${quote(names.slice(0, 1000))})`);
  return Object.fromEntries(rows.map(r => {
    const v = r[key] as Record<string, unknown>;
    return [String(v.resourceName), String(v.status)];
  }));
}

const SEARCH_DESCRIPTION = `Fetch Google Ads data with GAQL built from parts (same contract as Google's google-ads-mcp "search" tool): SELECT <fields> FROM <resource> WHERE <conditions joined by AND> ORDER BY <orderings> LIMIT <limit>. Returns flattened rows ("campaign.name", "metrics.clicks", …; money fields are micros — divide by 1,000,000).

Hints:
- Grammar: https://developers.google.com/google-ads/api/docs/query/grammar — fields: https://developers.google.com/google-ads/api/fields/latest/overview
- You MUST look up valid fields with ads_get_resource_metadata first; don't guess. Use full names (campaign.id, not id).
- Dates are YYYY-MM-DD and ranges must be finite, e.g. "segments.date BETWEEN '2026-09-01' AND '2026-09-30'" or "segments.date DURING LAST_30_DAYS".
- change_event queries need LIMIT ≤ 10000. Conversion upload issues: offline_conversion_upload_conversion_action_summary.

Valid resources: ${GAQL_RESOURCES.join(', ')}`;

const KEYWORDS = z.array(z.object({
  text: z.string(),
  matchType: z.enum(['EXACT', 'PHRASE', 'BROAD']).optional(),
  cpcBid: z.number().positive().optional(),
})).min(1).max(500);

// ── Tools ────────────────────────────────────────────────────────────────────

export const ADS_TOOLS: ToolDef[] = [
  // Client context
  {
    name: 'ads_list_clients',
    title: 'List Google Ads clients',
    description: 'List the Google Ads accounts linked to your workspaces (one per client), with monthly budget, brief (goal, targets, markets, competitors, notes) and guardrails. Start here.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { workspaceId: z.string().optional(), includeDisabled: z.boolean().optional() },
    handler: (ctx, args) => {
      let list = listAdsAccounts(ctx.workspaceIds);
      if (args.workspaceId) list = list.filter(a => a.workspace_id === args.workspaceId);
      if (!args.includeDisabled) list = list.filter(a => a.enabled);
      return { clients: list.map(publicAccount) };
    },
  },
  {
    name: 'ads_get_client_brief',
    title: 'Get a client brief',
    description: 'One client\'s brief, monthly budget and guardrails, the changes waiting for approval, and the notes from the latest routine runs. Read this before deciding anything for the client.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { account: ACCOUNT },
    handler: (ctx, args) => {
      const acc = account(ctx, args.account);
      return {
        client: publicAccount(acc),
        awaiting_approval: listChanges({ workspaceIds: [acc.workspace_id], adsAccountId: acc.id, status: 'needs_approval', limit: 20 }).map(c => presentChange(ctx, c)),
        recent_routine_runs: listRoutineRuns({ workspaceIds: [acc.workspace_id], adsAccountId: acc.id, limit: 3 }),
        dashboard: ctx.origin ? `${ctx.origin}/ads?account=${acc.id}` : null,
      };
    },
  },
  {
    name: 'ads_update_client_brief',
    title: 'Update a client brief',
    description: 'Save what you learned about a client: competitors you identified, markets, offer, audience, notes. Monthly budget and guardrails can only be changed by a person on the dashboard.',
    scope: 'ads:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputShape: {
      account: ACCOUNT,
      competitors: z.array(z.string()).max(25).optional(),
      markets: z.string().max(2000).optional(),
      offer: z.string().max(2000).optional(),
      audience: z.string().max(2000).optional(),
      website: z.string().max(500).optional(),
      notes: z.string().max(2000).optional(),
    },
    handler: (ctx, args) => {
      const acc = writableAccount(ctx, args.account);
      const patch: Record<string, unknown> = { ...acc.brief };
      for (const key of ['competitors', 'markets', 'offer', 'audience', 'website', 'notes'] as const) {
        if (args[key] !== undefined) patch[key] = args[key];
      }
      const updated = updateAdsAccount(acc.id, { brief: normalizeBrief(patch) });
      return { client: updated ? publicAccount(updated) : null };
    },
  },
  {
    name: 'ads_list_accessible_customers',
    title: 'List accessible Google Ads customers',
    description: 'Customer IDs the connected Google user can access directly (same as Google\'s list_accessible_customers). Use ads_discover_accounts for names and manager hierarchies.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { googleAccount: z.string().optional().describe('Email or id of a connected Google account; defaults to the first with Ads access.') },
    handler: async (ctx, args) => {
      const conn = connection(ctx, args.googleAccount);
      return { google_account: conn.email ?? conn.id, customer_ids: await listAccessibleCustomers(conn.id) };
    },
  },
  {
    name: 'ads_discover_accounts',
    title: 'Discover Google Ads accounts',
    description: 'Every ad account reachable through the connected Google users (including clients under manager accounts), and whether each is already linked to a workspace.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { googleAccount: z.string().optional() },
    handler: async (ctx, args) => {
      const conns = args.googleAccount ? [connection(ctx, args.googleAccount)] : adsConnections(ctx);
      const linked = listAdsAccounts(ctx.workspaceIds);
      const out = [];
      for (const conn of conns) {
        const { customers, errors } = await discoverCustomers(conn.id);
        out.push({
          google_account: conn.email ?? conn.id,
          workspaces: conn.workspace_ids,
          errors,
          customers: customers.map(c => ({
            ...c, customer_id: formatCustomerId(c.customer_id),
            login_customer_id: c.login_customer_id ? formatCustomerId(c.login_customer_id) : null,
            linked_as: linked.filter(l => l.customer_id === c.customer_id).map(l => ({ account_id: l.id, workspace_id: l.workspace_id })),
          })),
        });
      }
      return { connections: out };
    },
  },
  {
    name: 'ads_link_account',
    title: 'Link a Google Ads account to a workspace',
    description: 'Link an ad account to a client workspace so it can be reported on and managed. New links start with default guardrails and no monthly budget (so spend increases need approval until a person sets one).',
    scope: 'ads:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: {
      workspaceId: z.string(),
      customerId: z.string(),
      loginCustomerId: z.string().optional().describe('Manager (MCC) customer ID when the account is reached through a manager — see ads_discover_accounts.'),
      googleAccount: z.string().optional(),
    },
    handler: async (ctx, args) => {
      const ws = String(args.workspaceId);
      if (!ctx.workspaceIds.includes(ws)) throw new AdsApiError('Workspace not found.', 'NOT_FOUND');
      assertCanChangeAds(ctx.user, ws);
      const conn = connection(ctx, args.googleAccount);
      if (!conn.workspace_ids.includes(ws)) throw new AdsApiError(`Google connection ${conn.email ?? conn.id} is not shared with that workspace.`, 'PERMISSION');
      const linked = await verifyAndLinkAccount({
        workspaceId: ws, googleAccountId: conn.id, customerId: String(args.customerId),
        loginCustomerId: args.loginCustomerId ? String(args.loginCustomerId) : null, userId: ctx.user.id,
      });
      return { client: publicAccount(linked) };
    },
  },

  // Upstream-compatible reads
  {
    name: 'ads_search',
    title: 'Search Google Ads (GAQL)',
    description: SEARCH_DESCRIPTION,
    scope: 'mcp:read',
    annotations: READ,
    inputShape: {
      account: ACCOUNT,
      fields: z.array(z.string()).min(1).max(200),
      resource: z.string(),
      conditions: z.array(z.string()).max(50).optional(),
      orderings: z.array(z.string()).max(20).optional(),
      limit: z.number().int().min(1).max(MAX_ROWS).optional(),
    },
    handler: async (ctx, args) => {
      const acc = account(ctx, args.account);
      const query = buildGaql({ fields: args.fields as string[], resource: String(args.resource), conditions: args.conditions as string[] | undefined, orderings: args.orderings as string[] | undefined, limit: (args.limit as number | undefined) ?? 1000 });
      const { rows, truncated } = await searchGaql(callContext(acc), acc.customer_id, query, (args.limit as number | undefined) ?? 1000);
      return { query, row_count: rows.length, truncated, rows: rows.map(r => flattenRow(r)) };
    },
  },
  {
    name: 'ads_query',
    title: 'Run a GAQL query',
    description: 'Run a complete GAQL query string (SELECT … FROM … WHERE … ORDER BY … LIMIT …) against one client account. Read-only. Returns flattened rows; money fields are micros. Look up fields with ads_get_resource_metadata first.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { account: ACCOUNT, query: z.string().min(10).max(20_000), maxRows: z.number().int().min(1).max(MAX_ROWS).optional() },
    handler: async (ctx, args) => {
      const acc = account(ctx, args.account);
      const { rows, truncated } = await searchGaql(callContext(acc), acc.customer_id, String(args.query), (args.maxRows as number | undefined) ?? 1000);
      return { row_count: rows.length, truncated, rows: rows.map(r => flattenRow(r)) };
    },
  },
  {
    name: 'ads_get_resource_metadata',
    title: 'Get GAQL resource metadata',
    description: 'The selectable, filterable and sortable fields for a resource (e.g. campaign, ad_group, search_term_view), including compatible metrics.* and segments.* fields. Use before building a query; results are cached.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { resource: z.string(), account: ACCOUNT.optional() },
    handler: async (ctx, args) => {
      const ctxCall = args.account ? callContext(account(ctx, args.account)) : { googleAccountId: connection(ctx).id };
      return getResourceMetadata(ctxCall, String(args.resource));
    },
  },

  // Insight
  {
    name: 'ads_account_overview',
    title: 'Account overview',
    description: 'KPIs for the last N complete days (default 30) vs the previous N days, a daily series, every campaign with budget, spend, conversions, CPA/ROAS and impression share lost to budget/rank, plus monthly budget pacing.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { account: ACCOUNT, days: z.number().int().min(1).max(365).optional(), fresh: z.boolean().optional() },
    handler: (ctx, args) => accountOverview(account(ctx, args.account), (args.days as number | undefined) ?? 30, { fresh: !!args.fresh }),
  },
  {
    name: 'ads_budget_pacing',
    title: 'Budget pacing',
    description: 'Month-to-date spend vs the client\'s monthly budget, projected month spend with the enabled daily budgets, and the recommended total daily budget to spend the rest of the budget evenly.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { account: ACCOUNT },
    handler: (ctx, args) => budgetPacing(account(ctx, args.account)),
  },
  {
    name: 'ads_audit_account',
    title: 'Audit an account',
    description: 'Structured health check: conversion tracking, pacing, campaigns limited by budget or rank, wasted search terms, low Quality Score keywords, ad policy problems, ad groups without ads, weak ad strength, optimisation score. Findings are ordered by severity with evidence and suggested actions.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { account: ACCOUNT },
    handler: (ctx, args) => auditAccount(account(ctx, args.account)),
  },
  {
    name: 'ads_search_terms',
    title: 'Search terms report',
    description: 'Search terms that triggered ads in the last N days (default 30) with cost, clicks and conversions — the main source for negative keywords and new keyword ideas.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: {
      account: ACCOUNT, days: z.number().int().min(1).max(90).optional(), minCost: z.number().min(0).optional(),
      withoutConversionsOnly: z.boolean().optional(), limit: z.number().int().min(1).max(1000).optional(),
    },
    handler: (ctx, args) => searchTerms(account(ctx, args.account), {
      days: args.days as number | undefined, minCost: args.minCost as number | undefined,
      withoutConversionsOnly: !!args.withoutConversionsOnly, limit: args.limit as number | undefined,
    }),
  },
  {
    name: 'ads_list_recommendations',
    title: 'List Google recommendations',
    description: 'Google\'s open recommendations for the account with their estimated impact. Treat them as suggestions: many raise spend or broaden matching.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { account: ACCOUNT, limit: z.number().int().min(1).max(500).optional() },
    handler: async (ctx, args) => ({ recommendations: await listRecommendations(account(ctx, args.account), (args.limit as number | undefined) ?? 100) }),
  },
  {
    name: 'ads_keyword_ideas',
    title: 'Keyword ideas',
    description: 'Keyword Planner ideas with average monthly searches, competition and top-of-page bid ranges, from seed keywords and/or a URL (e.g. a competitor or landing page). Needs Basic API access — Explorer access excludes planning services.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: {
      account: ACCOUNT,
      keywords: z.array(z.string()).max(20).optional(),
      url: z.string().url().optional(),
      locationIds: z.array(z.string()).max(20).optional().describe('Geo target constant IDs, e.g. 2826 = United Kingdom (find with ads_find_locations).'),
      languageId: z.string().optional().describe('Language constant ID, e.g. 1000 = English.'),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    handler: async (ctx, args) => {
      const acc = account(ctx, args.account);
      return { ideas: await generateKeywordIdeas(callContext(acc), acc.customer_id, { keywords: args.keywords as string[] | undefined, url: args.url as string | undefined, geoTargetIds: args.locationIds as string[] | undefined, languageId: args.languageId as string | undefined, limit: args.limit as number | undefined }) };
    },
  },
  {
    name: 'ads_find_locations',
    title: 'Find location targets',
    description: 'Find geo target constant IDs by place name (countries, regions, cities) for campaign targeting and keyword ideas.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { account: ACCOUNT, names: z.array(z.string()).min(1).max(25), countryCode: z.string().length(2).optional() },
    handler: async (ctx, args) => {
      const acc = account(ctx, args.account);
      return { locations: await suggestLocations(callContext(acc), args.names as string[], args.countryCode as string | undefined) };
    },
  },
  {
    name: 'ads_list_changes',
    title: 'List changes',
    description: 'Change history and pending plans for your clients: what was applied, what waits for approval, what was rejected or failed.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: {
      account: ACCOUNT.optional(),
      status: z.enum(['pending', 'needs_approval', 'blocked', 'applying', 'applied', 'rejected', 'failed', 'expired']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    handler: (ctx, args) => {
      const acc = args.account ? account(ctx, args.account) : null;
      const changes = listChanges({ workspaceIds: acc ? [acc.workspace_id] : ctx.workspaceIds, adsAccountId: acc?.id, status: args.status as ChangeStatus | undefined, limit: (args.limit as number | undefined) ?? 50 });
      return { changes: changes.map(c => ({ ...presentChange(ctx, c), account_id: c.ads_account_id, created_at: c.created_at, applied_at: c.applied_at, source: c.source, rationale: c.rationale })) };
    },
  },
  {
    name: 'ads_get_routine_history',
    title: 'Routine history',
    description: 'Notes from previous AI routine runs (summary, findings, actions, market notes, next steps), newest first.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { account: ACCOUNT.optional(), limit: z.number().int().min(1).max(50).optional() },
    handler: (ctx, args) => {
      const acc = args.account ? account(ctx, args.account) : null;
      return { runs: listRoutineRuns({ workspaceIds: acc ? [acc.workspace_id] : ctx.workspaceIds, adsAccountId: acc?.id, limit: (args.limit as number | undefined) ?? 10 }) };
    },
  },

  // Changes
  {
    name: 'ads_set_status',
    title: 'Pause, enable or remove',
    description: 'Pause or enable campaigns, ad groups, ads or keywords, or remove them (REMOVED is permanent and needs approval unless the client allows removals). ids: numeric ids for campaigns/ad groups; "adGroupId~adId" for ads; "adGroupId~criterionId" for keywords; "campaignId~criterionId" for campaign criteria; or full resource names.',
    scope: 'ads:write',
    annotations: WRITE,
    inputShape: {
      account: ACCOUNT,
      entity: z.enum(['campaign', 'ad_group', 'ad_group_ad', 'ad_group_criterion', 'campaign_criterion', 'asset_group']),
      ids: z.array(z.string()).min(1).max(500),
      status: z.enum(['ENABLED', 'PAUSED', 'REMOVED']),
      rationale: RATIONALE,
    },
    handler: async (ctx, args) => {
      const acc = writableAccount(ctx, args.account);
      const kind = args.entity as EntityKind;
      const ids = args.ids as string[];
      const ops = statusOperations(acc.customer_id, kind, ids, args.status as 'ENABLED' | 'PAUSED' | 'REMOVED');
      const names = ids.map(id => resourceName(acc.customer_id, kind, id));
      const statuses = args.status === 'REMOVED' ? {} : await currentStatuses(acc, kind, names);
      const verb = args.status === 'REMOVED' ? 'Remove' : args.status === 'PAUSED' ? 'Pause' : 'Enable';
      return propose(ctx, acc, 'set_status', `${verb} ${ids.length} ${kind.replaceAll('_', ' ')}${ids.length === 1 ? '' : 's'}`, args.rationale, ops, { statuses });
    },
  },
  {
    name: 'ads_update_budget',
    title: 'Change a daily budget',
    description: 'Set a campaign\'s daily budget (in the account currency, e.g. 45.50). Pass campaignId (its budget is looked up) or budgetId. Guardrails check the size of the increase and the projected month spend against the monthly budget.',
    scope: 'ads:write',
    annotations: WRITE,
    inputShape: {
      account: ACCOUNT,
      campaignId: z.string().optional(),
      budgetId: z.string().optional(),
      dailyBudget: z.number().positive(),
      rationale: RATIONALE,
    },
    handler: async (ctx, args) => {
      const acc = writableAccount(ctx, args.account);
      let budget = args.budgetId ? String(args.budgetId) : null;
      let note = '';
      if (!budget) {
        if (!args.campaignId) throw new AdsApiError('Pass campaignId or budgetId.', 'INVALID_REQUEST');
        const campaign = resourceName(acc.customer_id, 'campaign', String(args.campaignId));
        const { rows } = await searchGaql(callContext(acc), acc.customer_id, `SELECT campaign.name, campaign_budget.resource_name, campaign_budget.explicitly_shared, campaign_budget.amount_micros
          FROM campaign WHERE campaign.resource_name = '${campaign}'`, 1);
        const b = rows[0]?.campaignBudget as Record<string, unknown> | undefined;
        if (!b?.resourceName) throw new AdsApiError(`Campaign ${args.campaignId} not found.`, 'NOT_FOUND');
        budget = String(b.resourceName);
        note = `${(rows[0].campaign as Record<string, unknown>).name}: ${microsToUnits(b.amountMicros)} → ${args.dailyBudget}/day${b.explicitlyShared ? ' (shared budget — affects every campaign using it)' : ''}`;
      }
      const op = budgetAmountOperation(acc.customer_id, budget, Number(args.dailyBudget));
      return propose(ctx, acc, 'update_budget', note || `Set budget ${budget} to ${args.dailyBudget}/day`, args.rationale, [op]);
    },
  },
  {
    name: 'ads_update_bids',
    title: 'Change bids',
    description: 'Change manual CPC bids on keywords (id "adGroupId~criterionId") and/or ad groups (default bid). Amounts are in the account currency. Guardrails limit the percentage change per bid.',
    scope: 'ads:write',
    annotations: WRITE,
    inputShape: {
      account: ACCOUNT,
      keywordBids: z.array(z.object({ id: z.string(), cpcBid: z.number().positive() })).max(500).optional(),
      adGroupBids: z.array(z.object({ id: z.string(), cpcBid: z.number().positive() })).max(500).optional(),
      rationale: RATIONALE,
    },
    handler: async (ctx, args) => {
      const acc = writableAccount(ctx, args.account);
      const kw = (args.keywordBids as Array<{ id: string; cpcBid: number }> | undefined) ?? [];
      const ag = (args.adGroupBids as Array<{ id: string; cpcBid: number }> | undefined) ?? [];
      if (!kw.length && !ag.length) throw new AdsApiError('Pass keywordBids and/or adGroupBids.', 'INVALID_REQUEST');
      const ops = [...kw.map(b => keywordBidOperation(acc.customer_id, b.id, b.cpcBid)), ...ag.map(b => adGroupBidOperation(acc.customer_id, b.id, b.cpcBid))];
      return propose(ctx, acc, 'update_bids', `Change ${kw.length} keyword and ${ag.length} ad group bid(s)`, args.rationale, ops);
    },
  },
  {
    name: 'ads_add_keywords',
    title: 'Add keywords',
    description: 'Add keywords to an ad group (match type EXACT, PHRASE or BROAD; default PHRASE; optional CPC bid for manual bidding).',
    scope: 'ads:write',
    annotations: WRITE,
    inputShape: { account: ACCOUNT, adGroupId: z.string(), keywords: KEYWORDS, rationale: RATIONALE },
    handler: async (ctx, args) => {
      const acc = writableAccount(ctx, args.account);
      const ops = addKeywordOperations(acc.customer_id, String(args.adGroupId), args.keywords as Array<{ text: string }>);
      return propose(ctx, acc, 'add_keywords', `Add ${ops.length} keyword(s) to ad group ${args.adGroupId}`, args.rationale, ops);
    },
  },
  {
    name: 'ads_add_negative_keywords',
    title: 'Add negative keywords',
    description: 'Add negative keywords at campaign level, ad group level, or to a shared negative keyword list (shared_set). Use phrase or exact match for precise exclusions.',
    scope: 'ads:write',
    annotations: WRITE,
    inputShape: {
      account: ACCOUNT,
      level: z.enum(['campaign', 'ad_group', 'shared_set']),
      id: z.string().describe('Campaign id, ad group id or shared set id, depending on level.'),
      keywords: KEYWORDS,
      rationale: RATIONALE,
    },
    handler: async (ctx, args) => {
      const acc = writableAccount(ctx, args.account);
      const kws = args.keywords as Array<{ text: string; matchType?: 'EXACT' | 'PHRASE' | 'BROAD' }>;
      const ops = args.level === 'campaign' ? campaignNegativeOperations(acc.customer_id, String(args.id), kws)
        : args.level === 'ad_group' ? addKeywordOperations(acc.customer_id, String(args.id), kws, { negative: true })
          : sharedSetNegativeOperations(acc.customer_id, String(args.id), kws);
      return propose(ctx, acc, 'add_negatives', `Add ${ops.length} negative keyword(s) to ${String(args.level).replace('_', ' ')} ${args.id}`, args.rationale, ops);
    },
  },
  {
    name: 'ads_create_responsive_search_ad',
    title: 'Create a responsive search ad',
    description: 'Create a responsive search ad in an ad group: 3–15 headlines (≤30 characters), 2–4 descriptions (≤90 characters), optional display paths (≤15 characters) and pins. Created PAUSED by default so it can be reviewed.',
    scope: 'ads:write',
    annotations: WRITE,
    inputShape: {
      account: ACCOUNT,
      adGroupId: z.string(),
      finalUrl: z.string().url(),
      headlines: z.array(z.union([z.string(), z.object({ text: z.string(), pin: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() })])).min(3).max(15),
      descriptions: z.array(z.union([z.string(), z.object({ text: z.string(), pin: z.union([z.literal(1), z.literal(2)]).optional() })])).min(2).max(4),
      path1: z.string().max(15).optional(),
      path2: z.string().max(15).optional(),
      status: z.enum(['ENABLED', 'PAUSED']).optional(),
      rationale: RATIONALE,
    },
    handler: async (ctx, args) => {
      const acc = writableAccount(ctx, args.account);
      const op = responsiveSearchAdOperation(acc.customer_id, String(args.adGroupId), {
        finalUrl: String(args.finalUrl), headlines: args.headlines as never, descriptions: args.descriptions as never,
        path1: args.path1 as string | undefined, path2: args.path2 as string | undefined, status: (args.status as 'ENABLED' | 'PAUSED' | undefined) ?? 'PAUSED',
      });
      return propose(ctx, acc, 'create_ad', `Create a ${((args.status as string) ?? 'PAUSED').toLowerCase()} responsive search ad in ad group ${args.adGroupId}`, args.rationale, [op]);
    },
  },
  {
    name: 'ads_update_bidding_strategy',
    title: 'Change a bid strategy',
    description: 'Switch a campaign\'s bid strategy (MAXIMIZE_CONVERSIONS with optional target CPA, MAXIMIZE_CONVERSION_VALUE with optional target ROAS e.g. 4.0 = 400%, TARGET_SPEND = maximise clicks with optional max CPC, MANUAL_CPC) or change its target. Needs approval unless the client allows bidding changes.',
    scope: 'ads:write',
    annotations: WRITE,
    inputShape: {
      account: ACCOUNT, campaignId: z.string(),
      strategy: z.enum(['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_SPEND', 'MANUAL_CPC']),
      targetCpa: z.number().positive().optional(), targetRoas: z.number().positive().optional(), maxCpc: z.number().positive().optional(),
      rationale: RATIONALE,
    },
    handler: async (ctx, args) => {
      const acc = writableAccount(ctx, args.account);
      const op = campaignBiddingOperation(acc.customer_id, String(args.campaignId), args.strategy as 'MANUAL_CPC', {
        targetCpa: args.targetCpa as number | undefined, targetRoas: args.targetRoas as number | undefined, maxCpc: args.maxCpc as number | undefined,
      });
      return propose(ctx, acc, 'update_bidding', `Set campaign ${args.campaignId} to ${args.strategy}${args.targetCpa ? ` (target CPA ${args.targetCpa})` : ''}${args.targetRoas ? ` (target ROAS ${args.targetRoas})` : ''}`, args.rationale, [op]);
    },
  },
  {
    name: 'ads_create_search_campaign',
    title: 'Create a search campaign',
    description: 'Build a complete Search campaign in one atomic change: budget, PAUSED campaign (Google Search only, presence-based location targeting), locations, languages, campaign negatives, one ad group, keywords and an optional responsive search ad. Find location IDs with ads_find_locations (2826 = UK, 2840 = US); language 1000 = English.',
    scope: 'ads:write',
    annotations: WRITE,
    inputShape: {
      account: ACCOUNT,
      name: z.string().min(1).max(255),
      dailyBudget: z.number().positive(),
      biddingStrategy: z.enum(['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_SPEND', 'MANUAL_CPC']),
      targetCpa: z.number().positive().optional(), targetRoas: z.number().positive().optional(), maxCpc: z.number().positive().optional(),
      locationIds: z.array(z.string()).max(100).optional(),
      languageIds: z.array(z.string()).max(20).optional(),
      adGroupName: z.string().max(255).optional(),
      defaultCpcBid: z.number().positive().optional(),
      keywords: KEYWORDS.optional(),
      negativeKeywords: KEYWORDS.optional(),
      ad: z.object({
        finalUrl: z.string().url(),
        headlines: z.array(z.string()).min(3).max(15),
        descriptions: z.array(z.string()).min(2).max(4),
        path1: z.string().max(15).optional(),
        path2: z.string().max(15).optional(),
      }).optional(),
      rationale: RATIONALE,
    },
    handler: async (ctx, args) => {
      const acc = writableAccount(ctx, args.account);
      const ops = searchCampaignOperations(acc.customer_id, {
        name: String(args.name), dailyBudget: Number(args.dailyBudget), biddingStrategy: args.biddingStrategy as 'MANUAL_CPC',
        targetCpa: args.targetCpa as number | undefined, targetRoas: args.targetRoas as number | undefined, maxCpc: args.maxCpc as number | undefined,
        locationIds: args.locationIds as string[] | undefined, languageIds: args.languageIds as string[] | undefined,
        adGroupName: args.adGroupName as string | undefined, defaultCpcBid: args.defaultCpcBid as number | undefined,
        keywords: args.keywords as never, negativeKeywords: args.negativeKeywords as never, ad: args.ad as never,
      });
      return propose(ctx, acc, 'create_campaign', `Create paused search campaign "${args.name}" (${args.dailyBudget}/day)`, args.rationale, ops);
    },
  },
  {
    name: 'ads_mutate',
    title: 'Advanced: any Google Ads change',
    description: 'Send any GoogleAdsService.Mutate operations (REST JSON, e.g. [{"campaignOperation":{"update":{"resourceName":"customers/123/campaigns/456","status":"PAUSED"},"updateMask":"status"}}]) for changes the other tools don\'t cover: assets, sitelinks, ad schedules, bid modifiers, audiences, labels, experiments and more. Temporary negative ids link resources created together. Same validation and guardrails as every other change.',
    scope: 'ads:write',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputShape: {
      account: ACCOUNT,
      operations: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
      summary: z.string().min(5).max(300).describe('One line describing the change for the change log.'),
      rationale: RATIONALE,
    },
    handler: async (ctx, args) => {
      const acc = writableAccount(ctx, args.account);
      return propose(ctx, acc, 'mutate', String(args.summary), args.rationale, args.operations as Operation[]);
    },
  },
  {
    name: 'ads_recommendations',
    title: 'Apply or dismiss recommendations',
    description: 'Apply or dismiss Google recommendations by resource name (from ads_list_recommendations). Applying budget, bidding or broad-match recommendations needs approval unless the client auto-approves changes.',
    scope: 'ads:write',
    annotations: WRITE,
    inputShape: { account: ACCOUNT, action: z.enum(['apply', 'dismiss']), resourceNames: z.array(z.string()).min(1).max(100), rationale: RATIONALE },
    handler: async (ctx, args) => {
      const acc = writableAccount(ctx, args.account);
      const change = await proposeRecommendations({ account: acc, userId: ctx.user.id, source: 'mcp', action: args.action as 'apply' | 'dismiss', resourceNames: args.resourceNames as string[], rationale: String(args.rationale) });
      return presentChange(ctx, change);
    },
  },
  {
    name: 'ads_apply_change',
    title: 'Apply a change',
    description: 'Apply a change plan whose status is "pending". The guardrails are re-checked against the account\'s current state first; if the change now needs approval it is left for a person.',
    scope: 'ads:write',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputShape: { changeId: z.string() },
    handler: async (ctx, args) => {
      const existing = getChange(String(args.changeId));
      if (!existing || !ctx.workspaceIds.includes(existing.workspace_id)) throw new AdsApiError('Change not found.', 'NOT_FOUND');
      const acc = getAdsAccount(existing.ads_account_id);
      if (!acc) throw new AdsApiError('The ad account for this change is no longer linked.', 'NOT_FOUND');
      assertCanChangeAds(ctx.user, acc.workspace_id);
      const applied = await applyChange(existing.id, { userId: ctx.user.id, approvedByPerson: false });
      return presentChange(ctx, applied);
    },
  },
  {
    name: 'ads_revert_change',
    title: 'Revert a change',
    description: 'Propose the opposite of an applied change (restores previous budgets, bids and statuses, removes things it created). Returns a new change plan that follows the normal guardrails.',
    scope: 'ads:write',
    annotations: WRITE,
    inputShape: { changeId: z.string(), },
    handler: async (ctx, args) => {
      const existing = getChange(String(args.changeId));
      if (!existing || !ctx.workspaceIds.includes(existing.workspace_id)) throw new AdsApiError('Change not found.', 'NOT_FOUND');
      const acc = getAdsAccount(existing.ads_account_id);
      if (!acc) throw new AdsApiError('The ad account for this change is no longer linked.', 'NOT_FOUND');
      assertCanChangeAds(ctx.user, acc.workspace_id);
      return presentChange(ctx, await revertChange(existing.id, { userId: ctx.user.id, source: 'mcp' }));
    },
  },
  {
    name: 'ads_record_routine_run',
    title: 'Record a routine run',
    description: 'Log what this routine run did for a client: summary, findings, actions (include change ids), market and competitor notes, and next steps. Shown on the dashboard and returned by ads_get_client_brief next time.',
    scope: 'ads:write',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputShape: {
      account: ACCOUNT,
      summary: z.string().min(10).max(8000),
      findings: z.array(z.string()).max(50).optional(),
      actions: z.array(z.string()).max(50).optional(),
      nextSteps: z.array(z.string()).max(50).optional(),
      marketNotes: z.string().max(8000).optional(),
    },
    handler: (ctx, args) => {
      const acc = account(ctx, args.account);
      return recordRoutineRun({
        workspaceId: acc.workspace_id, adsAccountId: acc.id, userId: ctx.user.id, summary: String(args.summary),
        findings: args.findings, actions: args.actions, nextSteps: args.nextSteps, marketNotes: args.marketNotes as string | undefined,
      });
    },
  },
];
