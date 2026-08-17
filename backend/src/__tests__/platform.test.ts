import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'organic-platform-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'platform-test-secret-1234567890';

let users: typeof import('../auth/users.js');
let workspaces: typeof import('../auth/workspaces.js');
let database: typeof import('../db/database.js');
let store: typeof import('../platform/store.js');

beforeAll(async () => {
  users = await import('../auth/users.js');
  workspaces = await import('../auth/workspaces.js');
  database = await import('../db/database.js');
  store = await import('../platform/store.js');
});

function tenant(label: string) {
  const user = users.createUser({ email: `${label}-${randomUUID()}@example.com`, password: 'password123' });
  const workspace = workspaces.bootstrapUserWorkspace(user, false);
  return { user, workspace };
}

describe('organic operations platform', () => {
  it('encrypts connector secrets, redacts them, and isolates every tenant query', () => {
    const a = tenant('connector-a'); const b = tenant('connector-b');
    const created = store.createIntegration({ workspaceId: a.workspace.id, provider: 'cloudflare', name: 'Edge',
      config: { zone_id: 'zone-a', api_token: 'tenant-a-secret' }, createdBy: a.user.id });
    const raw = database.getDb().prepare('SELECT config FROM integrations WHERE id=?').get(created.id) as { config: string };
    expect(raw.config).toMatch(/^enc:v1:/);
    expect(raw.config).not.toContain('tenant-a-secret');
    const publicRow = store.publicIntegration(created);
    expect(publicRow.config).toEqual({ zone_id: 'zone-a' });
    expect(publicRow.configured_secrets).toContain('api_token');
    expect(store.listIntegrations(b.workspace.id)).toEqual([]);
    expect(store.getIntegration(b.workspace.id, created.id)).toBeNull();
  });

  it('normalizes evidence, deduplicates active work, and creates explainable forecasts', () => {
    const { workspace } = tenant('evidence');
    for (let index = 0; index < 10; index++) {
      const observed = new Date(Date.now() - (9 - index) * 86_400_000).toISOString();
      store.recordMetric({ workspace_id: workspace.id, site_id: null, source: 'ga4', metric: 'sessions', dimension: '', value: 100 + index * 10, unit: 'count', observed_at: observed, provenance: { property: 'test' } });
      store.recordMetric({ workspace_id: workspace.id, site_id: null, source: 'pagespeed', metric: 'lcp_ms', dimension: 'mobile', value: 3000 - index * 100, unit: 'ms', observed_at: observed, provenance: { strategy: 'mobile' } });
    }
    expect(store.listMetrics(workspace.id, { source: 'ga4' })).toHaveLength(10);
    const forecast = store.forecastMetrics(workspace.id)[0];
    expect(forecast.metric).toBe('sessions');
    expect(forecast.forecast).toBeGreaterThan(forecast.current);
    expect(forecast.lower).toBeLessThanOrEqual(forecast.forecast);
    expect(forecast.method).toContain('90%');
    expect(store.forecastMetrics(workspace.id).some(row => row.metric === 'lcp_ms')).toBe(false);

    const first = store.createWorkItem({ workspaceId: workspace.id, source: 'content_audit', sourceRef: 'thin:/one', title: 'Thin page' });
    const second = store.createWorkItem({ workspaceId: workspace.id, source: 'content_audit', sourceRef: 'thin:/one', title: 'Duplicate signal' });
    expect(second.id).toBe(first.id);
    expect(store.updateWorkItem(workspace.id, first.id, { status: 'done' })?.resolved_at).toBeTruthy();
    const reopened = store.createWorkItem({ workspaceId: workspace.id, source: 'content_audit', sourceRef: 'thin:/one', title: 'Regressed again' });
    expect(reopened.id).not.toBe(first.id);
  });

  it('keeps intelligence readings, freshness, and forecasts isolated by website scope', () => {
    const { workspace } = tenant('site-intelligence');
    const firstSite = `site-${randomUUID()}`; const secondSite = `site-${randomUUID()}`;
    database.upsertSite({ id: firstSite, name: 'Alpha', domain: `${firstSite}.example.com`, sitemap_url: `https://${firstSite}.example.com/sitemap.xml`, gsc_url: `sc-domain:${firstSite}.example.com`, enabled: 1, workspace_id: workspace.id });
    database.upsertSite({ id: secondSite, name: 'Beta', domain: `${secondSite}.example.com`, sitemap_url: `https://${secondSite}.example.com/sitemap.xml`, gsc_url: `sc-domain:${secondSite}.example.com`, enabled: 1, workspace_id: workspace.id });
    for (let index = 0; index < 10; index++) {
      const observed = new Date(Date.now() - (9 - index) * 86_400_000).toISOString();
      store.recordMetric({ workspace_id: workspace.id, site_id: firstSite, source: 'ga4', metric: 'sessions', dimension: '', value: 10 + index, unit: 'count', observed_at: observed, provenance: {} });
      store.recordMetric({ workspace_id: workspace.id, site_id: secondSite, source: 'ga4', metric: 'sessions', dimension: '', value: 100 + index, unit: 'count', observed_at: observed, provenance: {} });
      store.recordMetric({ workspace_id: workspace.id, site_id: null, source: 'ga4', metric: 'sessions', dimension: '', value: 1000 + index, unit: 'count', observed_at: observed, provenance: {} });
    }

    expect(store.listMetrics(workspace.id, { siteId: firstSite })).toHaveLength(10);
    expect(store.listMetrics(workspace.id, { workspaceOnly: true })).toHaveLength(10);
    expect(store.listMetrics(workspace.id)).toHaveLength(30);
    const firstForecast = store.forecastMetrics(workspace.id, 30, { siteId: firstSite }).find(row => row.metric === 'sessions');
    const secondForecast = store.forecastMetrics(workspace.id, 30, { siteId: secondSite }).find(row => row.metric === 'sessions');
    const workspaceForecast = store.forecastMetrics(workspace.id, 30, { workspaceOnly: true }).find(row => row.metric === 'sessions');
    const portfolioForecast = store.forecastMetrics(workspace.id).find(row => row.metric === 'sessions');
    expect(firstForecast?.current).toBe(19);
    expect(secondForecast?.current).toBe(109);
    expect(workspaceForecast?.current).toBe(1009);
    expect(portfolioForecast?.current).toBe(1137);

    const siteOverview = store.platformOverview(workspace.id, { siteId: firstSite }) as { scope: { mode: string; site_id: string }; freshness: Array<{ source: string; observations: number }>; forecasts: Array<{ current: number }> };
    const workspaceOverview = store.platformOverview(workspace.id, { workspaceOnly: true }) as { scope: { mode: string; site_id: null }; freshness: Array<{ source: string; observations: number }> };
    expect(siteOverview.scope).toEqual({ mode: 'site', site_id: firstSite });
    expect(siteOverview.freshness).toEqual([{ source: 'ga4', observed_at: expect.any(String), observations: 10 }]);
    expect(siteOverview.forecasts[0].current).toBe(19);
    expect(workspaceOverview.scope).toEqual({ mode: 'workspace', site_id: null });
    expect(workspaceOverview.freshness[0].observations).toBe(10);
  });

  it('keeps usage append-only while allowing user anonymization and workspace deletion', () => {
    const { user, workspace } = tenant('ledger');
    const id = store.recordUsage({ workspace_id: workspace.id, user_id: user.id, provider: 'openai', operation: 'check', quantity: 2, unit: 'request', estimated_cost: 0.04 });
    expect(() => database.getDb().prepare('UPDATE usage_ledger SET quantity=99 WHERE id=?').run(id)).toThrow(/append-only/);
    expect(() => database.getDb().prepare('DELETE FROM usage_ledger WHERE id=?').run(id)).toThrow(/append-only/);
    const replacement = tenant('ledger-replacement');
    workspaces.reassignOwnedWorkspaces(user.id, replacement.user.id);
    users.deleteUser(user.id);
    expect((database.getDb().prepare('SELECT user_id FROM usage_ledger WHERE id=?').get(id) as { user_id: string | null }).user_id).toBeNull();
    workspaces.deleteWorkspace(workspace.id);
    expect(database.getDb().prepare('SELECT 1 FROM usage_ledger WHERE id=?').get(id)).toBeUndefined();
  });

  it('enforces workspace and user hard budgets before paid operations', () => {
    const { user, workspace } = tenant('budget');
    const policyId = store.upsertBudget({ workspaceId: workspace.id, provider: 'openai', period: 'daily', limitValue: 2, limitUnit: 'quantity', hardLimit: true });
    store.recordUsage({ workspace_id: workspace.id, user_id: user.id, provider: 'openai', operation: 'check', quantity: 2, unit: 'check', estimated_cost: 0 });
    expect(() => store.assertWithinBudget({ workspaceId: workspace.id, userId: user.id, provider: 'openai', quantity: 1 })).toThrow(/budget reached/);
    expect(() => store.assertWithinBudget({ workspaceId: workspace.id, provider: 'cloudflare', quantity: 1 })).not.toThrow();
    const foreign = tenant('budget-foreign');
    expect(() => store.upsertBudget({ id: policyId, workspaceId: foreign.workspace.id, limitValue: 999 })).toThrow(/not found/);
  });

  it('creates one-time scoped tokens and rejects revoked or under-scoped use', () => {
    const { user, workspace } = tenant('token');
    const created = store.createServiceToken({ workspaceId: workspace.id, userId: user.id, name: 'CI', scopes: ['metrics:read'] });
    expect(created.token).toMatch(/^oc_/);
    expect(database.getDb().prepare('SELECT token_hash FROM service_tokens WHERE id=?').get(created.id)).not.toEqual({ token_hash: created.token });
    expect(store.authenticateServiceToken(created.token, 'metrics:read')?.workspaceId).toBe(workspace.id);
    expect(store.authenticateServiceToken(created.token, 'logs:write')).toBeNull();
    expect(store.revokeServiceToken(workspace.id, created.id)).toBe(true);
    expect(store.authenticateServiceToken(created.token, 'metrics:read')).toBeNull();
  });

  it('cannot overwrite another user or tenant saved view by guessing its id', () => {
    const a = tenant('view-a'); const b = tenant('view-b');
    const id = store.saveDashboardView({ workspaceId: a.workspace.id, userId: a.user.id, name: 'A private view', config: { source: 'ga4' } });
    expect(() => store.saveDashboardView({ workspaceId: b.workspace.id, userId: b.user.id, id, name: 'Hijacked', config: {} })).toThrow(/not found/);
    expect(store.listDashboardViews(a.workspace.id, a.user.id)[0].name).toBe('A private view');
  });

  it('retains governed publishing state and OAuth credentials inside one workspace', async () => {
    const a = tenant('action-a'); const b = tenant('action-b');
    const action = store.createContentAction({ workspaceId: a.workspace.id, userId: a.user.id, kind: 'metadata', title: 'Improve title', payload: { title: 'Better' } });
    expect(action.status).toBe('proposed');
    expect(store.getContentAction(b.workspace.id, action.id)).toBeNull();
    expect(store.updateContentAction(a.workspace.id, action.id, { status: 'approved', approvedBy: a.user.id })?.status).toBe('approved');

    const account = workspaces.addBingOAuthAccount(a.workspace.id, 'Delegated Bing', { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
    expect(account.auth_type).toBe('oauth');
    const raw = database.getDb().prepare('SELECT access_token,refresh_token FROM bing_accounts WHERE id=?').get(account.id) as { access_token: string; refresh_token: string };
    expect(raw.access_token).toMatch(/^enc:v1:/); expect(raw.refresh_token).toMatch(/^enc:v1:/);
    expect(workspaces.listBingAccounts(b.workspace.id)).toEqual([]);
  });

  it('models market entities without leaking local knowledge across workspaces', () => {
    const a = tenant('entity-a'); const b = tenant('entity-b');
    const entity = store.saveLocalEntity({ workspaceId: a.workspace.id, name: 'Example Group', market: 'London', locale: 'en-GB',
      primaryUrl: 'https://example.com/london', address: '1 Example Street', phone: '+44 20 0000 0000',
      identifiers: { wikidata: 'Q123' }, listings: [{ provider: 'Google Business Profile', status: 'consistent' }], reviewRating: 4.8, reviewCount: 100 });
    expect(entity.consistency_score).toBeGreaterThanOrEqual(80);
    expect(store.listLocalEntities(a.workspace.id)).toHaveLength(1);
    expect(store.listLocalEntities(b.workspace.id)).toEqual([]);
    expect(() => store.saveLocalEntity({ id: entity.id, workspaceId: b.workspace.id, name: 'Hijack', market: 'Paris' })).toThrow(/not found/);
  });
});
