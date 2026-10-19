/**
 * ads/setup.ts — the Google Ads setup checklist: which Google connections have
 * the Ads scope, whether the Google Ads API is enabled on the OAuth client's
 * Cloud project, and whether that project's access level reaches real
 * (non-test) accounts. Each probe turns Google's error into the next step.
 */
import { getGoogleAccountsForWorkspace, type GoogleAccount } from '../db/database.js';
import {
  CLOUD_PLATFORM_SCOPE, GOOGLE_ADS_SERVICE, enableRequiredApis, getAccessTokenForAccount, hasBuiltinCredentials,
} from '../auth/google-oauth.js';
import { ADS_SCOPE, AdsApiError, cleanCustomerId, listAccessibleCustomers, projectFromClientId, searchGaql } from './client.js';
import { linkAdsAccount, listAdsAccounts } from './store.js';

export type ApiState = 'ok' | 'no_scope' | 'api_disabled' | 'access_level' | 'needs_reauth' | 'error' | 'unchecked';

export interface ConnectionStatus {
  id: string;
  email: string | null;
  project: string | null;
  has_ads_scope: boolean;
  has_cloud_scope: boolean;
  needs_reauth: boolean;
  api: ApiState;
  access: ApiState;
  accessible_customers: number | null;
  message: string | null;
  hint: string | null;
}

export function consoleLinks(project: string | null) {
  const q = project ? `?project=${project}` : '';
  return {
    enable_api: `https://console.cloud.google.com/apis/library/googleads.googleapis.com${q}`,
    access_level: `https://console.cloud.google.com/google/ads-apis/overview${q}`,
    oauth_consent: `https://console.cloud.google.com/auth/overview${q}`,
    credentials: `https://console.cloud.google.com/apis/credentials${q}`,
    billing: `https://console.cloud.google.com/billing/linkedaccount${q}`,
    new_project: 'https://console.cloud.google.com/projectcreate',
  };
}

const probeCache = new Map<string, { at: number; value: ConnectionStatus }>();
const PROBE_TTL_MS = 2 * 60_000;

async function probe(account: GoogleAccount, workspaceId: string, fresh: boolean): Promise<ConnectionStatus> {
  const cacheKey = `${account.id}:${workspaceId}`;
  const hit = probeCache.get(cacheKey);
  if (!fresh && hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;
  const scopes = (account.granted_scopes ?? '').split(' ');
  const status: ConnectionStatus = {
    id: account.id,
    email: account.email,
    project: projectFromClientId(account.client_id),
    has_ads_scope: scopes.includes(ADS_SCOPE),
    has_cloud_scope: scopes.includes(CLOUD_PLATFORM_SCOPE),
    needs_reauth: !!account.needs_reauth,
    api: 'unchecked', access: 'unchecked', accessible_customers: null, message: null, hint: null,
  };
  const fail = (e: unknown) => {
    const err = e as AdsApiError;
    const kind = err instanceof AdsApiError ? err.kind : 'UNKNOWN';
    status.message = err instanceof Error ? err.message : String(e);
    status.hint = err instanceof AdsApiError ? err.hint ?? null : null;
    return kind === 'API_DISABLED' ? 'api_disabled' : kind === 'ACCESS_LEVEL' ? 'access_level' : kind === 'NO_ADS_SCOPE' ? 'no_scope' : kind === 'NEEDS_REAUTH' ? 'needs_reauth' : 'error';
  };
  if (status.needs_reauth) { status.api = 'needs_reauth'; status.access = 'needs_reauth'; }
  else if (!status.has_ads_scope) { status.api = 'no_scope'; status.access = 'no_scope'; }
  else {
    try {
      const ids = await listAccessibleCustomers(account.id);
      status.api = 'ok';
      status.accessible_customers = ids.length;
      // Test access can list customers but can't query production accounts; a
      // real query against a linked (or the first reachable) account tells us.
      const linked = listAdsAccounts(workspaceId).find(a => a.google_account_id === account.id && !a.test_account);
      const target = linked?.customer_id ?? ids[0];
      if (target) {
        try {
          await searchGaql({ googleAccountId: account.id, loginCustomerId: linked?.login_customer_id ?? null }, target, 'SELECT customer.id FROM customer LIMIT 1', 1);
          status.access = 'ok';
        } catch (e) {
          const state = fail(e);
          // Any other error (e.g. no permission on that one account) is not an
          // access-level problem; keep its message so it can be shown.
          status.access = state === 'error' ? 'ok' : state;
        }
      }
    } catch (e) {
      status.api = fail(e);
      if (status.api === 'access_level') { status.access = 'access_level'; status.api = 'ok'; }
    }
  }
  probeCache.set(cacheKey, { at: Date.now(), value: status });
  return status;
}

export async function setupStatus(workspaceId: string, opts: { fresh?: boolean } = {}) {
  const accounts = getGoogleAccountsForWorkspace(workspaceId);
  const connections = await Promise.all(accounts.map(a => probe(a, workspaceId, !!opts.fresh)));
  const linked = listAdsAccounts(workspaceId);
  const project = connections.find(c => c.has_ads_scope)?.project ?? connections[0]?.project ?? null;
  const ready = connections.some(c => c.api === 'ok' && (c.access === 'ok' || c.access === 'unchecked'));
  return {
    builtin_oauth_client: hasBuiltinCredentials(),
    project,
    links: consoleLinks(project),
    connections,
    linked_accounts: linked.length,
    clients_without_budget: linked.filter(a => a.monthly_budget === null).length,
    steps: {
      google_connected: accounts.length > 0,
      ads_scope: connections.some(c => c.has_ads_scope),
      api_enabled: connections.some(c => c.api === 'ok'),
      production_access: connections.some(c => c.access === 'ok'),
      accounts_linked: linked.length > 0,
      budgets_set: linked.length > 0 && linked.every(a => a.monthly_budget !== null),
    },
    ready,
  };
}

/** Enable the Google Ads API on the OAuth client's project using a connection with Cloud access. */
export async function enableAdsApi(account: GoogleAccount): Promise<{ ok: boolean; project: string | null; message: string }> {
  const project = projectFromClientId(account.client_id);
  if (!(account.granted_scopes ?? '').split(' ').includes(CLOUD_PLATFORM_SCOPE)) {
    return { ok: false, project, message: 'This connection did not grant Google Cloud access. Reconnect it with "Auto-configure Google APIs" ticked, or enable the API in the Cloud console.' };
  }
  const token = await getAccessTokenForAccount(account.id);
  const { enabled } = await enableRequiredApis(token, account.client_id, account.email ?? account.id, [GOOGLE_ADS_SERVICE]);
  for (const key of probeCache.keys()) if (key.startsWith(`${account.id}:`)) probeCache.delete(key);
  return enabled.length
    ? { ok: true, project, message: `Google Ads API enabled on project ${project}. It can take a minute or two to take effect.` }
    : { ok: false, project, message: `Couldn't enable the API on project ${project}. Your Google user needs the Service Usage Admin (or Owner/Editor) role on that project.` };
}

/**
 * Check the Google connection can actually read the customer (through the
 * manager when one is given), then link it to the workspace with the
 * account's real name, currency and time zone.
 */
export async function verifyAndLinkAccount(input: {
  workspaceId: string; googleAccountId: string; customerId: string; loginCustomerId?: string | null; userId: string | null;
  monthlyBudget?: number | null;
}) {
  const customerId = cleanCustomerId(input.customerId);
  const loginCustomerId = input.loginCustomerId ? cleanCustomerId(input.loginCustomerId) : null;
  const available = getGoogleAccountsForWorkspace(input.workspaceId).some(a => a.id === input.googleAccountId);
  if (!available) throw new AdsApiError('That Google connection is not available in this workspace. Share it with the workspace first.', 'PERMISSION');
  const { rows } = await searchGaql({ googleAccountId: input.googleAccountId, loginCustomerId }, customerId,
    'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account FROM customer LIMIT 1', 1);
  const c = (rows[0]?.customer ?? {}) as Record<string, unknown>;
  return linkAdsAccount({
    workspaceId: input.workspaceId, googleAccountId: input.googleAccountId, customerId, loginCustomerId,
    name: (c.descriptiveName as string) ?? null, currency: (c.currencyCode as string) ?? null, timeZone: (c.timeZone as string) ?? null,
    isManager: !!c.manager, testAccount: !!c.testAccount, monthlyBudget: input.monthlyBudget ?? null, createdBy: input.userId,
  });
}
