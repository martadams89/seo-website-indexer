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

export const PROVIDERS = ['openai', 'anthropic', 'gemini', 'perplexity', 'xai', 'brave'] as const;
export type Provider = typeof PROVIDERS[number];

const KEY_SETTING: Record<Provider, string> = {
  openai: 'openai_api_key',
  anthropic: 'anthropic_api_key',
  gemini: 'gemini_api_key',
  perplexity: 'perplexity_api_key',
  xai: 'xai_api_key',
  brave: 'brave_api_key',
};

export function configuredProviders(): Provider[] {
  return PROVIDERS.filter(p => !!getSetting(KEY_SETTING[p]));
}

interface ProviderAnswer {
  text: string;
  model: string;
  citations: string[]; // URLs the provider explicitly returned, when supported
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const TIMEOUT = 90_000;

async function askOpenAI(turns: ChatTurn[], key: string): Promise<ProviderAnswer> {
  const model = 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, tools: [{ type: 'web_search_preview' }], input: turns.map(t => ({ role: t.role, content: t.content })) }),
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

async function askAnthropic(turns: ChatTurn[], key: string): Promise<ProviderAnswer> {
  const model = 'claude-sonnet-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: turns,
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

async function askGemini(turns: ChatTurn[], key: string): Promise<ProviderAnswer> {
  const model = 'gemini-flash-latest';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: turns.map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] })),
      tools: [{ google_search: {} }],
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
    }>;
  };
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map(p => p.text ?? '').join('\n');
  const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
  // Gemini grounding returns opaque vertexaisearch.cloud.google.com redirect
  // URLs — useless for domain matching and ugly in the UI. Resolve each 302 to
  // the real source (best-effort, parallel), falling back to web.title, which
  // Gemini sets to the source domain.
  const citations = (await Promise.all(chunks.map(async c => {
    const uri = c.web?.uri;
    const title = c.web?.title;
    if (uri && uri.includes('vertexaisearch.cloud.google.com')) {
      try {
        const r = await fetch(uri, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(6_000) });
        const loc = r.headers.get('location');
        if (loc && loc.startsWith('http')) return loc;
      } catch { /* fall through to title */ }
      if (title) return title.startsWith('http') ? title : `https://${title}`;
      return null; // an unresolvable redirect URL is worse than no citation
    }
    return uri ?? null;
  }))).filter((u): u is string => !!u);
  return { text, model, citations };
}

async function askPerplexity(turns: ChatTurn[], key: string): Promise<ProviderAnswer> {
  const model = 'sonar';
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: turns }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Perplexity HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; citations?: string[] };
  return { text: data.choices?.[0]?.message?.content ?? '', model, citations: data.citations ?? [] };
}

async function askXai(turns: ChatTurn[], key: string): Promise<ProviderAnswer> {
  const model = 'grok-3-mini';
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: turns,
      search_parameters: { mode: 'auto' },
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`xAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; citations?: string[] };
  return { text: data.choices?.[0]?.message?.content ?? '', model, citations: data.citations ?? [] };
}

/**
 * Brave Search — not an LLM, but the retrieval layer that grounds Claude's
 * web search (and other answer engines). Free tier ≈2,000 queries/month.
 * "Cited" here means: your domain appears in the top web results for the
 * prompt — the strongest predictor of being cited by grounded AI answers.
 */
async function askBrave(turns: ChatTurn[], key: string): Promise<ProviderAnswer> {
  const prompt = [...turns].reverse().find(t => t.role === 'user')?.content ?? '';
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: prompt, count: '10' })}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as { web?: { results?: Array<{ url?: string; title?: string; description?: string }> } };
  const results = data.web?.results ?? [];
  // Brave returns titles/descriptions with embedded <strong> highlighting and
  // HTML entities — strip to clean text and emit markdown the UI can render.
  const clean = (s?: string) => (s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
  const host = (u?: string) => { try { return new URL(u ?? '').hostname.replace(/^www\./, ''); } catch { return u ?? ''; } };
  const text = results
    .map((r, i) => `${i + 1}. **${clean(r.title)}** — ${host(r.url)}\n${clean(r.description)}`)
    .join('\n\n');
  return { text, model: 'brave-search', citations: results.map(r => r.url).filter((u): u is string => !!u) };
}

const ASK: Record<Provider, (turns: ChatTurn[], key: string) => Promise<ProviderAnswer>> = {
  openai: askOpenAI,
  anthropic: askAnthropic,
  gemini: askGemini,
  perplexity: askPerplexity,
  xai: askXai,
  brave: askBrave,
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
    INSERT INTO ai_results(prompt_id, provider, model, cited, domains, excerpt, error, parent_id, citations, user_prompt)
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `);

  const results = await Promise.all(providers.map(async provider => {
    const key = getSetting(KEY_SETTING[provider])!;
    try {
      const answer = await ASK[provider]([{ role: 'user', content: row.prompt }], key);
      const found = findDomains(answer, domains);
      // Full response (bounded) — the dashboard renders it as a scrollable chat bubble.
      const text = answer.text.trim().slice(0, 12_000);
      insert.run(promptId, provider, answer.model, found.length ? 1 : 0, JSON.stringify(found), text, null,
        null, JSON.stringify(answer.citations.slice(0, 40)), null);
      logSystem(found.length ? 'ok' : 'info',
        `AI citation [${provider}] ${found.length ? `cited: ${found.join(', ')}` : 'not cited'} — "${row.prompt.slice(0, 60)}"`);
      return { provider, model: answer.model, cited: found.length > 0, domains: found, excerpt: text };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      insert.run(promptId, provider, null, 0, '[]', null, msg.slice(0, 300), null, '[]', null);
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

export interface AiResultRow {
  id: number; prompt_id: number; provider: Provider; model: string | null;
  cited: number; domains: string; excerpt: string | null; error: string | null;
  parent_id: number | null; citations: string | null; user_prompt: string | null;
  created_at: string;
}

/** Root result + all follow-ups for one prompt × provider, oldest first. */
export function getThread(promptId: number, provider: string): AiResultRow[] {
  return getDb().prepare(`
    SELECT * FROM ai_results WHERE prompt_id = ? AND provider = ?
    ORDER BY id ASC
  `).all(promptId, provider) as AiResultRow[];
}

/**
 * Continue the conversation with one provider: rebuild the turn history from
 * the stored thread, append the user's follow-up, ask, persist.
 */
export async function replyInThread(promptId: number, provider: Provider, followUp: string): Promise<AiResultRow> {
  const db = getDb();
  const promptRow = db.prepare('SELECT * FROM ai_prompts WHERE id = ?').get(promptId) as PromptRow | undefined;
  if (!promptRow) throw new Error('Prompt not found');
  if (provider === 'brave') throw new Error('Brave Search is a retrieval check — it has no conversation to continue.');
  const key = getSetting(KEY_SETTING[provider]);
  if (!key) throw new Error(`${provider} API key not configured`);

  const turns: ChatTurn[] = [];
  for (const r of getThread(promptId, provider)) {
    if (r.error) continue; // failed calls contribute nothing to the context
    turns.push({ role: 'user', content: r.user_prompt ?? promptRow.prompt });
    if (r.excerpt) turns.push({ role: 'assistant', content: r.excerpt });
  }
  if (turns.length === 0) turns.push({ role: 'user', content: promptRow.prompt });
  turns.push({ role: 'user', content: followUp });

  const domains = trackedDomains();
  const parent = getThread(promptId, provider).at(-1);
  const answer = await ASK[provider](turns, key);
  const found = findDomains(answer, domains);
  const text = answer.text.trim().slice(0, 12_000);
  const res = db.prepare(`
    INSERT INTO ai_results(prompt_id, provider, model, cited, domains, excerpt, error, parent_id, citations, user_prompt)
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(promptId, provider, answer.model, found.length ? 1 : 0, JSON.stringify(found), text, null,
    parent?.id ?? null, JSON.stringify(answer.citations.slice(0, 40)), followUp);
  logSystem(found.length ? 'ok' : 'info', `AI follow-up [${provider}] ${found.length ? `cited: ${found.join(', ')}` : 'not cited'}`);
  return db.prepare('SELECT * FROM ai_results WHERE id = ?').get(res.lastInsertRowid) as AiResultRow;
}
