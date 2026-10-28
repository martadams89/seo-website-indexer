/**
 * ads/routes.ts — dashboard API for Google Ads. Session-authenticated like the
 * rest of /api; viewers can read, and mutations are gated by the global
 * workspace hook (editors need the manage_ads capability).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getGoogleAccountsForWorkspace, getWorkspaceSetting, setWorkspaceSetting } from '../db/database.js';
import { getWorkspace, workspaceSlug } from '../auth/workspaces.js';
import { recordAuditEvent, type User } from '../auth/users.js';
import { publicOrigin } from '../utils/origin.js';
import { ADS_SCOPE, AdsApiError, discoverCustomers, formatCustomerId } from './client.js';
import { assertCanChangeAds } from './access.js';
import { applyChange, proposeRecommendations, rejectChange, revertChange } from './changes.js';
import { accountOverview, auditAccount, listRecommendations, searchTerms } from './insights.js';
import { buildRoutinePrompt, DEFAULT_ROUTINE, FOCUS_AREAS, normalizeRoutine } from './routine-prompt.js';
import { enableAdsApi, moveAdsAccount, setupStatus, verifyAndLinkAccount } from './setup.js';
import { analyticsLogins, Ga4Error, listGa4Properties } from '../analytics/ga4.js';
import { linkGa4Property } from './ga4-link.js';
import {
  getAdsAccount, getChange, healOrphanedAdsAccounts, isOrphanedAdsAccount, listAdsAccounts, listChanges, listRoutineRuns,
  unlinkAdsAccount, updateAdsAccount, type AdsAccount, type ChangeStatus,
} from './store.js';

interface RequestContext { ctx: { user: User; impersonator: User | null; workspaceId: string | null } }
const context = (req: FastifyRequest) => (req as unknown as RequestContext).ctx;
const user = (req: FastifyRequest) => context(req).user;
const actor = (req: FastifyRequest) => context(req).impersonator ?? context(req).user;
function workspace(req: FastifyRequest): string {
  const value = context(req)?.workspaceId;
  if (!value) throw Object.assign(new Error('No workspace selected.'), { statusCode: 400 });
  return value;
}

/** An ads account in the ACTIVE workspace, or a 404. */
function accountInWorkspace(req: FastifyRequest, id: string): AdsAccount {
  const acc = getAdsAccount(id);
  if (!acc || acc.workspace_id !== workspace(req)) throw Object.assign(new Error('Ad account not found.'), { statusCode: 404 });
  return acc;
}

const STATUS_BY_KIND: Record<string, number> = {
  INVALID_CUSTOMER_ID: 400, INVALID_AMOUNT: 400, INVALID_REQUEST: 400, PERMISSION: 403, NOT_FOUND: 404,
  NO_ADS_SCOPE: 409, NEEDS_REAUTH: 409, API_DISABLED: 409, ACCESS_LEVEL: 409, QUOTA: 429,
};

const GA4_STATUS_BY_KIND: Record<string, number> = {
  INVALID: 400, PERMISSION: 403, NOT_FOUND: 404, NO_LOGIN: 409, SCOPE: 409, API_DISABLED: 409, QUOTA: 429,
};

/** Wrap a handler so Google Ads and GA4 errors come back as { error, kind, hint }. */
function handle<T>(fn: (req: FastifyRequest, reply: FastifyReply) => Promise<T> | T) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof AdsApiError) {
        return reply.status(STATUS_BY_KIND[e.kind] ?? 502).send({ error: e.message, kind: e.kind, hint: e.hint ?? null, requestId: e.requestId ?? null });
      }
      if (e instanceof Ga4Error) {
        return reply.status(GA4_STATUS_BY_KIND[e.kind] ?? 502).send({ error: e.message, kind: e.kind, hint: e.hint ?? null });
      }
      const status = (e as { statusCode?: number }).statusCode;
      if (status) return reply.status(status).send({ error: (e as Error).message });
      throw e;
    }
  };
}

const ROUTINE_KEY = 'ads_routine';

export function registerAdsRoutes(app: FastifyInstance): void {
  // ── Setup ──────────────────────────────────────────────────────────────────
  app.get('/api/ads/setup', handle(async (req) => {
    const { fresh } = req.query as { fresh?: string };
    healOrphanedAdsAccounts(workspace(req));
    return setupStatus(workspace(req), { fresh: fresh === '1' || fresh === 'true' });
  }));

  app.post('/api/ads/setup/enable-api', handle(async (req) => {
    const { googleAccountId } = (req.body ?? {}) as { googleAccountId?: string };
    const account = getGoogleAccountsForWorkspace(workspace(req)).find(a => a.id === googleAccountId);
    if (!account) throw Object.assign(new Error('Google connection not found in this workspace.'), { statusCode: 404 });
    return enableAdsApi(account);
  }));

  app.get('/api/ads/discover', handle(async (req) => {
    const ws = workspace(req);
    const { googleAccountId } = req.query as { googleAccountId?: string };
    const connections = getGoogleAccountsForWorkspace(ws).filter(a => (a.granted_scopes ?? '').split(' ').includes(ADS_SCOPE) && (!googleAccountId || a.id === googleAccountId));
    if (!connections.length) throw new AdsApiError('No Google connection in this workspace has Google Ads access yet.', 'NO_ADS_SCOPE', { hint: 'Use "Add Google Ads access" on a connected account, or connect a new one with Google Ads ticked.' });
    const linked = listAdsAccounts(ws);
    const results = [];
    for (const conn of connections) {
      try {
        const { customers, errors } = await discoverCustomers(conn.id);
        results.push({
          google_account_id: conn.id, email: conn.email, errors,
          customers: customers.map(c => {
            const existing = linked.find(l => l.customer_id === c.customer_id);
            // A linked account whose Google connection was disconnected must
            // stay selectable so it can be relinked to this connection.
            return {
              ...c, linked_account_id: existing?.id ?? null, needs_relink: !!existing && isOrphanedAdsAccount(existing),
              // The connection the linked account uses now (another login or project when it differs).
              linked_via: existing?.google_account_id ?? null,
            };
          }),
        });
      } catch (e) {
        const err = e as AdsApiError;
        results.push({ google_account_id: conn.id, email: conn.email, customers: [], errors: [err.message], kind: err.kind ?? 'UNKNOWN', hint: err.hint ?? null });
      }
    }
    return { connections: results };
  }));

  // GA4 properties the workspace's Google logins can read (for the client's GA4 picker).
  app.get('/api/ads/ga4/properties', handle(async (req) => {
    const results = [];
    for (const login of analyticsLogins([workspace(req)])) {
      try {
        results.push({ google_login: login.email ?? login.id, properties: await listGa4Properties(login), error: null, hint: null });
      } catch (e) {
        const err = e as Ga4Error;
        results.push({ google_login: login.email ?? login.id, properties: [], error: err.message, hint: err.hint ?? null });
      }
    }
    return { logins: results };
  }));

  // ── Client accounts ────────────────────────────────────────────────────────
  app.get('/api/ads/accounts', handle(async (req) => {
    healOrphanedAdsAccounts(workspace(req));
    return listAdsAccounts(workspace(req)).map(a => ({
      ...a, customer_id_formatted: formatCustomerId(a.customer_id), connection_lost: isOrphanedAdsAccount(a),
      pending_approvals: listChanges({ workspaceIds: [a.workspace_id], adsAccountId: a.id, status: 'needs_approval', limit: 100 }).length,
    }));
  }));

  app.post('/api/ads/accounts', handle(async (req) => {
    const ws = workspace(req);
    assertCanChangeAds(user(req), ws);
    const body = (req.body ?? {}) as { googleAccountId?: string; customerId?: string; loginCustomerId?: string | null; monthlyBudget?: number | null };
    if (!body.googleAccountId || !body.customerId) throw Object.assign(new Error('googleAccountId and customerId are required.'), { statusCode: 400 });
    const linked = await verifyAndLinkAccount({
      workspaceId: ws, googleAccountId: body.googleAccountId, customerId: body.customerId,
      loginCustomerId: body.loginCustomerId ?? null, userId: user(req).id,
      monthlyBudget: body.monthlyBudget === undefined || body.monthlyBudget === null ? null : Number(body.monthlyBudget),
    });
    recordAuditEvent({ actorUserId: actor(req).id, workspaceId: ws, action: 'google_ads.account_linked', detail: { accountId: linked.id, customerId: linked.customer_id } });
    return linked;
  }));

  app.patch('/api/ads/accounts/:id', handle(async (req) => {
    const acc = accountInWorkspace(req, (req.params as { id: string }).id);
    assertCanChangeAds(user(req), acc.workspace_id);
    const body = (req.body ?? {}) as { monthlyBudget?: number | null; brief?: unknown; guardrails?: unknown; enabled?: boolean; ga4PropertyId?: string | null };
    const monthlyBudget = body.monthlyBudget === undefined ? undefined : body.monthlyBudget === null ? null : Number(body.monthlyBudget);
    // Link the GA4 property first: it is verified against Google and may fail,
    // and nothing else should be saved if it does.
    const ga4Changed = body.ga4PropertyId !== undefined && (body.ga4PropertyId || null) !== acc.ga4_property_id;
    if (ga4Changed) await linkGa4Property(acc, body.ga4PropertyId);
    const updated = updateAdsAccount(acc.id, { monthlyBudget, brief: body.brief, guardrails: body.guardrails, enabled: body.enabled });
    if (ga4Changed) {
      recordAuditEvent({ actorUserId: actor(req).id, workspaceId: acc.workspace_id, action: 'google_ads.ga4_linked', detail: { accountId: acc.id, ga4PropertyId: updated?.ga4_property_id ?? null } });
    }
    if (body.guardrails !== undefined || monthlyBudget !== undefined) {
      recordAuditEvent({ actorUserId: actor(req).id, workspaceId: acc.workspace_id, action: 'google_ads.guardrails_updated', detail: { accountId: acc.id, monthlyBudget: updated?.monthly_budget, guardrails: updated?.guardrails } });
    }
    return updated;
  }));

  // Move a client to another Google connection (another user, or the same user through another Cloud project).
  app.post('/api/ads/accounts/:id/connection', handle(async (req) => {
    const acc = accountInWorkspace(req, (req.params as { id: string }).id);
    assertCanChangeAds(user(req), acc.workspace_id);
    const { googleAccountId } = (req.body ?? {}) as { googleAccountId?: string };
    if (!googleAccountId) throw Object.assign(new Error('googleAccountId is required.'), { statusCode: 400 });
    const moved = await moveAdsAccount(acc, googleAccountId, user(req).id);
    recordAuditEvent({ actorUserId: actor(req).id, workspaceId: acc.workspace_id, action: 'google_ads.account_moved', detail: { accountId: acc.id, from: acc.google_account_id, to: moved.google_account_id } });
    return moved;
  }));

  app.delete('/api/ads/accounts/:id', handle(async (req) => {
    const acc = accountInWorkspace(req, (req.params as { id: string }).id);
    assertCanChangeAds(user(req), acc.workspace_id);
    unlinkAdsAccount(acc.id);
    recordAuditEvent({ actorUserId: actor(req).id, workspaceId: acc.workspace_id, action: 'google_ads.account_unlinked', detail: { accountId: acc.id, customerId: acc.customer_id } });
    return { ok: true };
  }));

  app.get('/api/ads/accounts/:id/overview', handle(async (req) => {
    const acc = accountInWorkspace(req, (req.params as { id: string }).id);
    const { days, fresh } = req.query as { days?: string; fresh?: string };
    return accountOverview(acc, Number(days) || 30, { fresh: fresh === '1' || fresh === 'true' });
  }));

  app.get('/api/ads/accounts/:id/audit', handle(async (req) => auditAccount(accountInWorkspace(req, (req.params as { id: string }).id))));

  app.get('/api/ads/accounts/:id/search-terms', handle(async (req) => {
    const acc = accountInWorkspace(req, (req.params as { id: string }).id);
    const q = req.query as { days?: string; minCost?: string; wasteOnly?: string };
    return searchTerms(acc, { days: Number(q.days) || 30, minCost: q.minCost ? Number(q.minCost) : undefined, withoutConversionsOnly: q.wasteOnly === '1' || q.wasteOnly === 'true', limit: 200 });
  }));

  app.get('/api/ads/accounts/:id/recommendations', handle(async (req) => ({
    recommendations: await listRecommendations(accountInWorkspace(req, (req.params as { id: string }).id)),
  })));

  app.post('/api/ads/accounts/:id/recommendations', handle(async (req) => {
    const acc = accountInWorkspace(req, (req.params as { id: string }).id);
    assertCanChangeAds(user(req), acc.workspace_id);
    const body = (req.body ?? {}) as { action?: 'apply' | 'dismiss'; resourceNames?: string[] };
    if (body.action !== 'apply' && body.action !== 'dismiss') throw Object.assign(new Error('action must be apply or dismiss.'), { statusCode: 400 });
    const change = await proposeRecommendations({ account: acc, userId: user(req).id, source: 'ui', action: body.action, resourceNames: body.resourceNames ?? [], rationale: 'Decided on the dashboard.' });
    // A person asked for this on the dashboard, so it is applied straight away unless blocked.
    if (change.status === 'blocked') return change;
    return applyChange(change.id, { userId: user(req).id, approvedByPerson: true });
  }));

  // ── Changes ────────────────────────────────────────────────────────────────
  app.get('/api/ads/changes', handle(async (req) => {
    const q = req.query as { accountId?: string; status?: string; limit?: string };
    const statuses = q.status ? q.status.split(',') as ChangeStatus[] : undefined;
    return listChanges({ workspaceIds: [workspace(req)], adsAccountId: q.accountId || undefined, status: statuses, limit: Number(q.limit) || 100 });
  }));

  const changeInWorkspace = (req: FastifyRequest) => {
    const change = getChange((req.params as { id: string }).id);
    if (!change || change.workspace_id !== workspace(req)) throw Object.assign(new Error('Change not found.'), { statusCode: 404 });
    assertCanChangeAds(user(req), change.workspace_id);
    return change;
  };

  // One change, with its client, for the approval page that notification links open.
  app.get('/api/ads/changes/:id', handle(async (req) => {
    const change = getChange((req.params as { id: string }).id);
    if (!change || change.workspace_id !== workspace(req)) throw Object.assign(new Error('Change not found.'), { statusCode: 404 });
    const account = getAdsAccount(change.ads_account_id);
    return { ...change, account: account ? { id: account.id, name: account.name, customer_id: formatCustomerId(account.customer_id), currency: account.currency } : null };
  }));

  // Approving a change (or applying a pending one) is a person deciding on the dashboard.
  app.post('/api/ads/changes/:id/approve', handle(async (req) => {
    const change = changeInWorkspace(req);
    const applied = await applyChange(change.id, { userId: user(req).id, approvedByPerson: true });
    recordAuditEvent({ actorUserId: actor(req).id, workspaceId: change.workspace_id, action: 'google_ads.change_approved', detail: { changeId: change.id, summary: change.summary } });
    return applied;
  }));

  app.post('/api/ads/changes/:id/reject', handle(async (req) => {
    const change = changeInWorkspace(req);
    const rejected = rejectChange(change.id, user(req).id);
    recordAuditEvent({ actorUserId: actor(req).id, workspaceId: change.workspace_id, action: 'google_ads.change_rejected', detail: { changeId: change.id, summary: change.summary } });
    return rejected;
  }));

  app.post('/api/ads/changes/:id/revert', handle(async (req) => {
    const change = changeInWorkspace(req);
    return revertChange(change.id, { userId: user(req).id, source: 'ui' });
  }));

  // ── Routine ────────────────────────────────────────────────────────────────
  app.get('/api/ads/routine-runs', handle(async (req) => {
    const q = req.query as { accountId?: string; limit?: string };
    return listRoutineRuns({ workspaceIds: [workspace(req)], adsAccountId: q.accountId || undefined, limit: Number(q.limit) || 20 });
  }));

  app.get('/api/ads/routine', handle(async (req) => {
    const ws = workspace(req);
    let saved: unknown = null;
    try { saved = JSON.parse(getWorkspaceSetting(ws, ROUTINE_KEY) ?? 'null'); } catch { saved = null; }
    const value = (saved ?? {}) as { settings?: unknown; account_ids?: string[]; connector_name?: string };
    return {
      settings: normalizeRoutine(value.settings ?? DEFAULT_ROUTINE),
      account_ids: Array.isArray(value.account_ids) ? value.account_ids : [],
      connector_name: value.connector_name ?? 'SEO Website Indexer',
      focus_areas: FOCUS_AREAS,
      endpoint: `${publicOrigin(req)}/mcp`,
    };
  }));

  /**
   * Save the questionnaire and build the prompt. Answers about each client
   * (budget, goal, targets, competitors…) are saved onto that client so the
   * dashboard, the guardrails and future prompts all use the same values.
   */
  app.post('/api/ads/routine/prompt', handle(async (req) => {
    const ws = workspace(req);
    const body = (req.body ?? {}) as {
      settings?: unknown; accountIds?: string[]; connectorName?: string;
      clients?: Record<string, { monthlyBudget?: number | null; brief?: unknown }>;
    };
    const settings = normalizeRoutine(body.settings);
    const ids = Array.isArray(body.accountIds) ? body.accountIds : [];
    const accounts = ids.map(id => accountInWorkspace(req, id));
    const needsWrite = accounts.length > 0;
    if (needsWrite) assertCanChangeAds(user(req), ws);
    for (const acc of accounts) {
      const answers = body.clients?.[acc.id];
      updateAdsAccount(acc.id, {
        monthlyBudget: answers?.monthlyBudget === undefined ? undefined : answers.monthlyBudget === null ? null : Number(answers.monthlyBudget),
        brief: answers?.brief === undefined ? undefined : answers.brief,
        // The routine mode is enforced on the server: "propose" puts the client in review mode;
        // autopilot keeps a client that auto-approves everything as it is.
        guardrails: acc.guardrails.mode === 'read_only' ? undefined
          : { mode: settings.mode === 'propose' ? 'review' : acc.guardrails.mode === 'auto' ? 'auto' : 'guarded' },
      });
    }
    const connectorName = (body.connectorName ?? '').trim().slice(0, 100) || 'SEO Website Indexer';
    setWorkspaceSetting(ws, ROUTINE_KEY, JSON.stringify({ settings, account_ids: ids, connector_name: connectorName }));
    const origin = publicOrigin(req);
    const fresh = ids.map(id => getAdsAccount(id)!).filter(Boolean);
    return buildRoutinePrompt({
      settings, accounts: fresh, connectorName, endpoint: `${origin}/mcp`, dashboardUrl: `${origin}/w/${encodeURIComponent(workspaceSlug(ws))}/ads?tab=changes`,
      workspaceName: getWorkspace(ws)?.name ?? null,
    });
  }));
}
