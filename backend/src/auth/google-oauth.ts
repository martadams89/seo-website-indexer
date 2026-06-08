/**
 * google-oauth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Google OAuth 2.0 Device Authorization Flow (RFC 8628)
 *
 * THE OUT-OF-THE-BOX SOLUTION — PRE-CONFIGURED OAUTH CLIENT:
 * ─────────────────────────────────────────────────────────────
 * This app ships with a pre-configured, built-in Google OAuth 2.0 "Desktop app"
 * client ID and secret, identical to how CLI tools like rclone work.
 *
 *   • Users get a zero-setup, one-click "Sign in with Google" experience out of the box.
 *   • Just click "Sign in with Google", see a URL + 8-char code, and authorize it.
 *   • Self-builders can easily override this via GOOGLE_OAUTH_CLIENT_ID and 
 *     GOOGLE_OAUTH_CLIENT_SECRET environment variables.
 *
 * TO CREATE YOUR OWN CLIENT (optional):
 *   1. console.cloud.google.com → APIs & Services → Credentials
 *   2. Enable: Google Search Console API + Web Search Indexing API
 *   3. Create Credentials → OAuth client ID → Desktop app
 *   4. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in your env
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getSetting,
  setSetting,
  getAllGoogleAccounts,
  getGoogleAccountById,
  upsertGoogleAccount,
  deleteGoogleAccount,
  type GoogleAccount
} from '../db/database.js';

// ── OAuth Scopes ──────────────────────────────────────────────────────────────

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/indexing',
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
export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<string> {
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
    expires_in?:    number;
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
  
  // Fetch Google email address to identify account
  const email = await fetchUserEmail(data.access_token);

  // Save the new account (uses email as account ID for extreme simplicity and clarity)
  upsertGoogleAccount({
    id: email,
    email,
    client_id: clientId,
    client_secret: clientSecret,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_expiry: expiryDate.toISOString(),
  });

  // Clear in-memory temp custom credentials
  _tempClientId = null;
  _tempClientSecret = null;

  return data.access_token;
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
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!data.access_token) {
    // 'invalid_grant' = user revoked or refresh token expired (~6 months unused)
    const isInvalidGrant = data.error === 'invalid_grant';
    throw new Error(
      `Token refresh failed for ${account.email || 'account'} (${data.error ?? 'unknown'}${data.error_description ? `: ${data.error_description}` : ''}). ` +
      (isInvalidGrant
        ? 'Refresh token has been revoked or expired. Please reconnect this account on the Accounts page.'
        : 'Please re-connect this account on the Google Accounts tab.')
    );
  }

  const expiryDate = new Date(Date.now() + ((data.expires_in ?? 3600) - 300) * 1_000);

  account.access_token = data.access_token;
  account.token_expiry = expiryDate.toISOString();
  // Google occasionally rotates the refresh token — persist the new one if provided.
  if (data.refresh_token && data.refresh_token !== account.refresh_token) {
    account.refresh_token = data.refresh_token;
  }
  upsertGoogleAccount(account);

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

  return refreshAccountToken(account);
}

/** Returns the current authentication status for the API/UI. */
export function getAuthStatus(): AuthStatus {
  const accounts = getAllGoogleAccounts();
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
}

/** Backward-compatible stub: wipes all accounts and tokens */
export function clearAuth(): void {
  const accounts = getAllGoogleAccounts();
  for (const acc of accounts) {
    disconnectGoogleAccount(acc.id);
  }
}
