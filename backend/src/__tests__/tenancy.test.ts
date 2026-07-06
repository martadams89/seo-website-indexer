import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Multi-tenant isolation is the security-critical property of the workspace
// model: a user must never see another tenant's sites, Google/Bing accounts or
// alerts, while a super-admin sees everything. We drive the real modules
// against a throwaway SQLite file so the schema + queries are exercised end to
// end. DATA_DIR/APP_SECRET are set before the DB modules load (dynamic import).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-tenancy-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'test-secret-key-1234567890';

type UsersMod = typeof import('../auth/users.js');
type WsMod = typeof import('../auth/workspaces.js');
type DbMod = typeof import('../db/database.js');

let users: UsersMod;
let ws: WsMod;
let db: DbMod;
let googleAuth: typeof import('../auth/google-oauth.js');

beforeAll(async () => {
  users = await import('../auth/users.js');
  ws = await import('../auth/workspaces.js');
  db = await import('../db/database.js');
  googleAuth = await import('../auth/google-oauth.js');
});

function makeSite(id: string, workspaceId: string) {
  db.upsertSite({
    id, name: id, domain: `${id}.com`, sitemap_url: `https://${id}.com/sitemap.xml`,
    gsc_url: `https://${id}.com/`, enabled: 1, workspace_id: workspaceId,
  });
}

describe('workspace tenant isolation', () => {
  it('scopes sites, accounts and access to the owning workspace', () => {
    const alice = users.createUser({ email: `alice-${randomUUID()}@x.com`, password: 'password123', superAdmin: true });
    const bob = users.createUser({ email: `bob-${randomUUID()}@x.com`, password: 'password123' });

    // Alice is the first user → bootstrap claims any legacy data; Bob gets his own.
    const wsA = ws.bootstrapUserWorkspace(alice, true);
    const wsB = ws.bootstrapUserWorkspace(bob, false);
    expect(wsA.id).not.toEqual(wsB.id);

    const siteA = `a-${randomUUID().slice(0, 8)}`;
    const siteB = `b-${randomUUID().slice(0, 8)}`;
    makeSite(siteA, wsA.id);
    makeSite(siteB, wsB.id);

    // Each workspace only sees its own site.
    expect(db.getSitesForWorkspace(wsA.id).map(s => s.id)).toContain(siteA);
    expect(db.getSitesForWorkspace(wsA.id).map(s => s.id)).not.toContain(siteB);
    expect(db.getSitesForWorkspace(wsB.id).map(s => s.id)).toEqual([siteB]);

    // Bob (regular user) cannot access Alice's site; Alice (super-admin) can access both.
    expect(ws.canAccessSite(bob, siteA)).toBe(false);
    expect(ws.canAccessSite(bob, siteB)).toBe(true);
    expect(ws.canAccessSite(alice, siteA)).toBe(true);
    expect(ws.canAccessSite(alice, siteB)).toBe(true);

    // accessibleWorkspaces: Bob sees only his; the super-admin sees all.
    expect(ws.accessibleWorkspaces(bob).map(w => w.id)).toEqual([wsB.id]);
    const adminIds = ws.accessibleWorkspaces(alice).map(w => w.id);
    expect(adminIds).toContain(wsA.id);
    expect(adminIds).toContain(wsB.id);
  });

  it('clearAuthForWorkspace only clears the calling workspace’s Google accounts', () => {
    const eve = users.createUser({ email: `eve-${randomUUID()}@x.com`, password: 'password123' });
    const frank = users.createUser({ email: `frank-${randomUUID()}@x.com`, password: 'password123' });
    const wsE = ws.bootstrapUserWorkspace(eve, false);
    const wsF = ws.bootstrapUserWorkspace(frank, false);
    const mkAcct = (workspaceId: string) => {
      const id = `ga-${randomUUID().slice(0, 8)}`;
      db.upsertGoogleAccount({ id, email: `${id}@x.com`, client_id: 'c', client_secret: 's', access_token: null, refresh_token: 'r', token_expiry: null, workspace_id: workspaceId });
      return id;
    };
    mkAcct(wsE.id); mkAcct(wsE.id); mkAcct(wsF.id);
    expect(db.getGoogleAccountsForWorkspace(wsE.id)).toHaveLength(2);
    expect(db.getGoogleAccountsForWorkspace(wsF.id)).toHaveLength(1);

    // The bug: this used to wipe EVERY workspace's accounts. It must not.
    googleAuth.clearAuthForWorkspace(wsE.id);
    expect(db.getGoogleAccountsForWorkspace(wsE.id)).toHaveLength(0);
    expect(db.getGoogleAccountsForWorkspace(wsF.id)).toHaveLength(1); // Frank untouched
  });

  it('resolves the Bing key from the site’s own workspace', () => {
    const carol = users.createUser({ email: `carol-${randomUUID()}@x.com`, password: 'password123' });
    const wsC = ws.bootstrapUserWorkspace(carol, false);
    ws.addBingAccount(wsC.id, 'Carol Bing', 'carol-secret-key');

    const site = `c-${randomUUID().slice(0, 8)}`;
    makeSite(site, wsC.id);
    expect(ws.bingKeyForSite(site)).toBe('carol-secret-key');

    // A site in a workspace with no Bing account resolves to null (no cross-tenant leak).
    const dave = users.createUser({ email: `dave-${randomUUID()}@x.com`, password: 'password123' });
    const wsD = ws.bootstrapUserWorkspace(dave, false);
    const siteD = `d-${randomUUID().slice(0, 8)}`;
    makeSite(siteD, wsD.id);
    expect(ws.bingKeyForSite(siteD)).toBeNull();
  });

  it('does not let a member removal orphan the owner, and members gain access', () => {
    const owner = users.createUser({ email: `own-${randomUUID()}@x.com`, password: 'password123' });
    const guest = users.createUser({ email: `guest-${randomUUID()}@x.com`, password: 'password123' });
    const shared = ws.bootstrapUserWorkspace(owner, false);
    const site = `s-${randomUUID().slice(0, 8)}`;
    makeSite(site, shared.id);

    expect(ws.canAccessSite(guest, site)).toBe(false);
    ws.addWorkspaceMember(shared.id, guest.id);
    expect(ws.canAccessSite(guest, site)).toBe(true);
    expect(ws.canManageWorkspace(guest, shared.id)).toBe(false); // member, not owner
    expect(ws.canManageWorkspace(owner, shared.id)).toBe(true);

    ws.removeWorkspaceMember(shared.id, guest.id);
    expect(ws.canAccessSite(guest, site)).toBe(false);
  });
});
