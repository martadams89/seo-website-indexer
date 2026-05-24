/**
 * google.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wrappers for:
 *  1. Google Indexing API  — URL_UPDATED notifications (200 quota/day/project)
 *  2. Google Search Console — sitemap submission
 *
 * All calls go through `getAccessToken()` from google-oauth.ts so any auth
 * strategy (SA / Device Flow) works transparently.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getAccessToken } from '../auth/google-oauth.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IndexingResult {
  url: string;
  success: boolean;
  statusCode: number;
  message?: string;
}

export interface SitemapSubmitResult {
  sitemapUrl: string;
  success: boolean;
  statusCode: number;
  message?: string;
}

// ── Indexing API ─────────────────────────────────────────────────────────────

const INDEXING_ENDPOINT = 'https://indexing.googleapis.com/v3/urlNotifications:publish';

/**
 * Notifies Google of an updated URL via the Indexing API.
 * Requires the service account / OAuth user to be a verified owner in GSC.
 *
 * NOTE: This API is officially documented for job posting / livestream structured
 * data, but it also works for general URLs when the site has been verified.
 * The 200 URLs/day quota is per Google Cloud project (all sites combined).
 */
export async function notifyGoogle(url: string, type: 'URL_UPDATED' | 'URL_DELETED' = 'URL_UPDATED'): Promise<IndexingResult> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (e) {
    return { url, success: false, statusCode: 0, message: `Auth error: ${String(e)}` };
  }

  const payload = JSON.stringify({ url, type });

  let attempt = 0;
  while (attempt < 3) {
    attempt++;
    let res: Response;
    try {
      res = await fetch(INDEXING_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: payload,
      });
    } catch (e) {
      if (attempt < 3) continue;
      return { url, success: false, statusCode: 0, message: `Network error: ${String(e)}` };
    }

    if (res.status === 200) {
      return { url, success: true, statusCode: 200 };
    }
    if (res.status === 429) {
      return { url, success: false, statusCode: 429, message: 'Daily quota exhausted (200 URLs/day per project).' };
    }
    if (res.status === 401 && attempt < 3) {
      // Token may have just expired — wait briefly and let the next iteration
      // call getAccessToken() again (which will refresh)
      await sleep(1000);
      try { token = await getAccessToken(); } catch { /* ignore */ }
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(attempt * 2000);
      continue;
    }

    // 4xx or exhausted retries
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: { message?: string } };
      message = body?.error?.message ?? message;
    } catch { /* ignore */ }
    return { url, success: false, statusCode: res.status, message };
  }

  return { url, success: false, statusCode: 0, message: 'All retries exhausted.' };
}

// ── Search Console — Sitemap Submission ──────────────────────────────────────

const GSC_BASE = 'https://www.googleapis.com/webmasters/v3';

/**
 * Submits (or re-submits) a sitemap to Google Search Console.
 * `gscUrl` is the site identifier as registered in GSC, e.g.:
 *   - "https://prosurvey.app/"  (URL-prefix property)
 *   - "sc-domain:dampsurvey.pro" (domain property)
 */
export async function submitSitemapToGSC(gscUrl: string, sitemapUrl: string): Promise<SitemapSubmitResult> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (e) {
    return { sitemapUrl, success: false, statusCode: 0, message: `Auth error: ${String(e)}` };
  }

  const siteEnc    = encodeURIComponent(gscUrl);
  const sitemapEnc = encodeURIComponent(sitemapUrl);
  const endpoint   = `${GSC_BASE}/sites/${siteEnc}/sitemaps/${sitemapEnc}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Length': '0',
      },
    });
  } catch (e) {
    return { sitemapUrl, success: false, statusCode: 0, message: `Network error: ${String(e)}` };
  }

  if (res.status === 204 || res.status === 200) {
    return { sitemapUrl, success: true, statusCode: res.status };
  }

  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json() as { error?: { message?: string } };
    message = body?.error?.message ?? message;
  } catch { /* ignore */ }

  return { sitemapUrl, success: false, statusCode: res.status, message };
}

/**
 * Lists all sitemaps registered in GSC for the given site.
 * Returns an array of sitemap objects or throws on error.
 */
export async function listGSCSitemaps(gscUrl: string): Promise<Array<{ path: string; lastSubmitted?: string; isPending?: boolean }>> {
  const token = await getAccessToken();
  const siteEnc = encodeURIComponent(gscUrl);

  const res = await fetch(`${GSC_BASE}/sites/${siteEnc}/sitemaps`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`GSC sitemaps list failed: HTTP ${res.status}`);
  }

  const body = await res.json() as { sitemap?: Array<{ path: string; lastSubmitted?: string; isPending?: boolean }> };
  return body.sitemap ?? [];
}

/**
 * Lists all sites/properties the authenticated user has access to in GSC.
 * Useful for onboarding — lets users pick from their existing properties.
 */
export async function listGSCSites(): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
  const token = await getAccessToken();

  const res = await fetch(`${GSC_BASE}/sites`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GSC sites list failed (HTTP ${res.status}): ${body}`);
  }

  const body = await res.json() as { siteEntry?: Array<{ siteUrl: string; permissionLevel: string }> };
  return body.siteEntry ?? [];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
