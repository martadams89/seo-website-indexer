/**
 * One-shot text generation against the workspace's configured LLM provider.
 *
 * A single system + user prompt, no web-search tools: the caller supplies all
 * context. Shared by llms.txt generation and Ranking Playbook drafts. Providers
 * are called with raw fetch (no SDKs) so tests can stub `globalThis.fetch`.
 */
import { effectiveSetting } from '../db/database.js';
import { resolveModel } from './models.js';

export type GenProvider = 'anthropic' | 'openai' | 'gemini' | 'xai' | 'perplexity';

// Order = writing-quality preference when several providers are configured.
export const GEN_ORDER: GenProvider[] = ['anthropic', 'openai', 'gemini', 'xai', 'perplexity'];
export const GEN_KEY: Record<GenProvider, string> = {
  anthropic: 'anthropic_api_key', openai: 'openai_api_key', gemini: 'gemini_api_key',
  xai: 'xai_api_key', perplexity: 'perplexity_api_key',
};

/** First configured writing provider for the workspace (workspace key, else platform key). */
export function generationProvider(workspaceId: string | null = null): GenProvider | null {
  return GEN_ORDER.find(p => !!effectiveSetting(workspaceId, GEN_KEY[p])) ?? null;
}

const TIMEOUT = 90_000;

export interface Completion { text: string; model: string }

export async function complete(provider: GenProvider, key: string, system: string, user: string, modelId?: string): Promise<Completion> {
  if (provider === 'anthropic') {
    const model = modelId || 'claude-sonnet-5';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return { text: (data.content ?? []).map(b => b.text ?? '').join(''), model };
  }
  if (provider === 'gemini') {
    const model = modelId || 'gemini-flash-latest';
    // The key travels in the query string: never log this URL.
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 4000, temperature: 0.4 },
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return { text: (data.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join(''), model };
  }
  // OpenAI-compatible chat completions: openai, xai, perplexity.
  const cfg: Record<'openai' | 'xai' | 'perplexity', { url: string; model: string }> = {
    openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
    xai: { url: 'https://api.x.ai/v1/chat/completions', model: 'grok-3-mini' },
    perplexity: { url: 'https://api.perplexity.ai/chat/completions', model: 'sonar' },
  };
  const { url } = cfg[provider];
  const model = modelId || cfg[provider].model;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0.4, max_tokens: 4000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`${provider} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return { text: data.choices?.[0]?.message?.content ?? '', model };
}

/**
 * Resolve provider, key and model for a workspace and run one completion.
 * Throws a 400 when no writing provider is configured. Callers own budget
 * checks (assertWithinBudget) and usage metering (recordUsage).
 */
export async function completeForWorkspace(workspaceId: string | null, system: string, user: string): Promise<Completion & { provider: GenProvider }> {
  const provider = generationProvider(workspaceId);
  if (!provider) {
    throw Object.assign(new Error('No AI provider is configured. Add an OpenAI, Anthropic, Gemini, xAI or Perplexity key under Settings → API keys.'), { statusCode: 400 });
  }
  const key = effectiveSetting(workspaceId, GEN_KEY[provider])!;
  const result = await complete(provider, key, system, user, resolveModel(workspaceId, provider));
  return { ...result, provider };
}

/** Strip an accidental ``` fence around model output. */
export function stripCodeFence(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

/**
 * Parse the first JSON object in model output. Models sometimes wrap JSON in
 * prose or a fence; find the outermost braces and parse that span.
 */
export function parseJsonObject<T = Record<string, unknown>>(text: string): T | null {
  const cleaned = stripCodeFence(text);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}
