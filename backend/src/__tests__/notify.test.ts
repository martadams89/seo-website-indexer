import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Notification fan-out: the right channels are considered "configured" from
// settings, each is dispatched with the correct URL/shape, and per-channel
// success/failure is reported independently. fetch is stubbed so no network.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-notify-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'notify-test-secret';

type DbMod = typeof import('../db/database.js');
type NotifyMod = typeof import('../utils/notify.js');
let db: DbMod;
let notify: NotifyMod;

beforeAll(async () => {
  db = await import('../db/database.js');
  notify = await import('../utils/notify.js');
});

describe('notification channels', () => {
  beforeEach(() => {
    // Reset config each test.
    for (const k of ['notify_slack_webhook', 'notify_discord_webhook', 'notify_ntfy_topic',
      'notify_telegram_token', 'notify_telegram_chat', 'notify_webhook_url', 'notify_email_to']) {
      db.setSetting(k, '');
    }
    vi.restoreAllMocks();
  });

  it('reports which channels are configured', () => {
    expect(notify.configuredChannels()).toEqual([]);
    db.setSetting('notify_slack_webhook', 'https://hooks.slack.com/services/x');
    db.setSetting('notify_telegram_token', 'tok');
    db.setSetting('notify_telegram_chat', '123');
    // Telegram needs BOTH token and chat.
    expect(notify.configuredChannels().sort()).toEqual(['slack', 'telegram']);
  });

  it('dispatches to every configured channel with the right endpoint', async () => {
    db.setSetting('notify_slack_webhook', 'https://hooks.slack.com/services/x');
    db.setSetting('notify_telegram_token', 'BOT');
    db.setSetting('notify_telegram_chat', '42');
    db.setSetting('notify_webhook_url', 'https://example.com/hook');

    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return { ok: true, status: 200, statusText: 'OK' } as Response; }));

    const results = await notify.sendTestNotification();
    expect(results.every(r => r.ok)).toBe(true);
    expect(results.map(r => r.channel).sort()).toEqual(['slack', 'telegram', 'webhook']);
    expect(calls.some(u => u.includes('hooks.slack.com'))).toBe(true);
    expect(calls.some(u => u.includes('api.telegram.org/botBOT/sendMessage'))).toBe(true);
    expect(calls.some(u => u === 'https://example.com/hook')).toBe(true);
  });

  it('reports per-channel failure without failing the others', async () => {
    db.setSetting('notify_slack_webhook', 'https://hooks.slack.com/services/x');
    db.setSetting('notify_webhook_url', 'https://example.com/hook');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const ok = String(url).includes('example.com');
      return { ok, status: ok ? 200 : 500, statusText: ok ? 'OK' : 'Server Error' } as Response;
    }));

    const results = await notify.sendTestNotification();
    const byChannel = Object.fromEntries(results.map(r => [r.channel, r]));
    expect(byChannel.webhook.ok).toBe(true);
    expect(byChannel.slack.ok).toBe(false);
    expect(byChannel.slack.error).toContain('500');
    // sendNotification is true because at least one channel succeeded.
    expect(await notify.sendNotification('t', 'b')).toBe(true);
  });
});
