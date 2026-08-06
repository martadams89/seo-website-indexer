import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Google OAuth token refresh resilience. When Google refuses to mint a new
// access token from a stored refresh token — the token was revoked, expired,
// or (the case that prompted this) killed by a Workspace reauth/session-control
// policy surfacing as "invalid_grant: ... invalid_rapt" — we must flag the
// account needs_reauth (so the UI prompts a reconnect and the scheduler stops
// hammering a dead token) and raise an actionable error. A later successful
// refresh must clear that flag.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-token-refresh-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'token-refresh-secret-1234567890';

type DbMod = typeof import('../db/database.js');
type OAuthMod = typeof import('../auth/google-oauth.js');
let db: DbMod;
let oauth: OAuthMod;

beforeAll(async () => {
  db = await import('../db/database.js');
  oauth = await import('../auth/google-oauth.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Seed an account whose access token is already expired so any read forces a refresh. */
function seedExpiredAccount(): string {
  const id = `${randomUUID().slice(0, 8)}@workspace.example`;
  db.upsertGoogleAccount({
    id, email: id, client_id: '123-abc.apps.googleusercontent.com', client_secret: 'shh',
    access_token: 'stale', refresh_token: 'rt', token_expiry: new Date(Date.now() - 60_000).toISOString(),
    workspace_id: null, owner_user_id: null,
  });
  return id;
}

describe('Google token refresh', () => {
  it('coalesces concurrent refreshes for the same account', async () => {
    const id = seedExpiredAccount();
    const fetchMock = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: 'shared-fresh-token', expires_in: 3600 }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const tokens = await Promise.all([
      oauth.getAccessTokenForAccount(id),
      oauth.getAccessTokenForAccount(id),
      oauth.getAccessTokenForAccount(id),
    ]);

    expect(tokens).toEqual(['shared-fresh-token', 'shared-fresh-token', 'shared-fresh-token']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records a time-limited refresh grant returned by Google', async () => {
    const id = `${randomUUID().slice(0, 8)}@example.com`;
    oauth.saveCredentials('123-abc.apps.googleusercontent.com', 'shh');
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/token')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            access_token: 'issued-access-token', refresh_token: 'issued-refresh-token',
            expires_in: 3600, refresh_token_expires_in: 604800,
            scope: 'https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/userinfo.email',
          }),
        } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        json: async () => ({ email: id }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    await oauth.exchangeCodeForTokens('code', 'https://example.test/api/auth/google/callback');

    const account = db.getGoogleAccountById(id);
    expect(account?.refresh_token_expiry).toBeTruthy();
    const remaining = new Date(account!.refresh_token_expiry!).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(6 * 86_400_000);
    expect(remaining).toBeLessThanOrEqual(7 * 86_400_000);
    expect(account?.granted_scopes).toContain('/auth/webmasters');
  });

  it('flags needs_reauth on an invalid_rapt reauth failure and raises an actionable error', async () => {
    const id = seedExpiredAccount();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ error: 'invalid_grant', error_subtype: 'invalid_rapt', error_description: 'reauth required' }),
    } as unknown as Response)));

    await expect(oauth.getAccessTokenForAccount(id)).rejects.toThrow(/reconnect this account/i);
    expect(db.getGoogleAccountById(id)?.needs_reauth).toBe(1);
    expect(db.getGoogleAccountById(id)?.last_refresh_error).toContain('invalid_rapt');
  });

  it('flags needs_reauth on a plain revoked/expired refresh token', async () => {
    const id = seedExpiredAccount();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
    } as unknown as Response)));

    await expect(oauth.getAccessTokenForAccount(id)).rejects.toThrow(/revoked or expired/i);
    expect(db.getGoogleAccountById(id)?.needs_reauth).toBe(1);
  });

  it('clears needs_reauth once a refresh succeeds again', async () => {
    const id = seedExpiredAccount();
    db.setGoogleAccountNeedsReauth(id, true);
    expect(db.getGoogleAccountById(id)?.needs_reauth).toBe(1);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ access_token: 'fresh-access-token', expires_in: 3600 }),
    } as unknown as Response)));

    const token = await oauth.getAccessTokenForAccount(id);
    expect(token).toBe('fresh-access-token');
    expect(db.getGoogleAccountById(id)?.needs_reauth).toBe(0);
  });

  it('does not flag on a transient non-grant error (e.g. temporary server error)', async () => {
    const id = seedExpiredAccount();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500,
      json: async () => ({ error: 'internal_failure', error_description: 'try again later' }),
    } as unknown as Response)));

    await expect(oauth.getAccessTokenForAccount(id)).rejects.toThrow(/Token refresh failed/i);
    expect(db.getGoogleAccountById(id)?.needs_reauth).toBe(0);
  });
});
