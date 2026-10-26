// Open Google's consent screen in a popup. Used for new connections and to add
// scopes (e.g. Google Ads) to an existing one without disconnecting it.
import { useEffect } from 'react';
import { api } from '../api';
import { apiFetch } from '../api/client';

export async function openGoogleConsent(options: {
  accountId?: string; clientId?: string; clientSecret?: string; autoSetup?: boolean; ads?: boolean; business?: boolean;
  /** Limit the grant to these products; [] asks for a full connection. */
  only?: Array<'ads' | 'business'>;
  /** Sign a new Google user in through the OAuth client this existing connection uses. */
  projectFrom?: string;
}): Promise<void> {
  const { authorizationUrl } = await api.beginGoogleAuth(options);
  const width = 600;
  const height = 700;
  const left = window.screen.width / 2 - width / 2;
  const top = window.screen.height / 2 - height / 2;
  const popup = window.open(authorizationUrl, 'google-auth', `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes,scrollbars=yes`);
  if (!popup) throw new Error('Your browser blocked the Google sign-in popup. Allow popups for this site and try again.');
}

/**
 * Switch on the Google APIs a connection needs with a one-off sign-in. The
 * Cloud permission it asks for is used once and not kept, so the saved
 * connection doesn't fall under Workspace Google Cloud session control (which
 * would expire it every few hours).
 */
export async function openApiEnable(accountId: string, services?: string[]): Promise<string[]> {
  const started = await apiFetch<{ authorizationUrl: string; services: string[] }>('/api/auth/google/enable-apis/start', { method: 'POST', body: JSON.stringify({ accountId, services }) });
  const { authorizationUrl } = started;
  const width = 600;
  const height = 700;
  const popup = window.open(authorizationUrl, 'google-enable-apis', `width=${width},height=${height},left=${window.screen.width / 2 - width / 2},top=${window.screen.height / 2 - height / 2},status=no,resizable=yes,scrollbars=yes`);
  if (!popup) throw new Error('Your browser blocked the Google sign-in popup. Allow popups for this site and try again.');
  return started.services;
}

/** Run `onDone` when the one-off API enable popup reports back. */
export function useApisEnabled(onDone: (result: { ok: boolean; enabled: string[]; skipped: string[] }) => void): void {
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data?.type === 'GOOGLE_APIS_ENABLED') onDone(event.data);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onDone]);
}

/** Run `onSuccess` when the OAuth callback popup reports a completed connection. */
export function useGoogleAuthSuccess(onSuccess: () => void): void {
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data?.type === 'GOOGLE_AUTH_SUCCESS') onSuccess();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onSuccess]);
}
