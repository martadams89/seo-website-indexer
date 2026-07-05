/**
 * AI-generated llms.txt — instead of the minimal static manifest, gather real
 * context about the site (homepage + a sample of its actual pages, with their
 * titles/descriptions) and have a configured LLM write a comprehensive,
 * spec-compliant llms.txt. Also produces a deterministic llms-sitemap.xml.
 *
 * Reuses the same provider API keys as citation tracking; picks the first
 * configured provider best-suited to writing. No web-search tools — this is a
 * pure generation call driven entirely by the context we supply.
 */
import { effectiveSetting, getUrlsBySite, type Site } from '../db/database.js';
import { isNonHtmlUrl } from './../indexer/sitemap.js';
import { resolveModel } from './models.js';

// ── Provider text completion (no web search) ─────────────────────────────────

type GenProvider = 'anthropic' | 'openai' | 'gemini' | 'xai' | 'perplexity';
// Order = writing-quality preference.
const GEN_ORDER: GenProvider[] = ['anthropic', 'openai', 'gemini', 'xai', 'perplexity'];
const GEN_KEY: Record<GenProvider, string> = {
  anthropic: 'anthropic_api_key', openai: 'openai_api_key', gemini: 'gemini_api_key',
  xai: 'xai_api_key', perplexity: 'perplexity_api_key',
};

export function llmsGenerationProvider(workspaceId: string | null = null): GenProvider | null {
  return GEN_ORDER.find(p => !!effectiveSetting(workspaceId, GEN_KEY[p])) ?? null;
}

const TIMEOUT = 90_000;

async function complete(provider: GenProvider, key: string, system: string, user: string, modelId?: string): Promise<{ text: string; model: string }> {
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
    xai: { url: 'https://api.x.ai/v1/chat/completions', model: 'grok-2-latest' },
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

// ── Site context gathering ───────────────────────────────────────────────────

function normaliseHost(domain: string): string {
  let host = domain;
  if (host.includes('://')) host = host.split('://')[1];
  return host.split('/')[0];
}

interface PageMeta { url: string; title?: string; description?: string; h1?: string }

function extractMeta(url: string, html: string): PageMeta {
  const pick = (re: RegExp) => (html.match(re)?.[1] ?? '').replace(/\s+/g, ' ').trim() || undefined;
  return {
    url,
    title: pick(/<title[^>]*>([^<]{1,200})<\/title>/i),
    description: pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,300})["']/i)
      ?? pick(/<meta[^>]+content=["']([^"']{1,300})["'][^>]+name=["']description["']/i),
    h1: pick(/<h1[^>]*>([^<]{1,200})<\/h1>/i),
  };
}

async function fetchMeta(url: string): Promise<PageMeta> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'SEO-Website-Indexer/llms-generator' } });
    if (!res.ok) return { url };
    const html = (await res.text()).slice(0, 100_000);
    return extractMeta(url, html);
  } catch { return { url }; }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

const MAX_PAGES = 24;

export interface SiteContext {
  name: string; host: string; homepage: string; sitemap: string;
  home: PageMeta; pages: PageMeta[]; totalUrls: number;
}

export async function gatherSiteContext(site: Site): Promise<SiteContext> {
  const host = normaliseHost(site.domain);
  const homepage = `https://${host}/`;
  const urls = getUrlsBySite(site.id).map(u => u.url).filter(u => !isNonHtmlUrl(u));
  const sample = urls.filter(u => u !== homepage).slice(0, MAX_PAGES);
  const [home, pages] = await Promise.all([
    fetchMeta(homepage),
    mapLimit(sample, 6, fetchMeta),
  ]);
  return {
    name: site.name || host, host, homepage, sitemap: site.sitemap_url || `https://${host}/sitemap.xml`,
    home, pages: pages.filter(p => p.title || p.description || p.h1), totalUrls: urls.length,
  };
}

// ── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert technical writer specialising in GEO (Generative Engine Optimization) and the llms.txt standard (llmstxt.org).

You write llms.txt files: a Markdown file placed at a site's root that helps AI assistants and LLM crawlers understand a site and find its most useful pages.

The required structure is:
1. A single H1 with the site/project name:  # Name
2. Immediately after, a blockquote one-paragraph summary of what the site is and who it's for:  > summary
3. Optionally, a short paragraph or two of extra context (no headings).
4. Then one or more H2 sections (## Section) grouping links. Each link is a bullet:  - [Page title](https://absolute-url): concise description of what's there and why it matters.
5. An optional "## Optional" section at the very end for links that can be skipped if the crawler is short on context.

Rules:
- Output ONLY the raw Markdown content of the llms.txt file. No code fences, no preamble, no explanation.
- Use ABSOLUTE URLs exactly as provided. Never invent URLs, titles, or facts — use only the supplied context.
- Write genuinely useful, specific descriptions (not generic filler). Infer sensible section groupings (e.g. Products, Documentation, Guides, Company, Legal) from the pages.
- Aim for comprehensive but curated: include the site's most valuable pages, well organised. It is fine to omit near-duplicate or low-value URLs, and to put those in "## Optional".
- The summary blockquote must be concrete and specific to THIS site.`;

export function buildUserPrompt(ctx: SiteContext): string {
  const lines: string[] = [];
  lines.push(`Site name: ${ctx.name}`);
  lines.push(`Homepage: ${ctx.homepage}`);
  lines.push(`Sitemap: ${ctx.sitemap}`);
  lines.push(`Total known pages: ${ctx.totalUrls}`);
  lines.push('');
  lines.push('Homepage metadata:');
  lines.push(`- Title: ${ctx.home.title ?? '(none)'}`);
  lines.push(`- Description: ${ctx.home.description ?? '(none)'}`);
  if (ctx.home.h1) lines.push(`- Main heading: ${ctx.home.h1}`);
  lines.push('');
  lines.push(`Pages (title / description / URL), ${ctx.pages.length} sampled:`);
  for (const p of ctx.pages) {
    const title = p.title || p.h1 || '(untitled)';
    const desc = p.description ? ` — ${p.description}` : '';
    lines.push(`- ${title}${desc}\n  ${p.url}`);
  }
  lines.push('');
  lines.push('Write the complete llms.txt for this site now.');
  return lines.join('\n');
}

// ── Public entry point ───────────────────────────────────────────────────────

export interface GeneratedLlms { content: string; provider: GenProvider; model: string; pagesScanned: number }

export async function generateLlmsTxt(site: Site): Promise<GeneratedLlms> {
  const ws = site.workspace_id ?? null;
  const provider = llmsGenerationProvider(ws);
  if (!provider) throw Object.assign(new Error('No AI provider configured. Add an OpenAI, Anthropic, Gemini, xAI or Perplexity key in Settings → API Keys.'), { statusCode: 400 });
  const ctx = await gatherSiteContext(site);
  const key = effectiveSetting(ws, GEN_KEY[provider])!;
  const { text, model } = await complete(provider, key, SYSTEM_PROMPT, buildUserPrompt(ctx), resolveModel(ws, provider));
  // Strip any accidental code fences the model may add.
  const content = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim() + '\n';
  if (content.length < 20) throw new Error('The model returned an empty result — try again or switch provider.');
  return { content, provider, model, pagesScanned: ctx.pages.length };
}
