import { describe, it, expect } from 'vitest';
import { AdsApiError, buildGaql, cleanCustomerId, flattenRow, formatCustomerId, microsToUnits, networkError, parseAdsError, unitsToMicros } from '../ads/client.js';
import {
  addKeywordOperations, budgetAmountOperation, campaignBiddingOperation, operationTypeFor, resourceName,
  responsiveSearchAdOperation, searchCampaignOperations, statusOperations,
} from '../ads/operations.js';
import { buildRoutinePrompt, cadenceCron, normalizeRoutine } from '../ads/routine-prompt.js';
import { normalizeBrief, normalizeGuardrails, type AdsAccount } from '../ads/store.js';

describe('Google Ads identifiers and money', () => {
  it('cleans customer ids in every common format', () => {
    expect(cleanCustomerId('123-456-7890')).toBe('1234567890');
    expect(cleanCustomerId('customers/1234567890')).toBe('1234567890');
    expect(cleanCustomerId(1234567890)).toBe('1234567890');
    expect(() => cleanCustomerId('12345')).toThrow(AdsApiError);
    expect(formatCustomerId('1234567890')).toBe('123-456-7890');
  });

  it('converts between currency units and micros', () => {
    expect(unitsToMicros(45.5)).toBe('45500000');
    expect(unitsToMicros(0.019)).toBe('20000');
    expect(microsToUnits('45500000')).toBe(45.5);
    expect(() => unitsToMicros(-1)).toThrow();
  });
});

describe('GAQL helpers', () => {
  it('builds the same query shape as the upstream search tool', () => {
    expect(buildGaql({ fields: ['campaign.id', 'metrics.clicks'], resource: 'campaign', conditions: ["campaign.status = 'ENABLED'", 'segments.date DURING LAST_7_DAYS'], orderings: ['metrics.clicks DESC'], limit: 10 }))
      .toBe("SELECT campaign.id, metrics.clicks FROM campaign WHERE campaign.status = 'ENABLED' AND segments.date DURING LAST_7_DAYS ORDER BY metrics.clicks DESC LIMIT 10");
    expect(() => buildGaql({ fields: ['campaign.id; DROP'], resource: 'campaign' })).toThrow(/not a valid GAQL field/);
    expect(() => buildGaql({ fields: [], resource: 'campaign' })).toThrow();
  });

  it('flattens REST rows to snake_case dotted keys', () => {
    expect(flattenRow({ campaign: { id: '1', biddingStrategyType: 'MANUAL_CPC' }, metrics: { costMicros: '10' } }))
      .toEqual({ 'campaign.id': '1', 'campaign.bidding_strategy_type': 'MANUAL_CPC', 'metrics.cost_micros': '10' });
  });
});

describe('Google Ads error mapping', () => {
  it('turns a disabled API into an actionable hint', () => {
    const err = parseAdsError(403, { error: { code: 403, message: 'Google Ads API has not been used in project 123 before or it is disabled.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } }, '123456789');
    expect(err.kind).toBe('API_DISABLED');
    expect(err.hint).toContain('googleads.googleapis.com?project=123456789');
  });

  it('recognises a project that only has Test access', () => {
    const err = parseAdsError(403, { error: { details: [{ errors: [{ errorCode: { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }, message: 'The Google Cloud project is only approved for test accounts.' }] }] } }, '42424242');
    expect(err.kind).toBe('ACCESS_LEVEL');
    expect(err.hint).toContain('ads-apis/overview?project=42424242');
  });

  it('asks for the Ads scope on insufficient scopes and keeps the request id', () => {
    const err = parseAdsError(403, { error: { message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', details: [{ requestId: 'abc' }] } }, null);
    expect(err.kind).toBe('NO_ADS_SCOPE');
    expect(err.requestId).toBe('abc');
  });

  it('explains manager access problems', () => {
    const err = parseAdsError(403, { error: { details: [{ errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' }, message: 'User doesn\'t have permission to access customer.' }] }] } }, null);
    expect(err.kind).toBe('PERMISSION');
    expect(err.hint).toMatch(/manager/);
  });
});

describe('Google Ads network failures', () => {
  const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause });

  it('names the DNS failure behind a bare "fetch failed"', () => {
    const err = networkError(fetchFailed(Object.assign(new Error('getaddrinfo ENOTFOUND googleads.googleapis.com'), { code: 'ENOTFOUND' })), 'googleads.googleapis.com');
    expect(err?.kind).toBe('NETWORK');
    expect(err?.message).toContain('ENOTFOUND');
    expect(err?.hint).toMatch(/Pi-hole/);
  });

  it('digs the code out of an AggregateError from dual-stack connects', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 0.0.0.0:443'), { code: 'ECONNREFUSED' });
    const err = networkError(fetchFailed(new AggregateError([refused], 'connect failed')), 'googleads.googleapis.com');
    expect(err?.message).toContain('ECONNREFUSED');
    expect(err?.hint).toMatch(/refused/);
  });

  it('explains timeouts and TLS interception', () => {
    expect(networkError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'googleads.googleapis.com')?.message).toMatch(/did not answer/);
    const tls = networkError(fetchFailed(Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })), 'googleads.googleapis.com');
    expect(tls?.hint).toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  it('leaves other errors alone', () => {
    expect(networkError(new Error('invalid_grant'), 'oauth2.googleapis.com')).toBeNull();
    expect(networkError('nope', 'oauth2.googleapis.com')).toBeNull();
  });
});

describe('operation builders', () => {
  const cid = '1234567890';

  it('accepts ids or resource names, and refuses other accounts\' resources', () => {
    expect(resourceName(cid, 'campaign', 55)).toBe(`customers/${cid}/campaigns/55`);
    expect(resourceName(cid, 'ad_group_criterion', '1~2')).toBe(`customers/${cid}/adGroupCriteria/1~2`);
    expect(() => resourceName(cid, 'ad_group_criterion', '12')).toThrow(/adGroupId~id/);
    expect(() => resourceName(cid, 'campaign', 'customers/9999999999/campaigns/1')).toThrow(/different ad account/);
    expect(operationTypeFor(`customers/${cid}/adGroupAds/1~2`)).toBe('adGroupAdOperation');
  });

  it('builds status updates and permanent removals', () => {
    expect(statusOperations(cid, 'campaign', ['1'], 'PAUSED')[0]).toEqual({ campaignOperation: { update: { resourceName: `customers/${cid}/campaigns/1`, status: 'PAUSED' }, updateMask: 'status' } });
    expect(statusOperations(cid, 'ad_group', ['7'], 'REMOVED')[0]).toEqual({ adGroupOperation: { remove: `customers/${cid}/adGroups/7` } });
    expect(() => statusOperations(cid, 'campaign_criterion', ['1~2'], 'PAUSED')).toThrow(/only be removed/);
  });

  it('builds budget, bidding and keyword operations', () => {
    expect(budgetAmountOperation(cid, 9, 12.34)).toEqual({ campaignBudgetOperation: { update: { resourceName: `customers/${cid}/campaignBudgets/9`, amountMicros: '12340000' }, updateMask: 'amountMicros' } });
    expect(campaignBiddingOperation(cid, 3, 'MAXIMIZE_CONVERSIONS', { targetCpa: 25 })).toMatchObject({ campaignOperation: { updateMask: 'maximizeConversions.targetCpaMicros' } });
    const kws = addKeywordOperations(cid, 4, [{ text: '  emergency   plumber ', matchType: 'EXACT' }], { negative: true });
    expect(kws[0]).toEqual({ adGroupCriterionOperation: { create: { adGroup: `customers/${cid}/adGroups/4`, status: 'ENABLED', keyword: { text: 'emergency plumber', matchType: 'EXACT' }, negative: true } } });
  });

  it('validates responsive search ad limits', () => {
    const good = { finalUrl: 'https://example.com/', headlines: ['One', 'Two', { text: 'Three', pin: 1 as const }], descriptions: ['First line', 'Second line'] };
    const op = responsiveSearchAdOperation(cid, 4, good) as { adGroupAdOperation: { create: { status: string; ad: { responsiveSearchAd: { headlines: Array<{ pinnedField?: string }> } } } } };
    expect(op.adGroupAdOperation.create.status).toBe('PAUSED');
    expect(op.adGroupAdOperation.create.ad.responsiveSearchAd.headlines[2].pinnedField).toBe('HEADLINE_1');
    expect(() => responsiveSearchAdOperation(cid, 4, { ...good, headlines: ['a', 'b'] })).toThrow(/3–15 headlines/);
    expect(() => responsiveSearchAdOperation(cid, 4, { ...good, headlines: ['x'.repeat(31), 'b', 'c'] })).toThrow(/1–30 characters/);
  });

  it('creates a complete paused search campaign with linked temporary ids', () => {
    const ops = searchCampaignOperations(cid, {
      name: 'Emergency plumbing', dailyBudget: 40, biddingStrategy: 'MAXIMIZE_CONVERSIONS', targetCpa: 30,
      locationIds: ['2826'], languageIds: ['1000'], keywords: [{ text: 'emergency plumber' }],
      ad: { finalUrl: 'https://example.com', headlines: ['A', 'B', 'C'], descriptions: ['D', 'E'] },
    });
    const campaign = ops.find(op => 'campaignOperation' in op) as { campaignOperation: { create: Record<string, unknown> } };
    expect(campaign.campaignOperation.create.status).toBe('PAUSED');
    expect(campaign.campaignOperation.create.campaignBudget).toBe(`customers/${cid}/campaignBudgets/-1`);
    expect(campaign.campaignOperation.create.maximizeConversions).toEqual({ targetCpaMicros: '30000000' });
    expect(ops.filter(op => 'campaignCriterionOperation' in op)).toHaveLength(2);
    expect(ops.at(-1)).toHaveProperty('adGroupAdOperation');
  });
});

describe('client brief and routine prompt', () => {
  const account: AdsAccount = {
    id: 'acc-1', workspace_id: 'ws', google_account_id: 'g', customer_id: '1234567890', login_customer_id: '9999999999',
    name: 'Acme Plumbing', currency: 'GBP', time_zone: 'Europe/London', is_manager: false, test_account: false,
    monthly_budget: 1500, brief: normalizeBrief({ goal: 'leads', target_cpa: 40, competitors: 'a.com, b.com\nb.com', markets: 'Leeds and Bradford' }),
    guardrails: normalizeGuardrails({}), enabled: true, last_checked_at: null, last_error: null, created_by: null, created_at: '', updated_at: '',
  };

  it('normalises briefs and de-duplicates competitors', () => {
    expect(account.brief.competitors).toEqual(['a.com', 'b.com']);
    expect(normalizeBrief({ target_cpa: -3, unknown: 'x' })).toEqual({});
  });

  it('builds a prompt that carries budgets, goals, cadence and the right apply rule', () => {
    const settings = normalizeRoutine({ cadence: 'weekdays', time: '06:30', timezone: 'Europe/London', mode: 'autopilot', focus: ['pacing', 'waste'] });
    const { prompt, schedule, cron } = buildRoutinePrompt({ settings, accounts: [account], connectorName: 'Indexer', endpoint: 'https://seo.example.com/mcp', dashboardUrl: 'https://seo.example.com/ads?tab=changes' });
    expect(schedule).toBe('every weekday (Monday–Friday) at 06:30 (Europe/London)');
    expect(cron).toBe('30 6 * * 1-5');
    expect(prompt).toContain('Acme Plumbing — account id `acc-1`, Google Ads customer 123-456-7890');
    expect(prompt).toContain('Monthly budget: £1,500.00');
    expect(prompt).toContain('target CPA £40.00');
    expect(prompt).toContain('apply it with ads_apply_change');
    expect(prompt).toContain('https://seo.example.com/mcp');
    const propose = buildRoutinePrompt({ settings: { ...settings, mode: 'propose' }, accounts: [account], connectorName: 'Indexer', endpoint: 'x', dashboardUrl: 'y' });
    expect(propose.prompt).toContain('do NOT apply it');
  });

  it('rejects invalid routine settings', () => {
    const s = normalizeRoutine({ cadence: 'hourly', time: '25:00', timezone: 'Mars/Base', lookback_days: 3, focus: ['bogus'] });
    expect(s).toMatchObject({ cadence: 'daily', time: '07:00', timezone: 'Europe/London', lookback_days: 30 });
    expect(s.focus.length).toBeGreaterThan(0);
    expect(cadenceCron({ cadence: 'twice_weekly', time: '09:05' })).toBe('5 9 * * 1,4');
  });
});
