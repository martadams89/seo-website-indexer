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
import { accessibleWorkspaces, canAccessSiteInWorkspace, workspaceRole } from '../auth/workspaces.js';
import { inspectGoogleUrl } from '../indexer/google.js';
import { getGooglePerformance, getGoogleDimension } from '../indexer/performance.js';
import { checkSiteHygiene } from '../indexer/hygiene.js';
import { checkAgentReadiness } from '../indexer/agent-readiness.js';
import { publishUrlUpdated, indexingQuotaBucket } from '../indexer/google-indexing.js';
import { snapshotSitePerformance, getWowDeltas } from '../analytics/perf-store.js';
import { getResults } from '../ai/citations.js';
import { runIndexing, isRunning } from '../scheduler.js';
import { type McpScope, type McpTokenAuth } from './tokens.js';

export interface McpContext {
  user: User;
  scopes: McpScope[];
  /** Ids of every workspace the user can reach — the tenant fence for all tools. */
  workspaceIds: string[];
}

/** Resolve an authenticated token into a usable context, or null if the user is gone. */
export function buildContext(auth: McpTokenAuth): McpContext | null {
  const user = getUserById(auth.userId);
  if (!user || user.disabled) return null;
  return { user, scopes: auth.scopes, workspaceIds: accessibleWorkspaces(user).map(w => w.id) };
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
      const site = requireSite(ctx, String(args.siteId));
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
    name: 'trigger_indexing_run',
    title: 'Trigger an indexing run',
    description: 'Start a manual indexing run for one site (discovers and submits changed URLs). Fails if a run is already in progress for that workspace. Requires the mcp:write scope.',
    scope: 'mcp:write',
    inputShape: { siteId: z.string() },
    handler: async (ctx, args) => {
      const site = requireSite(ctx, String(args.siteId));
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
      const site = requireSite(ctx, String(args.siteId));
      await snapshotSitePerformance(site);
      return { ok: true, siteId: site.id, snapshotAt: new Date().toISOString() };
    },
  },
];

/** Tools this context is allowed to use, by scope. */
export function toolsForContext(ctx: McpContext): ToolDef[] {
  return TOOLS.filter(t => ctx.scopes.includes(t.scope));
}

/** Directly run a tool by name (used by the HTTP layer's fallbacks and by tests). */
export async function runTool(ctx: McpContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!ctx.scopes.includes(tool.scope)) throw new Error(`This token lacks the "${tool.scope}" scope required by ${name}.`);
  return tool.handler(ctx, args);
}

/** Build a fully-wired MCP server exposing exactly the tools this token may use. */
export function buildMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: 'seo-website-indexer', version: 'mcp-1' },
    { instructions: 'Read and act on your SEO Website Indexer data: sites, Search Console performance, URL inspection, indexing, hygiene, AI-agent readiness and AI citations. Site ids come from list_sites.' },
  );
  for (const tool of toolsForContext(ctx)) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputShape },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(ctx, args ?? {});
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          const structured = result && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>) : { result };
          return { content: [{ type: 'text' as const, text }], structuredContent: structured };
        } catch (e) {
          return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
        }
      },
    );
  }
  return server;
}
