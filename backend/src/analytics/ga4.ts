/**
 * analytics/ga4.ts — read-only Google Analytics 4 access for the dashboard and
 * the MCP server: property discovery (Admin API), report metadata and
 * reports (Data API).
 *
 * Which Google login reads a property is resolved per request from the
 * connections shared with the caller's workspaces: the preferred login first
 * (e.g. the one linked to the Google Ads account), then the others. Google
 * decides access (the login needs at least Viewer on the property); this
 * module never reaches a login outside the caller's workspaces.
 */
import { getAccessTokenForAccount, GOOGLE_ANALYTICS_SCOPE } from '../auth/google-oauth.js';
import { getGoogleAccountsForWorkspace, type GoogleAccount } from '../db/database.js';

const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
export const GA4_MAX_ROWS = 10_000;

export type Ga4ErrorKind = 'NO_LOGIN' | 'SCOPE' | 'API_DISABLED' | 'PERMISSION' | 'NOT_FOUND' | 'INVALID' | 'QUOTA' | 'UNKNOWN';

export class Ga4Error extends Error {
  constructor(message: string, public kind: Ga4ErrorKind, public hint: string | null = null) {
    super(message);
    this.name = 'Ga4Error';
  }
}

/** "properties/449058214", " 449058214 " → "449058214". Throws on anything else. */
export function cleanPropertyId(raw: unknown): string {
  const id = String(raw ?? '').trim().replace(/^properties\//, '');
  if (!/^\d{4,15}$/.test(id)) throw new Ga4Error(`"${String(raw)}" is not a GA4 property ID. Use the numeric ID from GA4 → Admin → Property details (e.g. 449058214).`, 'INVALID');
  return id;
}

const DATE = /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d{1,4}daysAgo)$/;
export function cleanDate(raw: unknown, fallback: string): string {
  const value = raw === undefined || raw === null || raw === '' ? fallback : String(raw).trim();
  if (!DATE.test(value)) throw new Ga4Error(`"${value}" is not a GA4 date. Use YYYY-MM-DD, "today", "yesterday" or "NdaysAgo".`, 'INVALID');
  return value;
}

// ── Logins ───────────────────────────────────────────────────────────────────

/** Google logins shared with these workspaces that may read GA4, `prefer` first. */
export function analyticsLogins(workspaceIds: string[], prefer?: string | null): GoogleAccount[] {
  const seen = new Map<string, GoogleAccount>();
  for (const ws of workspaceIds) {
    for (const acc of getGoogleAccountsForWorkspace(ws)) {
      if (acc.needs_reauth) continue;
      // Legacy grants recorded no scopes; let Google decide for those.
      const scopes = acc.granted_scopes;
      if (scopes && !scopes.split(' ').includes(GOOGLE_ANALYTICS_SCOPE)) continue;
      seen.set(acc.id, acc);
    }
  }
  const list = [...seen.values()];
  return prefer ? [...list.filter(a => a.id === prefer), ...list.filter(a => a.id !== prefer)] : list;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

interface GoogleErrorBody { error?: { code?: number; message?: string; status?: string; details?: Array<{ reason?: string }> } }

function toGa4Error(status: number, body: GoogleErrorBody, label: string): Ga4Error {
  const message = body.error?.message ?? `HTTP ${status}`;
  const reasons = (body.error?.details ?? []).map(d => d.reason ?? '');
  if (reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /insufficient authentication scopes/i.test(message)) {
    return new Ga4Error(`${label} has not granted Google Analytics access.`, 'SCOPE', 'Click Reconnect on this Google login (Accounts page) so it grants Google Analytics read access.');
  }
  if (reasons.includes('SERVICE_DISABLED') || /has not been used in project|is disabled/i.test(message)) {
    const link = /https:\/\/console\.(?:developers|cloud)\.google\.com\/\S+/.exec(message)?.[0] ?? null;
    return new Ga4Error(`A Google Analytics API is disabled for the Google Cloud project behind ${label}.`, 'API_DISABLED',
      `Enable the "Google Analytics Data API" and "Google Analytics Admin API" in that project${link ? ` (${link.replace(/[.,)]+$/, '')})` : ''}, wait a minute, then retry.`);
  }
  if (status === 401) return new Ga4Error(`${label} needs to be reconnected.`, 'SCOPE', 'Click Reconnect on this Google login on the Accounts page.');
  if (status === 403) return new Ga4Error(`${label} cannot read this GA4 property.`, 'PERMISSION', 'In GA4 → Admin → Property access management, give this Google login the Viewer role (or higher).');
  if (status === 404) return new Ga4Error(`GA4 property not found for ${label}: ${message}`, 'NOT_FOUND', 'Check the numeric property ID in GA4 → Admin → Property details.');
  if (status === 429) return new Ga4Error(`GA4 quota exceeded: ${message}`, 'QUOTA', 'GA4 limits requests per property per hour; try again later or request fewer rows.');
  if (status === 400) return new Ga4Error(`GA4 rejected the request: ${message}`, 'INVALID', 'Check dimension and metric names with ga4_get_metadata; some combinations are incompatible.');
  return new Ga4Error(`GA4 request failed (${status}): ${message}`, 'UNKNOWN');
}

async function ga4Fetch<T>(login: GoogleAccount, url: string, body?: unknown): Promise<T> {
  const label = login.email ?? login.id;
  let token: string;
  try { token = await getAccessTokenForAccount(login.id); }
  catch (e) { throw new Ga4Error(`${label}: ${e instanceof Error ? e.message : String(e)}`, 'SCOPE', 'Reconnect this Google login on the Accounts page.'); }
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({})) as T & GoogleErrorBody;
  if (!res.ok) throw toGa4Error(res.status, data, label);
  return data;
}

/**
 * Run `fn` with the first login that can read the property. Access problems
 * (permission, not found, missing scope) move on to the next login; anything
 * else (an invalid request, quota, a disabled API) is the same for every login
 * and is thrown at once.
 */
export async function withPropertyAccess<T>(logins: GoogleAccount[], fn: (login: GoogleAccount) => Promise<T>): Promise<{ result: T; login: GoogleAccount }> {
  if (!logins.length) {
    throw new Ga4Error('No Google login with Google Analytics access is connected to this workspace.', 'NO_LOGIN',
      'Connect (or Reconnect) a Google login that has Viewer access to the GA4 property, on the Accounts page.');
  }
  const failures: Ga4Error[] = [];
  for (const login of logins) {
    try {
      return { result: await fn(login), login };
    } catch (e) {
      if (!(e instanceof Ga4Error) || !['PERMISSION', 'NOT_FOUND', 'SCOPE'].includes(e.kind)) throw e;
      failures.push(e);
    }
  }
  const tried = logins.map(l => l.email ?? l.id).join(', ');
  const first = failures.find(f => f.kind === 'PERMISSION') ?? failures[0];
  throw new Ga4Error(`None of the connected Google logins can read this GA4 property (tried ${tried}).`, first.kind, first.hint);
}

// ── Properties ───────────────────────────────────────────────────────────────

export interface Ga4Property { property_id: string; property_name: string; account_id: string; account_name: string }

/** GA4 properties one login can see (Admin API account summaries). */
export async function listGa4Properties(login: GoogleAccount): Promise<Ga4Property[]> {
  const out: Ga4Property[] = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const data = await ga4Fetch<{
      accountSummaries?: Array<{ account?: string; displayName?: string; propertySummaries?: Array<{ property?: string; displayName?: string }> }>;
      nextPageToken?: string;
    }>(login, `${ADMIN_API}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    for (const account of data.accountSummaries ?? []) {
      for (const p of account.propertySummaries ?? []) {
        out.push({
          property_id: String(p.property ?? '').replace(/^properties\//, ''), property_name: p.displayName ?? '',
          account_id: String(account.account ?? '').replace(/^accounts\//, ''), account_name: account.displayName ?? '',
        });
      }
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

/** Display name of a property, or null when the Admin API can't tell us (best effort). */
export async function ga4PropertyName(login: GoogleAccount, propertyId: string): Promise<string | null> {
  try {
    const data = await ga4Fetch<{ displayName?: string }>(login, `${ADMIN_API}/properties/${propertyId}`);
    return data.displayName ?? null;
  } catch {
    return null;
  }
}

// ── Metadata ─────────────────────────────────────────────────────────────────

export interface Ga4Metadata {
  dimensions: Array<{ name: string; label: string; category: string; custom: boolean }>;
  metrics: Array<{ name: string; label: string; category: string; type: string; custom: boolean }>;
}

export async function getGa4Metadata(login: GoogleAccount, propertyId: string): Promise<Ga4Metadata> {
  const data = await ga4Fetch<{
    dimensions?: Array<{ apiName?: string; uiName?: string; category?: string; customDefinition?: boolean }>;
    metrics?: Array<{ apiName?: string; uiName?: string; category?: string; type?: string; customDefinition?: boolean }>;
  }>(login, `${DATA_API}/properties/${propertyId}/metadata`);
  return {
    dimensions: (data.dimensions ?? []).map(d => ({ name: d.apiName ?? '', label: d.uiName ?? '', category: d.category ?? '', custom: !!d.customDefinition })),
    metrics: (data.metrics ?? []).map(m => ({ name: m.apiName ?? '', label: m.uiName ?? '', category: m.category ?? '', type: m.type ?? '', custom: !!m.customDefinition })),
  };
}

// ── Reports ──────────────────────────────────────────────────────────────────

export type Ga4MatchType = 'exact' | 'contains' | 'begins_with' | 'regex';
export interface Ga4Filter { dimension: string; value: string; match?: Ga4MatchType; exclude?: boolean }

export interface Ga4ReportRequest {
  startDate?: string;
  endDate?: string;
  dimensions?: string[];
  metrics: string[];
  filters?: Ga4Filter[];
  orderBy?: { field: string; desc?: boolean };
  limit?: number;
}

export interface Ga4ReportResult {
  property_id: string;
  start_date: string;
  end_date: string;
  dimensions: string[];
  metrics: string[];
  rows: Array<Record<string, string | number>>;
  totals: Record<string, number> | null;
  row_count: number;
  truncated: boolean;
  currency: string | null;
  time_zone: string | null;
  google_login: string;
}

const MATCH: Record<Ga4MatchType, string> = { exact: 'EXACT', contains: 'CONTAINS', begins_with: 'BEGINS_WITH', regex: 'FULL_REGEXP' };

/** The Data API body for a report request (exported for tests). */
export function buildReportBody(req: Ga4ReportRequest) {
  if (!req.metrics?.length) throw new Ga4Error('A GA4 report needs at least one metric (e.g. sessions, keyEvents).', 'INVALID');
  const dimensions = req.dimensions ?? [];
  const limit = Math.min(Math.max(1, Math.floor(req.limit ?? 1000)), GA4_MAX_ROWS);
  const expressions = (req.filters ?? []).map(f => {
    const expr = { filter: { fieldName: f.dimension, stringFilter: { matchType: MATCH[f.match ?? 'exact'], value: f.value, caseSensitive: false } } };
    return f.exclude ? { notExpression: expr } : expr;
  });
  const orderBy = req.orderBy
    ? [req.metrics.includes(req.orderBy.field)
      ? { metric: { metricName: req.orderBy.field }, desc: req.orderBy.desc ?? true }
      : { dimension: { dimensionName: req.orderBy.field }, desc: req.orderBy.desc ?? false }]
    : req.metrics.length ? [{ metric: { metricName: req.metrics[0] }, desc: true }] : undefined;
  return {
    dateRanges: [{ startDate: cleanDate(req.startDate, '28daysAgo'), endDate: cleanDate(req.endDate, 'yesterday') }],
    dimensions: dimensions.map(name => ({ name })),
    metrics: req.metrics.map(name => ({ name })),
    ...(expressions.length ? { dimensionFilter: expressions.length === 1 ? expressions[0] : { andGroup: { expressions } } } : {}),
    ...(orderBy ? { orderBys: orderBy } : {}),
    metricAggregations: ['TOTAL'],
    limit: String(limit),
  };
}

const asNumber = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** GA4 returns dates as YYYYMMDD; show them as YYYY-MM-DD. */
const readable = (dimension: string, value: string) => dimension === 'date' && /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;

export async function runGa4Report(login: GoogleAccount, propertyId: string, req: Ga4ReportRequest): Promise<Ga4ReportResult> {
  const body = buildReportBody(req);
  const data = await ga4Fetch<{
    dimensionHeaders?: Array<{ name?: string }>;
    metricHeaders?: Array<{ name?: string }>;
    rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }>;
    totals?: Array<{ metricValues?: Array<{ value?: string }> }>;
    rowCount?: number;
    metadata?: { currencyCode?: string; timeZone?: string };
  }>(login, `${DATA_API}/properties/${propertyId}:runReport`, body);
  const dims = (data.dimensionHeaders ?? []).map(h => h.name ?? '');
  const mets = (data.metricHeaders ?? []).map(h => h.name ?? '');
  const rows = (data.rows ?? []).map(row => {
    const out: Record<string, string | number> = {};
    dims.forEach((d, i) => { out[d] = readable(d, row.dimensionValues?.[i]?.value ?? ''); });
    mets.forEach((m, i) => { out[m] = asNumber(row.metricValues?.[i]?.value); });
    return out;
  });
  const totalsRow = data.totals?.[0]?.metricValues;
  const rowCount = data.rowCount ?? rows.length;
  return {
    property_id: propertyId,
    start_date: body.dateRanges[0].startDate,
    end_date: body.dateRanges[0].endDate,
    dimensions: dims,
    metrics: mets,
    rows,
    totals: totalsRow ? Object.fromEntries(mets.map((m, i) => [m, asNumber(totalsRow[i]?.value)])) : null,
    row_count: rowCount,
    truncated: rowCount > rows.length,
    currency: data.metadata?.currencyCode ?? null,
    time_zone: data.metadata?.timeZone ?? null,
    google_login: login.email ?? login.id,
  };
}
