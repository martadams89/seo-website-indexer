/**
 * auth/google-health.ts — what each Google connection still needs.
 *
 * Google never grants a new permission silently: adding one always needs the
 * person's consent. So the app works out, per connection, which permissions
 * its linked sites, Ads clients and Business Profile locations need but the
 * grant lacks; which Google APIs are switched off on the OAuth client's
 * project; and what will make Google expire the connection (a Cloud scope
 * under Workspace session control, or a consent screen left in Testing).
 * The dashboard turns each finding into a one-click fix, and the platform
 * loop notifies the workspace when something new needs attention.
 */
import {
  getAllGoogleAccounts, getDb, getGoogleAccountsForOwner, getGoogleAccountsForWorkspace, getSetting, isGoogleAccountAvailableToWorkspace, setSetting, type GoogleAccount,
} from '../db/database.js';
import { notificationEventEnabled, sendWorkspaceNotification } from '../utils/notify.js';
import {
  CLOUD_PLATFORM_SCOPE, GOOGLE_ADS_SCOPE, GOOGLE_ANALYTICS_SCOPE, GOOGLE_BUSINESS_SCOPE, getAccessTokenForAccount, isBuiltinClient, limitedTo,
  type LimitedProduct,
} from './google-oauth.js';

const WEBMASTERS_SCOPE = 'https://www.googleapis.com/auth/webmasters';
const INDEXING_SCOPE = 'https://www.googleapis.com/auth/indexing';

export interface ScopeNeed { scope: string; label: string; reason: string }
export interface ApiNeed { service: string; label: string }
export interface ConnectionHealth {
  id: string;
  email: string | null;
  project: string | null;
  status: 'ok' | 'attention' | 'reconnect';
  needs_reauth: boolean;
  last_refresh_error: string | null;
  missing_scopes: ScopeNeed[];
  /** Flags to pass when reconnecting so the new grant covers what's missing. */
  reconnect_with: { ads: boolean; business: boolean };
  disabled_apis: ApiNeed[];
  /** The grant carries cloud-platform: a Workspace Google Cloud session-control policy can expire it every few hours. */
  cloud_scope: boolean;
  /** Set when Google gave the refresh token a lifetime (consent screen in Testing): the date it stops working. */
  refresh_token_expiry: string | null;
  apis_checked_at: string | null;
}

const SERVICE_LABEL: Record<string, string> = {
  'searchconsole.googleapis.com': 'Google Search Console API',
  'indexing.googleapis.com': 'Web Search Indexing API',
  'analyticsdata.googleapis.com': 'Google Analytics Data API',
  'analyticsadmin.googleapis.com': 'Google Analytics Admin API',
  'googleads.googleapis.com': 'Google Ads API',
  'mybusinessaccountmanagement.googleapis.com': 'My Business Account Management API',
  'mybusinessbusinessinformation.googleapis.com': 'My Business Business Information API',
  'mybusiness.googleapis.com': 'Google My Business API',
  'businessprofileperformance.googleapis.com': 'Business Profile Performance API',
};

/** APIs the one-off enable flow may switch on. */
export const KNOWN_GOOGLE_SERVICES = new Set(Object.keys(SERVICE_LABEL));

const projectOf = (clientId: string | null | undefined) => /^(\d{6,})-/.exec(clientId ?? '')?.[1] ?? null;
const count = (sql: string, ...args: unknown[]) => (getDb().prepare(sql).get(...args) as { n: number }).n;

/** What this connection is used for. */
function usage(account: GoogleAccount) {
  const tableExists = (name: string) => !!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const sites = count('SELECT COUNT(*) AS n FROM sites WHERE google_account_id=?', account.id);
  const indexingSites = count('SELECT COUNT(*) AS n FROM sites WHERE google_account_id=? AND google_indexing_api=1', account.id);
  const ads = tableExists('ads_accounts') ? count('SELECT COUNT(*) AS n FROM ads_accounts WHERE google_account_id=?', account.id) : 0;
  const adsWithGa4 = tableExists('ads_accounts') ? count('SELECT COUNT(*) AS n FROM ads_accounts WHERE google_account_id=? AND ga4_property_id IS NOT NULL', account.id) : 0;
  const locations = tableExists('gbp_locations') ? count('SELECT COUNT(*) AS n FROM gbp_locations WHERE google_account_id=?', account.id) : 0;
  const workspaces = (getDb().prepare('SELECT workspace_id FROM google_account_workspaces WHERE account_id=?').all(account.id) as Array<{ workspace_id: string }>).map(r => r.workspace_id);
  if (account.workspace_id && !workspaces.includes(account.workspace_id)) workspaces.push(account.workspace_id);
  const ga4Integrations = workspaces.length
    ? count(`SELECT COUNT(*) AS n FROM integrations WHERE provider='ga4' AND workspace_id IN (${workspaces.map(() => '?').join(',')})`, ...workspaces)
    : 0;
  return { sites, indexingSites, ads, locations, ga4: adsWithGa4 + ga4Integrations > 0, workspaces };
}

/** What a connection is used for, in counts the dashboard can show. */
export function connectionUsage(account: GoogleAccount): { sites: number; ads_clients: number; locations: number } {
  const u = usage(account);
  return { sites: u.sites, ads_clients: u.ads, locations: u.locations };
}

export interface GoogleProject {
  /** Cloud project number (from the OAuth client id), when Google's client ids carry one. */
  project: string | null;
  /** A connection holding this OAuth client: pass it as projectFrom to sign another Google user in through it. */
  source_id: string;
  builtin: boolean;
  connections: Array<{ id: string; email: string | null; limited_to: LimitedProduct[] | null; in_workspace: boolean } & ReturnType<typeof connectionUsage>>;
}

/**
 * The Cloud projects (OAuth clients) this person can sign Google users in
 * through without re-entering a client id and secret: those used by the
 * workspace's connections, and by their own connections elsewhere. The secret
 * never leaves the server.
 */
export function googleProjects(workspaceId: string, userId: string): GoogleProject[] {
  const byId = new Map<string, GoogleAccount>();
  for (const a of [...getGoogleAccountsForWorkspace(workspaceId), ...getGoogleAccountsForOwner(userId)]) byId.set(a.id, a);
  const groups = new Map<string, GoogleAccount[]>();
  for (const a of byId.values()) if (a.client_id) groups.set(a.client_id, [...(groups.get(a.client_id) ?? []), a]);
  return [...groups.entries()].map(([clientId, accounts]) => {
    const inWorkspace = (a: GoogleAccount) => isGoogleAccountAvailableToWorkspace(a.id, workspaceId);
    const source = accounts.find(a => inWorkspace(a) && !a.needs_reauth) ?? accounts.find(a => !a.needs_reauth) ?? accounts[0];
    return {
      project: projectOf(clientId), source_id: source.id, builtin: isBuiltinClient(clientId),
      connections: accounts.map(a => ({ id: a.id, email: a.email, limited_to: limitedTo(a.granted_scopes), in_workspace: inWorkspace(a), ...connectionUsage(a) })),
    };
  }).sort((a, b) => b.connections.filter(c => c.in_workspace).length - a.connections.filter(c => c.in_workspace).length);
}

/** Permissions the connection's current uses need but its grant lacks. Pure apart from the usage lookup. */
export function scopeNeeds(account: GoogleAccount, use = usage(account)): ScopeNeed[] {
  const granted = new Set((account.granted_scopes ?? '').split(' ').filter(Boolean));
  // Connections from before the app recorded granted scopes: nothing reliable to compare.
  if (!granted.size) return [];
  const needs: ScopeNeed[] = [];
  const need = (scope: string, label: string, reason: string) => { if (!granted.has(scope)) needs.push({ scope, label, reason }); };
  if (use.sites) need(WEBMASTERS_SCOPE, 'Search Console', `${use.sites} site${use.sites === 1 ? '' : 's'} use this connection`);
  if (use.indexingSites) need(INDEXING_SCOPE, 'Indexing API', `${use.indexingSites} site${use.indexingSites === 1 ? '' : 's'} send Indexing API notifications`);
  if (use.ga4) need(GOOGLE_ANALYTICS_SCOPE, 'Google Analytics (GA4)', 'GA4 reporting is set up in this workspace');
  if (use.ads) need(GOOGLE_ADS_SCOPE, 'Google Ads', `${use.ads} Google Ads client${use.ads === 1 ? '' : 's'} use this connection`);
  if (use.locations) need(GOOGLE_BUSINESS_SCOPE, 'Google Business Profile', `${use.locations} Business Profile location${use.locations === 1 ? '' : 's'} use this connection`);
  return needs;
}

// ── API probes ───────────────────────────────────────────────────────────────

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
export function __setHealthFetcherForTests(next: Fetcher): void { fetcher = next; }

const PROBE_TTL_MS = 30 * 60_000;
const probeCache = new Map<string, { at: number; disabled: ApiNeed[] }>();

/** The API Google says is switched off, from a SERVICE_DISABLED error body; null for any other answer. */
export function disabledServiceFrom(status: number, body: unknown): string | null {
  if (status !== 403) return null;
  const err = (body as { error?: { message?: string; details?: Array<{ reason?: string; metadata?: Record<string, string> }> } } | null)?.error;
  const detail = err?.details?.find(d => d.reason === 'SERVICE_DISABLED');
  if (detail?.metadata?.service) return detail.metadata.service;
  const m = /(?:has not been used in project \d+ before or it is disabled|is disabled)[^]*?(?:apis\/api\/|\/library\/)?([a-z0-9-]+\.googleapis\.com)/i.exec(err?.message ?? '');
  return detail || m ? m?.[1] ?? 'unknown' : null;
}

async function probe(token: string, service: string, url: string): Promise<string | null> {
  try {
    const res = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return null;
    const body = await res.json().catch(() => null);
    const disabled = disabledServiceFrom(res.status, body);
    return disabled ? (disabled === 'unknown' ? service : disabled) : null;
  } catch { return null; }
}

/** Which Google APIs this connection's uses need but the project has switched off. Cached for 30 minutes. */
export async function probeDisabledApis(account: GoogleAccount, opts: { fresh?: boolean; use?: ReturnType<typeof usage> } = {}): Promise<ApiNeed[]> {
  const hit = probeCache.get(account.id);
  if (!opts.fresh && hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.disabled;
  if (account.needs_reauth) return hit?.disabled ?? [];
  const use = opts.use ?? usage(account);
  const granted = new Set((account.granted_scopes ?? '').split(' '));
  const checks: Array<[string, string]> = [];
  if (use.sites && granted.has(WEBMASTERS_SCOPE)) checks.push(['searchconsole.googleapis.com', 'https://searchconsole.googleapis.com/webmasters/v3/sites']);
  if (use.ga4 && granted.has(GOOGLE_ANALYTICS_SCOPE)) checks.push(['analyticsadmin.googleapis.com', 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=1']);
  if (use.ads && granted.has(GOOGLE_ADS_SCOPE)) checks.push(['googleads.googleapis.com', `https://googleads.googleapis.com/${(process.env.GOOGLE_ADS_API_VERSION ?? 'v26').trim() || 'v26'}/customers:listAccessibleCustomers`]);
  if (use.locations && granted.has(GOOGLE_BUSINESS_SCOPE)) checks.push(['mybusinessaccountmanagement.googleapis.com', 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=1']);
  if (!checks.length) { probeCache.set(account.id, { at: Date.now(), disabled: [] }); return []; }
  let token: string;
  try { token = await getAccessTokenForAccount(account.id); } catch { return hit?.disabled ?? []; }
  const results = await Promise.all(checks.map(([service, url]) => probe(token, service, url)));
  const disabled = [...new Set(results.filter((s): s is string => !!s))].map(service => ({ service, label: SERVICE_LABEL[service] ?? service }));
  // The Business Profile reviews and performance APIs travel with account management.
  if (disabled.some(d => d.service === 'mybusinessaccountmanagement.googleapis.com')) {
    for (const service of ['mybusinessbusinessinformation.googleapis.com', 'mybusiness.googleapis.com', 'businessprofileperformance.googleapis.com']) {
      if (!disabled.some(d => d.service === service)) disabled.push({ service, label: SERVICE_LABEL[service] });
    }
  }
  probeCache.set(account.id, { at: Date.now(), disabled });
  return disabled;
}

export function forgetProbe(accountId: string): void { probeCache.delete(accountId); }

/** Services to switch on for this connection when no probe result is available: everything its uses need. */
export function servicesFor(account: GoogleAccount): string[] {
  const use = usage(account);
  return [
    ...(use.sites ? ['searchconsole.googleapis.com'] : []),
    ...(use.indexingSites ? ['indexing.googleapis.com'] : []),
    ...(use.ga4 ? ['analyticsdata.googleapis.com', 'analyticsadmin.googleapis.com'] : []),
    ...(use.ads ? ['googleads.googleapis.com'] : []),
    ...(use.locations ? ['mybusinessaccountmanagement.googleapis.com', 'mybusinessbusinessinformation.googleapis.com', 'mybusiness.googleapis.com', 'businessprofileperformance.googleapis.com'] : []),
  ];
}

// ── Health ───────────────────────────────────────────────────────────────────

export async function connectionHealth(account: GoogleAccount, opts: { probe?: boolean; fresh?: boolean } = {}): Promise<ConnectionHealth> {
  const use = usage(account);
  const missing = scopeNeeds(account, use);
  const cached = probeCache.get(account.id);
  const disabled = opts.probe ? await probeDisabledApis(account, { fresh: opts.fresh, use }) : cached?.disabled ?? [];
  const scopes = (account.granted_scopes ?? '').split(' ');
  const expiry = account.refresh_token_expiry ?? null;
  const status: ConnectionHealth['status'] = account.needs_reauth ? 'reconnect' : missing.length || disabled.length || expiry ? 'attention' : 'ok';
  return {
    id: account.id, email: account.email, project: projectOf(account.client_id), status,
    needs_reauth: !!account.needs_reauth, last_refresh_error: account.last_refresh_error ?? null,
    missing_scopes: missing,
    reconnect_with: { ads: use.ads > 0 || scopes.includes(GOOGLE_ADS_SCOPE), business: use.locations > 0 || scopes.includes(GOOGLE_BUSINESS_SCOPE) },
    disabled_apis: disabled,
    cloud_scope: scopes.includes(CLOUD_PLATFORM_SCOPE),
    refresh_token_expiry: expiry,
    apis_checked_at: (opts.probe ? new Date() : cached ? new Date(cached.at) : null)?.toISOString() ?? null,
  };
}

export async function workspaceGoogleHealth(workspaceId: string, opts: { probe?: boolean; fresh?: boolean } = {}): Promise<ConnectionHealth[]> {
  return Promise.all(getGoogleAccountsForWorkspace(workspaceId).map(a => connectionHealth(a, opts)));
}

/** Cheap count for the dashboard banner: no Google calls, uses the last probe if any. */
export function googleAttentionCount(workspaceId: string): number {
  return getGoogleAccountsForWorkspace(workspaceId).filter(a =>
    a.needs_reauth || scopeNeeds(a).length > 0 || (probeCache.get(a.id)?.disabled.length ?? 0) > 0).length;
}

// ── Notifications ────────────────────────────────────────────────────────────

let lastCheck = 0;
const CHECK_EVERY_MS = 60 * 60_000;

/**
 * Hourly from the platform loop: re-check every connection and tell each
 * workspace that uses it when its problems change (once per change, not every
 * hour). Covers reconnect-required, missing permissions, disabled APIs and
 * Testing-mode grants that Google will end.
 */
export async function notifyGoogleConnectionProblems(force = false): Promise<number> {
  if (!force && Date.now() - lastCheck < CHECK_EVERY_MS) return 0;
  lastCheck = Date.now();
  let sent = 0;
  const origin = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : null;
  for (const account of getAllGoogleAccounts()) {
    const h = await connectionHealth(account, { probe: true }).catch(() => null);
    if (!h) continue;
    const problems = [
      ...(h.needs_reauth ? ['Google stopped accepting this connection — reconnect it.'] : []),
      ...h.missing_scopes.map(m => `Needs ${m.label} permission (${m.reason}).`),
      ...h.disabled_apis.map(a => `${a.label} is switched off on project ${h.project ?? '?'}.`),
      // Keep-alive can't extend this one: Google ends Testing-mode grants after 7 days.
      ...(h.refresh_token_expiry && !h.needs_reauth ? [`Google will end this connection on ${h.refresh_token_expiry.slice(0, 10)} because the OAuth consent screen is in Testing. Publish the app (Google Auth Platform → Audience) and reconnect.`] : []),
    ];
    const key = `google_health:${account.id}`;
    const signature = problems.join('|');
    if (signature === (getSetting(key) ?? '')) continue;
    setSetting(key, signature);
    if (!problems.length) continue;
    for (const workspaceId of usage(account).workspaces) {
      if (!notificationEventEnabled(workspaceId, 'google_connection')) continue;
      const ok = await sendWorkspaceNotification(workspaceId, `Google connection needs attention — ${account.email ?? account.id}`,
        `${problems.map(p => `• ${p}`).join('\n')}\n\nFix it in one click: ${origin ? `${origin}/settings?tab=google` : 'Settings → Google Accounts'}`, 'google_connection').catch(() => false);
      if (ok) sent++;
    }
  }
  return sent;
}
