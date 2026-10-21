import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Local Services spend is fetched separately so the guardrails and pacing can
// project it at its real run rate instead of its placeholder budget. The query
// must target only per-lead campaigns, sum their month-to-date cost, and be
// skipped entirely for accounts without Local Services.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-ads-per-lead-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'ads-per-lead-secret-1234567890';

let client: typeof import('../ads/client.js');
let changes: typeof import('../ads/changes.js');
let queries: string[] = [];

beforeAll(async () => {
  client = await import('../ads/client.js');
  changes = await import('../ads/changes.js');
  const db = await import('../db/database.js');
  db.upsertGoogleAccount({
    id: 'owner@example.test', email: 'owner@example.test', client_id: '123456789012-abc.apps.googleusercontent.com', client_secret: 'secret',
    access_token: 'x', refresh_token: 'refresh', token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    granted_scopes: client.ADS_SCOPE, workspace_id: null, owner_user_id: null,
  });
  client.__setAdsTransportForTests({
    token: async () => 'test-access-token',
    fetcher: async (_url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) as { query?: string } : {};
      queries.push(String(body.query ?? ''));
      return new Response(JSON.stringify({ results: [
        { campaign: { advertisingChannelType: 'LOCAL_SERVICES' }, metrics: { costMicros: '600000000' } },
        { campaign: { advertisingChannelType: 'LOCAL_SERVICES' }, metrics: { costMicros: '500000000' } },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
});

beforeEach(() => { queries = []; });

const ctx = { googleAccountId: 'owner@example.test', loginCustomerId: null };

describe('per-lead month-to-date spend', () => {
  it('sums this month\'s Local Services cost with a channel-filtered query', async () => {
    const micros = await changes.perLeadMonthToDateMicros(ctx, '1234567890', ['SEARCH', 'LOCAL_SERVICES']);
    expect(micros).toBe(1_100_000_000);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("campaign.advertising_channel_type IN ('LOCAL_SERVICES')");
    expect(queries[0]).toContain('DURING THIS_MONTH');
  });

  it('makes no API call for accounts without Local Services', async () => {
    expect(await changes.perLeadMonthToDateMicros(ctx, '1234567890', ['SEARCH', 'PERFORMANCE_MAX', null])).toBe(0);
    expect(queries).toHaveLength(0);
  });
});
