/**
 * App users, sessions and 2FA — the authentication foundation for multi-tenant
 * use. Pure Node crypto: scrypt for passwords, opaque DB-backed session tokens,
 * and RFC 6238 TOTP (HMAC-SHA1) for 2FA. No external auth dependencies.
 *
 * Ownership/workspace scoping builds on top of `users` in a later phase; this
 * layer only handles identity + sessions.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHmac, randomUUID } from 'crypto';
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
  totp_enabled: boolean;
}

export function toPublic(u: User): PublicUser {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role,
    is_super_admin: !!u.is_super_admin, totp_enabled: !!u.totp_enabled,
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

export function createUser(opts: { email: string; password: string; name?: string; role?: string; superAdmin?: boolean }): User {
  const salt = randomBytes(16).toString('hex');
  const id = randomUUID();
  getDb().prepare(`
    INSERT INTO users(id, email, name, password_hash, password_salt, role, is_super_admin)
    VALUES(?,?,?,?,?,?,?)
  `).run(id, opts.email.trim(), opts.name?.trim() || null, hashPassword(opts.password, salt), salt,
    opts.role ?? 'user', opts.superAdmin ? 1 : 0);
  return getUserById(id)!;
}

export function setUserPassword(id: string, password: string): void {
  const salt = randomBytes(16).toString('hex');
  getDb().prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
    .run(hashPassword(password, salt), salt, id);
}

export function recordLogin(id: string): void {
  getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
}

export function listUsers(): PublicUser[] {
  return (getDb().prepare('SELECT * FROM users ORDER BY created_at').all() as User[]).map(toPublic);
}

// ── Sessions ─────────────────────────────────────────────────────────────────

const SESSION_TTL_DAYS = 30;

export function createSession(userId: string, userAgent?: string): string {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();
  getDb().prepare('INSERT INTO sessions(token, user_id, expires_at, user_agent) VALUES(?,?,?,?)')
    .run(token, userId, expires, userAgent ?? null);
  return token;
}

/** Resolve a session token to its user, or null if missing/expired. */
export function getSessionUser(token: string | undefined): User | null {
  if (!token) return null;
  const row = getDb().prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?')
    .get(token) as { user_id: string; expires_at: string } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return getUserById(row.user_id) ?? null;
}

export function destroySession(token: string): void {
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function pruneExpiredSessions(): number {
  return getDb().prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run().changes;
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
