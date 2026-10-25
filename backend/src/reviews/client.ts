/**
 * reviews/client.ts — a small REST client for the Google Business Profile
 * APIs used to read and answer reviews.
 *
 *   Accounts:   mybusinessaccountmanagement.googleapis.com/v1/accounts
 *   Locations:  mybusinessbusinessinformation.googleapis.com/v1/{account}/locations
 *   Reviews:    mybusiness.googleapis.com/v4/{account}/{location}/reviews  (list, get, PUT/DELETE …/reply)
 *   Insights:   businessprofileperformance.googleapis.com/v1/{location}  (daily metrics, search keywords)
 *
 * Every call uses the stored Google connection's OAuth token with the
 * business.manage scope. Google only serves these APIs to Cloud projects it
 * has approved: an unapproved project has a quota of 0 and every call fails
 * with RESOURCE_EXHAUSTED, which is translated into an "apply for access" hint.
 */
import { getAccessTokenForAccount, GOOGLE_BUSINESS_SCOPE } from '../auth/google-oauth.js';
import { getGoogleAccountById } from '../db/database.js';
import { describeNetworkFailure } from '../utils/network-failure.js';

export const BUSINESS_SCOPE = GOOGLE_BUSINESS_SCOPE;
const ACCOUNTS_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFO_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const REVIEWS_BASE = 'https://mybusiness.googleapis.com/v4';
const PERFORMANCE_BASE = 'https://businessprofileperformance.googleapis.com/v1';
const REQUEST_TIMEOUT_MS = 30_000;
/** Google's documented maximum page size for reviews.list. */
const REVIEW_PAGE_SIZE = 50;
/** Google stores replies of up to 4,096 bytes. */
export const MAX_REPLY_BYTES = 4096;

export const ACCESS_FORM_URL = 'https://support.google.com/business/contact/api_default';

// ── Errors ───────────────────────────────────────────────────────────────────

export type ReviewsErrorKind =
  | 'NO_SCOPE' | 'NEEDS_REAUTH' | 'API_DISABLED' | 'NOT_APPROVED' | 'PERMISSION' | 'NOT_FOUND'
  | 'NOT_VERIFIED' | 'QUOTA' | 'INVALID_REQUEST' | 'NETWORK' | 'UNKNOWN';

export class ReviewsApiError extends Error {
  kind: ReviewsErrorKind;
  status?: number;
  hint?: string;
  constructor(message: string, kind: ReviewsErrorKind = 'UNKNOWN', extra: { status?: number; hint?: string } = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

export function projectFromClientId(clientId: string | null | undefined): string | null {
  const m = /^(\d{6,})-/.exec(clientId ?? '');
  return m ? m[1] : null;
}

interface GoogleErrorBody {
  error?: {
    code?: number; message?: string; status?: string;
    details?: Array<{ '@type'?: string; reason?: string; metadata?: Record<string, string> }>;
  };
}

/** Turn a Google error payload into one readable message plus a next step. */
export function parseBusinessError(status: number, body: unknown, projectNumber: string | null): ReviewsApiError {
  const err = (body as GoogleErrorBody | null)?.error;
  const details = err?.details ?? [];
  const raw = JSON.stringify(body ?? '');
  const message = err?.message ?? `Google Business Profile API HTTP ${status}`;
  const project = projectNumber ?? 'YOUR_PROJECT_NUMBER';

  if (details.some(d => d.reason === 'SERVICE_DISABLED') || /has not been used in project|is disabled/i.test(err?.message ?? '')) {
    return new ReviewsApiError(message, 'API_DISABLED', {
      status,
      hint: `Enable the Business Profile APIs (My Business Account Management, My Business Business Information and Google My Business) on Google Cloud project ${project}, or use "Enable automatically" on the Reviews page.`,
    });
  }
  // An unapproved project has a quota of 0 requests per minute.
  if (status === 429 && (details.some(d => d.metadata?.quota_limit_value === '0') || /limit[^"]*\b0\b|quota_limit_value":"0"/i.test(raw))) {
    return new ReviewsApiError('Google has not approved this Cloud project for the Business Profile APIs yet (its quota is 0 requests per minute).', 'NOT_APPROVED', {
      status,
      hint: `Apply at ${ACCESS_FORM_URL} — choose "Application for Basic API Access", give project number ${project}, and send it from an email that owns or manages the Business Profile. Google requires a profile verified and active for 60+ days with a website. Approval shows as 300 requests per minute on the project's Business Profile API quotas.`,
    });
  }
  if (status === 401 && !/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(raw)) {
    return new ReviewsApiError(message, 'NEEDS_REAUTH', {
      status,
      hint: 'Google rejected this connection\'s sign-in. Reconnect the Google account (Reviews → Setup) and try again.',
    });
  }
  if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(raw)) {
    return new ReviewsApiError(message, 'NO_SCOPE', {
      status,
      hint: 'This Google connection has not granted Business Profile access. Use "Add Business Profile access" on the Reviews page to re-consent.',
    });
  }
  if (status === 429) {
    return new ReviewsApiError(message, 'QUOTA', { status, hint: 'Business Profile API quota reached (300 requests per minute once approved). It resets within a minute.' });
  }
  if (/not verified|unverified|FAILED_PRECONDITION/i.test(raw) && status === 400) {
    return new ReviewsApiError(message, 'NOT_VERIFIED', { status, hint: 'Google only accepts replies for verified Business Profiles. Verify the profile in Google Business Profile Manager.' });
  }
  if (status === 403) {
    return new ReviewsApiError(message, 'PERMISSION', {
      status,
      hint: 'The connected Google user is not an owner or manager of this Business Profile. Add them in Business Profile → Settings → People and access, or link the location from a user who manages it.',
    });
  }
  if (status === 404) return new ReviewsApiError(message, 'NOT_FOUND', { status });
  if (status === 400) return new ReviewsApiError(message, 'INVALID_REQUEST', { status });
  return new ReviewsApiError(message, 'UNKNOWN', { status });
}

// ── Transport ────────────────────────────────────────────────────────────────

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
let tokenSource: (accountId: string) => Promise<string> = getAccessTokenForAccount;
/** Test seam: swap the network layer without touching real credentials. */
export function __setBusinessTransportForTests(next: { fetcher?: Fetcher; token?: (accountId: string) => Promise<string> }): void {
  if (next.fetcher) fetcher = next.fetcher;
  if (next.token) tokenSource = next.token;
}

function networkError(e: unknown, url: string): ReviewsApiError | null {
  const failure = describeNetworkFailure(e, new URL(url).host, REQUEST_TIMEOUT_MS / 1000);
  return failure ? new ReviewsApiError(failure.message, 'NETWORK', { hint: failure.hint }) : null;
}

async function call<T>(googleAccountId: string, url: string, init: { method?: 'GET' | 'PUT' | 'DELETE' | 'POST'; body?: unknown } = {}): Promise<T> {
  const account = getGoogleAccountById(googleAccountId);
  if (!account) throw new ReviewsApiError('The Google connection for this location was removed. Link the location again from the Reviews page.', 'NEEDS_REAUTH');
  if (account.needs_reauth) throw new ReviewsApiError(`Google connection ${account.email ?? account.id} must be reconnected before it can be used.`, 'NEEDS_REAUTH', { hint: 'Reconnect it under Settings → Google Accounts or from the Reviews page.' });
  const token = await tokenSource(googleAccountId).catch((e: unknown) => { throw networkError(e, 'https://oauth2.googleapis.com') ?? e; });
  const res = await fetcher(url, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((e: unknown) => { throw networkError(e, url) ?? e; });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) throw parseBusinessError(res.status, parsed, projectFromClientId(account.client_id));
  return parsed as T;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface BusinessAccount { name: string; accountName?: string; type?: string; role?: string; verificationState?: string }

export interface BusinessLocation {
  /** "locations/123" (Business Information API). */
  name: string;
  title?: string;
  websiteUri?: string;
  storefrontAddress?: { addressLines?: string[]; locality?: string; administrativeArea?: string; postalCode?: string; regionCode?: string };
  metadata?: { placeId?: string; mapsUri?: string; newReviewUri?: string; hasVoiceOfMerchant?: boolean };
}

export type StarRating = 'STAR_RATING_UNSPECIFIED' | 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';

export interface GoogleReview {
  /** "accounts/1/locations/2/reviews/3". */
  name: string;
  reviewId?: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean };
  starRating?: StarRating;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string; reviewReplyState?: string; policyViolation?: string };
  reviewMediaItems?: Array<{ thumbnailUrl?: string; videoUrl?: string; thumbnailLabel?: string }>;
  reviewReplyUrl?: string;
}

export const STAR_VALUE: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

// ── Calls ────────────────────────────────────────────────────────────────────

/** Business Profile accounts (personal, location groups, organisations) the Google user can reach. */
export async function listBusinessAccounts(googleAccountId: string): Promise<BusinessAccount[]> {
  const out: BusinessAccount[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ pageSize: '20', ...(pageToken ? { pageToken } : {}) });
    const data = await call<{ accounts?: BusinessAccount[]; nextPageToken?: string }>(googleAccountId, `${ACCOUNTS_BASE}/accounts?${q}`);
    out.push(...(data.accounts ?? []));
    pageToken = data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return out;
}

/** Locations in one Business Profile account. */
export async function listLocations(googleAccountId: string, accountName: string): Promise<BusinessLocation[]> {
  const out: BusinessLocation[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ pageSize: '100', readMask: 'name,title,storefrontAddress,websiteUri,metadata', ...(pageToken ? { pageToken } : {}) });
    const data = await call<{ locations?: BusinessLocation[]; nextPageToken?: string }>(googleAccountId, `${INFO_BASE}/${accountName}/locations?${q}`);
    out.push(...(data.locations ?? []));
    pageToken = data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return out;
}

export interface ReviewPage { reviews: GoogleReview[]; averageRating: number | null; totalReviewCount: number | null; nextPageToken: string | null }

/** One page of reviews, newest change first. `parent` is "accounts/1/locations/2". */
export async function listReviewsPage(googleAccountId: string, parent: string, pageToken?: string): Promise<ReviewPage> {
  const q = new URLSearchParams({ pageSize: String(REVIEW_PAGE_SIZE), orderBy: 'updateTime desc', ...(pageToken ? { pageToken } : {}) });
  const data = await call<{ reviews?: GoogleReview[]; averageRating?: number; totalReviewCount?: number; nextPageToken?: string }>(googleAccountId, `${REVIEWS_BASE}/${parent}/reviews?${q}`);
  return {
    reviews: data.reviews ?? [],
    averageRating: typeof data.averageRating === 'number' ? data.averageRating : null,
    totalReviewCount: typeof data.totalReviewCount === 'number' ? data.totalReviewCount : null,
    nextPageToken: data.nextPageToken || null,
  };
}

export async function getReview(googleAccountId: string, reviewName: string): Promise<GoogleReview> {
  return call<GoogleReview>(googleAccountId, `${REVIEWS_BASE}/${reviewName}`);
}

/** Create or replace the owner's reply. Google moderates replies; the returned state starts as PENDING. */
export async function putReply(googleAccountId: string, reviewName: string, comment: string): Promise<{ comment?: string; updateTime?: string; reviewReplyState?: string }> {
  if (Buffer.byteLength(comment, 'utf8') > MAX_REPLY_BYTES) throw new ReviewsApiError(`Replies can be at most ${MAX_REPLY_BYTES} bytes.`, 'INVALID_REQUEST');
  return call(googleAccountId, `${REVIEWS_BASE}/${reviewName}/reply`, { method: 'PUT', body: { comment } });
}

export async function deleteReply(googleAccountId: string, reviewName: string): Promise<void> {
  await call(googleAccountId, `${REVIEWS_BASE}/${reviewName}/reply`, { method: 'DELETE' });
}

// ── Performance (calls, website clicks, directions, impressions) ─────────────

export const PERFORMANCE_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'CALL_CLICKS', 'WEBSITE_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'BUSINESS_CONVERSATIONS', 'BUSINESS_BOOKINGS',
] as const;
export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number];

const ymd = (d: Date) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
const pad = (n: number) => String(n).padStart(2, '0');

/** Daily values per metric for a location ("locations/123"), inclusive of both dates. */
export async function fetchDailyMetrics(googleAccountId: string, locationName: string, start: Date, end: Date): Promise<Record<string, Array<{ date: string; value: number }>>> {
  const q = new URLSearchParams();
  for (const metric of PERFORMANCE_METRICS) q.append('dailyMetrics', metric);
  const s = ymd(start); const e = ymd(end);
  q.set('dailyRange.start_date.year', String(s.year)); q.set('dailyRange.start_date.month', String(s.month)); q.set('dailyRange.start_date.day', String(s.day));
  q.set('dailyRange.end_date.year', String(e.year)); q.set('dailyRange.end_date.month', String(e.month)); q.set('dailyRange.end_date.day', String(e.day));
  type Series = { dailyMetric?: string; timeSeries?: { datedValues?: Array<{ date?: { year?: number; month?: number; day?: number }; value?: string }> } };
  const data = await call<{ multiDailyMetricTimeSeries?: Array<{ dailyMetricTimeSeries?: Series[] }> }>(googleAccountId, `${PERFORMANCE_BASE}/${locationName}:fetchMultiDailyMetricsTimeSeries?${q}`);
  const out: Record<string, Array<{ date: string; value: number }>> = {};
  for (const group of data.multiDailyMetricTimeSeries ?? []) {
    for (const series of group.dailyMetricTimeSeries ?? []) {
      if (!series.dailyMetric) continue;
      out[series.dailyMetric] = (series.timeSeries?.datedValues ?? [])
        .filter(v => v.date?.year && v.date.month && v.date.day)
        .map(v => ({ date: `${v.date!.year}-${pad(v.date!.month!)}-${pad(v.date!.day!)}`, value: Number(v.value ?? 0) || 0 }));
    }
  }
  return out;
}

/** Search terms that showed the profile, by month. Google reports small counts only as "under N". */
export async function fetchSearchKeywords(googleAccountId: string, locationName: string, startMonth: { year: number; month: number }, endMonth: { year: number; month: number }): Promise<Array<{ keyword: string; impressions: number; below_threshold: boolean }>> {
  const out: Array<{ keyword: string; impressions: number; below_threshold: boolean }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const q = new URLSearchParams({
      'monthlyRange.start_month.year': String(startMonth.year), 'monthlyRange.start_month.month': String(startMonth.month),
      'monthlyRange.end_month.year': String(endMonth.year), 'monthlyRange.end_month.month': String(endMonth.month),
      pageSize: '100', ...(pageToken ? { pageToken } : {}),
    });
    const data = await call<{ searchKeywordsCounts?: Array<{ searchKeyword?: string; insightsValue?: { value?: string; threshold?: string } }>; nextPageToken?: string }>(
      googleAccountId, `${PERFORMANCE_BASE}/${locationName}/searchkeywords/impressions/monthly?${q}`);
    for (const row of data.searchKeywordsCounts ?? []) {
      if (!row.searchKeyword) continue;
      const exact = row.insightsValue?.value !== undefined;
      out.push({ keyword: row.searchKeyword, impressions: Number(exact ? row.insightsValue!.value : row.insightsValue?.threshold ?? 0) || 0, below_threshold: !exact });
    }
    pageToken = data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return out;
}
