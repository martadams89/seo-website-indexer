/**
 * mcp/tools.ts — the MCP tool surface.
 *
 * Every tool runs in a per-token context (the owning user + the workspaces they
 * can reach + the granted scopes). Read tools need `mcp:read`; action tools need
 * `mcp:write`. Site-scoped tools resolve the site strictly against the caller's
 * accessible workspaces, so a token can never read or touch another tenant.
 *
 * Tool definitions are exported so both the live MCP server and the tests share
 * one registry — the tests exercise the handlers directly, no transport needed.
 */
import { z, type ZodRawShape } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getSitesForWorkspace, getGoogleAccountById, getRecentRuns, getRecentLogs,
  getAllUrlFailures, getQuotaUsage, todayKey, type Site,
} from '../db/database.js';
import { getUserById, type User } from '../auth/users.js';
import { accessibleWorkspaces, canAccessSiteInWorkspace, canEditWorkspace, hasCapability, workspaceRole } from '../auth/workspaces.js';
import { inspectGoogleUrl } from '../indexer/google.js';
import { getGooglePerformance, getGoogleDimension } from '../indexer/performance.js';
import { checkSiteHygiene } from '../indexer/hygiene.js';
import { checkAgentReadiness } from '../indexer/agent-readiness.js';
import { publishUrlUpdated, indexingQuotaBucket } from '../indexer/google-indexing.js';
import { GOOGLE_INDEXING_CAPABILITIES, recordRequestOutcomes, siteRequestCandidates, type RequestOutcome } from '../indexer/request-indexing.js';
import { snapshotSitePerformance, getWowDeltas, addTrackedQuery, listTrackedQueries, removeTrackedQuery } from '../analytics/perf-store.js';
import { comparePeriods, type CompareDimension } from '../analytics/compare.js';
import { contentGroupPerformance, deleteContentGroup, saveContentGroup } from '../analytics/content-groups.js';
import { getOpportunity, getPlaybook, setOpportunityStatus, type StoredOpportunity } from '../analytics/playbook.js';
import { getAlerts } from '../analytics/stats.js';
import { getResults } from '../ai/citations.js';
import { runIndexing, isRunning } from '../scheduler.js';
import { type McpScope, type McpTokenAuth } from './tokens.js';
import { ADS_TOOLS } from './ads-tools.js';
import { GA4_TOOLS } from './ga4-tools.js';
import { REVIEWS_TOOLS } from './reviews-tools.js';
import { BUSINESS_TOOLS } from './business-tools.js';

export interface McpContext {
  user: User;
  scopes: McpScope[];
  /** Ids of every workspace the user can reach — the tenant fence for all tools. */
  workspaceIds: string[];
  /** Public origin of this install, for links back to the dashboard. */
  origin?: string;
}

/** Resolve an authenticated token into a usable context, or null if the user is gone. */
export function buildContext(auth: McpTokenAuth, origin?: string): McpContext | null {
  const user = getUserById(auth.userId);
  if (!user || user.disabled) return null;
  return { user, scopes: auth.scopes, workspaceIds: accessibleWorkspaces(user).map(w => w.id), origin };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A site the caller can reach, or throw a clean not-found (never leak existence). */
function requireSite(ctx: McpContext, siteId: string): Site {
  for (const ws of ctx.workspaceIds) {
    if (canAccessSiteInWorkspace(ctx.user, siteId, ws)) {
      const site = getSitesForWorkspace(ws).find(s => s.id === siteId);
      if (site) return site;
    }
  }
  throw new Error(`Site "${siteId}" not found or not accessible with this token.`);
}

/**
 * A site the caller may act on: the token's scope is not enough on its own —
 * the user must also be allowed to manage sites in that workspace, exactly as
 * in the dashboard (viewers stay read-only even with an mcp:write token).
 */
function requireWritableSite(ctx: McpContext, siteId: string): Site {
  const site = requireSite(ctx, siteId);
  const ws = site.workspace_id;
  if (!ws || !canEditWorkspace(ctx.user, ws) || !hasCapability(ctx.user, ws, 'manage_sites')) {
    throw new Error('You have read-only access to this site\'s workspace.');
  }
  return site;
}

/** Project a Site to fields safe to hand an AI assistant (no FTP/deploy secrets). */
function publicSite(site: Site) {
  return {
    id: site.id,
    name: site.name,
    domain: site.domain,
    gsc_url: site.gsc_url,
    sitemap_url: site.sitemap_url,
    enabled: !!site.enabled,
    workspace_id: site.workspace_id ?? null,
    google_account_id: site.google_account_id ?? null,
    google_indexing_api: !!site.google_indexing_api,
    robots_txt_status: site.robots_txt_status ?? null,
    llms_txt_status: site.llms_txt_status ?? null,
    created_at: site.created_at,
  };
}

function allAccessibleSites(ctx: McpContext): Site[] {
  const seen = new Map<string, Site>();
  for (const ws of ctx.workspaceIds) for (const s of getSitesForWorkspace(ws)) seen.set(s.id, s);
  return [...seen.values()];
}

// ── Tool registry ───────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: McpScope;
  inputShape: ZodRawShape;
  handler: (ctx: McpContext, args: Record<string, unknown>) => Promise<unknown> | unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

const DAYS = z.number().int().min(1).max(480).optional();

export const TOOLS: ToolDef[] = [
  {
    name: 'list_workspaces',
    title: 'List workspaces',
    description: 'List every workspace this token can access, with the caller\'s role in each.',
    scope: 'mcp:read',
    inputShape: {},
    handler: (ctx) => accessibleWorkspaces(ctx.user).map(w => ({ id: w.id, name: w.name, role: workspaceRole(ctx.user, w.id) })),
  },
  {
    name: 'list_sites',
    title: 'List sites',
    description: 'List all sites across the accessible workspaces. Optionally filter to one workspace or to enabled sites only.',
    scope: 'mcp:read',
    inputShape: { workspaceId: z.string().optional(), enabledOnly: z.boolean().optional() },
    handler: (ctx, args) => {
      let sites = allAccessibleSites(ctx);
      if (typeof args.workspaceId === 'string') sites = sites.filter(s => s.workspace_id === args.workspaceId);
      if (args.enabledOnly) sites = sites.filter(s => s.enabled);
      return sites.map(publicSite);
    },
  },
  {
    name: 'get_site',
    title: 'Get site',
    description: 'Get one site\'s configuration by id.',
    scope: 'mcp:read',
    inputShape: { siteId: z.string() },
    handler: (ctx, args) => publicSite(requireSite(ctx, String(args.siteId))),
  },
  {
    name: 'get_search_performance',
    title: 'Get Search Console performance',
    description: 'Google Search Console performance for a site over the last N days (default 28): totals, daily series, top queries and pages.',
    scope: 'mcp:read',
    inputShape: { siteId: z.string(), days: DAYS },
    handler: (ctx, args) => getGooglePerformance(requireSite(ctx, String(args.siteId)), Number(args.days ?? 28)),
  },
  {
    name: 'get_performance_by_dimension',
    title: 'Get performance by dimension',
    description: 'Search Console performance broken down by country, device or searchAppearance over the last N days (default 28).',
    scope: 'mcp:read',
    inputShape: {
      siteId: z.string(),
      dimension: z.enum(['country', 'device', 'searchAppearance']),
      days: DAYS,
    },
    handler: (ctx, args) => getGoogleDimension(requireSite(ctx, String(args.siteId)), Number(args.days ?? 28), args.dimension as 'country' | 'device' | 'searchAppearance'),
  },
  {
    name: 'get_week_over_week_deltas',
    title: 'Get week-over-week deltas',
    description: 'Week-over-week clicks/impressions/position movement for a site (engine: google or bing, default google).',
    scope: 'mcp:read',
    inputShape: { siteId: z.string(), engine: z.enum(['google', 'bing']).optional() },
    handler: (ctx, args) => getWowDeltas(requireSite(ctx, String(args.siteId)).id, (args.engine as 'google' | 'bing') ?? 'google'),
  },
  {
    name: 'inspect_url',
    title: 'Inspect a URL in Search Console',
    description: 'Run a live Google Search Console URL Inspection for a page: indexing state, coverage, last crawl, verdict.',
    scope: 'mcp:read',
    inputShape: { siteId: z.string(), url: z.string().url() },
    handler: (ctx, args) => {
      const site = requireSite(ctx, String(args.siteId));
      if (!site.google_account_id) throw new Error('No Google account linked to this site.');
      return inspectGoogleUrl(site.google_account_id, site.gsc_url, String(args.url));
    },
  },
  {
    name: 'get_indexing_quota',
    title: 'Get indexing API quota used today',
    description: 'How much of today\'s Google Indexing API daily quota (200 URLs/project) this site\'s linked account has spent.',
    scope: 'mcp:read',
    inputShape: { siteId: z.string() },
    handler: (ctx, args) => {
      const site = requireSite(ctx, String(args.siteId));
      if (!site.google_account_id) throw new Error('No Google account linked to this site.');
      const account = getGoogleAccountById(site.google_account_id);
      if (!account) throw new Error('Linked Google account not found.');
      const bucket = indexingQuotaBucket(account);
      const used = getQuotaUsage('indexing', bucket);
      return { day: todayKey(), account: account.email ?? account.id, used, limit: 200, remaining: Math.max(0, 200 - used) };
    },
  },
  {
    name: 'get_url_failures',
    title: 'Get recent URL submission failures',
    description: 'Recent URL submission failures (with backoff) across accessible sites, optionally filtered to one site.',
    scope: 'mcp:read',
    inputShape: { siteId: z.string().optional() },
    handler: (ctx, args) => {
      const ids = new Set(allAccessibleSites(ctx).map(s => s.id));
      return getAllUrlFailures().filter(f => ids.has(f.site_id) && (!args.siteId || f.site_id === args.siteId));
    },
  },
  {
    name: 'get_recent_runs',
    title: 'Get recent indexing runs',
    description: 'Recent indexing run history across accessible workspaces (newest first).',
    scope: 'mcp:read',
    inputShape: { limit: z.number().int().min(1).max(100).optional() },
    handler: (ctx, args) => {
      const limit = Number(args.limit ?? 20);
      const runs = ctx.workspaceIds.flatMap(ws => getRecentRuns(limit, ws));
      runs.sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
      return runs.slice(0, limit);
    },
  },
  {
    name: 'get_recent_logs',
    title: 'Get recent activity logs',
    description: 'Recent system/activity log lines across accessible workspaces.',
    scope: 'mcp:read',
    inputShape: { limit: z.number().int().min(1).max(200).optional() },
    handler: (ctx, args) => {
      const limit = Number(args.limit ?? 100);
      const logs = ctx.workspaceIds.flatMap(ws => getRecentLogs(limit, ws));
      return logs.slice(0, limit);
    },
  },
  {
    name: 'get_site_hygiene',
    title: 'Get site hygiene issues',
    description: 'Crawl a sample of the site and report technical SEO hygiene issues (titles, meta, canonicals, status codes, etc.).',
    scope: 'mcp:read',
    inputShape: { siteId: z.string(), limit: z.number().int().min(1).max(100).optional() },
    handler: (ctx, args) => checkSiteHygiene(requireSite(ctx, String(args.siteId)), Number(args.limit ?? 40)),
  },
  {
    name: 'get_agent_readiness',
    title: 'Get AI agent readiness',
    description: 'Audit how ready the site is for AI agents and answer engines (robots for AI, llms.txt, structured data, MCP card, etc.).',
    scope: 'mcp:read',
    inputShape: { siteId: z.string() },
    handler: (ctx, args) => checkAgentReadiness(requireSite(ctx, String(args.siteId))),
  },
  {
    name: 'get_indexing_request_queue',
    title: 'Get pages to request indexing for',
    description: 'Google has no API for Search Console\'s "Request indexing" button. This returns the site\'s pages most worth a manual request (not indexed but fixable, changed since Google\'s last crawl, or never inspected), each with its URL Inspection link, so a browser agent can request them in the person\'s signed-in Search Console. Pages requested in the past 7 days are left out. Also returns what Google\'s indexing APIs can and cannot do.',
    scope: 'mcp:read',
    inputShape: { siteId: z.string(), limit: z.number().int().min(1).max(100).optional() },
    handler: (ctx, args) => {
      const site = requireSite(ctx, String(args.siteId));
      return {
        site: site.name,
        property: site.gsc_url,
        daily_quota_note: 'Google does not publish the Request indexing quota; it is small (typically around 10 per property per day). Stop when Search Console says the quota is exceeded.',
        pages: siteRequestCandidates(site, Number(args.limit ?? 10)),
        capabilities: GOOGLE_INDEXING_CAPABILITIES,
      };
    },
  },
  {
    name: 'list_ai_citations',
    title: 'List AI citation results',
    description: 'Recent AI citation tracking results (whether AI assistants cite the site for tracked prompts) across accessible workspaces.',
    scope: 'mcp:read',
    inputShape: { workspaceId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    handler: (ctx, args) => {
      const limit = Number(args.limit ?? 50);
      const wss = args.workspaceId && ctx.workspaceIds.includes(String(args.workspaceId)) ? [String(args.workspaceId)] : ctx.workspaceIds;
      return wss.flatMap(ws => getResults(limit, ws)).slice(0, limit);
    },
  },

  // ── Actions (mcp:write) ──────────────────────────────────────────────────────
  {
    name: 'submit_urls_for_indexing',
    title: 'Submit URLs to the Google Indexing API',
    description: 'Notify Google (URL_UPDATED) for up to 50 specific URLs on a site via the Indexing API. Spends indexing quota. Requires the mcp:write scope.',
    scope: 'mcp:write',
    inputShape: { siteId: z.string(), urls: z.array(z.string().url()).min(1).max(50) },
    handler: async (ctx, args) => {
      const site = requireWritableSite(ctx, String(args.siteId));
      if (!site.google_account_id) throw new Error('No Google account linked to this site.');
      const urls = args.urls as string[];
      const results = [];
      for (const url of urls) {
        try {
          const r = await publishUrlUpdated(site.google_account_id, url);
          results.push({ ...r, url });
        } catch (e) {
          results.push({ url, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { submitted: results.length, results };
    },
  },
  {
    name: 'record_indexing_requests',
    title: 'Record Request indexing results',
    description: 'After requesting indexing in Search Console (by a person or a browser agent), record the outcome for each page so the queue skips recent requests. Requires the mcp:write scope.',
    scope: 'mcp:write',
    inputShape: {
      siteId: z.string(),
      results: z.array(z.object({
        url: z.string().url(),
        outcome: z.enum(['requested', 'already_indexed', 'quota_exceeded', 'not_allowed', 'error']),
        note: z.string().max(200).optional(),
      })).min(1).max(100),
    },
    handler: (ctx, args) => {
      const site = requireWritableSite(ctx, String(args.siteId));
      const results = args.results as Array<{ url: string; outcome: RequestOutcome; note?: string }>;
      return { updated: recordRequestOutcomes(site.id, results) };
    },
  },
  {
    name: 'trigger_indexing_run',
    title: 'Trigger an indexing run',
    description: 'Start a manual indexing run for one site (discovers and submits changed URLs). Fails if a run is already in progress for that workspace. Requires the mcp:write scope.',
    scope: 'mcp:write',
    inputShape: { siteId: z.string() },
    handler: async (ctx, args) => {
      const site = requireWritableSite(ctx, String(args.siteId));
      const ws = site.workspace_id ?? undefined;
      if (isRunning(ws)) throw new Error('A run is already in progress for this workspace.');
      const runId = await runIndexing({ trigger: 'manual', workspaceId: ws, siteIds: [site.id] });
      return { ok: true, runId, siteId: site.id };
    },
  },
  {
    name: 'refresh_performance_snapshot',
    title: 'Refresh performance snapshot',
    description: 'Pull a fresh Search Console performance snapshot for a site and store it (updates trends and deltas). Requires the mcp:write scope.',
    scope: 'mcp:write',
    inputShape: { siteId: z.string() },
    handler: async (ctx, args) => {
      const site = requireWritableSite(ctx, String(args.siteId));
      await snapshotSitePerformance(site);
      return { ok: true, siteId: site.id, snapshotAt: new Date().toISOString() };
    },
  },
  {
    name: 'get_playbook',
    title: 'Get the ranking playbook',
    description: 'Ranked SEO opportunities for a site from its Search Console data: striking-distance queries (positions 4–20), CTR gaps and regressions, cannibalisation (two pages competing for the same queries) and content decay. Each comes with an estimated monthly-click range, effort, confidence, evidence and steps. Also returns blockers (indexing problems to fix first) and measured results of opportunities marked done.',
    scope: 'mcp:read',
    inputShape: {
      siteId: z.string(),
      kind: z.enum(['striking_distance', 'ctr_gap', 'cannibalisation', 'content_decay']).optional(),
      status: z.enum(['open', 'dismissed', 'done']).optional().describe('Default open.'),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (ctx, args) => {
      const site = requireSite(ctx, String(args.siteId));
      const playbook = getPlaybook(site.id);
      if (!playbook) throw new Error('Site not found.');
      const status = (args.status as string | undefined) ?? 'open';
      const opportunities = (status === 'done' ? playbook.results : playbook.opportunities
        .filter((o: StoredOpportunity) => o.status === status && (!args.kind || o.kind === args.kind))
        .slice(0, (args.limit as number | undefined) ?? 25)
        .map((o: StoredOpportunity) => ({
          id: o.id, kind: o.kind, subtype: o.subtype, page: o.page, competing_page: o.secondary_page, headline: o.headline,
          monthly_clicks_estimate: { low: o.low, high: o.high }, effort: o.effort, confidence: o.confidence, steps: o.steps, evidence: o.evidence,
        })));
      return {
        site: playbook.site, computed_at: playbook.computedAt, summary: playbook.summary, blockers: playbook.blockers,
        opportunities, methodology: playbook.methodology,
        ...(playbook.computedAt ? {} : { note: 'No playbook has been computed for this site yet. It is built after Search Console data syncs (or with Refresh on the Playbook page).' }),
      };
    },
  },
  {
    name: 'get_playbook_opportunity',
    title: 'Get one playbook opportunity',
    description: 'Full detail for one opportunity from get_playbook, including evidence, steps and any saved draft (titles, descriptions, briefs).',
    scope: 'mcp:read',
    inputShape: { siteId: z.string(), opportunityId: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (ctx, args) => {
      const site = requireSite(ctx, String(args.siteId));
      const o = getOpportunity(site.id, String(args.opportunityId));
      if (!o) throw new Error('Opportunity not found.');
      return o;
    },
  },
  {
    name: 'set_playbook_opportunity_status',
    title: 'Mark a playbook opportunity done or dismissed',
    description: 'Mark an opportunity done (after the change is live — the app then measures the real effect about a month later), dismissed, or open again. Requires the mcp:write scope.',
    scope: 'mcp:write',
    inputShape: { siteId: z.string(), opportunityId: z.string(), status: z.enum(['open', 'dismissed', 'done']) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (ctx, args) => {
      const site = requireWritableSite(ctx, String(args.siteId));
      const o = setOpportunityStatus(site, String(args.opportunityId), args.status as 'open' | 'dismissed' | 'done');
      if (!o) throw new Error('Opportunity not found.');
      return { id: o.id, status: o.status, done_at: o.done_at };
    },
  },
  {
    name: 'compare_periods',
    title: 'Compare search performance between periods',
    description: 'Compare a site\'s Google Search Console performance for a period (the last N days, or start/end dates) with the period before or the same period last year: total clicks, impressions, CTR and position, plus the queries, pages, countries or devices that gained and lost the most clicks, and how many are new or lost.',
    scope: 'mcp:read',
    inputShape: {
      siteId: z.string(),
      days: z.number().int().min(1).max(480).optional().describe('Last N complete days (default 28). Ignored when start and end are given.'),
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      compareTo: z.enum(['previous', 'year']).optional().describe('previous (default) or year (same dates last year).'),
      dimension: z.enum(['query', 'page', 'country', 'device']).optional(),
      limit: z.number().int().min(5).max(200).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: (ctx, args) => comparePeriods(requireSite(ctx, String(args.siteId)), {
      days: args.days as number | undefined, start: args.start as string | undefined, end: args.end as string | undefined,
      mode: args.compareTo as 'previous' | 'year' | undefined, dimension: args.dimension as CompareDimension | undefined, limit: args.limit as number | undefined,
    }),
  },
  {
    name: 'list_content_groups',
    title: 'Content group performance',
    description: 'A site\'s content groups (pages grouped by URL rules, e.g. blog, services, locations) with clicks, impressions, CTR and position for the last N days vs the period before, top pages per group, and the ungrouped remainder.',
    scope: 'mcp:read',
    inputShape: { siteId: z.string(), days: z.number().int().min(1).max(240).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (ctx, args) => contentGroupPerformance(requireSite(ctx, String(args.siteId)).id, (args.days as number | undefined) ?? 28),
  },
  {
    name: 'save_content_group',
    title: 'Create or update a content group',
    description: 'Group a site\'s pages by URL rules. A page belongs when it matches any include rule and no exclude rule. Rule values starting with "/" match the URL path; otherwise the full URL. Saving with an existing name (or id) updates that group. Requires mcp:write.',
    scope: 'mcp:write',
    inputShape: {
      siteId: z.string(),
      name: z.string().min(1).max(100),
      include: z.array(z.object({ match: z.enum(['prefix', 'contains', 'exact', 'regex']), value: z.string().min(1).max(300) })).min(1),
      exclude: z.array(z.object({ match: z.enum(['prefix', 'contains', 'exact', 'regex']), value: z.string().min(1).max(300) })).optional(),
      id: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (ctx, args) => saveContentGroup(requireWritableSite(ctx, String(args.siteId)).id, { id: args.id as string | undefined, name: String(args.name), include: args.include, exclude: args.exclude, userId: ctx.user.id }),
  },
  {
    name: 'delete_content_group',
    title: 'Delete a content group',
    description: 'Delete one of a site\'s content groups (only the grouping; no page or Search Console data is removed). Requires mcp:write.',
    scope: 'mcp:write',
    inputShape: { siteId: z.string(), groupId: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    handler: (ctx, args) => {
      const ok = deleteContentGroup(requireWritableSite(ctx, String(args.siteId)).id, String(args.groupId));
      if (!ok) throw new Error('Content group not found.');
      return { ok };
    },
  },
  {
    name: 'list_tracked_queries',
    title: 'List tracked keywords',
    description: 'Search queries tracked for a site, with their last recorded Google position (from Search Console). Position drops raise alerts.',
    scope: 'mcp:read',
    inputShape: { siteId: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (ctx, args) => ({ tracked: listTrackedQueries(requireSite(ctx, String(args.siteId)).id) }),
  },
  {
    name: 'track_query',
    title: 'Track or untrack a keyword',
    description: 'Start (or stop) tracking a search query\'s Google position for a site. Requires mcp:write.',
    scope: 'mcp:write',
    inputShape: { siteId: z.string(), query: z.string().min(1).max(200), track: z.boolean().optional().describe('false to stop tracking (default true).') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (ctx, args) => {
      const site = requireWritableSite(ctx, String(args.siteId));
      const query = String(args.query).trim();
      if (args.track === false) {
        const row = listTrackedQueries(site.id).find(t => t.query.toLowerCase() === query.toLowerCase());
        if (row) removeTrackedQuery(row.id);
      } else addTrackedQuery(site.id, query);
      return { tracked: listTrackedQueries(site.id) };
    },
  },
  {
    name: 'get_alerts',
    title: 'Get alerts',
    description: 'Recent alerts across your workspaces (index drops, schema or llms.txt drift, hygiene problems, quota, Bing, AI citation changes), newest first.',
    scope: 'mcp:read',
    inputShape: { workspaceId: z.string().optional(), unacknowledgedOnly: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: (ctx, args) => {
      const workspaces = typeof args.workspaceId === 'string' ? ctx.workspaceIds.filter(w => w === args.workspaceId) : ctx.workspaceIds;
      const limit = (args.limit as number | undefined) ?? 50;
      const rows = workspaces.flatMap(w => getAlerts(w, limit).map(a => ({ ...a, workspace_id: w }) as Record<string, unknown>))
        .filter(a => !args.unacknowledgedOnly || !a.acked)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, limit);
      return { alerts: rows };
    },
  },
];

/** Every tool: the SEO tools above plus the Google Ads, GA4, Google reviews and Business Profile tools. */
export const ALL_TOOLS: ToolDef[] = [...TOOLS, ...ADS_TOOLS, ...GA4_TOOLS, ...REVIEWS_TOOLS, ...BUSINESS_TOOLS];

/** Tools this context is allowed to use, by scope. */
export function toolsForContext(ctx: McpContext): ToolDef[] {
  return ALL_TOOLS.filter(t => ctx.scopes.includes(t.scope));
}

/** Directly run a tool by name (used by the HTTP layer's fallbacks and by tests). */
export async function runTool(ctx: McpContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = ALL_TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!ctx.scopes.includes(tool.scope)) throw new Error(`This token lacks the "${tool.scope}" scope required by ${name}.`);
  return tool.handler(ctx, args);
}

/** Build a fully-wired MCP server exposing exactly the tools this token may use. */
export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: 'seo-website-indexer', version: 'mcp-2' },
    { instructions: [
      'Read and act on your SEO Website Indexer data: sites, Search Console performance, URL inspection, indexing, hygiene, AI-agent readiness and AI citations. Site ids come from list_sites.',
      'Google Ads tools start with ads_. Start with ads_list_clients, then ads_get_client_brief for the client\'s budget, goals and guardrails. Use ads_get_resource_metadata before writing GAQL for ads_search/ads_query.',
      'Every Google Ads change tool validates the change with Google and returns a change plan: apply "pending" plans with ads_apply_change; "needs_approval" plans wait for a person on the dashboard. Never try to split a change to get around a guardrail.',
    ].join(' ') },
  );
  for (const tool of toolsForContext(ctx)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputShape, ...(tool.annotations ? { annotations: tool.annotations } : {}) },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(ctx, args ?? {});
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          const structured = result && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>) : { result };
          return { content: [{ type: 'text' as const, text }], structuredContent: structured };
        } catch (e) {
          // Google Ads errors carry an actionable hint (enable the API, allow a host…); pass it on.
          const hint = (e as { hint?: unknown } | null)?.hint;
          const text = `${e instanceof Error ? e.message : String(e)}${typeof hint === 'string' && hint ? `\n\nHint: ${hint}` : ''}`;
          return { content: [{ type: 'text' as const, text }], isError: true };
        }
      },
    );
  }
  return server;
}
