/**
 * auth/oauth-clients.ts — OAuth clients (one per Google Cloud project) saved
 * for a workspace. A client ID and secret typed into a connect form is saved
 * when the sign-in starts, so a cancelled or failed sign-in never means typing
 * it again, and every later sign-in picks the project from a list. The secret
 * is encrypted at rest and never sent back to the browser.
 */
import { randomUUID } from 'crypto';
import { getDb } from '../db/database.js';
import { decrypt, encrypt } from '../utils/crypto.js';

export interface SavedOAuthClient { id: string; workspace_id: string; owner_user_id: string | null; label: string | null; client_id: string; created_at: string }
type Row = SavedOAuthClient & { client_secret: string };

const strip = ({ client_secret: _secret, ...rest }: Row): SavedOAuthClient => rest;

export function saveOAuthClient(input: { workspaceId: string; userId: string; clientId: string; clientSecret: string; label?: string | null }): SavedOAuthClient {
  const clientId = input.clientId.trim();
  const secret = input.clientSecret.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('That doesn\'t look like a Google OAuth client ID (it ends in .apps.googleusercontent.com).');
  if (!secret) throw new Error('Enter the client secret too.');
  const db = getDb();
  const existing = db.prepare('SELECT id FROM google_oauth_clients WHERE workspace_id = ? AND client_id = ?').get(input.workspaceId, clientId) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE google_oauth_clients SET client_secret = ?, label = COALESCE(?, label) WHERE id = ?').run(encrypt(secret), input.label?.trim().slice(0, 80) || null, existing.id);
    return getOAuthClient(existing.id)!;
  }
  const id = randomUUID();
  db.prepare('INSERT INTO google_oauth_clients(id, workspace_id, owner_user_id, label, client_id, client_secret) VALUES(?,?,?,?,?,?)')
    .run(id, input.workspaceId, input.userId, input.label?.trim().slice(0, 80) || null, clientId, encrypt(secret));
  return getOAuthClient(id)!;
}

export function getOAuthClient(id: string): SavedOAuthClient | null {
  const row = getDb().prepare('SELECT * FROM google_oauth_clients WHERE id = ?').get(id) as Row | undefined;
  return row ? strip(row) : null;
}

/** The client id and decrypted secret, for starting a sign-in on the server. */
export function oauthClientCredentials(id: string): { clientId: string; clientSecret: string } | null {
  const row = getDb().prepare('SELECT client_id, client_secret FROM google_oauth_clients WHERE id = ?').get(id) as { client_id: string; client_secret: string } | undefined;
  const secret = row ? decrypt(row.client_secret) : null;
  return row && secret ? { clientId: row.client_id, clientSecret: secret } : null;
}

/** Saved clients a person can use here: the workspace's, and the ones they saved in other workspaces. */
export function listOAuthClients(workspaceId: string, userId: string): SavedOAuthClient[] {
  const rows = getDb().prepare('SELECT * FROM google_oauth_clients WHERE workspace_id = ? OR owner_user_id = ? ORDER BY (workspace_id = ?) DESC, created_at')
    .all(workspaceId, userId, workspaceId) as Row[];
  // The same project saved in several workspaces is listed once, preferring this workspace's copy.
  const seen = new Set<string>();
  return rows.filter(r => !seen.has(r.client_id) && seen.add(r.client_id)).map(strip);
}

export function deleteOAuthClient(id: string): void {
  getDb().prepare('DELETE FROM google_oauth_clients WHERE id = ?').run(id);
}
