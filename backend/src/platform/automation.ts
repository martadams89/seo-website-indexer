import { getDb, getWorkspaceSettings } from '../db/database.js';
import { runDuePrompts } from '../ai/citations.js';
import { auditContentInventory } from './content-audit.js';
import { syncIntegration } from './connectors.js';
import { runDueDigests, runDueReports } from './reports.js';
import { dueIntegrations } from './store.js';

let running = false;

export async function runPlatformAutomation(): Promise<{ integrations: number; prompts: number; reports: number; digests: number; audited: number; retained: number }> {
  if (running) return { integrations: 0, prompts: 0, reports: 0, digests: 0, audited: 0, retained: 0 };
  running = true;
  try {
    let integrations = 0;
    for (const integration of dueIntegrations(20)) {
      try { await syncIntegration(integration); integrations++; } catch { /* work item and status retained */ }
    }
    const prompts = await runDuePrompts(); const reports = await runDueReports(); const digests = await runDueDigests();
    const workspaces = getDb().prepare('SELECT id FROM workspaces').all() as Array<{ id: string }>; let audited = 0;
    let retained = 0;
    for (const workspace of workspaces) {
      const result = await auditContentInventory(workspace.id).catch(() => null); if (result?.pages) audited += result.pages;
      const days = Math.min(Math.max(Number(getWorkspaceSettings(workspace.id).retention_days || 365), 30), 3650);
      // Usage is intentionally absent: the billback ledger is immutable. These
      // high-volume operational details obey the tenant's explicit policy.
      for (const table of ['metric_observations', 'annotations', 'notification_deliveries'] as const) {
        const timeColumn = table === 'annotations' ? 'event_at' : table === 'notification_deliveries' ? 'created_at' : 'observed_at';
        retained += getDb().prepare(`DELETE FROM ${table} WHERE workspace_id=? AND ${timeColumn}<datetime('now',?)`).run(workspace.id, `-${days} days`).changes;
      }
    }
    return { integrations, prompts, reports, digests, audited, retained };
  } finally { running = false; }
}

export function platformAutomationRunning(): boolean { return running; }
