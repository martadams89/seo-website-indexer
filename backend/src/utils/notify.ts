/**
 * Outbound notifications: one webhook URL setting, payload shaped for the
 * detected service (Slack / Discord / ntfy / generic JSON).
 */
import { getSetting } from '../db/database.js';

export async function sendNotification(title: string, body: string): Promise<boolean> {
  const url = getSetting('notify_webhook_url');
  if (!url) return false;
  let payload: unknown;
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (url.includes('hooks.slack.com')) {
    payload = { text: `*${title}*\n${body}` };
  } else if (url.includes('discord.com/api/webhooks')) {
    payload = { content: `**${title}**\n${body}`.slice(0, 1900) };
  } else if (url.includes('ntfy.sh') || getSetting('notify_style') === 'ntfy') {
    // ntfy takes the raw body; title goes in a header
    headers = { Title: title.replace(/[^\x20-\x7E]/g, ''), 'Content-Type': 'text/plain' };
    payload = body;
  } else {
    payload = { title, body };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
