import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'citation-attribution-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'citation-attribution-test-secret';

let users: typeof import('../auth/users.js');
let workspaces: typeof import('../auth/workspaces.js');
let database: typeof import('../db/database.js');
let citations: typeof import('../ai/citations.js');
let store: typeof import('../platform/store.js');

beforeAll(async () => {
  users = await import('../auth/users.js');
  workspaces = await import('../auth/workspaces.js');
  database = await import('../db/database.js');
  citations = await import('../ai/citations.js');
  store = await import('../platform/store.js');
});

function setupIdentity() {
  const suffix = randomUUID().slice(0, 8);
  const user = users.createUser({ email: `citation-${suffix}@example.com`, password: 'password123' });
  const workspace = workspaces.bootstrapUserWorkspace(user, false);
  const siteId = `site-${suffix}`;
  const domain = `acme-${suffix}.example.com`;
  database.getDb().prepare(`INSERT INTO sites(id,name,domain,sitemap_url,gsc_url,workspace_id) VALUES(?,?,?,?,?,?)`)
    .run(siteId, 'Acme Scout', domain, `https://${domain}/sitemap.xml`, `sc-domain:${domain}`, workspace.id);
  store.saveLocalEntity({
    workspaceId: workspace.id, siteId, name: 'Acme Scout', market: 'Global', primaryUrl: `https://${domain}`,
    listings: [{ provider: 'Google Play', url: 'https://play.google.com/store/apps/details?id=com.acme.scout', status: 'consistent' }],
    identifiers: { linkedin: 'https://www.linkedin.com/company/acme-scout' },
    knowledge: { legal_name: 'Acme Scout Limited' },
  });
  database.setWorkspaceSetting(workspace.id, 'openai_api_key', 'test-key');
  return { workspace, siteId, domain };
}

function storedResult(workspaceId: string, siteId: string, excerpt: string, sources: string[]) {
  const prompt = citations.addPrompt(`Buyer question ${randomUUID()}`, siteId, workspaceId, 'commercial');
  const id = Number(database.getDb().prepare(`
    INSERT INTO ai_results(prompt_id,provider,model,cited,domains,excerpt,citations,user_prompt)
    VALUES(?,'openai','stored-model',0,'[]',?,?,?)
  `).run(prompt.id, excerpt, JSON.stringify(sources), prompt.prompt).lastInsertRowid);
  return { id, prompt };
}

function attributionKinds(row: Record<string, unknown>): string[] {
  return (JSON.parse(String(row.attributions ?? '[]')) as Array<{ kind: string }>).map(item => item.kind);
}

describe('entity-aware AI citation attribution', () => {
  it('reclassifies retained answers as direct, profile, marketplace, mention-only or absent', () => {
    const { workspace, siteId, domain } = setupIdentity();
    const direct = storedResult(workspace.id, siteId, `Acme Scout is documented at ${domain}.`, [`https://${domain}/guide`]);
    const profile = storedResult(workspace.id, siteId, 'The app is available from its verified listing.', ['https://play.google.com/store/apps/details?id=com.acme.scout']);
    const marketplace = storedResult(workspace.id, siteId, 'A marketplace comparison includes this product.', ['https://www.g2.com/products/acme-scout/reviews']);
    const mention = storedResult(workspace.id, siteId, 'Acme Scout is one option for field teams.', ['https://industry.example.org/comparison']);
    const absent = storedResult(workspace.id, siteId, 'Another product is recommended.', ['https://industry.example.org/other']);

    const rows = citations.getResults(20, workspace.id);
    const byId = (id: number) => rows.find(row => row.id === id)!;
    expect(attributionKinds(byId(direct.id))).toContain('owned_site');
    expect(attributionKinds(byId(profile.id))).toContain('third_party_profile');
    expect(attributionKinds(byId(marketplace.id))).toContain('marketplace');
    expect(attributionKinds(byId(mention.id))).toEqual(['brand_mention']);
    expect(byId(absent.id).cited).toBe(0);

    const insights = citations.getAiInsights(workspace.id);
    expect(insights.overview).toMatchObject({ checks: 5, cited: 4, visibility: 80, directCitations: 1, thirdPartyCitations: 2, mentionOnlyCitations: 1 });
    expect(insights.sources.find(source => source.domain === 'play.google.com')).toMatchObject({ attributed: true, entities: ['Acme Scout'] });
    expect(insights.sources.find(source => source.domain === 'g2.com')).toMatchObject({ attributed: true });
  });

  it('uses configurable trading names to uplift old results without rerunning a paid prompt', () => {
    const { workspace, siteId } = setupIdentity();
    const old = storedResult(workspace.id, siteId, 'Legacy Rocket is recommended for this workflow.', ['https://softwareadvice.com/project-management/']);
    expect(citations.getResults(10, workspace.id).find(row => row.id === old.id)?.cited).toBe(0);

    database.setWorkspaceSetting(workspace.id, 'ai_brand_aliases', 'Legacy Rocket');
    const uplifted = citations.getResults(10, workspace.id).find(row => row.id === old.id)!;
    expect(uplifted.cited).toBe(1);
    expect(attributionKinds(uplifted)).toContain('brand_mention');
  });

  it('publishes an explainable identity summary for the dashboard', () => {
    const { workspace, domain } = setupIdentity();
    database.setWorkspaceSetting(workspace.id, 'ai_brand_aliases', 'Scout Pro');
    const summary = citations.getCitationIdentitySummary(workspace.id);
    expect(summary.ownedDomains).toContain(domain);
    expect(summary.aliases).toEqual(expect.arrayContaining(['Acme Scout', 'Acme Scout Limited', 'Scout Pro']));
    expect(summary.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'Acme Scout', provider: 'Google Play', domain: 'play.google.com' }),
    ]));
  });
});
