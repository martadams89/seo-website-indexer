import { useState, useEffect } from 'react';
import { ShieldCheck, Plus, Trash2, Key, Check, Copy, AlertCircle, AlertTriangle, RefreshCw, Smartphone } from 'lucide-react';
import { api, type GoogleAccount } from '../api';
import { useApp } from '../AppContext';
import { useWorkspace } from '../workspace/WorkspaceContext';

export default function AccountsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { status, refresh } = useApp();
  const { active } = useWorkspace();
  const canConnect = !!active?.permissions?.manage_integrations;
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [myAccounts, setMyAccounts] = useState<GoogleAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  // Custom Account Connection Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  // Opt-in, not default: ticking this requests the broad cloud-platform scope,
  // which makes refresh tokens for managed (Google Workspace) accounts subject
  // to reauth/session-control policies → periodic "invalid_rapt" failures. Core
  // Search Console works without it.
  const [autoSetup, setAutoSetup] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [copied, setCopied] = useState(false);

  const hasBuiltin = status?.auth?.hasBuiltinCredentials ?? false;
  const redirectUri = window.location.origin + '/api/auth/google/callback';

  async function fetchAccounts() {
    setLoading(true);
    try {
      const [data, mine] = await Promise.all([api.getAccounts(), api.getMyAccounts()]);
      setAccounts(data);
      setMyAccounts(mine);
    } catch (e) {
      setError(String(e).replace('Error: ', ''));
    }
    setLoading(false);
  }

  useEffect(() => {
    fetchAccounts();
  }, []);

  // Listen for callback postMessage
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data?.type === 'GOOGLE_AUTH_SUCCESS') {
        await refresh();
        await fetchAccounts();
        setShowAddForm(false);
        setClientId('');
        setClientSecret('');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [refresh]);

  // `reconnect` re-authorises an existing account in place: it reuses the
  // account's encrypted client id/secret through a single-use server-side OAuth
  // state, so the user never has to disconnect it or re-enter credentials.
  async function startGoogleAuth(reconnect?: GoogleAccount) {
    setConnectError('');
    if (reconnect) setReconnectingId(reconnect.id); else setConnecting(true);
    try {
      const { authorizationUrl } = await api.beginGoogleAuth(reconnect
        ? { accountId: reconnect.id, autoSetup }
        : { clientId: hasBuiltin ? undefined : clientId.trim(), clientSecret: hasBuiltin ? undefined : clientSecret.trim(), autoSetup });

      const width = 600;
      const height = 700;
      const left = window.screen.width / 2 - width / 2;
      const top = window.screen.height / 2 - height / 2;
      
      const popup = window.open(
        authorizationUrl,
        'google-auth',
        `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes,scrollbars=yes`
      );

      if (!popup) {
        throw new Error('Popup was blocked by your browser. Please allow popups for this site.');
      }
    } catch (e) {
      setConnectError(String(e).replace('Error: ', ''));
    }
    setConnecting(false);
    setReconnectingId(null);
  }

  async function disconnectAccount(id: string, email: string | null) {
    if (!confirm(`Delete Google credential ${email || id}? It will be removed from every workspace using it and linked sites will stop using it.`)) return;
    try {
      await api.disconnectAccount(id);
      await refresh();
      await fetchAccounts();
    } catch (e) {
      setError(String(e).replace('Error: ', ''));
    }
  }

  async function shareAccount(id: string) {
    try {
      await api.shareAccountWithWorkspace(id);
      await refresh();
      await fetchAccounts();
    } catch (e) { setError(String(e).replace('Error: ', '')); }
  }

  async function unshareAccount(id: string, email: string | null) {
    if (!confirm(`Remove ${email || id} from this workspace? Sites here that use it will be unlinked; the credential remains available to its owner and other workspaces.`)) return;
    try {
      await api.unshareAccountFromWorkspace(id);
      await refresh();
      await fetchAccounts();
    } catch (e) { setError(String(e).replace('Error: ', '')); }
  }

  function copyRedirectUri() {
    navigator.clipboard.writeText(redirectUri);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      {embedded ? (
        <div className="flex items-center justify-between mb-3">
          <p className="text-dim" style={{ fontSize: 12, margin: 0 }}>
            Workspace members can use shared accounts or contribute one of their own. Credentials remain owned by the person who connected them.
          </p>
          <button className="btn btn-primary btn-sm" disabled={!canConnect} onClick={() => setShowAddForm(!showAddForm)}>
            <Plus size={14} /> Connect Account
          </button>
        </div>
      ) : (
        <div className="page-header flex items-center justify-between">
          <div>
            <h1 className="page-title">Google Accounts</h1>
            <p className="page-subtitle">Manage connected Google OAuth profiles for Search Console</p>
          </div>
          <button className="btn btn-primary" disabled={!canConnect} onClick={() => setShowAddForm(!showAddForm)}>
            <Plus size={14} /> Connect Account
          </button>
        </div>
      )}

      {error && (
        <div className="alert alert-error mb-4">
          <div className="alert-content">{error}</div>
        </div>
      )}

      {/* Add Account Panel */}
      {showAddForm && (
        <div className="card mb-4" style={{ border: '2px solid var(--accent)' }}>
          <h2 style={{ fontWeight: 700, fontSize: 16, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Key size={18} style={{ color: 'var(--accent)' }} /> Link Google Account
          </h2>
          <p className="text-secondary text-sm mb-4">
            Connect an additional Google account. You can link sites to this profile for Search Console inspection and sitemap submission.
          </p>

          <div className="alert alert-warn mb-4">
            <div className="alert-content">
              <strong>For a durable connection:</strong> set the OAuth app to <strong>In production</strong>, or use an
              <strong> Internal</strong> app for your Workspace. Google deliberately expires refresh tokens after seven days
              for External apps left in Testing. A Workspace administrator can also mark the app Trusted.
            </div>
          </div>

          <div style={{ background: 'var(--bg-input)', padding: '16px 20px', borderRadius: 8, border: '1px solid var(--border)', marginBottom: 20 }}>
            <strong style={{ display: 'block', fontSize: 12, marginBottom: 6, color: 'var(--text-primary)' }}>Authorized Redirect URI:</strong>
            <p style={{ margin: '0 0 8px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
              Paste this Redirect URI into your Google Cloud Credentials configuration under <strong>Authorized redirect URIs</strong>:
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-card)', padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
              <code style={{ fontSize: 12, wordBreak: 'break-all', flexGrow: 1, color: 'var(--text-primary)' }}>{redirectUri}</code>
              <button
                type="button"
                className="btn-icon btn-icon-ghost"
                onClick={copyRedirectUri}
                title="Copy Redirect URI"
                aria-label={copied ? 'Copied redirect URI' : 'Copy redirect URI'}
              >
                {copied ? <Check size={16} style={{ color: 'var(--ok)' }} /> : <Copy size={16} />}
              </button>
            </div>
          </div>

          {/* Auto-setup opt-in (applies to both connect modes) */}
          <label className="autosetup-row">
            <input type="checkbox" checked={autoSetup} onChange={e => setAutoSetup(e.target.checked)} />
            <div>
              <strong>Auto-configure Google APIs</strong>
              <div className="text-dim" style={{ fontSize: 12 }}>
                After you sign in, the tool enables the Search Console API on your project for you and can
                provision a one-click Gemini key later. This requests broad Google
                Cloud access on the consent screen. <strong>Managed (Google Workspace) accounts:</strong> leave
                this unchecked — the Cloud scope makes your login subject to your organisation's re-authentication
                policy and forces a periodic reconnect. Search Console works without it; you can enable the API
                by hand in the Cloud console.
              </div>
            </div>
          </label>

          {hasBuiltin ? (
            <div className="text-center py-3">
              <div style={{ background: 'var(--ok-dim)', width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
                <Smartphone size={20} style={{ color: 'var(--ok)' }} />
              </div>
              <h3 style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>One-Click Google Sign-In</h3>
              <p className="text-secondary text-xs mb-3">Uses your pre-configured environment credentials.</p>
              <button className="btn btn-primary" onClick={() => startGoogleAuth()} disabled={connecting}>
                {connecting ? 'Launching popup…' : 'Sign in with Google'}
              </button>
            </div>
          ) : (
            <div>
              <div className="input-group mb-3">
                <label className="input-label">Client ID</label>
                <input className="input" placeholder="1234567890-abc...apps.googleusercontent.com"
                  value={clientId} onChange={e => setClientId(e.target.value)} />
              </div>

              <div className="input-group mb-3">
                <label className="input-label">Client Secret</label>
                <input className="input" type="password" placeholder="GOCSPX-..."
                  value={clientSecret} onChange={e => setClientSecret(e.target.value)} />
              </div>

              {connectError && <div className="alert alert-error mb-3"><div className="alert-content">{connectError}</div></div>}

              <div className="flex gap-2 justify-end">
                <button className="btn btn-secondary" onClick={() => setShowAddForm(false)}>Cancel</button>
                <button className="btn btn-primary" disabled={!clientId.trim() || !clientSecret.trim() || connecting} onClick={() => startGoogleAuth()}>
                  {connecting ? 'Launching popup…' : 'Start Authorization'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Accounts List */}
      {myAccounts.some(a => !a.available_in_workspace) && (
        <div className="card mb-4">
          <h2 style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Your other Google accounts</h2>
          <p className="text-dim" style={{ fontSize: 12, marginBottom: 10 }}>Reuse a personal connection in this workspace without signing in to Google again.</p>
          <div className="member-list">
            {myAccounts.filter(a => !a.available_in_workspace).map(acc => (
              <div className="member-row" key={acc.id}>
                <div className="member-info">
                  <span className="member-name">{acc.email || acc.id}</span>
                  <span className="member-role">Owned by you · not shared with this workspace</span>
                </div>
                <button className="btn btn-secondary btn-sm" disabled={!canConnect} onClick={() => shareAccount(acc.id)}><Plus size={13} /> Add to workspace</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2 style={{ fontWeight: 700, fontSize: 16, marginBottom: 12 }}>Connected Accounts</h2>
        
        {loading ? (
          <div className="text-center py-4"><span className="spinner" /> Loading accounts…</div>
        ) : accounts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-secondary)' }}>
            <AlertCircle size={32} style={{ color: 'var(--text-dim)', marginBottom: 12, margin: '0 auto' }} />
            <p className="text-sm">No Google Accounts connected yet.</p>
            <p className="text-xs text-dim mt-1">Click "Connect Account" to connect your first profile.</p>
          </div>
        ) : (
          <div className="flex-col gap-3">
            {accounts.map(acc => (
              <div key={acc.id} className="flex items-center gap-3 p-3" style={{ border: `1px solid ${acc.needs_reauth ? 'var(--error)' : 'var(--border)'}`, borderRadius: 8, background: 'var(--bg-input)' }}>
                <div style={{ background: acc.needs_reauth ? 'var(--error-dim)' : 'var(--ok-dim)', width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {acc.needs_reauth
                    ? <AlertTriangle size={18} style={{ color: 'var(--error)' }} />
                    : <ShieldCheck size={18} style={{ color: 'var(--ok)' }} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    {acc.email || 'Google Account'}
                    {!!acc.needs_reauth && <span className="badge badge-error">Reconnect required</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <span>Client ID: <code>{acc.client_id.slice(0, 15)}...</code></span>
                    <span>•</span>
                    <span>Connected {new Date(acc.created_at || '').toLocaleDateString()}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
                    {acc.is_mine ? 'Connected by you' : `Shared workspace account${acc.owner_email ? ` · owned by ${acc.owner_email}` : ''}`}
                  </div>
                  {acc.refresh_token_expiry && (
                    <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 4 }}>
                      Google issued a time-limited refresh grant ending {new Date(acc.refresh_token_expiry).toLocaleString()}.
                      Publish the OAuth app or make it Internal/Trusted before reconnecting.
                    </div>
                  )}
                  {acc.last_refreshed_at && !acc.needs_reauth && (
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
                      Last refreshed automatically {new Date(acc.last_refreshed_at).toLocaleString()}.
                    </div>
                  )}
                  {acc.granted_scopes?.split(' ').includes('https://www.googleapis.com/auth/cloud-platform') && (
                    <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 3 }}>
                      This grant includes broad Google Cloud access and may be subject to your Workspace session-control policy.
                      Revoke the app in Google Account connections, then reconnect with Auto-configure disabled if periodic reauthentication continues.
                    </div>
                  )}
                  {!!acc.needs_reauth && (
                    <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 4 }}>
                      Its Google token can no longer be refreshed (revoked or a Workspace reauth policy). Click <strong>Reconnect</strong> to re-authorise — it reuses this account's credentials, so no need to disconnect or re-enter your client ID/secret.
                      {acc.last_refresh_error && <><br />Google response: <code>{acc.last_refresh_error}</code></>}
                    </div>
                  )}
                </div>
                {acc.can_disconnect && (
                  <button
                    className={`btn btn-sm ${acc.needs_reauth ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => startGoogleAuth(acc)}
                    disabled={reconnectingId === acc.id || !canConnect}
                    title="Reconnect this account (reuses stored credentials)"
                  >
                    <RefreshCw size={14} /> {reconnectingId === acc.id ? 'Reconnecting…' : 'Reconnect'}
                  </button>
                )}
                {acc.can_unshare && (
                  <button className="btn btn-ghost btn-sm" disabled={!canConnect} onClick={() => unshareAccount(acc.id, acc.email)} title="Remove from this workspace">
                    Remove
                  </button>
                )}
                {acc.can_disconnect && (
                  <button className="btn btn-ghost btn-sm" disabled={!canConnect} style={{ color: 'var(--error)' }} onClick={() => disconnectAccount(acc.id, acc.email)} title="Delete credential everywhere">
                    <Trash2 size={14} /> Delete
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
