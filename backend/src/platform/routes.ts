import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSiteById, getSitesForWorkspace, getWorkspaceSettings, setWorkspaceSetting } from '../db/database.js';
import { canAccessSiteInWorkspace, listWorkspaceMembers } from '../auth/workspaces.js';
import { recordAuditEvent, type User } from '../auth/users.js';
import {
  INTEGRATION_PROVIDERS, addAnnotation, assertWithinBudget, authenticateServiceToken, budgetStatus, bulkUpdateWorkItems,
  createContentAction, createIntegration, createServiceToken, createWebhook, createWorkItem, deleteBudget,
  deleteDashboardView, deleteIntegration, deleteLocalEntity, deleteWebhook, getContentAction, getIntegration, listBudgets,
  listContentActions, listDashboardViews, listIntegrations, listLocalEntities, listMetrics, listServiceTokens, listTimeline,
  listUsage, listWebhooks, listWorkItems, platformOverview, publicIntegration, recordMetric, recordUsage,
  revokeServiceToken, saveDashboardView, saveLocalEntity, updateContentAction, updateIntegration, updateWorkItem,
  upsertBudget, usageSummary, type IntegrationProvider,
} from './store.js';
import { publishContentAction, rollbackContentAction, stageContentAction, syncIntegrationById, verifyContentAction } from './connectors.js';
import { auditContentInventory } from './content-audit.js';
import { runPlatformAutomation } from './automation.js';
import { discoverEntityFromSite } from './entity-discovery.js';
import {
  createReportTemplate, defaultReportRecipients, deleteReportTemplate, generateReport, getReportRun,
  listReportRuns, listReportTemplates, sendWorkspaceDigest, updateReportTemplate,
} from './reports.js';

interface RequestContext { ctx: { user: User; impersonator: User | null; workspaceId: string | null } }
const context = (req: FastifyRequest) => (req as unknown as RequestContext).ctx;
function workspace(req: FastifyRequest): string {
  const value = context(req)?.workspaceId;
  if (!value) throw Object.assign(new Error('No workspace selected.'), { statusCode: 400 });
  return value;
}
const user = (req: FastifyRequest) => context(req).user;
const WORK_ITEM_STATUSES = ['open', 'in_progress', 'done', 'dismissed'];
const WORK_ITEM_SEVERITIES = ['critical', 'high', 'medium', 'low'];
const SERVICE_TOKEN_SCOPES = ['workspace:read', 'metrics:read', 'events:write', 'logs:write'];
function assertSite(req: FastifyRequest, siteId: string): void {
  if (!canAccessSiteInWorkspace(user(req), siteId, workspace(req))) throw Object.assign(new Error('Site not found'), { statusCode: 404 });
}
function serviceContext(req: FastifyRequest, reply: FastifyReply, scope: string) {
  const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const token = raw ? authenticateServiceToken(raw, scope) : null;
  if (!token) reply.code(401).send({ error: `A valid service token with the "${scope}" scope is required.` });
  return token;
}
function csvCell(value: unknown): string {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function registerPlatformRoutes(app: FastifyInstance): void {
  app.get('/api/platform/overview', async req => platformOverview(workspace(req)));

  app.get('/api/platform/integrations', async req => listIntegrations(workspace(req)).map(publicIntegration));
  app.post('/api/platform/integrations', async (req, reply) => {
    const ws = workspace(req); const body = (req.body ?? {}) as { provider?: IntegrationProvider; site_id?: string | null; name?: string; config?: Record<string, unknown>; cadence_minutes?: number };
    if (!body.provider || !INTEGRATION_PROVIDERS.includes(body.provider)) return reply.code(400).send({ error: 'A supported provider is required.' });
    if (body.site_id) assertSite(req, body.site_id);
    return publicIntegration(createIntegration({ workspaceId: ws, siteId: body.site_id, provider: body.provider, name: body.name,
      config: body.config, cadenceMinutes: body.cadence_minutes, createdBy: user(req).id }));
  });
  app.patch('/api/platform/integrations/:id', async (req, reply) => {
    const ws = workspace(req); const body = (req.body ?? {}) as { site_id?: string | null; name?: string; config?: Record<string, unknown>; enabled?: boolean; cadence_minutes?: number };
    if (body.site_id) assertSite(req, body.site_id);
    const row = updateIntegration(ws, (req.params as { id: string }).id, { siteId: body.site_id, name: body.name, config: body.config, enabled: body.enabled, cadenceMinutes: body.cadence_minutes });
    return row ? publicIntegration(row) : reply.code(404).send({ error: 'Integration not found' });
  });
  app.delete('/api/platform/integrations/:id', async (req, reply) => deleteIntegration(workspace(req), (req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'Integration not found' }));
  app.post('/api/platform/integrations/:id/sync', async (req, reply) => {
    try { return await syncIntegrationById(workspace(req), (req.params as { id: string }).id); }
    catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : 'Integration sync failed' }); }
  });

  app.get('/api/platform/metrics', async req => {
    const query = req.query as { source?: string; metric?: string; site_id?: string; from?: string; to?: string; limit?: string };
    if (query.site_id) assertSite(req, query.site_id);
    return listMetrics(workspace(req), { source: query.source, metric: query.metric, siteId: query.site_id, from: query.from, to: query.to, limit: Number(query.limit) || 1000 });
  });
  app.get('/api/platform/metrics/export.csv', async (req, reply) => {
    const query = req.query as { from?: string; to?: string }; const rows = listMetrics(workspace(req), { from: query.from, to: query.to, limit: 5000 });
    const columns = ['observed_at','source','site_id','metric','dimension','value','unit','provenance'];
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="organic-evidence.csv"');
    return [columns.join(','), ...rows.map(row => columns.map(column => csvCell((row as unknown as Record<string, unknown>)[column])).join(','))].join('\n');
  });

  app.get('/api/platform/work-items', async req => {
    const query = req.query as { status?: string; assignee?: string; include_snoozed?: string; limit?: string };
    return listWorkItems(workspace(req), { status: query.status, assignee: query.assignee, includeSnoozed: query.include_snoozed === 'true', limit: Number(query.limit) || 200 });
  });
  app.post('/api/platform/work-items', async (req, reply) => {
    const ws = workspace(req); const body = (req.body ?? {}) as { site_id?: string; title?: string; description?: string; severity?: string; assignee_user_id?: string; due_at?: string; deep_link?: string };
    if (!body.title?.trim()) return reply.code(400).send({ error: 'Title is required.' });
    if (body.severity && !WORK_ITEM_SEVERITIES.includes(body.severity)) return reply.code(400).send({ error: 'Severity is invalid.' });
    if (body.site_id) assertSite(req, body.site_id);
    if (body.assignee_user_id && !listWorkspaceMembers(ws).some(member => member.user_id === body.assignee_user_id)) return reply.code(400).send({ error: 'Assignee is not a workspace member.' });
    return createWorkItem({ workspaceId: ws, siteId: body.site_id, source: 'manual', title: body.title, description: body.description, severity: body.severity, assigneeUserId: body.assignee_user_id, dueAt: body.due_at, deepLink: body.deep_link });
  });
  app.patch('/api/platform/work-items/:id', async (req, reply) => {
    const ws = workspace(req); const body = (req.body ?? {}) as { status?: string; assignee_user_id?: string | null; due_at?: string | null; snoozed_until?: string | null; severity?: string };
    if (body.assignee_user_id && !listWorkspaceMembers(ws).some(member => member.user_id === body.assignee_user_id)) return reply.code(400).send({ error: 'Assignee is not a workspace member.' });
    if (body.status && !WORK_ITEM_STATUSES.includes(body.status)) return reply.code(400).send({ error: 'Status is invalid.' });
    if (body.severity && !WORK_ITEM_SEVERITIES.includes(body.severity)) return reply.code(400).send({ error: 'Severity is invalid.' });
    return updateWorkItem(ws, (req.params as { id: string }).id, { status: body.status, assigneeUserId: body.assignee_user_id, dueAt: body.due_at, snoozedUntil: body.snoozed_until, severity: body.severity })
      ?? reply.code(404).send({ error: 'Work item not found' });
  });
  app.post('/api/platform/work-items/bulk', async (req, reply) => {
    const ws = workspace(req); const body = (req.body ?? {}) as { ids?: string[]; changes?: { status?: string; assignee_user_id?: string | null; due_at?: string | null; snoozed_until?: string | null; severity?: string }; preview?: boolean };
    const ids = [...new Set(body.ids ?? [])].slice(0, 200); if (!ids.length) return reply.code(400).send({ error: 'Select at least one work item.' });
    if (body.changes?.status && !WORK_ITEM_STATUSES.includes(body.changes.status)) return reply.code(400).send({ error: 'Status is invalid.' });
    if (body.changes?.severity && !WORK_ITEM_SEVERITIES.includes(body.changes.severity)) return reply.code(400).send({ error: 'Severity is invalid.' });
    if (body.changes?.assignee_user_id && !listWorkspaceMembers(ws).some(member => member.user_id === body.changes!.assignee_user_id)) return reply.code(400).send({ error: 'Assignee is not a workspace member.' });
    const current = listWorkItems(ws, { includeSnoozed: true, limit: 500 }).filter(item => ids.includes(item.id));
    if (body.preview) return { preview: true, affected: current.length, items: current };
    const changes = body.changes ?? {}; return { updated: bulkUpdateWorkItems(ws, ids, { status: changes.status, assigneeUserId: changes.assignee_user_id, dueAt: changes.due_at, snoozedUntil: changes.snoozed_until, severity: changes.severity }) };
  });

  app.get('/api/platform/timeline', async req => listTimeline(workspace(req), Number((req.query as { limit?: string }).limit) || 200));
  app.post('/api/platform/annotations', async (req, reply) => {
    const body = (req.body ?? {}) as { site_id?: string; kind?: string; title?: string; note?: string; event_at?: string; metadata?: Record<string, unknown> };
    if (!body.title?.trim()) return reply.code(400).send({ error: 'Title is required.' }); if (body.site_id) assertSite(req, body.site_id);
    return { id: addAnnotation({ workspaceId: workspace(req), siteId: body.site_id, userId: user(req).id, kind: body.kind, title: body.title, note: body.note, eventAt: body.event_at, metadata: body.metadata }) };
  });

  app.get('/api/platform/views', async req => listDashboardViews(workspace(req), user(req).id));
  app.post('/api/platform/views', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string; name?: string; config?: Record<string, unknown>; is_default?: boolean };
    if (!body.name?.trim()) return reply.code(400).send({ error: 'View name is required.' });
    return { id: saveDashboardView({ workspaceId: workspace(req), userId: user(req).id, id: body.id, name: body.name, config: body.config ?? {}, isDefault: body.is_default }) };
  });
  app.delete('/api/platform/views/:id', async (req, reply) => deleteDashboardView(workspace(req), user(req).id, (req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'Saved view not found' }));

  app.get('/api/platform/entities', async req => listLocalEntities(workspace(req)));
  app.post('/api/platform/entities/discover', async (req, reply) => {
    const body = (req.body ?? {}) as { site_id?: string };
    if (!body.site_id) return reply.code(400).send({ error: 'Choose a website to scan.' });
    assertSite(req, body.site_id);
    const site = getSiteById(body.site_id);
    if (!site) return reply.code(404).send({ error: 'Site not found.' });
    try {
      const result = await discoverEntityFromSite(site);
      recordUsage({ workspace_id: workspace(req), user_id: user(req).id, provider: 'internal', operation: 'entity.discover', quantity: 1, unit: 'page', estimated_cost: 0, metadata: { site_id: site.id, source_url: result.source_url } });
      return result;
    } catch (error) {
      return reply.code(422).send({ error: error instanceof Error ? error.message : 'Website discovery failed.' });
    }
  });
  app.post('/api/platform/entities', async (req, reply) => {
    const ws = workspace(req); const body = (req.body ?? {}) as { id?: string; site_id?: string | null; name?: string; market?: string; locale?: string; entity_type?: string; primary_url?: string | null; address?: string | null; phone?: string | null; identifiers?: Record<string,string>; listings?: Array<{provider:string;url?:string;status?:string;rating?:number;review_count?:number}>; knowledge?: Record<string,unknown>; review_rating?: number | null; review_count?: number | null };
    if (!body.name?.trim() || !body.market?.trim()) return reply.code(400).send({ error: 'Entity name and market are required.' });
    if (body.site_id) assertSite(req, body.site_id);
    return saveLocalEntity({ id: body.id, workspaceId: ws, siteId: body.site_id, name: body.name, market: body.market, locale: body.locale, entityType: body.entity_type, primaryUrl: body.primary_url, address: body.address, phone: body.phone, identifiers: body.identifiers, listings: body.listings, knowledge: body.knowledge, reviewRating: body.review_rating, reviewCount: body.review_count });
  });
  app.delete('/api/platform/entities/:id', async (req, reply) => deleteLocalEntity(workspace(req), (req.params as {id:string}).id) ? { ok:true } : reply.code(404).send({error:'Entity not found'}));

  app.get('/api/platform/reports/templates', async req => listReportTemplates(workspace(req)));
  app.post('/api/platform/reports/templates', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; sections?: string[]; branding?: { title?: string; logo_url?: string; accent?: string; footer?: string }; recipients?: string[]; cadence?: string };
    if (!body.name?.trim()) return reply.code(400).send({ error: 'Template name is required.' }); const ws = workspace(req);
    return createReportTemplate({ workspaceId: ws, userId: user(req).id, name: body.name, sections: body.sections, branding: body.branding, recipients: body.recipients ?? defaultReportRecipients(ws), cadence: body.cadence });
  });
  app.patch('/api/platform/reports/templates/:id', async (req, reply) => updateReportTemplate(workspace(req), (req.params as { id: string }).id, req.body as Parameters<typeof updateReportTemplate>[2]) ?? reply.code(404).send({ error: 'Report template not found' }));
  app.delete('/api/platform/reports/templates/:id', async (req, reply) => deleteReportTemplate(workspace(req), (req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'Report template not found' }));
  app.get('/api/platform/reports/runs', async req => listReportRuns(workspace(req)));
  app.post('/api/platform/reports/generate', async req => {
    const body = (req.body ?? {}) as { template_id?: string; period_start?: string; period_end?: string; email?: boolean };
    const report = await generateReport(workspace(req), body.template_id, { periodStart: body.period_start, periodEnd: body.period_end, email: body.email });
    return { id: report.id, snapshot: report.snapshot, emailed: report.emailed };
  });
  app.get('/api/platform/reports/:id', async (req, reply) => {
    const report = getReportRun(workspace(req), (req.params as { id: string }).id); if (!report) return reply.code(404).send({ error: 'Report not found' });
    if ((req.query as { format?: string }).format === 'html') { reply.header('Content-Type', 'text/html; charset=utf-8'); return report.html; } return report.snapshot;
  });
  app.post('/api/platform/digest/send', async req => ({ sent: await sendWorkspaceDigest(workspace(req), true) }));

  app.get('/api/platform/usage', async req => { const query = req.query as { from?: string; to?: string }; const ws = workspace(req); return { summary: usageSummary(ws, query.from, query.to), ledger: listUsage(ws), budgets: budgetStatus(ws) }; });
  app.get('/api/platform/usage/export.csv', async (req, reply) => {
    const rows = listUsage(workspace(req), 5000); const columns = ['occurred_at','provider','operation','user_id','quantity','unit','estimated_cost','metadata'];
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="organic-billback.csv"');
    return [columns.join(','), ...rows.map(row => columns.map(column => csvCell((row as unknown as Record<string, unknown>)[column])).join(','))].join('\n');
  });
  app.get('/api/platform/budgets', async req => ({ policies: listBudgets(workspace(req)), status: budgetStatus(workspace(req)) }));
  app.post('/api/platform/budgets', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string; user_id?: string; provider?: string; period?: string; limit_value?: number; limit_unit?: string; warning_pct?: number; hard_limit?: boolean };
    if (body.limit_value == null || body.limit_value < 0) return reply.code(400).send({ error: 'A non-negative limit is required.' });
    if (body.user_id && !listWorkspaceMembers(workspace(req)).some(member => member.user_id === body.user_id)) return reply.code(400).send({ error: 'Budget user is not a workspace member.' });
    if (body.period && !['daily', 'monthly'].includes(body.period)) return reply.code(400).send({ error: 'Budget period is invalid.' });
    if (body.limit_unit && !['cost', 'quantity'].includes(body.limit_unit)) return reply.code(400).send({ error: 'Budget measure is invalid.' });
    return { id: upsertBudget({ id: body.id, workspaceId: workspace(req), userId: body.user_id, provider: body.provider, period: body.period, limitValue: body.limit_value, limitUnit: body.limit_unit, warningPct: body.warning_pct, hardLimit: body.hard_limit }) };
  });
  app.delete('/api/platform/budgets/:id', async (req, reply) => deleteBudget(workspace(req), (req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'Budget not found' }));

  app.get('/api/platform/webhooks', async req => listWebhooks(workspace(req)));
  app.post('/api/platform/webhooks', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; url?: string; events?: string[] }; if (!body.name?.trim() || !body.url?.trim()) return reply.code(400).send({ error: 'Name and URL are required.' });
    try { const target = new URL(body.url); if (!['http:', 'https:'].includes(target.protocol)) throw new Error('unsupported protocol'); }
    catch { return reply.code(400).send({ error: 'Webhook URL must use HTTP or HTTPS.' }); }
    return createWebhook({ workspaceId: workspace(req), name: body.name, url: body.url, events: body.events?.length ? body.events : ['*'] });
  });
  app.delete('/api/platform/webhooks/:id', async (req, reply) => deleteWebhook(workspace(req), (req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'Webhook not found' }));
  app.get('/api/platform/tokens', async req => listServiceTokens(workspace(req)));
  app.post('/api/platform/tokens', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; scopes?: string[]; expires_at?: string }; if (!body.name?.trim() || !body.scopes?.length) return reply.code(400).send({ error: 'Name and at least one scope are required.' });
    const scopes = [...new Set(body.scopes)]; if (scopes.some(scope => !SERVICE_TOKEN_SCOPES.includes(scope))) return reply.code(400).send({ error: 'One or more service-token scopes are invalid.' });
    return createServiceToken({ workspaceId: workspace(req), userId: user(req).id, name: body.name, scopes, expiresAt: body.expires_at });
  });
  app.delete('/api/platform/tokens/:id', async (req, reply) => revokeServiceToken(workspace(req), (req.params as { id: string }).id) ? { ok: true } : reply.code(404).send({ error: 'Token not found' }));

  app.get('/api/platform/content/actions', async req => listContentActions(workspace(req)));
  app.post('/api/platform/content/actions', async (req, reply) => {
    const ws = workspace(req); const body = (req.body ?? {}) as { site_id?: string; integration_id?: string; kind?: string; title?: string; rationale?: string; evidence?: Record<string, unknown>; payload?: Record<string, unknown> };
    if (!body.title?.trim() || !body.kind || !body.payload) return reply.code(400).send({ error: 'Kind, title and proposed payload are required.' });
    if (body.site_id) assertSite(req, body.site_id); if (body.integration_id && !getIntegration(ws, body.integration_id)) return reply.code(404).send({ error: 'Integration not found' });
    return createContentAction({ workspaceId: ws, siteId: body.site_id, integrationId: body.integration_id, userId: user(req).id, kind: body.kind, title: body.title, rationale: body.rationale, evidence: body.evidence, payload: body.payload });
  });
  app.post('/api/platform/content/actions/:id/approve', async (req, reply) => {
    const ws = workspace(req); const action = getContentAction(ws, (req.params as { id: string }).id); if (!action) return reply.code(404).send({ error: 'Content action not found' });
    if (action.status !== 'proposed') return reply.code(409).send({ error: 'Only proposed changes can be approved.' }); return updateContentAction(ws, action.id, { status: 'approved', approvedBy: user(req).id });
  });
  for (const [path, run] of [
    ['stage', stageContentAction], ['publish', publishContentAction], ['verify', verifyContentAction], ['rollback', rollbackContentAction],
  ] as const) app.post(`/api/platform/content/actions/:id/${path}`, async (req, reply) => {
    const action = getContentAction(workspace(req), (req.params as { id: string }).id); if (!action) return reply.code(404).send({ error: 'Content action not found' });
    try { return await run(action); } catch (error) { return reply.code(422).send({ error: error instanceof Error ? error.message : `${path} failed` }); }
  });
  app.post('/api/platform/content/audit', async req => { const body = (req.body ?? {}) as { site_id?: string; force?: boolean }; if (body.site_id) assertSite(req, body.site_id); return auditContentInventory(workspace(req), body.site_id, body.force ?? true); });
  app.post('/api/platform/automation/run', async () => runPlatformAutomation());

  const governanceKeys = ['digest_cadence','digest_recipients','alert_min_severity','workspace_mfa_required','retention_days','telemetry_enabled','brand_name','brand_logo_url','brand_accent','client_portal_enabled'];
  app.get('/api/platform/governance', async req => { const settings = getWorkspaceSettings(workspace(req)); return Object.fromEntries(governanceKeys.map(key => [key, settings[key] ?? ''])); });
  app.put('/api/platform/governance', async req => {
    const ws = workspace(req); const body = (req.body ?? {}) as Record<string, unknown>;
    for (const key of governanceKeys) if (body[key] !== undefined) {
      let value = typeof body[key] === 'string' ? String(body[key]).slice(0, 4000) : JSON.stringify(body[key]);
      if (key === 'digest_recipients') {
        let recipients: string[];
        if (Array.isArray(body[key])) recipients = body[key].map(String);
        else {
          try { const parsed = JSON.parse(value) as unknown; recipients = Array.isArray(parsed) ? parsed.map(String) : []; }
          catch { recipients = value.split(/[\s,]+/); }
        }
        value = JSON.stringify([...new Set(recipients.map(item => item.trim().toLowerCase()).filter(item => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)))].slice(0, 100));
      }
      setWorkspaceSetting(ws, key, value);
    }
    recordAuditEvent({ actorUserId: user(req).id, targetUserId: user(req).id, action: 'workspace.governance_updated', workspaceId: ws,
      detail: { keys: Object.keys(body).filter(key => governanceKeys.includes(key)) }, ipAddress: req.ip }); return { ok: true };
  });

  // Stable, scoped automation API. Cookie auth and CSRF are intentionally not
  // involved: every route requires a hashed bearer token with a matching scope.
  app.get('/api/v1/workspace', async (req, reply) => { const token = serviceContext(req, reply, 'workspace:read'); return token ? platformOverview(token.workspaceId) : undefined; });
  app.get('/api/v1/metrics', async (req, reply) => {
    const token = serviceContext(req, reply, 'metrics:read'); if (!token) return; const query = req.query as { source?: string; metric?: string; from?: string; to?: string; limit?: string };
    return listMetrics(token.workspaceId, { source: query.source, metric: query.metric, from: query.from, to: query.to, limit: Number(query.limit) || 1000 });
  });
  app.post('/api/v1/events', async (req, reply) => {
    const token = serviceContext(req, reply, 'events:write'); if (!token) return; const body = (req.body ?? {}) as { site_id?: string; source?: string; metric?: string; dimension?: string; value?: number; unit?: string; observed_at?: string; provenance?: Record<string, unknown> };
    if (!body.source || !body.metric || !Number.isFinite(body.value)) return reply.code(400).send({ error: 'source, metric and numeric value are required.' });
    if (body.site_id && !getSitesForWorkspace(token.workspaceId).some(site => site.id === body.site_id)) return reply.code(404).send({ error: 'Site not found' });
    assertWithinBudget({ workspaceId: token.workspaceId, userId: token.userId, provider: 'api', quantity: 1 });
    recordMetric({ workspace_id: token.workspaceId, site_id: body.site_id ?? null, source: body.source, metric: body.metric, dimension: body.dimension ?? '', value: body.value!, unit: body.unit ?? null, observed_at: body.observed_at ?? new Date().toISOString(), provenance: { service_token: true, ...(body.provenance ?? {}) } });
    recordUsage({ workspace_id: token.workspaceId, user_id: token.userId, provider: 'api', operation: 'events.write', quantity: 1, unit: 'event', estimated_cost: 0, metadata: { token_id: token.id } });
    return reply.code(202).send({ accepted: true });
  });
  app.post('/api/v1/logs/ingest', async (req, reply) => {
    const token = serviceContext(req, reply, 'logs:write'); if (!token) return; const events = (Array.isArray(req.body) ? req.body : [req.body]) as Array<{ site_id?: string; timestamp?: string; status?: number; path?: string; bot?: string; bytes?: number; response_ms?: number }>;
    assertWithinBudget({ workspaceId: token.workspaceId, userId: token.userId, provider: 'api', quantity: Math.min(events.length, 1000) });
    let accepted = 0; const siteIds = new Set(getSitesForWorkspace(token.workspaceId).map(site => site.id));
    for (const event of events.slice(0, 1000)) {
      if (event.site_id && !siteIds.has(event.site_id)) continue; const at = event.timestamp ?? new Date().toISOString(); const dimension = event.path ?? '';
      if (Number.isFinite(event.status)) recordMetric({ workspace_id: token.workspaceId, site_id: event.site_id ?? null, source: 'server_log', metric: 'requests', dimension, value: 1, unit: 'request', observed_at: at, provenance: { status: event.status, bot: event.bot } });
      if (Number.isFinite(event.bytes)) recordMetric({ workspace_id: token.workspaceId, site_id: event.site_id ?? null, source: 'server_log', metric: 'bytes', dimension, value: event.bytes!, unit: 'bytes', observed_at: at, provenance: { status: event.status, bot: event.bot } });
      if (Number.isFinite(event.response_ms)) recordMetric({ workspace_id: token.workspaceId, site_id: event.site_id ?? null, source: 'server_log', metric: 'response_ms', dimension, value: event.response_ms!, unit: 'ms', observed_at: at, provenance: { status: event.status, bot: event.bot } }); accepted++;
    }
    recordUsage({ workspace_id: token.workspaceId, user_id: token.userId, provider: 'api', operation: 'logs.ingest', quantity: accepted, unit: 'event', estimated_cost: 0, metadata: { token_id: token.id } });
    return reply.code(202).send({ accepted });
  });
}
