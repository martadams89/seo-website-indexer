/**
 * bing.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Bing Webmaster Tools — Content (URL) Submission API.
 *
 * This is a DIRECT channel to Bing, complementary to IndexNow. IndexNow already
 * notifies Bing (and Yandex/Yahoo/Seznam) via the shared gateway, but the Bing
 * Webmaster API additionally:
 *   • reports your remaining daily/monthly submission quota, and
 *   • submits straight into your verified Bing Webmaster property.
 *
 * Setup (one-time):
 *   1. Verify each site in https://www.bing.com/webmasters (or import from GSC).
 *   2. Settings → API access → generate an API key.
 *   3. Paste that key into this tool's Settings (stored as `bing_api_key`).
 *      One key works for every site verified under that Bing account.
 *
 * Docs: https://learn.microsoft.com/bingwebmaster/getting-access
 *       https://learn.microsoft.com/dotnet/api/microsoft.bing.webmaster.api.interfaces
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BING_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';

// SubmitUrlBatch accepts up to 500 URLs per call.
export const BING_MAX_BATCH = 500;

export interface BingSubmitResult {
  siteUrl: string;
  urlCount: number;
  success: boolean;
  statusCode: number;
  message?: string;
  /** True when the failure is a quota error (HTTP 429 / quota ErrorCode). */
  quotaExceeded?: boolean;
}

export interface BingQuota {
  dailyQuota: number;
  monthlyQuota: number;
}

/**
 * Derives the Bing-verified site URL from a GSC property + domain.
 * Bing properties are always URL-prefix style (e.g. "https://example.com").
 * - URL-prefix GSC property  → reuse its origin.
 * - "sc-domain:" GSC property → fall back to https://{domain}.
 */
export function deriveBingSiteUrl(gscUrl: string | null | undefined, domain: string): string {
  if (gscUrl && /^https?:\/\//i.test(gscUrl)) {
    try { return new URL(gscUrl).origin; } catch { /* fall through */ }
  }
  let host = domain;
  if (host.includes('://')) host = host.split('://')[1];
  if (host.includes('/')) host = host.split('/')[0];
  return `https://${host}`;
}

/** Fetches the remaining URL-submission quota for a Bing-verified site. */
export async function getBingQuota(apiKey: string, siteUrl: string): Promise<BingQuota | null> {
  const url = `${BING_BASE}/GetUrlSubmissionQuota?apikey=${encodeURIComponent(apiKey)}&siteUrl=${encodeURIComponent(siteUrl)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const body = await res.json() as { d?: { DailyQuota?: number; MonthlyQuota?: number } };
    if (!body?.d) return null;
    return { dailyQuota: body.d.DailyQuota ?? 0, monthlyQuota: body.d.MonthlyQuota ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Submits a batch of URLs (≤ BING_MAX_BATCH) to Bing for a verified site.
 * Bing returns HTTP 200 with `{ "d": null }` on success.
 */
export async function submitUrlBatchToBing(apiKey: string, siteUrl: string, urls: string[]): Promise<BingSubmitResult> {
  if (urls.length === 0) {
    return { siteUrl, urlCount: 0, success: true, statusCode: 200, message: 'No URLs to submit.' };
  }
  const batch = urls.slice(0, BING_MAX_BATCH);
  const endpoint = `${BING_BASE}/SubmitUrlBatch?apikey=${encodeURIComponent(apiKey)}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ siteUrl, urlList: batch }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { siteUrl, urlCount: batch.length, success: false, statusCode: 0, message: `Network error: ${String(e)}` };
  }

  if (res.status === 200) {
    return { siteUrl, urlCount: batch.length, success: true, statusCode: 200 };
  }

  // Bing returns a JSON envelope with Message + ErrorCode on failure.
  let message = `HTTP ${res.status}`;
  let quotaExceeded = res.status === 429;
  try {
    const body = await res.json() as { Message?: string; ErrorCode?: number };
    if (body?.Message) message = body.Message;
    // ErrorCode 3 == quota exceeded in the Bing Webmaster API.
    if (body?.ErrorCode === 3 || /quota/i.test(body?.Message ?? '')) quotaExceeded = true;
  } catch {
    try { message = (await res.text()) || message; } catch { /* ignore */ }
  }

  return { siteUrl, urlCount: batch.length, success: false, statusCode: res.status, message, quotaExceeded };
}

/** Submits URLs to Bing in batches of BING_MAX_BATCH, stopping on quota errors. */
export async function submitToBingInBatches(apiKey: string, siteUrl: string, urls: string[]): Promise<BingSubmitResult[]> {
  const results: BingSubmitResult[] = [];
  for (let i = 0; i < urls.length; i += BING_MAX_BATCH) {
    const batch = urls.slice(i, i + BING_MAX_BATCH);
    const result = await submitUrlBatchToBing(apiKey, siteUrl, batch);
    results.push(result);
    if (!result.success && result.quotaExceeded) break;
    if (i + BING_MAX_BATCH < urls.length) await new Promise(r => setTimeout(r, 500));
  }
  return results;
}
