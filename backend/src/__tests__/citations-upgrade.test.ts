import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'citation-upgrade-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'citation-upgrade-test-secret';

let users: typeof import('../auth/users.js');
let workspaces: typeof import('../auth/workspaces.js');
let database: typeof import('../db/database.js');
let citations: typeof import('../ai/citations.js');

beforeAll(async () => {
  users = await import('../auth/users.js');
  workspaces = await import('../auth/workspaces.js');
  database = await import('../db/database.js');
  citations = await import('../ai/citations.js');
});

function tenant(label: string) {
  const user = users.createUser({ email: `${label}-${randomUUID()}@example.com`, password: 'password123' });
  const workspace = workspaces.bootstrapUserWorkspace(user, false);
  return { user, workspace };
}

describe('legacy AI citation uplift', () => {
  it('upgrades in place, preserves every result, and snapshots subsequent edits', () => {
    const { user, workspace } = tenant('legacy');
    const promptId = Number(database.getDb().prepare(`
      INSERT INTO ai_prompts(workspace_id,prompt,category,group_name,locale,device,cadence,schema_version)
      VALUES(?,?,'discovery','Core prompts','en-GB','desktop','manual',1)
    `).run(workspace.id, 'What is the best technical SEO platform?').lastInsertRowid);
    const resultId = Number(database.getDb().prepare(`
      INSERT INTO ai_results(prompt_id,provider,model,cited,domains,excerpt,citations,user_prompt)
      VALUES(?,'openai','test-model',1,'["example.com"]','Historic answer','["https://example.com/proof"]',NULL)
    `).run(promptId).lastInsertRowid);

    const plan = citations.getLegacyPromptPlan(workspace.id);
    expect(plan).toMatchObject({ prompt_count: 1, result_count: 1 });
    expect(plan.prompts[0]).toMatchObject({ id: promptId, suggested_category: 'commercial' });

    expect(citations.upgradeLegacyPrompts(workspace.id, {
      group_name: 'Imported buyer questions', locale: 'en-US', device: 'mobile', cadence: 'weekly',
      categories: { [String(promptId)]: 'comparison' },
    }, user.id)).toEqual({ prompts_upgraded: 1, results_preserved: 1 });

    expect(database.getDb().prepare('SELECT id,prompt,category,group_name,locale,device,cadence,schema_version FROM ai_prompts WHERE id=?').get(promptId)).toEqual({
      id: promptId, prompt: 'What is the best technical SEO platform?', category: 'comparison',
      group_name: 'Imported buyer questions', locale: 'en-US', device: 'mobile', cadence: 'weekly', schema_version: 2,
    });
    expect(database.getDb().prepare('SELECT id,user_prompt,excerpt FROM ai_results WHERE id=?').get(resultId)).toEqual({
      id: resultId, user_prompt: 'What is the best technical SEO platform?', excerpt: 'Historic answer',
    });
    expect(database.getDb().prepare('SELECT reason FROM ai_prompt_revisions WHERE prompt_id=?').all(promptId)).toEqual([{ reason: 'legacy_upgrade' }]);

    citations.updatePrompt(promptId, workspace.id, { prompt: 'Which technical SEO platforms fit an agency?', category: 'commercial' }, user.id);
    expect(database.getDb().prepare('SELECT prompt,category FROM ai_prompts WHERE id=?').get(promptId)).toEqual({
      prompt: 'Which technical SEO platforms fit an agency?', category: 'commercial',
    });
    expect(database.getDb().prepare('SELECT user_prompt FROM ai_results WHERE id=?').get(resultId)).toEqual({
      user_prompt: 'What is the best technical SEO platform?',
    });
    expect(database.getDb().prepare('SELECT reason FROM ai_prompt_revisions WHERE prompt_id=? ORDER BY id').all(promptId)).toEqual([
      { reason: 'legacy_upgrade' }, { reason: 'edit' },
    ]);
    expect(citations.getLegacyPromptPlan(workspace.id).prompt_count).toBe(0);
  });

  it('never exposes or upgrades another workspace’s legacy prompts', () => {
    const first = tenant('isolated-a'); const second = tenant('isolated-b');
    database.getDb().prepare(`INSERT INTO ai_prompts(workspace_id,prompt,schema_version) VALUES(?,?,1)`).run(first.workspace.id, 'Private legacy prompt');
    expect(citations.getLegacyPromptPlan(second.workspace.id).prompt_count).toBe(0);
    expect(citations.upgradeLegacyPrompts(second.workspace.id, { categories: {} }, second.user.id)).toEqual({ prompts_upgraded: 0, results_preserved: 0 });
    expect(citations.getLegacyPromptPlan(first.workspace.id).prompt_count).toBe(1);
  });
});
