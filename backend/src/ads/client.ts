/**
 * ads/client.ts — a small REST client for the Google Ads API.
 *
 * The app talks to Google Ads over its REST interface with the same OAuth
 * credentials it already stores for Search Console (the `adwords` scope is an
 * opt-in addition). Since 9 September 2026 API access belongs to the Google
 * Cloud project that owns the OAuth client, so no developer token is sent.
 *
 * Tool semantics (`search`, `get_resource_metadata`, `list_accessible_customers`)
 * mirror Google's open-source googleads/google-ads-mcp server so prompts written
 * for that server work here too.
 */
import { GOOGLE_ADS_SCOPE, getAccessTokenForAccount } from '../auth/google-oauth.js';
import { getGoogleAccountById } from '../db/database.js';
import { describeNetworkFailure } from '../utils/network-failure.js';

export const ADS_SCOPE = GOOGLE_ADS_SCOPE;
export const ADS_API_VERSION = (process.env.GOOGLE_ADS_API_VERSION ?? 'v26').trim() || 'v26';
const BASE = `https://googleads.googleapis.com/${ADS_API_VERSION}`;
const REQUEST_TIMEOUT_MS = 60_000;
/** Hard ceiling on rows returned to a caller, so one query can't flood an AI context. */
export const MAX_ROWS = 10_000;

// ── Identifiers ──────────────────────────────────────────────────────────────

/** "123-456-7890" / "customers/1234567890" / 1234567890 → "1234567890". */
export function cleanCustomerId(value: unknown): string {
  const digits = String(value ?? '').replace(/^customers\//, '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(digits)) throw new AdsApiError(`"${String(value)}" is not a Google Ads customer ID (expected 10 digits, e.g. 123-456-7890).`, 'INVALID_CUSTOMER_ID');
  return digits;
}

export function formatCustomerId(id: string): string {
  return /^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;
}

/** Google Ads money is int64 micros, serialised as a string in REST JSON. */
export function microsToUnits(micros: unknown): number {
  const n = Number(micros ?? 0);
  return Number.isFinite(n) ? Math.round(n / 10_000) / 100 : 0;
}

export function unitsToMicros(units: number): string {
  if (!Number.isFinite(units) || units < 0) throw new AdsApiError('Amounts must be zero or a positive number.', 'INVALID_AMOUNT');
  // Google requires money in multiples of the currency's minimum unit; 10,000
  // micros (0.01) is valid for every currency the API accepts budgets in.
  return String(Math.round(units * 100) * 10_000);
}

export function projectFromClientId(clientId: string | null | undefined): string | null {
  const m = /^(\d{6,})-/.exec(clientId ?? '');
  return m ? m[1] : null;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type AdsErrorKind =
  | 'INVALID_CUSTOMER_ID' | 'INVALID_AMOUNT' | 'NO_ADS_SCOPE' | 'NEEDS_REAUTH' | 'API_DISABLED'
  | 'ACCESS_LEVEL' | 'PERMISSION' | 'NOT_FOUND' | 'QUOTA' | 'INVALID_REQUEST' | 'NETWORK' | 'UNKNOWN';

export class AdsApiError extends Error {
  kind: AdsErrorKind;
  status?: number;
  requestId?: string;
  hint?: string;
  details?: unknown;
  constructor(message: string, kind: AdsErrorKind = 'UNKNOWN', extra: { status?: number; requestId?: string; hint?: string; details?: unknown } = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

interface GoogleErrorBody {
  error?: {
    code?: number; message?: string; status?: string;
    details?: Array<{
      '@type'?: string; reason?: string; metadata?: Record<string, string>; requestId?: string;
      errors?: Array<{ errorCode?: Record<string, string>; message?: string; location?: unknown }>;
    }>;
  };
}

/** Turn a Google error payload into one readable message plus an actionable hint. */
export function parseAdsError(status: number, body: unknown, projectNumber: string | null): AdsApiError {
  const err = (body as GoogleErrorBody | null)?.error;
  const details = err?.details ?? [];
  const failures = details.flatMap(d => d.errors ?? []);
  const requestId = details.find(d => d.requestId)?.requestId;
  const codes = failures.flatMap(f => Object.values(f.errorCode ?? {}));
  const messages = failures.map(f => f.message).filter(Boolean) as string[];
  const raw = JSON.stringify(body ?? '');
  const message = messages.length ? messages.join(' · ') : (err?.message ?? `Google Ads API HTTP ${status}`);
  const project = projectNumber ?? 'YOUR_PROJECT';

  if (details.some(d => d.reason === 'SERVICE_DISABLED') || /has not been used in project|is disabled/i.test(err?.message ?? '')) {
    return new AdsApiError(message, 'API_DISABLED', {
      status, requestId, details: body,
      hint: `Enable the Google Ads API on Google Cloud project ${project}: https://console.cloud.google.com/apis/library/googleads.googleapis.com?project=${project} (or use "Enable automatically" on the Google Ads page).`,
    });
  }
  if (/NOT_APPROVED|only approved for test accounts|TEST_ACCOUNT/i.test(raw)) {
    return new AdsApiError(message, 'ACCESS_LEVEL', {
      status, requestId, details: body,
      hint: `Your Google Cloud project only has Test access, which can't reach real ad accounts. Apply for Explorer or Basic access at https://console.cloud.google.com/google/ads-apis/overview?project=${project}. Projects on a Free Trial or with disabled billing are currently rejected.`,
    });
  }
  if (status === 401 || /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(raw)) {
    return new AdsApiError(message, 'NO_ADS_SCOPE', {
      status, requestId, details: body,
      hint: 'This Google connection has not granted Google Ads access. Use "Add Google Ads access" on the Google Ads page to re-consent with the Ads scope.',
    });
  }
  if (codes.some(c => /USER_PERMISSION_DENIED|CUSTOMER_NOT_ENABLED|NOT_ADS_USER|PERMISSION/.test(c)) || status === 403) {
    return new AdsApiError(message, 'PERMISSION', {
      status, requestId, details: body,
      hint: 'The connected Google user cannot access this ad account directly. If the account sits under a manager (MCC), relink it from the manager so the login customer ID is set, and check the user\'s access in Google Ads → Admin → Access and security.',
    });
  }
  if (status === 404) return new AdsApiError(message, 'NOT_FOUND', { status, requestId, details: body });
  if (status === 429 || codes.some(c => /RESOURCE_EXHAUSTED|RATE_EXCEEDED/.test(c))) {
    return new AdsApiError(message, 'QUOTA', { status, requestId, details: body, hint: 'Google Ads API quota reached for this Cloud project. Explorer access allows 2,880 operations per day; Basic allows 15,000.' });
  }
  if (status === 400) return new AdsApiError(message, 'INVALID_REQUEST', { status, requestId, details: body });
  return new AdsApiError(message, 'UNKNOWN', { status, requestId, details: body });
}

/** A network failure (DNS, refused, TLS, timeout) as an AdsApiError, or null for other errors. */
export function networkError(e: unknown, host: string): AdsApiError | null {
  const failure = describeNetworkFailure(e, host, REQUEST_TIMEOUT_MS / 1000);
  return failure ? new AdsApiError(failure.message, 'NETWORK', { hint: failure.hint }) : null;
}

// ── Transport ────────────────────────────────────────────────────────────────

export interface AdsCallContext {
  /** Stored Google connection (google_accounts.id) whose OAuth grant includes the Ads scope. */
  googleAccountId: string;
  /** Manager account used to reach a client account (login-customer-id header). */
  loginCustomerId?: string | null;
}

/** Test seam: swap the network layer without touching real credentials. */
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
let tokenSource: (accountId: string) => Promise<string> = getAccessTokenForAccount;
export function __setAdsTransportForTests(next: { fetcher?: Fetcher; token?: (accountId: string) => Promise<string> }): void {
  if (next.fetcher) fetcher = next.fetcher;
  if (next.token) tokenSource = next.token;
}

export function accountHasAdsScope(googleAccountId: string): boolean {
  const account = getGoogleAccountById(googleAccountId);
  return !!account?.granted_scopes?.split(' ').includes(ADS_SCOPE);
}

async function call<T>(ctx: AdsCallContext, path: string, body?: unknown, method?: 'GET' | 'POST'): Promise<T> {
  const account = getGoogleAccountById(ctx.googleAccountId);
  if (!account) throw new AdsApiError('The Google connection for this ad account was removed. Link the account again from the Google Ads page.', 'NEEDS_REAUTH');
  if (account.needs_reauth) throw new AdsApiError(`Google connection ${account.email ?? account.id} must be reconnected before it can be used.`, 'NEEDS_REAUTH', { hint: 'Reconnect it under Settings → Google Accounts or from the Google Ads page.' });
  const token = await tokenSource(ctx.googleAccountId).catch((e: unknown) => { throw networkError(e, 'oauth2.googleapis.com') ?? e; });
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (ctx.loginCustomerId) headers['login-customer-id'] = cleanCustomerId(ctx.loginCustomerId);
  const res = await fetcher(`${BASE}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((e: unknown) => { throw networkError(e, new URL(BASE).host) ?? e; });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) throw parseAdsError(res.status, parsed, projectFromClientId(account.client_id));
  return parsed as T;
}

// ── Read operations ──────────────────────────────────────────────────────────

/** Customer IDs the Google user can reach directly (managers and standalone accounts). */
export async function listAccessibleCustomers(googleAccountId: string): Promise<string[]> {
  const data = await call<{ resourceNames?: string[] }>({ googleAccountId }, '/customers:listAccessibleCustomers');
  return (data.resourceNames ?? []).map(name => name.replace(/^customers\//, ''));
}

export type AdsRow = Record<string, unknown>;

/** Run a GAQL query with pagination. Rows keep the REST shape ({ campaign: {...}, metrics: {...} }). */
export async function searchGaql(ctx: AdsCallContext, customerId: string, query: string, maxRows = 1000): Promise<{ rows: AdsRow[]; truncated: boolean; fieldMask?: string }> {
  const cid = cleanCustomerId(customerId);
  const cap = Math.max(1, Math.min(MAX_ROWS, Math.floor(maxRows)));
  const rows: AdsRow[] = [];
  let pageToken: string | undefined;
  let fieldMask: string | undefined;
  do {
    const page = await call<{ results?: AdsRow[]; nextPageToken?: string; fieldMask?: string }>(
      ctx, `/customers/${cid}/googleAds:search`, { query, ...(pageToken ? { pageToken } : {}) });
    fieldMask ??= page.fieldMask;
    for (const row of page.results ?? []) {
      if (rows.length >= cap) return { rows, truncated: true, fieldMask };
      rows.push(row);
    }
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
  return { rows, truncated: false, fieldMask };
}

export interface StructuredSearch {
  fields: string[];
  resource: string;
  conditions?: string[];
  orderings?: string[];
  limit?: number | null;
}

/** Build GAQL exactly like the upstream `search` tool: SELECT … FROM … WHERE a AND b ORDER BY … LIMIT n. */
export function buildGaql(input: StructuredSearch): string {
  const identifier = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/i;
  if (!identifier.test(input.resource)) throw new AdsApiError(`"${input.resource}" is not a valid GAQL resource name.`, 'INVALID_REQUEST');
  if (!input.fields.length) throw new AdsApiError('Select at least one field.', 'INVALID_REQUEST');
  for (const field of input.fields) {
    if (!identifier.test(field)) throw new AdsApiError(`"${field}" is not a valid GAQL field. Use full names such as campaign.id or metrics.clicks.`, 'INVALID_REQUEST');
  }
  let query = `SELECT ${input.fields.join(', ')} FROM ${input.resource}`;
  if (input.conditions?.length) query += ` WHERE ${input.conditions.join(' AND ')}`;
  if (input.orderings?.length) query += ` ORDER BY ${input.orderings.join(', ')}`;
  if (input.limit) query += ` LIMIT ${Math.max(1, Math.min(MAX_ROWS, Math.floor(input.limit)))}`;
  return query;
}

/** Flatten a REST row into "resource.field" keys, mirroring the upstream server's output. */
export function flattenRow(row: AdsRow, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const snake = key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
    const path = prefix ? `${prefix}.${snake}` : snake;
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(out, flattenRow(value as AdsRow, path));
    else out[path] = value;
  }
  return out;
}

const metadataCache = new Map<string, { at: number; value: ResourceMetadata }>();
const METADATA_TTL_MS = 24 * 3_600_000;

export interface ResourceMetadata { resource: string; selectable: string[]; filterable: string[]; sortable: string[] }

/** Selectable/filterable/sortable fields for a resource, including compatible metrics and segments. */
export async function getResourceMetadata(ctx: AdsCallContext, resource: string): Promise<ResourceMetadata> {
  if (!/^[a-z][a-z0-9_]*$/.test(resource)) throw new AdsApiError(`"${resource}" is not a valid resource name (e.g. campaign, ad_group).`, 'INVALID_REQUEST');
  const cached = metadataCache.get(resource);
  if (cached && Date.now() - cached.at < METADATA_TTL_MS) return cached.value;
  const selectable = new Set<string>(); const filterable = new Set<string>(); const sortable = new Set<string>();
  const collect = async (query: string) => {
    let pageToken: string | undefined;
    do {
      const page = await call<{ results?: Array<{ name?: string; selectable?: boolean; filterable?: boolean; sortable?: boolean }>; nextPageToken?: string }>(
        ctx, '/googleAdsFields:search', { query, pageSize: 10_000, ...(pageToken ? { pageToken } : {}) });
      for (const field of page.results ?? []) {
        if (!field.name) continue;
        if (field.selectable) selectable.add(field.name);
        if (field.filterable) filterable.add(field.name);
        if (field.sortable) sortable.add(field.name);
      }
      pageToken = page.nextPageToken || undefined;
    } while (pageToken);
  };
  await collect(`SELECT name, selectable, filterable, sortable WHERE name LIKE '${resource}.%' AND category = 'ATTRIBUTE'`);
  await collect(`SELECT name, selectable, filterable, sortable WHERE selectable_with CONTAINS ANY('${resource}')`);
  const value = { resource, selectable: [...selectable].sort(), filterable: [...filterable].sort(), sortable: [...sortable].sort() };
  metadataCache.set(resource, { at: Date.now(), value });
  return value;
}

// ── Write operations ─────────────────────────────────────────────────────────

export interface MutateResult {
  mutateOperationResponses?: Array<Record<string, unknown>>;
  partialFailureError?: unknown;
}

/** GoogleAdsService.Mutate. `validateOnly` runs Google's full validation without changing anything. */
export async function mutate(ctx: AdsCallContext, customerId: string, operations: unknown[], opts: { validateOnly: boolean; partialFailure?: boolean }): Promise<MutateResult> {
  const cid = cleanCustomerId(customerId);
  if (!operations.length) throw new AdsApiError('No operations to send.', 'INVALID_REQUEST');
  if (operations.length > 1000) throw new AdsApiError('A single change may contain at most 1,000 operations.', 'INVALID_REQUEST');
  return call<MutateResult>(ctx, `/customers/${cid}/googleAds:mutate`, {
    mutateOperations: operations,
    validateOnly: opts.validateOnly,
    partialFailure: !!opts.partialFailure,
    responseContentType: 'RESOURCE_NAME_ONLY',
  });
}

export async function applyRecommendations(ctx: AdsCallContext, customerId: string, resourceNames: string[]): Promise<unknown> {
  const cid = cleanCustomerId(customerId);
  return call(ctx, `/customers/${cid}/recommendations:apply`, { operations: resourceNames.map(resourceName => ({ resourceName })), partialFailure: false });
}

export async function dismissRecommendations(ctx: AdsCallContext, customerId: string, resourceNames: string[]): Promise<unknown> {
  const cid = cleanCustomerId(customerId);
  return call(ctx, `/customers/${cid}/recommendations:dismiss`, { operations: resourceNames.map(resourceName => ({ resourceName })), partialFailure: false });
}

// ── Planning ─────────────────────────────────────────────────────────────────

export interface KeywordIdeaInput {
  keywords?: string[];
  url?: string;
  geoTargetIds?: string[];
  languageId?: string;
  limit?: number;
}

/** KeywordPlanIdeaService.GenerateKeywordIdeas (not available on Explorer access). */
export async function generateKeywordIdeas(ctx: AdsCallContext, customerId: string, input: KeywordIdeaInput): Promise<Array<Record<string, unknown>>> {
  const cid = cleanCustomerId(customerId);
  const keywords = (input.keywords ?? []).map(k => k.trim()).filter(Boolean).slice(0, 20);
  const url = input.url?.trim();
  if (!keywords.length && !url) throw new AdsApiError('Provide seed keywords, a URL, or both.', 'INVALID_REQUEST');
  const body: Record<string, unknown> = {
    language: `languageConstants/${(input.languageId ?? '1000').replace(/\D/g, '') || '1000'}`,
    geoTargetConstants: (input.geoTargetIds ?? []).map(id => `geoTargetConstants/${String(id).replace(/\D/g, '')}`),
    keywordPlanNetwork: 'GOOGLE_SEARCH',
    includeAdultKeywords: false,
    pageSize: Math.max(1, Math.min(1000, input.limit ?? 100)),
  };
  if (keywords.length && url) body.keywordAndUrlSeed = { url, keywords };
  else if (keywords.length) body.keywordSeed = { keywords };
  else body.urlSeed = { url };
  const data = await call<{ results?: Array<{ text?: string; keywordIdeaMetrics?: Record<string, unknown> }> }>(ctx, `/customers/${cid}:generateKeywordIdeas`, body);
  return (data.results ?? []).map(idea => {
    const m = idea.keywordIdeaMetrics ?? {};
    return {
      keyword: idea.text,
      avg_monthly_searches: Number(m.avgMonthlySearches ?? 0),
      competition: m.competition ?? null,
      competition_index: m.competitionIndex !== undefined ? Number(m.competitionIndex) : null,
      top_of_page_bid_low: m.lowTopOfPageBidMicros !== undefined ? microsToUnits(m.lowTopOfPageBidMicros) : null,
      top_of_page_bid_high: m.highTopOfPageBidMicros !== undefined ? microsToUnits(m.highTopOfPageBidMicros) : null,
    };
  });
}

/** GeoTargetConstantService.SuggestGeoTargetConstants — find location IDs by name. */
export async function suggestLocations(ctx: AdsCallContext, names: string[], countryCode?: string, locale = 'en'): Promise<Array<Record<string, unknown>>> {
  const data = await call<{ geoTargetConstantSuggestions?: Array<{ geoTargetConstant?: Record<string, unknown>; searchTerm?: string; reach?: string }> }>(
    ctx, '/geoTargetConstants:suggest', {
      locale,
      ...(countryCode ? { countryCode } : {}),
      locationNames: { names: names.map(n => n.trim()).filter(Boolean).slice(0, 25) },
    });
  return (data.geoTargetConstantSuggestions ?? []).map(s => ({
    search_term: s.searchTerm,
    id: s.geoTargetConstant?.id,
    name: s.geoTargetConstant?.name,
    canonical_name: s.geoTargetConstant?.canonicalName,
    target_type: s.geoTargetConstant?.targetType,
    country_code: s.geoTargetConstant?.countryCode,
    reach: s.reach !== undefined ? Number(s.reach) : null,
  }));
}

// ── Account discovery ────────────────────────────────────────────────────────

export interface DiscoveredCustomer {
  customer_id: string;
  name: string | null;
  currency: string | null;
  time_zone: string | null;
  manager: boolean;
  test_account: boolean;
  status: string | null;
  /** Manager whose login-customer-id reaches this account, or null when accessed directly. */
  login_customer_id: string | null;
  level: number;
  error?: string;
}

/**
 * Every ad account a Google connection can reach: the directly accessible
 * accounts plus (for managers) their client accounts up to two levels down.
 */
export async function discoverCustomers(googleAccountId: string): Promise<{ customers: DiscoveredCustomer[]; errors: string[] }> {
  const roots = await listAccessibleCustomers(googleAccountId);
  const found = new Map<string, DiscoveredCustomer>();
  const errors: string[] = [];
  for (const root of roots.slice(0, 50)) {
    try {
      const { rows } = await searchGaql({ googleAccountId, loginCustomerId: root }, root, `
        SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code,
               customer_client.time_zone, customer_client.manager, customer_client.test_account,
               customer_client.status, customer_client.level
        FROM customer_client WHERE customer_client.level <= 2`, 5000);
      for (const row of rows) {
        const c = (row.customerClient ?? {}) as Record<string, unknown>;
        const id = String(c.id ?? '');
        if (!id) continue;
        const level = Number(c.level ?? 0);
        const existing = found.get(id);
        // Prefer direct access (level 0) over reaching the same account via a manager.
        if (existing && existing.level <= level) continue;
        found.set(id, {
          customer_id: id,
          name: (c.descriptiveName as string) ?? null,
          currency: (c.currencyCode as string) ?? null,
          time_zone: (c.timeZone as string) ?? null,
          manager: !!c.manager,
          test_account: !!c.testAccount,
          status: (c.status as string) ?? null,
          login_customer_id: level === 0 ? null : root,
          level,
        });
      }
    } catch (e) {
      const err = e as AdsApiError;
      if (err.kind === 'API_DISABLED' || err.kind === 'ACCESS_LEVEL' || err.kind === 'NO_ADS_SCOPE') throw err;
      errors.push(`${formatCustomerId(root)}: ${err.message}`);
      if (!found.has(root)) {
        found.set(root, { customer_id: root, name: null, currency: null, time_zone: null, manager: false, test_account: false, status: null, login_customer_id: null, level: 0, error: err.message });
      }
    }
  }
  return { customers: [...found.values()].sort((a, b) => (a.name ?? a.customer_id).localeCompare(b.name ?? b.customer_id)), errors };
}
