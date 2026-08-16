/**
 * Workspaces — the tenant boundary. A user owns one or more workspaces (their
 * "client bases"); each workspace holds its own Google accounts, Bing accounts
 * and sites. Regular users see only workspaces they own or are members of; a
 * super-admin sees all. This module centralises workspace CRUD and the
 * access-control helpers every scoped endpoint uses.
 */
import { randomUUID, randomBytes, createHash } from 'crypto';
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

/** Workspaces a user can access (owned + member with an active, non-disabled
 *  membership), or all for a super-admin. */
export function accessibleWorkspaces(user: User): Workspace[] {
  if (user.is_super_admin) {
    return getDb().prepare('SELECT * FROM workspaces ORDER BY created_at').all() as Workspace[];
  }
  return getDb().prepare(`
    SELECT DISTINCT w.* FROM workspaces w
    LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = @uid
    WHERE w.owner_user_id = @uid OR (m.user_id = @uid AND m.disabled = 0)
    ORDER BY w.created_at
  `).all({ uid: user.id }) as Workspace[];
}

export function canAccessWorkspace(user: User, workspaceId: string): boolean {
  if (user.is_super_admin) return !!getWorkspace(workspaceId);
  return accessibleWorkspaces(user).some(w => w.id === workspaceId);
}

// Legacy membership rows predate the admin/editor/viewer split and default to
// the generic 'member' role — treat those as full editors (their original
// meaning: everything except workspace-owner-only actions).
function normalizeRole(role: string): 'admin' | 'editor' | 'viewer' {
  if (role === 'admin' || role === 'viewer') return role;
  return 'editor';
}

/** The caller's role within a specific workspace: 'owner' for the workspace
 *  owner, the member's own (normalized) role otherwise, or null if they have
 *  no access (not a member, or their membership is disabled). Super-admins
 *  are not reflected here — check `user.is_super_admin` separately. */
export function workspaceRole(user: User, workspaceId: string): 'owner' | 'admin' | 'editor' | 'viewer' | null {
  const ws = getWorkspace(workspaceId);
  if (!ws) return null;
  if (ws.owner_user_id === user.id) return 'owner';
  const row = getDb().prepare('SELECT role, disabled FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, user.id) as { role: string; disabled: number } | undefined;
  if (!row || row.disabled) return null;
  return normalizeRole(row.role);
}

/** True if the user owns the workspace, is a super-admin, or holds the
 *  workspace-scoped 'admin' role there — required for destructive and tenant
 *  administration actions (rename, delete, invites, member roles/disable). */
export function canManageWorkspace(user: User, workspaceId: string): boolean {
  if (user.is_super_admin) return !!getWorkspace(workspaceId);
  const ws = getWorkspace(workspaceId);
  if (!ws) return false;
  return ws.owner_user_id === user.id || workspaceRole(user, workspaceId) === 'admin';
}

/** True if the user may create/edit/delete content (sites, prompts, keys...)
 *  in the workspace — owner/admin/editor, but not a read-only 'viewer'. */
export function canEditWorkspace(user: User, workspaceId: string): boolean {
  if (user.is_super_admin) return !!getWorkspace(workspaceId);
  const role = workspaceRole(user, workspaceId);
  return role === 'owner' || role === 'admin' || role === 'editor';
}

/** Whether the user may use the AI Citations feature (and spend its API
 *  budget) in this workspace: super-admins and owners always can; members
 *  need their per-membership ai_citations flag left on. */
export function canUseAiCitations(user: User, workspaceId: string): boolean {
  if (user.is_super_admin) return true;
  const ws = getWorkspace(workspaceId);
  if (!ws) return false;
  if (ws.owner_user_id === user.id) return true;
  const row = getDb().prepare('SELECT ai_citations, disabled FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, user.id) as { ai_citations: number; disabled: number } | undefined;
  return !!row && !row.disabled && !!row.ai_citations;
}

// ── Granular capabilities ─────────────────────────────────────────────────
// The role tiers (admin/editor/viewer) are the coarse default; an editor's
// individual capabilities can additionally be granted or revoked one at a
// time, e.g. an editor who can manage sites but not touch integrations/API
// keys. Admins always have every capability in their own workspace; viewers
// never have any (read-only is absolute) — overrides only affect editors.
export const CAPABILITIES = ['manage_sites', 'manage_integrations', 'manage_notifications'] as const;
export type Capability = typeof CAPABILITIES[number];
export type CapabilityMap = Record<Capability, boolean>;

function roleDefaultCapability(role: 'admin' | 'editor' | 'viewer', _cap: Capability): boolean {
  if (role === 'admin') return true;
  if (role === 'viewer') return false;
  // Ordinary workspace users can operate the full SEO tool by default. A
  // workspace admin can still revoke individual capabilities for a constrained
  // editor; membership/security administration remains admin-only.
  return true;
}

function parsePermissions(raw: string | null): Partial<CapabilityMap> {
  if (!raw) return {};
  try { return JSON.parse(raw) as Partial<CapabilityMap>; } catch { return {}; }
}

/** The member's effective capability set (role defaults + any per-capability
 *  overrides). Only meaningful for members with role 'editor' — admins are
 *  always all-true and viewers always all-false regardless of overrides. */
function effectiveCapabilities(role: 'admin' | 'editor' | 'viewer', permissionsJson: string | null): CapabilityMap {
  const overrides = role === 'editor' ? parsePermissions(permissionsJson) : {};
  const out = {} as CapabilityMap;
  for (const cap of CAPABILITIES) out[cap] = overrides[cap] ?? roleDefaultCapability(role, cap);
  return out;
}

/** Whether the user has a specific capability in this workspace: super-admins
 *  and the owner always do; otherwise resolved from the member's role default
 *  plus any per-capability override (editors only — viewers can't be granted
 *  capabilities, admins already have them all). */
export function hasCapability(user: User, workspaceId: string, cap: Capability): boolean {
  if (user.is_super_admin) return true;
  const ws = getWorkspace(workspaceId);
  if (!ws) return false;
  if (ws.owner_user_id === user.id) return true;
  const row = getDb().prepare('SELECT role, disabled, permissions FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, user.id) as { role: string; disabled: number; permissions: string | null } | undefined;
  if (!row || row.disabled) return false;
  return effectiveCapabilities(normalizeRole(row.role), row.permissions)[cap];
}

// ── Membership ───────────────────────────────────────────────────────────────

export interface WorkspaceMember {
  user_id: string; email: string; name: string | null; role: string; is_owner: boolean;
  ai_citations: boolean; disabled: boolean; permissions: CapabilityMap;
}

export function listWorkspaceMembers(workspaceId: string): WorkspaceMember[] {
  const ws = getWorkspace(workspaceId);
  const rows = getDb().prepare(`
    SELECT u.id AS user_id, u.email, u.name, COALESCE(m.role, 'owner') AS role,
           COALESCE(m.ai_citations, 1) AS ai_citations, COALESCE(m.disabled, 0) AS disabled, m.permissions
    FROM users u
    LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = @wid
    WHERE m.user_id IS NOT NULL OR u.id = @owner
    ORDER BY u.email
  `).all({ wid: workspaceId, owner: ws?.owner_user_id ?? '' }) as Array<{ user_id: string; email: string; name: string | null; role: string; ai_citations: number; disabled: number; permissions: string | null }>;
  return rows.map(r => {
    const isOwner = r.user_id === ws?.owner_user_id;
    const role = isOwner ? 'owner' : normalizeRole(r.role);
    return {
      user_id: r.user_id, email: r.email, name: r.name, is_owner: isOwner, role,
      ai_citations: !!r.ai_citations, disabled: !!r.disabled,
      permissions: isOwner
        ? { manage_sites: true, manage_integrations: true, manage_notifications: true }
        : effectiveCapabilities(role as 'admin' | 'editor' | 'viewer', r.permissions),
    };
  });
}

export function addWorkspaceMember(workspaceId: string, userId: string, role: 'admin' | 'editor' | 'viewer' = 'editor', aiCitations = true): void {
  getDb().prepare('INSERT OR REPLACE INTO workspace_members(workspace_id, user_id, role, ai_citations) VALUES(?,?,?,?)')
    .run(workspaceId, userId, role, aiCitations ? 1 : 0);
}

export function removeWorkspaceMember(workspaceId: string, userId: string): void {
  getDb().prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, userId);
}

export interface UserWorkspaceAccess {
  workspace_id: string;
  workspace_name: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  is_owner: boolean;
  ai_citations: boolean;
  disabled: boolean;
  permissions: CapabilityMap;
}

/** Complete tenant membership view used by the super-admin user inspector. */
export function listUserWorkspaceAccess(userId: string): UserWorkspaceAccess[] {
  const rows = getDb().prepare(`
    SELECT w.id AS workspace_id, w.name AS workspace_name,
           CASE WHEN w.owner_user_id = @uid THEN 'owner' ELSE m.role END AS role,
           CASE WHEN w.owner_user_id = @uid THEN 1 ELSE 0 END AS is_owner,
           COALESCE(m.ai_citations, 1) AS ai_citations,
           COALESCE(m.disabled, 0) AS disabled,
           m.permissions
    FROM workspaces w
    LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = @uid
    WHERE w.owner_user_id = @uid OR m.user_id = @uid
    ORDER BY w.name COLLATE NOCASE
  `).all({ uid: userId }) as Array<{
    workspace_id: string; workspace_name: string; role: string; is_owner: number;
    ai_citations: number; disabled: number; permissions: string | null;
  }>;
  return rows.map(row => {
    const isOwner = !!row.is_owner;
    const role = isOwner ? 'owner' : normalizeRole(row.role);
    return {
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      role,
      is_owner: isOwner,
      ai_citations: !!row.ai_citations,
      disabled: !!row.disabled,
      permissions: isOwner
        ? { manage_sites: true, manage_integrations: true, manage_notifications: true }
        : effectiveCapabilities(role as 'admin' | 'editor' | 'viewer', row.permissions),
    };
  });
}

/** Update a member's role / AI-citations access / disabled flag / individual
 *  capability overrides within ONE workspace. Never touches the owner (not a
 *  workspace_members row) or the user's other workspace memberships. */
export function updateWorkspaceMember(
  workspaceId: string, userId: string,
  changes: { role?: 'admin' | 'editor' | 'viewer'; ai_citations?: boolean; disabled?: boolean; permissions?: Partial<CapabilityMap> },
): boolean {
  const existing = getDb().prepare('SELECT permissions FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, userId) as { permissions: string | null } | undefined;
  if (!existing) return false;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (changes.role) { sets.push('role = ?'); params.push(changes.role); }
  if (typeof changes.ai_citations === 'boolean') { sets.push('ai_citations = ?'); params.push(changes.ai_citations ? 1 : 0); }
  if (typeof changes.disabled === 'boolean') { sets.push('disabled = ?'); params.push(changes.disabled ? 1 : 0); }
  if (changes.permissions) {
    const merged = { ...parsePermissions(existing.permissions), ...changes.permissions };
    sets.push('permissions = ?'); params.push(JSON.stringify(merged));
  }
  if (sets.length === 0) return true;
  params.push(workspaceId, userId);
  getDb().prepare(`UPDATE workspace_members SET ${sets.join(', ')} WHERE workspace_id = ? AND user_id = ?`).run(...params);
  return true;
}

/** The set of site IDs inside a workspace (for authorization checks). */
export function siteIdsInWorkspace(workspaceId: string): string[] {
  return (getDb().prepare('SELECT id FROM sites WHERE workspace_id = ?').all(workspaceId) as Array<{ id: string }>).map(r => r.id);
}

export function siteWorkspaceId(siteId: string): string | null {
  const r = getDb().prepare('SELECT workspace_id FROM sites WHERE id = ?').get(siteId) as { workspace_id: string | null } | undefined;
  return r?.workspace_id ?? null;
}

/** True if the user may touch this site (its workspace is accessible to them
 *  at all — used for cross-workspace administrative operations). */
export function canAccessSite(user: User, siteId: string): boolean {
  const ws = siteWorkspaceId(siteId);
  if (!ws) return !!user.is_super_admin; // unassigned sites: super-admin only
  return canAccessWorkspace(user, ws);
}

/** True if the user may access this site AND it belongs to the workspace
 *  currently active in their session. A multi-workspace user (or a
 *  super-admin) may be able to access a site "in general" via canAccessSite,
 *  but the dashboard must only ever surface a site's data while its OWNING
 *  workspace is the active one — otherwise switching workspace while viewing
 *  a site (e.g. its Analytics page) keeps leaking the previous tenant's data. */
export function canAccessSiteInWorkspace(user: User, siteId: string, activeWorkspaceId: string | null): boolean {
  const ws = siteWorkspaceId(siteId);
  if (ws === null) return !!user.is_super_admin && activeWorkspaceId === null;
  if (ws !== activeWorkspaceId) return false;
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
    // Claim legacy Google accounts and explicitly delegate them to this first
    // workspace. Ownership alone never grants access in another workspace.
    db.prepare('UPDATE google_accounts SET workspace_id = ?, owner_user_id = COALESCE(owner_user_id, ?) WHERE workspace_id IS NULL').run(ws.id, user.id);
    db.prepare(`
      INSERT OR IGNORE INTO google_account_workspaces(account_id, workspace_id, added_by)
      SELECT id, ?, ? FROM google_accounts WHERE owner_user_id = ?
    `).run(ws.id, user.id, user.id);
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

// ── Super-admin: all workspaces at a glance ──────────────────────────────────

export interface WorkspaceSummary extends Workspace {
  owner_email: string | null;
  member_count: number;
  site_count: number;
}

/** Every workspace in the install with owner/member/site counts, for the
 *  super-admin "all workspaces" management view. */
export function listAllWorkspacesSummary(): WorkspaceSummary[] {
  return getDb().prepare(`
    SELECT w.*, u.email AS owner_email,
      (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count,
      (SELECT COUNT(*) FROM sites s WHERE s.workspace_id = w.id) AS site_count
    FROM workspaces w
    LEFT JOIN users u ON u.id = w.owner_user_id
    ORDER BY w.created_at
  `).all() as WorkspaceSummary[];
}

/** Reassign a workspace to a different owner (super-admin action, e.g. when
 *  the original owner has left). The new owner must already exist. */
export function reassignWorkspaceOwner(workspaceId: string, newOwnerUserId: string): void {
  getDb().prepare('UPDATE workspaces SET owner_user_id = ? WHERE id = ?').run(newOwnerUserId, workspaceId);
  // The new owner no longer needs (or should have) a separate membership row.
  getDb().prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, newOwnerUserId);
}

// ── Invites (email a join link scoped to one workspace) ──────────────────────

export interface WorkspaceInvite {
  id: string; workspace_id: string; email: string; role: string; ai_citations: number;
  invited_by: string | null; expires_at: string; accepted_at: string | null; created_at: string;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60_000; // 7 days

function sha256Hex(s: string): string { return createHash('sha256').update(s).digest('hex'); }

/** Create a pending invite and return the RAW token (emailed) — only its hash
 *  is stored. Any prior unaccepted invite for the same email+workspace is
 *  replaced so re-inviting doesn't leave stale live tokens around. */
export function createWorkspaceInvite(
  workspaceId: string, email: string, role: 'admin' | 'editor' | 'viewer', aiCitations: boolean, invitedBy: string,
): string {
  const db = getDb();
  const normEmail = email.trim().toLowerCase();
  db.prepare('DELETE FROM workspace_invites WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL')
    .run(workspaceId, normEmail);
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  const expires = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO workspace_invites(id, workspace_id, email, role, ai_citations, token_hash, invited_by, expires_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(id, workspaceId, normEmail, role, aiCitations ? 1 : 0, sha256Hex(token), invitedBy, expires);
  return token;
}

export function listWorkspaceInvites(workspaceId: string): WorkspaceInvite[] {
  return getDb().prepare(`
    SELECT * FROM workspace_invites WHERE workspace_id = ? AND accepted_at IS NULL ORDER BY created_at DESC
  `).all(workspaceId) as WorkspaceInvite[];
}

export function revokeWorkspaceInvite(workspaceId: string, inviteId: string): void {
  getDb().prepare('DELETE FROM workspace_invites WHERE workspace_id = ? AND id = ?').run(workspaceId, inviteId);
}

/** Resolve a raw invite token to its still-valid invite (unexpired, unused),
 *  including the workspace name for the accept-invite page to display. */
export function getInviteByToken(token: string): (WorkspaceInvite & { workspace_name: string }) | null {
  const row = getDb().prepare(`
    SELECT i.*, w.name AS workspace_name FROM workspace_invites i
    JOIN workspaces w ON w.id = i.workspace_id
    WHERE i.token_hash = ?
  `).get(sha256Hex(token)) as (WorkspaceInvite & { workspace_name: string }) | undefined;
  if (!row) return null;
  if (row.accepted_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/** Mark an invite consumed once its target user has been added as a member. */
export function markInviteAccepted(inviteId: string): void {
  getDb().prepare("UPDATE workspace_invites SET accepted_at = datetime('now') WHERE id = ?").run(inviteId);
}
