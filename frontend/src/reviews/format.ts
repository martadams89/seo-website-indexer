// reviews/format.ts — small display helpers shared by the Business Profile tabs.
import type { ConnectionStatus, ProfileChange, ReplyPlan } from './api';

/** "owner@acme.test · project 123": tells a connection apart from the same Google user on another project. */
export const connectionLabel = (c: Pick<ConnectionStatus, 'email' | 'id' | 'project' | 'business_only'>) =>
  `${c.email ?? c.id}${c.project ? ` · project ${c.project}` : ''}${c.business_only ? ' (Business Profile only)' : ''}`;

/** What happened to a change, for a toast. */
export function changeOutcome(change: ProfileChange): string {
  if (change.status === 'published') return 'Published to Google';
  if (change.status === 'scheduled') return `Scheduled for ${localTime(change.publish_at)}`;
  if (change.status === 'needs_approval') return 'Saved for approval';
  if (change.status === 'blocked') return change.findings.map(f => f.message).join(' ') || 'Blocked';
  return change.error ?? change.status;
}

/** Status of a proposed reply or profile change, with its badge tone. */
export const PLAN_STATUS: Record<ReplyPlan['status'], { label: string; tone: string }> = {
  needs_approval: { label: 'Waiting for approval', tone: 'warn' },
  blocked: { label: 'Blocked by rules', tone: 'error' },
  publishing: { label: 'Publishing', tone: 'info' },
  published: { label: 'Published', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'info' },
  failed: { label: 'Google refused it', tone: 'error' },
  superseded: { label: 'Replaced', tone: 'info' },
};

/** A UTC time in the viewer's own time zone, e.g. "Tue 3 Nov, 09:00". */
export function localTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Status of a Business Profile change (adds "scheduled" to the reply statuses). */
export const CHANGE_STATUS: Record<ProfileChange['status'], { label: string; tone: string }> = {
  needs_approval: PLAN_STATUS.needs_approval, blocked: PLAN_STATUS.blocked, publishing: PLAN_STATUS.publishing,
  published: PLAN_STATUS.published, rejected: PLAN_STATUS.rejected, failed: PLAN_STATUS.failed,
  scheduled: { label: 'Scheduled', tone: 'accent' },
};
