import type Database from 'better-sqlite3';

export interface Migration {
  id: string;
  description: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    id: '20260926_04_ranking_playbook',
    description: 'Query×page Search Console window and Ranking Playbook opportunities',
    up(db) {
      db.exec(`
        CREATE TABLE perf_query_page (
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          query TEXT NOT NULL,
          page TEXT NOT NULL,
          clicks INTEGER NOT NULL DEFAULT 0,
          impressions INTEGER NOT NULL DEFAULT 0,
          position REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (site_id, query, page)
        );
        CREATE INDEX idx_perf_query_page_page ON perf_query_page(site_id, page);

        CREATE TABLE perf_query_page_sync (
          site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
          identity TEXT NOT NULL,
          checked_at TEXT NOT NULL,
          success_at TEXT,
          error TEXT,
          truncated INTEGER NOT NULL DEFAULT 0,
          period_start TEXT,
          period_end TEXT,
          row_count INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
  },
  {
    id: '20260926_03_page_signals',
    description: 'Per-page search performance, page inventory for internal links, snippet changes and page-level Core Web Vitals',
    up(db) {
      db.exec(`
        CREATE TABLE perf_page_daily (
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          day TEXT NOT NULL,
          page TEXT NOT NULL,
          clicks INTEGER NOT NULL DEFAULT 0,
          impressions INTEGER NOT NULL DEFAULT 0,
          position REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (site_id, day, page)
        );
        CREATE INDEX idx_perf_page_lookup ON perf_page_daily(site_id, page, day);

        CREATE TABLE page_inventory (
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          url TEXT NOT NULL,
          status INTEGER NOT NULL,
          title TEXT,
          meta_description TEXT,
          h1 TEXT,
          robots TEXT,
          words INTEGER NOT NULL DEFAULT 0,
          links TEXT NOT NULL DEFAULT '[]',
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (site_id, url)
        );

        CREATE TABLE page_snippet_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          url TEXT NOT NULL,
          changed_at TEXT NOT NULL,
          old_title TEXT,
          new_title TEXT,
          old_description TEXT,
          new_description TEXT
        );
        CREATE INDEX idx_snippet_changes_site ON page_snippet_changes(site_id, changed_at DESC);

        CREATE TABLE page_vitals (
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          url TEXT NOT NULL,
          day TEXT NOT NULL,
          has_data INTEGER NOT NULL DEFAULT 0,
          lcp_ms INTEGER,
          inp_ms INTEGER,
          cls REAL,
          PRIMARY KEY (site_id, url, day)
        );
      `);
    },
  },
  {
    id: '20260926_02_google_feedback',
    description: 'Canonical selection, content fingerprints and Search Console sitemap processing feedback',
    up(db) {
      db.exec(`
        ALTER TABLE url_state ADD COLUMN gsc_google_canonical TEXT;
        ALTER TABLE url_state ADD COLUMN gsc_user_canonical TEXT;
        ALTER TABLE url_state ADD COLUMN gsc_robots_state TEXT;
        ALTER TABLE url_state ADD COLUMN content_hash TEXT;
        ALTER TABLE url_state ADD COLUMN content_changed_at TEXT;
        ALTER TABLE sitemap_state ADD COLUMN gsc_errors INTEGER;
        ALTER TABLE sitemap_state ADD COLUMN gsc_warnings INTEGER;
        ALTER TABLE sitemap_state ADD COLUMN gsc_last_downloaded TEXT;
        ALTER TABLE sitemap_state ADD COLUMN gsc_is_pending INTEGER;
        ALTER TABLE sitemap_state ADD COLUMN gsc_checked_at TEXT;
      `);
    },
  },
  {
    id: '20260926_01_google_recrawl_signals',
    description: 'Per-sitemap resubmission signatures, URL Inspection crawl detail and opt-in Indexing API tracking',
    up(db) {
      db.exec(`
        CREATE TABLE sitemap_state (
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          sitemap_url TEXT NOT NULL,
          signature TEXT NOT NULL,
          url_count INTEGER NOT NULL DEFAULT 0,
          last_submitted TEXT,
          PRIMARY KEY (site_id, sitemap_url)
        );
        ALTER TABLE sites ADD COLUMN google_indexing_api INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE url_state ADD COLUMN gsc_verdict TEXT;
        ALTER TABLE url_state ADD COLUMN gsc_coverage_state TEXT;
        ALTER TABLE url_state ADD COLUMN gsc_page_fetch_state TEXT;
        ALTER TABLE url_state ADD COLUMN gsc_last_crawl_time TEXT;
        ALTER TABLE url_state ADD COLUMN google_indexing_notified_at TEXT;
        ALTER TABLE url_state ADD COLUMN google_indexing_lastmod TEXT;
      `);
    },
  },
  {
    id: '20260909_02_search_sync',
    description: 'Opportunity sync status and source identity',
    up(db) {
      db.exec(`CREATE TABLE discovery_search_sync (
        site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
        identity TEXT NOT NULL, checked_at TEXT NOT NULL, success_at TEXT,
        error TEXT, truncated INTEGER NOT NULL DEFAULT 0
      );`);
    },
  },
  { id: '20260909_01_crawl_observations', description: 'Retain bounded crawl import observations for comparison', up(db) {
    db.exec(`CREATE TABLE crawl_import_observations (
      import_id TEXT PRIMARY KEY REFERENCES crawl_imports(id) ON DELETE CASCADE,
      observations TEXT NOT NULL
    );`);
  } },
  { id: '20260908_05_crawl_candidates', description: 'Public crawl candidate inbox', up(db) { db.exec(`
    CREATE TABLE crawl_candidates (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL, target_url TEXT NOT NULL, anchor TEXT NOT NULL,
      crawl_date TEXT, provenance TEXT NOT NULL, imported_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', notes TEXT NOT NULL DEFAULT '',
      UNIQUE(workspace_id, site_id, source_url, target_url)
    );
    CREATE INDEX idx_crawl_candidates ON crawl_candidates(workspace_id,site_id,imported_at DESC);
    CREATE TABLE crawl_imports (
      id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,provenance TEXT NOT NULL,
      imported_at TEXT NOT NULL,summary TEXT NOT NULL
    );
    CREATE INDEX idx_crawl_imports ON crawl_imports(workspace_id,site_id,imported_at DESC);
  `); } },
  {id:'20260908_04_audit_jobs',description:'Persistent audit job status',up(db){db.exec(`CREATE TABLE discovery_jobs(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,state TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE INDEX idx_discovery_jobs ON discovery_jobs(workspace_id,site_id,created_at DESC);`);}},
  { id: '20260908_03_discovery_documents', description: 'Content briefs and measurement plans', up(db) { db.exec(`
    CREATE TABLE discovery_documents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,kind TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX idx_discovery_documents ON discovery_documents(workspace_id,site_id,kind,updated_at DESC);
    CREATE TABLE discovery_document_revisions(id INTEGER PRIMARY KEY AUTOINCREMENT,document_id TEXT NOT NULL REFERENCES discovery_documents(id) ON DELETE CASCADE,body TEXT NOT NULL,observed_at TEXT NOT NULL);
    CREATE INDEX idx_document_revisions ON discovery_document_revisions(document_id,id DESC);
  `); } },
  { id: '20260908_02_backlink_notes', description: 'Backlink review notes and monitoring controls', up(db) { db.exec("ALTER TABLE backlinks ADD COLUMN notes TEXT NOT NULL DEFAULT ''; ALTER TABLE backlinks ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;"); } },
  {
    id: '20260907_01_discovery_workbench',
    description: 'Evidence-based website audits and versioned app-store listing drafts',
    up(db) {
      db.exec(`
        CREATE TABLE discovery_runs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          observed_at TEXT NOT NULL,
          report TEXT NOT NULL
        );
        CREATE INDEX idx_discovery_runs ON discovery_runs(workspace_id, site_id, observed_at DESC);
        CREATE TABLE app_listings (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
          draft TEXT NOT NULL,
          analysis TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_app_listings ON app_listings(workspace_id, updated_at DESC);
        CREATE TABLE app_listing_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          listing_id TEXT NOT NULL REFERENCES app_listings(id) ON DELETE CASCADE,
          draft TEXT NOT NULL,
          analysis TEXT NOT NULL,
          observed_at TEXT NOT NULL
        );
        CREATE INDEX idx_listing_revisions ON app_listing_revisions(listing_id, id DESC);
        CREATE TABLE backlinks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          source_url TEXT NOT NULL,
          target_url TEXT NOT NULL DEFAULT '',
          provenance TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'unverified',
          evidence TEXT NOT NULL DEFAULT '{}',
          first_seen TEXT NOT NULL,
          checked_at TEXT,
          UNIQUE(workspace_id, site_id, source_url, target_url)
        );
        CREATE INDEX idx_backlinks ON backlinks(workspace_id, site_id, checked_at);
        CREATE TABLE backlink_checks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          backlink_id TEXT NOT NULL REFERENCES backlinks(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          evidence TEXT NOT NULL,
          checked_at TEXT NOT NULL
        );
        CREATE INDEX idx_backlink_checks ON backlink_checks(backlink_id, id DESC);
      `);
    },
  },
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
