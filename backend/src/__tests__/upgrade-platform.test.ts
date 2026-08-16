import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Prove that an actual v1.26-shaped database is upgraded in place. Fresh-schema
// tests do not catch missing ALTER TABLE migrations or destructive defaults.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'organic-platform-upgrade-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'platform-upgrade-test-secret';

let database: typeof import('../db/database.js');

beforeAll(async () => {
  const legacy = new Database(path.join(TMP, 'indexer.db'));
  legacy.exec(`
    CREATE TABLE ai_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT,
      workspace_id TEXT,
      prompt TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'discovery',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO ai_prompts(prompt, category) VALUES('Which platform is visible?', 'commercial');

    CREATE TABLE bing_accounts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO bing_accounts(id, name, api_key) VALUES('legacy-bing', 'Legacy key', 'encrypted-key');
  `);
  legacy.close();
  database = await import('../db/database.js');
  database.getDb();
});

afterAll(() => {
  try { database.getDb().close(); } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('v1.26 platform upgrade', () => {
  it('adds scheduled prompt and Bing OAuth columns without losing existing rows', () => {
    const db = database.getDb();
    const promptColumns = (db.prepare('PRAGMA table_info(ai_prompts)').all() as Array<{ name: string }>).map(row => row.name);
    expect(promptColumns).toEqual(expect.arrayContaining(['group_name', 'locale', 'device', 'persona', 'cadence', 'next_run_at', 'last_run_at']));
    expect(db.prepare('SELECT prompt,group_name,cadence FROM ai_prompts WHERE id=1').get()).toEqual({
      prompt: 'Which platform is visible?', group_name: 'Core prompts', cadence: 'manual',
    });

    const bingColumns = (db.prepare('PRAGMA table_info(bing_accounts)').all() as Array<{ name: string }>).map(row => row.name);
    expect(bingColumns).toEqual(expect.arrayContaining(['auth_type', 'access_token', 'refresh_token', 'expires_at']));
    expect(db.prepare('SELECT name,auth_type FROM bing_accounts WHERE id=?').get('legacy-bing')).toEqual({ name: 'Legacy key', auth_type: 'api_key' });
  });

  it('creates every normalized platform table during the same upgrade', () => {
    const tables = (database.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      'integrations', 'metric_observations', 'work_items', 'annotations', 'dashboard_views',
      'report_templates', 'report_runs', 'usage_ledger', 'budget_policies', 'outbound_webhooks',
      'service_tokens', 'content_actions', 'local_entities', 'bing_oauth_states',
    ]));
  });
});
