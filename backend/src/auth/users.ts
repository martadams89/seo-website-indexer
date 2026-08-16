/**
 * App users, sessions and 2FA — the authentication foundation for multi-tenant
 * use. Pure Node crypto: scrypt for passwords, opaque DB-backed session tokens,
 * and RFC 6238 TOTP (HMAC-SHA1) for 2FA. No external auth dependencies.
 *
 * Ownership/workspace scoping builds on top of `users` in a later phase; this
 * layer only handles identity + sessions.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHmac, createHash, randomUUID } from 'crypto';
import { getDb } from '../db/database.js';
import { encrypt, decrypt } from '../utils/crypto.js';

export interface User {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  password_salt: string | null;
  totp_secret: string | null;
  totp_enabled: number;
  role: string;
  is_super_admin: number;
  disabled: number;
  must_change_password: number;
  created_at: string;
  last_login_at: string | null;
}

/** Shape safe to send to the client — never includes secrets. */
export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  is_super_admin: boolean;
  disabled: boolean;
  totp_enabled: boolean;
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
}

export function toPublic(u: User): PublicUser {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role,
    is_super_admin: !!u.is_super_admin, disabled: !!u.disabled, totp_enabled: !!u.totp_enabled,
    must_change_password: !!u.must_change_password,
    created_at: u.created_at,
    last_login_at: u.last_login_at,
  };
}

// ── Passwords (scrypt) ───────────────────────────────────────────────────────

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export function verifyPassword(user: User, password: string): boolean {
  if (!user.password_hash || !user.password_salt) return false;
  const candidate = hashPassword(password, user.password_salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(user.password_hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── User CRUD ────────────────────────────────────────────────────────────────

export function countUsers(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

export function getUserByEmail(email: string): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email.trim()) as User | undefined;
}

export function getUserById(id: string): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function createUser(opts: { email: string; password: string; name?: string; role?: string; superAdmin?: boolean; mustChangePassword?: boolean }): User {
  const salt = randomBytes(16).toString('hex');
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO users(id, email, name, password_hash, password_salt, role, is_super_admin, must_change_password)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(id, opts.email.trim().toLowerCase(), opts.name?.trim() || null, hashPassword(opts.password, salt), salt,
    opts.role ?? 'user', opts.superAdmin ? 1 : 0, opts.mustChangePassword ? 1 : 0);
  return getUserById(id)!;
}

export function setUserPassword(id: string, password: string): void {
  const salt = randomBytes(16).toString('hex');
  getDb().prepare('UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?')
    .run(hashPassword(password, salt), salt, id);
}

/** Set a one-time admin-generated password and revoke every existing session. */
export function setTemporaryPassword(id: string, password: string): void {
  const salt = randomBytes(16).toString('hex');
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 1 WHERE id = ?')
      .run(hashPassword(password, salt), salt, id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    // A previously emailed link must not be able to replace a newer
    // administrator-issued credential.
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(id);
  })();
}

export function generateTemporaryPassword(): string {
  // 24 URL-safe random characters; comfortably above the app's 8-char floor.
  return randomBytes(18).toString('base64url');
}

export function updateUserProfile(id: string, changes: { email?: string; name?: string | null; role?: string }): boolean {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof changes.email === 'string') { sets.push('email = ?'); params.push(changes.email.trim().toLowerCase()); }
  if (changes.name !== undefined) { sets.push('name = ?'); params.push(changes.name?.trim() || null); }
  if (typeof changes.role === 'string') { sets.push('role = ?'); params.push(changes.role); }
  if (sets.length === 0) return true;
  params.push(id);
  return getDb().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
}

export function recordLogin(id: string): void {
  getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
}

export function listUsers(): PublicUser[] {
  return (getDb().prepare('SELECT * FROM users ORDER BY created_at').all() as User[]).map(toPublic);
}

export function countSuperAdmins(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE is_super_admin = 1').get() as { c: number }).c;
}

export function setUserSuperAdmin(id: string, on: boolean): void {
  getDb().prepare('UPDATE users SET is_super_admin = ? WHERE id = ?').run(on ? 1 : 0, id);
}

/** Global account disable (super-admin only) — a disabled user cannot log in
 *  or use any existing session, in any workspace. */
export function setUserDisabled(id: string, disabled: boolean): void {
  getDb().prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
  if (disabled) getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
}

export function deleteUser(id: string): void {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ── Sessions ─────────────────────────────────────────────────────────────────

const SESSION_TTL_DAYS = 30;

export function createSession(userId: string, userAgent?: string, impersonatorUserId?: string | null): string {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();
  getDb().prepare('INSERT INTO sessions(token, user_id, expires_at, user_agent, impersonator_user_id) VALUES(?,?,?,?,?)')
    .run(token, userId, expires, userAgent ?? null, impersonatorUserId ?? null);
  return token;
}

export interface SessionContext { user: User; impersonator: User | null }

/** Resolve a session token to its user and optional impersonating admin. */
export function getSessionContext(token: string | undefined): SessionContext | null {
  if (!token) return null;
  const row = getDb().prepare('SELECT user_id, impersonator_user_id, expires_at FROM sessions WHERE token = ?')
    .get(token) as { user_id: string; impersonator_user_id: string | null; expires_at: string } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  const user = getUserById(row.user_id);
  if (!user) return null;
  const impersonator = row.impersonator_user_id ? getUserById(row.impersonator_user_id) ?? null : null;
  return { user, impersonator };
}

/** Backwards-compatible identity-only session lookup. */
export function getSessionUser(token: string | undefined): User | null {
  return getSessionContext(token)?.user ?? null;
}

export function destroySession(token: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function pruneExpiredSessions(): number {
  return getDb().prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run().changes;
}

export interface AuditEvent {
  id: number;
  actor_user_id: string | null;
  actor_email?: string | null;
  target_user_id: string | null;
  target_email?: string | null;
  workspace_id: string | null;
  action: string;
  detail: string | null;
  ip_address: string | null;
  created_at: string;
}

export function recordAuditEvent(event: {
  actorUserId?: string | null; targetUserId?: string | null; workspaceId?: string | null;
  action: string; detail?: Record<string, unknown> | string | null; ipAddress?: string | null;
}): void {
  const detail = typeof event.detail === 'string' ? event.detail
    : event.detail ? JSON.stringify(event.detail) : null;
  getDb().prepare(`
    INSERT INTO audit_events(actor_user_id, target_user_id, workspace_id, action, detail, ip_address)
    VALUES(?,?,?,?,?,?)
  `).run(event.actorUserId ?? null, event.targetUserId ?? null, event.workspaceId ?? null,
    event.action, detail, event.ipAddress ?? null);
}

export function listAuditEvents(limit = 100, targetUserId?: string): AuditEvent[] {
  const sql = `
    SELECT ae.*, actor.email AS actor_email, target.email AS target_email
    FROM audit_events ae
    LEFT JOIN users actor ON actor.id = ae.actor_user_id
    LEFT JOIN users target ON target.id = ae.target_user_id
    ${targetUserId ? 'WHERE ae.target_user_id = ? OR ae.actor_user_id = ?' : ''}
    ORDER BY ae.created_at DESC, ae.id DESC LIMIT ?
  `;
  return (targetUserId
    ? getDb().prepare(sql).all(targetUserId, targetUserId, limit)
    : getDb().prepare(sql).all(limit)) as AuditEvent[];
}

// ── Password reset tokens (emailed link) ─────────────────────────────────────

const RESET_TTL_MS = 60 * 60_000; // 1 hour
function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

/** Mint a single-use reset token for a user. Returns the RAW token (emailed);
 *  only its hash is stored. Any prior unused tokens for the user are cleared. */
export function createPasswordReset(userId: string): string {
  const db = getDb();
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + RESET_TTL_MS).toISOString();
  db.prepare('INSERT INTO password_resets(token_hash, user_id, expires_at) VALUES(?,?,?)')
    .run(sha256(token), userId, expires);
  return token;
}

/** Validate a reset token and, if good, set the new password + invalidate it and
 *  all of the user's sessions. Returns the user id on success, else null. */
export function consumePasswordReset(token: string, newPassword: string): string | null {
  const db = getDb();
  const hash = sha256(token);
  const row = db.prepare('SELECT user_id, expires_at, used FROM password_resets WHERE token_hash = ?')
    .get(hash) as { user_id: string; expires_at: string; used: number } | undefined;
  if (!row || row.used || new Date(row.expires_at).getTime() < Date.now()) return null;
  setUserPassword(row.user_id, newPassword);
  db.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').run(hash);
  // Force re-login everywhere after a reset.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
  return row.user_id;
}

// ── TOTP (RFC 6238, HMAC-SHA1) ───────────────────────────────────────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return (code % 1_000_000).toString().padStart(6, '0');
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpUri(secret: string, email: string): string {
  return `otpauth://totp/${encodeURIComponent(`SEO Indexer:${email}`)}?secret=${secret}&issuer=SEO%20Indexer&algorithm=SHA1&digits=6&period=30`;
}

/** Verify a 6-digit TOTP against a base32 secret, allowing ±1 step of clock drift. */
export function verifyTotp(secret: string, token: string): boolean {
  const clean = token.replace(/\D/g, '');
  if (clean.length !== 6) return false;
  const key = base32Decode(secret);
  const step = Math.floor(Date.now() / 30_000);
  for (let w = -1; w <= 1; w++) {
    if (timingSafeEqualStr(hotp(key, step + w), clean)) return true;
  }
  return false;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// TOTP secrets are stored encrypted at rest (reusing the app's crypto util).
export function setTotpSecret(id: string, secret: string): void {
  getDb().prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(encrypt(secret), id);
}
export function getTotpSecret(user: User): string | null {
  return user.totp_secret ? decrypt(user.totp_secret) : null;
}
export function enableTotp(id: string): void {
  getDb().prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(id);
}
export function disableTotp(id: string): void {
  getDb().prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(id);
}
