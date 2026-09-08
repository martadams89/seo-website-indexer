import { randomUUID } from 'node:crypto';
import { getDb } from '../db/database.js';
export interface ListingDraft {
  platform: 'apple' | 'google';
  locale: string;
  name: string;
  subtitle: string;
  description: string;
  keywords: string;
  promotional_text: string;
  target_terms: string[];
}
export interface ListingAnalysis {
  fields: Array<{
    field: string;
    length: number;
    limit: number;
    required: boolean;
    status: 'ok' | 'missing' | 'over';
  }>;
  findings: Array<{ title: string; detail: string; kind: 'error' | 'review' }>;
  terms: Array<{ term: string; fields: string[] }>;
  source: string;
  methodology: string;
}
export interface AppListing {
  id: string;
  site_id: string | null;
  draft: ListingDraft;
  analysis: ListingAnalysis;
  created_at: string;
  updated_at: string;
}
export function validateListing(value: unknown): ListingDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Object.assign(new Error('A listing draft is required.'), { statusCode: 400 });
  const v = value as Record<string, unknown>;
  if (!['apple', 'google'].includes(String(v.platform)))
    throw Object.assign(new Error('Choose Apple App Store or Google Play.'), { statusCode: 400 });
  const draft: ListingDraft = {
    platform: v.platform as ListingDraft['platform'],
    locale: '',
    name: '',
    subtitle: '',
    description: '',
    keywords: '',
    promotional_text: '',
    target_terms: [],
  };
  for (const field of [
    'locale',
    'name',
    'subtitle',
    'description',
    'keywords',
    'promotional_text',
  ] as const) {
    if (typeof v[field] !== 'string' || v[field].length > (field === 'description' ? 12000 : 2000))
      throw Object.assign(new Error(`Invalid ${field}.`), { statusCode: 400 });
    draft[field] = v[field];
  }
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(draft.locale))
    throw Object.assign(new Error('Use a locale such as en-GB.'), { statusCode: 400 });
  if (
    !Array.isArray(v.target_terms) ||
    v.target_terms.length > 30 ||
    v.target_terms.some((t) => typeof t !== 'string' || !t.trim() || t.length > 100)
  )
    throw Object.assign(new Error('Provide up to 30 target terms, each at most 100 characters.'), {
      statusCode: 400,
    });
  draft.target_terms = [
    ...new Map(
      (v.target_terms as string[]).map((t) => [t.trim().normalize('NFKC').toLowerCase(), t.trim()]),
    ).values(),
  ];
  return draft;
}
function coversTerm(value: string, term: string): boolean {
  value = value.normalize('NFKC');
  term = term.normalize('NFKC');
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(term))
    return value.toLowerCase().includes(term.toLowerCase());
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(value.toLowerCase());
}
export function analyzeListing(draft: ListingDraft): ListingAnalysis {
  const limits: Array<[keyof ListingDraft, number, boolean]> = [
    ['name', 30, true],
    ['subtitle', draft.platform === 'apple' ? 30 : 80, draft.platform === 'google'],
    ['description', 4000, true],
  ];
  if (draft.platform === 'apple') limits.push(['keywords', 100, false], ['promotional_text', 170, false]);
  const fields: ListingAnalysis['fields'] = limits.map(([field, limit, required]) => {
    const value = String(draft[field]);
    const length = Array.from(value).length;
    return {
      field,
      length,
      limit,
      required,
      status: length > limit ? 'over' : required && !value.trim() ? 'missing' : 'ok',
    };
  });
  const findings: ListingAnalysis['findings'] = fields
    .filter((f) => f.status !== 'ok')
    .map((f) => ({
      kind: 'error',
      title: `${f.field.replaceAll('_', ' ')} ${f.status === 'over' ? 'exceeds the field limit' : 'is required'}`,
      detail: `${f.length} / ${f.limit} characters. Edit before submitting to the store.`,
    }));
  const tokens = draft.keywords
    .split(',')
    .map((t) => t.trim().toLocaleLowerCase())
    .filter(Boolean);
  if (draft.platform === 'apple') {
    const redundant = tokens.filter((token) =>
      `${draft.name} ${draft.subtitle}`
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .includes(token),
    );
    if (redundant.length)
      findings.push({
        kind: 'review',
        title: 'Keywords repeat name or subtitle',
        detail: `Review redundant entries: ${redundant.join(', ')}. Use the limited keyword field for relevant terms not already represented.`,
      });
    if (draft.keywords && draft.keywords.split(',').some((token) => !token.trim()))
      findings.push({
        kind: 'review',
        title: 'Empty keyword entries',
        detail: 'Remove leading, trailing or repeated commas to use the keyword field cleanly.',
      });
    const repeated = [...new Set(tokens.filter((t, i) => tokens.indexOf(t) !== i))];
    if (repeated.length)
      findings.push({
        kind: 'review',
        title: 'Repeated keyword entries',
        detail: `Remove duplicate entries: ${repeated.join(', ')}.`,
      });
    if (/,\s/.test(draft.keywords))
      findings.push({
        kind: 'review',
        title: 'Keyword separator spacing',
        detail:
          'Apple recommends comma-separated keywords without spaces after commas. Keep spaces within phrases when needed.',
      });
  }
  if (
    /\b(?:#1|number one|best app|guaranteed|overnight)\b/i.test(
      `${draft.name} ${draft.subtitle} ${draft.description}`,
    )
  )
    findings.push({
      kind: 'review',
      title: 'Review promotional claims',
      detail:
        'Replace unverifiable ranking or performance claims with specific, supportable product benefits.',
    });
  const terms = draft.target_terms.map((term) => ({
    term,
    fields: (
      ['name', 'subtitle', 'description', ...(draft.platform === 'apple' ? ['keywords'] : [])] as const
    ).filter((field) => coversTerm(String(draft[field as keyof ListingDraft]), term)),
  }));
  return {
    fields,
    findings,
    terms,
    source:
      draft.platform === 'apple'
        ? 'https://developer.apple.com/app-store/product-page/'
        : 'https://support.google.com/googleplay/android-developer/answer/13393723',
    methodology:
      'Local draft checks and literal target-term coverage. No store access, search volume, rank estimate or publishing. Character counts use Unicode code points; confirm validation in the store console. Description mentions do not imply that Apple indexes them as keywords.',
  };
}
export function listAppListings(workspaceId: string): AppListing[] {
  return (
    getDb()
      .prepare('SELECT * FROM app_listings WHERE workspace_id=? ORDER BY updated_at DESC')
      .all(workspaceId) as Array<Omit<AppListing, 'draft' | 'analysis'> & { draft: string; analysis: string }>
  ).map((row) => ({ ...row, draft: JSON.parse(row.draft), analysis: JSON.parse(row.analysis) }));
}
export function saveAppListing(
  workspaceId: string,
  draft: ListingDraft,
  siteId: string | null,
  id?: string,
): AppListing {
  const existing = id
    ? getDb().prepare('SELECT id FROM app_listings WHERE workspace_id=? AND id=?').get(workspaceId, id)
    : null;
  if (id && !existing) throw Object.assign(new Error('Listing not found.'), { statusCode: 404 });
  const listingId = id ?? randomUUID();
  const analysis = analyzeListing(draft);
  const at = new Date().toISOString();
  getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO app_listings(id,workspace_id,site_id,draft,analysis,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET site_id=excluded.site_id,draft=excluded.draft,analysis=excluded.analysis,updated_at=excluded.updated_at`,
      )
      .run(listingId, workspaceId, siteId, JSON.stringify(draft), JSON.stringify(analysis), at, at);
    getDb()
      .prepare('INSERT INTO app_listing_revisions(listing_id,draft,analysis,observed_at) VALUES(?,?,?,?)')
      .run(listingId, JSON.stringify(draft), JSON.stringify(analysis), at);
    getDb()
      .prepare(
        'DELETE FROM app_listing_revisions WHERE listing_id=? AND id NOT IN (SELECT id FROM app_listing_revisions WHERE listing_id=? ORDER BY id DESC LIMIT 30)',
      )
      .run(listingId, listingId);
  })();
  return listAppListings(workspaceId).find((row) => row.id === listingId)!;
}
export function listingHistory(workspaceId: string, id: string) {
  return (
    getDb()
      .prepare(
        'SELECT r.* FROM app_listing_revisions r JOIN app_listings l ON l.id=r.listing_id WHERE l.workspace_id=? AND l.id=? ORDER BY r.id DESC LIMIT 30',
      )
      .all(workspaceId, id) as Array<{ id: number; draft: string; analysis: string; observed_at: string }>
  ).map((r) => ({
    ...r,
    draft: JSON.parse(r.draft) as ListingDraft,
    analysis: JSON.parse(r.analysis) as ListingAnalysis,
  }));
}
