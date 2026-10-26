import type Database from 'better-sqlite3';

export interface Migration {
  id: string;
  description: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    id: '20261026_01_gbp_profile_posts_photos',
    description: 'Business Profile editing, posts and photos: per-location AI rules, Google-suggested edit tracking and an approval queue',
    up(db) {
      db.exec(`
        ALTER TABLE gbp_locations ADD COLUMN profile_rules TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE gbp_locations ADD COLUMN google_updates TEXT;
        ALTER TABLE gbp_locations ADD COLUMN google_updates_checked_at TEXT;
        CREATE TABLE gbp_changes (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          location_id TEXT NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          summary TEXT NOT NULL,
          rationale TEXT,
          source TEXT NOT NULL DEFAULT 'dashboard',
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          status TEXT NOT NULL,
          findings TEXT NOT NULL DEFAULT '[]',
          decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          decided_at TEXT,
          published_at TEXT,
          error TEXT,
          result TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_gbp_changes_workspace_status ON gbp_changes(workspace_id, status);
        CREATE INDEX idx_gbp_changes_location ON gbp_changes(location_id, created_at DESC);
      `);
    },
  },
  {
    id: '20261025_03_google_oauth_state_purpose',
    description: 'Let a Google sign-in be a one-off API enable flow that stores no connection',
    up(db) {
      db.exec(`
        ALTER TABLE google_oauth_states ADD COLUMN purpose TEXT;
        ALTER TABLE google_oauth_states ADD COLUMN payload TEXT;
      `);
    },
  },
  {
    id: '20261021_01_ads_ga4_property',
    description: 'Link a GA4 property to each Google Ads client so the AI routine can read its analytics',
    up(db) {
      db.exec(`
        ALTER TABLE ads_accounts ADD COLUMN ga4_property_id TEXT;
        ALTER TABLE ads_accounts ADD COLUMN ga4_property_name TEXT;
      `);
    },
  },
  {
    id: '20261025_02_content_groups',
    description: 'Content groups: pages grouped by URL rules for group-level Search Console reporting',
    up(db) {
      db.exec(`
        CREATE TABLE content_groups (
          id TEXT PRIMARY KEY,
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          include_rules TEXT NOT NULL DEFAULT '[]',
          exclude_rules TEXT NOT NULL DEFAULT '[]',
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(site_id, name)
        );
      `);
    },
  },
  {
    id: '20261025_01_google_reviews',
    description: 'Google Business Profile locations, synced reviews and guarded reply plans',
    up(db) {
      db.exec(`
        CREATE TABLE gbp_locations (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          google_account_id TEXT REFERENCES google_accounts(id) ON DELETE SET NULL,
          account_name TEXT NOT NULL,
          location_name TEXT NOT NULL,
          title TEXT,
          address TEXT,
          website TEXT,
          place_id TEXT,
          maps_uri TEXT,
          new_review_uri TEXT,
          site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
          brief TEXT NOT NULL DEFAULT '{}',
          rules TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          average_rating REAL,
          total_reviews INTEGER,
          last_synced_at TEXT,
          last_full_sync_at TEXT,
          last_error TEXT,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(workspace_id, location_name)
        );
        CREATE TABLE gbp_reviews (
          id TEXT PRIMARY KEY,
          location_id TEXT NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          review_name TEXT NOT NULL,
          reviewer_name TEXT,
          reviewer_photo TEXT,
          anonymous INTEGER NOT NULL DEFAULT 0,
          rating INTEGER NOT NULL DEFAULT 0,
          comment TEXT,
          create_time TEXT,
          update_time TEXT,
          reply_comment TEXT,
          reply_update_time TEXT,
          reply_state TEXT,
          reply_policy_violation TEXT,
          reply_url TEXT,
          media TEXT NOT NULL DEFAULT '[]',
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(location_id, review_name)
        );
        CREATE INDEX idx_gbp_reviews_location_time ON gbp_reviews(location_id, create_time DESC);
        CREATE TABLE gbp_replies (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          location_id TEXT NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,
          review_id TEXT NOT NULL REFERENCES gbp_reviews(id) ON DELETE CASCADE,
          action TEXT NOT NULL DEFAULT 'reply',
          text TEXT,
          previous_reply TEXT,
          rationale TEXT,
          rating INTEGER,
          source TEXT NOT NULL DEFAULT 'dashboard',
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          status TEXT NOT NULL,
          findings TEXT NOT NULL DEFAULT '[]',
          decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          decided_at TEXT,
          published_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_gbp_replies_workspace_status ON gbp_replies(workspace_id, status, created_at DESC);
        CREATE INDEX idx_gbp_replies_review ON gbp_replies(review_id, created_at DESC);
      `);
    },
  },
  {
    id: '20261019_03_manual_index_requests',
    description: 'Track Search Console "Request indexing" clicks made by a person or a browser agent',
    up(db) {
      db.exec(`
        ALTER TABLE url_state ADD COLUMN manual_index_requested_at TEXT;
        ALTER TABLE url_state ADD COLUMN manual_index_outcome TEXT;
      `);
    },
  },
  {
    id: '20261019_01_google_ads',
    description: 'Google Ads client accounts, guarded change plans and AI routine history',
    up(db) {
      db.exec(`
        CREATE TABLE ads_accounts (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          google_account_id TEXT REFERENCES google_accounts(id) ON DELETE SET NULL,
          customer_id TEXT NOT NULL,
          login_customer_id TEXT,
          name TEXT,
          currency TEXT,
          time_zone TEXT,
          is_manager INTEGER NOT NULL DEFAULT 0,
          test_account INTEGER NOT NULL DEFAULT 0,
          monthly_budget REAL,
          brief TEXT NOT NULL DEFAULT '{}',
          guardrails TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          last_checked_at TEXT,
          last_error TEXT,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (workspace_id, customer_id)
        );
        CREATE INDEX idx_ads_accounts_ws ON ads_accounts(workspace_id);

        CREATE TABLE ads_changes (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          ads_account_id TEXT NOT NULL REFERENCES ads_accounts(id) ON DELETE CASCADE,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          source TEXT NOT NULL,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          rationale TEXT,
          operations TEXT NOT NULL,
          before_state TEXT NOT NULL DEFAULT '{}',
          impact TEXT NOT NULL DEFAULT '{}',
          findings TEXT NOT NULL DEFAULT '[]',
          validation TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          decided_at TEXT,
          applied_at TEXT,
          result TEXT,
          error TEXT,
          reverts_change_id TEXT,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_ads_changes_account ON ads_changes(ads_account_id, created_at DESC);
        CREATE INDEX idx_ads_changes_ws_status ON ads_changes(workspace_id, status, created_at DESC);

        CREATE TABLE ads_routine_runs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          ads_account_id TEXT REFERENCES ads_accounts(id) ON DELETE CASCADE,
          user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          summary TEXT NOT NULL,
          findings TEXT NOT NULL DEFAULT '[]',
          actions TEXT NOT NULL DEFAULT '[]',
          next_steps TEXT NOT NULL DEFAULT '[]',
          market_notes TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_ads_routine_runs_ws ON ads_routine_runs(workspace_id, created_at DESC);
      `);
    },
  },
  {
    id: '20261019_02_mcp_oauth',
    description: 'OAuth 2.1 authorization for MCP clients (dynamic registration, client metadata documents, PKCE, refresh tokens)',
    up(db) {
      db.exec(`
        CREATE TABLE mcp_oauth_clients (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          redirect_uris TEXT NOT NULL,
          secret_hash TEXT,
          token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
          created_ip TEXT,
          -- Set for clients a person registered on the dashboard (kept until deleted).
          registered_by TEXT REFERENCES users(id) ON DELETE CASCADE,
          -- Set for Client ID Metadata Document clients (client_id is this https URL).
          metadata_fetched_at TEXT,
          last_used_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE mcp_oauth_requests (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
          redirect_uri TEXT NOT NULL,
          state TEXT,
          scope TEXT,
          code_challenge TEXT NOT NULL,
          resource TEXT,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE mcp_oauth_codes (
          code_hash TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          redirect_uri TEXT NOT NULL,
          code_challenge TEXT NOT NULL,
          scopes TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );

        CREATE TABLE mcp_oauth_grants (
          id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          scopes TEXT NOT NULL,
          refresh_hash TEXT UNIQUE,
          refresh_expires_at TEXT,
          last_used_at TEXT,
          revoked_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_mcp_oauth_grants_user ON mcp_oauth_grants(user_id);

        ALTER TABLE mcp_tokens ADD COLUMN oauth_grant_id TEXT REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE;
      `);
    },
  },
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

        CREATE TABLE playbook_opportunities (
          id TEXT PRIMARY KEY,
          site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          subtype TEXT,
          page TEXT NOT NULL,
          secondary_page TEXT,
          headline TEXT NOT NULL,
          steps TEXT NOT NULL DEFAULT '[]',
          evidence TEXT NOT NULL DEFAULT '{}',
          low REAL NOT NULL DEFAULT 0,
          high REAL NOT NULL DEFAULT 0,
          point REAL NOT NULL DEFAULT 0,
          effort TEXT NOT NULL DEFAULT 'M',
          confidence TEXT NOT NULL DEFAULT 'medium',
          counted INTEGER NOT NULL DEFAULT 1,
          hidden INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open',
          changed INTEGER NOT NULL DEFAULT 0,
          dismissed_high REAL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          computed_at TEXT NOT NULL,
          work_item_id TEXT,
          draft TEXT,
          draft_at TEXT,
          done_at TEXT,
          baseline_clicks REAL,
          baseline_site_clicks REAL
        );
        CREATE INDEX idx_playbook_site ON playbook_opportunities(site_id, status, point DESC);

        CREATE TABLE playbook_runs (
          site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
          computed_at TEXT NOT NULL,
          summary TEXT NOT NULL DEFAULT '{}',
          notified_at TEXT
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
