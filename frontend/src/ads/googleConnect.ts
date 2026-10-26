// Google sign-in for every connection flow: new connections, reconnects, added
// scopes and the one-off API switch-on.
//
// Browsers only allow a pop-up opened directly by the click, so the window
// opens straight away and is pointed at Google once the server has built the
// sign-in link. If pop-ups are blocked anyway, the sign-in continues in this
// tab and Google's callback brings the person back here. Google always shows
// its account chooser (the server never sends a login hint), so with several
// Google accounts signed in you pick the one you mean every time.
import { useEffect } from 'react';
import { api } from '../api';
import { apiFetch } from '../api/client';

const POPUP_FEATURES = () => {
  const width = 600;
  const height = 720;
  return `width=${width},height=${height},left=${window.screen.width / 2 - width / 2},top=${window.screen.height / 2 - height / 2},status=no,resizable=yes,scrollbars=yes`;
};

/** Where to come back to when the sign-in has to run in this tab. */
const here = () => `${window.location.pathname}${window.location.search}`;

/**
 * Open a Google sign-in window during the click, then load `getUrl()` into it.
 * Returns 'redirect' when pop-ups are blocked and this tab is going to Google.
 */
export async function openGoogleWindow(name: string, getUrl: () => Promise<string>, note = 'Opening Google…'): Promise<'popup' | 'redirect'> {
  // Must run before any await, or the browser no longer sees it as the click's pop-up.
  const popup = window.open('', name, POPUP_FEATURES());
  if (popup) {
    try {
      popup.document.title = 'Google sign-in';
      popup.document.body.style.cssText = 'font:14px system-ui,sans-serif;background:#12131a;color:#e2e8f0;display:grid;place-items:center;height:90vh;margin:0';
      popup.document.body.textContent = note;
    } catch { /* another origin already loaded in this named window */ }
  }
  let url: string;
  try { url = await getUrl(); }
  catch (e) { popup?.close(); throw e; }
  if (popup && !popup.closed) {
    popup.location.href = url;
    popup.focus();
    return 'popup';
  }
  window.location.assign(url);
  return 'redirect';
}

export async function openGoogleConsent(options: {
  accountId?: string; clientId?: string; clientSecret?: string; autoSetup?: boolean; ads?: boolean; business?: boolean;
  /** A name for a newly entered OAuth client, saved with it (e.g. 'Ads – Basic access'). */
  clientLabel?: string;
  /** Limit the grant to these products; [] asks for a full connection. */
  only?: Array<'ads' | 'business'>;
  /** Sign a new Google user in through the OAuth client this existing connection uses. */
  projectFrom?: string;
  /** Shown while Google loads, e.g. which account to choose on a reconnect. */
  note?: string;
}): Promise<'popup' | 'redirect'> {
  const { note, ...body } = options;
  return openGoogleWindow('google-auth', async () => (await api.beginGoogleAuth({ ...body, returnTo: here() })).authorizationUrl,
    note ?? 'Opening Google… choose the Google account to connect on the next screen.');
}

/**
 * Switch on the Google APIs a connection needs with a one-off sign-in. The
 * Cloud permission it asks for is used once and not kept, so the saved
 * connection doesn't fall under Workspace Google Cloud session control (which
 * would expire it every few hours).
 */
export async function openApiEnable(accountId: string, services?: string[]): Promise<string[]> {
  let enabling: string[] = services ?? [];
  await openGoogleWindow('google-enable-apis', async () => {
    const started = await apiFetch<{ authorizationUrl: string; services: string[] }>('/api/auth/google/enable-apis/start', { method: 'POST', body: JSON.stringify({ accountId, services, returnTo: here() }) });
    enabling = started.services;
    return started.authorizationUrl;
  }, 'Opening Google… choose a Google account that can manage this Cloud project.');
  return enabling;
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
