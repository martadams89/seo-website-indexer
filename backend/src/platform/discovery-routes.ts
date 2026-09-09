import { discoverLinks } from './link-discovery.js';
import { searchStore, fetchStoreListing } from './app-store-search.js';
import { loadSearchOpportunities } from './search-sync.js';
import { compareCrawlImports } from './crawl-comparison.js';
import {
  importCrawlCandidates,
  listCrawlCandidates,
  reviewCrawlCandidate,
  saveCandidateNotes,
  crawlImportHistory,
} from './crawl-candidates.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getSitesForWorkspace, getDb } from '../db/database.js';
import { recordAuditEvent, type User } from '../auth/users.js';
import {
  startAuditJob,
  getAuditJob,
  latestAuditJob,
  recoverAuditJobs,
  cancelAuditJob,
} from './audit-jobs.js';
import { auditView } from './discovery-store.js';
import { listAppListings, saveAppListing, validateListing, listingHistory } from './aso.js';
import { listBacklinks, importBacklinks, checkBacklinks, backlinkHistory } from './backlinks.js';
import { createWorkItem } from './store.js';
import { listDocuments, saveDocument, measureDocument } from './planning.js';
import { searchOpportunities } from './search-opportunities.js';
const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function scope(req: FastifyRequest) {
  const ctx = (req as unknown as { ctx: { workspaceId: string | null; user: User } }).ctx;
  if (!ctx?.workspaceId) throw bad('No workspace selected');
  return { workspaceId: ctx.workspaceId, user: ctx.user };
}
function site(req: FastifyRequest, value: unknown) {
  const { workspaceId } = scope(req);
  if (typeof value !== 'string') throw bad('Select a site');
  const result = getSitesForWorkspace(workspaceId).find((s) => s.id === value);
  if (!result) throw bad('Site not found', 404);
  return result;
}
const body = (req: FastifyRequest): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
export function registerDiscoveryRoutes(app: FastifyInstance) {
  app.post('/api/platform/discovery/links/discover', async (req) => {
    const b = body(req);
    return discoverLinks(scope(req).workspaceId, site(req, b.site_id), b.query ?? '', b.monitor === true);
  });
  app.post('/api/platform/discovery/stores/search', async (req) => {
    scope(req);
    const b = body(req);
    return searchStore(b.platform, b.query, b.country, b.language);
  });
  app.post('/api/platform/discovery/stores/lookup', async (req) => {
    scope(req);
    const b = body(req);
    return fetchStoreListing(b.platform, b.id, b.country, b.language);
  });
  app.post('/api/platform/discovery/opportunities/sync', async (req) =>
    loadSearchOpportunities(scope(req).workspaceId, site(req, body(req).site_id), true),
  );
  app.get('/api/platform/discovery/candidates/compare', async (req) => {
    const q = req.query as { site_id?: string; before_id?: string; after_id?: string };
    const s = site(req, q.site_id);
    if (typeof q.before_id !== 'string' || typeof q.after_id !== 'string') throw bad('Choose two imports');
    return compareCrawlImports(scope(req).workspaceId, s.id, q.before_id, q.after_id);
  });
  app.post('/api/platform/discovery/candidates/:id/notes', async (req) =>
    saveCandidateNotes(scope(req).workspaceId, (req.params as { id: string }).id, body(req).notes),
  );
  app.post('/api/platform/discovery/candidates/bulk', async (req) => {
    const b = body(req);
    const s = site(req, b.site_id);
    if (
      !Array.isArray(b.ids) ||
      !b.ids.length ||
      b.ids.length > 50 ||
      b.ids.some((id) => typeof id !== 'string') ||
      !['promote', 'dismissed', 'pending'].includes(String(b.action))
    )
      throw bad('Choose 1–50 candidates and a supported action.');
    const results = [];
    for (const id of new Set(b.ids as string[])) {
      try {
        reviewCrawlCandidate(scope(req).workspaceId, s, id, String(b.action));
        results.push({ id, ok: true });
      } catch (error) {
        results.push({ id, ok: false, error: error instanceof Error ? error.message : 'Review failed' });
      }
    }
    return results;
  });
  app.post('/api/platform/discovery/candidates/:id/review', async (req) => {
    const b = body(req);
    const s = site(req, b.site_id);
    if (typeof b.action !== 'string') throw bad('Choose an action');
    return reviewCrawlCandidate(scope(req).workspaceId, s, (req.params as { id: string }).id, b.action);
  });
  app.get('/api/platform/discovery/candidates/imports', async (req) => {
    const s = site(req, (req.query as { site_id?: string }).site_id);
    return crawlImportHistory(scope(req).workspaceId, s.id);
  });
  app.get('/api/platform/discovery/candidates', async (req) => {
    const s = site(req, (req.query as { site_id?: string }).site_id);
    return listCrawlCandidates(scope(req).workspaceId, s.id);
  });
  app.post('/api/platform/discovery/candidates/import', { bodyLimit: 2_000_000 }, async (req) => {
    const b = body(req);
    const s = site(req, b.site_id);
    if (typeof b.text !== 'string' || typeof b.provenance !== 'string')
      throw bad('Provide NDJSON and a source label.');
    return importCrawlCandidates(scope(req).workspaceId, s, b.text, b.provenance, b.preview === true);
  });

  app.get('/api/platform/discovery/coverage', async (req) =>
    getSitesForWorkspace(scope(req).workspaceId).map((site) => {
      const audit = getDb()
        .prepare(
          "SELECT observed_at,json_array_length(report,'$.pages') pages,json_array_length(report,'$.failures') failures FROM discovery_runs WHERE workspace_id=? AND site_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 1",
        )
        .get(scope(req).workspaceId, site.id) as
        | { observed_at: string; pages: number; failures: number }
        | undefined;
      const links = getDb()
        .prepare(
          "SELECT COUNT(*) total,SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) present FROM backlinks WHERE workspace_id=? AND site_id=?",
        )
        .get(scope(req).workspaceId, site.id) as { total: number; present: number | null };
      const listings = getDb()
        .prepare('SELECT COUNT(*) count FROM app_listings WHERE workspace_id=? AND site_id=?')
        .get(scope(req).workspaceId, site.id) as { count: number };
      const search = getDb()
        .prepare("SELECT MAX(day) latest FROM perf_daily WHERE site_id=? AND engine='google'")
        .get(site.id) as { latest: string | null };
      return {
        id: site.id,
        name: site.name,
        domain: site.domain,
        enabled: site.enabled,
        audit: audit ?? null,
        backlinks: links.total,
        verified_backlinks: links.present ?? 0,
        listings: listings.count,
        search_latest: search.latest,
      };
    }),
  );
  recoverAuditJobs();
  app.get('/api/platform/discovery/documents/:id/measurement', async (req) =>
    measureDocument(scope(req).workspaceId, (req.params as { id: string }).id),
  );
  app.get('/api/platform/discovery/documents/:id/history', async (req) =>
    (
      getDb()
        .prepare(
          'SELECT r.id,r.body,r.observed_at FROM discovery_document_revisions r JOIN discovery_documents d ON d.id=r.document_id WHERE d.workspace_id=? AND d.id=? ORDER BY r.id DESC LIMIT 30',
        )
        .all(scope(req).workspaceId, (req.params as { id: string }).id) as Array<{
        id: number;
        body: string;
        observed_at: string;
      }>
    ).map((r) => ({ ...r, body: JSON.parse(r.body) })),
  );
  app.post('/api/platform/discovery/documents/:id/review', async (req, reply) => {
    const b = body(req);
    const s = site(req, b.site_id);
    const doc = listDocuments(scope(req).workspaceId, s.id, 'brief').find(
      (d) => d.id === (req.params as { id: string }).id,
    );
    if (!doc) return reply.code(404).send({ error: 'Brief not found' });
    return createWorkItem({
      workspaceId: scope(req).workspaceId,
      siteId: s.id,
      source: 'content_brief',
      sourceRef: doc.id,
      title: `Review content: ${doc.body.title}`,
      description: doc.body.query,
      evidence: { brief: doc.body },
      severity: 'low',
      deepLink: `/discovery?tab=content&site=${encodeURIComponent(s.id)}`,
    });
  });
  app.get('/api/platform/discovery/documents', async (req) => {
    const q = req.query as { site_id?: string; kind?: string };
    const s = site(req, q.site_id);
    if (!['brief', 'experiment'].includes(q.kind ?? '')) throw bad('Choose a document type');
    return listDocuments(scope(req).workspaceId, s.id, q.kind!);
  });
  app.post('/api/platform/discovery/documents', async (req) => {
    const b = body(req);
    const s = site(req, b.site_id);
    if (typeof b.kind !== 'string' || (b.id !== undefined && typeof b.id !== 'string'))
      throw bad('Invalid document');
    return saveDocument(scope(req).workspaceId, s.id, b.kind, b.body, b.id as string | undefined);
  });
  app.get('/api/platform/discovery/audits', async (req) => {
    const s = site(req, (req.query as { site_id?: string }).site_id);
    return auditView(scope(req).workspaceId, s.id, (req.query as { run_id?: string }).run_id);
  });
  app.post('/api/platform/discovery/audits', async (req, reply) => {
    const s = site(req, body(req).site_id);
    const ctx = scope(req);
    const limit = body(req).limit ?? 50;
    if (![10, 25, 50].includes(Number(limit))) throw bad('Choose a 10, 25 or 50 page sample.');
    const job = startAuditJob(ctx.workspaceId, s.id, Number(limit));
    recordAuditEvent({
      actorUserId: ctx.user.id,
      workspaceId: ctx.workspaceId,
      action: 'discovery.audit',
      detail: { site_id: s.id, job_id: job.id },
    });
    return reply.code(202).send(job);
  });
  app.get('/api/platform/discovery/jobs/current', async (req) =>
    latestAuditJob(scope(req).workspaceId, site(req, (req.query as { site_id?: string }).site_id).id),
  );
  app.post(
    '/api/platform/discovery/jobs/:id/cancel',
    async (req, reply) =>
      cancelAuditJob(scope(req).workspaceId, (req.params as { id: string }).id) ??
      reply.code(404).send({ error: 'Job not found' }),
  );
  app.get(
    '/api/platform/discovery/jobs/:id',
    async (req, reply) =>
      getAuditJob(scope(req).workspaceId, (req.params as { id: string }).id) ??
      reply.code(404).send({ error: 'Job not found' }),
  );
  app.get('/api/platform/discovery/opportunities', async (req) => {
    const value = (req.query as { site_id?: string }).site_id;
    return value
      ? loadSearchOpportunities(scope(req).workspaceId, site(req, value))
      : searchOpportunities(scope(req).workspaceId);
  });
  app.get('/api/platform/discovery/listings', async (req) => listAppListings(scope(req).workspaceId));
  app.post('/api/platform/discovery/listings', async (req) => {
    const b = body(req);
    const ctx = scope(req);
    const draft = validateListing(b.draft);
    const siteId = b.site_id ? site(req, b.site_id).id : null;
    if (b.id !== undefined && typeof b.id !== 'string') throw bad('Invalid listing ID');
    const result = saveAppListing(ctx.workspaceId, draft, siteId, b.id as string | undefined);
    recordAuditEvent({
      actorUserId: ctx.user.id,
      workspaceId: ctx.workspaceId,
      action: 'discovery.listing.save',
      detail: { id: result.id },
    });
    return result;
  });
  app.get('/api/platform/discovery/listings/:id/history', async (req) =>
    listingHistory(scope(req).workspaceId, (req.params as { id: string }).id),
  );
  for (const [resource, table] of [
    ['listings', 'app_listings'],
    ['documents', 'discovery_documents'],
  ] as const) {
    app.delete(`/api/platform/discovery/${resource}/:id`, async (req, reply) => {
      const ctx = scope(req);
      const id = (req.params as { id: string }).id;
      const removed = getDb()
        .prepare(`DELETE FROM ${table} WHERE workspace_id=? AND id=?`)
        .run(ctx.workspaceId, id).changes;
      if (!removed) return reply.code(404).send({ error: 'Draft not found' });
      recordAuditEvent({
        actorUserId: ctx.user.id,
        workspaceId: ctx.workspaceId,
        action: `discovery.${resource}.delete`,
        detail: { id },
      });
      return { ok: true };
    });
  }
  app.get('/api/platform/discovery/backlinks', async (req) => {
    const s = site(req, (req.query as { site_id?: string }).site_id);
    return listBacklinks(scope(req).workspaceId, s.id);
  });
  app.post('/api/platform/discovery/backlinks/import', async (req) => {
    const b = body(req);
    const s = site(req, b.site_id);
    if (typeof b.csv !== 'string' || typeof b.provenance !== 'string' || !b.provenance.trim())
      throw bad('CSV and a source label are required.');
    return importBacklinks(scope(req).workspaceId, s, b.csv, b.provenance.trim(), b.preview === true);
  });
  app.post('/api/platform/discovery/backlinks/check', async (req) => {
    const s = site(req, body(req).site_id);
    const id = body(req).id;
    if (id !== undefined && typeof id !== 'string') throw bad('Invalid backlink ID');
    return checkBacklinks(scope(req).workspaceId, s.id, false, id as string | undefined);
  });
  app.post('/api/platform/discovery/backlinks/:id/monitoring', async (req, reply) => {
    const b = body(req);
    if (typeof b.enabled !== 'boolean') throw bad('enabled must be a boolean');
    return getDb()
      .prepare('UPDATE backlinks SET enabled=? WHERE workspace_id=? AND id=?')
      .run(b.enabled ? 1 : 0, scope(req).workspaceId, (req.params as { id: string }).id).changes
      ? { ok: true }
      : reply.code(404).send({ error: 'Backlink not found' });
  });
  app.post('/api/platform/discovery/backlinks/:id/review', async (req, reply) => {
    const b = body(req);
    if (typeof b.notes !== 'string' || b.notes.length > 4000)
      throw bad('Notes must be text, up to 4000 characters.');
    const changed = getDb()
      .prepare('UPDATE backlinks SET notes=? WHERE workspace_id=? AND id=?')
      .run(b.notes, scope(req).workspaceId, (req.params as { id: string }).id).changes;
    return changed ? { ok: true } : reply.code(404).send({ error: 'Backlink not found' });
  });
  app.get('/api/platform/discovery/backlinks/:id/history', async (req) =>
    backlinkHistory(scope(req).workspaceId, (req.params as { id: string }).id),
  );
}
