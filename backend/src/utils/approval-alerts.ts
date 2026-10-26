/**
 * utils/approval-alerts.ts — "something is waiting for you" notifications with
 * deep links straight to the item, so a person can approve or reject an AI
 * assistant's review reply, Business Profile change or Google Ads change from
 * an email, WhatsApp or Slack message.
 *
 * An assistant often proposes several things in one run, so items are
 * gathered for a short window (NOTIFY_BATCH_SECONDS, default 60) and sent as
 * one message per workspace and event. The links need a signed-in session:
 * an email scanner or a forwarded message can't approve anything.
 */
import { getWorkspace } from '../auth/workspaces.js';
import { workspaceLink } from './links.js';
import { notificationEventEnabled, sendWorkspaceNotification, type NotificationEvent } from './notify.js';

export type ApprovalEvent = Extract<NotificationEvent, 'review_approvals' | 'ads_approvals' | 'ads_alerts'>;

export interface ApprovalItem {
  /** One line: what is waiting, e.g. 'Reply to a 2-star review — Acme Roofing'. */
  headline: string;
  /** Optional detail: the proposed text, the guardrail it tripped, the error. */
  detail?: string | null;
  /** Dashboard path inside the workspace, e.g. '/approve/reply/<id>'. */
  path: string;
}

const BATCH_MS = () => Math.max(0, Number(process.env.NOTIFY_BATCH_SECONDS ?? 60)) * 1000;
const MAX_LISTED = 10;

const ALL_PATH: Record<ApprovalEvent, string> = {
  review_approvals: '/reviews?tab=approvals',
  ads_approvals: '/ads?tab=changes',
  ads_alerts: '/ads?tab=changes',
};
const NOUN: Record<ApprovalEvent, [string, string]> = {
  review_approvals: ['Business Profile item waiting for approval', 'Business Profile items waiting for approval'],
  ads_approvals: ['Google Ads change waiting for approval', 'Google Ads changes waiting for approval'],
  ads_alerts: ['Google Ads change failed', 'Google Ads changes failed'],
};

const pending = new Map<string, { workspaceId: string; event: ApprovalEvent; items: ApprovalItem[]; timer: NodeJS.Timeout | null }>();

/** Queue one item; it goes out with anything else queued for the same workspace and event in the next minute. */
export function queueApprovalAlert(workspaceId: string, event: ApprovalEvent, item: ApprovalItem): void {
  if (!notificationEventEnabled(workspaceId, event)) return;
  const key = `${workspaceId}:${event}`;
  const batch = pending.get(key) ?? { workspaceId, event, items: [], timer: null };
  batch.items.push(item);
  pending.set(key, batch);
  if (!batch.timer) {
    batch.timer = setTimeout(() => { void flush(key); }, BATCH_MS());
    batch.timer.unref?.();
  }
}

const excerpt = (s: string | null | undefined, n = 280) => !s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s;

async function flush(key: string): Promise<boolean> {
  const batch = pending.get(key);
  pending.delete(key);
  if (!batch?.items.length) return false;
  const { workspaceId, event, items } = batch;
  const workspace = getWorkspace(workspaceId)?.name;
  const link = (path: string) => workspaceLink(workspaceId, path);
  const where = workspace ? ` — ${workspace}` : '';
  if (items.length === 1) {
    const [item] = items;
    const url = link(item.path);
    return sendWorkspaceNotification(workspaceId, `${item.headline}${where}`, [excerpt(item.detail, 600), url ? '' : `Open the dashboard to ${event === 'ads_alerts' ? 'review it' : 'approve or reject it'}.`].filter(Boolean).join('\n\n'), event, {
      links: url ? [{ label: event === 'ads_alerts' ? 'Open the change' : 'Approve or reject', url }] : [],
    }).catch(() => false);
  }
  const body = [
    ...items.slice(0, MAX_LISTED).map(i => `• ${i.headline}${i.detail ? `: ${excerpt(i.detail, 140)}` : ''}`),
    ...(items.length > MAX_LISTED ? [`…and ${items.length - MAX_LISTED} more.`] : []),
  ].join('\n');
  const all = link(ALL_PATH[event]);
  const firsts = items.slice(0, 2).map((i, n) => ({ label: `Open item ${n + 1}`, url: link(i.path) })).filter((l): l is { label: string; url: string } => !!l.url);
  return sendWorkspaceNotification(workspaceId, `${items.length} ${NOUN[event][1]}${where}`, body, event, {
    links: [...(all ? [{ label: 'See them all', url: all }] : []), ...firsts],
  }).catch(() => false);
}

/** Send everything queued now (tests, and before the process exits). */
export async function flushApprovalAlerts(): Promise<number> {
  const keys = [...pending.keys()];
  for (const key of keys) {
    const timer = pending.get(key)?.timer;
    if (timer) clearTimeout(timer);
    await flush(key);
  }
  return keys.length;
}
