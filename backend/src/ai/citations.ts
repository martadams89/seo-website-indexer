/**
 * AI citation tracking — the GEO measurement loop. Runs tracked prompts
 * against web-connected LLMs (ChatGPT, Claude, Gemini, Perplexity, Grok) and
 * records whether the answer cites/mentions your domains.
 *
 * Every provider is optional: configure its API key in Settings and it joins
 * the panel; unconfigured providers are skipped silently.
 */
import { getDb, effectiveSetting, getAllSites, getSitesForWorkspace, getWorkspaceSetting } from '../db/database.js';
import { resolveModel, type ModelProvider } from './models.js';
import { logSystem } from '../utils/logger.js';
import { recordAlert } from '../analytics/stats.js';
import { notificationEventEnabled, sendWorkspaceNotification } from '../utils/notify.js';

export const PROVIDERS = ['openai', 'anthropic', 'gemini', 'perplexity', 'xai', 'brave'] as const;
export type Provider = typeof PROVIDERS[number];
const PROVIDER_LABELS: Record<Provider, string> = {
  openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini',
  perplexity: 'Perplexity', xai: 'Grok', brave: 'Brave Search',
};

const KEY_SETTING: Record<Provider, string> = {
  openai: 'openai_api_key',
  anthropic: 'anthropic_api_key',
  gemini: 'gemini_api_key',
  perplexity: 'perplexity_api_key',
  xai: 'xai_api_key',
  brave: 'brave_api_key',
};

export function configuredProviders(workspaceId: string | null = null): Provider[] {
  return PROVIDERS.filter(p => !!effectiveSetting(workspaceId, KEY_SETTING[p]));
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

async function askOpenAI(turns: ChatTurn[], key: string, modelId?: string): Promise<ProviderAnswer> {
  const model = modelId || 'gpt-4o-mini';
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

async function askAnthropic(turns: ChatTurn[], key: string, modelId?: string): Promise<ProviderAnswer> {
  const model = modelId || 'claude-sonnet-5';
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

async function askGemini(turns: ChatTurn[], key: string, modelId?: string): Promise<ProviderAnswer> {
  const model = modelId || 'gemini-flash-latest';
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

async function askPerplexity(turns: ChatTurn[], key: string, modelId?: string): Promise<ProviderAnswer> {
  const model = modelId || 'sonar';
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

async function askXai(turns: ChatTurn[], key: string, modelId?: string): Promise<ProviderAnswer> {
  const model = modelId || 'grok-3-mini';
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

const ASK: Record<Provider, (turns: ChatTurn[], key: string, modelId?: string) => Promise<ProviderAnswer>> = {
  openai: askOpenAI,
  anthropic: askAnthropic,
  gemini: askGemini,
  perplexity: askPerplexity,
  xai: askXai,
  brave: askBrave,
};

/** Domains we count as "ours" for citation detection. */
function trackedDomains(workspaceId: string | null = null): string[] {
  const sites = workspaceId ? getSitesForWorkspace(workspaceId) : getAllSites();
  return sites.map(s => s.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''));
}

function findDomains(answer: ProviderAnswer, domains: string[]): string[] {
  const hay = (answer.text + ' ' + answer.citations.join(' ')).toLowerCase();
  return domains.filter(d => hay.includes(d.toLowerCase()));
}

export const PROMPT_CATEGORIES = ['discovery', 'comparison', 'commercial', 'brand', 'support'] as const;
export type PromptCategory = typeof PROMPT_CATEGORIES[number];

export interface PromptRow {
  id: number; workspace_id: string | null; site_id: string | null; prompt: string;
  category: PromptCategory; enabled: number; created_at: string;
}

/** Prompts for one workspace (the tenant boundary). */
export function listPrompts(workspaceId: string | null = null): PromptRow[] {
  if (workspaceId) {
    return getDb().prepare('SELECT * FROM ai_prompts WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId) as PromptRow[];
  }
  return getDb().prepare('SELECT * FROM ai_prompts ORDER BY created_at DESC').all() as PromptRow[];
}

export function addPrompt(
  prompt: string,
  siteId?: string | null,
  workspaceId: string | null = null,
  category: PromptCategory = 'discovery',
): PromptRow {
  const safeCategory = PROMPT_CATEGORIES.includes(category) ? category : 'discovery';
  const r = getDb().prepare('INSERT INTO ai_prompts(site_id, prompt, workspace_id, category) VALUES(?, ?, ?, ?)')
    .run(siteId ?? null, prompt, workspaceId, safeCategory);
  return getDb().prepare('SELECT * FROM ai_prompts WHERE id = ?').get(r.lastInsertRowid) as PromptRow;
}

function getPrompt(promptId: number, workspaceId: string | null): PromptRow | undefined {
  if (workspaceId) {
    return getDb().prepare('SELECT * FROM ai_prompts WHERE id = ? AND workspace_id = ?')
      .get(promptId, workspaceId) as PromptRow | undefined;
  }
  return getDb().prepare('SELECT * FROM ai_prompts WHERE id = ?').get(promptId) as PromptRow | undefined;
}

/** Delete a prompt, but only if it belongs to the caller's workspace. */
export function deletePrompt(id: number, workspaceId: string | null = null): void {
  if (workspaceId) {
    getDb().prepare('DELETE FROM ai_prompts WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
  } else {
    getDb().prepare('DELETE FROM ai_prompts WHERE id = ?').run(id);
  }
}

/** Citation results, scoped to one workspace's prompts. */
export function getResults(limit = 200, workspaceId: string | null = null): Array<Record<string, unknown>> {
  if (workspaceId) {
    return getDb().prepare(`
      SELECT r.*, p.prompt, p.site_id FROM ai_results r
      JOIN ai_prompts p ON p.id = r.prompt_id
      WHERE p.workspace_id = ?
      ORDER BY r.created_at DESC LIMIT ?
    `).all(workspaceId, limit) as Array<Record<string, unknown>>;
  }
  return getDb().prepare(`
    SELECT r.*, p.prompt, p.site_id FROM ai_results r
    JOIN ai_prompts p ON p.id = r.prompt_id
    ORDER BY r.created_at DESC LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
}

/** Run one prompt against every configured provider; persist + return results. */
export async function runPrompt(promptId: number, workspaceId: string | null = null): Promise<Array<Record<string, unknown>>> {
  const db = getDb();
  const row = getPrompt(promptId, workspaceId);
  if (!row) throw new Error('Prompt not found');
  const domains = trackedDomains(workspaceId);
  const providers = configuredProviders(workspaceId);
  if (providers.length === 0) throw new Error('No AI provider API keys configured (Settings)');

  const insert = db.prepare(`
    INSERT INTO ai_results(prompt_id, provider, model, cited, domains, excerpt, error, parent_id, citations, user_prompt)
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `);

  const movements: Array<{ provider: Provider; cited: boolean }> = [];
  const results = await Promise.all(providers.map(async provider => {
    const key = effectiveSetting(workspaceId, KEY_SETTING[provider])!;
    const previous = db.prepare(`
      SELECT cited FROM ai_results
      WHERE prompt_id = ? AND provider = ? AND parent_id IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(promptId, provider) as { cited: number } | undefined;
    try {
      const modelId = provider === 'brave' ? undefined : resolveModel(workspaceId, provider as ModelProvider);
      const answer = await ASK[provider]([{ role: 'user', content: row.prompt }], key, modelId);
      const found = findDomains(answer, domains);
      // Full response (bounded) — the dashboard renders it as a scrollable chat bubble.
      const text = answer.text.trim().slice(0, 12_000);
      insert.run(promptId, provider, answer.model, found.length ? 1 : 0, JSON.stringify(found), text, null,
        null, JSON.stringify(answer.citations.slice(0, 40)), null);
      if (previous && Boolean(previous.cited) !== Boolean(found.length)) {
        const gained = found.length > 0;
        const label = PROVIDER_LABELS[provider] ?? provider;
        recordAlert(
          row.site_id,
          'citation',
          `${gained ? 'Citation gained' : 'Citation lost'} on ${label}: “${row.prompt.slice(0, 90)}”`,
          gained ? 'info' : 'warn',
          gained ? `Now cites ${found.join(', ')}` : 'The latest answer no longer cites a tracked domain.',
          workspaceId,
        );
        movements.push({ provider, cited: gained });
      }
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
  if (workspaceId && movements.length > 0 && notificationEventEnabled(workspaceId, 'citation_changes')) {
    const gained = movements.filter(m => m.cited).length;
    const lost = movements.length - gained;
    const body = `${gained} citation${gained === 1 ? '' : 's'} gained, ${lost} lost for “${row.prompt.slice(0, 100)}”.`;
    sendWorkspaceNotification(workspaceId, 'AI visibility changed', body, 'citation_changes').catch(() => null);
  }
  return results;
}

/** Run all enabled prompts (used by the scheduler's citation sweep). */
export async function runAllPrompts(workspaceId: string | null = null): Promise<number> {
  const prompts = listPrompts(workspaceId).filter(p => p.enabled);
  let n = 0;
  for (const p of prompts) {
    try { await runPrompt(p.id, workspaceId); n++; } catch { /* logged in runPrompt */ }
  }
  return n;
}

export interface AiResultRow {
  id: number; prompt_id: number; provider: Provider; model: string | null;
  cited: number; domains: string; excerpt: string | null; error: string | null;
  parent_id: number | null; citations: string | null; user_prompt: string | null;
  created_at: string;
}

/** Root result + follow-ups for one workspace-scoped prompt × provider. */
export function getThread(promptId: number, provider: string, workspaceId: string | null = null): AiResultRow[] {
  if (workspaceId) {
    return getDb().prepare(`
      SELECT r.* FROM ai_results r
      JOIN ai_prompts p ON p.id = r.prompt_id
      WHERE r.prompt_id = ? AND r.provider = ? AND p.workspace_id = ?
      ORDER BY r.id ASC
    `).all(promptId, provider, workspaceId) as AiResultRow[];
  }
  return getDb().prepare('SELECT * FROM ai_results WHERE prompt_id = ? AND provider = ? ORDER BY id ASC')
    .all(promptId, provider) as AiResultRow[];
}

/**
 * Continue the conversation with one provider: rebuild the turn history from
 * the stored thread, append the user's follow-up, ask, persist.
 */
export async function replyInThread(promptId: number, provider: Provider, followUp: string, workspaceId: string | null = null): Promise<AiResultRow> {
  const db = getDb();
  const promptRow = getPrompt(promptId, workspaceId);
  if (!promptRow) throw new Error('Prompt not found');
  if (provider === 'brave') throw new Error('Brave Search is a retrieval check — it has no conversation to continue.');
  const key = effectiveSetting(workspaceId, KEY_SETTING[provider]);
  if (!key) throw new Error(`${provider} API key not configured`);

  const turns: ChatTurn[] = [];
  for (const r of getThread(promptId, provider, workspaceId)) {
    if (r.error) continue; // failed calls contribute nothing to the context
    turns.push({ role: 'user', content: r.user_prompt ?? promptRow.prompt });
    if (r.excerpt) turns.push({ role: 'assistant', content: r.excerpt });
  }
  if (turns.length === 0) turns.push({ role: 'user', content: promptRow.prompt });
  turns.push({ role: 'user', content: followUp });

  const domains = trackedDomains(workspaceId);
  const parent = getThread(promptId, provider, workspaceId).at(-1);
  const modelId = resolveModel(workspaceId, provider as ModelProvider);
  const answer = await ASK[provider](turns, key, modelId);
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

interface InsightResult extends AiResultRow {
  prompt: string;
  category: PromptCategory;
  site_id: string | null;
}

export interface AiInsights {
  overview: {
    prompts: number;
    configuredProviders: number;
    checks: number;
    cited: number;
    visibility: number;
    previousVisibility: number | null;
    change: number | null;
    sourceDomains: number;
  };
  providers: Array<{ provider: Provider; checks: number; cited: number; visibility: number }>;
  trend: Array<{ day: string; checks: number; cited: number; visibility: number }>;
  sources: Array<{ domain: string; citations: number; owned: boolean; competitor: boolean; providers: Provider[] }>;
  opportunities: Array<{
    promptId: number; prompt: string; category: PromptCategory; siteId: string | null;
    citedProviders: Provider[]; missingProviders: Provider[];
  }>;
  movements: Array<{
    promptId: number; prompt: string; provider: Provider; cited: boolean; previousCited: boolean; createdAt: string;
  }>;
}

function safeArray(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
  } catch { return []; }
}

function sourceDomain(value: string): string | null {
  try {
    const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(normalized).hostname.toLowerCase().replace(/^www\./, '');
  } catch { return null; }
}

/** Portfolio-level GEO intelligence derived from root runs only. */
export function getAiInsights(workspaceId: string | null): AiInsights {
  const empty: AiInsights = {
    overview: { prompts: 0, configuredProviders: 0, checks: 0, cited: 0, visibility: 0, previousVisibility: null, change: null, sourceDomains: 0 },
    providers: [], trend: [], sources: [], opportunities: [], movements: [],
  };
  if (!workspaceId) return empty;

  const prompts = listPrompts(workspaceId);
  const configured = configuredProviders(workspaceId);
  const rows = getDb().prepare(`
    SELECT r.*, p.prompt, p.category, p.site_id
    FROM ai_results r JOIN ai_prompts p ON p.id = r.prompt_id
    WHERE p.workspace_id = ? AND r.parent_id IS NULL
    ORDER BY r.created_at DESC, r.id DESC
  `).all(workspaceId) as InsightResult[];

  const latest = new Map<string, InsightResult>();
  const previous = new Map<string, InsightResult>();
  for (const row of rows) {
    const key = `${row.prompt_id}:${row.provider}`;
    if (!latest.has(key)) latest.set(key, row);
    else if (!previous.has(key)) previous.set(key, row);
  }
  const current = [...latest.values()].filter(row => configured.includes(row.provider));
  const cited = current.filter(r => r.cited && !r.error).length;
  const checks = current.filter(r => !r.error).length;
  const prior = [...previous.values()].filter(r => configured.includes(r.provider) && !r.error);
  const previousVisibility = prior.length ? Math.round((prior.filter(r => r.cited).length / prior.length) * 100) : null;
  const visibility = checks ? Math.round((cited / checks) * 100) : 0;

  const providerInsights = configured.map(provider => {
    const providerRows = current.filter(r => r.provider === provider && !r.error);
    const providerCited = providerRows.filter(r => r.cited).length;
    return { provider, checks: providerRows.length, cited: providerCited, visibility: providerRows.length ? Math.round(providerCited / providerRows.length * 100) : 0 };
  });

  const days = new Map<string, { checks: number; cited: number }>();
  for (const row of [...rows].reverse()) {
    if (row.error || !configured.includes(row.provider)) continue;
    const day = row.created_at.slice(0, 10);
    const item = days.get(day) ?? { checks: 0, cited: 0 };
    item.checks += 1;
    if (row.cited) item.cited += 1;
    days.set(day, item);
  }
  const trend = [...days.entries()].slice(-30).map(([day, item]) => ({
    day, ...item, visibility: item.checks ? Math.round(item.cited / item.checks * 100) : 0,
  }));

  const owned = trackedDomains(workspaceId);
  const competitors = (getWorkspaceSetting(workspaceId, 'ai_competitor_domains') ?? '')
    .split(/[\s,]+/).map(d => d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean);
  const domainMap = new Map<string, { citations: number; providers: Set<Provider> }>();
  for (const row of current) {
    for (const raw of safeArray(row.citations)) {
      const domain = sourceDomain(raw);
      if (!domain) continue;
      const entry = domainMap.get(domain) ?? { citations: 0, providers: new Set<Provider>() };
      entry.citations += 1;
      entry.providers.add(row.provider);
      domainMap.set(domain, entry);
    }
  }
  const matches = (domain: string, candidates: string[]) => candidates.some(candidate => domain === candidate || domain.endsWith(`.${candidate}`));
  const sources = [...domainMap.entries()].map(([domain, item]) => ({
    domain,
    citations: item.citations,
    owned: matches(domain, owned),
    competitor: matches(domain, competitors),
    providers: [...item.providers],
  })).sort((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain)).slice(0, 50);

  const opportunities = prompts.map(prompt => {
    const promptRows = configured.map(provider => latest.get(`${prompt.id}:${provider}`)).filter(Boolean) as InsightResult[];
    const citedProviders = promptRows.filter(r => r.cited && !r.error).map(r => r.provider);
    return {
      promptId: prompt.id, prompt: prompt.prompt, category: prompt.category, siteId: prompt.site_id,
      citedProviders,
      missingProviders: configured.filter(provider => !citedProviders.includes(provider)),
    };
  }).filter(item => item.missingProviders.length > 0)
    .sort((a, b) => b.missingProviders.length - a.missingProviders.length);

  const movements = current.flatMap(row => {
    const priorRow = previous.get(`${row.prompt_id}:${row.provider}`);
    if (!priorRow || Boolean(priorRow.cited) === Boolean(row.cited)) return [];
    return [{
      promptId: row.prompt_id, prompt: row.prompt, provider: row.provider,
      cited: Boolean(row.cited), previousCited: Boolean(priorRow.cited), createdAt: row.created_at,
    }];
  }).slice(0, 20);

  return {
    overview: {
      prompts: prompts.length, configuredProviders: configured.length, checks, cited, visibility,
      previousVisibility,
      change: previousVisibility === null ? null : visibility - previousVisibility,
      sourceDomains: domainMap.size,
    },
    providers: providerInsights, trend, sources, opportunities, movements,
  };
}
