import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Notification fan-out is now PER-WORKSPACE: channels are read from that
// workspace's overrides, dispatched with the right URL/shape, and reported
// independently. fetch is stubbed so no network. Also verifies that one
// workspace's channels never fire for another's config.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-notify-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'notify-test-secret';

type DbMod = typeof import('../db/database.js');
type NotifyMod = typeof import('../utils/notify.js');
type UsersMod = typeof import('../auth/users.js');
type WsMod = typeof import('../auth/workspaces.js');
let db: DbMod;
let notify: NotifyMod;
let users: UsersMod;
let workspaces: WsMod;
let WS: string;

function newWorkspace(): string {
  const u = users.createUser({ email: `u-${randomUUID()}@x.com`, password: 'password123' });
  return workspaces.createWorkspace('W', u.id).id;
}

beforeAll(async () => {
  db = await import('../db/database.js');
  notify = await import('../utils/notify.js');
  users = await import('../auth/users.js');
  workspaces = await import('../auth/workspaces.js');
  WS = newWorkspace();
});

function clear(ws: string) {
  for (const k of notify.NOTIFY_KEYS) db.setWorkspaceSetting(ws, k, '');
}

describe('per-workspace notification channels', () => {
  beforeEach(() => { clear(WS); vi.restoreAllMocks(); });

  it('reports which channels a workspace has configured', () => {
    expect(notify.configuredChannels(WS)).toEqual([]);
    db.setWorkspaceSetting(WS, 'notify_slack_webhook', 'https://hooks.slack.com/services/x');
    db.setWorkspaceSetting(WS, 'notify_telegram_token', 'tok');
    db.setWorkspaceSetting(WS, 'notify_telegram_chat', '123');
    expect(notify.configuredChannels(WS).sort()).toEqual(['slack', 'telegram']);
  });

  it('dispatches to every configured channel with the right endpoint', async () => {
    db.setWorkspaceSetting(WS, 'notify_slack_webhook', 'https://hooks.slack.com/services/x');
    db.setWorkspaceSetting(WS, 'notify_telegram_token', 'BOT');
    db.setWorkspaceSetting(WS, 'notify_telegram_chat', '42');
    db.setWorkspaceSetting(WS, 'notify_webhook_url', 'https://example.com/hook');

    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return { ok: true, status: 200, statusText: 'OK' } as Response; }));

    const results = await notify.sendTestNotification(WS);
    expect(results.every(r => r.ok)).toBe(true);
    expect(results.map(r => r.channel).sort()).toEqual(['slack', 'telegram', 'webhook']);
    expect(calls.some(u => u.includes('hooks.slack.com'))).toBe(true);
    expect(calls.some(u => u.includes('api.telegram.org/botBOT/sendMessage'))).toBe(true);
    expect(calls.some(u => u === 'https://example.com/hook')).toBe(true);
    const deliveries = notify.listNotificationDeliveries(WS);
    expect(deliveries.slice(0, 3).every(row => row.status === 'sent' && row.event_type === 'test')).toBe(true);
  });

  it('reports per-channel failure without failing the others', async () => {
    db.setWorkspaceSetting(WS, 'notify_slack_webhook', 'https://hooks.slack.com/services/x');
    db.setWorkspaceSetting(WS, 'notify_webhook_url', 'https://example.com/hook');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const ok = String(url).includes('example.com');
      return { ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'Server Error' } as Response;
    }));

    const results = await notify.sendTestNotification(WS);
    const byChannel = Object.fromEntries(results.map(r => [r.channel, r]));
    expect(byChannel.webhook.ok).toBe(true);
    expect(byChannel.slack.ok).toBe(false);
    expect(byChannel.slack.error).toContain('500');
    expect(await notify.sendWorkspaceNotification(WS, 't', 'b')).toBe(true);
  });

  it('does not leak one workspace\'s channels into another', async () => {
    const other = newWorkspace();
    db.setWorkspaceSetting(WS, 'notify_webhook_url', 'https://a.example.com/hook');
    expect(notify.configuredChannels(other)).toEqual([]);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return { ok: true, status: 200, statusText: 'OK' } as Response; }));
    await notify.sendTestNotification(other);
    expect(calls).toHaveLength(0); // the other workspace has nothing configured
  });

  it('honours per-event routing preferences and keeps them tenant scoped', () => {
    const other = newWorkspace();
    expect(notify.notificationEventEnabled(WS, 'citation_changes')).toBe(true);
    db.setWorkspaceSetting(WS, 'notify_citation_changes', 'false');
    expect(notify.notificationEventEnabled(WS, 'citation_changes')).toBe(false);
    expect(notify.notificationEventEnabled(other, 'citation_changes')).toBe(true);
  });
});
