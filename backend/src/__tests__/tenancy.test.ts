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
let citations: typeof import('../ai/citations.js');

beforeAll(async () => {
  users = await import('../auth/users.js');
  ws = await import('../auth/workspaces.js');
  db = await import('../db/database.js');
  googleAuth = await import('../auth/google-oauth.js');
  citations = await import('../ai/citations.js');
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

  const mkAcct = (workspaceId: string, ownerUserId: string) => {
    const id = `ga-${randomUUID().slice(0, 8)}`;
    db.upsertGoogleAccount({ id, email: `${id}@x.com`, client_id: 'c', client_secret: 's', access_token: null, refresh_token: 'r', token_expiry: null, workspace_id: workspaceId, owner_user_id: ownerUserId });
    return id;
  };

  it('Google accounts are shared across all of one owner’s workspaces (account-level)', () => {
    const owner = users.createUser({ email: `owner-${randomUUID()}@x.com`, password: 'password123' });
    const wsOne = ws.bootstrapUserWorkspace(owner, false);
    const wsTwo = ws.createWorkspace('Client B', owner.id); // same owner, second workspace
    const acctId = mkAcct(wsOne.id, owner.id); // connected while in wsOne

    // The one account is available in BOTH of the owner's workspaces — so it's
    // selectable for a site in either, and never "no accounts connected".
    expect(db.getGoogleAccountsForWorkspace(wsOne.id)).toHaveLength(1);
    expect(db.getGoogleAccountsForWorkspace(wsTwo.id)).toHaveLength(1);

    // And it's actually usable (not just listed) in both — the check used to
    // authorize linking/using an account, not just displaying it.
    expect(db.isGoogleAccountAvailableToWorkspace(acctId, wsOne.id)).toBe(true);
    expect(db.isGoogleAccountAvailableToWorkspace(acctId, wsTwo.id)).toBe(true);

    // A different owner's workspace never sees it (strict cross-account isolation).
    const stranger = users.createUser({ email: `stranger-${randomUUID()}@x.com`, password: 'password123' });
    const wsStranger = ws.bootstrapUserWorkspace(stranger, false);
    expect(db.isGoogleAccountAvailableToWorkspace(acctId, wsStranger.id)).toBe(false);
  });

  it('a Google account already owned by one user cannot be taken over by another', () => {
    const owner = users.createUser({ email: `own2-${randomUUID()}@x.com`, password: 'password123' });
    const other = users.createUser({ email: `other-${randomUUID()}@x.com`, password: 'password123' });
    const acctId = mkAcct(ws.bootstrapUserWorkspace(owner, false).id, owner.id);

    // The original owner may always reconnect/refresh it.
    expect(db.canOwnGoogleAccount(acctId, owner.id)).toBe(true);
    // A different tenant reconnecting the SAME Google email must be rejected —
    // otherwise the upsert would silently overwrite the original owner's
    // tokens with the other tenant's, a cross-account credential clash.
    expect(db.canOwnGoogleAccount(acctId, other.id)).toBe(false);

    // A brand-new (never-connected) email has no owner yet, so anyone may claim it.
    expect(db.canOwnGoogleAccount(`ga-${randomUUID()}@x.com`, other.id)).toBe(true);
  });

  it('auth status is scoped to the workspace, not leaked from other tenants', () => {
    const connected = users.createUser({ email: `conn-${randomUUID()}@x.com`, password: 'password123' });
    const bare = users.createUser({ email: `bare-${randomUUID()}@x.com`, password: 'password123' });
    const wsConnected = ws.bootstrapUserWorkspace(connected, false);
    const wsBare = ws.bootstrapUserWorkspace(bare, false);
    mkAcct(wsConnected.id, connected.id);

    // A tenant with a connected Google account sees itself as authenticated...
    expect(googleAuth.getAuthStatus(wsConnected.id).authenticated).toBe(true);
    // ...but a totally unrelated tenant with NO accounts of its own must not,
    // even though some other tenant in the same install has one connected.
    expect(googleAuth.getAuthStatus(wsBare.id).authenticated).toBe(false);
  });

  it('clearAuthForWorkspace only clears the calling owner’s Google accounts', () => {
    const eve = users.createUser({ email: `eve-${randomUUID()}@x.com`, password: 'password123' });
    const frank = users.createUser({ email: `frank-${randomUUID()}@x.com`, password: 'password123' });
    const wsE = ws.bootstrapUserWorkspace(eve, false);
    const wsF = ws.bootstrapUserWorkspace(frank, false);
    mkAcct(wsE.id, eve.id); mkAcct(wsE.id, eve.id); mkAcct(wsF.id, frank.id);
    expect(db.getGoogleAccountsForWorkspace(wsE.id)).toHaveLength(2);
    expect(db.getGoogleAccountsForWorkspace(wsF.id)).toHaveLength(1);

    // The bug: this used to wipe EVERY owner's accounts. It must not.
    googleAuth.clearAuthForWorkspace(wsE.id);
    expect(db.getGoogleAccountsForWorkspace(wsE.id)).toHaveLength(0);
    expect(db.getGoogleAccountsForWorkspace(wsF.id)).toHaveLength(1); // Frank untouched
  });

  it('run locks + run history are per-workspace (concurrent tenant runs)', () => {
    const gina = users.createUser({ email: `gina-${randomUUID()}@x.com`, password: 'password123' });
    const hank = users.createUser({ email: `hank-${randomUUID()}@x.com`, password: 'password123' });
    const wsG = ws.bootstrapUserWorkspace(gina, false);
    const wsH = ws.bootstrapUserWorkspace(hank, false);

    // A run in one workspace does NOT block another workspace.
    expect(db.acquireRunLock('run-g1', wsG.id)).toBe(true);
    expect(db.acquireRunLock('run-g2', wsG.id)).toBe(false); // G already running
    expect(db.acquireRunLock('run-h1', wsH.id)).toBe(true);  // H runs concurrently
    db.releaseRunLock(wsG.id);
    expect(db.acquireRunLock('run-g3', wsG.id)).toBe(true);   // G free again
    db.releaseRunLock(wsG.id); db.releaseRunLock(wsH.id);

    // Run history is scoped to the owning workspace.
    const mkRun = (id: string, workspaceId: string) => db.insertRun({
      id, workspace_id: workspaceId, started_at: new Date().toISOString(), finished_at: null,
      status: 'completed', total_submitted: 0, total_skipped: 0, total_failed: 0, trigger: 'manual',
    });
    mkRun('hist-g', wsG.id); mkRun('hist-h', wsH.id);
    const gRuns = db.getRecentRuns(50, wsG.id).map(r => r.id);
    expect(gRuns).toContain('hist-g');
    expect(gRuns).not.toContain('hist-h'); // no cross-tenant leak
  });

  it('live logs are scoped to the workspace of their run', () => {
    const ida = users.createUser({ email: `ida-${randomUUID()}@x.com`, password: 'password123' });
    const jack = users.createUser({ email: `jack-${randomUUID()}@x.com`, password: 'password123' });
    const wsI = ws.bootstrapUserWorkspace(ida, false);
    const wsJ = ws.bootstrapUserWorkspace(jack, false);
    db.insertLog({ run_id: 'run-i', workspace_id: wsI.id, level: 'info', message: 'i-log' });
    db.insertLog({ run_id: 'run-j', workspace_id: wsJ.id, level: 'info', message: 'j-log' });
    const iLogs = db.getRecentLogs(500, wsI.id).map(l => l.message);
    expect(iLogs).toContain('i-log');
    expect(iLogs).not.toContain('j-log'); // no cross-tenant log leak
    expect(db.getLogsForRun('run-j', wsI.id)).toHaveLength(0); // can't read another tenant's run logs
  });

  it('AI citation prompts + results are scoped per workspace', () => {
    const kate = users.createUser({ email: `kate-${randomUUID()}@x.com`, password: 'password123' });
    const liam = users.createUser({ email: `liam-${randomUUID()}@x.com`, password: 'password123' });
    const wsK = ws.bootstrapUserWorkspace(kate, false);
    const wsL = ws.bootstrapUserWorkspace(liam, false);
    citations.addPrompt('kate prompt', null, wsK.id);
    citations.addPrompt('liam prompt', null, wsL.id);
    const kPrompts = citations.listPrompts(wsK.id).map(p => p.prompt);
    expect(kPrompts).toContain('kate prompt');
    expect(kPrompts).not.toContain('liam prompt'); // no cross-tenant prompt leak
    // Deleting is workspace-guarded: Kate can't delete Liam's prompt.
    const liamPrompt = citations.listPrompts(wsL.id)[0];
    citations.deletePrompt(liamPrompt.id, wsK.id);
    expect(citations.listPrompts(wsL.id).map(p => p.id)).toContain(liamPrompt.id); // still there
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
