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
import { assertWithinBudget, listLocalEntities, recordUsage, type LocalEntity } from '../platform/store.js';

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

export type CitationAttributionKind = 'owned_site' | 'third_party_profile' | 'marketplace' | 'brand_mention';

export interface CitationAttribution {
  kind: CitationAttributionKind;
  entity: string;
  matched: string;
  source: string;
  url?: string;
  domain?: string;
}

interface IdentityAlias { value: string; entity: string; explicit: boolean }
interface IdentityProfile { entity: string; provider: string; url: string; domain: string }
interface CitationIdentity {
  domains: Array<{ domain: string; entity: string }>;
  aliases: IdentityAlias[];
  profiles: IdentityProfile[];
}

const MARKETPLACE_SOURCES: Record<string, string> = {
  'play.google.com': 'Google Play',
  'apps.apple.com': 'Apple App Store',
  'g2.com': 'G2',
  'softwareadvice.com': 'Software Advice',
  'capterra.com': 'Capterra',
  'getapp.com': 'GetApp',
  'trustradius.com': 'TrustRadius',
  'sourceforge.net': 'SourceForge',
  'producthunt.com': 'Product Hunt',
  'trustpilot.com': 'Trustpilot',
  'chromewebstore.google.com': 'Chrome Web Store',
  'microsoft.com': 'Microsoft Store',
};

const GENERIC_INFERRED_NAMES = new Set(['app', 'brand', 'company', 'default', 'home', 'platform', 'product', 'site', 'software', 'website']);

function cleanDomain(value: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

function normalizeWords(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function usableAlias(value: string, explicit: boolean): boolean {
  const normalized = normalizeWords(value);
  if (!normalized || normalized.length < 3) return false;
  if (explicit) return true;
  return !GENERIC_INFERRED_NAMES.has(normalized) && (normalized.includes(' ') || normalized.length >= 4);
}

function parseAliasSetting(value: string | null | undefined): string[] {
  return (value ?? '').split(/[\n,]+/).map(item => item.trim()).filter(Boolean).slice(0, 100);
}

function marketplaceSource(domain: string): string | null {
  const match = Object.entries(MARKETPLACE_SOURCES).find(([candidate]) => domain === candidate || domain.endsWith(`.${candidate}`));
  return match?.[1] ?? null;
}

function urlValue(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null;
  try { return new URL(value.trim()).toString(); } catch { return null; }
}

function entityAliases(entity: LocalEntity): string[] {
  const legalName = typeof entity.knowledge.legal_name === 'string' ? entity.knowledge.legal_name : '';
  return [entity.name, legalName].filter(Boolean);
}

function citationIdentity(workspaceId: string | null, siteId: string | null = null): CitationIdentity {
  const sites = workspaceId ? getSitesForWorkspace(workspaceId) : getAllSites();
  const scopedSites = siteId ? sites.filter(site => site.id === siteId) : sites;
  const entities = workspaceId ? listLocalEntities(workspaceId)
    .filter(entity => !siteId || entity.site_id === siteId || entity.site_id === null) : [];
  const domains = scopedSites.map(site => ({ domain: cleanDomain(site.domain), entity: site.name }));
  const aliases: IdentityAlias[] = [];
  const profiles: IdentityProfile[] = [];
  const addAlias = (value: string, entity: string, explicit: boolean) => {
    if (usableAlias(value, explicit)) aliases.push({ value: value.trim(), entity: entity.trim() || value.trim(), explicit });
  };
  for (const site of scopedSites) addAlias(site.name, site.name, false);
  for (const entity of entities) {
    for (const alias of entityAliases(entity)) addAlias(alias, entity.name, false);
    const primaryUrl = urlValue(entity.primary_url);
    if (primaryUrl) {
      const primaryDomain = cleanDomain(primaryUrl);
      if (!marketplaceSource(primaryDomain)) domains.push({ domain: primaryDomain, entity: entity.name });
    }
    const values: Array<{ provider: string; value: unknown }> = [
      ...entity.listings.map(item => ({ provider: item.provider || 'Third-party profile', value: item.url })),
      ...Object.entries(entity.identifiers).map(([provider, value]) => ({ provider, value })),
    ];
    for (const item of values) {
      const url = urlValue(item.value); if (!url) continue;
      const domain = cleanDomain(url);
      profiles.push({ entity: entity.name, provider: marketplaceSource(domain) ?? item.provider.replace(/_/g, ' '), url, domain });
    }
  }
  if (workspaceId) {
    const brandName = getWorkspaceSetting(workspaceId, 'brand_name');
    if (brandName) addAlias(brandName, brandName, true);
    for (const alias of parseAliasSetting(getWorkspaceSetting(workspaceId, 'ai_brand_aliases'))) addAlias(alias, alias, true);
  }
  const uniqueAliases = [...new Map(aliases.sort((a, b) => b.value.length - a.value.length)
    .map(alias => [normalizeWords(alias.value), alias])).values()];
  const uniqueProfiles = [...new Map(profiles.map(profile => [profile.url.toLowerCase(), profile])).values()];
  return { domains: [...new Map(domains.map(item => [item.domain, item])).values()], aliases: uniqueAliases, profiles: uniqueProfiles };
}

function domainMatches(domain: string, candidate: string): boolean {
  return domain === candidate || domain.endsWith(`.${candidate}`);
}

function urlMatchesProfile(value: string, profile: IdentityProfile): boolean {
  try {
    const candidate = new URL(value); const expected = new URL(profile.url);
    if (!domainMatches(cleanDomain(candidate.hostname), cleanDomain(expected.hostname))) return false;
    const candidatePath = candidate.pathname.replace(/\/$/, '').toLowerCase();
    const expectedPath = expected.pathname.replace(/\/$/, '').toLowerCase();
    if (expectedPath && expectedPath !== '/' && candidatePath !== expectedPath && !candidatePath.startsWith(`${expectedPath}/`)) return false;
    for (const [key, expectedValue] of expected.searchParams) if (candidate.searchParams.get(key) !== expectedValue) return false;
    return expectedPath !== '/' || [...expected.searchParams].length > 0;
  } catch { return false; }
}

function aliasInMarketplaceUrl(value: string, alias: IdentityAlias): boolean {
  try {
    const url = new URL(value); if (!marketplaceSource(cleanDomain(url.hostname))) return false;
    const aliasKey = normalizeWords(alias.value).replace(/\s+/g, '');
    const urlKey = normalizeWords(decodeURIComponent(`${url.pathname} ${url.search}`)).replace(/\s+/g, '');
    return aliasKey.length >= 4 && urlKey.includes(aliasKey);
  } catch { return false; }
}

function dedupeAttributions(items: CitationAttribution[]): CitationAttribution[] {
  return [...new Map(items.map(item => [`${item.kind}:${item.entity.toLowerCase()}:${item.url ?? item.matched.toLowerCase()}`, item])).values()];
}

/** Classify visibility independently from where the evidence lives. A brand can
 * be cited through its own domain, a marketplace/profile, or as a named entity. */
export function classifyCitation(answer: ProviderAnswer, identity: CitationIdentity): { cited: boolean; domains: string[]; attributions: CitationAttribution[] } {
  const attributions: CitationAttribution[] = [];
  const answerWords = ` ${normalizeWords(answer.text)} `;
  const directDomains = new Set<string>();

  for (const item of identity.domains) {
    const textHasDomain = answer.text.toLowerCase().includes(item.domain.toLowerCase());
    const citedUrl = answer.citations.find(value => {
      try { return domainMatches(cleanDomain(value), item.domain); } catch { return false; }
    });
    if (!textHasDomain && !citedUrl) continue;
    directDomains.add(item.domain);
    attributions.push({ kind: 'owned_site', entity: item.entity, matched: item.domain, source: 'Owned website',
      ...(citedUrl ? { url: citedUrl, domain: cleanDomain(citedUrl) } : { domain: item.domain }) });
  }

  for (const citation of answer.citations) {
    const domain = cleanDomain(citation);
    const profile = identity.profiles.find(item => urlMatchesProfile(citation, item));
    if (profile) {
      attributions.push({ kind: 'third_party_profile', entity: profile.entity, matched: profile.url,
        source: profile.provider, url: citation, domain });
      continue;
    }
    const alias = identity.aliases.find(item => aliasInMarketplaceUrl(citation, item));
    const source = marketplaceSource(domain);
    if (alias && source) attributions.push({ kind: 'marketplace', entity: alias.entity, matched: alias.value, source, url: citation, domain });
  }

  for (const alias of identity.aliases) {
    const normalized = normalizeWords(alias.value);
    if (normalized && answerWords.includes(` ${normalized} `)) {
      attributions.push({ kind: 'brand_mention', entity: alias.entity, matched: alias.value, source: 'Answer text' });
    }
  }

  const unique = dedupeAttributions(attributions);
  return { cited: unique.length > 0, domains: [...directDomains], attributions: unique };
}

export function getCitationIdentitySummary(workspaceId: string): {
  aliases: string[]; ownedDomains: string[]; profiles: Array<{ entity: string; provider: string; domain: string; url: string }>;
} {
  const identity = citationIdentity(workspaceId);
  return { aliases: identity.aliases.map(item => item.value), ownedDomains: identity.domains.map(item => item.domain), profiles: identity.profiles };
}

function attributionSummary(attributions: CitationAttribution[]): string {
  const direct = attributions.filter(item => item.kind === 'owned_site');
  const thirdParty = attributions.filter(item => item.kind === 'third_party_profile' || item.kind === 'marketplace');
  const mentions = attributions.filter(item => item.kind === 'brand_mention');
  if (direct.length) return `Direct website citation: ${[...new Set(direct.map(item => item.matched))].join(', ')}`;
  if (thirdParty.length) return `Third-party citation via ${[...new Set(thirdParty.map(item => item.source))].join(', ')}`;
  if (mentions.length) return `Brand/entity mentioned: ${[...new Set(mentions.map(item => item.entity))].join(', ')}`;
  return 'No tracked brand, entity, profile or owned website was found.';
}

export const PROMPT_CATEGORIES = ['discovery', 'comparison', 'commercial', 'brand', 'support'] as const;
export type PromptCategory = typeof PROMPT_CATEGORIES[number];

export interface PromptRow {
  id: number; workspace_id: string | null; site_id: string | null; prompt: string;
  category: PromptCategory; group_name: string; locale: string; device: string; persona: string | null;
  cadence: 'manual' | 'daily' | 'weekly' | 'monthly'; next_run_at: string | null; last_run_at: string | null;
  enabled: number; schema_version: number; created_at: string;
}

export interface LegacyPromptPlan {
  prompts: Array<{
    id: number; prompt: string; result_count: number; suggested_category: PromptCategory;
    category: PromptCategory; group_name: string; locale: string; device: string; cadence: PromptRow['cadence'];
  }>;
  prompt_count: number;
  result_count: number;
}

export interface LegacyPromptUpgrade {
  group_name?: string; locale?: string; device?: string; persona?: string | null;
  cadence?: PromptRow['cadence']; site_id?: string | null; categories?: Record<string, PromptCategory>;
}

/** Prompts for one workspace (the tenant boundary). */
export function listPrompts(workspaceId: string | null = null): PromptRow[] {
  if (workspaceId) {
    return getDb().prepare('SELECT * FROM ai_prompts WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId) as PromptRow[];
  }
  return getDb().prepare('SELECT * FROM ai_prompts ORDER BY created_at DESC').all() as PromptRow[];
}

function suggestedCategory(prompt: string): PromptCategory {
  const text = prompt.toLowerCase();
  if (/\b(vs\.?|versus|compare|comparison|alternative|difference between)\b/.test(text)) return 'comparison';
  if (/\b(how (?:do|can|should) i|how to|set ?up|configure|fix|troubleshoot|integrat(?:e|ion))\b/.test(text)) return 'support';
  if (/\b(best|top|recommend|shortlist|buy|pricing|price|cost|provider|agency|service|software|platform|tool)\b/.test(text)) return 'commercial';
  if (/\b(what is|who is|reviews? of|is .+ (?:good|legit|reliable))\b/.test(text)) return 'brand';
  return 'discovery';
}

/** Identify pre-structured prompts without mutating them. */
export function getLegacyPromptPlan(workspaceId: string): LegacyPromptPlan {
  const prompts = getDb().prepare(`
    SELECT p.*, COUNT(r.id) result_count
    FROM ai_prompts p LEFT JOIN ai_results r ON r.prompt_id=p.id
    WHERE p.workspace_id=? AND COALESCE(p.schema_version,1)<2
    GROUP BY p.id ORDER BY p.created_at, p.id
  `).all(workspaceId) as Array<PromptRow & { result_count: number }>;
  const rows = prompts.map(row => ({ id: row.id, prompt: row.prompt, result_count: Number(row.result_count),
    suggested_category: suggestedCategory(row.prompt), category: row.category, group_name: row.group_name,
    locale: row.locale, device: row.device, cadence: row.cadence }));
  return { prompts: rows, prompt_count: rows.length, result_count: rows.reduce((sum, row) => sum + row.result_count, 0) };
}

export function addPrompt(
  prompt: string,
  siteId?: string | null,
  workspaceId: string | null = null,
  category: PromptCategory = 'discovery',
  schedule: Partial<Pick<PromptRow, 'group_name' | 'locale' | 'device' | 'persona' | 'cadence'>> = {},
): PromptRow {
  const safeCategory = PROMPT_CATEGORIES.includes(category) ? category : 'discovery';
  const cadence = ['manual', 'daily', 'weekly', 'monthly'].includes(schedule.cadence ?? '') ? schedule.cadence! : 'manual';
  const next = cadence === 'manual' ? null : new Date().toISOString();
  const r = getDb().prepare(`INSERT INTO ai_prompts(site_id,prompt,workspace_id,category,group_name,locale,device,persona,cadence,next_run_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(siteId ?? null, prompt, workspaceId, safeCategory, schedule.group_name?.trim() || 'Core prompts',
      schedule.locale?.trim() || 'en-GB', schedule.device?.trim() || 'desktop', schedule.persona?.trim() || null, cadence, next);
  return getDb().prepare('SELECT * FROM ai_prompts WHERE id = ?').get(r.lastInsertRowid) as PromptRow;
}

function nextPromptRun(cadence: PromptRow['cadence']): string | null {
  const next = new Date();
  if (cadence === 'daily') next.setUTCDate(next.getUTCDate() + 1);
  else if (cadence === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
  else if (cadence === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1);
  else return null;
  return next.toISOString();
}

type PromptChanges = Partial<Pick<PromptRow, 'prompt' | 'site_id' | 'category' | 'group_name' | 'locale' | 'device' | 'persona' | 'cadence' | 'enabled'>>;

function persistPromptUpdate(current: PromptRow, workspaceId: string, changes: PromptChanges, changedBy: string | null, reason: 'edit' | 'legacy_upgrade'): void {
  const db = getDb();
  const cadence = changes.cadence && ['manual','daily','weekly','monthly'].includes(changes.cadence) ? changes.cadence : current.cadence;
  const category = changes.category && PROMPT_CATEGORIES.includes(changes.category) ? changes.category : current.category;
  db.prepare(`INSERT INTO ai_prompt_revisions(prompt_id,workspace_id,snapshot,reason,changed_by) VALUES(?,?,?,?,?)`)
    .run(current.id, workspaceId, JSON.stringify(current), reason, changedBy);
  // Old root results did not retain the exact question. Snapshot it before an
  // edit so historic answers continue to display beside what was really asked.
  db.prepare('UPDATE ai_results SET user_prompt=? WHERE prompt_id=? AND user_prompt IS NULL').run(current.prompt, current.id);
  db.prepare(`UPDATE ai_prompts SET prompt=?,site_id=?,category=?,group_name=?,locale=?,device=?,persona=?,cadence=?,enabled=?,schema_version=2,
    next_run_at=CASE WHEN ?='manual' THEN NULL WHEN cadence!=? OR next_run_at IS NULL THEN datetime('now') ELSE next_run_at END
    WHERE id=? AND workspace_id=?`).run(changes.prompt?.trim() || current.prompt, changes.site_id === undefined ? current.site_id : changes.site_id,
      category, changes.group_name?.trim() || current.group_name, changes.locale?.trim() || current.locale,
      changes.device?.trim() || current.device, changes.persona === undefined ? current.persona : (changes.persona?.trim() || null), cadence,
      changes.enabled === undefined ? current.enabled : changes.enabled, cadence, cadence, current.id, workspaceId);
}

export function updatePrompt(id: number, workspaceId: string, changes: PromptChanges, changedBy: string | null = null): PromptRow | null {
  const current = getPrompt(id, workspaceId); if (!current) return null;
  getDb().transaction(() => persistPromptUpdate(current, workspaceId, changes, changedBy, 'edit'))();
  return getPrompt(id, workspaceId) ?? null;
}

/** Convert v1 prompts to the structured library in place. Prompt/result IDs
 * stay stable, every previous prompt is revisioned, and all result rows remain. */
export function upgradeLegacyPrompts(workspaceId: string, input: LegacyPromptUpgrade, changedBy: string | null = null): { prompts_upgraded: number; results_preserved: number } {
  const plan = getLegacyPromptPlan(workspaceId);
  if (!plan.prompt_count) return { prompts_upgraded: 0, results_preserved: 0 };
  const cadence = input.cadence && ['manual','daily','weekly','monthly'].includes(input.cadence) ? input.cadence : 'manual';
  getDb().transaction(() => {
    for (const item of plan.prompts) {
      const current = getPrompt(item.id, workspaceId); if (!current || current.schema_version >= 2) continue;
      const requested = input.categories?.[String(item.id)];
      persistPromptUpdate(current, workspaceId, {
        category: requested && PROMPT_CATEGORIES.includes(requested) ? requested : item.suggested_category,
        group_name: input.group_name?.trim() || 'Imported citation prompts',
        locale: input.locale?.trim() || 'en-GB', device: input.device?.trim() || 'desktop',
        persona: input.persona?.trim() || null, cadence,
        site_id: input.site_id === undefined ? current.site_id : input.site_id,
      }, changedBy, 'legacy_upgrade');
    }
  })();
  return { prompts_upgraded: plan.prompt_count, results_preserved: plan.result_count };
}

export function listDuePrompts(limit = 50): PromptRow[] {
  return getDb().prepare(`SELECT * FROM ai_prompts WHERE enabled=1 AND cadence!='manual' AND
    (next_run_at IS NULL OR julianday(next_run_at)<=julianday('now')) ORDER BY COALESCE(next_run_at,created_at) LIMIT ?`).all(limit) as PromptRow[];
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
    const rows = getDb().prepare(`
      SELECT r.*, p.prompt, p.site_id FROM ai_results r
      JOIN ai_prompts p ON p.id = r.prompt_id
      WHERE p.workspace_id = ?
      ORDER BY r.created_at DESC LIMIT ?
    `).all(workspaceId, limit) as Array<Record<string, unknown>>;
    return rows.map(row => decorateStoredResult(row, citationIdentity(workspaceId, String(row.site_id ?? '') || null)));
  }
  const rows = getDb().prepare(`
    SELECT r.*, p.prompt, p.site_id FROM ai_results r
    JOIN ai_prompts p ON p.id = r.prompt_id
    ORDER BY r.created_at DESC LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
  return rows.map(row => decorateStoredResult(row, citationIdentity(null, String(row.site_id ?? '') || null)));
}

/** Run one prompt against every configured provider; persist + return results. */
export async function runPrompt(promptId: number, workspaceId: string | null = null): Promise<Array<Record<string, unknown>>> {
  const db = getDb();
  const row = getPrompt(promptId, workspaceId);
  if (!row) throw new Error('Prompt not found');
  const identity = citationIdentity(workspaceId, row.site_id);
  const providers = configuredProviders(workspaceId);
  if (providers.length === 0) throw new Error('No AI provider API keys configured (Settings)');

  const insert = db.prepare(`
    INSERT INTO ai_results(prompt_id, provider, model, cited, domains, attributions, attribution_version, excerpt, error, parent_id, citations, user_prompt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const movements: Array<{ provider: Provider; cited: boolean; sourceChanged?: boolean }> = [];
  const results = await Promise.all(providers.map(async provider => {
    if (workspaceId) assertWithinBudget({ workspaceId, provider, quantity: 1 });
    const key = effectiveSetting(workspaceId, KEY_SETTING[provider])!;
    const previous = db.prepare(`
      SELECT cited,citations,excerpt FROM ai_results
      WHERE prompt_id = ? AND provider = ? AND parent_id IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(promptId, provider) as { cited: number; citations: string | null; excerpt: string | null } | undefined;
    try {
      const modelId = provider === 'brave' ? undefined : resolveModel(workspaceId, provider as ModelProvider);
      const context = [row.locale ? `Locale: ${row.locale}.` : '', row.device ? `Device context: ${row.device}.` : '', row.persona ? `Audience persona: ${row.persona}.` : ''].filter(Boolean).join(' ');
      const answer = await ASK[provider]([{ role: 'user', content: context ? `${row.prompt}\n\n${context}` : row.prompt }], key, modelId);
      const attribution = classifyCitation(answer, identity);
      const previousAttribution = previous ? classifyCitation({ text: previous.excerpt ?? '', model: '', citations: safeArray(previous.citations) }, identity) : null;
      const currentSources = [...new Set(answer.citations.map(sourceDomain).filter((value): value is string => !!value))];
      const previousSources = [...new Set(safeArray(previous?.citations).map(sourceDomain).filter((value): value is string => !!value))];
      const addedSources = currentSources.filter(source => !previousSources.includes(source));
      const removedSources = previousSources.filter(source => !currentSources.includes(source));
      // Full response (bounded) — the dashboard renders it as a scrollable chat bubble.
      const text = answer.text.trim().slice(0, 12_000);
      insert.run(promptId, provider, answer.model, attribution.cited ? 1 : 0, JSON.stringify(attribution.domains), JSON.stringify(attribution.attributions), 1, text, null,
        null, JSON.stringify(answer.citations.slice(0, 40)), row.prompt);
      if (previousAttribution && previousAttribution.cited !== attribution.cited) {
        const gained = attribution.cited;
        const label = PROVIDER_LABELS[provider] ?? provider;
        recordAlert(
          row.site_id,
          'citation',
          `${gained ? 'Citation gained' : 'Citation lost'} on ${label}: “${row.prompt.slice(0, 90)}”`,
          gained ? 'info' : 'warn',
          gained ? attributionSummary(attribution.attributions) : 'The latest answer no longer cites a tracked brand, entity, profile or owned website.',
          workspaceId,
        );
        movements.push({ provider, cited: gained });
      } else if (previous && (addedSources.length || removedSources.length)) {
        const label = PROVIDER_LABELS[provider] ?? provider;
        recordAlert(row.site_id, 'citation', `Answer sources changed on ${label}: “${row.prompt.slice(0, 90)}”`, 'info',
          `${addedSources.length ? `Added ${addedSources.join(', ')}. ` : ''}${removedSources.length ? `Removed ${removedSources.join(', ')}.` : ''}`.trim(), workspaceId);
        movements.push({ provider, cited: attribution.cited, sourceChanged: true });
      }
      logSystem(attribution.cited ? 'ok' : 'info',
        `AI citation [${provider}] ${attribution.cited ? attributionSummary(attribution.attributions) : 'not cited'} — "${row.prompt.slice(0, 60)}"`);
      if (workspaceId) recordUsage({ workspace_id: workspaceId, user_id: null, provider, operation: 'ai.visibility_check', quantity: 1, unit: 'check', estimated_cost: 0,
        metadata: { prompt_id: promptId, model: answer.model, cited: attribution.cited, attribution_kinds: [...new Set(attribution.attributions.map(item => item.kind))], group: row.group_name, locale: row.locale, device: row.device } });
      return { provider, model: answer.model, cited: attribution.cited, domains: attribution.domains, attributions: attribution.attributions, excerpt: text };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      insert.run(promptId, provider, null, 0, '[]', '[]', 1, null, msg.slice(0, 300), null, '[]', row.prompt);
      logSystem('warn', `AI citation [${provider}] failed: ${msg.slice(0, 120)}`);
      return { provider, model: null, cited: false, domains: [], error: msg };
    }
  }));
  if (workspaceId && movements.length > 0 && notificationEventEnabled(workspaceId, 'citation_changes')) {
    const sourceChanges = movements.filter(m => m.sourceChanged).length;
    const citationMoves = movements.filter(m => !m.sourceChanged); const gained = citationMoves.filter(m => m.cited).length;
    const lost = citationMoves.length - gained;
    const body = `${gained} citation${gained === 1 ? '' : 's'} gained, ${lost} lost, ${sourceChanges} answer source set${sourceChanges === 1 ? '' : 's'} changed for “${row.prompt.slice(0, 100)}”.`;
    sendWorkspaceNotification(workspaceId, 'AI visibility changed', body, 'citation_changes').catch(() => null);
  }
  db.prepare('UPDATE ai_prompts SET last_run_at=datetime(\'now\'),next_run_at=? WHERE id=?').run(nextPromptRun(row.cadence), row.id);
  return results;
}

export async function runDuePrompts(): Promise<number> {
  const prompts = listDuePrompts(); let completed = 0;
  for (const prompt of prompts) {
    try { await runPrompt(prompt.id, prompt.workspace_id); completed++; } catch { /* result errors and connector health are retained */ }
  }
  return completed;
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
  attributions: string | null; attribution_version: number;
  parent_id: number | null; citations: string | null; user_prompt: string | null; site_id?: string | null;
  created_at: string;
}

/** Root result + follow-ups for one workspace-scoped prompt × provider. */
export function getThread(promptId: number, provider: string, workspaceId: string | null = null): AiResultRow[] {
  if (workspaceId) {
    const rows = getDb().prepare(`
      SELECT r.*,p.site_id FROM ai_results r
      JOIN ai_prompts p ON p.id = r.prompt_id
      WHERE r.prompt_id = ? AND r.provider = ? AND p.workspace_id = ?
      ORDER BY r.id ASC
    `).all(promptId, provider, workspaceId) as AiResultRow[];
    return rows.map(row => decorateStoredResult(row, citationIdentity(workspaceId, row.site_id ?? null)) as unknown as AiResultRow);
  }
  const rows = getDb().prepare(`SELECT r.*,p.site_id FROM ai_results r JOIN ai_prompts p ON p.id=r.prompt_id
    WHERE r.prompt_id=? AND r.provider=? ORDER BY r.id ASC`).all(promptId, provider) as AiResultRow[];
  return rows.map(row => decorateStoredResult(row, citationIdentity(null, row.site_id ?? null)) as unknown as AiResultRow);
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

  const identity = citationIdentity(workspaceId, promptRow.site_id);
  const parent = getThread(promptId, provider, workspaceId).at(-1);
  const modelId = resolveModel(workspaceId, provider as ModelProvider);
  const answer = await ASK[provider](turns, key, modelId);
  const attribution = classifyCitation(answer, identity);
  const text = answer.text.trim().slice(0, 12_000);
  const res = db.prepare(`
    INSERT INTO ai_results(prompt_id, provider, model, cited, domains, attributions, attribution_version, excerpt, error, parent_id, citations, user_prompt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(promptId, provider, answer.model, attribution.cited ? 1 : 0, JSON.stringify(attribution.domains), JSON.stringify(attribution.attributions), 1, text, null,
    parent?.id ?? null, JSON.stringify(answer.citations.slice(0, 40)), followUp);
  logSystem(attribution.cited ? 'ok' : 'info', `AI follow-up [${provider}] ${attribution.cited ? attributionSummary(attribution.attributions) : 'not cited'}`);
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
    directCitations: number;
    thirdPartyCitations: number;
    mentionOnlyCitations: number;
  };
  providers: Array<{ provider: Provider; checks: number; cited: number; visibility: number }>;
  trend: Array<{ day: string; checks: number; cited: number; visibility: number }>;
  sources: Array<{ domain: string; citations: number; owned: boolean; competitor: boolean; attributed: boolean;
    attributionKinds: CitationAttributionKind[]; entities: string[]; providers: Provider[] }>;
  opportunities: Array<{
    promptId: number; prompt: string; category: PromptCategory; siteId: string | null;
    citedProviders: Provider[]; missingProviders: Provider[];
  }>;
  movements: Array<{
    promptId: number; prompt: string; provider: Provider; cited: boolean; previousCited: boolean; createdAt: string;
    addedSources: string[]; removedSources: string[]; answerChanged: boolean;
  }>;
}

function safeArray(value: string | null | undefined): string[] {
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

function safeAttributions(value: unknown): CitationAttribution[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(item => item && typeof item === 'object' && typeof item.kind === 'string' && typeof item.entity === 'string') as CitationAttribution[];
  } catch { return []; }
}

function decorateStoredResult<T extends object>(row: T, identity: CitationIdentity): T {
  const value = row as Record<string, unknown>;
  if (value.error) return { ...row, cited: 0, domains: '[]', attributions: '[]', attribution_version: 1 } as T;
  const classification = classifyCitation({
    text: typeof value.excerpt === 'string' ? value.excerpt : '',
    model: typeof value.model === 'string' ? value.model : '',
    citations: safeArray(typeof value.citations === 'string' ? value.citations : null),
  }, identity);
  return { ...row, cited: classification.cited ? 1 : 0, domains: JSON.stringify(classification.domains),
    attributions: JSON.stringify(classification.attributions), attribution_version: 1 } as T;
}

/** Portfolio-level GEO intelligence derived from root runs only. */
export function getAiInsights(workspaceId: string | null): AiInsights {
  const empty: AiInsights = {
    overview: { prompts: 0, configuredProviders: 0, checks: 0, cited: 0, visibility: 0, previousVisibility: null, change: null, sourceDomains: 0,
      directCitations: 0, thirdPartyCitations: 0, mentionOnlyCitations: 0 },
    providers: [], trend: [], sources: [], opportunities: [], movements: [],
  };
  if (!workspaceId) return empty;

  const prompts = listPrompts(workspaceId);
  const configured = configuredProviders(workspaceId);
  const rawRows = getDb().prepare(`
    SELECT r.*, p.prompt, p.category, p.site_id
    FROM ai_results r JOIN ai_prompts p ON p.id = r.prompt_id
    WHERE p.workspace_id = ? AND r.parent_id IS NULL
    ORDER BY r.created_at DESC, r.id DESC
  `).all(workspaceId) as InsightResult[];
  const identityCache = new Map<string, CitationIdentity>();
  const identityFor = (siteId: string | null) => {
    const key = siteId ?? '*';
    if (!identityCache.has(key)) identityCache.set(key, citationIdentity(workspaceId, siteId));
    return identityCache.get(key)!;
  };
  const rows = rawRows.map(row => decorateStoredResult(row as unknown as Record<string, unknown>, identityFor(row.site_id)) as unknown as InsightResult);

  const latest = new Map<string, InsightResult>();
  const previous = new Map<string, InsightResult>();
  for (const row of rows) {
    const key = `${row.prompt_id}:${row.provider}`;
    if (!latest.has(key)) latest.set(key, row);
    else if (!previous.has(key)) previous.set(key, row);
  }
  const current = [...latest.values()].filter(row => configured.includes(row.provider));
  const cited = current.filter(r => r.cited && !r.error).length;
  const currentAttributions = current.map(row => ({ row, items: safeAttributions(row.attributions) }));
  const directCitations = currentAttributions.filter(({ items }) => items.some(item => item.kind === 'owned_site')).length;
  const thirdPartyCitations = currentAttributions.filter(({ items }) => items.some(item => item.kind === 'third_party_profile' || item.kind === 'marketplace')).length;
  const mentionOnlyCitations = currentAttributions.filter(({ items }) => items.some(item => item.kind === 'brand_mention')
    && !items.some(item => item.kind === 'owned_site' || item.kind === 'third_party_profile' || item.kind === 'marketplace')).length;
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

  const owned = citationIdentity(workspaceId).domains.map(item => item.domain);
  const competitors = (getWorkspaceSetting(workspaceId, 'ai_competitor_domains') ?? '')
    .split(/[\s,]+/).map(d => d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean);
  const domainMap = new Map<string, { citations: number; providers: Set<Provider>; attributionKinds: Set<CitationAttributionKind>; entities: Set<string> }>();
  for (const row of current) {
    const attributions = safeAttributions(row.attributions);
    for (const raw of safeArray(row.citations)) {
      const domain = sourceDomain(raw);
      if (!domain) continue;
      const entry = domainMap.get(domain) ?? { citations: 0, providers: new Set<Provider>(), attributionKinds: new Set<CitationAttributionKind>(), entities: new Set<string>() };
      entry.citations += 1;
      entry.providers.add(row.provider);
      for (const item of attributions.filter(attribution => attribution.domain && domainMatches(domain, attribution.domain))) {
        entry.attributionKinds.add(item.kind); entry.entities.add(item.entity);
      }
      domainMap.set(domain, entry);
    }
  }
  const matches = (domain: string, candidates: string[]) => candidates.some(candidate => domain === candidate || domain.endsWith(`.${candidate}`));
  const sources = [...domainMap.entries()].map(([domain, item]) => ({
    domain,
    citations: item.citations,
    owned: matches(domain, owned),
    competitor: matches(domain, competitors),
    attributed: item.attributionKinds.size > 0,
    attributionKinds: [...item.attributionKinds],
    entities: [...item.entities],
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
    if (!priorRow) return [];
    const currentSources = [...new Set(safeArray(row.citations).map(sourceDomain).filter((value): value is string => !!value))];
    const previousSources = [...new Set(safeArray(priorRow.citations).map(sourceDomain).filter((value): value is string => !!value))];
    const addedSources = currentSources.filter(source => !previousSources.includes(source));
    const removedSources = previousSources.filter(source => !currentSources.includes(source));
    const answerChanged = (row.excerpt ?? '').trim() !== (priorRow.excerpt ?? '').trim();
    if (Boolean(priorRow.cited) === Boolean(row.cited) && !addedSources.length && !removedSources.length && !answerChanged) return [];
    return [{
      promptId: row.prompt_id, prompt: row.prompt, provider: row.provider,
      cited: Boolean(row.cited), previousCited: Boolean(priorRow.cited), createdAt: row.created_at,
      addedSources, removedSources, answerChanged,
    }];
  }).slice(0, 20);

  return {
    overview: {
      prompts: prompts.length, configuredProviders: configured.length, checks, cited, visibility,
      previousVisibility,
      change: previousVisibility === null ? null : visibility - previousVisibility,
      sourceDomains: domainMap.size,
      directCitations, thirdPartyCitations, mentionOnlyCitations,
    },
    providers: providerInsights, trend, sources, opportunities, movements,
  };
}
