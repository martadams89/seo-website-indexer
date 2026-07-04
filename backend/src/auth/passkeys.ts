/**
 * Passkeys (WebAuthn / FIDO2) — passwordless login and a second factor, built
 * on @simplewebauthn/server. Credentials live in the `passkeys` table; the
 * public key is stored base64url-encoded, the signature counter is bumped on
 * every successful assertion (clone-detection).
 *
 * The relying-party id (rpID) and origin are derived per-request from the host
 * so the same build works on localhost and any deployed domain without config.
 * Challenges are short-lived and kept in-memory (single-process app).
 */
import { randomUUID } from 'crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { getDb } from '../db/database.js';
import { getUserById, type User } from './users.js';

const RP_NAME = 'SEO Website Indexer';

interface PasskeyRow {
  id: string; user_id: string; public_key: string; counter: number;
  transports: string | null; name: string | null; created_at: string;
}
export interface PublicPasskey { id: string; name: string | null; created_at: string }

function u8ToB64url(u: Uint8Array): string { return Buffer.from(u).toString('base64url'); }
function b64urlToU8(s: string): Uint8Array<ArrayBuffer> {
  // Copy into a freshly-allocated (plain ArrayBuffer-backed) Uint8Array so the
  // type is Uint8Array<ArrayBuffer>, which the WebAuthn verifier expects.
  const buf = Buffer.from(s, 'base64url');
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

export function listPasskeys(userId: string): PublicPasskey[] {
  return getDb().prepare('SELECT id, name, created_at FROM passkeys WHERE user_id = ? ORDER BY created_at')
    .all(userId) as PublicPasskey[];
}

export function deletePasskey(userId: string, id: string): boolean {
  const info = getDb().prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes > 0;
}

function credentialsForUser(userId: string): PasskeyRow[] {
  return getDb().prepare('SELECT * FROM passkeys WHERE user_id = ?').all(userId) as PasskeyRow[];
}

// ── Challenge store (short-lived, in-memory) ─────────────────────────────────
interface Challenge { challenge: string; userId?: string; expires: number }
const _challenges = new Map<string, Challenge>();
const CHALLENGE_TTL_MS = 5 * 60_000;
function putChallenge(challenge: string, userId?: string): string {
  const id = randomUUID();
  _challenges.set(id, { challenge, userId, expires: Date.now() + CHALLENGE_TTL_MS });
  return id;
}
function takeChallenge(id: string): Challenge | undefined {
  const c = _challenges.get(id);
  _challenges.delete(id);
  if (!c || c.expires < Date.now()) return undefined;
  return c;
}
// Opportunistic sweep so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _challenges) if (v.expires < now) _challenges.delete(k);
}, CHALLENGE_TTL_MS).unref?.();

// ── Registration ─────────────────────────────────────────────────────────────

export async function beginRegistration(user: User, rpID: string): Promise<PublicKeyCredentialCreationOptionsJSON & { challengeId: string }> {
  const existing = credentialsForUser(user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.email,
    userDisplayName: user.name || user.email,
    userID: new Uint8Array(Buffer.from(user.id)),
    attestationType: 'none',
    excludeCredentials: existing.map(c => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  const challengeId = putChallenge(options.challenge, user.id);
  return { ...options, challengeId };
}

export async function finishRegistration(
  user: User, challengeId: string, name: string | undefined,
  response: RegistrationResponseJSON, rpID: string, origin: string,
): Promise<boolean> {
  const stored = takeChallenge(challengeId);
  if (!stored || stored.userId !== user.id) throw new Error('Registration challenge expired — try again.');
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response, expectedChallenge: stored.challenge, expectedOrigin: origin, expectedRPID: rpID,
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'Passkey registration failed verification.');
  }
  if (!verification.verified || !verification.registrationInfo) return false;
  const { credential } = verification.registrationInfo;
  getDb().prepare('INSERT INTO passkeys(id, user_id, public_key, counter, transports, name) VALUES(?,?,?,?,?,?)')
    .run(
      credential.id,
      user.id,
      u8ToB64url(credential.publicKey),
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      name?.trim() || 'Passkey',
    );
  return true;
}

// ── Authentication ───────────────────────────────────────────────────────────

export async function beginAuthentication(rpID: string, email?: string): Promise<PublicKeyCredentialRequestOptionsJSON & { challengeId: string }> {
  // If an email is given we can scope allowCredentials; otherwise rely on
  // discoverable credentials (resident keys) so the browser offers any passkey.
  let allow: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }> | undefined;
  if (email) {
    const user = getDb().prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase()) as { id: string } | undefined;
    if (user) {
      allow = credentialsForUser(user.id).map(c => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined }));
    }
  }
  const options = await generateAuthenticationOptions({ rpID, allowCredentials: allow, userVerification: 'preferred' });
  const challengeId = putChallenge(options.challenge);
  return { ...options, challengeId };
}

/** Verifies an assertion and returns the authenticated user, or null. */
export async function finishAuthentication(
  challengeId: string, response: AuthenticationResponseJSON, rpID: string, origin: string,
): Promise<User | null> {
  const stored = takeChallenge(challengeId);
  if (!stored) throw new Error('Login challenge expired — try again.');
  const row = getDb().prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id) as PasskeyRow | undefined;
  if (!row) throw new Error('Unknown passkey.');
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: row.id,
        publicKey: b64urlToU8(row.public_key),
        counter: row.counter,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      },
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'Passkey verification failed.');
  }
  if (!verification.verified) return null;
  getDb().prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(verification.authenticationInfo.newCounter, row.id);
  return getUserById(row.user_id) ?? null;
}
