import type { AdsGuardrails } from './api';

export const GOALS: Array<{ id: string; label: string }> = [
  { id: 'leads', label: 'Leads (forms, enquiries)' },
  { id: 'sales', label: 'Online sales' },
  { id: 'calls', label: 'Phone calls' },
  { id: 'bookings', label: 'Bookings / appointments' },
  { id: 'traffic', label: 'Website traffic' },
  { id: 'awareness', label: 'Brand awareness' },
  { id: 'app_installs', label: 'App installs' },
];

export const MODE_LABEL: Record<AdsGuardrails['mode'], string> = {
  guarded: 'Autopilot within limits',
  review: 'Approve every change',
  read_only: 'Read-only',
};
