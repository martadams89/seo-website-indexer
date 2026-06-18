import { useState, useEffect } from 'react';
import { Save, LogOut } from 'lucide-react';
import { useApp } from '../AppContext';
import { api } from '../api';

export default function SettingsPage() {
  const { status, refresh } = useApp();
  const [cronSchedule, setCronSchedule] = useState('');
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [clearLoading, setClearLoading] = useState(false);
  const [bingKey, setBingKey] = useState('');
  const [bingConfigured, setBingConfigured] = useState(false);
  const [bingSaving, setBingSaving] = useState(false);
  const [bingSaved, setBingSaved] = useState(false);

  useEffect(() => {
    api.getSettings().then(s => {
      setCronSchedule(s.cron_schedule ?? '0 3 * * *');
      setBingConfigured(Boolean((s as Record<string, unknown>).bing_api_key_set));
    }).catch(() => null);
  }, []);

  async function saveSettings() {
    setSaving(true);
    setSaved(false);
    try {
      await api.updateSettings({ cron_schedule: cronSchedule });
      setSaved(true);
      await refresh();
      setTimeout(() => setSaved(false), 3000);
    } catch { /* ignore */ }
    setSaving(false);
  }

  async function saveBing() {
    setBingSaving(true);
    setBingSaved(false);
    try {
      await api.updateSettings({ bing_api_key: bingKey.trim() });
      setBingConfigured(bingKey.trim().length > 0);
      setBingKey('');
      setBingSaved(true);
      setTimeout(() => setBingSaved(false), 3000);
    } catch { /* ignore */ }
    setBingSaving(false);
  }

  async function clearAuth() {
    if (!confirm('Clear all Google authentication credentials? You will need to re-authenticate.')) return;
    setClearLoading(true);
    await api.clearAuth();
    await refresh();
    setClearLoading(false);
    window.location.href = '/setup';
  }

  const CRON_PRESETS = [
    { label: 'Every hour',   value: '0 * * * *' },
    { label: 'Every 6h',     value: '0 */6 * * *' },
    { label: '3am daily',    value: '0 3 * * *' },
    { label: 'Every Monday', value: '0 3 * * 1' },
  ];

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Configure scheduling and authentication</p>
      </div>

      {/* ── Schedule ── */}
      <div className="card mb-4">
        <div className="card-title">Scheduling</div>

        <div className="input-group mb-3">
          <label className="input-label">Cron Expression</label>
          <input
            className="input"
            style={{ fontFamily: 'JetBrains Mono' }}
            value={cronSchedule}
            onChange={e => setCronSchedule(e.target.value)}
            placeholder="0 3 * * *"
          />
          <span className="input-hint">Server timezone (UTC). Current: <code style={{ fontFamily: 'JetBrains Mono' }}>{status?.scheduler.cronSchedule}</code></span>
        </div>

        <div className="flex gap-2 flex-wrap mb-3">
          {CRON_PRESETS.map(p => (
            <button key={p.value} className="btn btn-secondary btn-sm" onClick={() => setCronSchedule(p.value)}>
              {p.label}
            </button>
          ))}
        </div>

        <div className="alert alert-info mb-3">
          <div className="alert-content" style={{ fontSize: 12 }}>
            <strong>Google Indexing API limit:</strong> 200 URLs/day across all sites in a single Google Cloud project.
            The scheduler distributes the budget round-robin across your sites, prioritising new and changed URLs
            (detected via <code>&lt;lastmod&gt;</code> in sitemaps).
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button className="btn btn-primary" disabled={saving} onClick={saveSettings}>
            {saving ? <><span className="spinner" /> Saving…</> : saved ? <><Save size={13} /> Saved ✓</> : <><Save size={13} /> Save Schedule</>}
          </button>
          {saved && <span className="text-ok text-sm">Schedule updated and restarted.</span>}
        </div>
      </div>

      {/* ── Auth ── */}
      <div className="card mb-4">
        <div className="card-title">Google Authentication</div>

        <div className="flex items-center gap-3 mb-3">
          <div style={{
            width: 10, height: 10, borderRadius: '50%',
            background: status?.auth.authenticated ? 'var(--ok)' : 'var(--error)',
            boxShadow: status?.auth.authenticated ? '0 0 8px var(--ok)' : 'none',
          }} />
          <div>
            {status?.auth.authenticated ? (
              <>
                <span className="text-ok" style={{ fontWeight: 600 }}>Connected (Google OAuth 2.0)</span>
                {status.auth.expiresAt && (
                  <div className="text-dim text-xs mt-1">
                    Session active — token expires: {new Date(status.auth.expiresAt).toLocaleDateString()} (auto-refresh enabled)
                  </div>
                )}
              </>
            ) : (
              <span className="text-error" style={{ fontWeight: 600 }}>Not authenticated</span>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          {!status?.auth.authenticated && (
            <a href="/setup" className="btn btn-primary btn-sm">
              Set Up Authentication
            </a>
          )}
          {status?.auth.authenticated && (
            <button className="btn btn-danger btn-sm" disabled={clearLoading} onClick={clearAuth}>
              {clearLoading ? <><span className="spinner" /> Clearing…</> : <><LogOut size={12} /> Clear Credentials</>}
            </button>
          )}
        </div>
      </div>

      {/* ── Bing Webmaster ── */}
      <div className="card mb-4">
        <div className="card-title">Bing Webmaster URL Submission</div>

        <div className="flex items-center gap-3 mb-3">
          <div style={{
            width: 10, height: 10, borderRadius: '50%',
            background: bingConfigured ? 'var(--ok)' : 'var(--text-dim)',
            boxShadow: bingConfigured ? '0 0 8px var(--ok)' : 'none',
          }} />
          <span style={{ fontWeight: 600, color: bingConfigured ? 'var(--ok)' : 'var(--text-secondary)' }}>
            {bingConfigured ? 'API key configured' : 'Not configured (optional)'}
          </span>
        </div>

        <div className="alert alert-info mb-3">
          <div className="alert-content" style={{ fontSize: 12 }}>
            IndexNow already notifies Bing, so this is <strong>optional</strong>. Add a Bing Webmaster API key to also
            submit changed pages directly into your verified Bing property and surface your daily Bing quota.
            Get a key from <a href="https://www.bing.com/webmasters" target="_blank" rel="noopener noreferrer">Bing Webmaster Tools</a> → <strong>Settings → API access</strong>. One key covers all your verified sites.
          </div>
        </div>

        <div className="input-group mb-3">
          <label className="input-label">Bing API Key</label>
          <input
            className="input"
            type="password"
            style={{ fontFamily: 'JetBrains Mono' }}
            value={bingKey}
            onChange={e => setBingKey(e.target.value)}
            placeholder={bingConfigured ? '•••••••• (leave blank to keep current)' : 'Paste your Bing Webmaster API key'}
            autoComplete="off"
          />
          <span className="input-hint">Stored server-side; never returned in plaintext. Submit an empty value to clear it.</span>
        </div>

        <div className="flex items-center gap-3">
          <button className="btn btn-primary" disabled={bingSaving || (!bingKey && !bingConfigured)} onClick={saveBing}>
            {bingSaving ? <><span className="spinner" /> Saving…</> : bingSaved ? <><Save size={13} /> Saved ✓</> : <><Save size={13} /> Save Bing Key</>}
          </button>
          {bingSaved && <span className="text-ok text-sm">Bing settings updated.</span>}
        </div>
      </div>

      {/* ── IndexNow Info ── */}
      <div className="card">
        <div className="card-title">IndexNow — How Key Verification Works</div>
        <div className="flex-col gap-3" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          <p>
            IndexNow requires you to prove site ownership by serving a key file at
            <code className="font-mono" style={{ color: 'var(--text-code)', margin: '0 4px' }}>https://yourdomain.com/{'{key}'}.txt</code>
            containing exactly the key as plain text.
          </p>

          <div className="alert alert-warn">
            <div className="alert-content">
              <div className="alert-title">Why you got a 403 "UserForbiddedToAccessSite" error</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                The key file was not accessible from Bing's servers. This is the most common cause of IndexNow failures.
              </div>
            </div>
          </div>

          <div className="card" style={{ background: 'var(--bg-input)' }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Option A — This container as your domain proxy (recommended)</div>
            <p style={{ fontSize: 12 }}>
              If you can route your domain's traffic through this container (via reverse proxy like nginx/Caddy/Cloudflare),
              the key file is served automatically at <code className="font-mono" style={{ color: 'var(--text-code)' }}>/{'{key}'}.txt</code>.
              No manual file deployment needed.
            </p>
            <pre style={{
              background: 'var(--bg-overlay)', padding: 10, borderRadius: 6, marginTop: 8,
              fontSize: 11, fontFamily: 'JetBrains Mono', color: 'var(--text-code)', overflowX: 'auto',
            }}>
{`# nginx example — proxy key file through to this container
location ~* \\.txt$ {
    proxy_pass http://seo-indexer:3000;
}`}
            </pre>
          </div>

          <div className="card" style={{ background: 'var(--bg-input)' }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Option B — Static file on your website</div>
            <p style={{ fontSize: 12 }}>
              Copy the key shown on the Sites page and create a file on your website:
            </p>
            <pre style={{
              background: 'var(--bg-overlay)', padding: 10, borderRadius: 6, marginTop: 8,
              fontSize: 11, fontFamily: 'JetBrains Mono', color: 'var(--text-code)', overflowX: 'auto',
            }}>
{`# Create in your public/ or static/ directory:
echo "YOUR_KEY_HERE" > public/YOUR_KEY_HERE.txt
# Then deploy your site normally.
# File must be accessible at: https://yourdomain.com/YOUR_KEY.txt`}
            </pre>
          </div>

          <p style={{ fontSize: 12 }}>
            Once deployed, go to <strong>Sites → IndexNow Setup → Verify Key File</strong> to confirm it works.
          </p>
        </div>
      </div>
    </div>
  );
}
