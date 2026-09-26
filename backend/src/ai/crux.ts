/**
 * Core Web Vitals via the (free, official) Chrome UX Report API.
 * Origin-level p75 for LCP / INP / CLS, snapshotted daily per site.
 */
import { getDb, effectiveSetting, type Site } from '../db/database.js';

export function cruxConfigured(workspaceId: string | null = null): boolean {
  return !!effectiveSetting(workspaceId, 'crux_api_key');
}

export interface CruxResult {
  lcp_ms: number | null;
  inp_ms: number | null;
  cls: number | null;
}

/**
 * One CrUX record query (`origin` or `url`), p75 per metric. Returns null when
 * the origin/page is not in the dataset (too little real-user traffic).
 */
export async function queryCruxRecord(key: string, target: { origin: string } | { url: string; formFactor?: 'PHONE' | 'DESKTOP' }): Promise<CruxResult | null> {
  const res = await fetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...target,
      metrics: ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`CrUX HTTP ${res.status}`);
  const data = await res.json() as { record?: { metrics?: Record<string, { percentiles?: { p75?: number | string } }> } };
  const m = data.record?.metrics ?? {};
  const p75 = (k: string): number | null => {
    const v = m[k]?.percentiles?.p75;
    return v === undefined ? null : Number(v);
  };
  return {
    lcp_ms: p75('largest_contentful_paint'),
    inp_ms: p75('interaction_to_next_paint'),
    cls: p75('cumulative_layout_shift'),
  };
}

export async function fetchCrux(site: Site): Promise<CruxResult | null> {
  const key = effectiveSetting(site.workspace_id ?? null, 'crux_api_key');
  if (!key) return null;
  const origin = site.domain.startsWith('http') ? site.domain : `https://${site.domain}`;
  const result = await queryCruxRecord(key, { origin: origin.replace(/\/$/, '') });
  if (!result) return null; // origin not in the CrUX dataset (low traffic)
  getDb().prepare(`
    INSERT INTO crux_snapshots(site_id, day, lcp_ms, inp_ms, cls)
    VALUES(?, date('now'), ?, ?, ?)
    ON CONFLICT(site_id, day) DO UPDATE SET lcp_ms=excluded.lcp_ms, inp_ms=excluded.inp_ms, cls=excluded.cls
  `).run(site.id, result.lcp_ms, result.inp_ms, result.cls);
  return result;
}
