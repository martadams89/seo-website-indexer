/**
 * Thin wrappers around @simplewebauthn/browser that talk to our passkey
 * endpoints. The backend returns the WebAuthn options with a `challengeId` we
 * echo back on finish so it can look up the (server-side) challenge.
 */
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { api, type CurrentUser } from '../api';

/** Register a new passkey for the signed-in user. */
export async function registerPasskey(name: string): Promise<void> {
  const options = await api.passkeyRegisterStart();
  const credential = await startRegistration({ optionsJSON: options as never });
  await api.passkeyRegisterFinish(name, options.challengeId, credential);
}

/** Sign in with a passkey. Returns the authenticated user. */
export async function loginWithPasskey(email?: string): Promise<CurrentUser> {
  const options = await api.passkeyLoginStart(email);
  const challengeId = options.challengeId;
  const credential = await startAuthentication({ optionsJSON: options as never });
  return api.passkeyLoginFinish(challengeId, credential);
}
