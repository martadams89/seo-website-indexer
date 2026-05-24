/**
 * google-oauth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Google OAuth 2.0 Device Authorization Flow (RFC 8628)
 *
 * WHY DEVICE FLOW, NOT SERVICE ACCOUNTS:
 * ────────────────────────────────────────
 * Service Account JSON does NOT work for this use case. Google Search Console
 * will not accept a *.iam.gserviceaccount.com email address in its "Add user"
 * dialog, so you can never grant it Owner access, which means the Indexing API
 * always returns 403. Service accounts are simply not supported for GSC.
 *
 * WHY NO gcloud CLI IN THE CONTAINER:
 * ─────────────────────────────────────
 * The gcloud SDK weighs ~400 MB and its `--no-launch-browser` flow uses the
 * deprecated OAuth OOB (out-of-band) redirect that Google is phasing out.
 *
 * THE ACTUAL SOLUTION — BUNDLED OAUTH CLIENT:
 * ─────────────────────────────────────────────
 * This app ships with its own OAuth 2.0 "Desktop app" client ID, identical to
 * how rclone, the Google Drive CLI, YouTube-DL, etc. work.
 *
 *   • The official Docker image has GOOGLE_OAUTH_CLIENT_ID and
 *     GOOGLE_OAUTH_CLIENT_SECRET baked in at build time.
 *   • Users click "Sign in with Google", see a URL + 8-char code, enter it on
 *     any device (phone, laptop). No Google Cloud setup required.
 *   • Self-builders supply their own client via env vars (see README).
 *
 * TO CREATE YOUR OWN CLIENT (for self-hosted builds):
 *   1. console.cloud.google.com → APIs & Services → Credentials
 *   2. Enable: Google Search Console API + Web Search Indexing API
 *   3. Create Credentials → OAuth client ID → Desktop app
 *   4. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in your env
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getSetting, setSetting } from '../db/database.js';

// ── OAuth Scopes ──────────────────────────────────────────────────────────────

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/indexing',
].join(' ');

// ── Bundled / Built-in OAuth Client ──────────────────────────────────────────
// Set these in your Docker image or docker-compose.yml environment.
// When set, users get a one-click "Sign in with Google" experience.
// When not set, users must supply their own client_id/secret (advanced).

const BUILTIN_CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID     ?? '';
const BUILTIN_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';

export function hasBuiltinCredentials(): boolean {
  return !!(BUILTIN_CLIENT_ID && BUILTIN_CLIENT_SECRET);
}

// ── Google OAuth Endpoints ────────────────────────────────────────────────────

const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL       = 'https://oauth2.googleapis.com/token';

// ── Settings Keys (SQLite) ────────────────────────────────────────────────────

const SK_OAUTH_CLIENT_ID     = 'oauth_client_id';
const SK_OAUTH_CLIENT_SECRET = 'oauth_client_secret';
const SK_OAUTH_REFRESH_TOKEN = 'oauth_refresh_token';
const SK_OAUTH_ACCESS_TOKEN  = 'oauth_access_token';
const SK_OAUTH_TOKEN_EXPIRY  = 'oauth_token_expiry';
const SK_AUTH_OK             = 'oauth_authenticated';  // '1' once authed

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DeviceFlowState {
  device_code:      string;
  user_code:        string;
  verification_url: string;
  expires_in:       number;
  interval:         number;
}

export interface AuthStatus {
  authenticated: boolean;
  /** true if env vars are set — user can click "Sign in" with no credential entry */
  hasBuiltinCredentials: boolean;
  expiresAt?: string;
  error?: string;
}

// ── In-memory token cache ─────────────────────────────────────────────────────

let _cachedToken: string | null = null;
let _cachedExpiry: Date | null  = null;

// ── Device Flow — Start ───────────────────────────────────────────────────────

/**
 * Starts the OAuth Device Authorization flow.
 * If clientId/clientSecret are omitted or empty, falls back to the bundled credentials.
 * Returns the state needed to show the user the URL + code.
 */
export async function startDeviceFlow(
  clientId?: string,
  clientSecret?: string,
): Promise<DeviceFlowState> {
  const activeClientId     = clientId || BUILTIN_CLIENT_ID;
  const activeClientSecret = clientSecret || BUILTIN_CLIENT_SECRET;

  if (!activeClientId || !activeClientSecret) {
    throw new Error(
      'No OAuth client credentials available. ' +
      'Either set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET environment variables, ' +
      'or provide your own credentials in the setup form.',
    );
  }

  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: activeClientId, scope: OAUTH_SCOPES }).toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to start device flow (HTTP ${res.status}): ${body}`);
  }

  const data = await res.json() as DeviceFlowState;

  // Persist client credentials so polling + refresh can use them
  setSetting(SK_OAUTH_CLIENT_ID,     activeClientId);
  setSetting(SK_OAUTH_CLIENT_SECRET, activeClientSecret);

  return data;
}

// ── Device Flow — Poll ────────────────────────────────────────────────────────

/**
 * Polls the token endpoint until the user authorises or the code expires.
 * Resolves with the access token on success, throws on timeout/error.
 */
export async function pollDeviceFlow(
  deviceCode:  string,
  intervalSecs: number,
  expirySecs:  number,
): Promise<string> {
  const clientId     = getSetting(SK_OAUTH_CLIENT_ID)     || BUILTIN_CLIENT_ID;
  const clientSecret = getSetting(SK_OAUTH_CLIENT_SECRET) || BUILTIN_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Client credentials missing. Re-start the auth flow.');
  }

  const deadline = Date.now() + expirySecs * 1_000;
  const pollMs   = Math.max(intervalSecs, 5) * 1_000;

  while (Date.now() < deadline) {
    await sleep(pollMs);

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        device_code:   deviceCode,
        grant_type:    'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    });

    const data = await res.json() as {
      access_token?:  string;
      refresh_token?: string;
      expires_in?:    number;
      error?:         string;
    };

    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down')             { await sleep(pollMs); continue; }
    if (data.error)                             throw new Error(`Auth error: ${data.error}`);

    if (data.access_token) {
      const expiryDate = new Date(Date.now() + ((data.expires_in ?? 3600) - 300) * 1_000);
      setSetting(SK_OAUTH_ACCESS_TOKEN, data.access_token);
      setSetting(SK_OAUTH_TOKEN_EXPIRY, expiryDate.toISOString());
      if (data.refresh_token) setSetting(SK_OAUTH_REFRESH_TOKEN, data.refresh_token);
      setSetting(SK_AUTH_OK, '1');
      _cachedToken  = data.access_token;
      _cachedExpiry = expiryDate;
      return data.access_token;
    }
  }

  throw new Error('Authorisation timed out — the code expired. Please try again.');
}

// ── Token Refresh ─────────────────────────────────────────────────────────────

async function refreshToken(): Promise<string> {
  const clientId     = getSetting(SK_OAUTH_CLIENT_ID)     || BUILTIN_CLIENT_ID;
  const clientSecret = getSetting(SK_OAUTH_CLIENT_SECRET) || BUILTIN_CLIENT_SECRET;
  const refreshTok   = getSetting(SK_OAUTH_REFRESH_TOKEN);

  if (!clientId || !clientSecret || !refreshTok) {
    throw new Error('Session expired and no refresh token stored. Please sign in again.');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshTok,
      grant_type:    'refresh_token',
    }).toString(),
  });

  const data = await res.json() as { access_token?: string; expires_in?: number; error?: string };
  if (!data.access_token) {
    // Refresh token revoked — clear auth state
    clearAuth();
    throw new Error(
      `Token refresh failed (${data.error ?? 'unknown'}). ` +
      'You have been signed out — please sign in again.',
    );
  }

  const expiry = new Date(Date.now() + ((data.expires_in ?? 3600) - 300) * 1_000);
  setSetting(SK_OAUTH_ACCESS_TOKEN, data.access_token);
  setSetting(SK_OAUTH_TOKEN_EXPIRY, expiry.toISOString());
  _cachedToken  = data.access_token;
  _cachedExpiry = expiry;
  return data.access_token;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a valid access token, refreshing automatically if needed.
 * Throws if the user has not authenticated yet.
 */
export async function getAccessToken(): Promise<string> {
  // In-memory cache hit
  if (_cachedToken && _cachedExpiry && _cachedExpiry > new Date()) {
    return _cachedToken;
  }

  // Persisted token still valid
  const stored = getSetting(SK_OAUTH_ACCESS_TOKEN);
  const expiry = getSetting(SK_OAUTH_TOKEN_EXPIRY);
  if (stored && expiry && new Date(expiry) > new Date()) {
    _cachedToken  = stored;
    _cachedExpiry = new Date(expiry);
    return stored;
  }

  // Refresh
  const hasRefresh = !!getSetting(SK_OAUTH_REFRESH_TOKEN);
  if (!hasRefresh) {
    throw new Error('Not authenticated. Please sign in with Google first.');
  }

  return refreshToken();
}

/** Returns the current authentication status for the API/UI. */
export function getAuthStatus(): AuthStatus {
  const authed       = getSetting(SK_AUTH_OK) === '1';
  const expiry       = getSetting(SK_OAUTH_TOKEN_EXPIRY);
  const hasRefresh   = !!getSetting(SK_OAUTH_REFRESH_TOKEN);

  return {
    authenticated:        authed && hasRefresh,
    hasBuiltinCredentials: hasBuiltinCredentials(),
    expiresAt:            expiry ?? undefined,
  };
}

/** Wipes all stored auth tokens and credentials. */
export function clearAuth(): void {
  for (const k of [
    SK_AUTH_OK, SK_OAUTH_ACCESS_TOKEN, SK_OAUTH_TOKEN_EXPIRY,
    SK_OAUTH_REFRESH_TOKEN, SK_OAUTH_CLIENT_ID, SK_OAUTH_CLIENT_SECRET,
  ]) {
    setSetting(k, '');
  }
  _cachedToken  = null;
  _cachedExpiry = null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
