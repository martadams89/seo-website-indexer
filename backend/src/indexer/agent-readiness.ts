/**
 * Agent-readiness scoring. The authoritative source is the public
 * isitagentready.com scan API (POST /api/scan) — we surface THEIR result
 * (level 0-5 + per-check breakdown) so our numbers never diverge from the tool
 * people actually test against.
 *
 * If that API is unreachable we fall back to a local approximation of the same
 * checks, clearly labelled `source: 'local'`, so the dashboard degrades
 * gracefully offline instead of going blank. Pure helpers (`summarize`, the
 * `detect*` functions, `mapScan`) are exported for offline unit testing.
 */
import { resolveTxt } from 'node:dns/promises';
import type { Site } from '../db/database.js';
import { readResponseJson, readResponseText, safeFetch } from '../security/outbound-url.js';

export type AgentCheckStatus = 'pass' | 'fail' | 'neutral';

export interface AgentCheck {
  id: string;
  label: string;
  category: string;   // isitagentready category key, or a local category
  status: AgentCheckStatus;
  detail: string;     // human-readable message
  fix?: string;       // remediation hint when failing
}

export interface AgentReadinessResult {
  source: 'isitagentready.com' | 'local';
  level: number | null;      // 0-5 (isitagentready); null for the local fallback
  levelName: string | null;  // e.g. "Agent-Native"
  score: number;             // 0-100 pass ratio (drives the trend line)
  passed: number;
  total: number;             // non-neutral checks
  checks: AgentCheck[];
  scannedAt: string;
}

const SCAN_API = 'https://isitagentready.com/api/scan';

// Prettier names for isitagentready's camelCase check ids.
const CHECK_LABELS: Record<string, string> = {
  robotsTxt: 'robots.txt', robotsTxtAiRules: 'AI crawler rules', sitemap: 'sitemap.xml',
  linkHeaders: 'Link relations (RFC 8288)', dnsAid: 'DNS-AID record',
  markdownNegotiation: 'Markdown negotiation', contentSignals: 'Content-Signal policy',
  webBotAuth: 'Web Bot Auth', apiCatalog: 'api-catalog (RFC 9727)',
  oauthDiscovery: 'OIDC discovery', oauthProtectedResource: 'OAuth Protected Resource',
  authMd: 'auth.md', mcpServerCard: 'MCP Server Card', a2aAgentCard: 'A2A agent card',
  agentSkills: 'Agent Skills index', webMcp: 'WebMCP',
  x402: 'x402 payments', mpp: 'MPP', ucp: 'UCP', acp: 'ACP', ap2: 'AP2',
};

export const CATEGORY_LABELS: Record<string, string> = {
  discoverability: 'Discoverability', discovery: 'Agent discovery',
  botAccessControl: 'Bot access control', contentAccessibility: 'Content accessibility',
  commerce: 'Commerce (agentic payments)', identity: 'Identity & auth', content: 'Structured content',
  protocol: 'Agent protocol', dns: 'DNS',
};

function prettify(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

function normStatus(s: unknown): AgentCheckStatus {
  return s === 'pass' ? 'pass' : s === 'neutral' ? 'neutral' : 'fail';
}

/** Pass ratio over non-neutral checks. */
export function summarize(checks: AgentCheck[]): { score: number; passed: number; total: number } {
  const scored = checks.filter(c => c.status !== 'neutral');
  const passed = scored.filter(c => c.status === 'pass').length;
  const total = scored.length;
  return { score: total ? Math.round((passed / total) * 100) : 0, passed, total };
}

interface RawScan {
  level?: number; levelName?: string; scannedAt?: string;
  checks?: Record<string, Record<string, { status?: string; message?: string }>>;
}

/** Flatten an isitagentready scan payload into our result shape. Pure. */
export function mapScan(data: RawScan): AgentReadinessResult {
  const checks: AgentCheck[] = [];
  for (const [category, group] of Object.entries(data.checks || {})) {
    for (const [id, c] of Object.entries(group || {})) {
      const status = normStatus(c?.status);
      checks.push({
        id, label: CHECK_LABELS[id] || prettify(id), category, status,
        detail: c?.message || '',
        ...(status === 'fail' ? { fix: c?.message || '' } : {}),
      });
    }
  }
  return {
    source: 'isitagentready.com',
    level: typeof data.level === 'number' ? data.level : null,
    levelName: data.levelName || null,
    ...summarize(checks),
    checks,
    scannedAt: data.scannedAt || new Date().toISOString(),
  };
}

function originOf(site: Site): string {
  const d = site.domain.startsWith('http') ? site.domain : `https://${site.domain}`;
  return d.replace(/\/+$/, '');
}

/** Authoritative: run the real isitagentready.com scan. Throws on API failure. */
export async function scanAgentReadiness(url: string): Promise<AgentReadinessResult> {
  const res = await fetch(SCAN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'SEOWebsiteIndexer/1.0 (agent-readiness)' },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`isitagentready scan failed: HTTP ${res.status}`);
  return mapScan(await readResponseJson<RawScan>(res, 2_000_000, 'Agent-readiness scan response'));
}

/**
 * Primary entry point. Prefer the real isitagentready.com result; on any error
 * (network/timeout/5xx) fall back to the local approximation so the metric
 * still renders — clearly flagged so nobody mistakes it for the real score.
 */
export async function checkAgentReadiness(site: Site): Promise<AgentReadinessResult> {
  try {
    return await scanAgentReadiness(originOf(site));
  } catch {
    return await localAgentReadiness(site);
  }
}

// ── Local fallback (offline approximation) ────────────────────────────────────

const UA = 'SEOWebsiteIndexer/1.0 (agent-readiness)';
const TIMEOUT = 12_000;
interface Fetched { ok: boolean; ct: string; headers: Headers; text: string }

async function grab(url: string, accept?: string): Promise<Fetched> {
  try {
    const res = await safeFetch(url, {
      headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}) },
      signal: AbortSignal.timeout(TIMEOUT),
    }, { label: 'Agent-readiness site URL' });
    return { ok: res.ok, ct: res.headers.get('content-type') || '', headers: res.headers, text: res.ok ? await readResponseText(res, 400_000, 'Agent-readiness page') : '' };
  } catch { return { ok: false, ct: '', headers: new Headers(), text: '' }; }
}

const AI_BOTS = ['GPTBot', 'ClaudeBot', 'Claude-Web', 'PerplexityBot', 'Google-Extended', 'CCBot', 'anthropic-ai'];

export function robotsAllowsAi(robots: string): boolean {
  if (!robots.trim()) return false;
  const lines = robots.split('\n').map(l => l.replace(/#.*$/, '').trim());
  let agents: string[] = [];
  const blocked = new Set<string>();
  for (const l of lines) {
    const ua = l.match(/^user-agent:\s*(.+)$/i);
    if (ua) { agents.push(ua[1].trim()); continue; }
    const dis = l.match(/^disallow:\s*(.*)$/i);
    if (dis && agents.length && dis[1].trim() === '/') for (const a of agents) blocked.add(a.toLowerCase());
    if (l === '') agents = [];
  }
  if (blocked.has('*')) return false;
  return !AI_BOTS.some(b => blocked.has(b.toLowerCase()));
}

export function hasContentSignal(robots: string, header: string | null): boolean {
  return /content-signal:/i.test(robots) || /content-signal/i.test(header || '');
}
export function hasJsonLd(html: string): boolean {
  return /<script[^>]+type=["']application\/ld\+json["'][^>]*>/i.test(html);
}
export function hasWebMcp(html: string): boolean {
  return /navigator\.modelContext/.test(html) || /modelContext\.provideContext/.test(html);
}
export function isMarkdownResponse(f: { ct: string; text: string }): boolean {
  if (/text\/markdown/i.test(f.ct)) return true;
  return !/<html[\s>]/i.test(f.text) && /^#{1,3}\s|\]\(https?:/m.test(f.text);
}
export function isValidJwks(text: string): boolean {
  try { const j = JSON.parse(text) as { keys?: Array<{ kty?: string }> }; return Array.isArray(j.keys) && j.keys.length > 0 && !!j.keys[0].kty; }
  catch { return false; }
}

async function dnsAidPresent(host: string): Promise<boolean> {
  try {
    const flat = (await resolveTxt(`_index._agents.${host}`)).map(r => r.join('')).join(' ');
    return /aid1|endpoint=|mcp=/i.test(flat);
  } catch { return false; }
}

async function localAgentReadiness(site: Site): Promise<AgentReadinessResult> {
  const origin = originOf(site);
  const host = (() => { try { return new URL(origin).hostname; } catch { return site.domain; } })();
  const [home, robots, llms, sitemap, securityTxt, aiTxt, mcpCard, apiCatalog, agentSkills, webBotAuth, authMd, mdNeg, dnsAid] = await Promise.all([
    grab(`${origin}/`), grab(`${origin}/robots.txt`), grab(`${origin}/llms.txt`), grab(`${origin}/sitemap.xml`),
    grab(`${origin}/.well-known/security.txt`), grab(`${origin}/ai.txt`), grab(`${origin}/.well-known/mcp.json`),
    grab(`${origin}/.well-known/api-catalog`), grab(`${origin}/.well-known/agent-skills/index.json`),
    grab(`${origin}/.well-known/http-message-signatures-directory`), grab(`${origin}/auth.md`),
    grab(`${origin}/`, 'text/markdown'), dnsAidPresent(host),
  ]);
  const mk = (id: string, label: string, category: string, ok: boolean, okMsg: string, fix: string): AgentCheck =>
    ({ id, label, category, status: ok ? 'pass' : 'fail', detail: ok ? okMsg : fix, ...(ok ? {} : { fix }) });
  const checks: AgentCheck[] = [
    mk('robotsTxt', 'robots.txt', 'discoverability', robots.ok, 'Present', 'Publish /robots.txt.'),
    mk('robotsTxtAiRules', 'AI crawler rules', 'botAccessControl', robots.ok && robotsAllowsAi(robots.text), 'AI bots not blocked', 'Allow GPTBot/ClaudeBot/etc in robots.txt.'),
    mk('contentSignals', 'Content-Signal policy', 'botAccessControl', hasContentSignal(robots.text, robots.headers.get('content-signal')), 'Declared', 'Add Content-Signal directives to robots.txt.'),
    mk('sitemap', 'sitemap.xml', 'discoverability', sitemap.ok, 'Present', 'Publish /sitemap.xml.'),
    mk('llms', 'llms.txt', 'discoverability', llms.ok && /^#\s/m.test(llms.text), 'Present', 'Publish /llms.txt with a "# Title".'),
    mk('markdownNegotiation', 'Markdown negotiation', 'contentAccessibility', isMarkdownResponse(mdNeg), 'Serves text/markdown', 'Serve markdown on Accept: text/markdown.'),
    mk('jsonLd', 'JSON-LD', 'contentAccessibility', hasJsonLd(home.text), 'Found on homepage', 'Add schema.org JSON-LD.'),
    mk('securityTxt', 'security.txt', 'discovery', securityTxt.ok, 'Present', 'Publish /.well-known/security.txt.'),
    mk('aiTxt', 'ai.txt', 'discovery', aiTxt.ok, 'Present', 'Publish /ai.txt.'),
    mk('mcpServerCard', 'MCP Server Card', 'discovery', mcpCard.ok, 'Present', 'Publish /.well-known/mcp.json.'),
    mk('apiCatalog', 'api-catalog', 'discovery', apiCatalog.ok, 'Present', 'Publish /.well-known/api-catalog.'),
    mk('agentSkills', 'Agent Skills index', 'discovery', agentSkills.ok, 'Present', 'Publish /.well-known/agent-skills/index.json.'),
    mk('webMcp', 'WebMCP', 'discovery', hasWebMcp(home.text), 'Wired on homepage', 'Call navigator.modelContext.provideContext().'),
    mk('webBotAuth', 'Web Bot Auth', 'botAccessControl', webBotAuth.ok && isValidJwks(webBotAuth.text), 'Valid JWKS', 'Publish /.well-known/http-message-signatures-directory.'),
    mk('authMd', 'auth.md', 'discovery', authMd.ok && /^#\s*[^\n]*auth\.md/im.test(authMd.text), 'Present', 'Serve /auth.md with an H1 containing "auth.md".'),
    mk('dnsAid', 'DNS-AID record', 'discoverability', dnsAid, 'Found (_index._agents)', 'Add a _index._agents TXT/HTTPS record and sign the zone with DNSSEC.'),
  ];
  return { source: 'local', level: null, levelName: null, ...summarize(checks), checks, scannedAt: new Date().toISOString() };
}
