import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// People run several Google accounts in one browser. Every Google sign-in must
// show Google's account chooser (never a login hint that lets Google pick),
// a reconnect that comes back as another account must change nothing, and a
// sign-in that ran in the same tab (pop-ups blocked) must find its way back.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-account-chooser-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'account-chooser-secret-1234567890';

type Mods = {
  db: typeof import('../db/database.js');
  oauth: typeof import('../auth/google-oauth.js');
  page: typeof import('../auth/google-result-page.js');
};
let m: Mods;
let userId = '';
let workspaceId = '';
const CLIENT = '123456789012-x.apps.googleusercontent.com';

beforeAll(async () => {
  m = { db: await import('../db/database.js'), oauth: await import('../auth/google-oauth.js'), page: await import('../auth/google-result-page.js') };
  const users = await import('../auth/users.js');
  const workspaces = await import('../auth/workspaces.js');
  const user = users.createUser({ email: `chooser-${randomUUID()}@x.com`, password: 'password123' });
  userId = user.id;
  workspaceId = workspaces.bootstrapUserWorkspace(user, false).id;
});

const base = () => ({ userId, workspaceId, redirectUri: 'https://app.test/api/auth/google/callback', clientId: CLIENT, clientSecret: 's' });

describe('account chooser', () => {
  it('always asks Google to show the chooser, and never sends a login hint', () => {
    for (const opts of [{}, { expectEmail: 'owner@acme.test' }, { only: ['ads' as const] }]) {
      const url = new URL(m.oauth.createGoogleOAuthAuthorization({ ...base(), ...opts }));
      expect(url.searchParams.get('prompt')).toBe('select_account consent');
      expect(url.searchParams.has('login_hint')).toBe(false);
    }
  });

  it('remembers who a reconnect is for and where to come back to', () => {
    const url = new URL(m.oauth.createGoogleOAuthAuthorization({ ...base(), expectEmail: 'owner@acme.test', returnTo: '/ads?tab=setup' }));
    const pending = m.oauth.consumeGoogleOAuthState(url.searchParams.get('state')!);
    expect(pending).toMatchObject({ purpose: 'connect', payload: { expectEmail: 'owner@acme.test', returnTo: '/ads?tab=setup' } });
  });

  it('refuses a reconnect that comes back as a different Google account', async () => {
    m.db.upsertGoogleAccount({
      id: 'owner@acme.test', email: 'owner@acme.test', client_id: CLIENT, client_secret: 's', access_token: 'old', refresh_token: 'old-refresh',
      token_expiry: new Date(Date.now() + 3_600_000).toISOString(), granted_scopes: m.oauth.OAUTH_SCOPES, workspace_id: workspaceId, owner_user_id: userId,
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => ({
      ok: true, status: 200,
      json: async () => String(input).includes('/token') ? { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: m.oauth.OAUTH_SCOPES } : { email: 'someone.else@gmail.com' },
    }) as unknown as Response));
    try {
      await expect(m.oauth.exchangeCodeForTokens('code', 'https://app.test/cb', workspaceId, userId, { clientId: CLIENT, clientSecret: 's' }, { expectEmail: 'owner@acme.test' }))
        .rejects.toThrow(/You chose someone\.else@gmail\.com .* reconnect for owner@acme\.test, so nothing was changed/);
      expect(m.db.getGoogleAccountById('someone.else@gmail.com')).toBeNull();
      expect(m.db.getGoogleAccountById('owner@acme.test')!.refresh_token).toBe('old-refresh');
      // A new connection (no expected account) takes whichever account was chosen.
      const added = await m.oauth.exchangeCodeForTokens('code', 'https://app.test/cb', workspaceId, userId, { clientId: CLIENT, clientSecret: 's' });
      expect(added).toMatchObject({ email: 'someone.else@gmail.com', accountId: 'someone.else@gmail.com' });
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('same-tab sign-in', () => {
  it('only accepts same-site paths to return to', () => {
    expect(m.oauth.safeReturnTo('/reviews?tab=setup&location=abc')).toBe('/reviews?tab=setup&location=abc');
    for (const bad of ['https://evil.test/', '//evil.test/x', '/\\evil.test', 'javascript:alert(1)', '/a"onmouseover="x', '/<script>', 'relative/path', 42]) {
      expect(m.oauth.safeReturnTo(bad)).toBeUndefined();
    }
  });

  it('reports to the opener in a pop-up, and goes back in the same tab', () => {
    const html = m.page.googleResultPage({
      ok: true, title: 'Connected a@b.test', message: 'ok', post: { type: 'GOOGLE_AUTH_SUCCESS', email: 'a@b.test' },
      openerOrigin: 'https://app.test', returnTo: '/ads?tab=setup', autoClose: true,
    });
    expect(html).toContain('window.opener.postMessage({"type":"GOOGLE_AUTH_SUCCESS","email":"a@b.test"}, "https://app.test")');
    expect(html).toContain('window.location.replace("/ads?tab=setup")');
  });

  it('keeps script content inert', () => {
    const html = m.page.googleResultPage({ ok: false, title: '<b>x</b>', message: 'm', post: { error: '</script><script>alert(1)</script>' }, openerOrigin: 'https://app.test', returnTo: null });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
