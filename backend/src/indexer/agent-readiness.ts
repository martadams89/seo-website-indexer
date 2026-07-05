/**
 * Agent-readiness scoring — a native, self-hosted equivalent of the checks run
 * by isitagentready.com, so each tracked site gets an "how discoverable/usable
 * am I to AI agents?" score as a first-class metric alongside indexing and
 * search performance.
 *
 * We run the checks ourselves (no third-party dependency): fetch the site's
 * homepage + well-known endpoints, probe content negotiation and the MCP
 * surface, and look up the DNS-AID record. Everything is weighted into a single
 * 0-100 score plus a per-check breakdown with a remediation hint.
 *
 * `scoreChecks` and the pure `detect*` helpers are exported for unit testing so
 * the network layer never has to run in CI.
 */
import { resolveTxt } from 'node:dns/promises';
import type { Site } from '../db/database.js';

export type AgentCheckCategory = 'discovery' | 'content' | 'protocol' | 'identity' | 'dns';

export interface AgentCheck {
  id: string;
  label: string;
  category: AgentCheckCategory;
  pass: boolean;
  weight: number;
  detail: string;
  /** One-line remediation shown when the check fails. */
  fix?: string;
}

export interface AgentReadinessResult {
  score: number;      // 0..100, weighted
  passed: number;     // checks passed
  total: number;      // checks run
  checks: AgentCheck[];
}

const UA = 'SEOWebsiteIndexer/1.0 (agent-readiness)';
const TIMEOUT = 12_000;

interface Fetched { status: number; ok: boolean; ct: string; headers: Headers; text: string }

async function grab(url: string, accept?: string): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}) },
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: 'follow',
    });
    const ct = res.headers.get('content-type') || '';
    // Cap body reads so a giant page can't blow memory.
    const text = res.ok ? (await res.text()).slice(0, 400_000) : '';
    return { status: res.status, ok: res.ok, ct, headers: res.headers, text };
  } catch {
    return { status: 0, ok: false, ct: '', headers: new Headers(), text: '' };
  }
}

async function grabMcp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: UA, version: '1.0' } } }),
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: 'follow',
    });
    if (!res.ok) return false;
    const j = await res.json().catch(() => null) as { result?: { protocolVersion?: string; serverInfo?: unknown } } | null;
    return !!(j && j.result && (j.result.protocolVersion || j.result.serverInfo));
  } catch { return false; }
}

// ── Pure detectors (unit-tested offline) ──────────────────────────────────────

const AI_BOTS = ['GPTBot', 'ClaudeBot', 'Claude-Web', 'PerplexityBot', 'Google-Extended', 'CCBot', 'anthropic-ai'];

/** True unless robots.txt blocks the AI crawlers with a global Disallow: /. */
export function robotsAllowsAi(robots: string): boolean {
  if (!robots.trim()) return false;
  // Split into per-user-agent groups.
  const lines = robots.split('\n').map(l => l.replace(/#.*$/, '').trim());
  let agents: string[] = [];
  const blocked = new Set<string>();
  for (const l of lines) {
    const ua = l.match(/^user-agent:\s*(.+)$/i);
    if (ua) { agents.push(ua[1].trim()); continue; }
    const dis = l.match(/^disallow:\s*(.*)$/i);
    if (dis && agents.length) {
      if (dis[1].trim() === '/') for (const a of agents) blocked.add(a.toLowerCase());
    }
    if (l === '') agents = [];
  }
  if (blocked.has('*')) return false;
  return !AI_BOTS.some(b => blocked.has(b.toLowerCase()));
}

/** contentsignals.org Content-Signal directives present (robots.txt or header). */
export function hasContentSignal(robots: string, header: string | null): boolean {
  return /content-signal:/i.test(robots) || /content-signal/i.test(header || '');
}

export function hasJsonLd(html: string): boolean {
  return /<script[^>]+type=["']application\/ld\+json["'][^>]*>/i.test(html);
}

export function hasMetaDescription(html: string): boolean {
  return /<meta[^>]+name=["']description["'][^>]+content=["'][^"']+["']/i.test(html)
    || /<meta[^>]+property=["']og:description["']/i.test(html);
}

/** WebMCP: page wires navigator.modelContext.provideContext(). */
export function hasWebMcp(html: string): boolean {
  return /navigator\.modelContext/.test(html) || /modelContext\.provideContext/.test(html);
}

/** Homepage advertises llms.txt / api-catalog / MCP via an RFC 8288 Link. */
export function hasAgentLink(html: string, linkHeader: string | null): boolean {
  const hay = `${linkHeader || ''}\n${html}`;
  return /rel=["']?(llms|api-catalog|service-desc|self)["']?/i.test(hay)
    && /(llms\.txt|api-catalog|mcp)/i.test(hay);
}

/** Response actually came back as markdown for an Accept: text/markdown request. */
export function isMarkdownResponse(f: { ct: string; text: string }): boolean {
  if (/text\/markdown/i.test(f.ct)) return true;
  // Some servers return markdown with a generic content-type; sniff the body.
  return !/<html[\s>]/i.test(f.text) && /^#{1,3}\s|\]\(https?:/m.test(f.text);
}

export function isValidJwks(text: string): boolean {
  try {
    const j = JSON.parse(text) as { keys?: Array<{ kty?: string }> };
    return Array.isArray(j.keys) && j.keys.length > 0 && !!j.keys[0].kty;
  } catch { return false; }
}

/** Weighted 0-100 score from a set of checks. */
export function scoreChecks(checks: AgentCheck[]): { score: number; passed: number; total: number } {
  const totalWeight = checks.reduce((s, c) => s + c.weight, 0) || 1;
  const gotWeight = checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  return {
    score: Math.round((gotWeight / totalWeight) * 100),
    passed: checks.filter(c => c.pass).length,
    total: checks.length,
  };
}

// ── Live check runner ─────────────────────────────────────────────────────────

function originOf(site: Site): string {
  const d = site.domain.startsWith('http') ? site.domain : `https://${site.domain}`;
  return d.replace(/\/+$/, '');
}

function hostOf(site: Site): string {
  try { return new URL(originOf(site)).hostname; } catch { return site.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
}

async function dnsAidPresent(host: string): Promise<boolean> {
  try {
    const records = await resolveTxt(`_index._agents.${host}`);
    const flat = records.map(r => r.join('')).join(' ');
    return /aid1|endpoint=|mcp=/i.test(flat);
  } catch { return false; }
}

export async function checkAgentReadiness(site: Site): Promise<AgentReadinessResult> {
  const origin = originOf(site);
  const host = hostOf(site);

  const [
    home, robots, llms, llmsFull, sitemap, securityTxt, aiTxt,
    mcpCard, apiCatalog, agentSkills, webBotAuth, authMd, oauthPr, oidc, mdNeg,
    mcpOk, dnsAid,
  ] = await Promise.all([
    grab(`${origin}/`),
    grab(`${origin}/robots.txt`),
    grab(`${origin}/llms.txt`),
    grab(`${origin}/llms-full.txt`),
    grab(`${origin}/sitemap.xml`),
    grab(`${origin}/.well-known/security.txt`),
    grab(`${origin}/ai.txt`),
    grab(`${origin}/.well-known/mcp.json`),
    grab(`${origin}/.well-known/api-catalog`),
    grab(`${origin}/.well-known/agent-skills/index.json`),
    grab(`${origin}/.well-known/http-message-signatures-directory`),
    grab(`${origin}/auth.md`),
    grab(`${origin}/.well-known/oauth-protected-resource`),
    grab(`${origin}/.well-known/openid-configuration`),
    grab(`${origin}/`, 'text/markdown'),
    grabMcp(`${origin}/mcp`),
    dnsAidPresent(host),
  ]);

  const mk = (id: string, label: string, category: AgentCheckCategory, pass: boolean, weight: number, detail: string, fix: string): AgentCheck =>
    ({ id, label, category, pass, weight, detail, ...(pass ? {} : { fix }) });

  const checks: AgentCheck[] = [
    // Discovery
    mk('robots', 'robots.txt', 'discovery', robots.ok, 2,
      robots.ok ? 'Present' : 'Not found', 'Publish /robots.txt.'),
    mk('robots_ai', 'AI crawlers allowed', 'discovery', robots.ok && robotsAllowsAi(robots.text), 2,
      robots.ok ? (robotsAllowsAi(robots.text) ? 'GPTBot/ClaudeBot/etc not blocked' : 'AI bots are Disallowed') : 'No robots.txt', 'Remove blanket Disallow: / for AI user-agents.'),
    mk('content_signal', 'Content-Signal policy', 'discovery', hasContentSignal(robots.text, robots.headers.get('content-signal')), 1,
      hasContentSignal(robots.text, robots.headers.get('content-signal')) ? 'Declared' : 'Missing', 'Add contentsignals.org Content-Signal directives to robots.txt.'),
    mk('llms', 'llms.txt', 'discovery', llms.ok && /^#\s/m.test(llms.text), 3,
      llms.ok ? 'Present' : 'Not found', 'Publish /llms.txt with a top-level "# Title".'),
    mk('llms_full', 'llms-full.txt', 'discovery', llmsFull.ok, 1,
      llmsFull.ok ? 'Present' : 'Not found', 'Publish /llms-full.txt with full-text content.'),
    mk('sitemap', 'sitemap.xml', 'discovery', sitemap.ok, 1,
      sitemap.ok ? 'Present' : 'Not found', 'Publish /sitemap.xml.'),
    mk('security_txt', 'security.txt (RFC 9116)', 'identity', securityTxt.ok, 1,
      securityTxt.ok ? 'Present' : 'Not found', 'Publish /.well-known/security.txt.'),
    mk('ai_txt', 'ai.txt', 'discovery', aiTxt.ok, 1,
      aiTxt.ok ? 'Present' : 'Not found', 'Publish /ai.txt with your AI-usage policy.'),

    // Structured content
    mk('jsonld', 'JSON-LD structured data', 'content', hasJsonLd(home.text), 2,
      hasJsonLd(home.text) ? 'Found on homepage' : 'None on homepage', 'Add schema.org JSON-LD to your pages.'),
    mk('meta', 'Meta / OG description', 'content', hasMetaDescription(home.text), 1,
      hasMetaDescription(home.text) ? 'Present' : 'Missing', 'Add a <meta name="description"> and OpenGraph tags.'),
    mk('markdown', 'Markdown content negotiation', 'content', isMarkdownResponse(mdNeg), 2,
      isMarkdownResponse(mdNeg) ? 'Serves text/markdown on request' : 'Only HTML', 'Serve text/markdown when Accept: text/markdown is sent.'),

    // Agent protocol surface
    mk('mcp_card', 'MCP Server Card', 'protocol', mcpCard.ok && /"endpoint"|"tools"/.test(mcpCard.text), 3,
      mcpCard.ok ? 'Present' : 'Not found', 'Publish /.well-known/mcp.json describing your MCP server.'),
    mk('mcp_endpoint', 'MCP endpoint (/mcp)', 'protocol', mcpOk, 3,
      mcpOk ? 'Responds to initialize' : 'No JSON-RPC response', 'Expose an MCP endpoint at /mcp.'),
    mk('api_catalog', 'api-catalog (RFC 9727)', 'protocol', apiCatalog.ok, 2,
      apiCatalog.ok ? 'Present' : 'Not found', 'Publish /.well-known/api-catalog (application/linkset+json).'),
    mk('link_header', 'Agent Link relations (RFC 8288)', 'protocol', hasAgentLink(home.text, home.headers.get('link')), 1,
      hasAgentLink(home.text, home.headers.get('link')) ? 'Advertised' : 'Missing', 'Advertise llms.txt / api-catalog via Link headers or <link> tags.'),
    mk('agent_skills', 'Agent Skills index', 'protocol', agentSkills.ok && /"skills"/.test(agentSkills.text), 2,
      agentSkills.ok ? 'Present' : 'Not found', 'Publish /.well-known/agent-skills/index.json.'),
    mk('webmcp', 'WebMCP (navigator.modelContext)', 'protocol', hasWebMcp(home.text), 1,
      hasWebMcp(home.text) ? 'Wired on homepage' : 'Not detected', 'Call navigator.modelContext.provideContext() in-page.'),

    // Identity / auth
    mk('web_bot_auth', 'Web Bot Auth directory', 'identity', webBotAuth.ok && isValidJwks(webBotAuth.text), 2,
      webBotAuth.ok && isValidJwks(webBotAuth.text) ? 'Valid JWKS' : 'Missing/invalid', 'Publish /.well-known/http-message-signatures-directory (JWKS).'),
    mk('auth_md', 'auth.md', 'identity', authMd.ok, 1,
      authMd.ok ? 'Present' : 'Not found', 'Publish /auth.md describing agent access.'),
    mk('oauth_pr', 'OAuth Protected Resource', 'identity', oauthPr.ok, 1,
      oauthPr.ok ? 'Present' : 'Not found', 'Publish /.well-known/oauth-protected-resource if tools need auth.'),
    mk('oidc', 'OIDC discovery', 'identity', oidc.ok, 1,
      oidc.ok ? 'Present' : 'Not found', 'Publish /.well-known/openid-configuration if you support OIDC.'),

    // DNS
    mk('dns_aid', 'DNS-AID record', 'dns', dnsAid, 2,
      dnsAid ? 'Found (_index._agents)' : 'Not found', 'Add a _index._agents TXT record pointing to your agent endpoints.'),
  ];

  return { ...scoreChecks(checks), checks };
}
