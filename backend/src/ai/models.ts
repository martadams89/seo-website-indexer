/**
 * AI model discovery — probe each configured provider's live model list, rank
 * by version ("highest number wins" within a tier like mini / flash / sonnet),
 * and let the workspace pick one. The chosen model is stored as a per-workspace
 * override (model_<provider>); absent → the auto-detected latest → a safe
 * hard-coded default. Model selection reuses the layered per-workspace settings.
 */
import { effectiveSetting, getWorkspaceSetting } from '../db/database.js';

export type ModelProvider = 'openai' | 'anthropic' | 'gemini' | 'xai' | 'perplexity';
export const MODEL_PROVIDERS: ModelProvider[] = ['openai', 'anthropic', 'gemini', 'xai', 'perplexity'];

const KEY: Record<ModelProvider, string> = {
  openai: 'openai_api_key', anthropic: 'anthropic_api_key', gemini: 'gemini_api_key',
  xai: 'xai_api_key', perplexity: 'perplexity_api_key',
};
// Safe fallbacks (also the "tier" keyword we prefer when auto-picking latest).
const DEFAULT: Record<ModelProvider, string> = {
  openai: 'gpt-4o-mini', anthropic: 'claude-sonnet-5', gemini: 'gemini-flash-latest',
  xai: 'grok-3-mini', perplexity: 'sonar',
};
const TIER: Record<ModelProvider, string> = {
  openai: 'mini', anthropic: 'sonnet', gemini: 'flash', xai: 'mini', perplexity: 'sonar',
};

// ── Version ranking: "highest number wins" ───────────────────────────────────

function versionKey(id: string): number[] {
  // Extract numeric tokens in order, e.g. gpt-5.1-mini -> [5,1]; claude-sonnet-5 -> [5].
  return (id.match(/\d+(?:\.\d+)?/g) ?? []).flatMap(n => n.split('.').map(Number));
}
function cmpVersion(a: string, b: string): number {
  const va = versionKey(a), vb = versionKey(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? -1) - (va[i] ?? -1);
    if (d !== 0) return d; // descending (latest first)
  }
  return a < b ? 1 : -1;
}

// A dated snapshot (e.g. gpt-4o-mini-2024-07-18, gpt-4-0613) rather than the
// rolling alias (gpt-4o-mini). We prefer the aliases so users track updates.
function isDatedSnapshot(id: string): boolean {
  return /\d{4}-\d{2}-\d{2}/.test(id) || /-\d{8}$/.test(id) || /-\d{4}$/.test(id) || /-\d{3,4}-preview/i.test(id);
}

/** The newest model, preferring the tier keyword + undated (rolling) aliases. */
export function pickLatest(provider: ModelProvider, ids: string[]): string {
  // Gemini's `-latest` alias always resolves to Google's newest flash model.
  if (provider === 'gemini') return 'gemini-flash-latest';
  if (ids.length === 0) return DEFAULT[provider];
  const tier = TIER[provider];
  const tiered = ids.filter(id => id.toLowerCase().includes(tier));
  let pool = tiered.length ? tiered : ids;
  const undated = pool.filter(id => !isDatedSnapshot(id));
  if (undated.length) pool = undated; // favour rolling aliases over dated snapshots
  return [...pool].sort(cmpVersion)[0];
}

// ── Live probes (best-effort; return [] on any error) ────────────────────────

const T = 15_000;
async function probeOpenAICompatible(url: string, key: string, prefix: RegExp): Promise<string[]> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(T) });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map(m => m.id ?? '').filter(id => prefix.test(id));
  } catch { return []; }
}
async function probeAnthropic(key: string): Promise<string[]> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(T),
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map(m => m.id ?? '').filter(id => id.startsWith('claude'));
  } catch { return []; }
}
async function probeGemini(key: string): Promise<string[]> {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, { signal: AbortSignal.timeout(T) });
    if (!res.ok) return [];
    const data = await res.json() as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    return (data.models ?? [])
      .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map(m => (m.name ?? '').replace(/^models\//, ''))
      .filter(id => id.startsWith('gemini'));
  } catch { return []; }
}

async function probeOne(provider: ModelProvider, key: string): Promise<string[]> {
  switch (provider) {
    case 'openai': return probeOpenAICompatible('https://api.openai.com/v1/models', key, /^(gpt|o\d|chatgpt)/i);
    case 'xai': return probeOpenAICompatible('https://api.x.ai/v1/models', key, /^grok/i);
    case 'anthropic': return probeAnthropic(key);
    case 'gemini': return probeGemini(key);
    case 'perplexity': return ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro']; // no list API
  }
}

export interface ProviderModels {
  provider: ModelProvider;
  configured: boolean;
  models: string[];        // available (probed), newest-first
  selected: string;        // the effective model for this workspace
  recommended: string;     // auto-detected latest
  isOverride: boolean;     // true if the workspace explicitly chose one
}

/** Probe every configured provider for the workspace and report models + choice. */
export async function probeModels(workspaceId: string | null): Promise<ProviderModels[]> {
  const out: ProviderModels[] = [];
  for (const provider of MODEL_PROVIDERS) {
    const key = effectiveSetting(workspaceId, KEY[provider]);
    if (!key) { out.push({ provider, configured: false, models: [], selected: DEFAULT[provider], recommended: DEFAULT[provider], isOverride: false }); continue; }
    const ids = (await probeOne(provider, key)).sort(cmpVersion);
    const recommended = pickLatest(provider, ids);
    const override = workspaceId ? getWorkspaceSetting(workspaceId, `model_${provider}`) : null;
    out.push({
      provider, configured: true, models: ids,
      recommended, selected: override || recommended, isOverride: !!override,
    });
  }
  return out;
}

/** Resolve the model to actually call for a provider in a workspace:
 *  explicit workspace choice → provider default (fast, no network). */
export function resolveModel(workspaceId: string | null, provider: ModelProvider): string {
  return effectiveSetting(workspaceId, `model_${provider}`) || DEFAULT[provider];
}
