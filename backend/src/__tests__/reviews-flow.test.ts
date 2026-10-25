import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// End-to-end Google reviews flow through the MCP tools against a fake Business
// Profile API: discovery, linking, a silent first sync, tenancy fencing, the
// reviews:write scope, reply rules (publish vs approval vs blocked), approving
// and rejecting, alerts for new negative reviews, and access-approval errors.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-reviews-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'reviews-test-secret-1234567890';

type Mods = {
  db: typeof import('../db/database.js');
  users: typeof import('../auth/users.js');
  ws: typeof import('../auth/workspaces.js');
  tokens: typeof import('../mcp/tokens.js');
  tools: typeof import('../mcp/tools.js');
  client: typeof import('../reviews/client.js');
  store: typeof import('../reviews/store.js');
  service: typeof import('../reviews/service.js');
};
let m: Mods;

interface Call { method: string; url: string; body: Record<string, unknown> | null }
let calls: Call[] = [];
let notApproved = false;
const PARENT = 'accounts/111/locations/222';
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
let reviews: Array<Record<string, unknown>> = [];

function respond(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fakeBusinessProfile(url: string, init: RequestInit): Promise<Response> {
  const method = init.method ?? 'GET';
  const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
  calls.push({ method, url, body });
  if (notApproved) {
    return respond({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute'", details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', metadata: { quota_limit_value: '0' } }] } }, 429);
  }
  const u = new URL(url);
  if (u.pathname === '/v1/accounts') return respond({ accounts: [{ name: 'accounts/111', accountName: 'Acme Group', type: 'LOCATION_GROUP' }] });
  if (u.pathname === '/v1/accounts/111/locations') {
    return respond({ locations: [{ name: 'locations/222', title: 'Acme Plumbing Leeds', websiteUri: 'https://acme.example/', storefrontAddress: { addressLines: ['1 High St'], locality: 'Leeds', postalCode: 'LS1 1AA' }, metadata: { placeId: 'place-1', newReviewUri: 'https://g.page/r/acme/review', hasVoiceOfMerchant: true } }] });
  }
  if (u.pathname === `/v4/${PARENT}/reviews`) {
    const sorted = [...reviews].sort((a, b) => String(b.updateTime).localeCompare(String(a.updateTime)));
    const avg = sorted.reduce((sum, r) => sum + ({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 } as Record<string, number>)[String(r.starRating)], 0) / (sorted.length || 1);
    return respond({ reviews: sorted, averageRating: avg, totalReviewCount: sorted.length });
  }
  if (u.pathname === '/v1/locations/222:fetchMultiDailyMetricsTimeSeries') {
    const series = (metric: string, perDay: number) => ({ dailyMetric: metric, timeSeries: { datedValues: Array.from({ length: 56 }, (_, i) => {
      const d = new Date(now - (57 - i) * 86_400_000);
      return { date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, value: String(i >= 28 ? perDay * 2 : perDay) };
    }) } });
    return respond({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [series('CALL_CLICKS', 1), series('WEBSITE_CLICKS', 3), series('BUSINESS_IMPRESSIONS_MOBILE_MAPS', 10)] }] });
  }
  if (u.pathname === '/v1/locations/222/searchkeywords/impressions/monthly') {
    return respond({ searchKeywordsCounts: [{ searchKeyword: 'emergency plumber leeds', insightsValue: { value: '120' } }, { searchKeyword: 'acme plumbing', insightsValue: { threshold: '15' } }] });
  }
  const reply = /^\/v4\/(accounts\/111\/locations\/222\/reviews\/[^/]+)\/reply$/.exec(u.pathname);
  if (reply) {
    const review = reviews.find(r => r.name === reply[1]);
    if (!review) return respond({ error: { code: 404, message: 'not found' } }, 404);
    if (method === 'DELETE') { delete review.reviewReply; return respond({}); }
    review.reviewReply = { comment: body?.comment, updateTime: new Date().toISOString(), reviewReplyState: 'PENDING' };
    review.updateTime = new Date().toISOString();
    return respond(review.reviewReply);
  }
  return respond({ error: { code: 404, message: 'not found' } }, 404);
}

const review = (id: string, stars: string, comment: string, daysAgo: number, extra: Record<string, unknown> = {}) => ({
  name: `${PARENT}/reviews/${id}`, reviewId: id, reviewer: { displayName: `Reviewer ${id}` }, starRating: stars, comment,
  createTime: iso(daysAgo), updateTime: iso(daysAgo), ...extra,
});

let alice: { user: ReturnType<Mods['users']['createUser']>; workspaceId: string };
let bob: { user: ReturnType<Mods['users']['createUser']>; workspaceId: string };

function seedUser(label: string) {
  const user = m.users.createUser({ email: `${label}-${randomUUID()}@x.com`, password: 'password123' });
  const workspace = m.ws.bootstrapUserWorkspace(user, false);
  return { user, workspaceId: workspace.id };
}

function ctxFor(userId: string, scopes: Array<'mcp:read' | 'mcp:write' | 'ads:write' | 'reviews:write'>) {
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
    client: await import('../reviews/client.js'),
    store: await import('../reviews/store.js'),
    service: await import('../reviews/service.js'),
  };
  m.client.__setBusinessTransportForTests({ fetcher: fakeBusinessProfile, token: async () => 'test-access-token' });
  alice = seedUser('alice');
  bob = seedUser('bob');
  m.db.upsertGoogleAccount({
    id: 'alice@agency.test', email: 'alice@agency.test', client_id: '123456789012-abc.apps.googleusercontent.com', client_secret: 'secret',
    access_token: 'x', refresh_token: 'refresh', token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    granted_scopes: `${m.client.BUSINESS_SCOPE} https://www.googleapis.com/auth/userinfo.email`, workspace_id: alice.workspaceId, owner_user_id: alice.user.id,
  });
  m.db.shareGoogleAccountWithWorkspace('alice@agency.test', alice.workspaceId, alice.user.id);
  reviews = [
    review('r1', 'FIVE', 'Fixed our boiler the same day. Brilliant service from Dave.', 3),
    review('r2', 'TWO', 'Turned up two hours late and did not call ahead.', 5),
    review('r3', 'FOUR', 'Good job, a bit pricey.', 40, { reviewReply: { comment: 'Thanks for the feedback!', updateTime: iso(39), reviewReplyState: 'APPROVED' } }),
  ];
});

beforeEach(() => { calls = []; notApproved = false; });

describe('Google reviews over MCP', () => {
  let locationId = '';
  const reviewId = (googleId: string) => m.store.findReviewByName(locationId, `${PARENT}/reviews/${googleId}`)!.id;

  it('discovers and links a location, importing existing reviews without alerts', async () => {
    const ctx = ctxFor(alice.user.id, ['mcp:read', 'reviews:write']);
    const found = await m.tools.runTool(ctx, 'reviews_discover_locations', {}) as { connections: Array<{ accounts: Array<{ locations: Array<{ location_name: string; title: string }> }> }> };
    expect(found.connections[0].accounts[0].locations[0]).toMatchObject({ location_name: 'locations/222', title: 'Acme Plumbing Leeds' });
    const linked = await m.tools.runTool(ctx, 'reviews_link_location', { workspaceId: alice.workspaceId, googleAccountId: 'alice@agency.test', accountName: 'accounts/111', locationName: 'locations/222' }) as { location: { id: string; total_reviews: number; reply_rules: { mode: string } } };
    locationId = linked.location.id;
    expect(linked.location.total_reviews).toBe(3);
    expect(linked.location.reply_rules.mode).toBe('guarded');
    const unreplied = await m.tools.runTool(ctx, 'reviews_list', { location: locationId, filter: 'unreplied' }) as { total: number; reviews: Array<{ rating: number }> };
    expect(unreplied.total).toBe(2);
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('fences locations to the token owner\'s workspaces', async () => {
    const bobCtx = ctxFor(bob.user.id, ['mcp:read', 'reviews:write']);
    expect((await m.tools.runTool(bobCtx, 'reviews_list_locations', {}) as { locations: unknown[] }).locations).toEqual([]);
    await expect(m.tools.runTool(bobCtx, 'reviews_list', { location: locationId })).rejects.toThrow(/not linked/);
    await expect(m.tools.runTool(bobCtx, 'reviews_reply', { reviewId: reviewId('r1'), text: 'Thanks Dave!' })).rejects.toThrow(/not found/);
  });

  it('keeps replying behind the reviews:write scope', async () => {
    const readOnly = ctxFor(alice.user.id, ['mcp:read']);
    expect(m.tools.toolsForContext(readOnly).some(t => t.name === 'reviews_reply')).toBe(false);
    expect(m.tools.toolsForContext(readOnly).some(t => t.name === 'reviews_list')).toBe(true);
    await expect(m.tools.runTool(readOnly, 'reviews_reply', { reviewId: reviewId('r1'), text: 'Thanks!' })).rejects.toThrow(/reviews:write/);
  });

  it('keeps workspace viewers read-only even with a reviews:write token', async () => {
    const carol = m.users.createUser({ email: `carol-${randomUUID()}@x.com`, password: 'password123' });
    m.ws.addWorkspaceMember(alice.workspaceId, carol.id, 'viewer');
    const ctx = ctxFor(carol.id, ['mcp:read', 'reviews:write']);
    expect((await m.tools.runTool(ctx, 'reviews_list_locations', {}) as { locations: unknown[] }).locations).toHaveLength(1);
    await expect(m.tools.runTool(ctx, 'reviews_reply', { reviewId: reviewId('r1'), text: 'Thanks so much!' })).rejects.toThrow(/read-only/);
  });

  it('publishes a reply to a 5-star review straight away in guarded mode', async () => {
    const ctx = ctxFor(alice.user.id, ['mcp:read', 'reviews:write']);
    const result = await m.tools.runTool(ctx, 'reviews_reply', { reviewId: reviewId('r1'), text: 'Thank you! Dave will be thrilled to hear it.', rationale: 'Positive review' }) as { status: string };
    expect(result.status).toBe('published');
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(1);
    expect(m.store.getReview(reviewId('r1'))?.reply_state).toBe('PENDING');
  });

  it('holds a reply to a 2-star review for approval, then publishes the edited version', async () => {
    const ctx = ctxFor(alice.user.id, ['mcp:read', 'reviews:write']);
    const result = await m.tools.runTool(ctx, 'reviews_reply', { reviewId: reviewId('r2'), text: 'Sorry we were late. Please call us on 0113 000 0000 so we can put it right.' }) as { status: string; reply_id: string; findings: Array<{ code: string }> };
    expect(result.status).toBe('needs_approval');
    expect(result.findings.map(f => f.code)).toContain('low_rating');
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
    const approved = await m.service.approveReply(result.reply_id, { user: alice.user, text: 'Sorry we were late, and that we didn\'t call ahead. Please ring us so we can put it right.' });
    expect(approved.status).toBe('published');
    expect(calls.find(c => c.method === 'PUT')?.body?.comment).toMatch(/didn't call ahead/);
  });

  it('asks for approval for placeholders, links and replacing replies, and blocks read-only locations', async () => {
    const ctx = ctxFor(alice.user.id, ['mcp:read', 'reviews:write']);
    const placeholder = await m.tools.runTool(ctx, 'reviews_reply', { reviewId: reviewId('r1'), text: 'Thanks [Name]! Visit https://acme.example for 10% off.' }) as { status: string; findings: Array<{ code: string }> };
    expect(placeholder.status).toBe('needs_approval');
    expect(placeholder.findings.map(f => f.code)).toEqual(expect.arrayContaining(['placeholder', 'link', 'replaces_reply']));
    m.store.updateLocation(locationId, { rules: { ...m.store.getLocation(locationId)!.rules, mode: 'read_only' } });
    const blocked = await m.tools.runTool(ctx, 'reviews_reply', { reviewId: reviewId('r3'), text: 'Thanks again!' }) as { status: string };
    expect(blocked.status).toBe('blocked');
    m.store.updateLocation(locationId, { rules: { ...m.store.getLocation(locationId)!.rules, mode: 'guarded' } });
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('always routes reply deletion through approval, and lets a person reject it', async () => {
    const ctx = ctxFor(alice.user.id, ['mcp:read', 'reviews:write']);
    const result = await m.tools.runTool(ctx, 'reviews_delete_reply', { reviewId: reviewId('r3'), rationale: 'Outdated offer mentioned' }) as { status: string; reply_id: string };
    expect(result.status).toBe('needs_approval');
    expect(m.service.rejectReply(result.reply_id, alice.user).status).toBe('rejected');
    expect(calls.some(c => c.method === 'DELETE')).toBe(false);
  });

  it('raises an alert for a new negative review after the first sync', async () => {
    reviews.push(review('r4', 'ONE', 'Never again.', 0));
    reviews.push(review('r5', 'FIVE', 'Superb.', 0));
    const result = await m.service.syncLocation(m.store.getLocation(locationId)!);
    expect(result.created).toBe(2);
    expect(result.alerts).toBe(1);
    const summary = await m.tools.runTool(ctxFor(alice.user.id, ['mcp:read']), 'reviews_summary', { location: locationId }) as { stats: { total: number; distribution: Record<string, number>; unreplied_negative: number } };
    expect(summary.stats.total).toBe(5);
    expect(summary.stats.distribution['1']).toBe(1);
    expect(summary.stats.unreplied_negative).toBe(1);
  });

  it('summarises Business Profile performance against the previous period', async () => {
    const result = await m.tools.runTool(ctxFor(alice.user.id, ['mcp:read']), 'reviews_business_performance', { location: locationId, days: 28 }) as {
      totals: Record<string, { current: number; previous: number; change_pct: number | null }>; search_keywords: { keywords: Array<{ keyword: string; below_threshold: boolean }> };
    };
    expect(result.totals.calls).toMatchObject({ current: 56, previous: 28, change_pct: 100 });
    expect(result.totals.maps_impressions.current).toBe(560);
    expect(result.search_keywords.keywords[0]).toMatchObject({ keyword: 'emergency plumber leeds', below_threshold: false });
    expect(result.search_keywords.keywords[1].below_threshold).toBe(true);
  });

  it('explains an unapproved Cloud project instead of a raw quota error', async () => {
    notApproved = true;
    const err = await m.service.syncLocation(m.store.getLocation(locationId)!).catch((e: unknown) => e) as InstanceType<typeof m.client.ReviewsApiError>;
    expect(err.kind).toBe('NOT_APPROVED');
    expect(err.hint).toContain('123456789012');
    expect(m.store.getLocation(locationId)?.last_error).toMatch(/not approved/);
  });
});
