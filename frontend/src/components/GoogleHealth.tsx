// GoogleHealth — what each Google connection still needs, with a fix for each.
//
// Google never grants a new permission silently, so a connection that's now
// used for Ads or Business Profile needs one consent click. Switched-off APIs
// are turned on with a one-off sign-in that keeps no Cloud access, so the saved
// connection stays clear of Workspace session control and keeps refreshing.
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, KeyRound, RefreshCw, ShieldAlert, Zap } from 'lucide-react';
import { apiFetch } from '../api/client';
import { openApiEnable, openGoogleConsent, useApisEnabled, useGoogleAuthSuccess } from '../ads/googleConnect';

export interface ConnectionHealth {
  id: string;
  email: string | null;
  project: string | null;
  status: 'ok' | 'attention' | 'reconnect';
  needs_reauth: boolean;
  missing_scopes: Array<{ scope: string; label: string; reason: string }>;
  reconnect_with: { ads: boolean; business: boolean };
  disabled_apis: Array<{ service: string; label: string }>;
  cloud_scope: boolean;
  refresh_token_expiry: string | null;
  apis_checked_at: string | null;
}

const consoleLink = (service: string, project: string | null) =>
  `https://console.cloud.google.com/apis/library/${service}${project ? `?project=${project}` : ''}`;

export function GoogleHealth({ canManage, onChanged }: { canManage: boolean; onChanged?: () => void }) {
  const [health, setHealth] = useState<ConnectionHealth[] | null>(null);
  const [busy, setBusy] = useState<string | null>('check');
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);

  const load = useCallback((fresh = false) =>
    apiFetch<ConnectionHealth[]>(`/api/auth/google/health?probe=1${fresh ? '&fresh=1' : ''}`)
      .then(setHealth)
      .catch(e => setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(b => (b === 'check' ? null : b))), []);

  useEffect(() => { load(); }, [load]);

  useGoogleAuthSuccess(useCallback(() => { load(true); onChanged?.(); }, [load, onChanged]));
  useApisEnabled(useCallback(result => {
    setMessage(result.ok
      ? { tone: 'ok', text: `Switched on ${result.enabled.length} Google API${result.enabled.length === 1 ? '' : 's'}. Google can take a few minutes to apply it.` }
      : { tone: 'warn', text: `Couldn't switch on: ${result.skipped.join(', ') || 'some APIs'}. Use the Cloud console links below, or ask a project Owner.` });
    load(true);
  }, [load]));

  async function updatePermissions(h: ConnectionHealth) {
    setMessage(null);
    setBusy(`scopes:${h.id}`);
    try { await openGoogleConsent({ accountId: h.id, ads: h.reconnect_with.ads, business: h.reconnect_with.business }); }
    catch (e) { setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) }); }
    setBusy(null);
  }

  async function enableApis(h: ConnectionHealth) {
    setMessage(null);
    setBusy(`apis:${h.id}`);
    try { await openApiEnable(h.id); }
    catch (e) { setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) }); }
    setBusy(null);
  }

  const issues = (health ?? []).filter(h => !h.needs_reauth && (h.missing_scopes.length || h.disabled_apis.length));
  if (!health || (!issues.length && !message)) return null;

  return (
    <div className="card mb-4 google-health" style={{ border: issues.length ? '1px solid var(--warn)' : undefined }}>
      <div className="flex items-center justify-between mb-2">
        <h2 style={{ fontWeight: 700, fontSize: 16, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldAlert size={16} style={{ color: 'var(--warn)' }} /> Connection checks
        </h2>
        <button className="btn btn-ghost btn-sm" disabled={busy === 'check'} onClick={() => { setBusy('check'); load(true); }}>
          <RefreshCw size={13} /> {busy === 'check' ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {message && <div className={`alert alert-${message.tone} mb-3`}><div className="alert-content">{message.text}</div></div>}
      {issues.map(h => (
        <div key={h.id} className="p-3 mb-2" style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-input)' }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{h.email ?? 'Google connection'}{h.project && <span className="text-dim" style={{ fontWeight: 400, fontSize: 12 }}> · project {h.project}</span>}</div>

          {h.missing_scopes.length > 0 && (
            <div className="mt-2">
              <div style={{ fontSize: 13 }}>Google hasn't granted these permissions yet:</div>
              <ul style={{ margin: '4px 0 8px 18px', fontSize: 12 }}>
                {h.missing_scopes.map(m => <li key={m.scope}><strong>{m.label}</strong> — {m.reason}</li>)}
              </ul>
              <button className="btn btn-primary btn-sm" disabled={!canManage || busy === `scopes:${h.id}`} onClick={() => updatePermissions(h)}>
                <KeyRound size={13} /> {busy === `scopes:${h.id}` ? 'Opening Google…' : 'Update permissions'}
              </button>
              <div className="text-dim mt-1" style={{ fontSize: 12 }}>
                Opens Google's consent screen for this account. It keeps the permissions it already has and adds the missing ones; nothing is disconnected.
              </div>
            </div>
          )}

          {h.disabled_apis.length > 0 && (
            <div className="mt-2">
              <div style={{ fontSize: 13 }}>These Google APIs are switched off on {h.project ? `project ${h.project}` : 'the OAuth client\'s project'}:</div>
              <ul style={{ margin: '4px 0 8px 18px', fontSize: 12 }}>
                {h.disabled_apis.map(a => (
                  <li key={a.service}>{a.label} <a href={consoleLink(a.service, h.project)} target="_blank" rel="noopener noreferrer">Enable in Cloud console <ExternalLink size={10} /></a></li>
                ))}
              </ul>
              <button className="btn btn-secondary btn-sm" disabled={!canManage || busy === `apis:${h.id}`} onClick={() => enableApis(h)}>
                <Zap size={13} /> {busy === `apis:${h.id}` ? 'Opening Google…' : 'Switch them on for me'}
              </button>
              <div className="text-dim mt-1" style={{ fontSize: 12 }}>
                A one-off Google sign-in with Cloud access that's used once and not kept, so your saved connection doesn't pick up
                the Cloud permission that makes Workspace accounts expire. Needs the Service Usage Admin (or Owner/Editor) role on the project.
              </div>
            </div>
          )}
        </div>
      ))}
      {health.some(h => h.apis_checked_at) && (
        <div className="text-dim" style={{ fontSize: 12 }}>
          APIs last checked {new Date(Math.max(...health.map(h => (h.apis_checked_at ? Date.parse(h.apis_checked_at) : 0)))).toLocaleString()}.
        </div>
      )}
    </div>
  );
}
