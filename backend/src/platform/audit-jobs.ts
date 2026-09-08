import { randomUUID } from 'node:crypto';
import { getDb, getSiteById } from '../db/database.js';
import { auditContentInventory } from './content-audit.js';
export interface AuditJob {
  id: string;
  site_id: string;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}
const active = new Map<string, AbortController>();
export function recoverAuditJobs() {
  getDb()
    .prepare(
      "UPDATE discovery_jobs SET state='failed',error='The server restarted during this audit. Start a new run.',updated_at=? WHERE state='running'",
    )
    .run(new Date().toISOString());
}
export function getAuditJob(workspaceId: string, id: string): AuditJob | null {
  return (
    (getDb()
      .prepare(
        'SELECT id,site_id,state,completed,total,error,created_at,updated_at FROM discovery_jobs WHERE workspace_id=? AND id=?',
      )
      .get(workspaceId, id) as AuditJob | undefined) ?? null
  );
}
export function latestAuditJob(workspaceId: string, siteId: string): AuditJob | null {
  return (
    (getDb()
      .prepare(
        'SELECT id,site_id,state,completed,total,error,created_at,updated_at FROM discovery_jobs WHERE workspace_id=? AND site_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      )
      .get(workspaceId, siteId) as AuditJob | undefined) ?? null
  );
}
export function startAuditJob(workspaceId: string, siteId: string, limit = 50): AuditJob {
  const site = getSiteById(siteId);
  if (!site || site.workspace_id !== workspaceId)
    throw Object.assign(new Error('Site not found'), { statusCode: 404 });
  const existing = latestAuditJob(workspaceId, siteId);
  if (existing?.state === 'running') return existing;
  if (active.size >= 2)
    throw Object.assign(new Error('Two audits are already running. Try again after one finishes.'), {
      statusCode: 429,
    });
  const id = randomUUID();
  const at = new Date().toISOString();
  const controller = new AbortController();
  active.set(id, controller);
  getDb()
    .prepare(
      "INSERT INTO discovery_jobs(id,workspace_id,site_id,state,created_at,updated_at) VALUES(?,?,?,'running',?,?)",
    )
    .run(id, workspaceId, siteId, at, at);
  getDb()
    .prepare(
      'DELETE FROM discovery_jobs WHERE workspace_id=? AND site_id=? AND id NOT IN (SELECT id FROM discovery_jobs WHERE workspace_id=? AND site_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30)',
    )
    .run(workspaceId, siteId, workspaceId, siteId);
  void auditContentInventory(workspaceId, siteId, true, {
    signal: controller.signal,
    limit,
    onProgress: (completed, total) =>
      getDb()
        .prepare('UPDATE discovery_jobs SET completed=?,total=?,updated_at=? WHERE id=?')
        .run(completed, total, new Date().toISOString(), id),
  })
    .then(() => {
      getDb()
        .prepare("UPDATE discovery_jobs SET state='succeeded',updated_at=? WHERE id=? AND state='running'")
        .run(new Date().toISOString(), id);
    })
    .catch((error) => {
      getDb()
        .prepare(
          "UPDATE discovery_jobs SET state='failed',error=?,updated_at=? WHERE id=? AND state='running'",
        )
        .run(error instanceof Error ? error.message : 'Audit failed', new Date().toISOString(), id);
    })
    .finally(() => active.delete(id));
  return getAuditJob(workspaceId, id)!;
}

export function cancelAuditJob(workspaceId: string, id: string): AuditJob | null {
  const job = getAuditJob(workspaceId, id);
  if (!job) return null;
  if (job.state === 'running') {
    getDb()
      .prepare(
        "UPDATE discovery_jobs SET state='cancelled',error='Cancelled by a workspace member.',updated_at=? WHERE workspace_id=? AND id=?",
      )
      .run(new Date().toISOString(), workspaceId, id);
    active.get(id)?.abort(new Error('Audit cancelled'));
  }
  return getAuditJob(workspaceId, id);
}
