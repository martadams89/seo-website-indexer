/**
 * mcp/ga4-tools.ts — Google Analytics 4 tools for the MCP server.
 *
 * Read-only reporting (mcp:read) for any GA4 property a Google login shared
 * with the caller's workspaces can see, plus linking a property to a Google
 * Ads client (ads:write) so the daily Ads routine reads its analytics too.
 * Logins outside the caller's workspaces are never used; Google enforces the
 * property access itself (the login needs at least Viewer).
 */
import { z } from 'zod';
import {
  analyticsLogins, cleanPropertyId, Ga4Error, getGa4Metadata, GA4_MAX_ROWS, listGa4Properties, runGa4Report,
  withPropertyAccess, type Ga4Filter,
} from '../analytics/ga4.js';
import { assertCanChangeAds, resolveAdsAccount } from '../ads/access.js';
import { ga4AdsPerformance, ga4LoginsFor, linkGa4Property } from '../ads/ga4-link.js';
import { formatCustomerId } from '../ads/client.js';
import { listAdsAccounts, type AdsAccount } from '../ads/store.js';
import type { McpContext, ToolDef } from './tools.js';

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const PROPERTY = z.string().describe('GA4 property ID, e.g. 449058214 (GA4 → Admin → Property details). Omit when you pass account.');
const ADS_ACCOUNT = z.string().describe('A Google Ads client (id from ads_list_clients or customer ID). Uses the GA4 property linked to that client.');
const DATE = z.string().describe('YYYY-MM-DD, "today", "yesterday" or "NdaysAgo" (e.g. "28daysAgo").');

/** Resolve which property to read and which logins may read it. */
function target(ctx: McpContext, args: Record<string, unknown>): { propertyId: string; logins: ReturnType<typeof analyticsLogins>; account: AdsAccount | null } {
  if (args.account) {
    const account = resolveAdsAccount(ctx.workspaceIds, args.account);
    const propertyId = args.propertyId ? cleanPropertyId(args.propertyId) : account.ga4_property_id;
    if (!propertyId) {
      throw new Ga4Error(`No GA4 property is linked to ${account.name ?? formatCustomerId(account.customer_id)}.`, 'NOT_FOUND',
        'Pass propertyId, or link one with ads_link_ga4_property (find IDs with ga4_list_properties).');
    }
    return { propertyId, logins: ga4LoginsFor(account), account };
  }
  if (!args.propertyId) throw new Ga4Error('Pass propertyId (from ga4_list_properties) or account (a Google Ads client with a linked GA4 property).', 'INVALID');
  return { propertyId: cleanPropertyId(args.propertyId), logins: analyticsLogins(ctx.workspaceIds), account: null };
}

const FILTER = z.object({
  dimension: z.string().describe('Dimension to filter on, e.g. sessionSourceMedium, sessionCampaignName, landingPage, country.'),
  value: z.string(),
  match: z.enum(['exact', 'contains', 'begins_with', 'regex']).optional().describe('Default exact (case-insensitive).'),
  exclude: z.boolean().optional().describe('true = keep rows that do NOT match.'),
});

export const GA4_TOOLS: ToolDef[] = [
  {
    name: 'ga4_list_properties',
    title: 'List GA4 properties',
    description: 'GA4 properties each connected Google login can read, and which Google Ads clients they are linked to. Use it to find a property ID.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { googleLogin: z.string().optional().describe('Only this login (email). Default: every login shared with your workspaces.') },
    handler: async (ctx, args) => {
      let logins = analyticsLogins(ctx.workspaceIds);
      if (args.googleLogin) logins = logins.filter(l => l.email === args.googleLogin || l.id === args.googleLogin);
      if (!logins.length) {
        throw new Ga4Error('No Google login with Google Analytics access is connected to your workspaces.', 'NO_LOGIN',
          'Connect (or Reconnect) a Google login that has Viewer access to the GA4 property, on the Accounts page.');
      }
      const linked = listAdsAccounts(ctx.workspaceIds).filter(a => a.ga4_property_id);
      const results = [];
      for (const login of logins) {
        try {
          const properties = await listGa4Properties(login);
          results.push({
            google_login: login.email ?? login.id,
            properties: properties.map(p => ({
              ...p,
              linked_ads_clients: linked.filter(a => a.ga4_property_id === p.property_id).map(a => a.name ?? formatCustomerId(a.customer_id)),
            })),
          });
        } catch (e) {
          const err = e as Ga4Error;
          results.push({ google_login: login.email ?? login.id, properties: [], error: err.message, hint: err.hint ?? null });
        }
      }
      return { logins: results };
    },
  },
  {
    name: 'ga4_get_metadata',
    title: 'Get GA4 dimensions and metrics',
    description: 'The dimensions and metrics a GA4 property supports (including its custom definitions). Check names here instead of guessing them for ga4_run_report. Use search to narrow the list.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: {
      propertyId: PROPERTY.optional(), account: ADS_ACCOUNT.optional(),
      search: z.string().optional().describe('Case-insensitive filter on name, label or category, e.g. "campaign", "revenue".'),
    },
    handler: async (ctx, args) => {
      const { propertyId, logins } = target(ctx, args);
      const { result } = await withPropertyAccess(logins, l => getGa4Metadata(l, propertyId));
      const q = typeof args.search === 'string' ? args.search.toLowerCase() : '';
      const hit = (x: { name: string; label: string; category: string }) => !q || `${x.name} ${x.label} ${x.category}`.toLowerCase().includes(q);
      return { property_id: propertyId, dimensions: result.dimensions.filter(hit), metrics: result.metrics.filter(hit) };
    },
  },
  {
    name: 'ga4_run_report',
    title: 'Run a GA4 report',
    description: 'Run a Google Analytics 4 report (Data API runReport) for a property or a Google Ads client\'s linked property. Common metrics: sessions, totalUsers, newUsers, engagedSessions, engagementRate, keyEvents, totalRevenue, averageSessionDuration. Common dimensions: date, sessionDefaultChannelGroup, sessionSourceMedium, sessionCampaignName, landingPagePlusQueryString, deviceCategory, country, eventName. Google Ads traffic is sessionSourceMedium = "google / cpc".',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: {
      propertyId: PROPERTY.optional(),
      account: ADS_ACCOUNT.optional(),
      startDate: DATE.optional().describe('Default "28daysAgo".'),
      endDate: DATE.optional().describe('Default "yesterday".'),
      dimensions: z.array(z.string()).max(9).optional(),
      metrics: z.array(z.string()).min(1).max(10),
      filters: z.array(FILTER).max(10).optional().describe('All filters must match (AND).'),
      orderBy: z.object({ field: z.string(), desc: z.boolean().optional() }).optional().describe('Default: first metric, descending.'),
      limit: z.number().int().min(1).max(GA4_MAX_ROWS).optional().describe('Rows to return (default 1000).'),
    },
    handler: async (ctx, args) => {
      const { propertyId, logins } = target(ctx, args);
      const { result } = await withPropertyAccess(logins, l => runGa4Report(l, propertyId, {
        startDate: args.startDate as string | undefined, endDate: args.endDate as string | undefined,
        dimensions: args.dimensions as string[] | undefined, metrics: args.metrics as string[],
        filters: args.filters as Ga4Filter[] | undefined, orderBy: args.orderBy as { field: string; desc?: boolean } | undefined,
        limit: args.limit as number | undefined,
      }));
      return result;
    },
  },
  {
    name: 'ga4_ads_performance',
    title: 'GA4 view of a Google Ads client',
    description: 'What GA4 recorded from a Google Ads client\'s paid traffic (google / cpc) on its linked property: sessions, engagement, key events and revenue with the change versus the previous period, by campaign, top landing pages, and the overall channel mix. Use it in every routine run alongside ads_account_overview to spot tracking gaps and landing-page problems.',
    scope: 'mcp:read',
    annotations: READ,
    inputShape: { account: ADS_ACCOUNT, days: z.number().int().min(1).max(365).optional().describe('Look-back window in days (default 28), compared with the window before it.') },
    handler: async (ctx, args) => ga4AdsPerformance(resolveAdsAccount(ctx.workspaceIds, args.account), (args.days as number | undefined) ?? 28),
  },
  {
    name: 'ads_link_ga4_property',
    title: 'Link a GA4 property to a Google Ads client',
    description: 'Link (or with propertyId null, unlink) the GA4 property this Google Ads client reads. The server checks that a connected Google login can read it before saving. Find property IDs with ga4_list_properties.',
    scope: 'ads:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputShape: { account: ADS_ACCOUNT, propertyId: z.string().nullable().describe('GA4 property ID, or null to unlink.') },
    handler: async (ctx, args) => {
      const account = resolveAdsAccount(ctx.workspaceIds, args.account);
      assertCanChangeAds(ctx.user, account.workspace_id);
      const { account: updated, google_login } = await linkGa4Property(account, args.propertyId as string | null);
      return {
        client: updated.name ?? formatCustomerId(updated.customer_id),
        ga4_property_id: updated.ga4_property_id,
        ga4_property_name: updated.ga4_property_name,
        verified_with: google_login,
      };
    },
  },
];
