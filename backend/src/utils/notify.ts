/**
 * Outbound notifications — each provider is a first-class, independently
 * configured channel. A notification fans out to every enabled channel; a run
 * only needs one to succeed. All config lives in settings (see the keys below);
 * email reuses the SMTP transport.
 *
 * Channels & their settings keys:
 *   slack     notify_slack_webhook                      (Incoming Webhook URL)
 *   discord   notify_discord_webhook                    (Webhook URL)
 *   ntfy      notify_ntfy_topic  (+ notify_ntfy_server, notify_ntfy_token)
 *   telegram  notify_telegram_token + notify_telegram_chat
 *   webhook   notify_webhook_url                        (generic JSON {title, body})
 *   email     notify_email_to                           (comma-separated; needs SMTP)
 */
import { getDb, getWorkspaceSetting } from '../db/database.js';
import { sendEmail, emailConfigured } from './email.js';
import { safeFetch } from '../security/outbound-url.js';

export type Channel = 'slack' | 'discord' | 'ntfy' | 'telegram' | 'webhook' | 'email';
export const CHANNELS: Channel[] = ['slack', 'discord', 'ntfy', 'telegram', 'webhook', 'email'];
// The settings keys each channel uses (per-workspace).
export const NOTIFY_KEYS = [
  'notify_slack_webhook', 'notify_discord_webhook',
  'notify_ntfy_server', 'notify_ntfy_topic', 'notify_ntfy_token',
  'notify_telegram_token', 'notify_telegram_chat', 'notify_webhook_url', 'notify_email_to',
  'notify_run_complete', 'notify_run_failed', 'notify_citation_changes',
] as const;

export interface ChannelResult { channel: Channel; configured: boolean; ok: boolean; error?: string }
export type NotificationEvent = 'run_complete' | 'run_failed' | 'citation_changes';
export interface NotificationDelivery {
  id: number; workspace_id: string; event_type: string; channel: Channel;
  status: 'sent' | 'failed'; title: string; error: string | null; created_at: string;
}

const ws = (workspaceId: string, key: string) => getWorkspaceSetting(workspaceId, key);

async function post(url: string, init: RequestInit): Promise<void> {
  const res = await safeFetch(url, { ...init, signal: AbortSignal.timeout(15_000) }, { label: 'Notification endpoint' });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
}

// ── Per-channel senders (throw on failure) — all scoped to one workspace ──────

async function sendSlack(w: string, title: string, body: string): Promise<void> {
  const url = ws(w, 'notify_slack_webhook');
  if (!url) throw new Error('not configured');
  await post(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `*${title}*\n${body}` }) });
}

async function sendDiscord(w: string, title: string, body: string): Promise<void> {
  const url = ws(w, 'notify_discord_webhook');
  if (!url) throw new Error('not configured');
  await post(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${body}`.slice(0, 1900) }) });
}

async function sendNtfy(w: string, title: string, body: string): Promise<void> {
  const topic = ws(w, 'notify_ntfy_topic');
  if (!topic) throw new Error('not configured');
  const server = (ws(w, 'notify_ntfy_server') || 'https://ntfy.sh').replace(/\/$/, '');
  const token = ws(w, 'notify_ntfy_token');
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain',
    Title: title.replace(/[^\x20-\x7E]/g, ''), // ntfy header must be ASCII
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = /^https?:\/\//.test(topic) ? topic : `${server}/${topic}`;
  await post(url, { method: 'POST', headers, body });
}

async function sendTelegram(w: string, title: string, body: string): Promise<void> {
  const token = ws(w, 'notify_telegram_token');
  const chat = ws(w, 'notify_telegram_chat');
  if (!token || !chat) throw new Error('not configured');
  await post(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: `${title}\n${body}`, disable_web_page_preview: true }),
  });
}

// Generic webhook. Retains light auto-detection so a value migrated from the old
// single global field keeps working when it points at Slack/Discord/ntfy.
async function sendWebhook(w: string, title: string, body: string): Promise<void> {
  const url = ws(w, 'notify_webhook_url');
  if (!url) throw new Error('not configured');
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let payload: string;
  if (url.includes('hooks.slack.com')) {
    payload = JSON.stringify({ text: `*${title}*\n${body}` });
  } else if (url.includes('discord.com/api/webhooks')) {
    payload = JSON.stringify({ content: `**${title}**\n${body}`.slice(0, 1900) });
  } else if (url.includes('ntfy.sh')) {
    headers = { 'Content-Type': 'text/plain', Title: title.replace(/[^\x20-\x7E]/g, '') };
    payload = body;
  } else {
    payload = JSON.stringify({ title, body });
  }
  await post(url, { method: 'POST', headers, body: payload });
}

async function sendEmailChannel(w: string, title: string, body: string): Promise<void> {
  const to = ws(w, 'notify_email_to');
  if (!to) throw new Error('not configured');
  if (!emailConfigured()) throw new Error('SMTP is not configured (set SMTP_HOST)');
  const ok = await sendEmail({ to, subject: title, text: body });
  if (!ok) throw new Error('mail server did not accept the message');
}

const SENDERS: Record<Channel, (w: string, t: string, b: string) => Promise<void>> = {
  slack: sendSlack, discord: sendDiscord, ntfy: sendNtfy,
  telegram: sendTelegram, webhook: sendWebhook, email: sendEmailChannel,
};

/** Which channels a workspace has configured (for the UI + test). */
export function configuredChannels(workspaceId: string): Channel[] {
  return CHANNELS.filter(c => {
    switch (c) {
      case 'slack': return !!ws(workspaceId, 'notify_slack_webhook');
      case 'discord': return !!ws(workspaceId, 'notify_discord_webhook');
      case 'ntfy': return !!ws(workspaceId, 'notify_ntfy_topic');
      case 'telegram': return !!(ws(workspaceId, 'notify_telegram_token') && ws(workspaceId, 'notify_telegram_chat'));
      case 'webhook': return !!ws(workspaceId, 'notify_webhook_url');
      case 'email': return !!ws(workspaceId, 'notify_email_to') && emailConfigured();
    }
  });
}

export function notificationEventEnabled(workspaceId: string, event: NotificationEvent): boolean {
  // Existing installs keep receiving their run summaries. Operators can opt
  // out explicitly; citation-change alerts are on by default once enabled.
  return ws(workspaceId, `notify_${event}`) !== 'false';
}

function recordDelivery(workspaceId: string, eventType: string, title: string, result: ChannelResult): void {
  getDb().prepare(`
    INSERT INTO notification_deliveries(workspace_id, event_type, channel, status, title, error)
    VALUES(?,?,?,?,?,?)
  `).run(workspaceId, eventType, result.channel, result.ok ? 'sent' : 'failed', title.slice(0, 180), result.error?.slice(0, 300) ?? null);
}

async function dispatch(workspaceId: string, title: string, body: string, only?: Channel[], eventType = 'manual'): Promise<ChannelResult[]> {
  const targets = only ?? configuredChannels(workspaceId);
  return Promise.all(targets.map(async (channel): Promise<ChannelResult> => {
    let result: ChannelResult;
    try {
      await SENDERS[channel](workspaceId, title, body);
      result = { channel, configured: true, ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = { channel, configured: msg !== 'not configured', ok: false, error: msg };
    }
    recordDelivery(workspaceId, eventType, title, result);
    return result;
  }));
}

/** Fan a notification out to every channel configured for a workspace. True if any succeeded. */
export async function sendWorkspaceNotification(workspaceId: string, title: string, body: string, eventType = 'manual'): Promise<boolean> {
  const results = await dispatch(workspaceId, title, body, undefined, eventType);
  return results.some(r => r.ok);
}

/** Send a test message to every configured channel for a workspace, with per-channel results. */
export async function sendTestNotification(workspaceId: string): Promise<ChannelResult[]> {
  const configured = configuredChannels(workspaceId);
  if (configured.length === 0) return [];
  return dispatch(
    workspaceId,
    'SEO Website Indexer — test notification',
    'If you can read this, notifications are working. 🎉',
    configured,
    'test',
  );
}

export function listNotificationDeliveries(workspaceId: string, limit = 50): NotificationDelivery[] {
  return getDb().prepare(`
    SELECT id, workspace_id, event_type, channel, status, title, error, created_at
    FROM notification_deliveries WHERE workspace_id = ?
    ORDER BY id DESC LIMIT ?
  `).all(workspaceId, Math.min(Math.max(limit, 1), 200)) as NotificationDelivery[];
}
