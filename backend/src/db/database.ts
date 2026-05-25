import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

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
    initSchema(_db);
    migrateSettingsToAccounts(_db);
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
}

export function getAllSites(): Site[] {
  return getDb().prepare('SELECT * FROM sites WHERE enabled = 1 ORDER BY created_at').all() as Site[];
}

export function getSiteById(id: string): Site | null {
  return (getDb().prepare('SELECT * FROM sites WHERE id = ?').get(id) as Site | undefined) ?? null;
}

export function upsertSite(site: Omit<Site, 'created_at'>): void {
  getDb().prepare(`
    INSERT INTO sites(id, name, domain, sitemap_url, gsc_url, enabled, google_account_id, robots_txt_status, llms_txt_status, deploy_webhook_url, ftp_host, ftp_port, ftp_user, ftp_pass, ftp_path)
    VALUES(@id, @name, @domain, @sitemap_url, @gsc_url, @enabled, @google_account_id, @robots_txt_status, @llms_txt_status, @deploy_webhook_url, @ftp_host, @ftp_port, @ftp_user, @ftp_pass, @ftp_path)
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
      ftp_path = excluded.ftp_path
  `).run({
    google_account_id: null,
    robots_txt_status: null,
    llms_txt_status: null,
    deploy_webhook_url: null,
    ftp_host: null,
    ftp_port: 21,
    ftp_user: null,
    ftp_pass: null,
    ftp_path: null,
    ...site
  });
}

export function deleteSite(id: string): void {
  getDb().prepare('DELETE FROM sites WHERE id = ?').run(id);
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
}

export function getUrlState(url: string, siteId: string): UrlState | null {
  return (getDb().prepare('SELECT * FROM url_state WHERE url = ? AND site_id = ?').get(url, siteId) as UrlState | undefined) ?? null;
}

export function upsertUrlState(state: Partial<UrlState> & { url: string; site_id: string }): void {
  const db = getDb();
  const existing = getUrlState(state.url, state.site_id);
  if (!existing) {
    db.prepare(`
      INSERT INTO url_state(url, site_id, last_submitted, last_seen_lastmod, submission_count, google_submitted, indexnow_submitted)
      VALUES(@url, @site_id, @last_submitted, @last_seen_lastmod, @submission_count, @google_submitted, @indexnow_submitted)
    `).run({
      last_submitted: null,
      last_seen_lastmod: null,
      submission_count: 0,
      google_submitted: 0,
      indexnow_submitted: 0,
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
  created_at?: string;
}

export function getAllGoogleAccounts(): GoogleAccount[] {
  return getDb().prepare('SELECT * FROM google_accounts ORDER BY created_at').all() as GoogleAccount[];
}

export function getGoogleAccountById(id: string): GoogleAccount | null {
  return (getDb().prepare('SELECT * FROM google_accounts WHERE id = ?').get(id) as GoogleAccount | undefined) ?? null;
}

export function getGoogleAccountByEmail(email: string): GoogleAccount | null {
  return (getDb().prepare('SELECT * FROM google_accounts WHERE email = ?').get(email) as GoogleAccount | undefined) ?? null;
}

export function upsertGoogleAccount(acc: GoogleAccount): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO google_accounts (id, email, client_id, client_secret, access_token, refresh_token, token_expiry)
    VALUES(@id, @email, @client_id, @client_secret, @access_token, @refresh_token, @token_expiry)
  `).run(acc);
}

export function deleteGoogleAccount(id: string): void {
  getDb().prepare('DELETE FROM google_accounts WHERE id = ?').run(id);
}
