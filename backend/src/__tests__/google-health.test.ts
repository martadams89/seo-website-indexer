import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Connection health: which permissions a connection's uses need but its grant
// lacks, which APIs Google reports as switched off, and the one-off "switch
// the APIs on" sign-in, which must ask for Cloud access without keeping it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-google-health-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'google-health-secret-1234567890';

type Mods = {
  db: typeof import('../db/database.js');
  oauth: typeof import('../auth/google-oauth.js');
  health: typeof import('../auth/google-health.js');
};
let m: Mods;
let userId: string;
let workspaceId: string;

const noUse = { sites: 0, indexingSites: 0, ads: 0, locations: 0, ga4: false, workspaces: [] as string[] };

function account(scopes: string[], extra: Partial<import('../db/database.js').GoogleAccount> = {}) {
  const id = randomUUID();
  const acc = {
    id: `acc-${id}`, email: `owner-${id}@example.com`, client_id: '123456789-abc.apps.googleusercontent.com', client_secret: 'shh',
    access_token: 'live-token', refresh_token: 'refresh', token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    granted_scopes: scopes.join(' '), workspace_id: workspaceId, owner_user_id: userId, ...extra,
  };
  m.db.upsertGoogleAccount(acc);
  return m.db.getGoogleAccountById(acc.id)!;
}

const disabledBody = (service: string) => ({
  error: { code: 403, status: 'PERMISSION_DENIED', message: `${service} has not been used in project 123456789 before or it is disabled.`,
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', metadata: { service } }] },
});

beforeAll(async () => {
  m = {
    db: await import('../db/database.js'),
    oauth: await import('../auth/google-oauth.js'),
    health: await import('../auth/google-health.js'),
  };
  const users = await import('../auth/users.js');
  const workspaces = await import('../auth/workspaces.js');
  const user = users.createUser({ email: `health-${randomUUID()}@x.com`, password: 'password123' });
  userId = user.id;
  workspaceId = workspaces.bootstrapUserWorkspace(user, false).id;
});

describe('scopeNeeds', () => {
  it('asks for Ads and Business Profile only when something uses them', () => {
    const acc = account(m.oauth.OAUTH_SCOPES.split(' '));
    expect(m.health.scopeNeeds(acc, noUse)).toEqual([]);
    const needs = m.health.scopeNeeds(acc, { ...noUse, ads: 2, locations: 1 });
    expect(needs.map(n => n.scope)).toEqual([m.oauth.GOOGLE_ADS_SCOPE, m.oauth.GOOGLE_BUSINESS_SCOPE]);
    expect(needs[0].reason).toContain('2 Google Ads clients');
  });

  it('is satisfied once the grant carries the scope', () => {
    const acc = account([...m.oauth.OAUTH_SCOPES.split(' '), m.oauth.GOOGLE_BUSINESS_SCOPE]);
    expect(m.health.scopeNeeds(acc, { ...noUse, locations: 3 })).toEqual([]);
  });

  it('skips connections that never recorded their scopes', () => {
    const acc = account([]);
    expect(m.health.scopeNeeds(acc, { ...noUse, sites: 4, ads: 1 })).toEqual([]);
  });
});

describe('disabledServiceFrom', () => {
  it('reads the service from a SERVICE_DISABLED error', () => {
    expect(m.health.disabledServiceFrom(403, disabledBody('googleads.googleapis.com'))).toBe('googleads.googleapis.com');
  });
  it('ignores other failures', () => {
    expect(m.health.disabledServiceFrom(403, { error: { message: 'The caller does not have permission' } })).toBeNull();
    expect(m.health.disabledServiceFrom(429, disabledBody('googleads.googleapis.com'))).toBeNull();
    expect(m.health.disabledServiceFrom(401, null)).toBeNull();
  });
});

describe('probeDisabledApis', () => {
  it('reports switched-off APIs and the Business Profile APIs that travel together', async () => {
    const seen: string[] = [];
    m.health.__setHealthFetcherForTests(async url => {
      seen.push(url);
      if (url.includes('mybusinessaccountmanagement')) return new Response(JSON.stringify(disabledBody('mybusinessaccountmanagement.googleapis.com')), { status: 403 });
      return new Response('{}', { status: 200 });
    });
    const acc = account([...m.oauth.OAUTH_SCOPES.split(' '), m.oauth.GOOGLE_ADS_SCOPE, m.oauth.GOOGLE_BUSINESS_SCOPE]);
    const disabled = await m.health.probeDisabledApis(acc, { fresh: true, use: { ...noUse, ads: 1, locations: 1 } });
    expect(seen.some(u => u.includes('googleads.googleapis.com'))).toBe(true);
    expect(disabled.map(d => d.service).sort()).toEqual([
      'businessprofileperformance.googleapis.com', 'mybusiness.googleapis.com',
      'mybusinessaccountmanagement.googleapis.com', 'mybusinessbusinessinformation.googleapis.com',
    ]);
  });

  it('only probes APIs the grant can reach', async () => {
    const seen: string[] = [];
    m.health.__setHealthFetcherForTests(async url => { seen.push(url); return new Response('{}', { status: 200 }); });
    const acc = account(m.oauth.OAUTH_SCOPES.split(' '));
    expect(await m.health.probeDisabledApis(acc, { fresh: true, use: { ...noUse, ads: 1, locations: 1 } })).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe('connectionHealth', () => {
  it('flags missing permissions and carries Ads and Business Profile into the reconnect', async () => {
    const acc = account([...m.oauth.OAUTH_SCOPES.split(' '), m.oauth.GOOGLE_ADS_SCOPE]);
    const h = await m.health.connectionHealth(acc);
    expect(h.status).toBe('ok');
    expect(h.reconnect_with).toEqual({ ads: true, business: false });
    expect(h.cloud_scope).toBe(false);
    expect(h.project).toBe('123456789');
  });

  it('marks a Testing-mode refresh grant and a dead token', async () => {
    const expiring = await m.health.connectionHealth(account(m.oauth.OAUTH_SCOPES.split(' '), { refresh_token_expiry: new Date(Date.now() + 5 * 86_400_000).toISOString() }));
    expect(expiring.status).toBe('attention');
    const acc = account(m.oauth.OAUTH_SCOPES.split(' '));
    m.db.getDb().prepare('UPDATE google_accounts SET needs_reauth=1 WHERE id=?').run(acc.id);
    expect((await m.health.connectionHealth(m.db.getGoogleAccountById(acc.id)!)).status).toBe('reconnect');
  });
});

describe('one-off API enable sign-in', () => {
  it('asks for Cloud access once, online only, and remembers what to switch on', () => {
    const acc = account(m.oauth.OAUTH_SCOPES.split(' '));
    const url = new URL(m.oauth.createApiEnableAuthorization({
      userId, workspaceId, redirectUri: 'https://app.test/api/auth/google/callback', account: acc, services: ['googleads.googleapis.com'],
    }));
    expect(url.searchParams.get('scope')).toBe(m.oauth.CLOUD_PLATFORM_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.get('login_hint')).toBe(acc.email);
    const pending = m.oauth.consumeGoogleOAuthState(url.searchParams.get('state')!);
    expect(pending?.purpose).toBe('enable_apis');
    expect(pending?.payload).toEqual({ services: ['googleads.googleapis.com'], accountId: acc.id });
    expect(m.oauth.consumeGoogleOAuthState(url.searchParams.get('state')!)).toBeNull();
  });

  it('leaves ordinary connects as connects', () => {
    const url = new URL(m.oauth.createGoogleOAuthAuthorization({
      userId, workspaceId, redirectUri: 'https://app.test/api/auth/google/callback', clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'shh',
    }));
    expect(m.oauth.consumeGoogleOAuthState(url.searchParams.get('state')!)?.purpose).toBe('connect');
  });
});
