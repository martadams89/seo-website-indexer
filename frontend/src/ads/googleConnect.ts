// Open Google's consent screen in a popup. Used for new connections and to add
// scopes (e.g. Google Ads) to an existing one without disconnecting it.
import { useEffect } from 'react';
import { api } from '../api';

export async function openGoogleConsent(options: { accountId?: string; clientId?: string; clientSecret?: string; autoSetup?: boolean; ads?: boolean; business?: boolean }): Promise<void> {
  const { authorizationUrl } = await api.beginGoogleAuth(options);
  const width = 600;
  const height = 700;
  const left = window.screen.width / 2 - width / 2;
  const top = window.screen.height / 2 - height / 2;
  const popup = window.open(authorizationUrl, 'google-auth', `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes,scrollbars=yes`);
  if (!popup) throw new Error('Your browser blocked the Google sign-in popup. Allow popups for this site and try again.');
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
