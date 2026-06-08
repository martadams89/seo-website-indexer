/**
 * crypto.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AES-256-GCM encryption for sensitive fields stored at rest (FTP passwords).
 *
 * Key strategy:
 *  - Reads APP_SECRET from env (production).
 *  - Otherwise auto-generates and persists `${DATA_DIR}/.key` on first boot.
 *  - Ciphertext envelope: `enc:v1:<iv_b64>:<tag_b64>:<data_b64>`.
 *  - Plaintext values are returned unchanged for backwards compatibility, so
 *    existing rows continue to decrypt safely until they are next written.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const KEY_FILE = path.join(DATA_DIR, '.key');
const VERSION  = 'enc:v1:';

let _key: Buffer | null = null;

function loadKey(): Buffer {
  if (_key) return _key;

  const envSecret = process.env.APP_SECRET;
  if (envSecret && envSecret.length >= 16) {
    _key = crypto.createHash('sha256').update(envSecret).digest();
    return _key;
  }

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (fs.existsSync(KEY_FILE)) {
    _key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    if (_key.length !== 32) {
      throw new Error(`Invalid app key in ${KEY_FILE}. Delete the file to regenerate.`);
    }
    return _key;
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, generated.toString('hex'), { mode: 0o600 });
  _key = generated;
  return _key;
}

export function encrypt(plain: string | null | undefined): string | null {
  if (plain == null || plain === '') return null;
  if (typeof plain === 'string' && plain.startsWith(VERSION)) return plain;
  const key = loadKey();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !value.startsWith(VERSION)) {
    // Legacy plaintext value — return as-is. Will be re-encrypted on next write.
    return value;
  }
  try {
    const [, , ivB64, tagB64, dataB64] = value.split(':');
    const key = loadKey();
    const iv  = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(VERSION);
}
