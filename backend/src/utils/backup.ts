/**
 * backup.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Nightly SQLite backup using `VACUUM INTO` (atomic, hot-backup safe).
 *
 * - Stores backups at ${DATA_DIR}/backups/indexer-YYYY-MM-DD.db
 * - Keeps the most recent N (default 7) and prunes the rest.
 * - Skips if a backup for today's date already exists.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { getDb, todayKey } from '../db/database.js';
import { logSystem } from './logger.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_BACKUPS = parseInt(process.env.BACKUP_KEEP ?? '7', 10);

export function backupNow(): { path: string; bytes: number; skipped?: boolean } {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const date = todayKey();
  const out  = path.join(BACKUP_DIR, `indexer-${date}.db`);

  if (fs.existsSync(out)) {
    return { path: out, bytes: fs.statSync(out).size, skipped: true };
  }

  const db = getDb();
  // VACUUM INTO is safe to run concurrently with reads/writes.
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  const bytes = fs.statSync(out).size;
  pruneOldBackups();
  return { path: out, bytes };
}

export function pruneOldBackups(): number {
  if (!fs.existsSync(BACKUP_DIR)) return 0;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('indexer-') && f.endsWith('.db'))
    .map(f => ({ name: f, path: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const toDelete = files.slice(KEEP_BACKUPS);
  for (const f of toDelete) {
    try { fs.unlinkSync(f.path); } catch { /* ignore */ }
  }
  return toDelete.length;
}

export function listBackups(): Array<{ name: string; bytes: number; mtime: string }> {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('indexer-') && f.endsWith('.db'))
    .map(f => {
      const p = path.join(BACKUP_DIR, f);
      const st = fs.statSync(p);
      return { name: f, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

let _scheduled: cron.ScheduledTask | null = null;

export function startBackupScheduler(): void {
  if (_scheduled) { _scheduled.stop(); _scheduled = null; }
  // 02:30 daily (before the 03:00 indexing run)
  _scheduled = cron.schedule('30 2 * * *', () => {
    try {
      const r = backupNow();
      if (r.skipped) {
        logSystem('info', `Backup skipped — today's backup already exists (${r.path})`);
      } else {
        logSystem('ok', `Backup created: ${path.basename(r.path)} (${Math.round(r.bytes / 1024)} KB)`);
      }
    } catch (e) {
      logSystem('error', `Backup failed: ${String(e)}`);
    }
  });
  console.log('[backup] Scheduler started (02:30 daily, keep last ' + KEEP_BACKUPS + ')');
}

export function stopBackupScheduler(): void {
  if (_scheduled) { _scheduled.stop(); _scheduled = null; }
}
