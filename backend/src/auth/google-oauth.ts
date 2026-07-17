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

import { randomUUID } from 'crypto';
import {
  getSetting,
  setSetting,
  getAllGoogleAccounts,
  getGoogleAccountsForWorkspace,
  getGoogleAccountById,
  upsertGoogleAccount,
  deleteGoogleAccount,
  setGoogleAccountNeedsReauth,
  canOwnGoogleAccount,
  tryAcquireGoogleTokenLock,
  releaseGoogleTokenLock,
  type GoogleAccount
} from '../db/database.js';
import { logSystem } from '../utils/logger.js';

// ── OAuth Scopes ──────────────────────────────────────────────────────────────

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/indexing',
  'https://www.googleapis.com/auth/userinfo.email',
  // Needed for one-click Gemini key provisioning (API Keys API + Service
  // Usage). Accounts linked before this scope existed must re-link once to
  // use that feature; everything else works without it.
  'https://www.googleapis.com/auth/cloud-platform',
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

// In-flight refresh, keyed by account id. Google accounts are shared across a
// user's workspaces, and a single snapshot/run can fire several Google API
// calls for the same account at once (see perf-store.ts's Promise.all, and
// the scheduler's concurrent per-workspace runs). Without de-duping, two
// callers whose cached token expired at the same moment would each fire an
// independent refresh_token request. Google occasionally rotates the refresh
// token on refresh (see the comment in refreshAccountToken below), so the
// loser of that race would get invalid_grant for a token the winner had
// already superseded — wrongly flagging a perfectly healthy account as
// needs_reauth. Routing concurrent callers through the same in-flight promise
// closes that window.
const _inFlightRefresh = new Map<string, Promise<string>>();

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
    workspace_id: workspaceId ?? null,
    owner_user_id: ownerUserId ?? null,
  });

  // Reconnecting mints a fresh refresh token, so clear any stale reauth flag
  // (the upsert's ON CONFLICT preserves the old needs_reauth value otherwise).
  setGoogleAccountNeedsReauth(email, false);
  _tokenCache.delete(email);

  // Best-effort: enable the Google APIs this tool needs (Web Search Indexing +
  // Search Console) on the linked project, so the user doesn't have to do it by
  // hand in the Cloud console. Needs the cloud-platform scope; if that wasn't
  // granted the enable calls 403 and we skip silently (logged). Fire-and-forget
  // so it never delays the OAuth response.
  void enableRequiredApis(data.access_token, clientId, email);

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

const AUTO_ENABLE_SERVICES = ['indexing.googleapis.com', 'searchconsole.googleapis.com'];

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
  else logSystem('dim', `Could not auto-enable Google APIs for ${label} (grant Cloud access when connecting, or enable them manually) — indexing still works if already enabled on the project.`);
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
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!data.access_token) {
    // 'invalid_grant' = the refresh token is permanently dead: the user revoked
    // access, it expired (~6 months unused), OR a Google Workspace reauth /
    // session-control policy killed it. The last case surfaces as
    // "invalid_grant: reauth related error (invalid_rapt)" and is triggered by
    // the sensitive cloud-platform scope (opt-in "Auto-configure" box) — the
    // core webmasters/indexing scopes don't attract it. Persist a needs_reauth
    // flag so the UI can prompt for reconnection and the scheduler stops
    // retrying a token that will never refresh again.
    const isInvalidGrant = data.error === 'invalid_grant';
    const isReauth = isInvalidGrant && /rapt|reauth/i.test(data.error_description ?? '');

    // Belt-and-suspenders on top of the in-flight de-dup in
    // getAccessTokenForAccount: if the DB's refresh_token no longer matches
    // the one this request sent, a concurrent refresh already won and
    // rotated it (or the user reconnected mid-flight) — this failure is
    // stale, not a real dead account, so don't flag needs_reauth over it.
    const current = isInvalidGrant ? getGoogleAccountById(account.id) : null;
    const supersededByConcurrentRefresh = !!current && current.refresh_token !== account.refresh_token;

    if (isInvalidGrant && !supersededByConcurrentRefresh) setGoogleAccountNeedsReauth(account.id, true);
    _tokenCache.delete(account.id);

    if (supersededByConcurrentRefresh && current!.access_token && current!.token_expiry && new Date(current!.token_expiry) > new Date()) {
      const expiryDate = new Date(current!.token_expiry);
      _tokenCache.set(account.id, { token: current!.access_token, expiry: expiryDate });
      return current!.access_token;
    }

    throw new Error(
      `Token refresh failed for ${account.email || 'account'} (${data.error ?? 'unknown'}${data.error_description ? `: ${data.error_description}` : ''}). ` +
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

const TOKEN_LOCK_TTL_MS = 20_000; // stale-lock takeover — much longer than any real token-endpoint round trip
const TOKEN_LOCK_POLL_MS = 200;
const TOKEN_LOCK_MAX_WAIT_MS = 20_000; // ~ one TTL cycle; if still stuck, take the lock over rather than hang the request

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Cross-process counterpart to the in-process single-flight guard in
 * getAccessTokenForAccount: wraps refreshAccountToken in a DB-backed lock so
 * that if this app is ever scaled to multiple instances sharing one SQLite
 * file, only one of them refreshes a given account's token at a time. Other
 * instances poll the row and pick up the winner's fresh token instead of
 * also POSTing the same (about-to-be-superseded) refresh_token to Google.
 */
async function refreshAccountTokenWithLock(account: GoogleAccount): Promise<string> {
  const holder = `${process.pid}:${randomUUID()}`;
  const start = Date.now();
  let acquired = tryAcquireGoogleTokenLock(account.id, holder, TOKEN_LOCK_TTL_MS);

  while (!acquired) {
    const latest = getGoogleAccountById(account.id);
    if (latest?.access_token && latest.token_expiry && new Date(latest.token_expiry) > new Date()) {
      const expiryDate = new Date(latest.token_expiry);
      _tokenCache.set(account.id, { token: latest.access_token, expiry: expiryDate });
      return latest.access_token;
    }
    if (Date.now() - start > TOKEN_LOCK_MAX_WAIT_MS) {
      // Waited a full TTL cycle with no fresh token appearing — the holder
      // almost certainly crashed mid-refresh. Force the takeover unconditionally
      // (negative "TTL" so the staleness check always passes) rather than hang.
      acquired = tryAcquireGoogleTokenLock(account.id, holder, -1_000);
      break;
    }
    await sleep(TOKEN_LOCK_POLL_MS);
    acquired = tryAcquireGoogleTokenLock(account.id, holder, TOKEN_LOCK_TTL_MS);
  }

  try {
    return await refreshAccountToken(account);
  } finally {
    if (acquired) releaseGoogleTokenLock(account.id, holder);
  }
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

  // Join an already-running refresh for this account rather than starting a
  // second one. Safe to check before the DB read below: everything from here
  // up to the first `await` inside refreshAccountToken runs synchronously, so
  // a concurrent caller can never observe this map between the check and the
  // set.
  const inFlight = _inFlightRefresh.get(accountId);
  if (inFlight) return inFlight;

  const account = getGoogleAccountById(accountId);
  if (!account) {
    throw new Error(`Google Account "${accountId}" not found. Link your account first.`);
  }

  if (account.access_token && account.token_expiry && new Date(account.token_expiry) > new Date()) {
    const expiryDate = new Date(account.token_expiry);
    _tokenCache.set(accountId, { token: account.access_token, expiry: expiryDate });
    return account.access_token;
  }

  const refreshPromise = refreshAccountTokenWithLock(account).finally(() => {
    _inFlightRefresh.delete(accountId);
  });
  _inFlightRefresh.set(accountId, refreshPromise);
  return refreshPromise;
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
