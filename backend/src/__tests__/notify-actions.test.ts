import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Notifications people act on: per-channel event routing, named email lists,
// WhatsApp Cloud API messages, links rendered per channel, approval alerts
// batched with deep links into the right workspace (/w/<slug>/…), workspace
// slugs, and saved Google OAuth clients. fetch and SMTP are stubbed.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-notify-actions-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'notify-actions-secret';
process.env.PUBLIC_URL = 'https://seo.example.test';
process.env.NOTIFY_BATCH_SECONDS = '600';

const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; text: string; html?: string }> }));
vi.mock('../utils/email.js', () => ({
  emailConfigured: () => true,
  sendEmail: async (m: { to: string; subject: string; text: string; html?: string }) => { mail.sent.push(m); return true; },
  verifyEmail: async () => undefined,
}));

type DbMod = typeof import('../db/database.js');
type NotifyMod = typeof import('../utils/notify.js');
type AlertsMod = typeof import('../utils/approval-alerts.js');
type WsMod = typeof import('../auth/workspaces.js');
type ClientsMod = typeof import('../auth/oauth-clients.js');
let db: DbMod;
let notify: NotifyMod;
let alerts: AlertsMod;
let workspaces: WsMod;
let clients: ClientsMod;
let users: typeof import('../auth/users.js');
let WS: string;
let OWNER: string;

interface Call { url: string; init: RequestInit }
let calls: Call[] = [];
function stubFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response('{}', { status: 200 })) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit = {}) => { calls.push({ url: String(url), init }); return respond(String(url), init); }));
}
const bodyOf = (c: Call) => JSON.parse(String(c.init.body));
const headersOf = (c: Call) => new Headers(c.init.headers);

function newWorkspace(name = 'Acme Roofing'): { ws: string; owner: string } {
  const u = users.createUser({ email: `u-${randomUUID()}@x.com`, password: 'password123' });
  return { ws: workspaces.createWorkspace(name, u.id).id, owner: u.id };
}
function clear(ws: string) { for (const k of notify.NOTIFY_KEYS) db.setWorkspaceSetting(ws, k, ''); }

beforeAll(async () => {
  db = await import('../db/database.js');
  notify = await import('../utils/notify.js');
  alerts = await import('../utils/approval-alerts.js');
  users = await import('../auth/users.js');
  workspaces = await import('../auth/workspaces.js');
  clients = await import('../auth/oauth-clients.js');
  ({ ws: WS, owner: OWNER } = newWorkspace());
});

beforeEach(() => { clear(WS); mail.sent = []; stubFetch(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('workspace slugs', () => {
  it('gives each workspace a readable, unique slug that survives a rename', () => {
    const a = newWorkspace('Café Déjà Vu!').ws;
    const b = newWorkspace('Cafe deja vu').ws;
    expect(workspaces.workspaceSlug(a)).toBe('cafe-deja-vu');
    expect(workspaces.workspaceSlug(b)).toBe('cafe-deja-vu-2');
    workspaces.renameWorkspace(a, 'Something Else');
    expect(workspaces.workspaceSlug(a)).toBe('cafe-deja-vu');
    expect(workspaces.findWorkspaceByRef('CAFE-DEJA-VU')?.id).toBe(a);
    expect(workspaces.findWorkspaceByRef(b)?.id).toBe(b);
  });

  it('builds deep links inside the workspace', async () => {
    const { workspaceLink } = await import('../utils/links.js');
    expect(workspaceLink(WS, '/approve/reply/r1')).toBe(`https://seo.example.test/w/${workspaces.workspaceSlug(WS)}/approve/reply/r1`);
  });
});

describe('routing and email lists', () => {
  it('normalises email lists and routes from the settings form', () => {
    const lists = notify.normalizeEmailLists([
      { id: 'ops', name: ' Ops ', to: 'a@x.com; bad, b@x.com a@x.com', events: ['ads_approvals', 'nope'] },
      { name: 'Empty', to: 'not-an-email' },
    ]);
    expect(lists).toEqual([{ id: 'ops', name: 'Ops', to: 'a@x.com, b@x.com', events: ['ads_approvals'] }]);
    expect(notify.normalizeRoutes({ slack: ['review_approvals', 'x'], bogus: ['run_failed'], whatsapp: 'all' })).toEqual({ slack: ['review_approvals'] });
  });

  it('sends each event to the default list (if routed) and every list subscribed to it', () => {
    db.setWorkspaceSetting(WS, 'notify_email_to', 'owner@x.com');
    db.setWorkspaceSetting(WS, 'notify_email_lists', JSON.stringify([
      { id: 'ads', name: 'Ads team', to: 'ads@x.com, owner@x.com', events: ['ads_approvals', 'ads_alerts'] },
      { id: 'all', name: 'Everything', to: 'boss@x.com', events: null },
    ]));
    expect(notify.emailRecipients(WS, 'ads_approvals').sort()).toEqual(['ads@x.com', 'boss@x.com', 'owner@x.com']);
    expect(notify.emailRecipients(WS, 'review_approvals').sort()).toEqual(['boss@x.com', 'owner@x.com']);
    db.setWorkspaceSetting(WS, 'notify_routes', JSON.stringify({ email: ['run_failed'] }));
    expect(notify.emailRecipients(WS, 'review_approvals')).toEqual(['boss@x.com']);
    expect(notify.emailRecipients(WS, 'test').sort()).toEqual(['ads@x.com', 'boss@x.com', 'owner@x.com']);
  });

  it('only sends an event to the channels routed for it', async () => {
    db.setWorkspaceSetting(WS, 'notify_slack_webhook', 'https://hooks.slack.com/services/x');
    db.setWorkspaceSetting(WS, 'notify_webhook_url', 'https://hooks.example.test/in');
    db.setWorkspaceSetting(WS, 'notify_routes', JSON.stringify({ slack: ['ads_approvals'] }));
    await notify.sendWorkspaceNotification(WS, 'Reply waiting', 'body', 'review_approvals');
    expect(calls.map(c => c.url)).toEqual(['https://hooks.example.test/in']);
    await notify.sendWorkspaceNotification(WS, 'Ads change waiting', 'body', 'ads_approvals');
    expect(calls.map(c => c.url).sort()).toEqual(['https://hooks.example.test/in', 'https://hooks.example.test/in', 'https://hooks.slack.com/services/x'].sort());
  });

  it('emails each recipient separately, with the links as buttons', async () => {
    db.setWorkspaceSetting(WS, 'notify_email_lists', JSON.stringify([{ id: 'l', name: 'L', to: 'a@x.com, b@x.com', events: null }]));
    const ok = await notify.sendWorkspaceNotification(WS, 'Reply waiting', 'A 2-star review <script>', 'review_approvals', {
      links: [{ label: 'Approve or reject', url: 'https://seo.example.test/w/acme/approve/reply/1' }],
    });
    expect(ok).toBe(true);
    expect(mail.sent.map(m => m.to).sort()).toEqual(['a@x.com', 'b@x.com']);
    expect(mail.sent[0].text).toContain('Approve or reject: https://seo.example.test/w/acme/approve/reply/1');
    expect(mail.sent[0].html).toContain('href="https://seo.example.test/w/acme/approve/reply/1"');
    expect(mail.sent[0].html).not.toContain('<script>');
  });
});

describe('links per channel', () => {
  it('renders links natively for Slack, ntfy, Telegram and the JSON webhook', async () => {
    db.setWorkspaceSetting(WS, 'notify_slack_webhook', 'https://hooks.slack.com/services/x');
    db.setWorkspaceSetting(WS, 'notify_ntfy_topic', 'acme-alerts');
    db.setWorkspaceSetting(WS, 'notify_telegram_token', 'BOT');
    db.setWorkspaceSetting(WS, 'notify_telegram_chat', '42');
    db.setWorkspaceSetting(WS, 'notify_webhook_url', 'https://hooks.example.test/in');
    const url = 'https://seo.example.test/w/acme/approve/ads/c1';
    await notify.sendWorkspaceNotification(WS, 'Budget change waiting', 'Raise the daily budget', 'ads_approvals', { links: [{ label: 'Approve or reject', url }] });
    const by = (part: string) => calls.find(c => c.url.includes(part))!;
    expect(bodyOf(by('hooks.slack.com')).text).toContain(`<${url}|Approve or reject>`);
    expect(headersOf(by('ntfy.sh')).get('Click')).toBe(url);
    expect(headersOf(by('ntfy.sh')).get('Actions')).toBe(`view, Approve or reject, ${url}`);
    expect(bodyOf(by('api.telegram.org')).text).toContain(`<a href="${url}">Approve or reject</a>`);
    expect(bodyOf(by('hooks.example.test'))).toMatchObject({ title: 'Budget change waiting', event: 'ads_approvals', links: [{ label: 'Approve or reject', url }] });
  });
});

describe('WhatsApp Cloud API', () => {
  beforeEach(() => {
    db.setWorkspaceSetting(WS, 'notify_whatsapp_token', 'EAAG-token');
    db.setWorkspaceSetting(WS, 'notify_whatsapp_phone_id', '1234567890');
    db.setWorkspaceSetting(WS, 'notify_whatsapp_to', '+44 7700 900123, 07700');
  });

  it('is a configured channel once token, phone number ID and recipients are set', () => {
    expect(notify.configuredChannels(WS)).toContain('whatsapp');
  });

  it('sends a template message with the notification as its one parameter', async () => {
    db.setWorkspaceSetting(WS, 'notify_whatsapp_template', 'seo_alert');
    db.setWorkspaceSetting(WS, 'notify_whatsapp_lang', 'en_GB');
    await notify.sendWorkspaceNotification(WS, 'Reply waiting', 'Line one\n\nLine two', 'review_approvals', { links: [{ label: 'Approve or reject', url: 'https://seo.example.test/w/acme/approve/reply/1' }] });
    expect(calls).toHaveLength(1); // the too-short number is skipped
    expect(calls[0].url).toBe('https://graph.facebook.com/v23.0/1234567890/messages');
    expect(headersOf(calls[0]).get('Authorization')).toBe('Bearer EAAG-token');
    const body = bodyOf(calls[0]);
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '447700900123', type: 'template', template: { name: 'seo_alert', language: { code: 'en_GB' } } });
    const param = body.template.components[0].parameters[0].text as string;
    expect(param).not.toMatch(/\n/);
    expect(param).toContain('Approve or reject: https://seo.example.test/w/acme/approve/reply/1');
  });

  it('sends free-form text without a template and explains the 24-hour window when Meta refuses', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } }), { status: 400 }));
    const results = await notify.sendTestNotification(WS);
    const wa = results.find(r => r.channel === 'whatsapp')!;
    expect(bodyOf(calls[0])).toMatchObject({ type: 'text', to: '447700900123' });
    expect(wa.ok).toBe(false);
    expect(wa.error).toContain('within 24 hours');
  });
});

describe('approval alerts', () => {
  beforeEach(async () => {
    await alerts.flushApprovalAlerts();
    calls = [];
    db.setWorkspaceSetting(WS, 'notify_webhook_url', 'https://hooks.example.test/in');
  });

  it('sends one item with an "Approve or reject" link into its workspace', async () => {
    alerts.queueApprovalAlert(WS, 'review_approvals', { headline: 'Reply to a 2-star review — Acme', detail: 'Sorry to hear that…', path: '/approve/reply/r1' });
    expect(calls).toHaveLength(0); // batched, not sent straight away
    expect(await alerts.flushApprovalAlerts()).toBe(1);
    const sent = bodyOf(calls[0]);
    expect(sent.title).toBe('Reply to a 2-star review — Acme — Acme Roofing');
    expect(sent.event).toBe('review_approvals');
    expect(sent.links).toEqual([{ label: 'Approve or reject', url: `https://seo.example.test/w/${workspaces.workspaceSlug(WS)}/approve/reply/r1` }]);
  });

  it('gathers several items into one message with a link to all of them', async () => {
    for (let i = 1; i <= 3; i++) alerts.queueApprovalAlert(WS, 'ads_approvals', { headline: `Change ${i}`, path: `/approve/ads/c${i}` });
    await alerts.flushApprovalAlerts();
    expect(calls).toHaveLength(1);
    const sent = bodyOf(calls[0]);
    const slug = workspaces.workspaceSlug(WS);
    expect(sent.title).toBe('3 Google Ads changes waiting for approval — Acme Roofing');
    expect(sent.body).toContain('• Change 3');
    expect(sent.links.map((l: { url: string }) => l.url)).toEqual([
      `https://seo.example.test/w/${slug}/ads?tab=changes`,
      `https://seo.example.test/w/${slug}/approve/ads/c1`,
      `https://seo.example.test/w/${slug}/approve/ads/c2`,
    ]);
  });

  it('respects the event being switched off', async () => {
    db.setWorkspaceSetting(WS, 'notify_ads_alerts', 'false');
    alerts.queueApprovalAlert(WS, 'ads_alerts', { headline: 'Failed', path: '/approve/ads/x' });
    expect(await alerts.flushApprovalAlerts()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('saved Google OAuth clients', () => {
  it('saves a client once per workspace, keeps the secret encrypted and never returns it', () => {
    const saved = clients.saveOAuthClient({ workspaceId: WS, userId: OWNER, clientId: ' 123-abc.apps.googleusercontent.com ', clientSecret: 'GOCSPX-one', label: 'Ads project' });
    expect(saved).not.toHaveProperty('client_secret');
    expect(saved.client_id).toBe('123-abc.apps.googleusercontent.com');
    const again = clients.saveOAuthClient({ workspaceId: WS, userId: OWNER, clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-two' });
    expect(again.id).toBe(saved.id);
    expect(again.label).toBe('Ads project');
    expect(clients.oauthClientCredentials(saved.id)).toEqual({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-two' });
    const raw = db.getDb().prepare('SELECT client_secret FROM google_oauth_clients WHERE id = ?').get(saved.id) as { client_secret: string };
    expect(raw.client_secret).not.toContain('GOCSPX');
  });

  it('rejects anything that is not a Google OAuth client', () => {
    expect(() => clients.saveOAuthClient({ workspaceId: WS, userId: OWNER, clientId: 'my-client', clientSecret: 's' })).toThrow(/apps\.googleusercontent\.com/);
    expect(() => clients.saveOAuthClient({ workspaceId: WS, userId: OWNER, clientId: '9-x.apps.googleusercontent.com', clientSecret: ' ' })).toThrow(/secret/);
  });

  it('lists the workspace\'s clients and the person\'s own from other workspaces once each', async () => {
    const { ws: other } = newWorkspace('Other');
    const mine = clients.saveOAuthClient({ workspaceId: other, userId: OWNER, clientId: '555555-gbp.apps.googleusercontent.com', clientSecret: 's', label: 'GBP project' });
    clients.saveOAuthClient({ workspaceId: WS, userId: OWNER, clientId: '555555-gbp.apps.googleusercontent.com', clientSecret: 's' });
    const listed = clients.listOAuthClients(WS, OWNER).filter(c => c.client_id.startsWith('555555-'));
    expect(listed).toHaveLength(1);
    expect(listed[0].workspace_id).toBe(WS);
    const stranger = users.createUser({ email: `s-${randomUUID()}@x.com`, password: 'password123' }).id;
    expect(clients.listOAuthClients(other, stranger).map(c => c.id)).toEqual([mine.id]);

    const { googleProjects } = await import('../auth/google-health.js');
    const project = googleProjects(WS, OWNER).find(p => p.project === '555555');
    expect(project).toMatchObject({ connections: [], saved_client_id: listed[0].id });
    expect(project?.source_id).toBe(`client:${listed[0].id}`);

    clients.deleteOAuthClient(mine.id);
    expect(clients.getOAuthClient(mine.id)).toBeNull();
  });
});
