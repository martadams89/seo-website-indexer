import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-playbook-draft-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'playbook-draft-secret-1234567890';

let db: typeof import('../db/database.js');
let draft: typeof import('../ai/playbook-draft.js');
let users: typeof import('../auth/users.js');
let workspaces: typeof import('../auth/workspaces.js');
let store: typeof import('../platform/store.js');

beforeAll(async () => {
  db = await import('../db/database.js');
  draft = await import('../ai/playbook-draft.js');
  users = await import('../auth/users.js');
  workspaces = await import('../auth/workspaces.js');
  store = await import('../platform/store.js');
});
afterEach(() => vi.unstubAllGlobals());

const opportunity = (siteId: string) => ({
  id: 'opp1', site_id: siteId, kind: 'ctr_gap' as const, subtype: 'query', page: 'https://draft.example/boots', secondary_page: null,
  headline: 'Rewrite the title and description of /boots', steps: [{ text: 'Lead the title with "waterproof boots"', copy: 'waterproof boots' }],
  evidence: { queries: [{ query: 'waterproof boots', impressions: 1200, clicks: 6, position: 4.2 }], currentTitle: 'Boots' },
  low: 20, high: 90, point: 44, effort: 'S' as const, confidence: 'high' as const, counted: 1, hidden: 0, status: 'open' as const, changed: 0,
  dismissed_high: null, first_seen: '', last_seen: '', computed_at: '', work_item_id: null, draft: null, draft_at: null, done_at: null, baseline_clicks: null, baseline_site_clicks: null,
});

describe('validateDraft', () => {
  it('normalises fields and reports length problems', () => {
    const { draft: d, errors } = draft.validateDraft({
      title: '  Waterproof   hiking boots that last | Acme  ', title_alternatives: ['A', 'B', 'C', 'D'], meta_description: 'x'.repeat(200), h1: 'Waterproof hiking boots',
      content_additions: [{ heading: 'Which boots for winter?', why: 'answers "boots for winter"', queries: ['boots for winter'] }, { heading: '' }],
      internal_link_anchors: [{ anchor: 'waterproof boots', from: 'https://draft.example/guides' }], rationale: 'r', unsure: ['price claim'],
    });
    expect(d.title).toBe('Waterproof hiking boots that last | Acme');
    expect(d.title_alternatives).toEqual(['A', 'B', 'C']);
    expect(d.content_additions).toHaveLength(1);
    expect(errors).toEqual(['meta_description is 200 characters; the limit is 155']);
    expect(draft.validateDraft({}).errors).toEqual(['title is missing', 'meta_description is missing', 'h1 is missing', 'content_additions is empty']);
  });
});

describe('draftPlaybookFix', () => {
  it('asks the configured provider, retries once on a length problem, and meters usage', async () => {
    const user = users.createUser({ email: `d-${randomUUID()}@x.com`, password: 'password123' });
    const ws = workspaces.bootstrapUserWorkspace(user, false);
    const siteId = randomUUID();
    db.upsertSite({ id: siteId, name: 'Draft Co', domain: `${siteId}.example`, sitemap_url: 'https://draft.example/sitemap.xml', gsc_url: 'https://draft.example/', enabled: 1, workspace_id: ws.id });
    db.setWorkspaceSetting(ws.id, 'anthropic_api_key', 'sk-test');
    const site = db.getSiteById(siteId)!;

    const answers = [
      { title: 'A very long title that goes well past the sixty character limit for snippets', meta_description: 'Short and useful description.', h1: 'Waterproof hiking boots', content_additions: [{ heading: 'Winter boots', why: 'w', queries: ['boots for winter'] }], rationale: 'r', unsure: [] },
      { title: 'Waterproof hiking boots that last | Draft Co', title_alternatives: ['Best waterproof hiking boots', 'Hiking boots built for rain'], meta_description: 'Short and useful description.', h1: 'Waterproof hiking boots', content_additions: [{ heading: 'Winter boots', why: 'w', queries: ['boots for winter'] }], internal_link_anchors: [], rationale: 'Leads with the main query.', unsure: ['claim about 10-year warranty'] },
    ];
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain('api.anthropic.com');
      bodies.push(String(init?.body));
      return Response.json({ content: [{ text: '```json\n' + JSON.stringify(answers[bodies.length - 1]) + '\n```' }] });
    }));

    const result = await draft.draftPlaybookFix(site, opportunity(siteId), ['draftco'], user.id);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('title is 76 characters; the limit is 60');
    expect(bodies[0]).toContain('waterproof boots');
    expect(result.title).toBe('Waterproof hiking boots that last | Draft Co');
    expect(result.needs_edit).toEqual([]);
    expect(result.provider).toBe('anthropic');
    expect(result.unsure).toEqual(['claim about 10-year warranty']);
    const usage = store.usageSummary(ws.id).rows.find(r => r.operation === 'ai.playbook_draft');
    expect(usage).toMatchObject({ provider: 'anthropic', quantity: 2 });
  });

  it('fails clearly without a provider', async () => {
    const siteId = randomUUID();
    db.upsertSite({ id: siteId, name: 'No AI', domain: `${siteId}.example`, sitemap_url: 'https://x.example/sitemap.xml', gsc_url: 'https://x.example/', enabled: 1 });
    await expect(draft.draftPlaybookFix(db.getSiteById(siteId)!, opportunity(siteId), [], null)).rejects.toMatchObject({ statusCode: 400 });
  });
});
