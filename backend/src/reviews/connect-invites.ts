/**
 * reviews/connect-invites.ts — a link an agency sends a client so the client
 * can connect their own Google account's Business Profile, without an account
 * in this app.
 *
 * Google approves the Business Profile APIs per Cloud project (the OAuth
 * client), not per Google user. The client signs in through the agency's
 * approved project, so calls are made with the client's own token but count
 * against the agency's project and its approval — the same way Mixpost and
 * similar tools work. The connection belongs to the person who made the link
 * and is shared with the link's workspace; the client then picks which of
 * their profiles to share, and those are linked straight away.
 *
 * The link is a bearer secret (stored hashed, plus encrypted so the agency can
 * copy it again). Picking profiles after the sign-in only works from the
 * browser that signed in (a cookie bound to the link), so a forwarded link
 * can't be used to see or share someone else's profiles.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { getDb, getGoogleAccountById, isGoogleAccountAvailableToWorkspace } from '../db/database.js';
import { decrypt, encrypt } from '../utils/crypto.js';
import { getOAuthClient, oauthClientCredentials } from '../auth/oauth-clients.js';
import { hasBuiltinCredentials } from '../auth/google-oauth.js';

export type InviteStatus = 'open' | 'connected' | 'expired' | 'revoked';

export interface ConnectInvite {
  id: string; token_hash: string; token_enc: string; workspace_id: string; created_by: string | null;
  product: 'business'; project_source: string; client_name: string | null; client_email: string | null;
  status: 'open' | 'connected' | 'revoked'; google_account_id: string | null; google_email: string | null;
  browser_hash: string | null; shared_locations: string | null; connected_at: string | null; expires_at: string; created_at: string;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const MAX_DAYS = 30;
/** How long after connecting the client can still pick or add profiles from the same browser. */
const PICK_WINDOW_MS = 7 * 86_400_000;

/** The OAuth client a link signs clients in through: a saved client, an existing connection's, or the server's built-in one. */
export function projectCredentials(source: string, workspaceId: string, userId: string | null): { clientId?: string; clientSecret?: string } | null {
  if (source === 'builtin') return hasBuiltinCredentials() ? {} : null;
  if (source.startsWith('client:')) {
    const saved = getOAuthClient(source.slice('client:'.length));
    if (!saved || (saved.workspace_id !== workspaceId && (!userId || saved.owner_user_id !== userId))) return null;
    return oauthClientCredentials(saved.id);
  }
  const account = getGoogleAccountById(source);
  if (!account?.client_id || !account.client_secret) return null;
  if (!isGoogleAccountAvailableToWorkspace(account.id, workspaceId) && (!userId || account.owner_user_id !== userId)) return null;
  return { clientId: account.client_id, clientSecret: account.client_secret };
}

export function createConnectInvite(input: {
  workspaceId: string; userId: string; projectSource: string; clientName?: string | null; clientEmail?: string | null; days?: number | null;
}): { invite: ConnectInvite; token: string } {
  const source = String(input.projectSource ?? '').trim();
  if (!source || !projectCredentials(source, input.workspaceId, input.userId)) {
    throw Object.assign(new Error('Pick the Google Cloud project clients should sign in through (the one Google approved for the Business Profile API).'), { statusCode: 400 });
  }
  const email = input.clientEmail?.trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('That email address doesn\'t look right.'), { statusCode: 400 });
  const days = Math.min(MAX_DAYS, Math.max(1, Math.round(Number(input.days) || 7)));
  const token = randomBytes(24).toString('base64url');
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO google_connect_invites(id, token_hash, token_enc, workspace_id, created_by, product, project_source, client_name, client_email, expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(id, hash(token), encrypt(token), input.workspaceId, input.userId, 'business', source,
    input.clientName?.trim().slice(0, 120) || null, email, new Date(Date.now() + days * 86_400_000).toISOString());
  return { invite: getConnectInvite(id)!, token };
}

export function getConnectInvite(id: string): ConnectInvite | null {
  return (getDb().prepare('SELECT * FROM google_connect_invites WHERE id = ?').get(id) as ConnectInvite | undefined) ?? null;
}

export function findConnectInvite(token: string): ConnectInvite | null {
  if (!token || token.length > 100) return null;
  return (getDb().prepare('SELECT * FROM google_connect_invites WHERE token_hash = ?').get(hash(token)) as ConnectInvite | undefined) ?? null;
}

export function listConnectInvites(workspaceId: string): ConnectInvite[] {
  return getDb().prepare('SELECT * FROM google_connect_invites WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100').all(workspaceId) as ConnectInvite[];
}

/** The raw link token, so the agency can copy an open link again. */
export function inviteToken(invite: ConnectInvite): string | null { return decrypt(invite.token_enc); }

export function inviteStatus(invite: ConnectInvite): InviteStatus {
  if (invite.status === 'revoked') return 'revoked';
  if (invite.status === 'connected') return 'connected';
  return new Date(invite.expires_at).getTime() < Date.now() ? 'expired' : 'open';
}

export function revokeConnectInvite(workspaceId: string, id: string): boolean {
  return getDb().prepare("UPDATE google_connect_invites SET status = 'revoked' WHERE id = ? AND workspace_id = ?").run(id, workspaceId).changes > 0;
}

/** Start a sign-in from this browser: returns the secret the browser keeps in a cookie. */
export function bindInviteBrowser(id: string): string {
  const nonce = randomBytes(24).toString('base64url');
  getDb().prepare('UPDATE google_connect_invites SET browser_hash = ? WHERE id = ?').run(hash(nonce), id);
  return nonce;
}

export function browserMatches(invite: ConnectInvite, nonce: string | null | undefined): boolean {
  if (!nonce || !invite.browser_hash) return false;
  const a = Buffer.from(hash(nonce)); const b = Buffer.from(invite.browser_hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether the client can (re)start the Google sign-in from this browser. */
export function canStart(invite: ConnectInvite, nonce: string | null | undefined): boolean {
  const status = inviteStatus(invite);
  if (status === 'open') return true;
  // Picked the wrong Google account? The same browser can try again until a profile has been shared.
  return status === 'connected' && browserMatches(invite, nonce) && !sharedLocations(invite).length && withinPickWindow(invite);
}

/** Whether this browser may list and share the connected account's profiles. */
export function canPick(invite: ConnectInvite, nonce: string | null | undefined): boolean {
  return inviteStatus(invite) === 'connected' && !!invite.google_account_id && browserMatches(invite, nonce) && withinPickWindow(invite);
}

const withinPickWindow = (invite: ConnectInvite) => !!invite.connected_at && Date.now() - new Date(invite.connected_at).getTime() < PICK_WINDOW_MS;

export function markInviteConnected(id: string, accountId: string, email: string): void {
  getDb().prepare(`UPDATE google_connect_invites SET status = 'connected', google_account_id = ?, google_email = ?, connected_at = ? WHERE id = ?`)
    .run(accountId, email, new Date().toISOString(), id);
}

export function sharedLocations(invite: ConnectInvite): string[] {
  try { return invite.shared_locations ? JSON.parse(invite.shared_locations) as string[] : []; } catch { return []; }
}

export function recordSharedLocations(id: string, titles: string[]): void {
  const invite = getConnectInvite(id);
  if (!invite) return;
  const all = [...new Set([...sharedLocations(invite), ...titles])].slice(0, 200);
  getDb().prepare('UPDATE google_connect_invites SET shared_locations = ? WHERE id = ?').run(JSON.stringify(all), id);
}

/** Cloud project number from an OAuth client id ("123456789012-abc.apps.googleusercontent.com"). */
export function inviteProject(invite: ConnectInvite): string | null {
  const creds = projectCredentials(invite.project_source, invite.workspace_id, invite.created_by);
  return /^(\d{6,})-/.exec(creds?.clientId ?? '')?.[1] ?? (invite.project_source === 'builtin' ? 'built-in' : null);
}
