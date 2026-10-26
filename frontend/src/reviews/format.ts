// reviews/format.ts — small display helpers shared by the Business Profile tabs.
import type { ConnectionStatus, ProfileChange } from './api';

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
