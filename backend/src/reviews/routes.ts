/**
 * reviews/routes.ts — dashboard API for Google reviews (/api/reviews/*).
 *
 * Reads are open to workspace members; state-changing routes go through the
 * workspace hook (editors need the manage_reviews capability). A person
 * replying here publishes directly — the reply rules only judge AI replies.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getGoogleAccountsForWorkspace, getWorkspaceSetting, setWorkspaceSetting } from '../db/database.js';
import { getWorkspace, workspaceSlug } from '../auth/workspaces.js';
import { recordAuditEvent, type User } from '../auth/users.js';
import { publicOrigin } from '../utils/origin.js';
import { ReviewsApiError } from './client.js';
import { buildReviewRoutinePrompt, DEFAULT_REVIEW_ROUTINE, normalizeReviewRoutine } from './routine-prompt.js';
import { approveReply, businessPerformance, discoverLocations, enableBusinessApis, linkLocation, moveLocation, rejectReply, setupStatus, submitReply, syncLocation } from './service.js';
import {
  deleteLocation, getChange, getLocation, getReplyPlan, getReview, listChanges, listLocations, listReplyPlans, listReviews, locationStats, updateLocation,
  type ChangeStatus, type ReplyStatus, type ReviewFilter, type ReviewLocation,
} from './store.js';
import {
  approveChange, checkGoogleUpdates, getPhotos, getPosts, profileOverview, rejectChange, resolveGoogleUpdates, submitChange, type ChangeInput,
} from './profile-service.js';
import type { PhotoInput, PostInput, ProfileEdit } from './profile-rules.js';

interface RequestContext { ctx: { user: User; impersonator: User | null; workspaceId: string | null } }
const context = (req: FastifyRequest) => (req as unknown as RequestContext).ctx;
const actor = (req: FastifyRequest) => context(req).impersonator ?? context(req).user;
function workspace(req: FastifyRequest): string {
  const value = context(req)?.workspaceId;
  if (!value) throw Object.assign(new Error('No workspace selected.'), { statusCode: 400 });
  return value;
}

function locationInWorkspace(req: FastifyRequest, id: string): ReviewLocation {
  const loc = getLocation(id);
  if (!loc || loc.workspace_id !== workspace(req)) throw Object.assign(new Error('Location not found.'), { statusCode: 404 });
  return loc;
}

const STATUS_BY_KIND: Record<string, number> = {
  INVALID_REQUEST: 400, PERMISSION: 403, NOT_FOUND: 404, NO_SCOPE: 409, NEEDS_REAUTH: 409, API_DISABLED: 409, NOT_APPROVED: 409, NOT_VERIFIED: 409, QUOTA: 429,
};

function handle<T>(fn: (req: FastifyRequest, reply: FastifyReply) => Promise<T> | T) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof ReviewsApiError) return reply.status(STATUS_BY_KIND[e.kind] ?? 502).send({ error: e.message, kind: e.kind, hint: e.hint ?? null });
      const status = (e as { statusCode?: number }).statusCode;
      if (status) return reply.status(status).send({ error: (e as Error).message });
      throw e;
    }
  };
}

const ROUTINE_KEY = 'reviews_routine';

export function registerReviewsRoutes(app: FastifyInstance): void {
  // ── Setup ──────────────────────────────────────────────────────────────────
  app.get('/api/reviews/setup', handle(async (req) => {
    const { fresh } = req.query as { fresh?: string };
    return setupStatus(workspace(req), { fresh: fresh === '1' || fresh === 'true' });
  }));

  app.post('/api/reviews/setup/enable-api', handle(async (req) => {
    const { googleAccountId } = (req.body ?? {}) as { googleAccountId?: string };
    const account = getGoogleAccountsForWorkspace(workspace(req)).find(a => a.id === googleAccountId);
    if (!account) throw Object.assign(new Error('Google connection not found in this workspace.'), { statusCode: 404 });
    return enableBusinessApis(account);
  }));

  app.get('/api/reviews/discover', handle(async (req) => {
    const { googleAccountId } = req.query as { googleAccountId?: string };
    return discoverLocations(workspace(req), googleAccountId || undefined);
  }));

  // ── Locations ──────────────────────────────────────────────────────────────
  app.get('/api/reviews/locations', handle(async (req) => listLocations(workspace(req)).map(l => ({ ...l, stats: locationStats(l.id) }))));

  app.post('/api/reviews/locations', handle(async (req) => {
    const ws = workspace(req);
    const body = (req.body ?? {}) as { googleAccountId?: string; accountName?: string; locationName?: string; siteId?: string | null };
    if (!body.googleAccountId || !body.accountName || !body.locationName) throw Object.assign(new Error('googleAccountId, accountName and locationName are required.'), { statusCode: 400 });
    const linked = await linkLocation({ workspaceId: ws, googleAccountId: body.googleAccountId, accountName: body.accountName, locationName: body.locationName, siteId: body.siteId ?? null, userId: actor(req).id });
    recordAuditEvent({ actorUserId: actor(req).id, workspaceId: ws, action: 'google_reviews.location_linked', detail: { locationId: linked.id, location: linked.location_name } });
    return linked;
  }));

  app.patch('/api/reviews/locations/:id', handle(async (req) => {
    const loc = locationInWorkspace(req, (req.params as { id: string }).id);
    const body = (req.body ?? {}) as { brief?: unknown; rules?: unknown; profileRules?: unknown; enabled?: boolean; siteId?: string | null; googleAccountId?: string };
    if (body.googleAccountId && body.googleAccountId !== loc.google_account_id) {
      const moved = await moveLocation(loc, body.googleAccountId);
      recordAuditEvent({ actorUserId: actor(req).id, workspaceId: loc.workspace_id, action: 'google_reviews.location_moved', detail: { locationId: loc.id, from: loc.google_account_id, to: moved.google_account_id } });
    }
    const updated = updateLocation(loc.id, {
      brief: body.brief === undefined ? undefined : { ...loc.brief, ...(body.brief as object) },
      rules: body.rules === undefined ? undefined : { ...loc.rules, ...(body.rules as object) },
      profile_rules: body.profileRules === undefined ? undefined : { ...loc.profile_rules, ...(body.profileRules as object) },
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      site_id: body.siteId === undefined ? undefined : body.siteId,
    });
    if (body.rules !== undefined) recordAuditEvent({ actorUserId: actor(req).id, workspaceId: loc.workspace_id, action: 'google_reviews.rules_updated', detail: { locationId: loc.id, rules: updated?.rules } });
    if (body.profileRules !== undefined) recordAuditEvent({ actorUserId: actor(req).id, workspaceId: loc.workspace_id, action: 'google_business.profile_rules_updated', detail: { locationId: loc.id, rules: updated?.profile_rules } });
    return updated;
  }));

  app.delete('/api/reviews/locations/:id', handle(async (req) => {
    const loc = locationInWorkspace(req, (req.params as { id: string }).id);
    deleteLocation(loc.id);
    recordAuditEvent({ actorUserId: actor(req).id, workspaceId: loc.workspace_id, action: 'google_reviews.location_unlinked', detail: { locationId: loc.id, location: loc.location_name } });
    return { ok: true };
  }));

  app.post('/api/reviews/locations/:id/sync', handle(async (req) => {
    const loc = locationInWorkspace(req, (req.params as { id: string }).id);
    return syncLocation(loc, { full: true });
  }));

  app.get('/api/reviews/locations/:id/summary', handle(async (req) => {
    const loc = locationInWorkspace(req, (req.params as { id: string }).id);
    return { location: loc, stats: locationStats(loc.id) };
  }));

  app.get('/api/reviews/locations/:id/performance', handle(async (req) => {
    const loc = locationInWorkspace(req, (req.params as { id: string }).id);
    const q = req.query as { days?: string; fresh?: string };
    return businessPerformance(loc, Number(q.days) || 28, { fresh: q.fresh === '1' || q.fresh === 'true' });
  }));

  // ── Profile, posts and photos ──────────────────────────────────────────────
  const fresh = (req: FastifyRequest) => ['1', 'true'].includes(String((req.query as { fresh?: string }).fresh ?? ''));
  const change = async (req: FastifyRequest, loc: ReviewLocation, input: ChangeInput) => {
    const result = await submitChange({ location: loc, change: input, user: actor(req), source: 'dashboard' });
    recordAuditEvent({ actorUserId: actor(req).id, workspaceId: loc.workspace_id, action: `google_business.${input.kind}`, detail: { locationId: loc.id, changeId: result.id, status: result.status, summary: result.summary } });
    if (result.status === 'failed') throw new ReviewsApiError(result.error ?? 'Google refused the change.', 'UNKNOWN');
    return result;
  };

  app.get('/api/reviews/locations/:id/profile', handle(async (req) => profileOverview(locationInWorkspace(req, (req.params as { id: string }).id), { fresh: fresh(req) })));

  app.patch('/api/reviews/locations/:id/profile', handle(async (req) => {
    const loc = locationInWorkspace(req, (req.params as { id: string }).id);
    return change(req, loc, { kind: 'profile', edit: (req.body ?? {}) as ProfileEdit });
  }));

  app.post('/api/reviews/locations/:id/google-updates/check', handle(async (req) => {
    const loc = locationInWorkspace(req, (req.params as { id: string }).id);
    return checkGoogleUpdates(loc);
  }));

  app.post('/api/reviews/locations/:id/google-updates/resolve', handle(async (req) => {
    const loc = locationInWorkspace(req, (req.params as { id: string }).id);
    const { keep } = (req.body ?? {}) as { keep?: string };
    if (keep !== 'google' && keep !== 'mine') throw Object.assign(new Error('keep must be "google" or "mine".'), { statusCode: 400 });
    const result = await resolveGoogleUpdates(loc, keep, actor(req));
    if (result.status === 'failed') throw new ReviewsApiError(result.error ?? 'Google refused the change.', 'UNKNOWN');
    return result;
  }));

  app.get('/api/reviews/locations/:id/posts', handle(async (req) => getPosts(locationInWorkspace(req, (req.params as { id: string }).id), { fresh: fresh(req) })));

  app.post('/api/reviews/locations/:id/posts', handle(async (req) => {
    const loc = locationInWorkspace(req, (req.params as { id: string }).id);
    return change(req, loc, { kind: 'post', post: (req.body ?? {}) as PostInput });
  }));

  app.delete('/api/reviews/locations/:id/posts', handle(async (req) => {
    const loc = locationInWorkspace(req, (req.params as { id: string }).id);
    const { name } = req.query as { name?: string };
    if (!name) throw Object.assign(new Error('Pass the post name.'), { statusCode: 400 });
    return change(req, loc, { kind: 'post_delete', post_name: name });
  }));

  app.get('/api/reviews/locations/:id/photos', handle(async (req) => getPhotos(locationInWorkspace(req, (req.params as { id: string }).id), { fresh: fresh(req) })));

  app.post('/api/reviews/locations/:id/photos', handle(async (req) => {
    const loc = locationInWorkspace(req, (req.params as { id: string }).id);
    return change(req, loc, { kind: 'photo', photo: (req.body ?? {}) as PhotoInput });
  }));

  app.delete('/api/reviews/locations/:id/photos', handle(async (req) => {
    const loc = locationInWorkspace(req, (req.params as { id: string }).id);
    const { name } = req.query as { name?: string };
    if (!name) throw Object.assign(new Error('Pass the photo name.'), { statusCode: 400 });
    return change(req, loc, { kind: 'photo_delete', media_name: name });
  }));

  app.get('/api/reviews/changes', handle(async (req) => {
    const q = req.query as { status?: ChangeStatus; locationId?: string; limit?: string };
    const ws = workspace(req);
    if (q.locationId) locationInWorkspace(req, q.locationId);
    return listChanges({ workspaceIds: [ws], status: q.status, locationId: q.locationId || undefined, limit: Number(q.limit) || 100 })
      .map(c => ({ ...c, location_title: getLocation(c.location_id)?.title ?? null }));
  }));

  app.get('/api/reviews/changes/:id', handle(async (req) => {
    const item = getChange((req.params as { id: string }).id);
    if (!item || item.workspace_id !== workspace(req)) throw Object.assign(new Error('Change not found.'), { statusCode: 404 });
    return { ...item, location_title: getLocation(item.location_id)?.title ?? null };
  }));

  app.post('/api/reviews/changes/:id/approve', handle(async (req) => {
    const item = getChange((req.params as { id: string }).id);
    if (!item || item.workspace_id !== workspace(req)) throw Object.assign(new Error('Change not found.'), { statusCode: 404 });
    const result = await approveChange(item.id, actor(req));
    recordAuditEvent({ actorUserId: actor(req).id, workspaceId: item.workspace_id, action: 'google_business.change_approved', detail: { changeId: item.id, status: result.status } });
    if (result.status === 'failed') throw new ReviewsApiError(result.error ?? 'Google refused the change.', 'UNKNOWN');
    return result;
  }));

  app.post('/api/reviews/changes/:id/reject', handle(async (req) => {
    const item = getChange((req.params as { id: string }).id);
    if (!item || item.workspace_id !== workspace(req)) throw Object.assign(new Error('Change not found.'), { statusCode: 404 });
    return rejectChange(item.id, actor(req));
  }));

  // ── Reviews and replies ────────────────────────────────────────────────────
  app.get('/api/reviews/reviews', handle(async (req) => {
    const q = req.query as { locationId?: string; filter?: ReviewFilter; minRating?: string; maxRating?: string; search?: string; limit?: string; offset?: string };
    const ws = workspace(req);
    if (q.locationId) locationInWorkspace(req, q.locationId);
    const result = listReviews({
      workspaceIds: [ws], locationId: q.locationId || undefined, filter: q.filter, minRating: Number(q.minRating) || undefined,
      maxRating: Number(q.maxRating) || undefined, search: q.search?.trim() || undefined, limit: Number(q.limit) || 50, offset: Number(q.offset) || 0,
    });
    const waiting = listReplyPlans({ workspaceIds: [ws], status: 'needs_approval', limit: 500 });
    return { ...result, reviews: result.reviews.map(r => ({ ...r, pending_reply: waiting.find(p => p.review_id === r.id) ?? null })) };
  }));

  app.post('/api/reviews/reviews/:id/reply', handle(async (req) => {
    const review = getReview((req.params as { id: string }).id);
    if (!review || review.workspace_id !== workspace(req)) throw Object.assign(new Error('Review not found.'), { statusCode: 404 });
    const { text } = (req.body ?? {}) as { text?: string };
    const plan = await submitReply({ location: getLocation(review.location_id)!, review, text, user: actor(req), source: 'dashboard' });
    if (plan.status === 'failed') throw new ReviewsApiError(plan.error ?? 'Google rejected the reply.', 'UNKNOWN');
    return plan;
  }));

  app.delete('/api/reviews/reviews/:id/reply', handle(async (req) => {
    const review = getReview((req.params as { id: string }).id);
    if (!review || review.workspace_id !== workspace(req)) throw Object.assign(new Error('Review not found.'), { statusCode: 404 });
    const plan = await submitReply({ location: getLocation(review.location_id)!, review, action: 'delete', user: actor(req), source: 'dashboard' });
    if (plan.status === 'failed') throw new ReviewsApiError(plan.error ?? 'Google could not delete the reply.', 'UNKNOWN');
    return plan;
  }));

  app.get('/api/reviews/replies', handle(async (req) => {
    const q = req.query as { status?: ReplyStatus; locationId?: string; limit?: string };
    const ws = workspace(req);
    return listReplyPlans({ workspaceIds: [ws], status: q.status, locationId: q.locationId || undefined, limit: Number(q.limit) || 100 })
      .map(p => ({ ...p, review: getReview(p.review_id), location_title: getLocation(p.location_id)?.title ?? null }));
  }));

  // One reply plan, with its review and location, for the approval page that notification links open.
  app.get('/api/reviews/replies/:id', handle(async (req) => {
    const plan = getReplyPlan((req.params as { id: string }).id);
    if (!plan || plan.workspace_id !== workspace(req)) throw Object.assign(new Error('Reply not found.'), { statusCode: 404 });
    return { ...plan, review: getReview(plan.review_id), location_title: getLocation(plan.location_id)?.title ?? null };
  }));

  app.post('/api/reviews/replies/:id/approve', handle(async (req) => {
    const plan = getReplyPlan((req.params as { id: string }).id);
    if (!plan || plan.workspace_id !== workspace(req)) throw Object.assign(new Error('Reply not found.'), { statusCode: 404 });
    const { text } = (req.body ?? {}) as { text?: string };
    const result = await approveReply(plan.id, { user: actor(req), text });
    if (result.status === 'failed') throw new ReviewsApiError(result.error ?? 'Google rejected the reply.', 'UNKNOWN');
    return result;
  }));

  app.post('/api/reviews/replies/:id/reject', handle(async (req) => {
    const plan = getReplyPlan((req.params as { id: string }).id);
    if (!plan || plan.workspace_id !== workspace(req)) throw Object.assign(new Error('Reply not found.'), { statusCode: 404 });
    return rejectReply(plan.id, actor(req));
  }));

  // ── Routine prompt ─────────────────────────────────────────────────────────
  app.get('/api/reviews/routine', handle(async (req) => {
    const ws = workspace(req);
    let saved: unknown = null;
    try { saved = JSON.parse(getWorkspaceSetting(ws, ROUTINE_KEY) ?? 'null'); } catch { saved = null; }
    const value = (saved ?? {}) as { settings?: unknown; location_ids?: string[]; connector_name?: string };
    return {
      settings: normalizeReviewRoutine(value.settings ?? DEFAULT_REVIEW_ROUTINE),
      location_ids: Array.isArray(value.location_ids) ? value.location_ids : [],
      connector_name: value.connector_name ?? 'SEO Website Indexer',
      endpoint: `${publicOrigin(req)}/mcp`,
    };
  }));

  app.post('/api/reviews/routine/prompt', handle(async (req) => {
    const ws = workspace(req);
    const body = (req.body ?? {}) as { settings?: unknown; locationIds?: string[]; connectorName?: string };
    const settings = normalizeReviewRoutine(body.settings);
    const ids = Array.isArray(body.locationIds) ? body.locationIds.map(String) : [];
    const locations = ids.map(id => locationInWorkspace(req, id));
    const connectorName = (body.connectorName ?? '').trim().slice(0, 100) || 'SEO Website Indexer';
    setWorkspaceSetting(ws, ROUTINE_KEY, JSON.stringify({ settings, location_ids: ids, connector_name: connectorName }));
    const origin = publicOrigin(req);
    return buildReviewRoutinePrompt({
      settings, locations, connectorName, endpoint: `${origin}/mcp`, dashboardUrl: `${origin}/w/${encodeURIComponent(workspaceSlug(ws))}/reviews?tab=approvals`,
      workspaceName: getWorkspace(ws)?.name ?? null,
    });
  }));

}
