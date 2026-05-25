import { useState, useEffect } from 'react';
import { ShieldCheck, Plus, Trash2, Key, Check, Copy, AlertCircle, Smartphone } from 'lucide-react';
import { api, type GoogleAccount } from '../api';
import { useApp } from '../AppContext';

export default function AccountsPage() {
  const { status, refresh } = useApp();
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  
  // Custom Account Connection Form State
  const [showAddForm, setShowAddForm] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [copied, setCopied] = useState(false);

  const hasBuiltin = status?.auth?.hasBuiltinCredentials ?? false;
  const redirectUri = window.location.origin + '/api/auth/google/callback';

  async function fetchAccounts() {
    setLoading(true);
    try {
      const data = await api.getAccounts();
      setAccounts(data);
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
      if (event.data?.type === 'GOOGLE_AUTH_SUCCESS') {
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

  async function startGoogleAuth() {
    setConnectError('');
    setConnecting(true);
    try {
      if (!hasBuiltin) {
        await api.saveCredentials(clientId.trim(), clientSecret.trim());
      }
      
      const activeClientId = hasBuiltin ? (status?.auth?.clientId || '') : clientId.trim();
      if (!activeClientId) {
        throw new Error('Google OAuth Client ID is missing.');
      }

      const scope = 'https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/indexing https://www.googleapis.com/auth/userinfo.email';
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${activeClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;

      const width = 600;
      const height = 700;
      const left = window.screen.width / 2 - width / 2;
      const top = window.screen.height / 2 - height / 2;
      
      const popup = window.open(
        authUrl,
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
  }

  async function disconnectAccount(id: string, email: string | null) {
    if (!confirm(`Disconnect account ${email || id}? Any sites linked to this account will stop indexing.`)) return;
    try {
      await api.disconnectAccount(id);
      await refresh();
      await fetchAccounts();
    } catch (e) {
      setError(String(e).replace('Error: ', ''));
    }
  }

  function copyRedirectUri() {
    navigator.clipboard.writeText(redirectUri);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <div className="page-header flex items-center justify-between">
        <div>
          <h1 className="page-title">Google Accounts</h1>
          <p className="page-subtitle">Manage connected Google OAuth profiles for Search Console</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAddForm(!showAddForm)}>
          <Plus size={14} /> Connect Account
        </button>
      </div>

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
            Connect an additional Google Cloud project. You can link sites to this profile to submit URLs and sitemaps.
          </p>

          <div style={{ background: 'var(--bg-input)', padding: '16px 20px', borderRadius: 8, border: '1px solid var(--border)', marginBottom: 20 }}>
            <strong style={{ display: 'block', fontSize: 12, marginBottom: 6, color: 'var(--text-primary)' }}>Authorized Redirect URI:</strong>
            <p style={{ margin: '0 0 8px 0', fontSize: 12, color: 'var(--text-secondary)' }}>
              Paste this Redirect URI into your Google Cloud Credentials configuration under <strong>Authorized redirect URIs</strong>:
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-card)', padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
              <code style={{ fontSize: 11, wordBreak: 'break-all', flexGrow: 1, color: 'var(--text-primary)' }}>{redirectUri}</code>
              <button className="btn btn-ghost btn-sm" onClick={copyRedirectUri} style={{ padding: 4 }} title="Copy Redirect URI">
                {copied ? <Check size={14} style={{ color: 'var(--ok)' }} /> : <Copy size={14} />}
              </button>
            </div>
          </div>

          {hasBuiltin ? (
            <div className="text-center py-3">
              <div style={{ background: 'var(--ok-dim)', width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
                <Smartphone size={20} style={{ color: 'var(--ok)' }} />
              </div>
              <h3 style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>One-Click Google Sign-In</h3>
              <p className="text-secondary text-xs mb-3">Uses your pre-configured environment credentials.</p>
              <button className="btn btn-primary" onClick={startGoogleAuth} disabled={connecting}>
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
                <button className="btn btn-primary" disabled={!clientId.trim() || !clientSecret.trim() || connecting} onClick={startGoogleAuth}>
                  {connecting ? 'Launching popup…' : 'Start Authorization'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Accounts List */}
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
              <div key={acc.id} className="flex items-center gap-3 p-3" style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-input)' }}>
                <div style={{ background: 'var(--ok-dim)', width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <ShieldCheck size={18} style={{ color: 'var(--ok)' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>{acc.email || 'Google Account'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                    <span>Client ID: <code>{acc.client_id.slice(0, 15)}...</code></span>
                    <span>•</span>
                    <span>Connected {new Date(acc.created_at || '').toLocaleDateString()}</span>
                  </div>
                </div>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => disconnectAccount(acc.id, acc.email)} title="Disconnect Account">
                  <Trash2 size={14} /> Disconnect
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
