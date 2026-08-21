import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'organic-site-files-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'site-file-history-test-secret';

let database: typeof import('../db/database.js');
let users: typeof import('../auth/users.js');
let workspaces: typeof import('../auth/workspaces.js');
let files: typeof import('../db/site-files.js');
let workspaceId = '';
let siteId = '';

beforeAll(async () => {
  database = await import('../db/database.js');
  users = await import('../auth/users.js');
  workspaces = await import('../auth/workspaces.js');
  files = await import('../db/site-files.js');
  const user = users.createUser({ email: `${randomUUID()}@example.com`, password: 'password123' });
  workspaceId = workspaces.bootstrapUserWorkspace(user, false).id;
  siteId = randomUUID();
  database.upsertSite({
    id: siteId,
    name: 'History site',
    domain: 'history.example.com',
    sitemap_url: 'https://history.example.com/sitemap.xml',
    gsc_url: 'sc-domain:history.example.com',
    enabled: 1,
    workspace_id: workspaceId,
    geo_manage: 1,
  });
});

afterAll(() => {
  try { database.getDb().close(); } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('versioned migrations and site discovery history', () => {
  it('records the migration and persists managed-file ownership', () => {
    expect(database.getSiteById(siteId)?.geo_manage).toBe(1);
    const migrations = database.getDb().prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>;
    expect(migrations.map(row => row.id)).toContain('20260821_01_site_file_history');
  });

  it('stores only meaningful changes and reports a compact line diff', () => {
    expect(files.recordSiteFileSnapshot({
      workspaceId, siteId, fileKind: 'llms.txt', source: 'live', status: 200,
      content: '# Example\n- [Home](https://history.example.com/)\n', matchesGenerated: true,
    })).toBe(true);
    expect(files.recordSiteFileSnapshot({
      workspaceId, siteId, fileKind: 'llms.txt', source: 'live', status: 200,
      content: '# Example\n- [Home](https://history.example.com/)\n', matchesGenerated: true,
    })).toBe(false);
    expect(files.recordSiteFileSnapshot({
      workspaceId, siteId, fileKind: 'llms.txt', source: 'live', status: 200,
      content: '# Example\n- [Home](https://history.example.com/)\n- [Docs](https://history.example.com/docs)\n', matchesGenerated: false,
    })).toBe(true);

    const history = files.listSiteFileSnapshots(workspaceId, siteId);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ file_kind: 'llms.txt', added_lines: 1, removed_lines: 0, matches_generated: 0 });
    expect(files.listSiteFileSnapshots(workspaceId, siteId, 1)[0]).toMatchObject({ added_lines: 1, removed_lines: 0 });
    expect(files.listSiteFileSnapshots('another-workspace', siteId)).toEqual([]);
  });
});
