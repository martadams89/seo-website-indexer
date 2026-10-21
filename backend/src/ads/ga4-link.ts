/**
 * ads/ga4-link.ts — GA4 alongside Google Ads.
 *
 * Each Ads client can link one GA4 property. Only the property ID is stored;
 * the Google login that reads it is resolved per request (the Ads login first,
 * then other logins shared with the client's workspace), so disconnecting and
 * reconnecting a login never orphans the link.
 */
import {
  analyticsLogins, cleanPropertyId, Ga4Error, ga4PropertyName, runGa4Report, withPropertyAccess,
  type Ga4ReportResult,
} from '../analytics/ga4.js';
import { setAdsGa4Property, type AdsAccount } from './store.js';

/** Logins that may read GA4 for this Ads client, its own Ads login first. */
export function ga4LoginsFor(account: AdsAccount) {
  return analyticsLogins([account.workspace_id], account.google_account_id);
}

/**
 * Link (or with null/empty, unlink) a GA4 property. Linking proves access by
 * running a one-row report, so a typo or a login without Viewer access fails
 * here rather than in the next daily run.
 */
export async function linkGa4Property(account: AdsAccount, raw: string | null | undefined): Promise<{ account: AdsAccount; google_login: string | null }> {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { account: setAdsGa4Property(account.id, null)!, google_login: null };
  }
  const propertyId = cleanPropertyId(raw);
  const { login } = await withPropertyAccess(ga4LoginsFor(account), l =>
    runGa4Report(l, propertyId, { metrics: ['sessions'], startDate: 'yesterday', endDate: 'yesterday', limit: 1 }));
  const name = await ga4PropertyName(login, propertyId);
  return { account: setAdsGa4Property(account.id, propertyId, name)!, google_login: login.email ?? login.id };
}

const PAID_GOOGLE = [{ dimension: 'sessionSourceMedium', value: 'google / cpc' }];
const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;
const change = (before: number | undefined, after: number | undefined) =>
  before && after !== undefined ? round(((after - before) / before) * 100) : null;

/**
 * What GA4 saw from this client's Google Ads traffic (source / medium
 * "google / cpc") over the last `days` days versus the period before: totals,
 * by campaign, top landing pages, and the overall channel mix for context.
 */
export async function ga4AdsPerformance(account: AdsAccount, days = 28) {
  if (!account.ga4_property_id) {
    throw new Ga4Error(`No GA4 property is linked to ${account.name ?? account.customer_id}.`, 'NOT_FOUND',
      'Link one on the Google Ads page (edit the client → GA4 property) or with ads_link_ga4_property.');
  }
  const span = Math.min(Math.max(1, Math.floor(days)), 365);
  const current = { startDate: `${span}daysAgo`, endDate: 'yesterday' };
  const previous = { startDate: `${span * 2}daysAgo`, endDate: `${span + 1}daysAgo` };
  const propertyId = account.ga4_property_id;
  const totalsMetrics = ['sessions', 'engagedSessions', 'keyEvents', 'totalRevenue'];

  const { result, login } = await withPropertyAccess(ga4LoginsFor(account), l => Promise.all([
    runGa4Report(l, propertyId, { ...current, dimensions: ['sessionCampaignName'], metrics: ['sessions', 'engagedSessions', 'engagementRate', 'keyEvents', 'totalRevenue'], filters: PAID_GOOGLE, limit: 50 }),
    runGa4Report(l, propertyId, { ...previous, metrics: totalsMetrics, filters: PAID_GOOGLE, limit: 1 }),
    runGa4Report(l, propertyId, { ...current, dimensions: ['landingPagePlusQueryString'], metrics: ['sessions', 'engagementRate', 'keyEvents'], filters: PAID_GOOGLE, limit: 15 }),
    runGa4Report(l, propertyId, { ...current, dimensions: ['sessionDefaultChannelGroup'], metrics: ['sessions', 'keyEvents', 'totalRevenue'], limit: 20 }),
  ]));
  const [byCampaign, before, landing, channels] = result as [Ga4ReportResult, Ga4ReportResult, Ga4ReportResult, Ga4ReportResult];
  const now: Record<string, number> = byCampaign.totals ?? {};
  const prev: Record<string, number> = before.totals ?? (before.rows[0] as Record<string, number> | undefined) ?? {};

  return {
    property_id: propertyId,
    property_name: account.ga4_property_name,
    google_login: login.email ?? login.id,
    days: span,
    currency: byCampaign.currency,
    paid_search_google: {
      totals: Object.fromEntries(totalsMetrics.map(m => [m, now[m] ?? 0])),
      previous_period_totals: Object.fromEntries(totalsMetrics.map(m => [m, prev[m] ?? 0])),
      change_pct: Object.fromEntries(totalsMetrics.map(m => [m, change(prev[m], now[m])])),
      by_campaign: byCampaign.rows,
      top_landing_pages: landing.rows,
    },
    all_channels: channels.rows,
    note: 'Paid search here is GA4 sessions with source / medium "google / cpc". GA4 key events will not match Google Ads conversions exactly (different attribution, counting and conversion windows, plus imported or offline conversions). Compare trends and large gaps, not exact numbers. A Google Ads campaign with clicks but no GA4 sessions usually means auto-tagging or tracking is broken.',
  };
}
