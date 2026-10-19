import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// End-to-end Google Ads flow through the MCP tools against a fake Google Ads
// REST API: linking through a manager, tenancy fencing, read vs ads:write
// scopes, viewer read-only, guardrail approval, applying, reverting and
// read-only clients. No real Google credentials are involved.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-ads-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'ads-test-secret-1234567890';

type Mods = {
  db: typeof import('../db/database.js');
  users: typeof import('../auth/users.js');
  ws: typeof import('../auth/workspaces.js');
  tokens: typeof import('../mcp/tokens.js');
  tools: typeof import('../mcp/tools.js');
  client: typeof import('../ads/client.js');
  store: typeof import('../ads/store.js');
  changes: typeof import('../ads/changes.js');
};
let m: Mods;

interface Call { url: string; body: Record<string, unknown> | null; headers: Record<string, string> }
let calls: Call[] = [];
let budgetMicros = 50_000_000;

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fakeGoogleAds(url: string, init: RequestInit): Promise<Response> {
  const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
  calls.push({ url, body, headers: init.headers as Record<string, string> });
  if (url.endsWith('/customers:listAccessibleCustomers')) return respond({ resourceNames: ['customers/1111111111'] });
  if (url.includes('googleAds:mutate')) {
    if (body?.validateOnly) return respond({});
    const ops = body?.mutateOperations as Array<Record<string, { update?: { amountMicros?: string } }>>;
    for (const op of ops) if (op.campaignBudgetOperation?.update?.amountMicros) budgetMicros = Number(op.campaignBudgetOperation.update.amountMicros);
    return respond({ mutateOperationResponses: ops.map(op => ({ [Object.keys(op)[0].replace('Operation', 'Result')]: { resourceName: 'customers/2222222222/campaignBudgets/10' } })) });
  }
  if (url.includes('googleAds:search')) {
    const q = String(body?.query ?? '');
    if (q.includes('FROM customer_client')) {
      return respond({ results: [
        { customerClient: { id: '1111111111', descriptiveName: 'Agency MCC', manager: true, level: '0', currencyCode: 'GBP', timeZone: 'Europe/London' } },
        { customerClient: { id: '2222222222', descriptiveName: 'Acme Plumbing', manager: false, level: '1', currencyCode: 'GBP', timeZone: 'Europe/London' } },
      ] });
    }
    if (q.includes('customer.descriptive_name')) return respond({ results: [{ customer: { id: '2222222222', descriptiveName: 'Acme Plumbing', currencyCode: 'GBP', timeZone: 'Europe/London', manager: false, testAccount: false } }] });
    if (q.includes("FROM campaign WHERE campaign.status != 'REMOVED'") && q.includes('campaign_budget.amount_micros') && !q.includes('metrics')) {
      return respond({ results: [{ campaign: { resourceName: 'customers/2222222222/campaigns/1', status: 'ENABLED' }, campaignBudget: { resourceName: 'customers/2222222222/campaignBudgets/10', amountMicros: String(budgetMicros) } }] });
    }
    if (q.includes('THIS_MONTH')) return respond({ results: [{ metrics: { costMicros: '500000000' } }] });
    if (q.includes('FROM campaign WHERE campaign.resource_name')) {
      return respond({ results: [{ campaign: { name: 'Leads' }, campaignBudget: { resourceName: 'customers/2222222222/campaignBudgets/10', amountMicros: String(budgetMicros), explicitlyShared: false } }] });
    }
    return respond({ results: [] });
  }
  return respond({ error: { code: 404, message: 'not found' } }, 404);
}

let alice: { user: ReturnType<Mods['users']['createUser']>; workspaceId: string };
let bob: { user: ReturnType<Mods['users']['createUser']>; workspaceId: string };

function seedUser(label: string) {
  const user = m.users.createUser({ email: `${label}-${randomUUID()}@x.com`, password: 'password123' });
  const workspace = m.ws.bootstrapUserWorkspace(user, false);
  return { user, workspaceId: workspace.id };
}

function ctxFor(userId: string, scopes: Array<'mcp:read' | 'mcp:write' | 'ads:write'>) {
  const { token } = m.tokens.createMcpToken({ userId, name: 't', scopes });
  return m.tools.buildContext(m.tokens.authenticateMcpToken(token)!, 'https://seo.example.com')!;
}

beforeAll(async () => {
  m = {
    db: await import('../db/database.js'),
    users: await import('../auth/users.js'),
    ws: await import('../auth/workspaces.js'),
    tokens: await import('../mcp/tokens.js'),
    tools: await import('../mcp/tools.js'),
    client: await import('../ads/client.js'),
    store: await import('../ads/store.js'),
    changes: await import('../ads/changes.js'),
  };
  m.client.__setAdsTransportForTests({ fetcher: fakeGoogleAds, token: async () => 'test-access-token' });
  alice = seedUser('alice');
  bob = seedUser('bob');
  m.db.upsertGoogleAccount({
    id: 'alice@agency.test', email: 'alice@agency.test', client_id: '123456789012-abc.apps.googleusercontent.com', client_secret: 'secret',
    access_token: 'x', refresh_token: 'refresh', token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    granted_scopes: `${m.client.ADS_SCOPE} https://www.googleapis.com/auth/userinfo.email`, workspace_id: alice.workspaceId, owner_user_id: alice.user.id,
  });
  m.db.shareGoogleAccountWithWorkspace('alice@agency.test', alice.workspaceId, alice.user.id);
});

beforeEach(() => { calls = []; });

describe('Google Ads over MCP', () => {
  let accountId = '';

  it('discovers and links a client account reached through a manager', async () => {
    const ctx = ctxFor(alice.user.id, ['mcp:read', 'ads:write']);
    const discovered = await m.tools.runTool(ctx, 'ads_discover_accounts', {}) as { connections: Array<{ customers: Array<{ customer_id: string; login_customer_id: string | null }> }> };
    const acme = discovered.connections[0].customers.find(c => c.customer_id === '222-222-2222');
    expect(acme?.login_customer_id).toBe('111-111-1111');

    const linked = await m.tools.runTool(ctx, 'ads_link_account', { workspaceId: alice.workspaceId, customerId: '222-222-2222', loginCustomerId: '111-111-1111' }) as { client: { id: string; name: string; currency: string } };
    expect(linked.client).toMatchObject({ name: 'Acme Plumbing', currency: 'GBP' });
    accountId = linked.client.id;
    // Every call to the client account goes through the manager.
    expect(calls.filter(c => c.url.includes('/customers/2222222222/')).every(c => c.headers['login-customer-id'] === '1111111111')).toBe(true);
    // No developer token is sent any more.
    expect(calls.every(c => !('developer-token' in c.headers))).toBe(true);
  });

  it('fences accounts to the token owner\'s workspaces', async () => {
    const bobCtx = ctxFor(bob.user.id, ['mcp:read', 'ads:write']);
    expect((await m.tools.runTool(bobCtx, 'ads_list_clients', {}) as { clients: unknown[] }).clients).toEqual([]);
    await expect(m.tools.runTool(bobCtx, 'ads_get_client_brief', { account: accountId })).rejects.toThrow(/not linked/);
    await expect(m.tools.runTool(bobCtx, 'ads_get_client_brief', { account: '222-222-2222' })).rejects.toThrow(/not linked/);
  });

  it('keeps change tools behind the ads:write scope', async () => {
    const readOnly = ctxFor(alice.user.id, ['mcp:read']);
    expect(m.tools.toolsForContext(readOnly).some(t => t.name === 'ads_update_budget')).toBe(false);
    expect(m.tools.toolsForContext(readOnly).some(t => t.name === 'ads_search')).toBe(true);
    await expect(m.tools.runTool(readOnly, 'ads_update_budget', { account: accountId, campaignId: '1', dailyBudget: 60, rationale: 'xxxxxxxxxxxx' })).rejects.toThrow(/ads:write/);
  });

  it('keeps workspace viewers read-only even with an ads:write token', async () => {
    const carol = m.users.createUser({ email: `carol-${randomUUID()}@x.com`, password: 'password123' });
    m.ws.addWorkspaceMember(alice.workspaceId, carol.id, 'viewer');
    const ctx = ctxFor(carol.id, ['mcp:read', 'ads:write']);
    expect((await m.tools.runTool(ctx, 'ads_list_clients', {}) as { clients: unknown[] }).clients).toHaveLength(1);
    await expect(m.tools.runTool(ctx, 'ads_update_budget', { account: accountId, campaignId: '1', dailyBudget: 55, rationale: 'Budget limited and converting well.' })).rejects.toThrow(/read-only/);
  });

  it('applies a change inside the guardrails after Google validates it', async () => {
    m.store.updateAdsAccount(accountId, { monthlyBudget: 3000 });
    const ctx = ctxFor(alice.user.id, ['mcp:read', 'ads:write']);
    const plan = await m.tools.runTool(ctx, 'ads_update_budget', { account: accountId, campaignId: '1', dailyBudget: 55, rationale: 'Converting below target CPA and losing 30% IS to budget.' }) as { change_id: string; status: string; summary: string };
    expect(plan.status).toBe('pending');
    expect(plan.summary).toContain('50 → 55/day');
    const validate = calls.find(c => c.url.includes('googleAds:mutate'));
    expect(validate?.body?.validateOnly).toBe(true);

    calls = [];
    const applied = await m.tools.runTool(ctx, 'ads_apply_change', { changeId: plan.change_id }) as { status: string };
    expect(applied.status).toBe('applied');
    expect(calls.filter(c => c.url.includes('googleAds:mutate')).map(c => c.body?.validateOnly)).toEqual([false]);
    expect(budgetMicros).toBe(55_000_000);
    // Applying twice is harmless.
    expect((await m.tools.runTool(ctx, 'ads_apply_change', { changeId: plan.change_id }) as { status: string }).status).toBe('applied');
  });

  it('holds a change outside the guardrails for a person to approve', async () => {
    const ctx = ctxFor(alice.user.id, ['mcp:read', 'ads:write']);
    const plan = await m.tools.runTool(ctx, 'ads_update_budget', { account: accountId, campaignId: '1', dailyBudget: 120, rationale: 'Big opportunity, double the budget.' }) as { change_id: string; status: string; next_step: string; findings: Array<{ code: string }> };
    expect(plan.status).toBe('needs_approval');
    expect(plan.findings.map(f => f.code)).toContain('budget_increase_over_limit');
    expect(plan.next_step).toContain('https://seo.example.com/ads?tab=changes&change=');
    await expect(m.tools.runTool(ctx, 'ads_apply_change', { changeId: plan.change_id })).rejects.toThrow(/approve/);
    expect(budgetMicros).toBe(55_000_000);

    // A person approves on the dashboard.
    const approved = await m.changes.applyChange(plan.change_id, { userId: alice.user.id, approvedByPerson: true });
    expect(approved.status).toBe('applied');
    expect(approved.decided_by).toBe(alice.user.id);
    expect(budgetMicros).toBe(120_000_000);
  });

  it('reverts an applied change to the recorded previous value', async () => {
    const ctx = ctxFor(alice.user.id, ['mcp:read', 'ads:write']);
    const applied = m.store.listChanges({ workspaceIds: [alice.workspaceId], status: 'applied' }).find(c => c.summary.includes('→ 120/day'))!;
    const revert = await m.tools.runTool(ctx, 'ads_revert_change', { changeId: applied.id }) as { change_id: string; status: string };
    const plan = m.store.getChange(revert.change_id)!;
    expect(plan.reverts_change_id).toBe(applied.id);
    expect(plan.operations).toEqual([{ campaignBudgetOperation: { update: { resourceName: 'customers/2222222222/campaignBudgets/10', amountMicros: '55000000' }, updateMask: 'amountMicros' } }]);
    // Cutting spend is inside the guardrails.
    expect(revert.status).toBe('pending');
  });

  it('blocks every change for a read-only client without calling Google', async () => {
    m.store.updateAdsAccount(accountId, { guardrails: { mode: 'read_only' } });
    const ctx = ctxFor(alice.user.id, ['mcp:read', 'ads:write']);
    const plan = await m.tools.runTool(ctx, 'ads_set_status', { account: accountId, entity: 'campaign', ids: ['1'], status: 'PAUSED', rationale: 'Testing read-only mode.' }) as { status: string };
    expect(plan.status).toBe('blocked');
    expect(calls.some(c => c.url.includes('googleAds:mutate'))).toBe(false);
    m.store.updateAdsAccount(accountId, { guardrails: { mode: 'guarded' } });
  });

  it('lets the assistant save research to the brief but not the budget', async () => {
    const ctx = ctxFor(alice.user.id, ['mcp:read', 'ads:write']);
    const updated = await m.tools.runTool(ctx, 'ads_update_client_brief', { account: accountId, competitors: ['rival.co.uk'], monthlyBudget: 99999 }) as { client: { brief: { competitors: string[] }; monthly_budget: number } };
    expect(updated.client.brief.competitors).toEqual(['rival.co.uk']);
    expect(updated.client.monthly_budget).toBe(3000);
    const run = await m.tools.runTool(ctx, 'ads_record_routine_run', { account: accountId, summary: 'Daily review complete. Raised Leads budget.', actions: ['change 123'] }) as { id: string };
    const brief = await m.tools.runTool(ctx, 'ads_get_client_brief', { account: accountId }) as { recent_routine_runs: Array<{ id: string }> };
    expect(brief.recent_routine_runs[0].id).toBe(run.id);
  });

  it('builds structured GAQL and returns flattened rows', async () => {
    const ctx = ctxFor(alice.user.id, ['mcp:read']);
    const result = await m.tools.runTool(ctx, 'ads_search', { account: accountId, fields: ['campaign.id'], resource: 'campaign', conditions: ["campaign.status = 'ENABLED'"], limit: 5 }) as { query: string };
    expect(result.query).toBe("SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED' LIMIT 5");
  });

  it('reports why Google Ads could not be reached instead of "fetch failed"', async () => {
    const dnsFailure = Object.assign(new Error('getaddrinfo ENOTFOUND googleads.googleapis.com'), { code: 'ENOTFOUND' });
    m.client.__setAdsTransportForTests({ fetcher: async () => { throw new TypeError('fetch failed', { cause: dnsFailure }); } });
    try {
      const err = await m.client.listAccessibleCustomers('alice@agency.test').catch((e: unknown) => e) as InstanceType<typeof m.client.AdsApiError>;
      expect(err).toBeInstanceOf(m.client.AdsApiError);
      expect(err.kind).toBe('NETWORK');
      expect(err.message).toMatch(/couldn't connect to googleads\.googleapis\.com \(ENOTFOUND/);
      expect(err.hint).toMatch(/DNS/);
    } finally {
      m.client.__setAdsTransportForTests({ fetcher: fakeGoogleAds });
    }
  });
});
