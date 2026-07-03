/**
 * Bing Webmaster Tools API — the second, independent submission surface
 * alongside IndexNow. Uses the account-level API key (Settings → API access
 * in Bing Webmaster Tools). Quota is adaptive per site (commonly ~100/day).
 */
import { getSetting } from '../db/database.js';

const BASE = 'https://ssl.bing.com/webmaster/api.svc/json';

function apiKey(): string | null {
  return getSetting('bing_api_key');
}

export function bingConfigured(): boolean {
  return !!apiKey();
}

async function call<T>(method: string, params: Record<string, string>, body?: unknown): Promise<T> {
  const key = apiKey();
  if (!key) throw new Error('Bing Webmaster API key not configured');
  const qs = new URLSearchParams({ apikey: key, ...params }).toString();
  const res = await fetch(`${BASE}/${method}?${qs}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bing API ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Bing API ${method}: non-JSON response`);
  }
}

export interface BingQuota {
  DailyQuota: number;
  MonthlyQuota: number;
}

export async function getUrlSubmissionQuota(siteUrl: string): Promise<BingQuota> {
  const r = await call<{ d: BingQuota }>('GetUrlSubmissionQuota', { siteUrl });
  return r.d;
}

/** Submit up to 500 URLs in one call. Returns the number accepted. */
export async function submitUrlBatch(siteUrl: string, urls: string[]): Promise<number> {
  if (urls.length === 0) return 0;
  const batch = urls.slice(0, 500);
  await call('SubmitUrlBatch', {}, { siteUrl, urlList: batch });
  return batch.length;
}
