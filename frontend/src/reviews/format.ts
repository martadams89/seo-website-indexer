// reviews/format.ts — small display helpers shared by the Business Profile tabs.
import type { ConnectionStatus, ProfileChange, ReplyPlan } from './api';

/** "owner@acme.test · project 123": tells a connection apart from the same Google user on another project. */
export const connectionLabel = (c: Pick<ConnectionStatus, 'email' | 'id' | 'project' | 'business_only'>) =>
  `${c.email ?? c.id}${c.project ? ` · project ${c.project}` : ''}${c.business_only ? ' (Business Profile only)' : ''}`;

/** What happened to a change, for a toast. */
export function changeOutcome(change: ProfileChange): string {
  if (change.status === 'published') return 'Published to Google';
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
