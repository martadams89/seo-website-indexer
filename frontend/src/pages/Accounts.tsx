import { useState, useEffect } from 'react';
import { ShieldCheck, Plus, Trash2, Key, AlertCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import { api, type GoogleAccount } from '../api';
import { useApp } from '../AppContext';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { GoogleHealth } from '../components/GoogleHealth';
import { GoogleConnectForm } from '../components/GoogleConnectForm';

const ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const hasAds = (acc: GoogleAccount) => !!acc.granted_scopes?.split(' ').includes(ADS_SCOPE);
const projectOf = (clientId: string) => /^(\d{6,})-/.exec(clientId)?.[1] ?? null;

export default function AccountsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { refresh } = useApp();
  const { active } = useWorkspace();
  const canConnect = !!active?.permissions?.manage_integrations;
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [myAccounts, setMyAccounts] = useState<GoogleAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  const [showAddForm, setShowAddForm] = useState(false);
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');

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
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [refresh]);

  // `reconnect` re-authorises an existing account in place: it reuses the
  // account's encrypted client id/secret through a single-use server-side OAuth
  // state, so the user never has to disconnect it or re-enter credentials.
  // The server carries Ads and Business Profile forward and keeps a limited connection limited;
  // leaving Cloud access out drops it, which is what stops Workspace session-control expiry.
  async function startGoogleAuth(reconnect: GoogleAccount, opts: { ads?: boolean } = {}) {
    setConnectError('');
    setReconnectingId(reconnect.id);
    try {
      const ads = opts.ads ?? hasAds(reconnect);
      const { authorizationUrl } = await api.beginGoogleAuth({ accountId: reconnect.id, ads });

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
            Connect another Google user, or the same one through another Google Cloud project. Pick a project you already use and nothing needs re-entering;
            a separate project is useful when Google Ads or Business Profile API access or quota sits on a different one.
          </p>

          <div className="alert alert-warn mb-4">
            <div className="alert-content">
              <strong>For a durable connection:</strong> set the OAuth app to <strong>In production</strong>, or use an
              <strong> Internal</strong> app for your Workspace. Google deliberately expires refresh tokens after seven days
              for External apps left in Testing. A Workspace administrator can also mark the app Trusted.
            </div>
          </div>

          <GoogleConnectForm product="all" canManage={canConnect} onConnected={() => setShowAddForm(false)} />
        </div>
      )}
      {connectError && <div className="alert alert-error mb-3"><div className="alert-content">{connectError}</div></div>}

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

      {accounts.length > 0 && <GoogleHealth canManage={canConnect} />}

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
                    {hasAds(acc) && <span className="badge badge-accent">Google Ads</span>}
                    {acc.limited_to && <span className="badge badge-info" title="This connection asked Google only for these products">{acc.limited_to.map(p => (p === 'ads' ? 'Google Ads' : 'Business Profile')).join(' + ')} only</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <span>{(acc.project ?? projectOf(acc.client_id)) ? <>Cloud project <code>{acc.project ?? projectOf(acc.client_id)}</code></> : <>Client ID: <code>{acc.client_id.slice(0, 15)}...</code></>}</span>
                    <span>•</span>
                    <span>Connected {new Date(acc.created_at || '').toLocaleDateString()}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
                    {acc.is_mine ? 'Connected by you' : `Shared workspace account${acc.owner_email ? ` · owned by ${acc.owner_email}` : ''}`}
                  </div>
                  {acc.used_for && (acc.used_for.sites + acc.used_for.ads_clients + acc.used_for.locations > 0) && (
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
                      Used for {[
                        acc.used_for.sites ? `${acc.used_for.sites} site${acc.used_for.sites === 1 ? '' : 's'} (Search Console)` : '',
                        acc.used_for.ads_clients ? `${acc.used_for.ads_clients} Google Ads client${acc.used_for.ads_clients === 1 ? '' : 's'}` : '',
                        acc.used_for.locations ? `${acc.used_for.locations} Business Profile location${acc.used_for.locations === 1 ? '' : 's'}` : '',
                      ].filter(Boolean).join(', ')}
                    </div>
                  )}
                  {acc.refresh_token_expiry && (
                    <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 4 }}>
                      Google issued a time-limited refresh grant ending {new Date(acc.refresh_token_expiry).toLocaleString()}, so this
                      connection will stop working then. This comes from your OAuth app, not Auto-configure: its consent screen is still in
                      Testing. In Google Cloud Console → <strong>Google Auth Platform → Audience</strong>, set the user type to
                      <strong> Internal</strong> (Google Workspace) or click <strong>Publish app</strong>, then Reconnect.
                      Reconnecting alone won't remove this.
                    </div>
                  )}
                  {acc.last_refreshed_at && !acc.needs_reauth && (
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>
                      Last refreshed automatically {new Date(acc.last_refreshed_at).toLocaleString()}.
                    </div>
                  )}
                  {acc.granted_scopes?.split(' ').includes('https://www.googleapis.com/auth/cloud-platform') && (
                    <div style={{ fontSize: 12, color: 'var(--warn)', marginTop: 3 }}>
                      This grant includes broad Google Cloud access, so a Workspace Google Cloud session-control policy can force
                      reauthentication every few hours. To keep it connected <strong>and</strong> keep the Cloud scope: in Google Admin →
                      Security → Access and data control → <strong>Google Cloud session control</strong>, lengthen the reauthentication
                      frequency or add this app to Trusted apps and enable <strong>“Exempt trusted apps”</strong>. Otherwise click
                      <strong> Reconnect</strong> with Auto-configure unticked to drop the Cloud scope. If it is still listed afterwards,
                      remove this app at myaccount.google.com/connections and connect again.
                    </div>
                  )}
                  {!!acc.needs_reauth && (
                    <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 4 }}>
                      Its Google token can no longer be refreshed (revoked or a Workspace reauth policy). Click <strong>Reconnect</strong> to re-authorise — it reuses this account's credentials, so no need to disconnect or re-enter your client ID/secret.
                      {acc.last_refresh_error && <><br />Google response: <code>{acc.last_refresh_error}</code></>}
                      {/rapt|reauth/i.test(acc.last_refresh_error ?? '') && (
                        <><br />This is your Workspace’s Google Cloud session-control policy. To stop it recurring, lengthen the reauth window or exempt this app in Google Admin → Security → Access and data control → <strong>Google Cloud session control</strong> — or reconnect with Auto-configure disabled.</>
                      )}
                    </div>
                  )}
                </div>
                {acc.can_disconnect && !hasAds(acc) && !acc.needs_reauth && (
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => startGoogleAuth(acc, { ads: true })}
                    disabled={reconnectingId === acc.id || !canConnect}
                    title="Re-consent with Google Ads access, keeping the current permissions"
                  >
                    <Plus size={14} /> Add Google Ads
                  </button>
                )}
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
