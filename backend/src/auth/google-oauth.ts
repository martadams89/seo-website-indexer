/**
 * google-oauth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Google OAuth 2.0 Web Application Flow with offline refresh tokens
 *
 * THE OUT-OF-THE-BOX SOLUTION — PRE-CONFIGURED OAUTH CLIENT:
 * ─────────────────────────────────────────────────────────────
 * This app can use a pre-configured Google OAuth client ID and secret.
 *
 *   • Users get a zero-setup, one-click "Sign in with Google" experience out of the box.
 *   • Users authorize in a browser popup and the callback stores an offline grant.
 *   • Self-builders can easily override this via GOOGLE_OAUTH_CLIENT_ID and 
 *     GOOGLE_OAUTH_CLIENT_SECRET environment variables.
 *
 * TO CREATE YOUR OWN CLIENT (optional):
 *   1. console.cloud.google.com → APIs & Services → Credentials
 *   2. Enable: Google Search Console API
 *   3. Create Credentials → OAuth client ID → Web application
 *   4. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in your env
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getSetting,
  setSetting,
  getAllGoogleAccounts,
  getGoogleAccountsForWorkspace,
  getGoogleAccountById,
  upsertGoogleAccount,
  deleteGoogleAccount,
  setGoogleAccountNeedsReauth,
  setGoogleAccountRefreshError,
  canOwnGoogleAccount,
  type GoogleAccount
} from '../db/database.js';
import { logSystem } from '../utils/logger.js';

// ── OAuth Scopes ──────────────────────────────────────────────────────────────

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// ── Bundled / Built-in OAuth Client ──────────────────────────────────────────

const BUILTIN_CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID     || '';
const BUILTIN_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';

export function hasBuiltinCredentials(): boolean {
  return !!(BUILTIN_CLIENT_ID && BUILTIN_CLIENT_SECRET);
}

// ── Google OAuth Endpoints ────────────────────────────────────────────────────

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuthStatus {
  authenticated: boolean;
  /** true if env vars are set — user can click "Sign in" with no credential entry */
  hasBuiltinCredentials: boolean;
  expiresAt?: string;
  clientId?: string;
  error?: string;
}

// ── In-Memory Token Cache ─────────────────────────────────────────────────────

interface CachedToken {
  token: string;
  expiry: Date;
}
const _tokenCache = new Map<string, CachedToken>();
// Search Console requests for one account often start together. Without a
// single-flight guard, an expired access token could trigger several refreshes
// at once. That is wasteful and can lose a rotated refresh token if responses
// complete out of order.
const _refreshInFlight = new Map<string, Promise<string>>();

// ── Temporary Custom Credentials Cache ────────────────────────────────────────

let _tempClientId: string | null = null;
let _tempClientSecret: string | null = null;

/** Temporarily caches custom credentials before popup authentication begins. */
export function saveCredentials(clientId: string, clientSecret: string): void {
  _tempClientId = clientId.trim();
  _tempClientSecret = clientSecret.trim();
}

// ── Web Flow Token Exchange ───────────────────────────────────────────────────

async function fetchUserEmail(accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch user email (HTTP ${res.status})`);
  }
  const data = await res.json() as { email?: string };
  if (!data.email) {
    throw new Error('Google did not return user email address.');
  }
  return data.email;
}

/**
 * Exchanges the authorization code received from Google for access/refresh tokens.
 * Persists the credentials inside SQLite.
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string, workspaceId?: string | null, ownerUserId?: string | null): Promise<string> {
  const clientId     = _tempClientId     || BUILTIN_CLIENT_ID;
  const clientSecret = _tempClientSecret || BUILTIN_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('OAuth Client ID or Client Secret is missing. Please save credentials first.');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  redirectUri,
    }).toString(),
  });

  const data = await res.json() as {
    access_token?:  string;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    expires_in?:    number;
    scope?:         string;
    error?:         string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(data.error_description ?? `Token exchange failed: ${data.error}`);
  }

  if (!data.access_token) {
    throw new Error('No access token returned from Google.');
  }
  if (!data.refresh_token) {
    throw new Error('Google did not return a refresh token. If you previously connected, please go to Google Account Settings -> Security -> Third-party apps -> Remove access for this app and sign in again.');
  }

  const expiryDate = new Date(Date.now() + ((data.expires_in ?? 3600) - 300) * 1_000);
  const refreshTokenExpiry = data.refresh_token_expires_in
    ? new Date(Date.now() + data.refresh_token_expires_in * 1_000).toISOString()
    : null;
  const issuedAt = new Date().toISOString();
  
  // Fetch Google email address to identify account
  const email = await fetchUserEmail(data.access_token);

  // Reject if this Google account already belongs to a different tenant.
  // Without this, the upsert below would silently overwrite that tenant's
  // tokens with ours while leaving ownership unchanged — a cross-tenant
  // credential clash, not a real reassignment. Strict account-level tenancy:
  // a Google account connected under one account is never usable by another.
  if (ownerUserId && !canOwnGoogleAccount(email, ownerUserId)) {
    throw new Error(
      `This Google account (${email}) is already connected to a different account in this app. Disconnect it there first, or sign in with a different Google account.`
    );
  }

  // Save the new account (uses email as account ID for extreme simplicity and clarity).
  // owner_user_id makes the account available across ALL of the owner's
  // workspaces (account-level). workspace_id records the "home" workspace it was
  // first connected in. The upsert's COALESCE preserves both on token refresh.
  upsertGoogleAccount({
    id: email,
    email,
    client_id: clientId,
    client_secret: clientSecret,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_expiry: expiryDate.toISOString(),
    refresh_token_expiry: refreshTokenExpiry,
    granted_scopes: data.scope ?? null,
    last_refreshed_at: issuedAt,
    last_refresh_error: null,
    workspace_id: workspaceId ?? null,
    owner_user_id: ownerUserId ?? null,
  });

  // Reconnecting mints a fresh refresh token, so clear any stale reauth flag
  // (the upsert's ON CONFLICT preserves the old needs_reauth value otherwise).
  setGoogleAccountNeedsReauth(email, false);
  _tokenCache.delete(email);

  // Best-effort: enable the Google API this tool needs (Search Console) on the
  // linked project, so the user doesn't have to do it by
  // hand in the Cloud console. Needs the cloud-platform scope; if that wasn't
  // granted the enable calls 403 and we skip silently (logged). Fire-and-forget
  // so it never delays the OAuth response.
  if ((data.scope ?? '').split(' ').includes('https://www.googleapis.com/auth/cloud-platform')) {
    void enableRequiredApis(data.access_token, clientId, email);
  }

  // Clear in-memory temp custom credentials
  _tempClientId = null;
  _tempClientSecret = null;

  return data.access_token;
}

// The project that owns the OAuth client is encoded in the numeric prefix of
// the client id ("123456789-abc.apps.googleusercontent.com").
function projectFromClientId(clientId: string): string | null {
  const m = /^(\d{6,})-/.exec(clientId);
  return m ? m[1] : null;
}

const AUTO_ENABLE_SERVICES = ['searchconsole.googleapis.com'];

/**
 * Enable the APIs the tool depends on, on the project owning the OAuth client.
 * Idempotent (Google no-ops an already-enabled service). Best-effort — any
 * failure (no cloud-platform scope, no permission) is logged, not thrown.
 */
export async function enableRequiredApis(accessToken: string, clientId: string, label: string): Promise<{ enabled: string[]; skipped: string[] }> {
  const project = projectFromClientId(clientId);
  const enabled: string[] = [];
  const skipped: string[] = [];
  if (!project) return { enabled, skipped: [...AUTO_ENABLE_SERVICES] };
  for (const svc of AUTO_ENABLE_SERVICES) {
    try {
      const res = await fetch(`https://serviceusage.googleapis.com/v1/projects/${project}/services/${svc}:enable`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) enabled.push(svc);
      else skipped.push(svc);
    } catch {
      skipped.push(svc);
    }
  }
  if (enabled.length) logSystem('ok', `Auto-enabled Google APIs for ${label}: ${enabled.map(s => s.replace('.googleapis.com', '')).join(', ')}`);
  else logSystem('dim', `Could not auto-enable Google APIs for ${label} (grant Cloud access when connecting, or enable them manually) — Search Console calls still work if the API is already enabled on the project.`);
  return { enabled, skipped };
}

// ── Token Refresh ─────────────────────────────────────────────────────────────

async function refreshAccountToken(account: GoogleAccount): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     account.client_id,
      client_secret: account.client_secret,
      refresh_token: account.refresh_token,
      grant_type:    'refresh_token',
    }).toString(),
  });

  const data = await res.json() as {
    access_token?: string;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_subtype?: string;
    error_description?: string;
  };
  if (!data.access_token) {
    // 'invalid_grant' = the refresh token is permanently dead: the user revoked
    // access, it expired (~6 months unused or a seven-day Testing grant), OR a Google Workspace reauth /
    // session-control policy killed it. The last case surfaces as
    // "invalid_grant: reauth related error (invalid_rapt)" and is triggered by
    // the sensitive cloud-platform scope (opt-in "Auto-configure" box) — the
    // core Search Console scope doesn't attract it. Persist a needs_reauth
    // flag so the UI can prompt for reconnection and the scheduler stops
    // retrying a token that will never refresh again.
    const isInvalidGrant = data.error === 'invalid_grant';
    const isReauth = isInvalidGrant && /rapt|reauth/i.test(`${data.error_subtype ?? ''} ${data.error_description ?? ''}`);
    const refreshError = `${data.error ?? `HTTP ${res.status}`}${data.error_subtype ? `/${data.error_subtype}` : ''}${data.error_description ? `: ${data.error_description}` : ''}`;
    setGoogleAccountRefreshError(account.id, refreshError);
    if (isInvalidGrant) setGoogleAccountNeedsReauth(account.id, true);
    _tokenCache.delete(account.id);
    throw new Error(
      `Token refresh failed for ${account.email || 'account'} (${data.error ?? 'unknown'}${data.error_subtype ? `/${data.error_subtype}` : ''}${data.error_description ? `: ${data.error_description}` : ''}). ` +
      (isReauth
        ? 'Your Google Workspace requires periodic re-authentication (reauth policy). Please reconnect this account on the Accounts page — leaving "Auto-configure Google APIs" unchecked avoids this recurring for managed accounts.'
        : isInvalidGrant
          ? 'Refresh token has been revoked or expired. Please reconnect this account on the Accounts page.'
          : 'Please re-connect this account on the Google Accounts tab.')
    );
  }

  const expiryDate = new Date(Date.now() + ((data.expires_in ?? 3600) - 300) * 1_000);

  account.access_token = data.access_token;
  account.token_expiry = expiryDate.toISOString();
  account.last_refreshed_at = new Date().toISOString();
  account.last_refresh_error = null;
  if (data.refresh_token_expires_in) {
    account.refresh_token_expiry = new Date(Date.now() + data.refresh_token_expires_in * 1_000).toISOString();
  }
  if (data.scope) account.granted_scopes = data.scope;
  // Google occasionally rotates the refresh token — persist the new one if provided.
  if (data.refresh_token && data.refresh_token !== account.refresh_token) {
    account.refresh_token = data.refresh_token;
  }
  upsertGoogleAccount(account);
  // A successful refresh clears any prior reauth flag (e.g. after reconnecting).
  if (account.needs_reauth) setGoogleAccountNeedsReauth(account.id, false);

  _tokenCache.set(account.id, { token: data.access_token, expiry: expiryDate });

  return data.access_token;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a valid access token for a specific Google account, refreshing automatically if needed.
 */
export async function getAccessTokenForAccount(accountId: string): Promise<string> {
  const cached = _tokenCache.get(accountId);
  if (cached && cached.expiry > new Date()) {
    return cached.token;
  }

  const account = getGoogleAccountById(accountId);
  if (!account) {
    throw new Error(`Google Account "${accountId}" not found. Link your account first.`);
  }

  if (account.access_token && account.token_expiry && new Date(account.token_expiry) > new Date()) {
    const expiryDate = new Date(account.token_expiry);
    _tokenCache.set(accountId, { token: account.access_token, expiry: expiryDate });
    return account.access_token;
  }

  const existingRefresh = _refreshInFlight.get(accountId);
  if (existingRefresh) return existingRefresh;

  const refresh = refreshAccountToken(account).finally(() => {
    if (_refreshInFlight.get(accountId) === refresh) _refreshInFlight.delete(accountId);
  });
  _refreshInFlight.set(accountId, refresh);
  return refresh;
}

/**
 * Returns the current authentication status for the API/UI, scoped to
 * `workspaceId`'s owner (account-level). Falls back to every account when no
 * workspace is given (system-wide checks, e.g. /api/health).
 * IMPORTANT: pass the caller's workspace — using getAllGoogleAccounts() here
 * would leak "authenticated" across tenants (a workspace with zero Google
 * accounts would appear connected just because a DIFFERENT tenant has one).
 */
export function getAuthStatus(workspaceId?: string | null): AuthStatus {
  const accounts = workspaceId ? getGoogleAccountsForWorkspace(workspaceId) : getAllGoogleAccounts();
  const hasBuiltin = hasBuiltinCredentials();
  const authenticated = accounts.length > 0;
  
  // Return the active client ID (built-in has priority for new setups)
  const activeClientId = hasBuiltin ? BUILTIN_CLIENT_ID : (accounts[0]?.client_id || '');

  return {
    authenticated,
    hasBuiltinCredentials: hasBuiltin,
    clientId: activeClientId || undefined,
  };
}

/** Wipes all stored credentials for a specific account. */
export function disconnectGoogleAccount(id: string): void {
  deleteGoogleAccount(id);
  _tokenCache.delete(id);
  _refreshInFlight.delete(id);
}

/** Disconnect every Google account in ONE workspace (tenant-scoped). */
export function clearAuthForWorkspace(workspaceId: string): void {
  for (const acc of getGoogleAccountsForWorkspace(workspaceId)) {
    disconnectGoogleAccount(acc.id);
  }
}

/**
 * DANGER: wipes ALL Google accounts across EVERY workspace/tenant. Only for
 * a single-tenant reset / super-admin factory-reset — never expose this on a
 * per-user route (that caused a cross-tenant data-loss: one user clearing
 * their creds nuked every workspace's Google auth). Use clearAuthForWorkspace.
 */
export function clearAuth(): void {
  for (const acc of getAllGoogleAccounts()) {
    disconnectGoogleAccount(acc.id);
  }
}
