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
});
