import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Password-reset tokens must be single-use, time-limited, and must invalidate
// the user's sessions on use. Fresh temp DB + dynamic imports.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-reset-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'reset-test-secret-123';

type UsersMod = typeof import('../auth/users.js');
type DbMod = typeof import('../db/database.js');
let users: UsersMod;
let db: DbMod;

beforeAll(async () => {
  users = await import('../auth/users.js');
  db = await import('../db/database.js');
});

describe('password reset tokens', () => {
  it('resets the password and is single-use', () => {
    const u = users.createUser({ email: `r-${randomUUID()}@x.com`, password: 'origpass123' });
    const token = users.createPasswordReset(u.id);

    expect(users.consumePasswordReset(token, 'brandnewpass')).toBe(u.id);
    const after = users.getUserById(u.id)!;
    expect(users.verifyPassword(after, 'brandnewpass')).toBe(true);
    expect(users.verifyPassword(after, 'origpass123')).toBe(false);

    // Second use is rejected.
    expect(users.consumePasswordReset(token, 'anotherpass1')).toBeNull();
  });

  it('rejects unknown/garbage tokens', () => {
    expect(users.consumePasswordReset('not-a-real-token', 'whatever12')).toBeNull();
  });

  it('rejects an expired token', () => {
    const u = users.createUser({ email: `e-${randomUUID()}@x.com`, password: 'origpass123' });
    const token = users.createPasswordReset(u.id);
    // Force expiry in the DB.
    db.getDb().prepare("UPDATE password_resets SET expires_at = datetime('now','-1 hour') WHERE user_id = ?").run(u.id);
    expect(users.consumePasswordReset(token, 'newpass1234')).toBeNull();
    // Original password still valid.
    expect(users.verifyPassword(users.getUserById(u.id)!, 'origpass123')).toBe(true);
  });

  it('invalidates existing sessions on reset (forces re-login)', () => {
    const u = users.createUser({ email: `s-${randomUUID()}@x.com`, password: 'origpass123' });
    const sessionToken = users.createSession(u.id);
    expect(users.getSessionUser(sessionToken)?.id).toBe(u.id);

    const reset = users.createPasswordReset(u.id);
    users.consumePasswordReset(reset, 'freshpass123');
    expect(users.getSessionUser(sessionToken)).toBeNull();
  });

  it('admin-generated passwords are one-time and revoke sessions', () => {
    const u = users.createUser({ email: `tmp-${randomUUID()}@x.com`, password: 'origpass123' });
    const sessionToken = users.createSession(u.id);
    const supersededReset = users.createPasswordReset(u.id);
    const temporary = users.generateTemporaryPassword();
    expect(temporary.length).toBeGreaterThanOrEqual(20);

    users.setTemporaryPassword(u.id, temporary);
    const changed = users.getUserById(u.id)!;
    expect(changed.must_change_password).toBe(1);
    expect(users.verifyPassword(changed, temporary)).toBe(true);
    expect(users.getSessionUser(sessionToken)).toBeNull();
    expect(users.consumePasswordReset(supersededReset, 'stale-reset-pass')).toBeNull();

    users.setUserPassword(u.id, 'permanent-pass-123');
    expect(users.getUserById(u.id)!.must_change_password).toBe(0);
  });

  it('tracks the super-admin behind an impersonated session', () => {
    const admin = users.createUser({ email: `imp-admin-${randomUUID()}@x.com`, password: 'password123', superAdmin: true });
    const target = users.createUser({ email: `imp-target-${randomUUID()}@x.com`, password: 'password123' });
    const token = users.createSession(target.id, 'test', admin.id);
    const session = users.getSessionContext(token)!;
    expect(session.user.id).toBe(target.id);
    expect(session.impersonator?.id).toBe(admin.id);
  });

  it('keeps administration events queryable for a user', () => {
    const actor = users.createUser({ email: `audit-a-${randomUUID()}@x.com`, password: 'password123', superAdmin: true });
    const target = users.createUser({ email: `audit-t-${randomUUID()}@x.com`, password: 'password123' });
    users.recordAuditEvent({ actorUserId: actor.id, targetUserId: target.id, action: 'user.tested', detail: { ok: true } });
    const event = users.listAuditEvents(10, target.id).find(e => e.action === 'user.tested');
    expect(event?.actor_email).toBe(actor.email);
    expect(event?.target_email).toBe(target.email);
    expect(JSON.parse(event?.detail ?? '{}')).toEqual({ ok: true });
  });
});
