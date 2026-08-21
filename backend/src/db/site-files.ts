import { createHash } from 'crypto';
import { getDb } from './database.js';

export type SiteFileKind = 'robots.txt' | 'llms.txt';
export type SiteFileSource = 'live' | 'deployment';

export interface SiteFileSnapshot {
  id: number;
  site_id: string;
  file_kind: SiteFileKind;
  source: SiteFileSource;
  http_status: number | null;
  content_hash: string;
  content: string;
  matches_generated: number | null;
  observed_at: string;
  added_lines: number;
  removed_lines: number;
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function lineChanges(current: string, previous: string): { added: number; removed: number } {
  const before = new Set(previous.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  const after = new Set(current.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  let added = 0;
  let removed = 0;
  for (const line of after) if (!before.has(line)) added += 1;
  for (const line of before) if (!after.has(line)) removed += 1;
  return { added, removed };
}

/** Store only meaningful state changes, avoiding a duplicate row on every audit. */
export function recordSiteFileSnapshot(input: {
  workspaceId: string;
  siteId: string;
  fileKind: SiteFileKind;
  source: SiteFileSource;
  status?: number | null;
  content: string;
  matchesGenerated?: boolean | null;
}): boolean {
  const db = getDb();
  const contentHash = hash(input.content);
  const latest = db.prepare(`SELECT content_hash,http_status,source,matches_generated FROM site_file_snapshots
    WHERE site_id=? AND file_kind=? ORDER BY observed_at DESC,id DESC LIMIT 1`).get(input.siteId, input.fileKind) as {
      content_hash: string;
      http_status: number | null;
      source: SiteFileSource;
      matches_generated: number | null;
    } | undefined;
  const status = input.status ?? null;
  const matches = input.matchesGenerated == null ? null : input.matchesGenerated ? 1 : 0;
  if (latest && latest.content_hash === contentHash && latest.http_status === status
    && latest.source === input.source && latest.matches_generated === matches) return false;

  db.prepare(`INSERT INTO site_file_snapshots(
    workspace_id,site_id,file_kind,source,http_status,content_hash,content,matches_generated
  ) VALUES(?,?,?,?,?,?,?,?)`).run(
    input.workspaceId, input.siteId, input.fileKind, input.source, status, contentHash, input.content, matches,
  );
  return true;
}

export function listSiteFileSnapshots(workspaceId: string, siteId: string, limit = 50): SiteFileSnapshot[] {
  const rows = getDb().prepare(`SELECT id,site_id,file_kind,source,http_status,content_hash,content,matches_generated,observed_at,
      LEAD(content) OVER (PARTITION BY file_kind ORDER BY observed_at DESC,id DESC) AS previous_content
    FROM site_file_snapshots WHERE workspace_id=? AND site_id=? ORDER BY observed_at DESC,id DESC LIMIT ?`)
    .all(workspaceId, siteId, Math.min(Math.max(limit, 1), 200)) as Array<
      Omit<SiteFileSnapshot, 'added_lines' | 'removed_lines'> & { previous_content: string | null }
    >;

  return rows.map(row => {
    const { previous_content: previous, ...snapshot } = row;
    const change = lineChanges(row.content, previous ?? '');
    return { ...snapshot, added_lines: change.added, removed_lines: change.removed };
  });
}
