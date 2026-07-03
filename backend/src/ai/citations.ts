/**
 * AI citation tracking — the GEO measurement loop. Runs tracked prompts
 * against web-connected LLMs (ChatGPT, Claude, Gemini, Perplexity, Grok) and
 * records whether the answer cites/mentions your domains.
 *
 * Every provider is optional: configure its API key in Settings and it joins
 * the panel; unconfigured providers are skipped silently.
 */
import { getDb, getSetting, getAllSites } from '../db/database.js';
import { logSystem } from '../utils/logger.js';

export const PROVIDERS = ['openai', 'anthropic', 'gemini', 'perplexity', 'xai'] as const;
export type Provider = typeof PROVIDERS[number];

const KEY_SETTING: Record<Provider, string> = {
  openai: 'openai_api_key',
  anthropic: 'anthropic_api_key',
  gemini: 'gemini_api_key',
  perplexity: 'perplexity_api_key',
  xai: 'xai_api_key',
};

export function configuredProviders(): Provider[] {
  return PROVIDERS.filter(p => !!getSetting(KEY_SETTING[p]));
}

interface ProviderAnswer {
  text: string;
  model: string;
  citations: string[]; // URLs the provider explicitly returned, when supported
}

const TIMEOUT = 90_000;

async function askOpenAI(prompt: string, key: string): Promise<ProviderAnswer> {
  const model = 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, tools: [{ type: 'web_search_preview' }], input: prompt }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string; annotations?: Array<{ type: string; url?: string }> }> }> };
  let text = '';
  const citations: string[] = [];
  for (const item of data.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.text) text += c.text + '\n';
      for (const a of c.annotations ?? []) if (a.url) citations.push(a.url);
    }
  }
  return { text, model, citations };
}

async function askAnthropic(prompt: string, key: string): Promise<ProviderAnswer> {
  const model = 'claude-sonnet-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { content?: Array<{ type: string; text?: string; citations?: Array<{ url?: string }> }> };
  let text = '';
  const citations: string[] = [];
  for (const block of data.content ?? []) {
    if (block.text) text += block.text + '\n';
    for (const c of block.citations ?? []) if (c.url) citations.push(c.url);
  }
  return { text, model, citations };
}

async function askGemini(prompt: string, key: string): Promise<ProviderAnswer> {
  const model = 'gemini-2.0-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> };
    }>;
  };
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map(p => p.text ?? '').join('\n');
  const citations = (cand?.groundingMetadata?.groundingChunks ?? [])
    .map(c => c.web?.uri).filter((u): u is string => !!u);
  return { text, model, citations };
}

async function askPerplexity(prompt: string, key: string): Promise<ProviderAnswer> {
  const model = 'sonar';
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Perplexity HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; citations?: string[] };
  return { text: data.choices?.[0]?.message?.content ?? '', model, citations: data.citations ?? [] };
}

async function askXai(prompt: string, key: string): Promise<ProviderAnswer> {
  const model = 'grok-3-mini';
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      search_parameters: { mode: 'auto' },
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`xAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; citations?: string[] };
  return { text: data.choices?.[0]?.message?.content ?? '', model, citations: data.citations ?? [] };
}

const ASK: Record<Provider, (prompt: string, key: string) => Promise<ProviderAnswer>> = {
  openai: askOpenAI,
  anthropic: askAnthropic,
  gemini: askGemini,
  perplexity: askPerplexity,
  xai: askXai,
};

/** Domains we count as "ours" for citation detection. */
function trackedDomains(): string[] {
  return getAllSites().map(s => s.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''));
}

function findDomains(answer: ProviderAnswer, domains: string[]): string[] {
  const hay = (answer.text + ' ' + answer.citations.join(' ')).toLowerCase();
  return domains.filter(d => hay.includes(d.toLowerCase()));
}

export interface PromptRow { id: number; site_id: string | null; prompt: string; enabled: number; created_at: string }

export function listPrompts(): PromptRow[] {
  return getDb().prepare('SELECT * FROM ai_prompts ORDER BY created_at DESC').all() as PromptRow[];
}

export function addPrompt(prompt: string, siteId?: string | null): PromptRow {
  const r = getDb().prepare('INSERT INTO ai_prompts(site_id, prompt) VALUES(?, ?)').run(siteId ?? null, prompt);
  return getDb().prepare('SELECT * FROM ai_prompts WHERE id = ?').get(r.lastInsertRowid) as PromptRow;
}

export function deletePrompt(id: number): void {
  getDb().prepare('DELETE FROM ai_prompts WHERE id = ?').run(id);
}

export function getResults(limit = 200): Array<Record<string, unknown>> {
  return getDb().prepare(`
    SELECT r.*, p.prompt, p.site_id FROM ai_results r
    JOIN ai_prompts p ON p.id = r.prompt_id
    ORDER BY r.created_at DESC LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
}

/** Run one prompt against every configured provider; persist + return results. */
export async function runPrompt(promptId: number): Promise<Array<Record<string, unknown>>> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ai_prompts WHERE id = ?').get(promptId) as PromptRow | undefined;
  if (!row) throw new Error('Prompt not found');
  const domains = trackedDomains();
  const providers = configuredProviders();
  if (providers.length === 0) throw new Error('No AI provider API keys configured (Settings)');

  const insert = db.prepare(`
    INSERT INTO ai_results(prompt_id, provider, model, cited, domains, excerpt, error)
    VALUES(?,?,?,?,?,?,?)
  `);

  const results = await Promise.all(providers.map(async provider => {
    const key = getSetting(KEY_SETTING[provider])!;
    try {
      const answer = await ASK[provider](row.prompt, key);
      const found = findDomains(answer, domains);
      const excerpt = answer.text.trim().slice(0, 600);
      insert.run(promptId, provider, answer.model, found.length ? 1 : 0, JSON.stringify(found), excerpt, null);
      logSystem(found.length ? 'ok' : 'info',
        `AI citation [${provider}] ${found.length ? `cited: ${found.join(', ')}` : 'not cited'} — "${row.prompt.slice(0, 60)}"`);
      return { provider, model: answer.model, cited: found.length > 0, domains: found, excerpt };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      insert.run(promptId, provider, null, 0, '[]', null, msg.slice(0, 300));
      logSystem('warn', `AI citation [${provider}] failed: ${msg.slice(0, 120)}`);
      return { provider, model: null, cited: false, domains: [], error: msg };
    }
  }));
  return results;
}

/** Run all enabled prompts (used by the scheduler's citation sweep). */
export async function runAllPrompts(): Promise<number> {
  const prompts = listPrompts().filter(p => p.enabled);
  let n = 0;
  for (const p of prompts) {
    try { await runPrompt(p.id); n++; } catch { /* logged in runPrompt */ }
  }
  return n;
}
