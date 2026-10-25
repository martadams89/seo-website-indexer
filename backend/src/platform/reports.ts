import { randomUUID } from 'crypto';
import { getDb, getSitesForWorkspace, getWorkspaceSetting, setWorkspaceSetting } from '../db/database.js';
import { getWorkspace, listWorkspaceMembers } from '../auth/workspaces.js';
import { getCommandCenter } from '../analytics/command-center.js';
import { getAiInsights } from '../ai/citations.js';
import { sendEmail } from '../utils/email.js';
import { sendWorkspaceNotification } from '../utils/notify.js';
import { listMetrics, listTimeline, listWorkItems, platformOverview, usageSummary } from './store.js';
import { listLocations, locationStats } from '../reviews/store.js';
import { businessPerformance } from '../reviews/service.js';
import { listAdsAccounts } from '../ads/store.js';
import { accountOverview } from '../ads/insights.js';

/** Report sections in the order they render. `local` and `ads` cover Google reviews/Business Profile and Google Ads. */
export const REPORT_SECTIONS = ['executive', 'search', 'local', 'ads', 'ai', 'operations'] as const;

export interface LocalReportRow {
  name: string; rating: number | null; total_reviews: number | null; new_reviews: number; new_average: number | null;
  response_rate: number | null; unanswered: number;
  performance: { calls: number; website_clicks: number; direction_requests: number; views: number; views_change_pct: number | null; calls_change_pct: number | null } | null;
  error: string | null;
}

export interface AdsReportRow {
  name: string; currency: string | null; cost: number; clicks: number; conversions: number; cpa: number | null; roas: number | null;
  cost_change_pct: number | null; conversions_change_pct: number | null; monthly_budget: number | null; month_to_date_spend: number | null; pacing: string | null;
  error: string | null;
}

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
    VALUES(?,?,?,?,?,?,?,?,?)`).run(id, input.workspaceId, input.name.trim(), JSON.stringify(normalizeSections(input.sections)),
      JSON.stringify(input.branding ?? {}), JSON.stringify(input.recipients ?? []), cadence, nextRun(cadence), input.userId);
  return getReportTemplate(input.workspaceId, id)!;
}

/** Known sections in render order; unknown names are dropped and an empty choice means every section. */
export function normalizeSections(raw: unknown): string[] {
  const wanted = Array.isArray(raw) ? raw.map(String) : [];
  const known = REPORT_SECTIONS.filter(s => wanted.includes(s));
  return known.length ? known : [...REPORT_SECTIONS];
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
    .run(input.name?.trim() || current.name, JSON.stringify(input.sections ? normalizeSections(input.sections) : current.sections), JSON.stringify(input.branding ?? current.branding),
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
  local?: LocalReportRow[]; ads?: AdsReportRow[];
}

const DAY_MS = 86_400_000;
const periodDays = (start: string, end: string) => Math.max(7, Math.min(270, Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS)));

/** Google reviews and Business Profile performance for each linked location (the part Porter-style GBP reporting covers). */
async function localSection(workspaceId: string, start: string, end: string): Promise<LocalReportRow[]> {
  const days = periodDays(start, end);
  const rows: LocalReportRow[] = [];
  for (const location of listLocations(workspaceId).filter(l => l.enabled)) {
    const stats = locationStats(location.id);
    const fresh = getDb().prepare('SELECT COUNT(*) AS n, AVG(NULLIF(rating,0)) AS avg FROM gbp_reviews WHERE location_id=? AND create_time >= ? AND create_time < ?')
      .get(location.id, start, end) as { n: number; avg: number | null };
    let performance: LocalReportRow['performance'] = null;
    let error: string | null = null;
    try {
      const p = await businessPerformance(location, days);
      const views = p.totals.search_impressions.current + p.totals.maps_impressions.current;
      const viewsBefore = p.totals.search_impressions.previous + p.totals.maps_impressions.previous;
      performance = {
        calls: p.totals.calls.current, website_clicks: p.totals.website_clicks.current, direction_requests: p.totals.direction_requests.current,
        views, views_change_pct: viewsBefore ? Math.round(((views - viewsBefore) / viewsBefore) * 1000) / 10 : null, calls_change_pct: p.totals.calls.change_pct,
      };
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    rows.push({
      name: location.title ?? location.location_name, rating: location.average_rating, total_reviews: location.total_reviews,
      new_reviews: fresh.n, new_average: fresh.avg === null ? null : Math.round(fresh.avg * 100) / 100,
      response_rate: stats.response_rate_90d, unanswered: stats.unreplied, performance, error,
    });
  }
  return rows;
}

/** Google Ads spend, results and budget pacing for each linked client account. */
async function adsSection(workspaceId: string, start: string, end: string): Promise<AdsReportRow[]> {
  const days = periodDays(start, end);
  const rows: AdsReportRow[] = [];
  for (const account of listAdsAccounts(workspaceId).filter(a => a.enabled && !a.is_manager)) {
    try {
      const o = await accountOverview(account, days);
      const change = o.change_pct as Record<string, number | null>;
      rows.push({
        name: account.name ?? account.customer_id, currency: account.currency, cost: o.totals.cost, clicks: o.totals.clicks, conversions: o.totals.conversions,
        cpa: o.totals.cpa, roas: o.totals.roas, cost_change_pct: change.cost ?? null, conversions_change_pct: change.conversions ?? null,
        monthly_budget: o.pacing.monthly_budget, month_to_date_spend: o.pacing.month_to_date_spend, pacing: o.pacing.status, error: null,
      });
    } catch (e) {
      rows.push({ name: account.name ?? account.customer_id, currency: account.currency, cost: 0, clicks: 0, conversions: 0, cpa: null, roas: null, cost_change_pct: null, conversions_change_pct: null, monthly_budget: account.monthly_budget, month_to_date_spend: null, pacing: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return rows;
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
  const show = (section: string) => !template || template.sections.includes(section);
  const signedPct = (v: number | null) => v === null ? '' : ` · ${v >= 0 ? '+' : ''}${v}%`;
  const money = (v: number | null, currency: string | null) => v === null ? '—' : `${currency ? `${currency} ` : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const local = snapshot.local ?? []; const ads = snapshot.ads ?? [];
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(brand.title || template?.name || snapshot.workspace.name)}</title>
  <style>body{margin:0;background:#f4f5f8;color:#151523;font:14px/1.5 Inter,Arial,sans-serif}.wrap{max-width:920px;margin:auto;padding:38px 24px}.hero{background:linear-gradient(135deg,#17152b,#252047);color:white;padding:38px;border-radius:22px}.hero i{color:${accent};font-style:normal;text-transform:uppercase;letter-spacing:.15em;font-size:11px}.hero h1{font-size:34px;margin:8px 0}.hero p{color:#c9c7dc;margin:0}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.card,.section{background:white;border:1px solid #e5e4ec;border-radius:16px;padding:20px}.card small{color:#6c6a7c}.card strong{display:block;font-size:27px;margin-top:6px}.section{margin-top:16px}.section h2{font-size:18px;margin:0 0 14px}.row{display:flex;justify-content:space-between;gap:16px;border-top:1px solid #ecebf2;padding:11px 0}.row:first-of-type{border:0}.tag{color:${accent};font-weight:700}.muted{color:#777487}.footer{text-align:center;color:#777487;font-size:12px;padding:24px}@media(max-width:680px){.grid{grid-template-columns:1fr 1fr}.hero{padding:25px}.hero h1{font-size:28px}}</style></head><body><div class="wrap">
  <section class="hero"><i>Organic intelligence report</i><h1>${esc(brand.title || snapshot.workspace.name)}</h1><p>${esc(snapshot.period.start.slice(0,10))} → ${esc(snapshot.period.end.slice(0,10))} · generated ${esc(snapshot.generated_at.slice(0,10))}</p></section>
  ${show('executive') ? `<div class="grid"><div class="card"><small>Workspace health</small><strong>${snapshot.command_center.score.overall}</strong></div><div class="card"><small>Organic clicks</small><strong>${metrics.clicks7d.toLocaleString()}</strong></div><div class="card"><small>AI visibility</small><strong>${metrics.aiVisibility ?? '—'}${metrics.aiVisibility != null ? '%' : ''}</strong></div><div class="card"><small>Open actions</small><strong>${actions.length}</strong></div></div>
  <section class="section"><h2>Executive priorities</h2>${actions.length ? actions.map(item => `<div class="row"><span><b>${esc(item.title)}</b><br><span class="muted">${esc(item.description)}</span></span><span class="tag">${esc(item.severity)}</span></div>`).join('') : '<p class="muted">No open priority actions.</p>'}</section>` : ''}
  ${show('search') ? `<section class="section"><h2>Search momentum</h2>${sites.length ? sites.map(site => `<div class="row"><span><b>${esc(site.name)}</b><br><span class="muted">${site.impressions.current.toLocaleString()} impressions</span></span><span class="tag">${site.clicks.current.toLocaleString()} clicks · ${site.clicks.changePct >= 0 ? '+' : ''}${Math.round(site.clicks.changePct)}%</span></div>`).join('') : '<p class="muted">Awaiting performance history.</p>'}</section>` : ''}
  ${show('local') && local.length ? `<section class="section"><h2>Google reviews and Business Profile</h2>${local.map(l => `<div class="row"><span><b>${esc(l.name)}</b><br><span class="muted">${l.rating !== null ? `★ ${l.rating.toFixed(1)} from ${(l.total_reviews ?? 0).toLocaleString()} reviews · ` : ''}${l.new_reviews} new this period${l.new_average !== null ? ` (avg ${l.new_average})` : ''} · ${l.response_rate !== null ? `${l.response_rate}% answered` : 'no recent reviews'}${l.unanswered ? ` · ${l.unanswered} awaiting a reply` : ''}</span></span><span class="tag">${l.performance ? `${l.performance.calls.toLocaleString()} calls${signedPct(l.performance.calls_change_pct)}<br>${l.performance.website_clicks.toLocaleString()} website clicks · ${l.performance.direction_requests.toLocaleString()} directions<br>${l.performance.views.toLocaleString()} views${signedPct(l.performance.views_change_pct)}` : '<span class="muted">Performance unavailable</span>'}</span></div>`).join('')}</section>` : ''}
  ${show('ads') && ads.length ? `<section class="section"><h2>Google Ads</h2>${ads.map(a => `<div class="row"><span><b>${esc(a.name)}</b><br><span class="muted">${a.error ? esc(a.error) : `${a.clicks.toLocaleString()} clicks · ${a.conversions.toLocaleString()} conversions${a.cpa !== null ? ` · CPA ${esc(money(a.cpa, a.currency))}` : ''}${a.roas !== null ? ` · ROAS ${a.roas}` : ''}`}</span></span><span class="tag">${esc(money(a.cost, a.currency))} spent${signedPct(a.cost_change_pct)}${a.monthly_budget !== null ? `<br><span class="muted">${esc(money(a.month_to_date_spend, a.currency))} of ${esc(money(a.monthly_budget, a.currency))} this month</span>` : ''}</span></div>`).join('')}</section>` : ''}
  ${show('ai') ? `<section class="section"><h2>AI visibility</h2><div class="row"><span>Portfolio share of voice</span><b>${ai.overview.visibility}%</b></div>${ai.providers.slice(0,6).map(provider => `<div class="row"><span>${esc(provider.provider)}</span><span>${provider.cited}/${provider.checks} cited · <b>${provider.visibility}%</b></span></div>`).join('')}</section>` : ''}
  ${show('operations') ? `<section class="section"><h2>Proof and governance</h2><div class="row"><span>Verified sites</span><b>${snapshot.sites.length}</b></div><div class="row"><span>Evidence observations</span><b>${snapshot.outcomes.length}</b></div><div class="row"><span>Estimated provider cost</span><b>${snapshot.usage.total_cost.toFixed(2)}</b></div></section>` : ''}
  <div class="footer">${esc(brand.footer || 'Generated by Organic Command · evidence and freshness are retained with each observation.')}</div></div></body></html>`;
}

export async function generateReport(workspaceId: string, templateId?: string | null, options: { periodStart?: string; periodEnd?: string; email?: boolean } = {}): Promise<{ id: string; snapshot: ReportSnapshot; html: string; emailed: number }> {
  const template = templateId ? getReportTemplate(workspaceId, templateId) : null;
  if (templateId && !template) throw new Error('Report template not found.');
  const id = randomUUID(); const start = options.periodStart ?? new Date(Date.now() - 28 * 86_400_000).toISOString(); const end = options.periodEnd ?? new Date().toISOString();
  getDb().prepare('INSERT INTO report_runs(id,template_id,workspace_id,status,period_start,period_end) VALUES(?,?,?,?,?,?)').run(id, template?.id ?? null, workspaceId, 'running', start, end);
  try {
    const snapshot = buildReportSnapshot(workspaceId, start, end);
    const wants = (section: string) => !template || template.sections.includes(section);
    if (wants('local')) snapshot.local = await localSection(workspaceId, start, end);
    if (wants('ads')) snapshot.ads = await adsSection(workspaceId, start, end);
    const html = reportHtml(snapshot, template); let emailed = 0;
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
