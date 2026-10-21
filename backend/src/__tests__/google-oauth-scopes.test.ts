import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// The Google authorization URL must request exactly the scopes the user chose.
// Incremental auth (include_granted_scopes) used to fold a previously granted
// cloud-platform scope back into every reconnect, so unticking Auto-configure
// never took the grant out of Workspace Google Cloud session control.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-oauth-scopes-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'oauth-scopes-secret-1234567890';

type OAuthMod = typeof import('../auth/google-oauth.js');
let oauth: OAuthMod;
let userId: string;
let workspaceId: string;

beforeAll(async () => {
  oauth = await import('../auth/google-oauth.js');
  const users = await import('../auth/users.js');
  const workspaces = await import('../auth/workspaces.js');
  const user = users.createUser({ email: `scopes-${randomUUID()}@x.com`, password: 'password123' });
  userId = user.id;
  workspaceId = workspaces.bootstrapUserWorkspace(user, false).id;
});

function authorize(opts: { autoSetup?: boolean; ads?: boolean } = {}): URL {
  return new URL(oauth.createGoogleOAuthAuthorization({
    userId, workspaceId, redirectUri: 'https://app.test/api/auth/google/callback',
    clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'shh', ...opts,
  }));
}

describe('Google authorization scopes', () => {
  it('never uses incremental auth, so old grants cannot be re-attached', () => {
    expect(authorize().searchParams.has('include_granted_scopes')).toBe(false);
    expect(authorize({ ads: true }).searchParams.has('include_granted_scopes')).toBe(false);
  });

  it('requests cloud-platform only when Auto-configure is ticked', () => {
    expect(authorize().searchParams.get('scope')).not.toContain(oauth.CLOUD_PLATFORM_SCOPE);
    expect(authorize({ ads: true }).searchParams.get('scope')).not.toContain(oauth.CLOUD_PLATFORM_SCOPE);
    expect(authorize({ autoSetup: true }).searchParams.get('scope')).toContain(oauth.CLOUD_PLATFORM_SCOPE);
  });

  it('keeps the core scopes and adds Google Ads only when asked', () => {
    const core = authorize().searchParams.get('scope')!;
    for (const scope of oauth.OAUTH_SCOPES.split(' ')) expect(core).toContain(scope);
    expect(core).not.toContain(oauth.GOOGLE_ADS_SCOPE);
    expect(authorize({ ads: true }).searchParams.get('scope')).toContain(oauth.GOOGLE_ADS_SCOPE);
  });

  it('still asks for an offline grant with a fresh consent', () => {
    const url = authorize();
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toContain('consent');
  });
});
