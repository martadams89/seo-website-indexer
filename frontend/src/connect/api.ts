// connect/api.ts — the public side of a Business Profile connect link (no account needed).
import { apiFetch } from '../api/client';

export interface ConnectLinkInfo {
  status: 'open' | 'connected' | 'expired' | 'revoked';
  /** The agency's workspace, and the person who sent the link. */
  workspace: string | null; from: string;
  client_name: string | null; expires_at: string;
  can_start: boolean; can_pick: boolean;
  connected_email: string | null; shared: string[];
}

export interface ConnectLocation {
  account_name: string; account_title: string; location_name: string;
  title: string | null; address: string | null; shared: boolean;
}

const base = (token: string) => `/api/connect/${encodeURIComponent(token)}`;

export const connectApi = {
  info: (token: string) => apiFetch<ConnectLinkInfo>(base(token)),
  start: (token: string) => apiFetch<{ authorizationUrl: string }>(`${base(token)}/start`, { method: 'POST', body: '{}' }),
  locations: (token: string) => apiFetch<{ email: string | null; error: string | null; hint: string | null; locations: ConnectLocation[]; account_errors: Array<{ account_title: string; error: string }> }>(`${base(token)}/locations`),
  share: (token: string, locations: Array<{ accountName: string; locationName: string }>) =>
    apiFetch<{ shared: string[]; errors: Array<{ location: string; error: string }> }>(`${base(token)}/locations`, { method: 'POST', body: JSON.stringify({ locations }) }),
};
