/**
 * AI draft for a Ranking Playbook opportunity: a title, meta description, H1
 * and the content sections a page needs, written from the queries Google
 * already shows it for. A review draft only: nothing is published by the
 * tool. Runs on the workspace's configured provider under its budget and a
 * per-user daily cap.
 */
import type { Site } from '../db/database.js';
import { completeForWorkspace, parseJsonObject } from './complete.js';
import { assertWithinBudget, recordUsage } from '../platform/store.js';
import { queriesForPage } from '../analytics/query-page-performance.js';
import { getInventoryPage } from '../analytics/internal-links.js';
import type { StoredOpportunity } from '../analytics/playbook.js';

export interface PlaybookDraft {
  title: string;
  title_alternatives: string[];
  meta_description: string;
  h1: string;
  content_additions: Array<{ heading: string; why: string; queries: string[] }>;
  internal_link_anchors: Array<{ anchor: string; from: string }>;
  rationale: string;
  unsure: string[];
  /** Validation problems the model did not fix on a second try; the person edits these. */
  needs_edit: string[];
  provider: string;
  model: string;
}

const TITLE_MAX = 60;
const META_MAX = 155;

const KIND_BRIEF: Record<string, string> = {
  ctr_gap: 'The page ranks well but few searchers click it. The snippet must promise what these queries want, lead with the main query and read like the best result on the page.',
  striking_distance: 'The page ranks at positions 4–15 for these queries. Make the title and H1 use the main query and add sections that answer the others directly, so it can move onto the top of page one.',
  cannibalisation: 'This page must clearly own these queries while a second page covers something else. Make the title and H1 unambiguous about the intent.',
  content_decay: 'The page used to earn more clicks and its ranking slipped. Refresh the framing so it answers what people ask now, and name the sections that need updating or adding.',
};

export function buildDraftPrompt(site: Site, o: StoredOpportunity, brandTerms: string[]): { system: string; user: string } {
  const meta = getInventoryPage(site.id, o.page);
  const queries = queriesForPage(site.id, o.page, 15);
  const evidenceQueries = Array.isArray(o.evidence.queries) ? (o.evidence.queries as Array<{ query: string; impressions?: number; position?: number }>) : [];
  const list = (queries.length ? queries.map(q => ({ query: q.query, impressions: q.impressions, position: q.position })) : evidenceQueries)
    .slice(0, 15).map(q => `- "${q.query}" (${q.impressions ?? '?'} impressions in 28 days, position ${q.position !== undefined ? Number(q.position).toFixed(1) : '?'})`).join('\n');
  const system = `You write search snippets and content briefs for an SEO team. Reply with ONE JSON object and nothing else, matching exactly:
{"title": string, "title_alternatives": [string, string], "meta_description": string, "h1": string, "content_additions": [{"heading": string, "why": string, "queries": [string]}], "internal_link_anchors": [{"anchor": string, "from": string}], "rationale": string, "unsure": [string]}
Rules:
- title at most ${TITLE_MAX} characters, meta_description at most ${META_MAX} characters, both plain text, no quotes or emoji, no clickbait.
- Lead the title with the main query's words in natural order; keep the site's brand term "${brandTerms[0] ?? site.name}" at the end of the title only if it fits.
- Write in the same language as the current title. Never invent facts, prices, dates, awards, statistics or product claims that are not in the material given; if a claim would help but is unverified, put it in "unsure" instead.
- content_additions: 2 to 5 sections the page should add or rewrite, each named for the queries it answers.
- internal_link_anchors: only if linking pages are given; otherwise an empty array.
- rationale: two sentences on why this will earn more clicks.`;
  const user = `Website: ${site.name} (${site.domain})
Page: ${o.page}
Opportunity: ${o.kind}${o.subtype ? ` (${o.subtype})` : ''}. ${KIND_BRIEF[o.kind] ?? ''}
Headline from the playbook: ${o.headline}
Steps already recommended:
${o.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}

Current title: ${meta?.title ?? (o.evidence.currentTitle as string | undefined) ?? '(unknown)'}
Current H1: ${meta?.h1 ?? (o.evidence.currentH1 as string | undefined) ?? '(unknown)'}
Current meta description: ${meta?.meta_description ?? '(unknown)'}
Word count: ${meta?.words ?? '(unknown)'}
Brand terms: ${brandTerms.join(', ') || '(none)'}

Queries Google shows this page for (28 days):
${list || '(no query rows; use the headline and steps)'}
${Array.isArray(o.evidence.missingTerms) && (o.evidence.missingTerms as string[]).length ? `\nWords from the main query missing from the title and H1: ${(o.evidence.missingTerms as string[]).join(', ')}` : ''}
${o.kind === 'cannibalisation' && o.secondary_page ? `\nThe second page covering the same queries: ${o.secondary_page}` : ''}`;
  return { system, user };
}

/** Validate model output; returns the problems that must be fixed. */
export function validateDraft(raw: Record<string, unknown>): { draft: Omit<PlaybookDraft, 'provider' | 'model' | 'needs_edit'>; errors: string[] } {
  const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  const draft = {
    title: str(raw.title),
    title_alternatives: strs(raw.title_alternatives).slice(0, 3),
    meta_description: str(raw.meta_description),
    h1: str(raw.h1),
    content_additions: (Array.isArray(raw.content_additions) ? raw.content_additions : []).map((c: unknown) => {
      const item = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      return { heading: str(item.heading), why: str(item.why), queries: strs(item.queries) };
    }).filter(c => c.heading).slice(0, 6),
    internal_link_anchors: (Array.isArray(raw.internal_link_anchors) ? raw.internal_link_anchors : []).map((c: unknown) => {
      const item = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      return { anchor: str(item.anchor), from: str(item.from) };
    }).filter(c => c.anchor).slice(0, 6),
    rationale: str(raw.rationale),
    unsure: strs(raw.unsure).slice(0, 8),
  };
  const errors: string[] = [];
  if (!draft.title) errors.push('title is missing');
  else if (draft.title.length > TITLE_MAX) errors.push(`title is ${draft.title.length} characters; the limit is ${TITLE_MAX}`);
  if (!draft.meta_description) errors.push('meta_description is missing');
  else if (draft.meta_description.length > META_MAX) errors.push(`meta_description is ${draft.meta_description.length} characters; the limit is ${META_MAX}`);
  if (!draft.h1) errors.push('h1 is missing');
  if (draft.content_additions.length === 0) errors.push('content_additions is empty');
  return { draft, errors };
}

/**
 * Draft the fix with the workspace's provider. Asks once more when the output
 * breaks a length rule; anything still wrong is returned in `needs_edit`.
 */
export async function draftPlaybookFix(site: Site, o: StoredOpportunity, brandTerms: string[], userId: string | null): Promise<PlaybookDraft> {
  const ws = site.workspace_id ?? null;
  const { system, user } = buildDraftPrompt(site, o, brandTerms);
  const ask = async (prompt: string) => {
    const result = await completeForWorkspace(ws, system, prompt);
    const parsed = parseJsonObject(result.text);
    if (!parsed) throw Object.assign(new Error(`${result.provider} returned no usable JSON. Try again.`), { statusCode: 502 });
    return { ...validateDraft(parsed), provider: result.provider, model: result.model };
  };
  // Budget is checked once for the request; a retry is the same unit of work.
  if (ws) assertWithinBudget({ workspaceId: ws, userId, provider: 'ai_draft', quantity: 1 });
  let attempt = await ask(user);
  let calls = 1;
  if (attempt.errors.length) {
    attempt = await ask(`${user}\n\nYour previous answer had these problems: ${attempt.errors.join('; ')}. Return corrected JSON only.`);
    calls++;
  }
  if (ws) {
    recordUsage({ workspace_id: ws, user_id: userId, provider: attempt.provider, operation: 'ai.playbook_draft', quantity: calls, unit: 'request', estimated_cost: 0,
      metadata: { site_id: site.id, opportunity_id: o.id, kind: o.kind, model: attempt.model, needs_edit: attempt.errors.length } });
  }
  return { ...attempt.draft, needs_edit: attempt.errors, provider: attempt.provider, model: attempt.model };
}
