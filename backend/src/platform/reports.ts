import { randomUUID } from 'crypto';
import { getDb, getSitesForWorkspace, getWorkspaceSetting, setWorkspaceSetting } from '../db/database.js';
import { getWorkspace, listWorkspaceMembers } from '../auth/workspaces.js';
import { getCommandCenter } from '../analytics/command-center.js';
import { getAiInsights } from '../ai/citations.js';
import { sendEmail } from '../utils/email.js';
import { sendWorkspaceNotification } from '../utils/notify.js';
import { listMetrics, listTimeline, listWorkItems, platformOverview, usageSummary } from './store.js';

const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
};
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export interface ReportTemplate {
  id: string; workspace_id: string; name: string; sections: string[];
  branding: { title?: string; logo_url?: string; accent?: string; footer?: string };
  recipients: string[]; cadence: string; next_run_at: string | null; enabled: boolean;
  created_by: string | null; created_at: string; updated_at: string;
}

function templateFromRow(row: Record<string, unknown>): ReportTemplate {
  return { ...row, sections: parseJson(String(row.sections ?? ''), []), branding: parseJson(String(row.branding ?? ''), {}),
    recipients: parseJson(String(row.recipients ?? ''), []), enabled: !!row.enabled } as unknown as ReportTemplate;
}

function nextRun(cadence: string, from = new Date()): string | null {
  const next = new Date(from);
  if (cadence === 'daily') next.setUTCDate(next.getUTCDate() + 1);
  else if (cadence === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
  else if (cadence === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1);
  else return null;
  next.setUTCHours(7, 0, 0, 0); return next.toISOString();
}

export function createReportTemplate(input: { workspaceId: string; userId: string; name: string; sections?: string[]; branding?: ReportTemplate['branding']; recipients?: string[]; cadence?: string }): ReportTemplate {
  const id = randomUUID(); const cadence = input.cadence ?? 'manual';
  getDb().prepare(`INSERT INTO report_templates(id,workspace_id,name,sections,branding,recipients,cadence,next_run_at,created_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, input.workspaceId, input.name.trim(), JSON.stringify(input.sections ?? ['executive', 'search', 'ai', 'experience', 'operations']),
      JSON.stringify(input.branding ?? {}), JSON.stringify(input.recipients ?? []), cadence, nextRun(cadence), input.userId);
  return getReportTemplate(input.workspaceId, id)!;
}

export function listReportTemplates(workspaceId: string): ReportTemplate[] {
  return (getDb().prepare('SELECT * FROM report_templates WHERE workspace_id=? ORDER BY name').all(workspaceId) as Array<Record<string, unknown>>).map(templateFromRow);
}

export function getReportTemplate(workspaceId: string, id: string): ReportTemplate | null {
  const row = getDb().prepare('SELECT * FROM report_templates WHERE workspace_id=? AND id=?').get(workspaceId, id) as Record<string, unknown> | undefined;
  return row ? templateFromRow(row) : null;
}

export function updateReportTemplate(workspaceId: string, id: string, input: Partial<Pick<ReportTemplate, 'name' | 'sections' | 'branding' | 'recipients' | 'cadence' | 'enabled'>>): ReportTemplate | null {
  const current = getReportTemplate(workspaceId, id); if (!current) return null;
  const cadence = input.cadence ?? current.cadence;
  getDb().prepare(`UPDATE report_templates SET name=?,sections=?,branding=?,recipients=?,cadence=?,enabled=?,next_run_at=?,updated_at=datetime('now') WHERE workspace_id=? AND id=?`)
    .run(input.name?.trim() || current.name, JSON.stringify(input.sections ?? current.sections), JSON.stringify(input.branding ?? current.branding),
      JSON.stringify(input.recipients ?? current.recipients), cadence, (input.enabled ?? current.enabled) ? 1 : 0,
      cadence !== current.cadence ? nextRun(cadence) : current.next_run_at, workspaceId, id);
  return getReportTemplate(workspaceId, id);
}

export function deleteReportTemplate(workspaceId: string, id: string): boolean {
  return getDb().prepare('DELETE FROM report_templates WHERE workspace_id=? AND id=?').run(workspaceId, id).changes > 0;
}

export interface ReportSnapshot {
  generated_at: string; period: { start: string; end: string }; workspace: { id: string; name: string };
  command_center: ReturnType<typeof getCommandCenter>; platform: Record<string, unknown>;
  sites: ReturnType<typeof getSitesForWorkspace>; work_items: ReturnType<typeof listWorkItems>;
  ai: ReturnType<typeof getAiInsights>; timeline: Array<Record<string, unknown>>;
  outcomes: ReturnType<typeof listMetrics>; usage: ReturnType<typeof usageSummary>;
}

export function buildReportSnapshot(workspaceId: string, periodStart?: string, periodEnd?: string): ReportSnapshot {
  const end = periodEnd ?? new Date().toISOString(); const start = periodStart ?? new Date(Date.now() - 28 * 86_400_000).toISOString();
  const workspace = getWorkspace(workspaceId);
  return {
    generated_at: new Date().toISOString(), period: { start, end }, workspace: { id: workspaceId, name: workspace?.name ?? 'Workspace' },
    command_center: getCommandCenter(workspaceId), platform: platformOverview(workspaceId), sites: getSitesForWorkspace(workspaceId),
    work_items: listWorkItems(workspaceId, { includeSnoozed: true, limit: 200 }), ai: getAiInsights(workspaceId),
    timeline: listTimeline(workspaceId, 100), outcomes: listMetrics(workspaceId, { from: start, to: end, limit: 2500 }), usage: usageSummary(workspaceId, start, end),
  };
}

export function reportHtml(snapshot: ReportSnapshot, template?: ReportTemplate | null): string {
  const brand = template?.branding ?? {}; const accent = /^#[0-9a-f]{6}$/i.test(brand.accent ?? '') ? brand.accent! : '#7c5cff';
  const metrics = snapshot.command_center.metrics; const actions = snapshot.work_items.filter(item => !['done', 'dismissed'].includes(item.status)).slice(0, 8);
  const ai = snapshot.ai; const sites = snapshot.command_center.movers.slice(0, 8);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(brand.title || template?.name || snapshot.workspace.name)}</title>
  <style>body{margin:0;background:#f4f5f8;color:#151523;font:14px/1.5 Inter,Arial,sans-serif}.wrap{max-width:920px;margin:auto;padding:38px 24px}.hero{background:linear-gradient(135deg,#17152b,#252047);color:white;padding:38px;border-radius:22px}.hero i{color:${accent};font-style:normal;text-transform:uppercase;letter-spacing:.15em;font-size:11px}.hero h1{font-size:34px;margin:8px 0}.hero p{color:#c9c7dc;margin:0}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.card,.section{background:white;border:1px solid #e5e4ec;border-radius:16px;padding:20px}.card small{color:#6c6a7c}.card strong{display:block;font-size:27px;margin-top:6px}.section{margin-top:16px}.section h2{font-size:18px;margin:0 0 14px}.row{display:flex;justify-content:space-between;gap:16px;border-top:1px solid #ecebf2;padding:11px 0}.row:first-of-type{border:0}.tag{color:${accent};font-weight:700}.muted{color:#777487}.footer{text-align:center;color:#777487;font-size:12px;padding:24px}@media(max-width:680px){.grid{grid-template-columns:1fr 1fr}.hero{padding:25px}.hero h1{font-size:28px}}</style></head><body><div class="wrap">
  <section class="hero"><i>Organic intelligence report</i><h1>${esc(brand.title || snapshot.workspace.name)}</h1><p>${esc(snapshot.period.start.slice(0,10))} → ${esc(snapshot.period.end.slice(0,10))} · generated ${esc(snapshot.generated_at.slice(0,10))}</p></section>
  <div class="grid"><div class="card"><small>Workspace health</small><strong>${snapshot.command_center.score.overall}</strong></div><div class="card"><small>Organic clicks</small><strong>${metrics.clicks7d.toLocaleString()}</strong></div><div class="card"><small>AI visibility</small><strong>${metrics.aiVisibility ?? '—'}${metrics.aiVisibility != null ? '%' : ''}</strong></div><div class="card"><small>Open actions</small><strong>${actions.length}</strong></div></div>
  <section class="section"><h2>Executive priorities</h2>${actions.length ? actions.map(item => `<div class="row"><span><b>${esc(item.title)}</b><br><span class="muted">${esc(item.description)}</span></span><span class="tag">${esc(item.severity)}</span></div>`).join('') : '<p class="muted">No open priority actions.</p>'}</section>
  <section class="section"><h2>Search momentum</h2>${sites.length ? sites.map(site => `<div class="row"><span><b>${esc(site.name)}</b><br><span class="muted">${site.impressions.current.toLocaleString()} impressions</span></span><span class="tag">${site.clicks.current.toLocaleString()} clicks · ${site.clicks.changePct >= 0 ? '+' : ''}${Math.round(site.clicks.changePct)}%</span></div>`).join('') : '<p class="muted">Awaiting performance history.</p>'}</section>
  <section class="section"><h2>AI visibility</h2><div class="row"><span>Portfolio share of voice</span><b>${ai.overview.visibility}%</b></div>${ai.providers.slice(0,6).map(provider => `<div class="row"><span>${esc(provider.provider)}</span><span>${provider.cited}/${provider.checks} cited · <b>${provider.visibility}%</b></span></div>`).join('')}</section>
  <section class="section"><h2>Proof and governance</h2><div class="row"><span>Verified sites</span><b>${snapshot.sites.length}</b></div><div class="row"><span>Evidence observations</span><b>${snapshot.outcomes.length}</b></div><div class="row"><span>Estimated provider cost</span><b>${snapshot.usage.total_cost.toFixed(2)}</b></div></section>
  <div class="footer">${esc(brand.footer || 'Generated by Organic Command · evidence and freshness are retained with each observation.')}</div></div></body></html>`;
}

export async function generateReport(workspaceId: string, templateId?: string | null, options: { periodStart?: string; periodEnd?: string; email?: boolean } = {}): Promise<{ id: string; snapshot: ReportSnapshot; html: string; emailed: number }> {
  const template = templateId ? getReportTemplate(workspaceId, templateId) : null;
  if (templateId && !template) throw new Error('Report template not found.');
  const id = randomUUID(); const start = options.periodStart ?? new Date(Date.now() - 28 * 86_400_000).toISOString(); const end = options.periodEnd ?? new Date().toISOString();
  getDb().prepare('INSERT INTO report_runs(id,template_id,workspace_id,status,period_start,period_end) VALUES(?,?,?,?,?,?)').run(id, template?.id ?? null, workspaceId, 'running', start, end);
  try {
    const snapshot = buildReportSnapshot(workspaceId, start, end); const html = reportHtml(snapshot, template); let emailed = 0;
    if (options.email && template?.recipients.length) {
      for (const recipient of template.recipients) if (await sendEmail({ to: recipient, subject: `${template.name} · ${snapshot.workspace.name}`, text: `Your organic intelligence report is ready for ${start.slice(0,10)} to ${end.slice(0,10)}.`, html })) emailed++;
    }
    getDb().prepare("UPDATE report_runs SET status='complete',snapshot=?,finished_at=datetime('now') WHERE id=?").run(JSON.stringify(snapshot), id);
    if (template) getDb().prepare('UPDATE report_templates SET next_run_at=? WHERE id=?').run(nextRun(template.cadence), template.id);
    return { id, snapshot, html, emailed };
  } catch (error) {
    getDb().prepare("UPDATE report_runs SET status='failed',error=?,finished_at=datetime('now') WHERE id=?").run(error instanceof Error ? error.message : String(error), id); throw error;
  }
}

export function listReportRuns(workspaceId: string, limit = 50): Array<Record<string, unknown>> {
  return (getDb().prepare('SELECT id,template_id,workspace_id,status,period_start,period_end,error,created_at,finished_at FROM report_runs WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?').all(workspaceId, Math.min(limit,200)) as Array<Record<string, unknown>>);
}

export function getReportRun(workspaceId: string, id: string): { snapshot: ReportSnapshot; html: string } | null {
  const row = getDb().prepare('SELECT rr.*,rt.sections,rt.branding,rt.recipients,rt.name template_name,rt.cadence,rt.enabled,rt.created_by,rt.updated_at FROM report_runs rr LEFT JOIN report_templates rt ON rt.id=rr.template_id WHERE rr.workspace_id=? AND rr.id=?').get(workspaceId,id) as Record<string, unknown> | undefined;
  if (!row?.snapshot) return null; const snapshot = parseJson(String(row.snapshot), null as unknown as ReportSnapshot); if (!snapshot) return null;
  const template = row.template_id ? templateFromRow({ id: row.template_id, workspace_id: row.workspace_id, name: row.template_name, sections: row.sections, branding: row.branding, recipients: row.recipients, cadence: row.cadence, next_run_at: null, enabled: row.enabled, created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at }) : null;
  return { snapshot, html: reportHtml(snapshot, template) };
}

export async function runDueReports(): Promise<number> {
  const due = getDb().prepare(`SELECT workspace_id,id FROM report_templates WHERE enabled=1 AND cadence!='manual'
    AND next_run_at IS NOT NULL AND julianday(next_run_at)<=julianday('now') LIMIT 20`).all() as Array<{ workspace_id: string; id: string }>;
  for (const row of due) { try { await generateReport(row.workspace_id, row.id, { email: true }); } catch { /* retained on report run */ } }
  return due.length;
}

export async function sendWorkspaceDigest(workspaceId: string, force = false): Promise<boolean> {
  const cadence = getWorkspaceSetting(workspaceId, 'digest_cadence') ?? 'off'; if (!force && cadence === 'off') return false;
  const recipientSetting = getWorkspaceSetting(workspaceId, 'digest_recipients') ?? '';
  const recipients = parseJson<string[]>(recipientSetting, recipientSetting.split(/[\s,]+/).filter(Boolean));
  if (!recipients.length) return false;
  const last = getWorkspaceSetting(workspaceId, 'digest_last_sent');
  const wait = cadence === 'daily' ? 20 * 3_600_000 : 6 * 86_400_000;
  if (!force && last && Date.now() - new Date(last).getTime() < wait) return false;
  const workspace = getWorkspace(workspaceId); const threshold = getWorkspaceSetting(workspaceId, 'alert_min_severity') ?? 'low';
  const rank: Record<string,number> = { critical: 4, high: 3, medium: 2, low: 1 };
  const items = listWorkItems(workspaceId, { limit: 100 }).filter(item => !['done','dismissed'].includes(item.status) && (rank[item.severity] ?? 0) >= (rank[threshold] ?? 1)).slice(0,10); const center = getCommandCenter(workspaceId);
  const text = [`${workspace?.name ?? 'Workspace'} organic digest`, `${items.length} open priority actions`, `${center.metrics.clicks7d} organic clicks (7d)`, `AI visibility ${center.metrics.aiVisibility ?? 'awaiting baseline'}%`, '', ...items.slice(0,5).map(item => `• [${item.severity}] ${item.title}`)].join('\n');
  let sent = 0; for (const recipient of recipients) if (await sendEmail({ to: recipient, subject: `${workspace?.name ?? 'Workspace'} · organic operations digest`, text })) sent++;
  if (sent) { setWorkspaceSetting(workspaceId, 'digest_last_sent', new Date().toISOString()); await sendWorkspaceNotification(workspaceId, 'Workspace digest sent', `${sent} recipient${sent===1?'':'s'} · ${items.length} open actions.`, 'digest'); }
  return sent > 0;
}

export async function runDueDigests(): Promise<number> {
  const rows = getDb().prepare('SELECT id FROM workspaces').all() as Array<{ id: string }>; let sent = 0;
  for (const row of rows) if (await sendWorkspaceDigest(row.id).catch(() => false)) sent++;
  return sent;
}

export function defaultReportRecipients(workspaceId: string): string[] {
  return listWorkspaceMembers(workspaceId).filter(member => member.role === 'owner' || member.role === 'admin').map(member => member.email);
}
