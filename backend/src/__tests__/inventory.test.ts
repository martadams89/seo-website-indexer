import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-inventory-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'inventory-test-secret-123';

type DbModule = typeof import('../db/database.js');
let db: DbModule;

beforeAll(async () => {
  db = await import('../db/database.js');
});

describe('live sitemap inventory reconciliation', () => {
  it('removes retired HTML state and failures but preserves live and IndexNow-only URLs', () => {
    const siteId = 'inventory-site';
    db.upsertSite({
      id: siteId,
      name: 'Inventory test',
      domain: 'inventory.test',
      sitemap_url: 'https://inventory.test/sitemap.xml',
      gsc_url: 'https://inventory.test/',
      enabled: 1,
      workspace_id: null,
    });

    db.upsertUrlState({ url: 'https://inventory.test/live/', site_id: siteId });
    db.upsertUrlState({ url: 'https://inventory.test/retired/', site_id: siteId });
    db.upsertUrlState({
      url: 'https://inventory.test/llms.txt',
      site_id: siteId,
      indexnow_only: 1,
    });
    db.recordUrlFailure('https://inventory.test/retired/', siteId, 'indexnow');

    const result = db.pruneHtmlUrlStateForSite(siteId, ['https://inventory.test/live/']);

    expect(result).toEqual({ states: 1, failures: 1 });
    expect(db.getUrlState('https://inventory.test/live/', siteId)).not.toBeNull();
    expect(db.getUrlState('https://inventory.test/retired/', siteId)).toBeNull();
    expect(db.getUrlState('https://inventory.test/llms.txt', siteId)).not.toBeNull();
  });
});
