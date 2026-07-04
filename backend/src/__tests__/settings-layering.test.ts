import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

// Layered settings: a workspace override wins over the platform default; an
// absent/empty override transparently inherits the platform default.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-layer-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'layer-secret';

type DbMod = typeof import('../db/database.js');
type UsersMod = typeof import('../auth/users.js');
type WsMod = typeof import('../auth/workspaces.js');
let db: DbMod;
let users: UsersMod;
let workspaces: WsMod;
beforeAll(async () => {
  db = await import('../db/database.js');
  users = await import('../auth/users.js');
  workspaces = await import('../auth/workspaces.js');
});
function newWorkspace(): string {
  const u = users.createUser({ email: `u-${randomUUID()}@x.com`, password: 'password123' });
  return workspaces.createWorkspace('W', u.id).id;
}

describe('effectiveSetting layering', () => {
  it('inherits the platform default, then honours a workspace override', () => {
    const ws = newWorkspace();
    const key = 'openai_api_key';

    // Platform default only.
    db.setSetting(key, 'platform-key');
    expect(db.effectiveSetting(null, key)).toBe('platform-key');
    expect(db.effectiveSetting(ws, key)).toBe('platform-key'); // inherits

    // Workspace override wins.
    db.setWorkspaceSetting(ws, key, 'workspace-key');
    expect(db.effectiveSetting(ws, key)).toBe('workspace-key');
    expect(db.effectiveSetting(null, key)).toBe('platform-key'); // platform unaffected

    // Clearing the override falls back to the platform default.
    db.setWorkspaceSetting(ws, key, '');
    expect(db.effectiveSetting(ws, key)).toBe('platform-key');
  });

  it('keeps overrides isolated between workspaces', () => {
    const a = newWorkspace();
    const b = newWorkspace();
    // crux has no platform default in this test DB.
    db.setWorkspaceSetting(a, 'crux_api_key', 'A-key');
    expect(db.effectiveSetting(a, 'crux_api_key')).toBe('A-key');
    expect(db.effectiveSetting(b, 'crux_api_key')).toBeNull(); // no override, no platform default
  });
});
