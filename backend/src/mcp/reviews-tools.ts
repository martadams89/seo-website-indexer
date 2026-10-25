/**
 * mcp/reviews-tools.ts — Google reviews tools for the MCP server.
 *
 * Read tools (mcp:read) list locations, reviews, summaries and reply history.
 * reviews_reply (reviews:write) never bypasses the location's reply rules:
 * a reply inside them is published, anything else waits for a person on the
 * dashboard (or is blocked when the location is read-only).
 *
 * Every tool is fenced to locations linked in the token owner's workspaces.
 */
import { z } from 'zod';
import { assertCanReply, resolveLocation, resolveReview } from '../reviews/access.js';
import { ReviewsApiError } from '../reviews/client.js';
import { businessPerformance, discoverLocations, linkLocation, submitReply, syncLocation } from '../reviews/service.js';
import {
  getLocation, getReview, listLocations, listReplyPlans, listReviews, locationStats, updateLocation,
  type ReplyPlan, type ReplyStatus, type ReviewFilter, type ReviewLocation, type StoredReview,
} from '../reviews/store.js';
import { normalizeReviewBrief } from '../reviews/rules.js';
import type { McpContext, ToolDef } from './tools.js';

const LOCATION = z.string().describe('The location: its id from reviews_list_locations (or its exact title).');
const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const STALE_MS = 30 * 60_000;

function location(ctx: McpContext, ref: unknown): ReviewLocation {
  return resolveLocation(ctx.workspaceIds, ref);
}

function writableLocation(ctx: McpContext, ref: unknown): ReviewLocation {
  const loc = location(ctx, ref);
  assertCanReply(ctx.user, loc.workspace_id);
  return loc;
}

function dashboardLink(ctx: McpContext, tab = 'approvals'): string | null {
  return ctx.origin ? `${ctx.origin}/reviews?tab=${tab}` : null;
}

function publicLocation(l: ReviewLocation) {
  return {
    id: l.id, workspace_id: l.workspace_id, title: l.title, address: l.address, website: l.website, maps_url: l.maps_uri,
    review_link: l.new_review_uri, enabled: l.enabled, average_rating: l.average_rating, total_reviews: l.total_reviews,
    last_synced_at: l.last_synced_at, last_error: l.last_error, reply_rules: l.rules, brief: l.brief,
  };
}

function publicReview(r: StoredReview) {
  return {
    id: r.id, rating: r.rating, reviewer: r.anonymous ? 'Anonymous' : r.reviewer_name, comment: r.comment,
    created: r.create_time, updated: r.update_time,
    reply: r.reply_comment ? { text: r.reply_comment, updated: r.reply_update_time, moderation: r.reply_state, policy_violation: r.reply_policy_violation } : null,
    media: r.media.length,
  };
}

/** What an assistant needs to know about a reply plan, including what happens next. */
function presentPlan(ctx: McpContext, plan: ReplyPlan) {
  const link = dashboardLink(ctx);
  const next: Record<ReplyStatus, string> = {
    published: 'Published. Google moderates replies; the moderation state shows on the review after the next sync.',
    needs_approval: `Waiting for a person to approve it on the dashboard${link ? ` (${link})` : ''}. Don't resubmit it to get around a rule.`,
    blocked: 'Blocked by this location\'s settings. Report it; a person must change the reply rules or reply on the dashboard.',
    publishing: 'Being published right now.',
    rejected: 'A person rejected this reply.',
    failed: 'Google refused the reply. Read the error; fix the reply if it was a mistake, otherwise report it.',
    superseded: 'Replaced by a newer reply.',
  };
  return { reply_id: plan.id, status: plan.status, action: plan.action, text: plan.text, findings: plan.findings, error: plan.error, next_step: next[plan.status] };
}

async function freshen(loc: ReviewLocation, force = false): Promise<ReviewLocation> {
  if (!force && loc.last_synced_at && Date.now() - Date.parse(loc.last_synced_at) < STALE_MS) return loc;
  await syncLocation(loc).catch(() => null);
  return getLocation(loc.id) ?? loc;
}

export const REVIEWS_TOOLS: ToolDef[] = [
  {
    name: 'reviews_list_locations',
    title: 'List Google Business Profile locations',
    description: 'Every Business Profile location linked to your workspaces, with rating, review count, unreplied counts, reply rules and brief. Start here.',
    scope: 'mcp:read',
    inputShape: {},
    annotations: READ,
    handler: (ctx) => ({
      locations: listLocations(ctx.workspaceIds).map(l => {
        const stats = locationStats(l.id);
        return { ...publicLocation(l), unreplied: stats.unreplied, unreplied_negative: stats.unreplied_negative, awaiting_approval: stats.awaiting_approval, reply_rejected: stats.reply_rejected };
      }),
    }),
  },
  {
    name: 'reviews_discover_locations',
    title: 'Find Business Profile locations to link',
    description: 'Business Profile accounts and locations the connected Google users manage, marking which are already linked. Use reviews_link_location to link one.',
    scope: 'mcp:read',
    inputShape: { workspaceId: z.string().optional().describe('Workspace to check (defaults to your first workspace).') },
    annotations: READ,
    handler: async (ctx, args) => {
      const ws = args.workspaceId ? String(args.workspaceId) : ctx.workspaceIds[0];
      if (!ws || !ctx.workspaceIds.includes(ws)) throw new ReviewsApiError('Workspace not found.', 'NOT_FOUND');
      return discoverLocations(ws);
    },
  },
  {
    name: 'reviews_link_location',
    title: 'Link a Business Profile location',
    description: 'Link a location (from reviews_discover_locations) to a workspace so its reviews are synced and can be answered. New links start in guarded mode: replies to 4–5 star reviews publish, others wait for approval.',
    scope: 'reviews:write',
    inputShape: {
      workspaceId: z.string().describe('Workspace that owns the location.'),
      googleAccountId: z.string().describe('google_account_id from reviews_discover_locations.'),
      accountName: z.string().describe('Business Profile account, e.g. "accounts/123".'),
      locationName: z.string().describe('Location, e.g. "locations/456".'),
    },
    annotations: { ...WRITE, idempotentHint: true },
    handler: async (ctx, args) => {
      const ws = String(args.workspaceId);
      if (!ctx.workspaceIds.includes(ws)) throw new ReviewsApiError('Workspace not found.', 'NOT_FOUND');
      assertCanReply(ctx.user, ws);
      const linked = await linkLocation({ workspaceId: ws, googleAccountId: String(args.googleAccountId), accountName: String(args.accountName), locationName: String(args.locationName), userId: ctx.user.id });
      return { location: publicLocation(linked) };
    },
  },
  {
    name: 'reviews_sync',
    title: 'Refresh reviews from Google',
    description: 'Pull the latest reviews and reply moderation states for a location now (the server also syncs about hourly).',
    scope: 'mcp:read',
    inputShape: { location: LOCATION },
    annotations: READ,
    handler: async (ctx, args) => {
      const loc = location(ctx, args.location);
      const result = await syncLocation(loc);
      return { ...result, location: publicLocation(getLocation(loc.id) ?? loc) };
    },
  },
  {
    name: 'reviews_list',
    title: 'List reviews',
    description: 'Reviews for a location, newest first. Filters: "unreplied" (no reply yet), "negative" (1–3 stars), "reply_rejected" (Google rejected the reply), "awaiting_approval", or "all".',
    scope: 'mcp:read',
    inputShape: {
      location: LOCATION,
      filter: z.enum(['all', 'unreplied', 'negative', 'reply_rejected', 'awaiting_approval']).optional(),
      minRating: z.number().int().min(1).max(5).optional(),
      maxRating: z.number().int().min(1).max(5).optional(),
      sinceDays: z.number().int().min(1).max(3650).optional().describe('Only reviews written in the last N days.'),
      search: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: READ,
    handler: async (ctx, args) => {
      const loc = await freshen(location(ctx, args.location));
      const result = listReviews({
        workspaceIds: [loc.workspace_id], locationId: loc.id, filter: args.filter as ReviewFilter | undefined,
        minRating: args.minRating as number | undefined, maxRating: args.maxRating as number | undefined,
        sinceDays: args.sinceDays as number | undefined, search: args.search as string | undefined, limit: (args.limit as number | undefined) ?? 50,
      });
      return { location: loc.title, total: result.total, reviews: result.reviews.map(publicReview) };
    },
  },
  {
    name: 'reviews_get',
    title: 'Get one review',
    description: 'A review with its current reply, moderation state and the history of replies proposed for it.',
    scope: 'mcp:read',
    inputShape: { reviewId: z.string().describe('The review id from reviews_list.') },
    annotations: READ,
    handler: (ctx, args) => {
      const { review, location: loc } = resolveReview(ctx.workspaceIds, args.reviewId);
      return {
        location: { id: loc.id, title: loc.title }, review: publicReview(review),
        reply_history: listReplyPlans({ workspaceIds: [loc.workspace_id], reviewId: review.id, limit: 20 }).map(p => presentPlan(ctx, p)),
      };
    },
  },
  {
    name: 'reviews_summary',
    title: 'Review summary and trend',
    description: 'Rating, star distribution, last 30 days vs the 30 before, response rate and median response time (90 days), monthly trend, and the open work for a location.',
    scope: 'mcp:read',
    inputShape: { location: LOCATION },
    annotations: READ,
    handler: async (ctx, args) => {
      const loc = await freshen(location(ctx, args.location));
      return { location: publicLocation(loc), stats: locationStats(loc.id) };
    },
  },
  {
    name: 'reviews_business_performance',
    title: 'Business Profile performance',
    description: 'How people interacted with the Business Profile: Search and Maps impressions, calls, website clicks, direction requests, messages and bookings for the last N days vs the period before (Google\'s figures lag about two days), plus the search terms that showed the profile over the last three full months.',
    scope: 'mcp:read',
    inputShape: { location: LOCATION, days: z.number().int().min(7).max(270).optional().describe('Period length in days (default 28).') },
    annotations: READ,
    handler: async (ctx, args) => {
      const loc = location(ctx, args.location);
      return { location: loc.title, ...(await businessPerformance(loc, (args.days as number | undefined) ?? 28)) };
    },
  },
  {
    name: 'reviews_get_brief',
    title: 'Get a location\'s reply brief and rules',
    description: 'How replies should sound (voice, sign-off, where to send unhappy customers, language, things never to say) and the reply rules the server enforces.',
    scope: 'mcp:read',
    inputShape: { location: LOCATION },
    annotations: READ,
    handler: (ctx, args) => {
      const loc = location(ctx, args.location);
      return { location: loc.title, brief: loc.brief, reply_rules: loc.rules };
    },
  },
  {
    name: 'reviews_list_replies',
    title: 'List replies made through the app',
    description: 'Replies proposed or published through this app (by people and assistants), newest first. Use status "published" for examples of the house style, or "needs_approval" for what is waiting.',
    scope: 'mcp:read',
    inputShape: {
      location: LOCATION.optional(),
      status: z.enum(['needs_approval', 'blocked', 'published', 'rejected', 'failed', 'superseded']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: READ,
    handler: (ctx, args) => {
      const loc = args.location ? location(ctx, args.location) : null;
      return {
        replies: listReplyPlans({ workspaceIds: loc ? [loc.workspace_id] : ctx.workspaceIds, locationId: loc?.id, status: args.status as ReplyStatus | undefined, limit: (args.limit as number | undefined) ?? 20 })
          .map(p => ({ ...presentPlan(ctx, p), review: (() => { const r = getReview(p.review_id); return r ? { id: r.id, rating: r.rating, comment: r.comment } : null; })(), created_at: p.created_at })),
      };
    },
  },
  {
    name: 'reviews_reply',
    title: 'Reply to a review',
    description: 'Publish a reply to a review (or replace its reply). The location\'s reply rules decide: inside them it is published; otherwise it waits for a person to approve it on the dashboard. Set publish: false to always leave it as a draft for approval.',
    scope: 'reviews:write',
    inputShape: {
      reviewId: z.string().describe('The review id from reviews_list.'),
      text: z.string().min(1).max(4000).describe('The reply as the business owner. Plain text.'),
      rationale: z.string().max(2000).optional().describe('One line on why this reply, shown to the person approving it.'),
      publish: z.boolean().optional().describe('false = save as a draft for approval even if the rules would allow publishing.'),
    },
    annotations: WRITE,
    handler: async (ctx, args) => {
      const { review, location: loc } = resolveReview(ctx.workspaceIds, args.reviewId);
      writableLocation(ctx, loc.id);
      const plan = await submitReply({ location: loc, review, text: String(args.text), rationale: args.rationale as string | undefined, user: ctx.user, source: 'mcp', publish: args.publish as boolean | undefined });
      return presentPlan(ctx, plan);
    },
  },
  {
    name: 'reviews_delete_reply',
    title: 'Ask to delete a reply',
    description: 'Request deletion of a published reply. Deleting always waits for a person to approve it on the dashboard.',
    scope: 'reviews:write',
    inputShape: { reviewId: z.string(), rationale: z.string().min(5).max(2000).describe('Why the reply should be removed.') },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async (ctx, args) => {
      const { review, location: loc } = resolveReview(ctx.workspaceIds, args.reviewId);
      writableLocation(ctx, loc.id);
      const plan = await submitReply({ location: loc, review, action: 'delete', rationale: String(args.rationale), user: ctx.user, source: 'mcp' });
      return presentPlan(ctx, plan);
    },
  },
  {
    name: 'reviews_update_brief',
    title: 'Update a location\'s reply brief',
    description: 'Save what you learned about how replies should sound (voice, sign-off, contact for issues, language, notes). Reply rules can only be changed by a person on the dashboard.',
    scope: 'reviews:write',
    inputShape: {
      location: LOCATION,
      brand_voice: z.string().max(2000).optional(),
      sign_off: z.string().max(200).optional(),
      contact_for_issues: z.string().max(500).optional(),
      language: z.string().max(60).optional(),
      notes: z.string().max(4000).optional(),
    },
    annotations: { ...WRITE, openWorldHint: false, idempotentHint: true },
    handler: (ctx, args) => {
      const loc = writableLocation(ctx, args.location);
      const { location: _ignored, ...fields } = args;
      const updated = updateLocation(loc.id, { brief: normalizeReviewBrief({ ...loc.brief, ...fields }) });
      return { location: updated?.title, brief: updated?.brief };
    },
  },
];
