/**
 * indexnow.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * IndexNow key management + URL batch submission.
 *
 * HOW INDEXNOW VERIFICATION WORKS (and why you get 403):
 * ──────────────────────────────────────────────────────
 * IndexNow uses a challenge-response model to prove you own the site:
 *
 *  1. Generate a random key (hex string, 8–128 chars).
 *  2. Create a plain-text file at:  https://{domain}/{key}.txt
 *     The file content must be exactly the key value (no newlines etc.).
 *  3. Now submit URLs. Bing/Yandex/etc. fetches the key file to verify
 *     ownership before accepting submissions.
 *
 * If the file doesn't exist or returns wrong content → 403 "UserForbiddedToAccessSite".
 * propertysurvey.pro works because its key file happened to be deployed;
 * the others fail because the file is missing from the live site.
 *
 * HOW THIS TOOL HANDLES IT:
 * ─────────────────────────
 * • We generate and store the key in SQLite (indexnow_keys table).
 * • The Fastify server exposes a route:  GET /:key.txt
 *   which serves the key file dynamically — so no manual file deployment needed.
 * • The UI shows a verification status badge and allows manual re-verification.
 * • Submissions are blocked until the key is confirmed reachable.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import crypto from 'crypto';
import {
  getIndexNowKey,
  upsertIndexNowKey,
  markIndexNowKeyVerified,
  getSiteById,
} from '../db/database.js';
import { logSystem } from '../utils/logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// IndexNow gateway (Bing routes to all participating engines: Yandex, Yahoo, etc.)
const INDEXNOW_API = 'https://api.indexnow.org/indexnow';

// Max URLs per batch request (IndexNow spec allows up to 10,000 but 500 is safe)
const MAX_BATCH = 500;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IndexNowSubmitResult {
  siteId: string;
  host: string;
  urlCount: number;
  success: boolean;
  statusCode: number;
  message?: string;
  /** Set when verification fails — key file not reachable */
  verificationRequired?: boolean;
}

export interface KeyVerificationResult {
  reachable: boolean;
  keyMatch: boolean;
  url: string;
  error?: string;
}

function getBaseUrl(siteId: string, domain: string): string {
  // If domain already has a protocol, use it
  if (domain.startsWith('http://') || domain.startsWith('https://')) {
    return domain;
  }
  
  // Otherwise, inspect the sitemap_url to see if we should use http or https
  const site = getSiteById(siteId);
  const protocol = (site && site.sitemap_url.startsWith('http://')) ? 'http' : 'https';
  return `${protocol}://${domain}`;
}

// ── Key Management ────────────────────────────────────────────────────────────

/**
 * Returns the IndexNow key for a site, generating one if it doesn't exist yet.
 * Key is a 32-char hex string stored in the database.
 */
export function getOrCreateIndexNowKey(siteId: string): string {
  const existing = getIndexNowKey(siteId);
  if (existing) return existing.key_value;

  // Generate a cryptographically secure 32-char hex key
  const key = crypto.randomBytes(16).toString('hex');
  upsertIndexNowKey(siteId, key, false);
  return key;
}

/**
 * Verifies that the key file is accessible at the expected URL.
 * Called before submitting to give a clear error if the route isn't live yet.
 *
 * The route is served automatically by server.ts — this just confirms the
 * container is accessible from the outside, or that the user has deployed it.
 */
export async function verifyIndexNowKey(siteId: string, domain: string): Promise<KeyVerificationResult> {
  const key = getOrCreateIndexNowKey(siteId);
  const baseUrl = getBaseUrl(siteId, domain);
  const url = `${baseUrl}/${key}.txt`;

  logSystem('info', `Starting IndexNow key verification for ${domain}. Fetching: ${url}`, siteId, url);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SEOWebsiteIndexer/1.0 (indexnow-verifier)' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const errMsg = `Key file returned HTTP ${res.status}. Make sure the container is publicly reachable at ${domain}.`;
      logSystem('error', `IndexNow verification failed for ${domain}: ${errMsg}`, siteId, url);
      return {
        reachable: false,
        keyMatch: false,
        url,
        error: errMsg,
      };
    }

    const body = (await res.text()).trim();
    const keyMatch = body === key;

    if (keyMatch) {
      markIndexNowKeyVerified(siteId);
      logSystem('ok', `IndexNow key file successfully verified for ${domain}!`, siteId, url);
    } else {
      const mismatchMsg = `Key file content mismatch. Expected "${key}", got "${body.slice(0, 64)}".`;
      logSystem('warn', `IndexNow verification mismatch for ${domain}: ${mismatchMsg}`, siteId, url);
    }

    return {
      reachable: true,
      keyMatch,
      url,
      error: keyMatch ? undefined : `Key file content mismatch. Expected "${key}", got "${body.slice(0, 64)}".`,
    };
  } catch (e) {
    const errMsg = `Cannot reach key file: ${String(e)}. The container must be accessible from the internet (or from Bing's crawlers) at ${baseUrl}.`;
    logSystem('error', `IndexNow verification network error for ${domain}: ${errMsg}`, siteId, url);
    return {
      reachable: false,
      keyMatch: false,
      url,
      error: errMsg,
    };
  }
}

// ── Submission ────────────────────────────────────────────────────────────────

/**
 * Submits up to MAX_BATCH URLs to IndexNow.
 * If there are more URLs, call this function multiple times.
 *
 * IMPORTANT: Do NOT submit more than 10,000 URLs per day per site.
 * Best practice is to only submit changed/new URLs (which the scheduler handles).
 */
export async function submitToIndexNow(
  siteId: string,
  domain: string,
  urls: string[]
): Promise<IndexNowSubmitResult> {
  if (urls.length === 0) {
    return { siteId, host: domain, urlCount: 0, success: true, statusCode: 200, message: 'No URLs to submit.' };
  }

  const key = getOrCreateIndexNowKey(siteId);
  const baseUrl = getBaseUrl(siteId, domain);
  const keyLocation = `${baseUrl}/${key}.txt`;
  const batch = urls.slice(0, MAX_BATCH);

  const payload = JSON.stringify({
    host: domain,
    key,
    keyLocation,
    urlList: batch,
  });

  let res: Response;
  try {
    res = await fetch(INDEXNOW_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return {
      siteId,
      host: domain,
      urlCount: batch.length,
      success: false,
      statusCode: 0,
      message: `Network error: ${String(e)}`,
    };
  }

  // 200 = accepted immediately, 202 = queued (key verification pending)
  if (res.status === 200 || res.status === 202) {
    const message = res.status === 202
      ? 'Queued — IndexNow will verify the key file before crawling. This is normal on first submission.'
      : undefined;
    return { siteId, host: domain, urlCount: batch.length, success: true, statusCode: res.status, message };
  }

  if (res.status === 403) {
    let detail = '';
    try {
      const body = await res.json() as { message?: string };
      detail = body.message ?? '';
    } catch { /* ignore */ }

    return {
      siteId,
      host: domain,
      urlCount: batch.length,
      success: false,
      statusCode: 403,
      verificationRequired: true,
      message:
        `IndexNow rejected the submission (403 Forbidden). ` +
        `This means the key verification file is not accessible at: ${keyLocation}\n\n` +
        `To fix this:\n` +
        `  1. Ensure this container/server is publicly reachable at ${baseUrl}\n` +
        `  2. If using a reverse proxy, make sure the /${key}.txt path is forwarded to this container\n` +
        `  3. If the site is hosted separately, place a file at /${key}.txt containing exactly: ${key}\n` +
        `  4. Check the "Sites" page in the dashboard to verify the key file status\n\n` +
        (detail ? `IndexNow said: "${detail}"` : ''),
    };
  }

  if (res.status === 422) {
    return {
      siteId,
      host: domain,
      urlCount: batch.length,
      success: false,
      statusCode: 422,
      message: 'Invalid URLs submitted — check that all URLs start with https:// and match the declared host.',
    };
  }

  if (res.status === 429) {
    return {
      siteId,
      host: domain,
      urlCount: batch.length,
      success: false,
      statusCode: 429,
      message: 'IndexNow rate limit hit. Try again tomorrow.',
    };
  }

  let message = `HTTP ${res.status}`;
  try { message = (await res.text()) || message; } catch { /* ignore */ }
  return { siteId, host: domain, urlCount: batch.length, success: false, statusCode: res.status, message };
}

/**
 * Submits URLs in batches if the list exceeds MAX_BATCH.
 * Returns an array of results, one per batch.
 */
export async function submitToIndexNowInBatches(
  siteId: string,
  domain: string,
  urls: string[]
): Promise<IndexNowSubmitResult[]> {
  const results: IndexNowSubmitResult[] = [];
  for (let i = 0; i < urls.length; i += MAX_BATCH) {
    const batch = urls.slice(i, i + MAX_BATCH);
    const result = await submitToIndexNow(siteId, domain, batch);
    results.push(result);
    // Stop on verification failure — no point sending more batches
    if (!result.success && result.verificationRequired) break;
    // Small delay between batches
    if (i + MAX_BATCH < urls.length) await sleep(500);
  }
  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
