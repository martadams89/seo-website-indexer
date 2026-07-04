/**
 * Offline admin CLI — recovery when you're locked out of the dashboard.
 *
 * The app has no email server by default, and the in-app "change password" form
 * requires your *current* password, so a forgotten password can only be reset
 * out-of-band. This CLI talks straight to the SQLite DB (respecting DATA_DIR).
 *
 * In Docker:
 *   docker exec <container> node dist/cli/admin.js list
 *   docker exec <container> node dist/cli/admin.js reset-password you@example.com
 *   docker exec <container> node dist/cli/admin.js disable-2fa you@example.com
 *   docker exec <container> node dist/cli/admin.js make-admin you@example.com
 *
 * From source (dev):
 *   npx tsx src/cli/admin.ts reset-password you@example.com 'newpass123'
 */
import { randomBytes } from 'crypto';
import { getDb } from '../db/database.js';
import {
  listUsers, getUserByEmail, setUserPassword, disableTotp, setUserSuperAdmin,
} from '../auth/users.js';

function usage(): never {
  console.log(`Admin CLI — dashboard account recovery

Usage:
  node dist/cli/admin.js list
  node dist/cli/admin.js reset-password <email> [newPassword]
  node dist/cli/admin.js disable-2fa <email>
  node dist/cli/admin.js make-admin <email>

If newPassword is omitted, a strong random one is generated and printed.`);
  process.exit(1);
}

function requireUser(email: string) {
  const user = getUserByEmail(email.trim().toLowerCase());
  if (!user) {
    console.error(`✗ No user with email "${email}". Run "list" to see accounts.`);
    process.exit(1);
  }
  return user;
}

function main(): void {
  getDb(); // opens + migrates the DB
  const [cmd, arg1, arg2] = process.argv.slice(2);

  switch (cmd) {
    case 'list': {
      const users = listUsers();
      if (users.length === 0) { console.log('(no users yet — open the dashboard to create the first admin)'); return; }
      for (const u of users) {
        console.log(`${u.email}\t${u.is_super_admin ? 'super-admin' : u.role}${u.totp_enabled ? '\t2FA' : ''}`);
      }
      return;
    }
    case 'reset-password': {
      if (!arg1) usage();
      const user = requireUser(arg1);
      const password = arg2 || randomBytes(12).toString('base64url');
      if (password.length < 8) { console.error('✗ Password must be at least 8 characters.'); process.exit(1); }
      setUserPassword(user.id, password);
      console.log(`✓ Password reset for ${user.email}`);
      if (!arg2) console.log(`  New password: ${password}\n  (save it now — it is not stored anywhere in plain text)`);
      return;
    }
    case 'disable-2fa': {
      if (!arg1) usage();
      const user = requireUser(arg1);
      disableTotp(user.id);
      console.log(`✓ Two-factor authentication disabled for ${user.email}`);
      return;
    }
    case 'make-admin': {
      if (!arg1) usage();
      const user = requireUser(arg1);
      setUserSuperAdmin(user.id, true);
      console.log(`✓ ${user.email} is now a super-admin`);
      return;
    }
    default:
      usage();
  }
}

main();
