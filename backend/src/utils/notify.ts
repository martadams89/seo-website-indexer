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
import { getSetting } from '../db/database.js';
import { sendEmail, emailConfigured } from './email.js';

export type Channel = 'slack' | 'discord' | 'ntfy' | 'telegram' | 'webhook' | 'email';
export const CHANNELS: Channel[] = ['slack', 'discord', 'ntfy', 'telegram', 'webhook', 'email'];

export interface ChannelResult { channel: Channel; configured: boolean; ok: boolean; error?: string }

async function post(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
}

// ── Per-channel senders (throw on failure) ───────────────────────────────────

async function sendSlack(title: string, body: string): Promise<void> {
  const url = getSetting('notify_slack_webhook');
  if (!url) throw new Error('not configured');
  await post(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `*${title}*\n${body}` }) });
}

async function sendDiscord(title: string, body: string): Promise<void> {
  const url = getSetting('notify_discord_webhook');
  if (!url) throw new Error('not configured');
  await post(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${body}`.slice(0, 1900) }) });
}

async function sendNtfy(title: string, body: string): Promise<void> {
  const topic = getSetting('notify_ntfy_topic');
  if (!topic) throw new Error('not configured');
  const server = (getSetting('notify_ntfy_server') || 'https://ntfy.sh').replace(/\/$/, '');
  const token = getSetting('notify_ntfy_token');
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain',
    Title: title.replace(/[^\x20-\x7E]/g, ''), // ntfy header must be ASCII
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  // If the topic value is itself a full URL, use it directly; else server/topic.
  const url = /^https?:\/\//.test(topic) ? topic : `${server}/${topic}`;
  await post(url, { method: 'POST', headers, body });
}

async function sendTelegram(title: string, body: string): Promise<void> {
  const token = getSetting('notify_telegram_token');
  const chat = getSetting('notify_telegram_chat');
  if (!token || !chat) throw new Error('not configured');
  await post(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: `${title}\n${body}`, disable_web_page_preview: true }),
  });
}

// Generic webhook. Retains light auto-detection so an existing install that put
// a Slack/Discord/ntfy URL in this single field keeps working after the upgrade.
async function sendWebhook(title: string, body: string): Promise<void> {
  const url = getSetting('notify_webhook_url');
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

async function sendEmailChannel(title: string, body: string): Promise<void> {
  const to = getSetting('notify_email_to');
  if (!to) throw new Error('not configured');
  if (!emailConfigured()) throw new Error('SMTP is not configured (set SMTP_HOST)');
  const ok = await sendEmail({ to, subject: title, text: body });
  if (!ok) throw new Error('mail server did not accept the message');
}

const SENDERS: Record<Channel, (t: string, b: string) => Promise<void>> = {
  slack: sendSlack, discord: sendDiscord, ntfy: sendNtfy,
  telegram: sendTelegram, webhook: sendWebhook, email: sendEmailChannel,
};

/** Which channels have config present (for the UI + test). */
export function configuredChannels(): Channel[] {
  return CHANNELS.filter(c => {
    switch (c) {
      case 'slack': return !!getSetting('notify_slack_webhook');
      case 'discord': return !!getSetting('notify_discord_webhook');
      case 'ntfy': return !!getSetting('notify_ntfy_topic');
      case 'telegram': return !!(getSetting('notify_telegram_token') && getSetting('notify_telegram_chat'));
      case 'webhook': return !!getSetting('notify_webhook_url');
      case 'email': return !!getSetting('notify_email_to') && emailConfigured();
    }
  });
}

async function dispatch(title: string, body: string, only?: Channel[]): Promise<ChannelResult[]> {
  const targets = only ?? configuredChannels();
  return Promise.all(targets.map(async (channel): Promise<ChannelResult> => {
    try {
      await SENDERS[channel](title, body);
      return { channel, configured: true, ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { channel, configured: msg !== 'not configured', ok: false, error: msg };
    }
  }));
}

/** Fan a notification out to every configured channel. True if any succeeded. */
export async function sendNotification(title: string, body: string): Promise<boolean> {
  const results = await dispatch(title, body);
  return results.some(r => r.ok);
}

/** Send a test message to every configured channel and report per-channel results. */
export async function sendTestNotification(): Promise<ChannelResult[]> {
  const configured = configuredChannels();
  if (configured.length === 0) return [];
  return dispatch(
    'SEO Website Indexer — test notification',
    'If you can read this, notifications are working. 🎉',
    configured,
  );
}
