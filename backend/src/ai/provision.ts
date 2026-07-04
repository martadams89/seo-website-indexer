/**
 * One-click Gemini key provisioning — uses the user's already-linked Google
 * account (OAuth) to enable the Generative Language API on their configured
 * GCP project and mint an API key restricted to that service. The key lands
 * straight in settings; the user never leaves the dashboard.
 *
 * Requires the cloud-platform OAuth scope: accounts linked before that scope
 * was added must be re-linked once (surfaced as a friendly error).
 */
import { effectiveSetting, setSetting, setWorkspaceSetting } from '../db/database.js';
import { getAccessTokenForAccount } from '../auth/google-oauth.js';
import { logSystem } from '../utils/logger.js';

const GEMINI_SERVICE = 'generativelanguage.googleapis.com';

class RelinkNeededError extends Error {
  needsRelink = true;
  constructor() {
    super('Google account lacks Cloud permissions. Re-link the account (Accounts page) to grant the new scope, then retry.');
  }
}

async function gcall<T>(token: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 403) throw new RelinkNeededError();
  if (!res.ok) throw new Error(`${new URL(url).hostname} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

/**
 * The OAuth client id encodes its project number ("123456789-abc.apps.…"),
 * and Google resource paths accept project numbers interchangeably with
 * project ids — so a linked account is enough; no separate setting needed.
 */
function deriveProjectNumber(clientId: string | null | undefined): string | null {
  const m = /^(\d{6,})-/.exec(clientId ?? '');
  return m ? m[1] : null;
}

export async function provisionGeminiKey(accountId: string, clientId?: string | null, workspaceId: string | null = null): Promise<{ ok: true; project: string } | { ok: false; error: string; needsRelink?: boolean }> {
  const project = effectiveSetting(workspaceId, 'google_project_id') || deriveProjectNumber(clientId);
  if (!project) {
    return { ok: false, error: 'Could not determine your Google Cloud project — set "Google Cloud project ID" in Settings (the project that owns your OAuth client).' };
  }

  try {
    const token = await getAccessTokenForAccount(accountId);

    // 1) Enable the Generative Language API on the project (idempotent).
    await gcall(token, `https://serviceusage.googleapis.com/v1/projects/${project}/services/${GEMINI_SERVICE}:enable`, {});

    // 2) Mint an API key restricted to that one service.
    const op = await gcall<{ name: string; done?: boolean; response?: { keyString?: string } }>(
      token,
      `https://apikeys.googleapis.com/v2/projects/${project}/locations/global/keys`,
      {
        displayName: 'SEO Website Indexer — Gemini (auto-provisioned)',
        restrictions: { apiTargets: [{ service: GEMINI_SERVICE }] },
      }
    );

    // 3) Poll the long-running operation for the key string (usually <5s).
    let keyString = op.response?.keyString;
    for (let i = 0; i < 10 && !keyString; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const poll = await gcall<{ done?: boolean; response?: { keyString?: string } }>(
        token, `https://apikeys.googleapis.com/v2/${op.name}`
      );
      if (poll.done) keyString = poll.response?.keyString;
    }
    if (!keyString) return { ok: false, error: 'Key creation did not complete in time — check the Google Cloud console and retry.' };

    // Save into the workspace's override when provisioned from a workspace, else
    // as the platform default.
    if (workspaceId) setWorkspaceSetting(workspaceId, 'gemini_api_key', keyString);
    else setSetting('gemini_api_key', keyString);
    logSystem('ok', `Gemini API key provisioned on project ${project} and saved.`);
    return { ok: true, project };
  } catch (e) {
    if (e instanceof RelinkNeededError) return { ok: false, error: e.message, needsRelink: true };
    const msg = e instanceof Error ? e.message : String(e);
    logSystem('warn', `Gemini key provisioning failed: ${msg.slice(0, 160)}`);
    return { ok: false, error: msg };
  }
}
