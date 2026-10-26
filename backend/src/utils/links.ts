/**
 * utils/links.ts — absolute links back into the dashboard for notifications
 * (email, WhatsApp, Slack…). Each link carries its workspace (/w/<slug>/…),
 * so opening it lands in the right workspace whatever the browser last used.
 *
 * Background jobs have no request to take a host from: PUBLIC_URL wins, and
 * otherwise the address the dashboard was last opened on is used.
 */
import { getSetting, setSetting } from '../db/database.js';
import { workspaceSlug } from '../auth/workspaces.js';

const ORIGIN_KEY = 'app_origin_seen';

export function rememberAppOrigin(origin: string): void {
  if (process.env.PUBLIC_URL || !/^https?:\/\//.test(origin)) return;
  if (getSetting(ORIGIN_KEY) !== origin) setSetting(ORIGIN_KEY, origin);
}

export function appOrigin(): string | null {
  if (process.env.PUBLIC_URL) return new URL(process.env.PUBLIC_URL).origin;
  return getSetting(ORIGIN_KEY) ?? null;
}

/** "https://host/w/acme/reviews?tab=approvals", or null when the host isn't known yet. */
export function workspaceLink(workspaceId: string, path: string): string | null {
  const origin = appOrigin();
  if (!origin) return null;
  return `${origin}/w/${encodeURIComponent(workspaceSlug(workspaceId))}${path.startsWith('/') ? path : `/${path}`}`;
}
