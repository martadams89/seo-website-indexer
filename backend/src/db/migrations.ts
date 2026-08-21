import type Database from 'better-sqlite3';

export interface Migration {
  id: string;
  description: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    id: '20260821_01_site_file_history',
    description: 'Retain robots.txt and llms.txt change history',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS site_file_snapshots (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          file_kind         TEXT NOT NULL CHECK(file_kind IN ('robots.txt', 'llms.txt')),
          source            TEXT NOT NULL CHECK(source IN ('live', 'deployment')),
          http_status       INTEGER,
          content_hash      TEXT NOT NULL,
          content           TEXT NOT NULL,
          matches_generated INTEGER,
          observed_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_site_file_snapshots_site
          ON site_file_snapshots(site_id, file_kind, observed_at DESC, id DESC);
      `);
    },
  },
];

/** Run each schema migration exactly once, transactionally and in id order. */
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>).map(row => row.id),
  );
  const record = db.prepare('INSERT INTO schema_migrations(id, description) VALUES(?, ?)');

  for (const migration of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      migration.up(db);
      record.run(migration.id, migration.description);
    })();
  }
}

export function listAppliedMigrations(db: Database.Database): Array<{ id: string; description: string; applied_at: string }> {
  return db.prepare('SELECT id, description, applied_at FROM schema_migrations ORDER BY id').all() as Array<{
    id: string;
    description: string;
    applied_at: string;
  }>;
}
