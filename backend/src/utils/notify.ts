/**
 * Outbound notifications — each provider is a first-class, independently
 * configured channel. A notification goes to every configured channel whose
 * routing includes its event (all events unless narrowed), plus every email
 * list that subscribes to it. A run only needs one delivery to succeed. All
 * config lives in workspace settings (see the keys below); email reuses the
 * SMTP transport.
 *
 * Channels & their settings keys:
 *   slack     notify_slack_webhook                      (Incoming Webhook URL)
 *   discord   notify_discord_webhook                    (Webhook URL)
 *   ntfy      notify_ntfy_topic  (+ notify_ntfy_server, notify_ntfy_token)
 *   telegram  notify_telegram_token + notify_telegram_chat
 *   webhook   notify_webhook_url                        (generic JSON {title, body, links, event})
 *   email     notify_email_to (default list)  + notify_email_lists (JSON: named lists, each with its events)
 *   whatsapp  notify_whatsapp_token + notify_whatsapp_phone_id + notify_whatsapp_to
 *             (+ notify_whatsapp_template, notify_whatsapp_lang) — WhatsApp Cloud API
 *
 * notify_routes (JSON) narrows which events each channel receives:
 *   { "slack": ["review_approvals", "ads_approvals"], "whatsapp": ["ads_alerts"] }
 * A channel that isn't listed gets every event.
 *
 * Messages carry links (deep links into the dashboard, e.g. to approve a
 * reply); each channel renders them its own way: Slack and Discord links,
 * ntfy action buttons, email buttons, Telegram HTML links.
 */
import { getDb, getWorkspaceSetting } from '../db/database.js';
import { sendEmail, emailConfigured } from './email.js';
import { safeFetch } from '../security/outbound-url.js';

export type Channel = 'slack' | 'discord' | 'ntfy' | 'telegram' | 'webhook' | 'email' | 'whatsapp';
export const CHANNELS: Channel[] = ['slack', 'discord', 'ntfy', 'telegram', 'webhook', 'email', 'whatsapp'];

export type NotificationEvent =
  | 'run_complete' | 'run_failed' | 'citation_changes' | 'playbook_ready'
  | 'review_alerts' | 'review_approvals' | 'profile_alerts'
  | 'ads_approvals' | 'ads_alerts'
  | 'google_connection';
export const NOTIFICATION_EVENTS: NotificationEvent[] = [
  'run_complete', 'run_failed', 'citation_changes', 'playbook_ready',
  'review_alerts', 'review_approvals', 'profile_alerts', 'ads_approvals', 'ads_alerts', 'google_connection',
];

// The settings keys each channel uses (per-workspace).
export const NOTIFY_KEYS = [
  'notify_slack_webhook', 'notify_discord_webhook',
  'notify_ntfy_server', 'notify_ntfy_topic', 'notify_ntfy_token',
  'notify_telegram_token', 'notify_telegram_chat', 'notify_webhook_url', 'notify_email_to', 'notify_email_lists',
  'notify_whatsapp_token', 'notify_whatsapp_phone_id', 'notify_whatsapp_to', 'notify_whatsapp_template', 'notify_whatsapp_lang',
  'notify_routes',
  ...NOTIFICATION_EVENTS.map(e => `notify_${e}`),
] as const;

export interface NotifyLink { label: string; url: string }
export interface NotifyMessage { title: string; body: string; links: NotifyLink[] }

export interface ChannelResult { channel: Channel; configured: boolean; ok: boolean; error?: string; target?: string }
export interface NotificationDelivery {
  id: number; workspace_id: string; event_type: string; channel: Channel;
  status: 'sent' | 'failed'; title: string; error: string | null; created_at: string;
}

export interface EmailList { id: string; name: string; to: string; events: NotificationEvent[] | null }

const ws = (workspaceId: string, key: string) => getWorkspaceSetting(workspaceId, key);

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

const isEvent = (v: unknown): v is NotificationEvent => NOTIFICATION_EVENTS.includes(v as NotificationEvent);

/** Clean up the email lists a client sent (names, addresses, events). */
export function normalizeEmailLists(raw: unknown): EmailList[] {
  const list = Array.isArray(raw) ? raw : parseJson<unknown[]>(typeof raw === 'string' ? raw : null, []);
  return list.slice(0, 20).map((item, i) => {
    const v = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const to = splitAddresses(String(v.to ?? '')).join(', ');
    const events = Array.isArray(v.events) ? [...new Set(v.events.filter(isEvent))] : null;
    return { id: String(v.id ?? '').trim().slice(0, 40) || `list-${i + 1}`, name: String(v.name ?? '').trim().slice(0, 80) || `List ${i + 1}`, to, events };
  }).filter(l => l.to);
}

/** Clean up per-channel routing: channel → events (null = every event). */
export function normalizeRoutes(raw: unknown): Partial<Record<Channel, NotificationEvent[]>> {
  const v = (raw && typeof raw === 'object' ? raw : parseJson<Record<string, unknown>>(typeof raw === 'string' ? raw : null, {})) as Record<string, unknown>;
  const out: Partial<Record<Channel, NotificationEvent[]>> = {};
  for (const channel of CHANNELS) {
    if (Array.isArray(v[channel])) out[channel] = [...new Set((v[channel] as unknown[]).filter(isEvent))];
  }
  return out;
}

export function emailLists(workspaceId: string): EmailList[] { return normalizeEmailLists(ws(workspaceId, 'notify_email_lists')); }
const routes = (workspaceId: string) => normalizeRoutes(ws(workspaceId, 'notify_routes'));

function splitAddresses(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map(a => a.trim()).filter(a => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)))].slice(0, 50);
}

async function post(url: string, init: RequestInit): Promise<void> {
  const res = await safeFetch(url, { ...init, signal: AbortSignal.timeout(15_000) }, { label: 'Notification endpoint' });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
}

const linksText = (m: NotifyMessage) => m.links.map(l => `${l.label}: ${l.url}`).join('\n');
const plain = (m: NotifyMessage) => [m.body, linksText(m)].filter(Boolean).join('\n\n');
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escapeSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Per-channel senders (throw on failure) — all scoped to one workspace ──────

async function sendSlack(w: string, m: NotifyMessage): Promise<void> {
  const url = ws(w, 'notify_slack_webhook');
  if (!url) throw new Error('not configured');
  const links = m.links.map(l => `<${l.url}|${escapeSlack(l.label)}>`).join('  ·  ');
  await post(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `*${escapeSlack(m.title)}*\n${escapeSlack(m.body)}${links ? `\n${links}` : ''}` }) });
}

async function sendDiscord(w: string, m: NotifyMessage): Promise<void> {
  const url = ws(w, 'notify_discord_webhook');
  if (!url) throw new Error('not configured');
  const links = m.links.map(l => `[${l.label}](<${l.url}>)`).join(' · ');
  const content = `**${m.title}**\n${m.body}`.slice(0, 1900 - links.length) + (links ? `\n${links}` : '');
  await post(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
}

async function sendNtfy(w: string, m: NotifyMessage): Promise<void> {
  const topic = ws(w, 'notify_ntfy_topic');
  if (!topic) throw new Error('not configured');
  const server = (ws(w, 'notify_ntfy_server') || 'https://ntfy.sh').replace(/\/$/, '');
  const token = ws(w, 'notify_ntfy_token');
  const ascii = (s: string) => s.replace(/[^\x20-\x7E]/g, ''); // ntfy headers must be ASCII
  const headers: Record<string, string> = { 'Content-Type': 'text/plain', Title: ascii(m.title) };
  if (m.links[0]) headers.Click = m.links[0].url;
  // Up to three tappable buttons on the phone notification.
  if (m.links.length) headers.Actions = m.links.slice(0, 3).map(l => `view, ${ascii(l.label).replace(/[,;]/g, ' ')}, ${l.url}`).join('; ');
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = /^https?:\/\//.test(topic) ? topic : `${server}/${topic}`;
  await post(url, { method: 'POST', headers, body: m.body });
}

async function sendTelegram(w: string, m: NotifyMessage): Promise<void> {
  const token = ws(w, 'notify_telegram_token');
  const chat = ws(w, 'notify_telegram_chat');
  if (!token || !chat) throw new Error('not configured');
  const links = m.links.map(l => `<a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a>`).join('  ·  ');
  await post(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, parse_mode: 'HTML', text: `<b>${escapeHtml(m.title)}</b>\n${escapeHtml(m.body)}${links ? `\n\n${links}` : ''}`, disable_web_page_preview: true }),
  });
}

// Generic webhook. Retains light auto-detection so a value migrated from the old
// single global field keeps working when it points at Slack/Discord/ntfy.
async function sendWebhook(w: string, m: NotifyMessage, event: string): Promise<void> {
  const url = ws(w, 'notify_webhook_url');
  if (!url) throw new Error('not configured');
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let payload: string;
  if (url.includes('hooks.slack.com')) {
    payload = JSON.stringify({ text: `*${m.title}*\n${plain(m)}` });
  } else if (url.includes('discord.com/api/webhooks')) {
    payload = JSON.stringify({ content: `**${m.title}**\n${plain(m)}`.slice(0, 1900) });
  } else if (url.includes('ntfy.sh')) {
    headers = { 'Content-Type': 'text/plain', Title: m.title.replace(/[^\x20-\x7E]/g, '') };
    payload = plain(m);
  } else {
    payload = JSON.stringify({ title: m.title, body: m.body, links: m.links, event });
  }
  await post(url, { method: 'POST', headers, body: payload });
}

function emailHtml(m: NotifyMessage): string {
  const paragraphs = m.body.split(/\n{2,}/).map(p => `<p style="margin:0 0 12px;line-height:1.5">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const buttons = m.links.map((l, i) => `<a href="${escapeHtml(l.url)}" style="display:inline-block;margin:4px 8px 4px 0;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;${i === 0 ? 'background:#2563eb;color:#ffffff' : 'background:#e5e7eb;color:#111827'}">${escapeHtml(l.label)}</a>`).join('');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111827">`
    + `<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;padding:24px">`
    + `<h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(m.title)}</h2>${paragraphs}${buttons ? `<div style="margin-top:16px">${buttons}</div>` : ''}`
    + `</div></body></html>`;
}

async function sendEmailTo(addresses: string[], m: NotifyMessage): Promise<void> {
  if (!addresses.length) throw new Error('not configured');
  if (!emailConfigured()) throw new Error('SMTP is not configured (set SMTP_HOST)');
  // One message per address, so a list never sees each other's addresses.
  const results = await Promise.all(addresses.map(to => sendEmail({ to, subject: m.title, text: plain(m), html: emailHtml(m) }).catch(() => false)));
  const failed = addresses.filter((_, i) => !results[i]);
  if (failed.length === addresses.length) throw new Error('mail server did not accept the message');
  if (failed.length) throw new Error(`not delivered to ${failed.join(', ')}`);
}

/** Template parameters may not contain new lines, tabs or more than four spaces in a row. */
const whatsappParam = (s: string) => s.replace(/[\r\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').trim().slice(0, 1000);

async function sendWhatsApp(w: string, m: NotifyMessage): Promise<void> {
  const token = ws(w, 'notify_whatsapp_token');
  const phoneId = ws(w, 'notify_whatsapp_phone_id');
  // Numbers are separated by commas, semicolons or new lines; spaces inside a number are fine.
  const recipients = [...new Set((ws(w, 'notify_whatsapp_to') ?? '').split(/[,;\n]+/).map(n => n.replace(/[^\d]/g, '')).filter(n => n.length >= 8))].slice(0, 20);
  if (!token || !phoneId || !recipients.length) throw new Error('not configured');
  const template = ws(w, 'notify_whatsapp_template')?.trim();
  const lang = ws(w, 'notify_whatsapp_lang')?.trim() || 'en';
  const version = (process.env.WHATSAPP_GRAPH_VERSION || 'v23.0').trim();
  const text = `*${m.title}*\n${m.body}${m.links.length ? `\n\n${linksText(m)}` : ''}`;
  const failures: string[] = [];
  for (const to of recipients) {
    const message = template
      // Business-initiated messages need an approved template: its {{1}} gets the whole notification.
      ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: template, language: { code: lang }, components: [{ type: 'body', parameters: [{ type: 'text', text: whatsappParam(`${m.title} — ${m.body} ${m.links.map(l => `${l.label}: ${l.url}`).join(' ')}`) }] }] } }
      // Free-form text is only delivered within 24 hours of the recipient last messaging this number.
      : { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: m.links.length > 0, body: text.slice(0, 4096) } };
    const res = await safeFetch(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneId)}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message),
      signal: AbortSignal.timeout(15_000),
    }, { label: 'WhatsApp Cloud API' });
    if (res.ok) continue;
    const err = (await res.json().catch(() => null) as { error?: { message?: string; code?: number } } | null)?.error;
    failures.push(`${to}: ${err?.code === 131047 || /re-engagement|24 hours/i.test(err?.message ?? '')
      ? 'WhatsApp only delivers free-form messages within 24 hours of the recipient messaging you. Set a message template.'
      : err?.message ?? `HTTP ${res.status}`}`);
  }
  if (failures.length) throw new Error(failures.join('; '));
}

type Sender = (w: string, m: NotifyMessage, event: string) => Promise<void>;
const SENDERS: Record<Exclude<Channel, 'email'>, Sender> = {
  slack: sendSlack, discord: sendDiscord, ntfy: sendNtfy, telegram: sendTelegram, webhook: sendWebhook, whatsapp: sendWhatsApp,
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
      case 'email': return emailConfigured() && (!!ws(workspaceId, 'notify_email_to') || emailLists(workspaceId).length > 0);
      case 'whatsapp': return !!(ws(workspaceId, 'notify_whatsapp_token') && ws(workspaceId, 'notify_whatsapp_phone_id') && ws(workspaceId, 'notify_whatsapp_to'));
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
  `).run(workspaceId, eventType, result.channel, result.ok ? 'sent' : 'failed', title.slice(0, 180), (result.target ? `${result.target}: ${result.error ?? ''}` : result.error)?.slice(0, 300) ?? null);
}

/** The email addresses that should get this event: the default list (if routed) plus every list subscribed to it. */
export function emailRecipients(workspaceId: string, event: string): string[] {
  const routed = routes(workspaceId).email;
  const all = !isEvent(event);
  const base = all || !routed || routed.includes(event as NotificationEvent) ? splitAddresses(ws(workspaceId, 'notify_email_to') ?? '') : [];
  const lists = emailLists(workspaceId).filter(l => all || !l.events || l.events.includes(event as NotificationEvent)).flatMap(l => splitAddresses(l.to));
  return [...new Set([...base, ...lists])];
}

/** Whether a (non-email) channel takes this event. Events outside the known list (tests, digests) go everywhere. */
export function channelTakes(workspaceId: string, channel: Channel, event: string): boolean {
  if (!isEvent(event)) return true;
  const routed = routes(workspaceId)[channel];
  return !routed || routed.includes(event);
}

async function dispatch(workspaceId: string, message: NotifyMessage, eventType: string, only?: Channel[]): Promise<ChannelResult[]> {
  const targets = (only ?? configuredChannels(workspaceId)).filter(c => c === 'email' || channelTakes(workspaceId, c, eventType));
  return Promise.all(targets.map(async (channel): Promise<ChannelResult> => {
    let result: ChannelResult;
    try {
      if (channel === 'email') {
        const to = emailRecipients(workspaceId, eventType);
        if (!to.length) return { channel, configured: true, ok: false, error: 'no email list takes this event' };
        await sendEmailTo(to, message);
      } else {
        await SENDERS[channel](workspaceId, message, eventType);
      }
      result = { channel, configured: true, ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = { channel, configured: msg !== 'not configured', ok: false, error: msg };
    }
    recordDelivery(workspaceId, eventType, message.title, result);
    return result;
  }));
}

/**
 * Send a notification to every channel and email list that takes this event.
 * True if any delivery succeeded. `links` become buttons or links in each
 * channel (deep links into the dashboard, e.g. to approve a reply).
 */
export async function sendWorkspaceNotification(
  workspaceId: string, title: string, body: string, eventType = 'manual', opts: { links?: NotifyLink[] } = {},
): Promise<boolean> {
  const results = await dispatch(workspaceId, { title, body, links: (opts.links ?? []).filter(l => l.url) }, eventType);
  return results.some(r => r.ok);
}

/** Send a test message to every configured channel and email list for a workspace, with per-channel results. */
export async function sendTestNotification(workspaceId: string, origin?: string | null): Promise<ChannelResult[]> {
  const configured = configuredChannels(workspaceId);
  if (configured.length === 0) return [];
  return dispatch(workspaceId, {
    title: 'SEO Website Indexer — test notification',
    body: 'If you can read this, notifications are working. 🎉',
    links: origin ? [{ label: 'Open the dashboard', url: origin }] : [],
  }, 'test', configured);
}

export function listNotificationDeliveries(workspaceId: string, limit = 50): NotificationDelivery[] {
  return getDb().prepare(`
    SELECT id, workspace_id, event_type, channel, status, title, error, created_at
    FROM notification_deliveries WHERE workspace_id = ?
    ORDER BY id DESC LIMIT ?
  `).all(workspaceId, Math.min(Math.max(limit, 1), 200)) as NotificationDelivery[];
}
