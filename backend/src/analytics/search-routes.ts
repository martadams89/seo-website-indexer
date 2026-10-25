/**
 * analytics/search-routes.ts — period comparison and content groups.
 * Site access is checked by the central site hook (/api/sites/:id and
 * /api/performance/:siteId are fenced to the active workspace); changes need
 * the manage_sites capability like other site routes.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getSiteById } from '../db/database.js';
import type { User } from '../auth/users.js';
import { comparePeriods, type CompareDimension, type CompareMode } from './compare.js';
import { contentGroupPerformance, deleteContentGroup, saveContentGroup } from './content-groups.js';

const actor = (req: FastifyRequest) => { const ctx = (req as unknown as { ctx: { user: User; impersonator: User | null } }).ctx; return ctx.impersonator ?? ctx.user; };

function site(id: string) {
  const s = getSiteById(id);
  if (!s) throw Object.assign(new Error('Site not found'), { statusCode: 404 });
  return s;
}

export function registerSearchRoutes(app: FastifyInstance): void {
  const fail = (e: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    const status = (e as { statusCode?: number }).statusCode;
    if (status) return reply.code(status).send({ error: (e as Error).message });
    return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
  };

  app.get('/api/performance/:siteId/compare', async (req, reply) => {
    const q = req.query as { start?: string; end?: string; days?: string; mode?: CompareMode; dimension?: CompareDimension; limit?: string };
    try {
      return await comparePeriods(site((req.params as { siteId: string }).siteId), {
        start: q.start, end: q.end, days: Number(q.days) || undefined, mode: q.mode,
        dimension: ['query', 'page', 'country', 'device'].includes(String(q.dimension)) ? q.dimension : 'query', limit: Number(q.limit) || undefined,
      });
    } catch (e) { return fail(e, reply); }
  });

  app.get('/api/sites/:id/content-groups', async (req) => {
    const s = site((req.params as { id: string }).id);
    return contentGroupPerformance(s.id, Number((req.query as { days?: string }).days) || 28);
  });

  app.post('/api/sites/:id/content-groups', async (req, reply) => {
    const s = site((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { id?: string; name?: string; include?: unknown; exclude?: unknown };
    try { return saveContentGroup(s.id, { id: body.id, name: body.name ?? '', include: body.include, exclude: body.exclude, userId: actor(req).id }); }
    catch (e) { return fail(e, reply); }
  });

  app.delete('/api/sites/:id/content-groups/:groupId', async (req, reply) => {
    const params = req.params as { id: string; groupId: string };
    return deleteContentGroup(site(params.id).id, params.groupId) ? { ok: true } : reply.code(404).send({ error: 'Content group not found' });
  });
}
