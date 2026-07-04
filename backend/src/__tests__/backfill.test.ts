import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Upgrade safety: an existing SINGLE-tenant install (sites, Google accounts and
// a global Bing key, none of which know about workspaces) must migrate cleanly
// to the multi-tenant model when the first user signs in — nothing lost, nothing
// left unassigned. We seed a "legacy" DB, then run the first-user bootstrap and
// assert everything got claimed. Fresh temp DATA_DIR + dynamic imports so the DB
// modules load against it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-backfill-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'test-secret-key-1234567890';

type UsersMod = typeof import('../auth/users.js');
type WsMod = typeof import('../auth/workspaces.js');
type DbMod = typeof import('../db/database.js');

let users: UsersMod;
let ws: WsMod;
let db: DbMod;

beforeAll(async () => {
  users = await import('../auth/users.js');
  ws = await import('../auth/workspaces.js');
  db = await import('../db/database.js');
});

describe('legacy single-tenant → multi-tenant backfill', () => {
  it('claims pre-existing sites, Google accounts and the global Bing key on first login', () => {
    // ── Seed a legacy install (everything workspace-less) ──
    const legacySiteId = `legacy-${randomUUID().slice(0, 8)}`;
    db.upsertSite({
      id: legacySiteId, name: 'Legacy Site', domain: 'legacy.com',
      sitemap_url: 'https://legacy.com/sitemap.xml', gsc_url: 'https://legacy.com/', enabled: 1,
      // workspace_id intentionally omitted → NULL (pre-migration state)
    });
    db.upsertGoogleAccount({
      id: 'legacy@example.com', email: 'legacy@example.com',
      client_id: '123-abc.apps.googleusercontent.com', client_secret: 'shh',
      access_token: 'at', refresh_token: 'rt', token_expiry: new Date().toISOString(),
      // workspace_id omitted → NULL
    });
    db.setSetting('bing_api_key', 'legacy-global-bing-key');

    // Sanity: they start unassigned.
    expect(db.getSiteById(legacySiteId)?.workspace_id ?? null).toBeNull();
    expect(db.getGoogleAccountById('legacy@example.com')?.workspace_id ?? null).toBeNull();

    // ── First user signs in → bootstrap claims everything ──
    const admin = users.createUser({ email: `admin-${randomUUID()}@x.com`, password: 'password123', superAdmin: true });
    const workspace = ws.bootstrapUserWorkspace(admin, /* isFirstUser */ true);

    // Site + Google account are now in the admin's Default workspace.
    expect(db.getSiteById(legacySiteId)?.workspace_id).toBe(workspace.id);
    expect(db.getGoogleAccountById('legacy@example.com')?.workspace_id).toBe(workspace.id);
    expect(db.getSitesForWorkspace(workspace.id).map(s => s.id)).toContain(legacySiteId);
    expect(db.getGoogleAccountsForWorkspace(workspace.id).map(a => a.id)).toContain('legacy@example.com');

    // The legacy global Bing key became a workspace Bing account…
    const bing = ws.listBingAccounts(workspace.id);
    expect(bing.length).toBe(1);
    // …and the site still resolves to that key (decrypted) via bingKeyForSite.
    expect(ws.bingKeyForSite(legacySiteId)).toBe('legacy-global-bing-key');
  });

  it('leaves nothing workspace-less after the first user bootstraps', () => {
    const orphanSites = db.getAllSites().filter(s => (s.workspace_id ?? null) === null);
    expect(orphanSites).toHaveLength(0);
  });
});
