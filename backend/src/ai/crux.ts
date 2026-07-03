/**
 * Core Web Vitals via the (free, official) Chrome UX Report API.
 * Origin-level p75 for LCP / INP / CLS, snapshotted daily per site.
 */
import { getDb, getSetting, type Site } from '../db/database.js';

export function cruxConfigured(): boolean {
  return !!getSetting('crux_api_key');
}

export interface CruxResult {
  lcp_ms: number | null;
  inp_ms: number | null;
  cls: number | null;
}

export async function fetchCrux(site: Site): Promise<CruxResult | null> {
  const key = getSetting('crux_api_key');
  if (!key) return null;
  const origin = site.domain.startsWith('http') ? site.domain : `https://${site.domain}`;
  const res = await fetch(`https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: origin.replace(/\/$/, ''),
      metrics: ['largest_contentful_paint', 'interaction_to_next_paint', 'cumulative_layout_shift'],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null; // origin not in the CrUX dataset (low traffic)
  if (!res.ok) throw new Error(`CrUX HTTP ${res.status}`);
  const data = await res.json() as { record?: { metrics?: Record<string, { percentiles?: { p75?: number | string } }> } };
  const m = data.record?.metrics ?? {};
  const p75 = (k: string): number | null => {
    const v = m[k]?.percentiles?.p75;
    return v === undefined ? null : Number(v);
  };
  const result: CruxResult = {
    lcp_ms: p75('largest_contentful_paint'),
    inp_ms: p75('interaction_to_next_paint'),
    cls: p75('cumulative_layout_shift'),
  };
  getDb().prepare(`
    INSERT INTO crux_snapshots(site_id, day, lcp_ms, inp_ms, cls)
    VALUES(?, date('now'), ?, ?, ?)
    ON CONFLICT(site_id, day) DO UPDATE SET lcp_ms=excluded.lcp_ms, inp_ms=excluded.inp_ms, cls=excluded.cls
  `).run(site.id, result.lcp_ms, result.inp_ms, result.cls);
  return result;
}
