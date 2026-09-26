/**
 * Ranking Playbook routes.
 *
 * Site-scoped routes live under /api/sites/:id/playbook so the site-tenancy
 * preHandler (404 outside the active workspace) and the manage_sites write
 * gate apply. The workspace summary is read-only and filters by the active
 * workspace itself.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getSiteById, getSitesForWorkspace, getQuotaUsage, incrementQuota, type Site } from '../db/database.js';
import type { User } from '../auth/users.js';
import { canUseAiCitations, workspaceRole } from '../auth/workspaces.js';
import { getPlaybook, getPlaybookRun, listOpportunities, getOpportunity, refreshPlaybook, setOpportunityStatus, sendToWork, saveDraft, type StoredOpportunity } from '../analytics/playbook.js';
import { draftPlaybookFix } from '../ai/playbook-draft.js';
import { generationProvider } from '../ai/complete.js';
import { getQueryPageSync } from '../analytics/query-page-performance.js';

const AI_DRAFT_DAILY_LIMIT = parseInt(process.env.AI_DRAFT_DAILY_LIMIT ?? '25', 10);

type Ctx = { ctx: { user: User; workspaceId: string | null } };
const context = (req: FastifyRequest) => (req as unknown as Ctx).ctx;

function siteFor(req: FastifyRequest): Site {
  const site = getSiteById((req.params as { id: string }).id);
  if (!site) throw Object.assign(new Error('Site not found'), { statusCode: 404 });
  return site;
}

/** Same shape as the citation cap: members need AI access; non-owners share a daily allowance. */
function assertDraftAllowed(req: FastifyRequest): void {
  const { user, workspaceId } = context(req);
  if (user.is_super_admin) return;
  if (!workspaceId) throw Object.assign(new Error('No workspace selected.'), { statusCode: 400 });
  if (!canUseAiCitations(user, workspaceId)) {
    throw Object.assign(new Error('AI drafting is disabled for your account in this workspace. Ask a workspace admin.'), { statusCode: 403 });
  }
  if (workspaceRole(user, workspaceId) === 'owner') return;
  const used = getQuotaUsage('ai_playbook_draft', `user:${user.id}`);
  if (used + 1 > AI_DRAFT_DAILY_LIMIT) {
    throw Object.assign(new Error(`Daily AI draft limit reached (${AI_DRAFT_DAILY_LIMIT}/day). Ask a super-admin if you need more.`), { statusCode: 429 });
  }
}

/** Only a produced draft counts against the daily allowance. */
function recordDraftUse(req: FastifyRequest): void {
  const { user, workspaceId } = context(req);
  if (user.is_super_admin || !workspaceId || workspaceRole(user, workspaceId) === 'owner') return;
  incrementQuota('ai_playbook_draft', `user:${user.id}`);
}

const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

export function registerPlaybookRoutes(app: FastifyInstance): void {
  app.get('/api/sites/:id/playbook', async (req, reply) => {
    const site = siteFor(req);
    return getPlaybook(site.id) ?? reply.code(404).send({ error: 'Site not found' });
  });

  app.post('/api/sites/:id/playbook/refresh', async (req, reply) => {
    const site = siteFor(req);
    if (!site.google_account_id) return reply.code(400).send({ error: 'Link a Google account and Search Console property to this website first.' });
    // A fresh window within the last ten minutes is reused: each refresh spends Search Console quota.
    const sync = getQueryPageSync(site.id);
    const fresh = !!sync?.success_at && !sync.error && Date.now() - Date.parse(sync.success_at) < REFRESH_COOLDOWN_MS;
    await refreshPlaybook(site, Date.now(), !fresh);
    return getPlaybook(site.id);
  });

  app.post('/api/sites/:id/playbook/:oppId/status', async (req, reply) => {
    const site = siteFor(req);
    const { status } = (req.body ?? {}) as { status?: string };
    if (status !== 'open' && status !== 'dismissed' && status !== 'done') return reply.code(400).send({ error: 'Choose open, dismissed or done.' });
    const opportunity = setOpportunityStatus(site, (req.params as { oppId: string }).oppId, status);
    return opportunity ? { opportunity } : reply.code(404).send({ error: 'Opportunity not found' });
  });

  // Bulk actions from the table's selection: each item is handled on its own so one failure never blocks the rest.
  app.post('/api/sites/:id/playbook/bulk', async (req, reply) => {
    const site = siteFor(req);
    const body = (req.body ?? {}) as { ids?: unknown; action?: string };
    const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === 'string').slice(0, 200) : [];
    const action = body.action;
    if (!ids.length || !['open', 'dismissed', 'done', 'send-to-work'].includes(action ?? '')) {
      return reply.code(400).send({ error: 'Choose at least one opportunity and an action: open, dismissed, done or send-to-work.' });
    }
    if (action === 'send-to-work' && !site.workspace_id) return reply.code(400).send({ error: 'This website is not in a workspace.' });
    const opportunities: StoredOpportunity[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of ids) {
      try {
        const o = action === 'send-to-work' ? sendToWork(site, id) : setOpportunityStatus(site, id, action as 'open' | 'dismissed' | 'done');
        if (o) opportunities.push(o); else failed.push({ id, error: 'Opportunity not found' });
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : 'Failed' });
      }
    }
    return { opportunities, failed };
  });

  app.post('/api/sites/:id/playbook/:oppId/send-to-work', async (req, reply) => {
    const site = siteFor(req);
    if (!site.workspace_id) return reply.code(400).send({ error: 'This website is not in a workspace.' });
    const opportunity = sendToWork(site, (req.params as { oppId: string }).oppId);
    return opportunity ? { opportunity } : reply.code(404).send({ error: 'Opportunity not found' });
  });

  app.post('/api/sites/:id/playbook/:oppId/draft', async (req, reply) => {
    const site = siteFor(req);
    const o = getOpportunity(site.id, (req.params as { oppId: string }).oppId);
    if (!o) return reply.code(404).send({ error: 'Opportunity not found' });
    try {
      if (!generationProvider(site.workspace_id ?? null)) {
        return reply.code(400).send({ error: 'No AI provider is configured. Add an OpenAI, Anthropic, Gemini, xAI or Perplexity key under Settings → API keys.' });
      }
      assertDraftAllowed(req);
      const brandTerms = getPlaybookRun(site.id)?.summary.brandTerms ?? [];
      const draft = await draftPlaybookFix(site, o, brandTerms, context(req).user.id);
      recordDraftUse(req);
      saveDraft(site.id, o.id, draft as unknown as Record<string, unknown>);
      return { opportunity: getOpportunity(site.id, o.id) };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
        ?? ((e as { name?: string }).name === 'TimeoutError' ? 504 : 502);
      const message = e instanceof Error ? e.message : 'AI draft failed';
      const keyProblem = /HTTP 401|HTTP 403|API key not valid|invalid_api_key|Incorrect API key/i.test(message);
      // Provider bodies stay in the server log; the person sees a plain reason.
      const providerFailure = status >= 500 && /HTTP \d{3}/.test(message);
      if (providerFailure) console.warn(`[playbook] draft failed for ${site.domain}: ${message}`);
      return reply.code(keyProblem ? 400 : status).send({
        error: keyProblem ? 'The AI provider rejected the API key. Check Settings → API keys.' : providerFailure ? 'The AI provider returned an error. Try again in a minute.' : message,
      });
    }
  });

  // Workspace summary for the Insights landing card and the dashboard panel.
  app.get('/api/playbook/summary', async (req) => {
    const ws = context(req).workspaceId;
    const sites = ws ? getSitesForWorkspace(ws) : [];
    return {
      sites: sites.map(site => {
        const run = getPlaybookRun(site.id);
        const top = listOpportunities(site.id, { status: ['open'] }).filter(o => o.counted && !o.hidden).slice(0, 3)
          .map(o => ({ id: o.id, kind: o.kind, page: o.page, headline: o.headline, low: o.low, high: o.high, effort: o.effort, confidence: o.confidence }));
        return { id: site.id, name: site.name, domain: site.domain, computedAt: run?.computed_at ?? null, summary: run?.summary ?? null, top };
      }),
    };
  });
}
