/**
 * llms.txt lifecycle: fetch the live file, lint its structure, and diff it
 * against the generated version (geo-deploy builds + deploys the files; this
 * module closes the loop with verification and drift detection).
 */
import { buildLlmsTxt, buildRobotsTxt } from './geo-deploy.js';
import type { Site } from '../db/database.js';

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SEOWebsiteIndexer/1.0 (llms-audit)' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    return { status: res.status, text: res.ok ? await res.text() : '' };
  } catch {
    return { status: 0, text: '' };
  }
}

export interface LlmsLint {
  ok: boolean;
  issues: string[];
  stats: { bytes: number; lines: number; links: number; sections: number };
}

export function lintLlmsTxt(text: string): LlmsLint {
  const issues: string[] = [];
  const lines = text.split('\n');
  const links = [...text.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)];
  const sections = lines.filter(l => /^#{1,3} /.test(l)).length;

  if (!text.trim()) issues.push('File is empty');
  if (!/^# ./m.test(text)) issues.push('Missing top-level "# Title" heading (llms.txt spec)');
  if (text.length > 100_000) issues.push(`File is ${Math.round(text.length / 1024)}KB — very large files get truncated by AI crawlers`);
  if (links.length === 0 && text.trim()) issues.push('No markdown links — llms.txt should point AI engines at your key pages');
  for (const l of links) {
    const href = l[2];
    if (!/^https?:\/\//.test(href) && !href.startsWith('/')) {
      issues.push(`Unresolvable link target: "${href.slice(0, 60)}"`);
    }
  }
  if (/\bTODO\b|\bFIXME\b|lorem ipsum/i.test(text)) issues.push('Contains placeholder text (TODO/FIXME/lorem)');

  return {
    ok: issues.length === 0,
    issues,
    stats: { bytes: text.length, lines: lines.length, links: links.length, sections },
  };
}

export interface LlmsAudit {
  live: { status: number; text: string };
  liveFull: { status: number } | null;
  generated: string;
  robotsLive: { status: number; text: string };
  robotsGenerated: string;
  lint: LlmsLint;
  drift: boolean;
}

export async function auditSiteLlms(site: Site): Promise<LlmsAudit> {
  const origin = site.domain.startsWith('http') ? site.domain : `https://${site.domain}`;
  const [live, liveFull, robotsLive] = await Promise.all([
    fetchText(`${origin.replace(/\/$/, '')}/llms.txt`),
    fetchText(`${origin.replace(/\/$/, '')}/llms-full.txt`).then(r => ({ status: r.status })),
    fetchText(`${origin.replace(/\/$/, '')}/robots.txt`),
  ]);
  const generated = buildLlmsTxt(site);
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return {
    live,
    liveFull: liveFull.status === 200 ? liveFull : null,
    generated,
    robotsLive,
    robotsGenerated: buildRobotsTxt(site),
    lint: lintLlmsTxt(live.status === 200 ? live.text : ''),
    drift: live.status === 200 ? norm(live.text) !== norm(generated) : true,
  };
}
