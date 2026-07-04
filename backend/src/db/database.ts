import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { encrypt, decrypt } from '../utils/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'indexer.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    // Scheduler + HTTP handlers write concurrently; wait for locks instead of
    // throwing SQLITE_BUSY.
    _db.pragma('busy_timeout = 5000');
    initSchema(_db);
    migrateSettingsToAccounts(_db);
    backfillSiteAccounts(_db);
  }
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_accounts (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE,
      client_id     TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      access_token  TEXT,
      refresh_token TEXT NOT NULL,
      token_expiry  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sites (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      domain      TEXT NOT NULL UNIQUE,
      sitemap_url TEXT NOT NULL,
      gsc_url     TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      google_account_id TEXT REFERENCES google_accounts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS url_state (
      url               TEXT NOT NULL,
      site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      last_submitted    TEXT,
      last_seen_lastmod TEXT,
      submission_count  INTEGER NOT NULL DEFAULT 0,
      google_submitted  INTEGER NOT NULL DEFAULT 0,
      indexnow_submitted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (url, site_id)
    );

    CREATE TABLE IF NOT EXISTS run_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT NOT NULL,
      level      TEXT NOT NULL DEFAULT 'info',
      message    TEXT NOT NULL,
      site_id    TEXT,
      url        TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_logs_created ON run_logs(created_at);

    CREATE TABLE IF NOT EXISTS run_history (
      id              TEXT PRIMARY KEY,
      started_at      TEXT NOT NULL,
      finished_at     TEXT,
      status          TEXT NOT NULL DEFAULT 'running',
      total_submitted INTEGER NOT NULL DEFAULT 0,
      total_skipped   INTEGER NOT NULL DEFAULT 0,
      total_failed    INTEGER NOT NULL DEFAULT 0,
      trigger         TEXT NOT NULL DEFAULT 'manual'
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS indexnow_keys (
      site_id    TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
      key_value  TEXT NOT NULL,
      verified   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_quota_usage (
      day        TEXT NOT NULL,
      api        TEXT NOT NULL,
      bucket     TEXT NOT NULL,
      count      INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (day, api, bucket)
    );

    CREATE INDEX IF NOT EXISTS idx_api_quota_day ON api_quota_usage(day);

    CREATE TABLE IF NOT EXISTS url_failures (
      url            TEXT NOT NULL,
      site_id        TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      api            TEXT NOT NULL,
      fail_count     INTEGER NOT NULL DEFAULT 0,
      last_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
      first_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (url, site_id, api)
    );

    CREATE INDEX IF NOT EXISTS idx_url_failures_last ON url_failures(last_failed_at);
    CREATE INDEX IF NOT EXISTS idx_url_state_site ON url_state(site_id);

    -- ── Analytics engine ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS site_stats_daily (
      site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      day               TEXT NOT NULL,             -- YYYY-MM-DD
      urls_total        INTEGER NOT NULL DEFAULT 0,
      urls_submitted    INTEGER NOT NULL DEFAULT 0,
      urls_google       INTEGER NOT NULL DEFAULT 0,
      urls_indexnow     INTEGER NOT NULL DEFAULT 0,
      urls_indexed      INTEGER NOT NULL DEFAULT 0, -- GSC 'Submitted and indexed' etc.
      urls_not_indexed  INTEGER NOT NULL DEFAULT 0,
      urls_with_schema  INTEGER NOT NULL DEFAULT 0,
      urls_stale        INTEGER NOT NULL DEFAULT 0, -- lastmod newer than last GSC crawl
      failures          INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (site_id, day)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id    TEXT REFERENCES sites(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,      -- index_drop | schema_drop | hygiene | llms_drift | quota | bing | citation
      severity   TEXT NOT NULL DEFAULT 'warn',
      message    TEXT NOT NULL,
      detail     TEXT,
      acked      INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

    -- ── AI citation tracking ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ai_prompts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id    TEXT REFERENCES sites(id) ON DELETE CASCADE,
      prompt     TEXT NOT NULL,
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_results (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_id  INTEGER NOT NULL REFERENCES ai_prompts(id) ON DELETE CASCADE,
      provider   TEXT NOT NULL,      -- openai | anthropic | gemini | perplexity | xai
      model      TEXT,
      cited      INTEGER NOT NULL DEFAULT 0,
      domains    TEXT,               -- JSON array of our domains found
      excerpt    TEXT,
      error      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_results_prompt ON ai_results(prompt_id, created_at);

    -- ── Core Web Vitals (CrUX) snapshots ─────────────────────────────────
    CREATE TABLE IF NOT EXISTS crux_snapshots (
      site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      day        TEXT NOT NULL,
      lcp_ms     INTEGER,
      inp_ms     INTEGER,
      cls        REAL,
      PRIMARY KEY (site_id, day)
    );

    -- ── Search-performance rollups (GSC + Bing, cached daily) ─────────────
    CREATE TABLE IF NOT EXISTS perf_daily (
      site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      engine      TEXT NOT NULL,            -- google | bing
      day         TEXT NOT NULL,            -- YYYY-MM-DD
      clicks      INTEGER NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      ctr         REAL NOT NULL DEFAULT 0,
      position    REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (site_id, engine, day)
    );

    CREATE TABLE IF NOT EXISTS perf_query_daily (
      site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      engine      TEXT NOT NULL,
      day         TEXT NOT NULL,
      query       TEXT NOT NULL,
      clicks      INTEGER NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      position    REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (site_id, engine, day, query)
    );
    CREATE INDEX IF NOT EXISTS idx_perf_query_lookup ON perf_query_daily(site_id, engine, query, day);

    CREATE TABLE IF NOT EXISTS tracked_queries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      query        TEXT NOT NULL,
      last_position REAL,                   -- last observed avg position (for drop detection)
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (site_id, query)
    );

    -- ── App users & sessions (multi-tenant foundation) ───────────────────
    CREATE TABLE IF NOT EXISTS users (
      id             TEXT PRIMARY KEY,
      email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name           TEXT,
      password_hash  TEXT,                   -- scrypt hash (hex); null if SSO-only later
      password_salt  TEXT,                   -- hex salt
      totp_secret    TEXT,                   -- encrypted base32 secret; null until enrolled
      totp_enabled   INTEGER NOT NULL DEFAULT 0,
      role           TEXT NOT NULL DEFAULT 'user',   -- user | admin
      is_super_admin INTEGER NOT NULL DEFAULT 0,     -- sees all workspaces (first admin)
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,          -- opaque random token; the cookie holds it
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      active_workspace_id TEXT,              -- currently-selected workspace for this session
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT NOT NULL,
      user_agent  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    -- Single-use password-reset tokens (emailed link). Only the SHA-256 of the
    -- token is stored; short-lived and consumed on use.
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

    -- ── Workspaces (a user's 'client base'; the tenant boundary) ─────────
    CREATE TABLE IF NOT EXISTS workspaces (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      owner_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);

    -- Shared access to a workspace (owner is implicit; this is for extra members).
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role         TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY (workspace_id, user_id)
    );

    -- Passkeys (WebAuthn credentials) per user.
    CREATE TABLE IF NOT EXISTS passkeys (
      id            TEXT PRIMARY KEY,         -- credential id (base64url)
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key    TEXT NOT NULL,           -- base64url COSE public key
      counter       INTEGER NOT NULL DEFAULT 0,
      transports    TEXT,                    -- JSON array
      name          TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);

    -- Multiple Bing Webmaster accounts (each a verified-property API key).
    CREATE TABLE IF NOT EXISTS bing_accounts (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      api_key       TEXT NOT NULL,           -- encrypted at rest
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bing_accounts_ws ON bing_accounts(workspace_id);
  `);

  // Backwards compatibility migrations
  const siteCols = db.prepare("PRAGMA table_info(sites)").all() as { name: string }[];
  if (!siteCols.some(c => c.name === 'google_account_id')) {
    db.exec("ALTER TABLE sites ADD COLUMN google_account_id TEXT REFERENCES google_accounts(id) ON DELETE SET NULL;");
  }
  if (!siteCols.some(c => c.name === 'robots_txt_status')) {
    db.exec("ALTER TABLE sites ADD COLUMN robots_txt_status TEXT;");
  }
  if (!siteCols.some(c => c.name === 'llms_txt_status')) {
    db.exec("ALTER TABLE sites ADD COLUMN llms_txt_status TEXT;");
  }
  if (!siteCols.some(c => c.name === 'deploy_webhook_url')) {
    db.exec("ALTER TABLE sites ADD COLUMN deploy_webhook_url TEXT;");
  }
  if (!siteCols.some(c => c.name === 'ftp_host')) {
    db.exec("ALTER TABLE sites ADD COLUMN ftp_host TEXT;");
  }
  if (!siteCols.some(c => c.name === 'ftp_port')) {
    db.exec("ALTER TABLE sites ADD COLUMN ftp_port INTEGER DEFAULT 21;");
  }
  if (!siteCols.some(c => c.name === 'ftp_user')) {
    db.exec("ALTER TABLE sites ADD COLUMN ftp_user TEXT;");
  }
  if (!siteCols.some(c => c.name === 'ftp_pass')) {
    db.exec("ALTER TABLE sites ADD COLUMN ftp_pass TEXT;");
  }
  if (!siteCols.some(c => c.name === 'ftp_path')) {
    db.exec("ALTER TABLE sites ADD COLUMN ftp_path TEXT;");
  }
  // 0 = monitor-only (default: the site's llms.txt/robots.txt are maintained
  // by hand or another pipeline — the tool audits but NEVER deploys);
  // 1 = managed (the tool generates and deploys the files).
  if (!siteCols.some(c => c.name === 'geo_manage')) {
    db.exec("ALTER TABLE sites ADD COLUMN geo_manage INTEGER DEFAULT 0;");
  }
  // AI-generated (or hand-edited) llms.txt body; when set, it's what gets
  // deployed instead of the minimal built-in template.
  if (!siteCols.some(c => c.name === 'llms_txt_content')) {
    db.exec("ALTER TABLE sites ADD COLUMN llms_txt_content TEXT;");
  }
  // Multi-tenant: which workspace a site belongs to, and which Bing account it submits through.
  if (!siteCols.some(c => c.name === 'workspace_id')) {
    db.exec("ALTER TABLE sites ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;");
  }
  if (!siteCols.some(c => c.name === 'bing_account_id')) {
    db.exec("ALTER TABLE sites ADD COLUMN bing_account_id TEXT REFERENCES bing_accounts(id) ON DELETE SET NULL;");
  }
  const gaCols = db.prepare("PRAGMA table_info(google_accounts)").all() as { name: string }[];
  if (gaCols.length > 0 && !gaCols.some(c => c.name === 'workspace_id')) {
    db.exec("ALTER TABLE google_accounts ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;");
  }

  const urlCols = db.prepare("PRAGMA table_info(url_state)").all() as { name: string }[];
  if (!urlCols.some(c => c.name === 'gsc_indexing_state')) {
    db.exec("ALTER TABLE url_state ADD COLUMN gsc_indexing_state TEXT;");
  }
  if (!urlCols.some(c => c.name === 'gsc_last_inspected')) {
    db.exec("ALTER TABLE url_state ADD COLUMN gsc_last_inspected TEXT;");
  }
  if (!urlCols.some(c => c.name === 'has_schema')) {
    db.exec("ALTER TABLE url_state ADD COLUMN has_schema INTEGER DEFAULT 0;");
  }
  if (!urlCols.some(c => c.name === 'schema_types')) {
    db.exec("ALTER TABLE url_state ADD COLUMN schema_types TEXT;");
  }
  // URLs discovered via robots.txt secondary sitemaps that are not indexable
  // HTML pages (e.g. llms.txt). Submitted to IndexNow only — never to the
  // Google Indexing API, GSC sitemap submission, or URL Inspection.
  if (!urlCols.some(c => c.name === 'indexnow_only')) {
    db.exec("ALTER TABLE url_state ADD COLUMN indexnow_only INTEGER DEFAULT 0;");
  }

  // AI citations: conversation threading + provider citation URLs.
  const aiCols = db.prepare("PRAGMA table_info(ai_results)").all() as { name: string }[];
  if (aiCols.length > 0) {
    if (!aiCols.some(c => c.name === 'parent_id')) {
      db.exec("ALTER TABLE ai_results ADD COLUMN parent_id INTEGER REFERENCES ai_results(id) ON DELETE CASCADE;");
    }
    if (!aiCols.some(c => c.name === 'citations')) {
      db.exec("ALTER TABLE ai_results ADD COLUMN citations TEXT;");
    }
    if (!aiCols.some(c => c.name === 'user_prompt')) {
      db.exec("ALTER TABLE ai_results ADD COLUMN user_prompt TEXT;");
    }
  }
}

function migrateSettingsToAccounts(db: Database.Database): void {
  const getSettingFn = (k: string) => {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  };

  const oldRefreshToken = getSettingFn('oauth_refresh_token');
  if (oldRefreshToken) {
    const oldClientId = getSettingFn('oauth_client_id') || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
    const oldClientSecret = getSettingFn('oauth_client_secret') || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
    const oldAccessToken = getSettingFn('oauth_access_token');
    const oldTokenExpiry = getSettingFn('oauth_token_expiry');

    try {
      db.prepare(`
        INSERT OR REPLACE INTO google_accounts (id, email, client_id, client_secret, access_token, refresh_token, token_expiry)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'default',
        'Primary Account',
        oldClientId,
        oldClientSecret,
        oldAccessToken,
        oldRefreshToken,
        oldTokenExpiry
      );

      db.exec("UPDATE sites SET google_account_id = 'default' WHERE google_account_id IS NULL;");
      db.prepare("DELETE FROM settings WHERE key IN ('oauth_refresh_token', 'oauth_access_token', 'oauth_token_expiry', 'oauth_authenticated')").run();
    } catch (e) {
      console.error('Failed to run settings to google_accounts migration:', e);
    }
  }
}

// Backfill: when a Google account exists but sites still reference NULL or a
// non-existent account id (e.g. user added the account through the new
// multi-account flow after creating sites, or the legacy 'default' migration
// fired but the row was later removed), auto-link orphan sites to the
// most-recently-created account so the UI and scheduler agree.
function backfillSiteAccounts(db: Database.Database): void {
  try {
    const accountCount = (db.prepare('SELECT COUNT(*) AS c FROM google_accounts').get() as { c: number }).c;
    if (accountCount === 0) return; // nothing to link to yet

    // Pick the newest account by created_at as the default fallback. This
    // matches the scheduler's first-account fallback semantics in spirit
    // (single-account installs are unambiguous; multi-account ones get the
    // most-recently-added account, and the user can re-assign per site).
    const defaultAccount = db.prepare(
      'SELECT id FROM google_accounts ORDER BY created_at DESC LIMIT 1'
    ).get() as { id: string } | undefined;
    if (!defaultAccount) return;

    // Orphan = NULL OR points at a row that no longer exists.
    const orphans = db.prepare(`
      SELECT s.id, s.name, s.google_account_id
      FROM sites s
      LEFT JOIN google_accounts a ON a.id = s.google_account_id
      WHERE s.google_account_id IS NULL OR a.id IS NULL
    `).all() as Array<{ id: string; name: string; google_account_id: string | null }>;

    if (orphans.length === 0) return;

    const upd = db.prepare('UPDATE sites SET google_account_id = ? WHERE id = ?');
    const tx = db.transaction((rows: typeof orphans) => {
      for (const r of rows) upd.run(defaultAccount.id, r.id);
    });
    tx(orphans);

    console.log(
      `[migration] Linked ${orphans.length} site(s) to Google account ${defaultAccount.id}: ` +
      orphans.map(o => `${o.name}${o.google_account_id ? ` (was stale "${o.google_account_id}")` : ''}`).join(', ')
    );
  } catch (e) {
    console.error('Failed to backfill site → google_account associations:', e);
  }
}

// ── Settings helpers ─────────────────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)').run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ── Site helpers ─────────────────────────────────────────────────────────────

export interface Site {
  id: string;
  name: string;
  domain: string;
  sitemap_url: string;
  gsc_url: string;
  enabled: number;
  created_at: string;
  google_account_id?: string | null;
  robots_txt_status?: string | null;
  llms_txt_status?: string | null;
  deploy_webhook_url?: string | null;
  ftp_host?: string | null;
  ftp_port?: number | null;
  ftp_user?: string | null;
  ftp_pass?: string | null;
  ftp_path?: string | null;
  geo_manage?: number | null;
  llms_txt_content?: string | null;
  workspace_id?: string | null;
  bing_account_id?: string | null;
}

// All enabled sites across every workspace — used by the background scheduler,
// which indexes the whole install regardless of who's logged in.
export function getAllSites(): Site[] {
  return (getDb().prepare('SELECT * FROM sites WHERE enabled = 1 ORDER BY created_at').all() as Site[])
    .map(decryptSiteSecrets);
}

// Sites within one workspace — used by the tenant-scoped API surface.
export function getSitesForWorkspace(workspaceId: string): Site[] {
  return (getDb().prepare('SELECT * FROM sites WHERE workspace_id = ? ORDER BY created_at').all(workspaceId) as Site[])
    .map(decryptSiteSecrets);
}

export function getSiteById(id: string): Site | null {
  const row = getDb().prepare('SELECT * FROM sites WHERE id = ?').get(id) as Site | undefined;
  return row ? decryptSiteSecrets(row) : null;
}

function decryptSiteSecrets(site: Site): Site {
  if (site.ftp_pass) site.ftp_pass = decrypt(site.ftp_pass);
  return site;
}

export function upsertSite(site: Omit<Site, 'created_at'>): void {
  const merged = {
    google_account_id: null as string | null,
    robots_txt_status: null as string | null,
    llms_txt_status: null as string | null,
    deploy_webhook_url: null as string | null,
    ftp_host: null as string | null,
    ftp_port: 21 as number | null,
    ftp_user: null as string | null,
    ftp_path: null as string | null,
    geo_manage: 0 as number | null,
    workspace_id: null as string | null,
    bing_account_id: null as string | null,
    ...site,
    // Always encrypt FTP password before writing
    ftp_pass: encrypt(site.ftp_pass ?? null),
  };
  getDb().prepare(`
    INSERT INTO sites(id, name, domain, sitemap_url, gsc_url, enabled, google_account_id, robots_txt_status, llms_txt_status, deploy_webhook_url, ftp_host, ftp_port, ftp_user, ftp_pass, ftp_path, workspace_id, bing_account_id)
    VALUES(@id, @name, @domain, @sitemap_url, @gsc_url, @enabled, @google_account_id, @robots_txt_status, @llms_txt_status, @deploy_webhook_url, @ftp_host, @ftp_port, @ftp_user, @ftp_pass, @ftp_path, @workspace_id, @bing_account_id)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      domain = excluded.domain,
      sitemap_url = excluded.sitemap_url,
      gsc_url = excluded.gsc_url,
      enabled = excluded.enabled,
      google_account_id = excluded.google_account_id,
      robots_txt_status = COALESCE(excluded.robots_txt_status, sites.robots_txt_status),
      llms_txt_status = COALESCE(excluded.llms_txt_status, sites.llms_txt_status),
      deploy_webhook_url = excluded.deploy_webhook_url,
      ftp_host = excluded.ftp_host,
      ftp_port = excluded.ftp_port,
      ftp_user = excluded.ftp_user,
      ftp_pass = excluded.ftp_pass,
      ftp_path = excluded.ftp_path,
      -- workspace never moves on a plain edit (COALESCE preserves it); bing
      -- account is set/cleared explicitly by the caller.
      workspace_id = COALESCE(excluded.workspace_id, sites.workspace_id),
      bing_account_id = excluded.bing_account_id
  `).run(merged);
}

export function deleteSite(id: string): void {
  getDb().prepare('DELETE FROM sites WHERE id = ?').run(id);
}

/** Persist a custom (AI-generated or hand-edited) llms.txt body for a site.
 *  Pass null/empty to clear it and fall back to the built-in template. */
export function setSiteLlmsContent(id: string, content: string | null): void {
  getDb().prepare('UPDATE sites SET llms_txt_content = ? WHERE id = ?').run(content && content.trim() ? content : null, id);
}

// ── URL state helpers ─────────────────────────────────────────────────────────

export interface UrlState {
  url: string;
  site_id: string;
  last_submitted: string | null;
  last_seen_lastmod: string | null;
  submission_count: number;
  google_submitted: number;
  indexnow_submitted: number;
  gsc_indexing_state?: string | null;
  gsc_last_inspected?: string | null;
  has_schema?: number | null;
  schema_types?: string | null;
  /** 1 = IndexNow-only (non-HTML, e.g. llms.txt); excluded from Google + inspection. */
  indexnow_only?: number | null;
}

export function getUrlState(url: string, siteId: string): UrlState | null {
  return (getDb().prepare('SELECT * FROM url_state WHERE url = ? AND site_id = ?').get(url, siteId) as UrlState | undefined) ?? null;
}

export function upsertUrlState(state: Partial<UrlState> & { url: string; site_id: string }): void {
  const db = getDb();
  const existing = getUrlState(state.url, state.site_id);
  if (!existing) {
    db.prepare(`
      INSERT INTO url_state(url, site_id, last_submitted, last_seen_lastmod, submission_count, google_submitted, indexnow_submitted, indexnow_only)
      VALUES(@url, @site_id, @last_submitted, @last_seen_lastmod, @submission_count, @google_submitted, @indexnow_submitted, @indexnow_only)
    `).run({
      last_submitted: null,
      last_seen_lastmod: null,
      submission_count: 0,
      google_submitted: 0,
      indexnow_submitted: 0,
      indexnow_only: 0,
      ...state
    });
  } else {
    const updates = Object.entries(state)
      .filter(([k]) => k !== 'url' && k !== 'site_id')
      .map(([k]) => `${k} = @${k}`)
      .join(', ');
    db.prepare(`UPDATE url_state SET ${updates} WHERE url = @url AND site_id = @site_id`).run(state);
  }
}

export function getUrlsBySite(siteId: string): UrlState[] {
  return getDb().prepare('SELECT * FROM url_state WHERE site_id = ?').all(siteId) as UrlState[];
}

// ── Log helpers ───────────────────────────────────────────────────────────────

export interface LogEntry {
  id?: number;
  run_id: string;
  level: 'info' | 'ok' | 'warn' | 'error' | 'dim';
  message: string;
  site_id?: string;
  url?: string;
  created_at?: string;
}

/**
 * Prune old run logs so the SQLite file stays bounded on long-lived installs.
 * Keeps 30 days; called at startup and once per scheduler day-roll.
 */
export function pruneOldLogs(days = 30): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const res = getDb().prepare('DELETE FROM run_logs WHERE created_at < ?').run(cutoff);
  return res.changes;
}

export function insertLog(entry: LogEntry): void {
  getDb().prepare(`
    INSERT INTO run_logs(run_id, level, message, site_id, url)
    VALUES(@run_id, @level, @message, @site_id, @url)
  `).run({
    site_id: null,
    url: null,
    ...entry
  });
}

export function getLogsForRun(runId: string): LogEntry[] {
  return getDb().prepare('SELECT * FROM run_logs WHERE run_id = ? ORDER BY id').all(runId) as LogEntry[];
}

export function getRecentLogs(limit = 200): LogEntry[] {
  return getDb().prepare('SELECT * FROM run_logs ORDER BY id DESC LIMIT ?').all(limit) as LogEntry[];
}

// ── Run history helpers ────────────────────────────────────────────────────────

export interface RunRecord {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'completed' | 'failed';
  total_submitted: number;
  total_skipped: number;
  total_failed: number;
  trigger: 'manual' | 'scheduled';
}

export function insertRun(run: RunRecord): void {
  getDb().prepare(`
    INSERT INTO run_history(id, started_at, status, total_submitted, total_skipped, total_failed, trigger)
    VALUES(@id, @started_at, @status, @total_submitted, @total_skipped, @total_failed, @trigger)
  `).run(run);
}

export function updateRun(id: string, updates: Partial<RunRecord>): void {
  const sets = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  getDb().prepare(`UPDATE run_history SET ${sets} WHERE id = @id`).run({ id, ...updates });
}

export function getRecentRuns(limit = 20): RunRecord[] {
  return getDb().prepare('SELECT * FROM run_history ORDER BY started_at DESC LIMIT ?').all(limit) as RunRecord[];
}

// ── IndexNow key helpers ───────────────────────────────────────────────────────

export interface IndexNowKey {
  site_id: string;
  key_value: string;
  verified: number;
  created_at: string;
}

export function getIndexNowKey(siteId: string): IndexNowKey | null {
  return (getDb().prepare('SELECT * FROM indexnow_keys WHERE site_id = ?').get(siteId) as IndexNowKey | undefined) ?? null;
}

export function upsertIndexNowKey(siteId: string, keyValue: string, verified = false): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO indexnow_keys(site_id, key_value, verified)
    VALUES(?, ?, ?)
  `).run(siteId, keyValue, verified ? 1 : 0);
}

export function markIndexNowKeyVerified(siteId: string): void {
  getDb().prepare('UPDATE indexnow_keys SET verified = 1 WHERE site_id = ?').run(siteId);
}

// ── Google Accounts Helpers ───────────────────────────────────────────────────

export interface GoogleAccount {
  id: string;
  email: string | null;
  client_id: string;
  client_secret: string;
  access_token: string | null;
  refresh_token: string;
  token_expiry: string | null;
  workspace_id?: string | null;
  created_at?: string;
}

export function getAllGoogleAccounts(): GoogleAccount[] {
  return getDb().prepare('SELECT * FROM google_accounts ORDER BY created_at').all() as GoogleAccount[];
}

/** Google accounts belonging to one workspace (the tenant boundary). */
export function getGoogleAccountsForWorkspace(workspaceId: string): GoogleAccount[] {
  return getDb().prepare('SELECT * FROM google_accounts WHERE workspace_id = ? ORDER BY created_at').all(workspaceId) as GoogleAccount[];
}

export function getGoogleAccountById(id: string): GoogleAccount | null {
  return (getDb().prepare('SELECT * FROM google_accounts WHERE id = ?').get(id) as GoogleAccount | undefined) ?? null;
}

export function getGoogleAccountByEmail(email: string): GoogleAccount | null {
  return (getDb().prepare('SELECT * FROM google_accounts WHERE email = ?').get(email) as GoogleAccount | undefined) ?? null;
}

/** Assign (or move) a Google account to a workspace. */
export function setGoogleAccountWorkspace(id: string, workspaceId: string): void {
  getDb().prepare('UPDATE google_accounts SET workspace_id = ? WHERE id = ?').run(workspaceId, id);
}

export function upsertGoogleAccount(acc: GoogleAccount): void {
  // IMPORTANT: use a real UPSERT, not INSERT OR REPLACE.
  // INSERT OR REPLACE deletes the existing row and inserts a new one, which —
  // with `PRAGMA foreign_keys = ON` and `sites.google_account_id ... ON DELETE
  // SET NULL` — cascades and unlinks EVERY site from this account. Because a
  // token refresh upserts the account roughly hourly, that silently nulled out
  // site→account links a few hours after connecting. ON CONFLICT...DO UPDATE
  // mutates the row in place, so the foreign key (and the site links) survive.
  //
  // workspace_id is set on first insert and preserved across refreshes: the
  // COALESCE keeps the existing workspace if the caller omits it (token
  // refreshes don't carry a workspace), while still allowing a first
  // assignment when the row had none.
  getDb().prepare(`
    INSERT INTO google_accounts (id, email, client_id, client_secret, access_token, refresh_token, token_expiry, workspace_id)
    VALUES(@id, @email, @client_id, @client_secret, @access_token, @refresh_token, @token_expiry, @workspace_id)
    ON CONFLICT(id) DO UPDATE SET
      email         = excluded.email,
      client_id     = excluded.client_id,
      client_secret = excluded.client_secret,
      access_token  = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_expiry  = excluded.token_expiry,
      workspace_id  = COALESCE(google_accounts.workspace_id, excluded.workspace_id)
  `).run({ workspace_id: null, ...acc });
}

export function deleteGoogleAccount(id: string): void {
  getDb().prepare('DELETE FROM google_accounts WHERE id = ?').run(id);
}

// ── API Quota Tracking ────────────────────────────────────────────────────────

export function todayKey(d: Date = new Date()): string {
  // UTC day key — Google quotas reset at midnight Pacific but UTC is close
  // enough for "today" semantics in the UI.
  return d.toISOString().slice(0, 10);
}

export interface QuotaRow {
  day: string;
  api: string;
  bucket: string;
  count: number;
  updated_at: string;
}

/** Increment a usage counter; returns the new value. */
export function incrementQuota(api: string, bucket: string, by = 1, day: string = todayKey()): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO api_quota_usage(day, api, bucket, count, updated_at)
    VALUES(?, ?, ?, ?, datetime('now'))
    ON CONFLICT(day, api, bucket) DO UPDATE SET
      count = api_quota_usage.count + excluded.count,
      updated_at = datetime('now')
  `).run(day, api, bucket, by);
  const row = db.prepare('SELECT count FROM api_quota_usage WHERE day = ? AND api = ? AND bucket = ?')
    .get(day, api, bucket) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getQuotaUsage(api: string, bucket: string, day: string = todayKey()): number {
  const row = getDb().prepare('SELECT count FROM api_quota_usage WHERE day = ? AND api = ? AND bucket = ?')
    .get(day, api, bucket) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getAllQuotaUsageForDay(day: string = todayKey()): QuotaRow[] {
  return getDb().prepare('SELECT * FROM api_quota_usage WHERE day = ?').all(day) as QuotaRow[];
}

/** Keep last 90 days only, run on boot / nightly */
export function pruneOldQuotaUsage(days = 90): void {
  getDb().prepare(`DELETE FROM api_quota_usage WHERE day < date('now', ?)`).run(`-${days} days`);
}

// ── Per-URL Failure Tracking ──────────────────────────────────────────────────

export interface UrlFailure {
  url: string;
  site_id: string;
  api: string;
  fail_count: number;
  last_failed_at: string;
  first_failed_at: string;
}

export function recordUrlFailure(url: string, siteId: string, api: string): void {
  getDb().prepare(`
    INSERT INTO url_failures(url, site_id, api, fail_count, last_failed_at, first_failed_at)
    VALUES(?, ?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(url, site_id, api) DO UPDATE SET
      fail_count = url_failures.fail_count + 1,
      last_failed_at = datetime('now')
  `).run(url, siteId, api);
}

export function clearUrlFailure(url: string, siteId: string, api: string): void {
  getDb().prepare('DELETE FROM url_failures WHERE url = ? AND site_id = ? AND api = ?')
    .run(url, siteId, api);
}

/**
 * Returns the set of URLs that have failed `>= threshold` times for the given
 * `api` and whose last failure was within the last `recencyDays` days.
 * Such URLs are dropped from the next round of submissions to save quota.
 */
export function getRecentlyBackedOffUrls(api: string, threshold = 3, recencyDays = 30): Set<string> {
  const rows = getDb().prepare(`
    SELECT url || '::' || site_id AS key
    FROM url_failures
    WHERE api = ? AND fail_count >= ? AND last_failed_at >= datetime('now', ?)
  `).all(api, threshold, `-${recencyDays} days`) as { key: string }[];
  return new Set(rows.map(r => r.key));
}

export function getAllUrlFailures(): UrlFailure[] {
  return getDb().prepare('SELECT * FROM url_failures ORDER BY last_failed_at DESC').all() as UrlFailure[];
}

// ── Run Lock with TTL ─────────────────────────────────────────────────────────

const RUN_LOCK_KEY = 'run_lock';
const RUN_LOCK_TTL_MS = 60 * 60 * 1000; // 60 min — much longer than any real run

export interface RunLock {
  runId: string;
  pid: number;
  acquiredAt: string;
}

export function acquireRunLock(runId: string): boolean {
  const existing = getSetting(RUN_LOCK_KEY);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as RunLock;
      const age = Date.now() - new Date(parsed.acquiredAt).getTime();
      if (age < RUN_LOCK_TTL_MS) return false;
      // Stale lock — overwrite
    } catch { /* corrupt lock — overwrite */ }
  }
  setSetting(RUN_LOCK_KEY, JSON.stringify({
    runId, pid: process.pid, acquiredAt: new Date().toISOString()
  } satisfies RunLock));
  return true;
}

export function releaseRunLock(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(RUN_LOCK_KEY);
}

export function getRunLock(): RunLock | null {
  const raw = getSetting(RUN_LOCK_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RunLock;
    const age = Date.now() - new Date(parsed.acquiredAt).getTime();
    if (age >= RUN_LOCK_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

