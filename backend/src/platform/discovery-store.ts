import { randomUUID } from 'node:crypto';
import { getDb } from '../db/database.js';
import type { Finding, PageEvidence } from './page-evidence.js';
export interface AuditReport {
  id: string;
  site_id: string;
  observed_at: string;
  attempted: number;
  inventory: number;
  pages: PageEvidence[];
  failures: Array<{ url: string; error: string }>;
  findings: Finding[];
  methodology: string;
}
export function saveAudit(report: Omit<AuditReport, 'id'>, workspaceId: string): AuditReport {
  const result = { ...report, id: randomUUID() };
  getDb().transaction(() => {
    getDb()
      .prepare('INSERT INTO discovery_runs(id,workspace_id,site_id,observed_at,report) VALUES(?,?,?,?,?)')
      .run(result.id, workspaceId, result.site_id, result.observed_at, JSON.stringify(result));
    getDb()
      .prepare(
        'DELETE FROM discovery_runs WHERE workspace_id=? AND site_id=? AND id NOT IN (SELECT id FROM discovery_runs WHERE workspace_id=? AND site_id=? ORDER BY observed_at DESC, rowid DESC LIMIT 30)',
      )
      .run(workspaceId, result.site_id, workspaceId, result.site_id);
  })();
  return result;
}
export function auditHistory(workspaceId: string, siteId: string): AuditReport[] {
  return (
    getDb()
      .prepare(
        'SELECT report FROM discovery_runs WHERE workspace_id=? AND site_id=? ORDER BY observed_at DESC, rowid DESC LIMIT 30',
      )
      .all(workspaceId, siteId) as Array<{ report: string }>
  ).map((row) => JSON.parse(row.report));
}
export function compareAudits(current: AuditReport, previous?: AuditReport) {
  const key = (finding: Finding) => `${finding.url}\n${finding.code}`;
  if (!previous)
    return {
      comparablePages: 0,
      new: [] as Finding[],
      resolved: [] as Finding[],
      persisting: [] as Finding[],
      unverified: [] as Finding[],
    };
  const old = new Set(previous.findings.map(key));
  const now = new Set(current.findings.map(key));
  // A failed, non-HTML, redirected or unsampled page cannot prove a repair.
  const comparable = new Set(
    current.pages.filter((p) => p.html && p.status === 200 && p.url === p.finalUrl).map((p) => p.url),
  );
  const enoughContext = (finding: Finding) =>
    !/^(duplicate-|sample-unlinked|broken-internal:|redirected-internal:|excluded-internal:|hreflang-return:)/.test(
      finding.code,
    ) ||
    (previous.pages.every((page) => comparable.has(page.url)) &&
      current.pages.every((page) => !page.linksTruncated));
  const before = new Set(previous.pages.filter((p) => p.html && p.status === 200).map((p) => p.url));
  return {
    comparablePages: [...comparable].filter((url) => before.has(url)).length,
    new: current.findings.filter((f) => !old.has(key(f))),
    persisting: current.findings.filter((f) => old.has(key(f))),
    resolved: previous.findings.filter((f) => !now.has(key(f)) && comparable.has(f.url) && enoughContext(f)),
    unverified: previous.findings.filter(
      (f) => !now.has(key(f)) && (!comparable.has(f.url) || !enoughContext(f)),
    ),
  };
}

export function auditView(workspaceId: string, siteId: string, runId?: string) {
  const rows = getDb()
    .prepare(
      "SELECT id,observed_at,json_extract(report,'$.attempted') attempted,json_extract(report,'$.inventory') inventory FROM discovery_runs WHERE workspace_id=? AND site_id=? ORDER BY observed_at DESC,rowid DESC LIMIT 30",
    )
    .all(workspaceId, siteId) as Array<{
    id: string;
    observed_at: string;
    attempted: number;
    inventory: number;
  }>;
  const index = runId ? rows.findIndex((row) => row.id === runId) : 0;
  if (runId && index < 0) throw Object.assign(new Error('Audit snapshot not found'), { statusCode: 404 });
  const read = (id: string | undefined): AuditReport | undefined => {
    if (!id) return undefined;
    const row = getDb()
      .prepare('SELECT report FROM discovery_runs WHERE workspace_id=? AND site_id=? AND id=?')
      .get(workspaceId, siteId, id) as { report: string } | undefined;
    return row ? JSON.parse(row.report) : undefined;
  };
  const report = read(rows[index]?.id);
  const previous = read(rows[index + 1]?.id);
  return {
    history: rows,
    report: report ?? null,
    comparison: report ? compareAudits(report, previous) : null,
  };
}
