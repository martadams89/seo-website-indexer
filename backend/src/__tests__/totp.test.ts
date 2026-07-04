import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { generateTotpSecret, verifyTotp, totpUri } from '../auth/users.js';

// Independent RFC 6238 code generator to drive the verifier (mirror of the
// module's internal HOTP), so the test proves the base32 + window handling.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32d(str: string): Buffer {
  const c = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of c) { value = (value << 5) | BASE32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function codeNow(secret: string, offsetSteps = 0): string {
  const key = b32d(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offsetSteps));
  const h = createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return (code % 1_000_000).toString().padStart(6, '0');
}

describe('TOTP', () => {
  it('generates a 32-char base32 secret', () => {
    const s = generateTotpSecret();
    expect(s).toHaveLength(32);
    expect(s).toMatch(/^[A-Z2-7]+$/);
  });

  it('accepts the current code and ±1 step of drift', () => {
    const s = generateTotpSecret();
    expect(verifyTotp(s, codeNow(s))).toBe(true);
    expect(verifyTotp(s, codeNow(s, -1))).toBe(true);
    expect(verifyTotp(s, codeNow(s, 1))).toBe(true);
  });

  it('rejects a stale code (2 steps away) and garbage', () => {
    const s = generateTotpSecret();
    expect(verifyTotp(s, codeNow(s, 2))).toBe(false);
    expect(verifyTotp(s, '000000')).toBe(false);
    expect(verifyTotp(s, 'nope')).toBe(false);
    expect(verifyTotp(s, '')).toBe(false);
  });

  it('builds a scannable otpauth URI', () => {
    const uri = totpUri('ABCDEF', 'a@b.com');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=ABCDEF');
    expect(uri).toContain('issuer=SEO');
  });
});
