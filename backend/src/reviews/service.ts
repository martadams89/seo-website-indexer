/**
 * reviews/service.ts — Google reviews workflows: setup checks, finding and
 * linking Business Profile locations, syncing reviews (with alerts for new
 * negative reviews and rejected replies), and publishing replies through the
 * reply rules.
 */
import {
  CLOUD_PLATFORM_SCOPE, enableRequiredApis, getAccessTokenForAccount, GOOGLE_BUSINESS_SERVICES, hasBuiltinCredentials,
} from '../auth/google-oauth.js';
import { getGoogleAccountsForWorkspace, getSitesForWorkspace, type GoogleAccount } from '../db/database.js';
import { notificationEventEnabled, sendWorkspaceNotification } from '../utils/notify.js';
import type { User } from '../auth/users.js';
import {
  ACCESS_FORM_URL, BUSINESS_SCOPE, deleteReply, fetchDailyMetrics, fetchSearchKeywords, listBusinessAccounts, listLocations as listGoogleLocations,
  listReviewsPage, MAX_REPLY_BYTES, projectFromClientId, putReply, ReviewsApiError, STAR_VALUE, type BusinessLocation, type GoogleReview,
} from './client.js';
import { evaluateReply, type ReplyFinding } from './rules.js';
import {
  findLocation, findReviewByName, getLocation, getReplyPlan, getReview, insertLocation, insertReplyPlan, latestReviewUpdate, listAllEnabledLocations,
  listLocations, setReviewReply, supersedeOpenPlans, transitionReplyPlan, updateLocation, upsertReview,
  type ReplyPlan, type ReviewLocation, type StoredReview,
} from './store.js';

const SYNC_MINUTES = Math.max(15, Number(process.env.REVIEWS_SYNC_MINUTES) || 60);
const FULL_SYNC_HOURS = 24;

const hasBusinessScope = (a: GoogleAccount) => (a.granted_scopes ?? '').split(' ').includes(BUSINESS_SCOPE);

export function businessConnections(workspaceId: string): GoogleAccount[] {
  return getGoogleAccountsForWorkspace(workspaceId).filter(hasBusinessScope);
}

function errorParts(e: unknown): { message: string; kind: string; hint: string | null } {
  const err = e as ReviewsApiError;
  return { message: err instanceof Error ? err.message : String(e), kind: err?.kind ?? 'UNKNOWN', hint: err?.hint ?? null };
}

// ── Setup ────────────────────────────────────────────────────────────────────

export function consoleLinks(project: string | null) {
  const q = project ? `?project=${project}` : '';
  return {
    access_form: ACCESS_FORM_URL,
    quotas: `https://console.cloud.google.com/apis/api/mybusinessaccountmanagement.googleapis.com/quotas${q}`,
    enable_apis: `https://console.cloud.google.com/apis/library/mybusinessaccountmanagement.googleapis.com${q}`,
    business_profile: 'https://business.google.com/locations',
  };
}

type ApiState = 'ok' | 'api_disabled' | 'not_approved' | 'no_scope' | 'needs_reauth' | 'error' | 'unchecked';
interface ConnectionStatus {
  id: string; email: string | null; project: string | null; has_business_scope: boolean; has_cloud_scope: boolean; needs_reauth: boolean;
  api: ApiState; accounts: number | null; message: string | null; hint: string | null;
}

const probeCache = new Map<string, { at: number; value: ConnectionStatus }>();
const PROBE_TTL_MS = 2 * 60_000;

async function probe(account: GoogleAccount, fresh: boolean): Promise<ConnectionStatus> {
  const hit = probeCache.get(account.id);
  if (!fresh && hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;
  const scopes = (account.granted_scopes ?? '').split(' ');
  const status: ConnectionStatus = {
    id: account.id, email: account.email, project: projectFromClientId(account.client_id),
    has_business_scope: scopes.includes(BUSINESS_SCOPE), has_cloud_scope: scopes.includes(CLOUD_PLATFORM_SCOPE),
    needs_reauth: !!account.needs_reauth, api: 'unchecked', accounts: null, message: null, hint: null,
  };
  if (status.needs_reauth) status.api = 'needs_reauth';
  else if (!status.has_business_scope) status.api = 'no_scope';
  else {
    try {
      status.accounts = (await listBusinessAccounts(account.id)).length;
      status.api = 'ok';
    } catch (e) {
      const { message, kind, hint } = errorParts(e);
      status.message = message; status.hint = hint;
      status.api = kind === 'API_DISABLED' ? 'api_disabled' : kind === 'NOT_APPROVED' ? 'not_approved' : kind === 'NO_SCOPE' ? 'no_scope' : kind === 'NEEDS_REAUTH' ? 'needs_reauth' : 'error';
    }
  }
  probeCache.set(account.id, { at: Date.now(), value: status });
  return status;
}

export async function setupStatus(workspaceId: string, opts: { fresh?: boolean } = {}) {
  const accounts = getGoogleAccountsForWorkspace(workspaceId);
  const connections = await Promise.all(accounts.map(a => probe(a, !!opts.fresh)));
  const linked = listLocations(workspaceId);
  const project = connections.find(c => c.has_business_scope)?.project ?? connections[0]?.project ?? null;
  return {
    builtin_oauth_client: hasBuiltinCredentials(),
    project,
    links: consoleLinks(project),
    connections,
    linked_locations: linked.length,
    steps: {
      google_connected: accounts.length > 0,
      business_scope: connections.some(c => c.has_business_scope),
      api_enabled: connections.some(c => c.api === 'ok' || c.api === 'not_approved'),
      access_approved: connections.some(c => c.api === 'ok'),
      locations_linked: linked.length > 0,
    },
    ready: connections.some(c => c.api === 'ok') && linked.length > 0,
  };
}

/** Enable the Business Profile APIs on the OAuth client's project (needs a connection with Cloud access). */
export async function enableBusinessApis(account: GoogleAccount): Promise<{ ok: boolean; project: string | null; message: string }> {
  const project = projectFromClientId(account.client_id);
  if (!(account.granted_scopes ?? '').split(' ').includes(CLOUD_PLATFORM_SCOPE)) {
    return { ok: false, project, message: 'This connection did not grant Google Cloud access. Reconnect it with "Auto-configure Google APIs" ticked, or enable the APIs in the Cloud console.' };
  }
  const token = await getAccessTokenForAccount(account.id);
  const { enabled } = await enableRequiredApis(token, account.client_id, account.email ?? account.id, GOOGLE_BUSINESS_SERVICES);
  probeCache.delete(account.id);
  return enabled.length === GOOGLE_BUSINESS_SERVICES.length
    ? { ok: true, project, message: `Business Profile APIs enabled on project ${project}. Google still has to approve the project for access before reviews can be read.` }
    : { ok: false, project, message: `Couldn't enable every Business Profile API on project ${project}. Your Google user needs the Service Usage Admin (or Owner/Editor) role on that project.` };
}

// ── Discovery and linking ────────────────────────────────────────────────────

function formatAddress(loc: BusinessLocation): string | null {
  const a = loc.storefrontAddress;
  if (!a) return null;
  return [...(a.addressLines ?? []), a.locality, a.administrativeArea, a.postalCode].filter(Boolean).join(', ') || null;
}

function hostOf(url: string | null | undefined): string | null {
  try { return url ? new URL(url).hostname.replace(/^www\./, '').toLowerCase() : null; } catch { return null; }
}

/** The site in this workspace whose domain matches the location's website, if any. */
export function matchingSite(workspaceId: string, website: string | null): string | null {
  const host = hostOf(website);
  if (!host) return null;
  const site = getSitesForWorkspace(workspaceId).find(s => {
    const domain = String(s.domain ?? '').replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
    return domain === host || host.endsWith(`.${domain}`);
  });
  return site?.id ?? null;
}

export async function discoverLocations(workspaceId: string, googleAccountId?: string) {
  const connections = businessConnections(workspaceId).filter(c => !googleAccountId || c.id === googleAccountId);
  if (!connections.length) {
    throw new ReviewsApiError('No Google connection in this workspace has Business Profile access yet.', 'NO_SCOPE', { hint: 'Use "Add Business Profile access" on the Reviews page, or connect a Google account with Business Profile ticked.' });
  }
  const linked = listLocations(workspaceId);
  const results = [];
  for (const conn of connections) {
    try {
      const accounts = await listBusinessAccounts(conn.id);
      const groups = [];
      for (const acc of accounts.slice(0, 50)) {
        try {
          const locations = await listGoogleLocations(conn.id, acc.name);
          groups.push({
            account_name: acc.name, account_title: acc.accountName ?? acc.name, type: acc.type ?? null, error: null as string | null,
            locations: locations.map(l => ({
              location_name: l.name, title: l.title ?? null, address: formatAddress(l), website: l.websiteUri ?? null,
              place_id: l.metadata?.placeId ?? null, maps_uri: l.metadata?.mapsUri ?? null,
              verified: l.metadata?.hasVoiceOfMerchant ?? null,
              linked_location_id: linked.find(x => x.location_name === l.name)?.id ?? null,
            })),
          });
        } catch (e) {
          groups.push({ account_name: acc.name, account_title: acc.accountName ?? acc.name, type: acc.type ?? null, error: errorParts(e).message, locations: [] });
        }
      }
      results.push({ google_account_id: conn.id, email: conn.email, accounts: groups, error: null as string | null, kind: null as string | null, hint: null as string | null });
    } catch (e) {
      const { message, kind, hint } = errorParts(e);
      results.push({ google_account_id: conn.id, email: conn.email, accounts: [], error: message, kind, hint });
    }
  }
  return { connections: results };
}

/** Link a Business Profile location to a workspace after confirming the Google user can read its reviews. */
export async function linkLocation(input: { workspaceId: string; googleAccountId: string; accountName: string; locationName: string; userId: string | null; siteId?: string | null }): Promise<ReviewLocation> {
  const conn = businessConnections(input.workspaceId).find(c => c.id === input.googleAccountId);
  if (!conn) throw new ReviewsApiError('That Google connection is not shared with this workspace or has no Business Profile access.', 'NO_SCOPE');
  const accountName = String(input.accountName).trim();
  const locationName = String(input.locationName).trim().replace(/^accounts\/[^/]+\//, '');
  if (!/^accounts\/[^/]+$/.test(accountName) || !/^locations\/[^/]+$/.test(locationName)) {
    throw new ReviewsApiError('Pass the Business Profile account ("accounts/…") and location ("locations/…") from the discovery list.', 'INVALID_REQUEST');
  }
  const existing = findLocation(input.workspaceId, locationName);
  if (existing) return existing;
  const meta = (await listGoogleLocations(conn.id, accountName)).find(l => l.name === locationName);
  if (!meta) throw new ReviewsApiError(`Location ${locationName} was not found in ${accountName} for ${conn.email ?? conn.id}.`, 'NOT_FOUND');
  // Reading the first page proves the reviews API works for this location before it is linked.
  await listReviewsPage(conn.id, `${accountName}/${locationName}`);
  const location = insertLocation({
    workspace_id: input.workspaceId, google_account_id: conn.id, account_name: accountName, location_name: locationName,
    title: meta.title ?? null, address: formatAddress(meta), website: meta.websiteUri ?? null, place_id: meta.metadata?.placeId ?? null,
    maps_uri: meta.metadata?.mapsUri ?? null, new_review_uri: meta.metadata?.newReviewUri ?? null,
    site_id: input.siteId ?? matchingSite(input.workspaceId, meta.websiteUri ?? null), created_by: input.userId,
  });
  await syncLocation(location, { full: true }).catch(() => null);
  return getLocation(location.id)!;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

function toUpsert(location: ReviewLocation, r: GoogleReview) {
  return {
    location_id: location.id, workspace_id: location.workspace_id, review_name: r.name,
    reviewer_name: r.reviewer?.isAnonymous ? null : r.reviewer?.displayName ?? null,
    reviewer_photo: r.reviewer?.isAnonymous ? null : r.reviewer?.profilePhotoUrl ?? null,
    anonymous: !!r.reviewer?.isAnonymous,
    rating: STAR_VALUE[r.starRating ?? ''] ?? 0,
    comment: r.comment ?? null,
    create_time: r.createTime ?? null,
    update_time: r.updateTime ?? null,
    reply_comment: r.reviewReply?.comment ?? null,
    reply_update_time: r.reviewReply?.updateTime ?? null,
    reply_state: r.reviewReply ? r.reviewReply.reviewReplyState ?? 'APPROVED' : null,
    reply_policy_violation: r.reviewReply?.policyViolation ?? null,
    reply_url: r.reviewReplyUrl ?? null,
    media: (r.reviewMediaItems ?? []).slice(0, 10),
  };
}

const excerpt = (text: string | null, n = 160) => !text ? '(no text)' : text.length > n ? `${text.slice(0, n - 1)}…` : text;
const stars = (n: number) => n ? `${'★'.repeat(n)}${'☆'.repeat(5 - n)}` : 'no rating';

async function alert(location: ReviewLocation, fresh: StoredReview[], rejected: StoredReview[]): Promise<void> {
  if (!fresh.length && !rejected.length) return;
  if (!notificationEventEnabled(location.workspace_id, 'review_alerts')) return;
  const name = location.title ?? location.location_name;
  const origin = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : null;
  const MAX_LINES = 8;
  const lines = [
    ...fresh.slice(0, MAX_LINES).map(r => `${stars(r.rating)} ${r.reviewer_name ?? 'Anonymous'}: "${excerpt(r.comment)}"`),
    ...(fresh.length > MAX_LINES ? [`…and ${fresh.length - MAX_LINES} more.`] : []),
    ...rejected.map(r => `Google rejected the reply to ${r.reviewer_name ?? 'Anonymous'}'s review${r.reply_policy_violation ? ` (${r.reply_policy_violation.toLowerCase().replace(/_/g, ' ')})` : ''}.`),
  ];
  const title = fresh.length
    ? `${fresh.length} new review${fresh.length === 1 ? '' : 's'} need${fresh.length === 1 ? 's' : ''} attention — ${name}`
    : `Review reply rejected — ${name}`;
  const body = `${lines.join('\n')}${origin ? `\n\nReply: ${origin}/reviews?location=${location.id}` : ''}`;
  await sendWorkspaceNotification(location.workspace_id, title, body, 'review_alerts').catch(() => false);
}

/**
 * Pull reviews from Google. Incremental syncs stop at reviews that haven't
 * changed since the last one; a full sync (daily) walks every page, because
 * Google's later pages occasionally miss reviews.
 */
export async function syncLocation(location: ReviewLocation, opts: { full?: boolean } = {}): Promise<{ fetched: number; created: number; alerts: number }> {
  if (!location.google_account_id) throw new ReviewsApiError('This location has no Google connection. Link it again from the Reviews page.', 'NEEDS_REAUTH');
  const full = !!opts.full || !location.last_full_sync_at || Date.now() - Date.parse(location.last_full_sync_at) > FULL_SYNC_HOURS * 3_600_000;
  const latest = latestReviewUpdate(location.id);
  const known = latest !== null;
  const latestKnown = Date.parse(latest ?? '') || 0;
  const parent = `${location.account_name}/${location.location_name}`;
  const fresh: StoredReview[] = [];
  const rejected: StoredReview[] = [];
  let fetched = 0;
  let created = 0;
  let pageToken: string | undefined;
  let summary: { averageRating: number | null; totalReviewCount: number | null } = { averageRating: null, totalReviewCount: null };
  try {
    for (let page = 0; page < (full ? 100 : 10); page++) {
      const res = await listReviewsPage(location.google_account_id, parent, pageToken);
      if (page === 0) summary = res;
      let changed = false;
      for (const r of res.reviews) {
        fetched++;
        const previousState = known ? findReviewByName(location.id, r.name)?.reply_state ?? null : null;
        const { review, created: isNew } = upsertReview(toUpsert(location, r));
        if (isNew) created++;
        if ((Date.parse(r.updateTime ?? '') || 0) > latestKnown) changed = true;
        // Alerts only for reviews that arrive after the first sync of this location.
        if (isNew && location.last_synced_at && review.rating > 0 && review.rating <= location.rules.alert_max_rating) fresh.push(review);
        if (review.reply_state === 'REJECTED' && previousState !== 'REJECTED' && location.last_synced_at) rejected.push(review);
      }
      pageToken = res.nextPageToken ?? undefined;
      if (!pageToken || (!full && known && !changed)) break;
    }
    updateLocation(location.id, {
      average_rating: summary.averageRating, total_reviews: summary.totalReviewCount,
      last_synced_at: new Date().toISOString(), ...(full ? { last_full_sync_at: new Date().toISOString() } : {}), last_error: null,
    });
  } catch (e) {
    updateLocation(location.id, { last_error: errorParts(e).message, last_synced_at: new Date().toISOString() });
    throw e;
  }
  await alert(location, fresh, rejected);
  return { fetched, created, alerts: fresh.length + rejected.length };
}

/** Called from the platform loop: sync locations that haven't been synced recently. */
export async function syncDueLocations(limit = 20): Promise<number> {
  const cutoff = Date.now() - SYNC_MINUTES * 60_000;
  const due = listAllEnabledLocations()
    .filter(l => !l.last_synced_at || Date.parse(l.last_synced_at) < cutoff)
    .sort((a, b) => (Date.parse(a.last_synced_at ?? '') || 0) - (Date.parse(b.last_synced_at ?? '') || 0))
    .slice(0, limit);
  let synced = 0;
  for (const location of due) {
    try { await syncLocation(location); synced++; } catch { /* last_error recorded on the location */ }
  }
  return synced;
}

// ── Replies ──────────────────────────────────────────────────────────────────

async function publishPlan(plan: ReplyPlan, location: ReviewLocation, review: StoredReview): Promise<ReplyPlan> {
  try {
    if (!location.google_account_id) throw new ReviewsApiError('This location has no Google connection. Link it again from the Reviews page.', 'NEEDS_REAUTH');
    if (plan.action === 'delete') {
      await deleteReply(location.google_account_id, review.review_name);
      setReviewReply(review.id, { comment: null, update_time: null, state: null });
    } else {
      const reply = await putReply(location.google_account_id, review.review_name, plan.text ?? '');
      setReviewReply(review.id, { comment: reply.comment ?? plan.text, update_time: reply.updateTime ?? new Date().toISOString(), state: reply.reviewReplyState ?? 'PENDING' });
    }
    transitionReplyPlan(plan.id, ['publishing'], 'published', { published: true, error: null });
    supersedeOpenPlans(review.id, plan.id);
  } catch (e) {
    const { message, hint } = errorParts(e);
    transitionReplyPlan(plan.id, ['publishing'], 'failed', { error: hint ? `${message} — ${hint}` : message });
  }
  return getReplyPlan(plan.id)!;
}

/**
 * Reply to a review (or delete its reply). A person on the dashboard publishes
 * straight away; an AI assistant's reply goes through the location's rules and
 * either publishes, waits for approval, or is blocked. `publish: false` always
 * leaves the reply as a draft for approval.
 */
export async function submitReply(input: {
  location: ReviewLocation; review: StoredReview; text?: string | null; action?: 'reply' | 'delete'; rationale?: string | null;
  user: User; source: 'dashboard' | 'mcp'; publish?: boolean;
}): Promise<ReplyPlan> {
  const action = input.action ?? 'reply';
  const text = action === 'delete' ? null : String(input.text ?? '').trim();
  let decision: 'publish' | 'needs_approval' | 'blocked' = 'publish';
  let findings: ReplyFinding[] = [];
  if (input.source === 'dashboard') {
    if (action === 'reply' && !text) throw new ReviewsApiError('Write a reply first.', 'INVALID_REQUEST');
    if (action === 'reply' && Buffer.byteLength(text ?? '', 'utf8') > MAX_REPLY_BYTES) throw new ReviewsApiError(`Google accepts replies of up to ${MAX_REPLY_BYTES} bytes.`, 'INVALID_REQUEST');
    if (action === 'delete' && !input.review.reply_comment) throw new ReviewsApiError('This review has no reply to delete.', 'INVALID_REQUEST');
  } else {
    ({ decision, findings } = evaluateReply({ rules: input.location.rules, rating: input.review.rating, text: text ?? '', existingReply: input.review.reply_comment, action }));
    if (decision === 'publish' && input.publish === false) {
      decision = 'needs_approval';
      findings = [...findings, { severity: 'approval', code: 'draft', message: 'Saved as a draft for approval, as requested.' }];
    }
  }
  const plan = insertReplyPlan({
    workspace_id: input.location.workspace_id, location_id: input.location.id, review_id: input.review.id, action, text,
    previous_reply: input.review.reply_comment, rationale: input.rationale?.trim().slice(0, 2000) || null, rating: input.review.rating,
    source: input.source, created_by: input.user.id, findings,
    status: decision === 'publish' ? 'publishing' : decision === 'blocked' ? 'blocked' : 'needs_approval',
  });
  if (decision === 'needs_approval') supersedeOpenPlans(input.review.id, plan.id);
  if (decision !== 'publish') return plan;
  return publishPlan(plan, input.location, input.review);
}

/** A person approves a waiting reply (optionally after editing it) and it is published. */
export async function approveReply(planId: string, opts: { user: User; text?: string | null }): Promise<ReplyPlan> {
  const plan = getReplyPlan(planId);
  if (!plan) throw new ReviewsApiError('Reply not found.', 'NOT_FOUND');
  const location = getLocation(plan.location_id);
  const review = getReview(plan.review_id);
  if (!location || !review) throw new ReviewsApiError('The review or location for this reply no longer exists.', 'NOT_FOUND');
  const text = plan.action === 'delete' ? null : String(opts.text ?? plan.text ?? '').trim();
  if (plan.action === 'reply' && !text) throw new ReviewsApiError('The reply is empty.', 'INVALID_REQUEST');
  if (text && Buffer.byteLength(text, 'utf8') > MAX_REPLY_BYTES) throw new ReviewsApiError(`Google accepts replies of up to ${MAX_REPLY_BYTES} bytes.`, 'INVALID_REQUEST');
  if (!transitionReplyPlan(plan.id, ['needs_approval'], 'publishing', { text, decided_by: opts.user.id })) {
    throw new ReviewsApiError(`This reply is ${plan.status.replace('_', ' ')} and can no longer be approved.`, 'INVALID_REQUEST');
  }
  return publishPlan(getReplyPlan(plan.id)!, location, review);
}

export function rejectReply(planId: string, user: User): ReplyPlan {
  const plan = getReplyPlan(planId);
  if (!plan) throw new ReviewsApiError('Reply not found.', 'NOT_FOUND');
  if (!transitionReplyPlan(plan.id, ['needs_approval'], 'rejected', { decided_by: user.id })) {
    throw new ReviewsApiError(`This reply is ${plan.status.replace('_', ' ')} and can no longer be rejected.`, 'INVALID_REQUEST');
  }
  return getReplyPlan(plan.id)!;
}

// ── Business Profile performance ─────────────────────────────────────────────

const PERFORMANCE_TTL_MS = 6 * 3_600_000;
const performanceCache = new Map<string, { at: number; value: unknown }>();

const GROUPS: Record<string, string[]> = {
  search_impressions: ['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'],
  maps_impressions: ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS'],
  calls: ['CALL_CLICKS'],
  website_clicks: ['WEBSITE_CLICKS'],
  direction_requests: ['BUSINESS_DIRECTION_REQUESTS'],
  messages: ['BUSINESS_CONVERSATIONS'],
  bookings: ['BUSINESS_BOOKINGS'],
};

/**
 * How people interacted with the profile over the last `days` (ending two days
 * ago, since Google's figures lag), compared with the period before, plus the
 * search terms that showed it over the last three full months.
 */
export async function businessPerformance(location: ReviewLocation, days = 28, opts: { fresh?: boolean } = {}) {
  const span = Math.max(7, Math.min(270, Math.round(days)));
  const key = `${location.id}:${span}`;
  const hit = performanceCache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < PERFORMANCE_TTL_MS) return hit.value as Awaited<ReturnType<typeof computePerformance>>;
  const value = await computePerformance(location, span);
  performanceCache.set(key, { at: Date.now(), value });
  return value;
}

async function computePerformance(location: ReviewLocation, span: number) {
  if (!location.google_account_id) throw new ReviewsApiError('This location has no Google connection. Link it again from the Reviews page.', 'NEEDS_REAUTH');
  const DAY = 86_400_000;
  const end = new Date(Date.now() - 2 * DAY);
  const start = new Date(end.getTime() - (2 * span - 1) * DAY);
  const series = await fetchDailyMetrics(location.google_account_id, location.location_name, start, end);
  const boundary = new Date(end.getTime() - (span - 1) * DAY).toISOString().slice(0, 10);
  const sum = (metrics: string[], current: boolean) => metrics.reduce((total, metric) =>
    total + (series[metric] ?? []).filter(p => current ? p.date >= boundary : p.date < boundary).reduce((a, p) => a + p.value, 0), 0);
  const totals = Object.fromEntries(Object.entries(GROUPS).map(([name, metrics]) => {
    const current = sum(metrics, true);
    const previous = sum(metrics, false);
    return [name, { current, previous, change_pct: previous ? Math.round(((current - previous) / previous) * 1000) / 10 : null }];
  }));
  const dates = [...new Set(Object.values(series).flat().map(p => p.date))].filter(d => d >= boundary).sort();
  const at = (metrics: string[], date: string) => metrics.reduce((a, m) => a + (series[m]?.find(p => p.date === date)?.value ?? 0), 0);
  const daily = dates.map(date => ({
    date, impressions: at([...GROUPS.search_impressions, ...GROUPS.maps_impressions], date), calls: at(GROUPS.calls, date),
    website_clicks: at(GROUPS.website_clicks, date), direction_requests: at(GROUPS.direction_requests, date),
  }));
  const now = new Date();
  const endMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const startMonth = new Date(Date.UTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() - 2, 1));
  let keywords: Array<{ keyword: string; impressions: number; below_threshold: boolean }> = [];
  let keywordsError: string | null = null;
  try {
    keywords = (await fetchSearchKeywords(location.google_account_id, location.location_name,
      { year: startMonth.getUTCFullYear(), month: startMonth.getUTCMonth() + 1 }, { year: endMonth.getUTCFullYear(), month: endMonth.getUTCMonth() + 1 }))
      .sort((a, b) => b.impressions - a.impressions).slice(0, 50);
  } catch (e) { keywordsError = errorParts(e).message; }
  return {
    period: { start: boundary, end: end.toISOString().slice(0, 10), days: span },
    totals, daily,
    search_keywords: { months: `${startMonth.toISOString().slice(0, 7)} to ${endMonth.toISOString().slice(0, 7)}`, keywords, error: keywordsError },
  };
}
