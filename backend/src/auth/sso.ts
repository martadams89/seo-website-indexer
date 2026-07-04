/**
 * SSO via OpenID Connect (authorization-code flow). Zero-dependency: builds the
 * authorize URL, exchanges the code for tokens, and reads the userinfo email.
 * Providers are configured purely through environment variables so nothing is
 * enabled unless an operator opts in:
 *
 *   Google:   SSO_GOOGLE_CLIENT_ID, SSO_GOOGLE_CLIENT_SECRET
 *   Generic:  SSO_OIDC_CLIENT_ID, SSO_OIDC_CLIENT_SECRET,
 *             SSO_OIDC_AUTH_URL, SSO_OIDC_TOKEN_URL, SSO_OIDC_USERINFO_URL,
 *             SSO_OIDC_NAME (label, optional)
 *
 * By default only users that already exist may sign in through SSO (email must
 * match). Set SSO_AUTO_PROVISION=true to create a new standard user on first
 * SSO login. The first user ever created is always allowed (bootstraps admin).
 */
import { randomUUID } from 'crypto';
import { getUserByEmail, createUser, countUsers, type User } from './users.js';
import { bootstrapUserWorkspace } from './workspaces.js';

interface ProviderConfig {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
}

function providerConfigs(): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  if (process.env.SSO_GOOGLE_CLIENT_ID && process.env.SSO_GOOGLE_CLIENT_SECRET) {
    out.push({
      id: 'google', name: 'Google',
      clientId: process.env.SSO_GOOGLE_CLIENT_ID, clientSecret: process.env.SSO_GOOGLE_CLIENT_SECRET,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid email profile',
    });
  }
  if (process.env.SSO_OIDC_CLIENT_ID && process.env.SSO_OIDC_CLIENT_SECRET
    && process.env.SSO_OIDC_AUTH_URL && process.env.SSO_OIDC_TOKEN_URL && process.env.SSO_OIDC_USERINFO_URL) {
    out.push({
      id: 'oidc', name: process.env.SSO_OIDC_NAME || 'SSO',
      clientId: process.env.SSO_OIDC_CLIENT_ID, clientSecret: process.env.SSO_OIDC_CLIENT_SECRET,
      authUrl: process.env.SSO_OIDC_AUTH_URL, tokenUrl: process.env.SSO_OIDC_TOKEN_URL,
      userinfoUrl: process.env.SSO_OIDC_USERINFO_URL,
      scope: process.env.SSO_OIDC_SCOPE || 'openid email profile',
    });
  }
  return out;
}

export function ssoProviders(): Array<{ id: string; name: string }> {
  return providerConfigs().map(p => ({ id: p.id, name: p.name }));
}

// Short-lived CSRF state store for the redirect round-trip.
const _states = new Map<string, number>();
const STATE_TTL_MS = 10 * 60_000;
function issueState(): string {
  const s = randomUUID();
  _states.set(s, Date.now() + STATE_TTL_MS);
  return s;
}
function consumeState(s: string | undefined): boolean {
  if (!s) return false;
  const exp = _states.get(s);
  _states.delete(s);
  return !!exp && exp > Date.now();
}

export function ssoAuthorizeUrl(providerId: string, redirectUri: string): string | null {
  const p = providerConfigs().find(x => x.id === providerId);
  if (!p) return null;
  const params = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scope,
    state: issueState(),
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${p.authUrl}?${params.toString()}`;
}

export async function ssoHandleCallback(
  providerId: string, code: string, state: string | undefined, redirectUri: string,
): Promise<User | null> {
  const p = providerConfigs().find(x => x.id === providerId);
  if (!p) return null;
  if (!consumeState(state)) throw new Error('Invalid or expired SSO state.');

  const tokenRes = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: p.clientId, client_secret: p.clientSecret,
      code, grant_type: 'authorization_code', redirect_uri: redirectUri,
    }).toString(),
  });
  const token = await tokenRes.json() as { access_token?: string; error?: string; error_description?: string };
  if (!token.access_token) throw new Error(token.error_description || token.error || 'Token exchange failed.');

  const infoRes = await fetch(p.userinfoUrl, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!infoRes.ok) throw new Error(`Userinfo request failed (HTTP ${infoRes.status}).`);
  const info = await infoRes.json() as { email?: string; email_verified?: boolean; name?: string };
  if (!info.email) throw new Error('SSO provider did not return an email.');
  const email = info.email.toLowerCase();

  const existing = getUserByEmail(email);
  if (existing) return existing;

  // No account yet — provision only if allowed (or this is the very first user).
  const isFirst = countUsers() === 0;
  if (!isFirst && process.env.SSO_AUTO_PROVISION !== 'true') {
    throw new Error('No account for this email. Ask an admin to add you first.');
  }
  const user = createUser({ email, password: randomUUID(), name: info.name, role: isFirst ? 'admin' : 'user', superAdmin: isFirst });
  bootstrapUserWorkspace(user, isFirst);
  return user;
}
