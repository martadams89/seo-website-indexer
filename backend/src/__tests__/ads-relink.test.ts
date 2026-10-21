import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Disconnecting a Google connection nulls ads_accounts.google_account_id
// (ON DELETE SET NULL). Reconnecting the same login used to leave the Ads
// account orphaned ("No Google connection is linked to …") with no way to
// relink it. It must now re-attach on its own when the choice is unambiguous,
// and never guess between several Google logins with Ads access.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-ads-relink-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'ads-relink-secret-1234567890';

type Mods = {
  db: typeof import('../db/database.js');
  users: typeof import('../auth/users.js');
  ws: typeof import('../auth/workspaces.js');
  oauth: typeof import('../auth/google-oauth.js');
  store: typeof import('../ads/store.js');
  changes: typeof import('../ads/changes.js');
};
let m: Mods;

beforeAll(async () => {
  m = {
    db: await import('../db/database.js'),
    users: await import('../auth/users.js'),
    ws: await import('../auth/workspaces.js'),
    oauth: await import('../auth/google-oauth.js'),
    store: await import('../ads/store.js'),
    changes: await import('../ads/changes.js'),
  };
});

function seedWorkspace(label: string) {
  const user = m.users.createUser({ email: `${label}-${randomUUID()}@x.com`, password: 'password123' });
  return { userId: user.id, workspaceId: m.ws.bootstrapUserWorkspace(user, false).id };
}

function connectGoogle(id: string, owner: { userId: string; workspaceId: string }, withAds = true) {
  m.db.upsertGoogleAccount({
    id, email: id, client_id: '123456789012-abc.apps.googleusercontent.com', client_secret: 'secret',
    access_token: 'x', refresh_token: 'refresh', token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    granted_scopes: withAds ? `${m.oauth.GOOGLE_ADS_SCOPE} https://www.googleapis.com/auth/webmasters` : 'https://www.googleapis.com/auth/webmasters',
    workspace_id: owner.workspaceId, owner_user_id: owner.userId,
  });
  m.db.shareGoogleAccountWithWorkspace(id, owner.workspaceId, owner.userId);
}

describe('Google Ads account relinking', () => {
  it('re-attaches an Ads account when its Google login is disconnected and reconnected', () => {
    const owner = seedWorkspace('weatherwise');
    const login = `owner-${randomUUID().slice(0, 6)}@weatherwise.test`;
    connectGoogle(login, owner);
    const acct = m.store.linkAdsAccount({ workspaceId: owner.workspaceId, googleAccountId: login, customerId: '3333333333', name: 'WeatherWise' });

    m.oauth.disconnectGoogleAccount(login);
    const orphan = m.store.getAdsAccount(acct.id)!;
    expect(orphan.google_account_id).toBeNull();
    expect(m.store.isOrphanedAdsAccount(orphan)).toBe(true);
    // Nothing to attach to yet: a clear, actionable error rather than a dead end.
    expect(() => m.changes.callContext(m.store.getAdsAccount(acct.id)!)).toThrow(/Find and link client accounts/);

    connectGoogle(login, owner); // the same Google login comes back
    const ctx = m.changes.callContext(m.store.getAdsAccount(acct.id)!);
    expect(ctx.googleAccountId).toBe(login);
    expect(m.store.getAdsAccount(acct.id)!.google_account_id).toBe(login); // persisted, not just in memory
  });

  it('heals a workspace in bulk (what the Ads page and the Google callback run)', () => {
    const owner = seedWorkspace('bulk');
    const login = `bulk-${randomUUID().slice(0, 6)}@agency.test`;
    connectGoogle(login, owner);
    const a = m.store.linkAdsAccount({ workspaceId: owner.workspaceId, googleAccountId: login, customerId: '4444444444' });
    const b = m.store.linkAdsAccount({ workspaceId: owner.workspaceId, googleAccountId: login, customerId: '5555555555' });
    m.oauth.disconnectGoogleAccount(login);
    connectGoogle(login, owner);

    expect(m.store.healOrphanedAdsAccounts(owner.workspaceId)).toBe(2);
    expect(m.store.getAdsAccount(a.id)!.google_account_id).toBe(login);
    expect(m.store.getAdsAccount(b.id)!.google_account_id).toBe(login);
    expect(m.store.healOrphanedAdsAccounts(owner.workspaceId)).toBe(0); // idempotent
  });

  it('does not guess between several Google logins with Ads access', () => {
    const owner = seedWorkspace('ambiguous');
    const first = `first-${randomUUID().slice(0, 6)}@agency.test`;
    const second = `second-${randomUUID().slice(0, 6)}@agency.test`;
    connectGoogle(first, owner);
    connectGoogle(second, owner);
    const acct = m.store.linkAdsAccount({ workspaceId: owner.workspaceId, googleAccountId: first, customerId: '6666666666' });
    m.oauth.disconnectGoogleAccount(first);
    connectGoogle(first, owner);

    expect(m.store.healOrphanedAdsAccount(acct.id)).toBeNull();
    expect(m.store.getAdsAccount(acct.id)!.google_account_id).toBeNull();
    expect(() => m.changes.callContext(m.store.getAdsAccount(acct.id)!)).toThrow(/Find and link client accounts/);
  });

  it('ignores logins without Google Ads access and leaves healthy links alone', () => {
    const owner = seedWorkspace('healthy');
    const ads = `ads-${randomUUID().slice(0, 6)}@agency.test`;
    const seoOnly = `seo-${randomUUID().slice(0, 6)}@agency.test`;
    connectGoogle(ads, owner);
    connectGoogle(seoOnly, owner, false);
    const acct = m.store.linkAdsAccount({ workspaceId: owner.workspaceId, googleAccountId: ads, customerId: '7777777777' });

    expect(m.store.isOrphanedAdsAccount(acct)).toBe(false);
    expect(m.store.healOrphanedAdsAccount(acct.id)).toBeNull();
    expect(m.store.getAdsAccount(acct.id)!.google_account_id).toBe(ads);
  });
});
