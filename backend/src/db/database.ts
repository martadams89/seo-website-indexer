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
  }
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      domain      TEXT NOT NULL UNIQUE,
      sitemap_url TEXT NOT NULL,
      gsc_url     TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
}

export function getAllSites(): Site[] {
  return getDb().prepare('SELECT * FROM sites WHERE enabled = 1 ORDER BY created_at').all() as Site[];
}

export function getSiteById(id: string): Site | null {
  return (getDb().prepare('SELECT * FROM sites WHERE id = ?').get(id) as Site | undefined) ?? null;
}

export function upsertSite(site: Omit<Site, 'created_at'>): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO sites(id, name, domain, sitemap_url, gsc_url, enabled)
    VALUES(@id, @name, @domain, @sitemap_url, @gsc_url, @enabled)
  `).run(site);
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
