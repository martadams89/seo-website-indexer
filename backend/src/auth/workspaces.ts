/**
 * Workspaces — the tenant boundary. A user owns one or more workspaces (their
 * "client bases"); each workspace holds its own Google accounts, Bing accounts
 * and sites. Regular users see only workspaces they own or are members of; a
 * super-admin sees all. This module centralises workspace CRUD and the
 * access-control helpers every scoped endpoint uses.
 */
import { randomUUID } from 'crypto';
import { getDb } from '../db/database.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import type { User } from './users.js';

export interface Workspace { id: string; name: string; owner_user_id: string | null; created_at: string }

export function createWorkspace(name: string, ownerUserId: string): Workspace {
  const id = randomUUID();
  getDb().prepare('INSERT INTO workspaces(id, name, owner_user_id) VALUES(?,?,?)').run(id, name.trim() || 'Workspace', ownerUserId);
  return getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Workspace;
}

export function getWorkspace(id: string): Workspace | undefined {
  return getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Workspace | undefined;
}

export function renameWorkspace(id: string, name: string): void {
  getDb().prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name.trim(), id);
}

export function deleteWorkspace(id: string): void {
  getDb().prepare('DELETE FROM workspaces WHERE id = ?').run(id);
}

/** How many workspaces a user owns (used to decide delete-vs-reassign). */
export function ownedWorkspaceCount(userId: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM workspaces WHERE owner_user_id = ?').get(userId) as { c: number }).c;
}

/**
 * Hand a departing user's owned workspaces (and their sites/accounts) to another
 * user, so deleting an account never silently orphans a client's data. Returns
 * the number of workspaces moved.
 */
export function reassignOwnedWorkspaces(fromUserId: string, toUserId: string): number {
  const info = getDb().prepare('UPDATE workspaces SET owner_user_id = ? WHERE owner_user_id = ?').run(toUserId, fromUserId);
  return info.changes;
}

/** Workspaces a user can access (owned + member), or all for a super-admin. */
export function accessibleWorkspaces(user: User): Workspace[] {
  if (user.is_super_admin) {
    return getDb().prepare('SELECT * FROM workspaces ORDER BY created_at').all() as Workspace[];
  }
  return getDb().prepare(`
    SELECT DISTINCT w.* FROM workspaces w
    LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = @uid
    WHERE w.owner_user_id = @uid OR m.user_id = @uid
    ORDER BY w.created_at
  `).all({ uid: user.id }) as Workspace[];
}

export function canAccessWorkspace(user: User, workspaceId: string): boolean {
  if (user.is_super_admin) return !!getWorkspace(workspaceId);
  return accessibleWorkspaces(user).some(w => w.id === workspaceId);
}

/** True if the user owns the workspace (or is a super-admin) — required for
 *  destructive/administrative actions like rename, delete and member changes. */
export function canManageWorkspace(user: User, workspaceId: string): boolean {
  if (user.is_super_admin) return !!getWorkspace(workspaceId);
  const ws = getWorkspace(workspaceId);
  return !!ws && ws.owner_user_id === user.id;
}

// ── Membership ───────────────────────────────────────────────────────────────

export interface WorkspaceMember { user_id: string; email: string; name: string | null; role: string; is_owner: boolean }

export function listWorkspaceMembers(workspaceId: string): WorkspaceMember[] {
  const ws = getWorkspace(workspaceId);
  const rows = getDb().prepare(`
    SELECT u.id AS user_id, u.email, u.name, COALESCE(m.role, 'owner') AS role
    FROM users u
    LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = @wid
    WHERE m.user_id IS NOT NULL OR u.id = @owner
    ORDER BY u.email
  `).all({ wid: workspaceId, owner: ws?.owner_user_id ?? '' }) as Array<{ user_id: string; email: string; name: string | null; role: string }>;
  return rows.map(r => ({ ...r, is_owner: r.user_id === ws?.owner_user_id }));
}

export function addWorkspaceMember(workspaceId: string, userId: string, role = 'member'): void {
  getDb().prepare('INSERT OR REPLACE INTO workspace_members(workspace_id, user_id, role) VALUES(?,?,?)')
    .run(workspaceId, userId, role);
}

export function removeWorkspaceMember(workspaceId: string, userId: string): void {
  getDb().prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, userId);
}

/** The set of site IDs inside a workspace (for authorization checks). */
export function siteIdsInWorkspace(workspaceId: string): string[] {
  return (getDb().prepare('SELECT id FROM sites WHERE workspace_id = ?').all(workspaceId) as Array<{ id: string }>).map(r => r.id);
}

export function siteWorkspaceId(siteId: string): string | null {
  const r = getDb().prepare('SELECT workspace_id FROM sites WHERE id = ?').get(siteId) as { workspace_id: string | null } | undefined;
  return r?.workspace_id ?? null;
}

/** True if the user may touch this site (its workspace is accessible). */
export function canAccessSite(user: User, siteId: string): boolean {
  const ws = siteWorkspaceId(siteId);
  if (!ws) return !!user.is_super_admin; // unassigned sites: super-admin only
  return canAccessWorkspace(user, ws);
}

/**
 * Called after a user is created. Gives them a default workspace, and — for the
 * very first user — claims any pre-existing (single-tenant) sites/accounts that
 * have no workspace yet, so upgrades are non-destructive.
 */
export function bootstrapUserWorkspace(user: User, isFirstUser: boolean): Workspace {
  const ws = createWorkspace('Default', user.id);
  if (isFirstUser) {
    const db = getDb();
    db.prepare('UPDATE sites SET workspace_id = ? WHERE workspace_id IS NULL').run(ws.id);
    // Claim legacy Google accounts: set both the home workspace AND the owner
    // (accounts are owner-level — available across all of this owner's workspaces).
    db.prepare('UPDATE google_accounts SET workspace_id = ?, owner_user_id = COALESCE(owner_user_id, ?) WHERE workspace_id IS NULL').run(ws.id, user.id);
    // Claim legacy AI-citation prompts (per-workspace now).
    db.prepare('UPDATE ai_prompts SET workspace_id = ? WHERE workspace_id IS NULL').run(ws.id);
    // A legacy single Bing key in settings becomes this workspace's first Bing account.
    const legacyBing = db.prepare("SELECT value FROM settings WHERE key = 'bing_api_key'").get() as { value: string } | undefined;
    if (legacyBing?.value) {
      addBingAccount(ws.id, 'Bing (migrated)', legacyBing.value);
    }
    // Legacy GLOBAL notification channels move into this workspace (notifications
    // are per-workspace now). We copy them, leaving the global rows harmless.
    const NOTIFY_KEYS = [
      'notify_slack_webhook', 'notify_discord_webhook', 'notify_ntfy_server',
      'notify_ntfy_topic', 'notify_ntfy_token', 'notify_telegram_token',
      'notify_telegram_chat', 'notify_webhook_url', 'notify_email_to',
    ];
    for (const key of NOTIFY_KEYS) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      if (row?.value) db.prepare('INSERT OR REPLACE INTO workspace_settings(workspace_id, key, value) VALUES(?,?,?)').run(ws.id, key, row.value);
    }
  }
  return ws;
}

// ── Multiple Bing accounts (per workspace) ───────────────────────────────────

export interface BingAccount { id: string; workspace_id: string | null; name: string; api_key: string; created_at: string }
export interface PublicBingAccount { id: string; name: string; created_at: string }

export function addBingAccount(workspaceId: string, name: string, apiKey: string): BingAccount {
  const id = randomUUID();
  getDb().prepare('INSERT INTO bing_accounts(id, workspace_id, name, api_key) VALUES(?,?,?,?)')
    .run(id, workspaceId, name.trim() || 'Bing account', encrypt(apiKey.trim()));
  return getDb().prepare('SELECT * FROM bing_accounts WHERE id = ?').get(id) as BingAccount;
}

export function listBingAccounts(workspaceId: string): PublicBingAccount[] {
  return (getDb().prepare('SELECT id, name, created_at FROM bing_accounts WHERE workspace_id = ? ORDER BY created_at').all(workspaceId) as PublicBingAccount[]);
}

export function getBingAccountKey(id: string): string | null {
  const r = getDb().prepare('SELECT api_key FROM bing_accounts WHERE id = ?').get(id) as { api_key: string } | undefined;
  return r ? decrypt(r.api_key) : null;
}

export function bingAccountWorkspace(id: string): string | null {
  const r = getDb().prepare('SELECT workspace_id FROM bing_accounts WHERE id = ?').get(id) as { workspace_id: string | null } | undefined;
  return r?.workspace_id ?? null;
}

export function removeBingAccount(id: string): void {
  getDb().prepare('DELETE FROM bing_accounts WHERE id = ?').run(id);
}

/** Resolve the Bing API key a site should use: its assigned account, else the
 *  first account in its workspace, else the legacy global setting. */
export function bingKeyForSite(siteId: string): string | null {
  const db = getDb();
  const site = db.prepare('SELECT workspace_id, bing_account_id FROM sites WHERE id = ?').get(siteId) as { workspace_id: string | null; bing_account_id: string | null } | undefined;
  if (site?.bing_account_id) {
    const k = getBingAccountKey(site.bing_account_id);
    if (k) return k;
  }
  if (site?.workspace_id) {
    const first = db.prepare('SELECT id FROM bing_accounts WHERE workspace_id = ? ORDER BY created_at LIMIT 1').get(site.workspace_id) as { id: string } | undefined;
    if (first) { const k = getBingAccountKey(first.id); if (k) return k; }
    // Per-workspace single Bing key override (set in the API Keys tab).
    const wsKey = db.prepare("SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = 'bing_api_key'").get(site.workspace_id) as { value: string } | undefined;
    if (wsKey?.value) return wsKey.value;
  }
  const legacy = db.prepare("SELECT value FROM settings WHERE key = 'bing_api_key'").get() as { value: string } | undefined;
  return legacy?.value ?? null;
}
