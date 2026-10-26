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

import { randomUUID, randomBytes, createHash } from 'crypto';
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
  shareGoogleAccountWithWorkspace,
  unshareGoogleAccountFromWorkspace,
  tryAcquireGoogleTokenLock,
  releaseGoogleTokenLock,
  getDb,
  type GoogleAccount
} from '../db/database.js';
import { logSystem } from '../utils/logger.js';
import { encrypt, decrypt } from '../utils/crypto.js';

// ── OAuth Scopes ──────────────────────────────────────────────────────────────

// Read-only GA4 access: reports (Data API) and property discovery (Admin API).
export const GOOGLE_ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  // Opt-in per site: Indexing API recrawl notifications for inspected pages.
  'https://www.googleapis.com/auth/indexing',
  GOOGLE_ANALYTICS_SCOPE,
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// Opt-in: Google Ads management. Google publishes no read-only Ads scope, so
// this one grant covers reporting and changes; the app's own guardrails and
// MCP scopes decide what may actually be changed.
export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
// Opt-in: Google Business Profile (reading and answering reviews). Like Ads,
// Google offers no read-only variant, so the app's reply rules and MCP scopes
// decide what may be published.
export const GOOGLE_BUSINESS_SCOPE = 'https://www.googleapis.com/auth/business.manage';
export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
export const WEBMASTERS_SCOPE = 'https://www.googleapis.com/auth/webmasters';
const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

/**
 * A connection can be limited to the products it's for. Google grants API
 * access and quota per Cloud project, so a workspace often has one project
 * (or Google user) for Search Console, another for Google Ads and another for
 * Business Profile. A limited connection asks for only those scopes plus the
 * email that names it, so its project's consent screen needs nothing else.
 */
export type LimitedProduct = 'ads' | 'business';
const PRODUCT_SCOPE: Record<LimitedProduct, string> = { ads: GOOGLE_ADS_SCOPE, business: GOOGLE_BUSINESS_SCOPE };

export function limitedScopes(only: LimitedProduct[]): string {
  return [EMAIL_SCOPE, ...(['ads', 'business'] as const).filter(p => only.includes(p)).map(p => PRODUCT_SCOPE[p])].join(' ');
}
export const BUSINESS_ONLY_SCOPES = limitedScopes(['business']);
export const ADS_ONLY_SCOPES = limitedScopes(['ads']);

/** The products a limited grant is for, or null for a full connection (one that can read Search Console). */
export function limitedTo(grantedScopes: string | null | undefined): LimitedProduct[] | null {
  const granted = (grantedScopes ?? '').split(' ').filter(Boolean);
  if (!granted.length || granted.includes(WEBMASTERS_SCOPE)) return null;
  const products = (['ads', 'business'] as const).filter(p => granted.includes(PRODUCT_SCOPE[p]));
  return products.length ? products : null;
}

/** Scopes a sign-in must not silently take away from the connection it replaces. */
const KEPT_SCOPES: Array<[string, string]> = [[WEBMASTERS_SCOPE, 'Search Console'], [GOOGLE_ADS_SCOPE, 'Google Ads'], [GOOGLE_BUSINESS_SCOPE, 'Business Profile']];

// ── Bundled / Built-in OAuth Client ──────────────────────────────────────────

const BUILTIN_CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID     || '';
const BUILTIN_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';

export function hasBuiltinCredentials(): boolean {
  return !!(BUILTIN_CLIENT_ID && BUILTIN_CLIENT_SECRET);
}

/** Whether this OAuth client is the server's built-in one (GOOGLE_OAUTH_CLIENT_ID). */
export function isBuiltinClient(clientId: string | null | undefined): boolean {
  return !!BUILTIN_CLIENT_ID && clientId === BUILTIN_CLIENT_ID;
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

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const hashState = (state: string) => createHash('sha256').update(state).digest('hex');

export interface PendingGoogleOAuth {
  userId: string;
  workspaceId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** 'connect' stores the connection; 'enable_apis' only switches APIs on and keeps nothing. */
  purpose: 'connect' | 'enable_apis';
  payload: { services?: string[]; accountId?: string } | null;
}

/** Create a concurrency-safe, single-use OAuth handshake and authorization URL. */
export function createGoogleOAuthAuthorization(opts: {
  userId: string; workspaceId: string; redirectUri: string; autoSetup?: boolean;
  clientId?: string; clientSecret?: string; loginHint?: string | null; ads?: boolean; business?: boolean;
  /** Ask only for these products (plus the email that names the connection); empty or omitted means a full connection. */
  only?: LimitedProduct[] | null;
}): string {
  const clientId = opts.clientId?.trim() || BUILTIN_CLIENT_ID;
  const clientSecret = opts.clientSecret?.trim() || BUILTIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('OAuth Client ID and Client Secret are required.');
  const state = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
  const db = getDb();
  db.prepare("DELETE FROM google_oauth_states WHERE julianday(expires_at) < julianday('now')").run();
  db.prepare(`
    INSERT INTO google_oauth_states(state_hash, user_id, workspace_id, client_id, client_secret, redirect_uri, expires_at)
    VALUES(?,?,?,?,?,?,?)
  `).run(hashState(state), opts.userId, opts.workspaceId, clientId, encrypt(clientSecret), opts.redirectUri, expires);
  // A limited connection that is asked for another product keeps its limit and adds that product.
  const only = [...new Set([...(opts.only ?? []), ...(opts.only?.length && opts.ads ? ['ads'] : []), ...(opts.only?.length && opts.business ? ['business'] : [])])]
    .filter((p): p is LimitedProduct => p === 'ads' || p === 'business');
  const scopes = (only.length
    ? [limitedScopes(only), opts.autoSetup ? CLOUD_PLATFORM_SCOPE : '']
    : [OAUTH_SCOPES, opts.ads ? GOOGLE_ADS_SCOPE : '', opts.business ? GOOGLE_BUSINESS_SCOPE : '', opts.autoSetup ? CLOUD_PLATFORM_SCOPE : '']
  ).filter(Boolean).join(' ');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'select_account consent',
    // No include_granted_scopes: every scope the app needs is requested
    // explicitly above (reconnects carry Ads and Business Profile forward), so incremental auth
    // would only add scopes the user did NOT ask for this time. In particular
    // it re-attached a previously granted cloud-platform scope even with
    // Auto-configure unticked, keeping the grant under Workspace Google Cloud
    // session control (forced reauth every few hours).
    state,
  });
  if (opts.loginHint) params.set('login_hint', opts.loginHint);
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

/** Consume a pending state exactly once. Unknown, expired, or replayed states fail. */
export function consumeGoogleOAuthState(state: string): PendingGoogleOAuth | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT user_id, workspace_id, client_id, client_secret, redirect_uri, expires_at, purpose, payload
    FROM google_oauth_states WHERE state_hash = ?
  `).get(hashState(state)) as {
    user_id: string; workspace_id: string; client_id: string; client_secret: string;
    redirect_uri: string; expires_at: string; purpose: string | null; payload: string | null;
  } | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM google_oauth_states WHERE state_hash = ?').run(hashState(state));
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  const clientSecret = decrypt(row.client_secret);
  if (!clientSecret) return null;
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    clientSecret,
    redirectUri: row.redirect_uri,
    purpose: row.purpose === 'enable_apis' ? 'enable_apis' : 'connect',
    payload: (() => { try { return row.payload ? JSON.parse(row.payload) : null; } catch { return null; } })(),
  };
}

/**
 * A one-off Google sign-in that only switches APIs on for the OAuth client's
 * Cloud project. It asks for the cloud-platform scope with online access (no
 * refresh token), uses the access token once and stores nothing — so the
 * saved connection never carries Cloud access, and a Workspace Google Cloud
 * session-control policy can't start expiring it every few hours.
 */
export function createApiEnableAuthorization(opts: {
  userId: string; workspaceId: string; redirectUri: string; account: GoogleAccount; services: string[];
}): string {
  if (!opts.account.client_id || !opts.account.client_secret) throw new Error('This Google connection has no OAuth client to enable APIs with.');
  const state = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
  const db = getDb();
  db.prepare("DELETE FROM google_oauth_states WHERE julianday(expires_at) < julianday('now')").run();
  db.prepare(`
    INSERT INTO google_oauth_states(state_hash, user_id, workspace_id, client_id, client_secret, redirect_uri, expires_at, purpose, payload)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(hashState(state), opts.userId, opts.workspaceId, opts.account.client_id, encrypt(opts.account.client_secret), opts.redirectUri, expires,
    'enable_apis', JSON.stringify({ services: opts.services, accountId: opts.account.id }));
  const params = new URLSearchParams({
    client_id: opts.account.client_id,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: CLOUD_PLATFORM_SCOPE,
    access_type: 'online',
    prompt: 'consent',
    state,
  });
  if (opts.account.email) params.set('login_hint', opts.account.email);
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchange a code for a short-lived access token without storing anything (used by the one-off API enable flow). */
export async function exchangeCodeForAccessToken(code: string, redirectUri: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as { access_token?: string; error?: string; error_description?: string };
  if (!data.access_token) throw new Error(`Google didn't return an access token (${data.error ?? res.status}${data.error_description ? `: ${data.error_description}` : ''}).`);
  return data.access_token;
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
 * The connection id for this Google user through this OAuth client. The same
 * user and client always map to the same row, so a reconnect refreshes it in
 * place; a different client (another Cloud project) gets its own row.
 */
export function connectionIdFor(email: string, clientId: string): string {
  const same = getDb().prepare('SELECT id FROM google_accounts WHERE email = ? AND client_id = ?').get(email, clientId) as { id: string } | undefined;
  if (same) return same.id;
  const project = projectFromClientId(clientId) ?? createHash('sha256').update(clientId).digest('hex').slice(0, 10);
  const candidates = [email, `${email}~${project}`, `${email}~${project}-${createHash('sha256').update(clientId).digest('hex').slice(0, 6)}`];
  return candidates.find(c => !getGoogleAccountById(c)) ?? `${email}~${randomUUID().slice(0, 8)}`;
}

/**
 * Exchanges the authorization code received from Google for access/refresh tokens.
 * Persists the credentials inside SQLite.
 */
export async function exchangeCodeForTokens(
  code: string, redirectUri: string, workspaceId?: string | null, ownerUserId?: string | null,
  credentials?: { clientId: string; clientSecret: string },
): Promise<string> {
  const clientId     = credentials?.clientId || _tempClientId || BUILTIN_CLIENT_ID;
  const clientSecret = credentials?.clientSecret || _tempClientSecret || BUILTIN_CLIENT_SECRET;

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

  // Reject if this Google account already belongs to a different app user.
  // Without this, the upsert below would silently overwrite that tenant's
  // tokens with ours while leaving ownership unchanged — a cross-tenant
  // credential clash, not a real reassignment. The owner can explicitly
  // delegate the credential to workspaces where they are a member.
  // One connection per Google user per OAuth client (Cloud project).
  const id = connectionIdFor(email, clientId);
  // A new sign-in through the same project replaces that connection's grant.
  // Refuse one that would silently take away Search Console, Google Ads or
  // Business Profile (a limited sign-in, or a box unticked on Google's screen).
  const previousScopes = (getGoogleAccountById(id)?.granted_scopes ?? '').split(' ');
  const newScopes = (data.scope ?? '').split(' ');
  const lost = KEPT_SCOPES.filter(([scope]) => previousScopes.includes(scope) && !newScopes.includes(scope)).map(([, label]) => label);
  if (lost.length) {
    throw new Error(
      `${email} is already connected through this Google Cloud project with ${lost.join(' and ')} access, and this sign-in would remove it. `
      + 'To use it in this workspace, add the existing connection instead (Settings → Google Accounts → "Your other Google accounts", or "Use a Google account you\'ve already connected" in setup). '
      + 'To give it more access, use Reconnect or "Add … access" on that connection, which keeps everything it has; or connect through a different Cloud project.'
    );
  }
  if (ownerUserId && !canOwnGoogleAccount(id, ownerUserId)) {
    throw new Error(
      `This Google account (${email}) is already connected to a different account in this app. Disconnect it there first, or sign in with a different Google account.`
    );
  }

  // Save the connection. Its id is the email for the first project a Google
  // user connects through, and email~project for any other project.
  // owner_user_id records who controls the credential. workspace_id records its
  // original "home" workspace, while a separate delegation row grants use in
  // the active workspace. The upsert preserves ownership on token refresh.
  upsertGoogleAccount({
    id,
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
  if (workspaceId) shareGoogleAccountWithWorkspace(id, workspaceId, ownerUserId);

  // Reconnecting mints a fresh refresh token, so clear any stale reauth flag
  // (the upsert's ON CONFLICT preserves the old needs_reauth value otherwise).
  setGoogleAccountNeedsReauth(id, false);
  _tokenCache.delete(id);

  // Best-effort: enable the Google API this tool needs (Search Console) on the
  // linked project, so the user doesn't have to do it by
  // hand in the Cloud console. Needs the cloud-platform scope; if that wasn't
  // granted the enable calls 403 and we skip silently (logged). Fire-and-forget
  // so it never delays the OAuth response.
  const granted = (data.scope ?? '').split(' ');
  if (granted.includes(CLOUD_PLATFORM_SCOPE)) {
    const services = [
      ...(granted.includes(WEBMASTERS_SCOPE) ? AUTO_ENABLE_SERVICES : []),
      ...(granted.includes(GOOGLE_ADS_SCOPE) ? [GOOGLE_ADS_SERVICE] : []),
      ...(granted.includes(GOOGLE_BUSINESS_SCOPE) ? GOOGLE_BUSINESS_SERVICES : []),
    ];
    void enableRequiredApis(data.access_token, clientId, email, services);
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

const AUTO_ENABLE_SERVICES = ['searchconsole.googleapis.com', 'indexing.googleapis.com', 'analyticsdata.googleapis.com', 'analyticsadmin.googleapis.com'];
export const GOOGLE_ADS_SERVICE = 'googleads.googleapis.com';
/** Accounts, locations and (v4) reviews. Enabling them doesn't grant access: Google approves projects separately. */
export const GOOGLE_BUSINESS_SERVICES = ['mybusinessaccountmanagement.googleapis.com', 'mybusinessbusinessinformation.googleapis.com', 'mybusiness.googleapis.com', 'businessprofileperformance.googleapis.com'];

/**
 * Enable the APIs the tool depends on, on the project owning the OAuth client.
 * Idempotent (Google no-ops an already-enabled service). Best-effort — any
 * failure (no cloud-platform scope, no permission) is logged, not thrown.
 */
export async function enableRequiredApis(accessToken: string, clientId: string, label: string, services: string[] = AUTO_ENABLE_SERVICES): Promise<{ enabled: string[]; skipped: string[] }> {
  const project = projectFromClientId(clientId);
  const enabled: string[] = [];
  const skipped: string[] = [];
  if (!project) return { enabled, skipped: [...services] };
  for (const svc of services) {
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

    // A different process may have refreshed and rotated this token while our
    // request was in flight (or the user may have reconnected). In that case
    // this invalid_grant belongs to the superseded token and must not mark the
    // healthy replacement grant as dead.
    const current = isInvalidGrant ? getGoogleAccountById(account.id) : null;
    const supersededByConcurrentRefresh = !!current && current.refresh_token !== account.refresh_token;

    if (!supersededByConcurrentRefresh) {
      setGoogleAccountRefreshError(account.id, refreshError);
      if (isInvalidGrant) setGoogleAccountNeedsReauth(account.id, true);
    }
    _tokenCache.delete(account.id);

    if (supersededByConcurrentRefresh && current!.access_token && current!.token_expiry && new Date(current!.token_expiry) > new Date()) {
      const expiryDate = new Date(current!.token_expiry);
      _tokenCache.set(account.id, { token: current!.access_token, expiry: expiryDate });
      return current!.access_token;
    }

    throw new Error(
      `Token refresh failed for ${account.email || 'account'} (${data.error ?? 'unknown'}${data.error_subtype ? `/${data.error_subtype}` : ''}${data.error_description ? `: ${data.error_description}` : ''}). ` +
      (isReauth
        ? 'Your Google Workspace enforces a Google Cloud session-control reauthentication policy, so Google expires this connection every few hours. Please reconnect this account on the Accounts page. To stop it recurring, in Google Admin → Security → Access and data control → Google Cloud session control, lengthen the reauthentication frequency or add this app to Trusted apps and enable "Exempt trusted apps" — or reconnect with "Auto-configure Google APIs" unchecked so the connection no longer carries a Google Cloud scope.'
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

// ── Proactive keep-alive ──────────────────────────────────────────────────────

/**
 * Refresh every healthy account whose access token is at (or within `windowMs`
 * of) expiry, ahead of demand. Run on a timer by the scheduler so:
 *   • API calls always find a warm token (no refresh latency mid-request), and
 *   • the refresh token is exercised regularly (it can never lapse from the
 *     ~6-month inactivity rule), and a grant Google has killed is detected and
 *     flagged needs_reauth immediately — the connection self-heals or surfaces
 *     a precise reconnect prompt without waiting for the next indexing run.
 * Accounts already flagged needs_reauth are skipped (their token is dead until
 * the user reconnects — re-POSTing it would just hammer Google).
 */
export async function proactivelyRefreshGoogleTokens(windowMs = 15 * 60_000): Promise<{ refreshed: number; failed: number; skipped: number }> {
  const now = Date.now();
  let refreshed = 0, failed = 0, skipped = 0;
  for (const account of getAllGoogleAccounts()) {
    if (account.needs_reauth) { skipped++; continue; }
    const expiresAt = account.token_expiry ? new Date(account.token_expiry).getTime() : 0;
    if (expiresAt > now + windowMs) { skipped++; continue; } // still comfortably valid
    try {
      await refreshAccountTokenWithLock(account);
      refreshed++;
    } catch {
      // refreshAccountToken already persisted last_refresh_error / needs_reauth.
      failed++;
    }
  }
  return { refreshed, failed, skipped };
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

  const refresh = refreshAccountTokenWithLock(account).finally(() => {
    if (_inFlightRefresh.get(accountId) === refresh) _inFlightRefresh.delete(accountId);
  });
  _inFlightRefresh.set(accountId, refresh);
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
  _inFlightRefresh.delete(id);
}

/** Remove every Google-account delegation from ONE workspace. Credentials and
 * shares used by other workspaces remain intact. */
export function clearAuthForWorkspace(workspaceId: string): void {
  for (const acc of getGoogleAccountsForWorkspace(workspaceId)) {
    unshareGoogleAccountFromWorkspace(acc.id, workspaceId);
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
