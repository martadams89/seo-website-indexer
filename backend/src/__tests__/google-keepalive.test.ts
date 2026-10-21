import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Proactive token keep-alive: refresh near-expiry Google tokens ahead of demand
// so API calls stay warm and a dead grant surfaces within minutes. It must skip
// comfortably-valid tokens and accounts already flagged needs_reauth.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-keepalive-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'keepalive-secret-1234567890';

type DbMod = typeof import('../db/database.js');
type OAuthMod = typeof import('../auth/google-oauth.js');
let db: DbMod; let oauth: OAuthMod;

beforeAll(async () => {
  db = await import('../db/database.js');
  oauth = await import('../auth/google-oauth.js');
});

afterEach(() => vi.unstubAllGlobals());

function seedAccount(opts: { minutesToExpiry: number; needsReauth?: boolean }): string {
  const id = `${randomUUID().slice(0, 8)}@example.com`;
  db.upsertGoogleAccount({
    id, email: id, client_id: '123-abc.apps.googleusercontent.com', client_secret: 'shh',
    access_token: 'stale', refresh_token: 'rt',
    token_expiry: new Date(Date.now() + opts.minutesToExpiry * 60_000).toISOString(),
    workspace_id: null, owner_user_id: null,
  });
  if (opts.needsReauth) db.setGoogleAccountNeedsReauth(id, true);
  return id;
}

describe('proactive Google token keep-alive', () => {
  it('refreshes a token near expiry, skips a fresh one, and skips needs_reauth accounts', async () => {
    const near = seedAccount({ minutesToExpiry: 5 });      // inside the 15-min window → refresh
    const fresh = seedAccount({ minutesToExpiry: 55 });     // comfortably valid → skip
    const dead = seedAccount({ minutesToExpiry: -10, needsReauth: true }); // flagged → skip

    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ access_token: 'warm-token', expires_in: 3600 }),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);

    const result = await oauth.proactivelyRefreshGoogleTokens();

    expect(result.refreshed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the near-expiry account hit Google
    expect(db.getGoogleAccountById(near)?.access_token).toBe('warm-token');
    expect(db.getGoogleAccountById(fresh)?.access_token).toBe('stale'); // untouched
    expect(db.getGoogleAccountById(dead)?.access_token).toBe('stale');  // skipped
  });

  it('counts a failed refresh without throwing (and the account is flagged)', async () => {
    const near = seedAccount({ minutesToExpiry: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }),
    } as unknown as Response)));

    const result = await oauth.proactivelyRefreshGoogleTokens();
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(db.getGoogleAccountById(near)?.needs_reauth).toBe(1);
  });
});
