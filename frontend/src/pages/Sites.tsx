import { useState, useEffect } from 'react';
import { Plus, Trash2, ShieldCheck, ExternalLink, Copy, Check, Play, Edit } from 'lucide-react';
import { useApp } from '../AppContext';
import { api, type Site, type GSCSite, type GoogleAccount } from '../api';

// ── Add Site Modal ────────────────────────────────────────────────────────────

function AddSiteModal({ accounts, onClose, onSaved }: { accounts: GoogleAccount[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName]           = useState('');
  const [domain, setDomain]       = useState('');
  const [sitemapUrl, setSitemapUrl] = useState('');
  const [gscUrl, setGscUrl]       = useState('');
  const [googleAccountId, setGoogleAccountId] = useState(() => accounts.length > 0 ? accounts[0].id : '');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');

  const [gscSites, setGscSites]           = useState<GSCSite[]>([]);

  // Load properties from Google Search Console
  useEffect(() => {
    api.listGSCSites()
      .then(sites => {
        // Filter out properties where the user is just a user if they want owner actions,
        // but since they have authenticated, let's show all of them!
        setGscSites(sites);
      })
      .catch(err => {
        console.warn('Could not load GSC properties:', err);
      });
  }, []);

  // Auto-fill sitemap and GSC URLs from domain
  function handleDomainBlur() {
    if (domain && !sitemapUrl) setSitemapUrl(`https://${domain}/sitemap.xml`);
    if (domain && !gscUrl) setGscUrl(`https://${domain}/`);
  }

  async function save() {
    setError('');
    setLoading(true);
    try {
      await api.addSite({ name, domain, sitemapUrl, gscUrl, googleAccountId: googleAccountId || null });
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e).replace('Error: ', ''));
    }
    setLoading(false);
  }

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2 className="modal-title">Add Site</h2>
        <p className="modal-subtitle">Add a website to monitor and submit to search engines.</p>

        <div className="flex-col gap-3">
          {/* Search Console Site Picker */}
          {gscSites.length > 0 && (
            <div className="input-group" style={{ background: 'var(--bg-input)', padding: 12, borderRadius: 8, border: '1px solid var(--border)' }}>
              <label className="input-label" style={{ color: 'var(--accent)', fontWeight: 600 }}>Import from Google Search Console</label>
              <select
                className="input mt-1"
                value=""
                onChange={e => {
                  const val = e.target.value;
                  if (!val) return;
                  
                  let parsedDomain = '';
                  if (val.startsWith('sc-domain:')) {
                    parsedDomain = val.replace('sc-domain:', '');
                  } else {
                    try {
                      const u = new URL(val);
                      parsedDomain = u.hostname;
                    } catch {
                      parsedDomain = val;
                    }
                  }
                  
                  setName(parsedDomain);
                  setDomain(parsedDomain);
                  setSitemapUrl(`https://${parsedDomain}/sitemap.xml`);
                  setGscUrl(val);

                  // Dynamically pre-select the Google Account that returned this property
                  const selectedGscSite = gscSites.find(s => s.siteUrl === val);
                  if (selectedGscSite?.googleAccountId) {
                    setGoogleAccountId(selectedGscSite.googleAccountId);
                  }
                }}
              >
                <option value="">-- Select a Search Console property to import --</option>
                {gscSites.map(s => (
                  <option key={s.siteUrl} value={s.siteUrl}>
                    {s.siteUrl}
                  </option>
                ))}
              </select>
              <span className="input-hint" style={{ marginTop: 4 }}>
                Selecting a verified GSC property will automatically configure the details and linked Google Account below.
              </span>
            </div>
          )}

          <div className="input-group">
            <label className="input-label">Site Name</label>
            <input className="input" placeholder="My Website" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="input-group">
            <label className="input-label">Domain</label>
            <input className="input" placeholder="example.com" value={domain}
              onChange={e => setDomain(e.target.value)} onBlur={handleDomainBlur} />
            <span className="input-hint">Without https:// or trailing slash</span>
          </div>
          <div className="input-group">
            <label className="input-label">Sitemap URL</label>
            <input className="input" placeholder="https://example.com/sitemap.xml"
              value={sitemapUrl} onChange={e => setSitemapUrl(e.target.value)} />
          </div>
          <div className="input-group">
            <label className="input-label">Google Search Console URL</label>
            <input className="input" placeholder="https://example.com/ or sc-domain:example.com"
              value={gscUrl} onChange={e => setGscUrl(e.target.value)} />
            <span className="input-hint">
              Use "sc-domain:example.com" for domain properties, or the full URL for URL-prefix properties.
            </span>
          </div>

          {/* Google Account Selector */}
          {accounts.length > 0 && (
            <div className="input-group">
              <label className="input-label">Google Account</label>
              <select
                className="input mt-1"
                value={googleAccountId}
                onChange={e => setGoogleAccountId(e.target.value)}
              >
                <option value="">None (IndexNow Only)</option>
                {accounts.map(acc => (
                  <option key={acc.id} value={acc.id}>
                    {acc.email || `Account (${acc.id.slice(0, 8)})`}
                  </option>
                ))}
              </select>
              <span className="input-hint" style={{ marginTop: 4 }}>
                Select which Google Account manages this site's Search Console access.
              </span>
            </div>
          )}

          {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name || !domain || !sitemapUrl || !gscUrl || loading} onClick={save}>
            {loading ? <><span className="spinner" /> Saving…</> : 'Add Site'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Site Modal ───────────────────────────────────────────────────────────

function EditSiteModal({ site, accounts, onClose, onSaved }: { site: Site; accounts: GoogleAccount[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName]           = useState(site.name);
  const [domain, setDomain]       = useState(site.domain);
  const [sitemapUrl, setSitemapUrl] = useState(site.sitemap_url);
  const [gscUrl, setGscUrl]       = useState(site.gsc_url);
  const [googleAccountId, setGoogleAccountId] = useState(site.google_account_id || '');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');

  async function save() {
    setError('');
    setLoading(true);
    try {
      await api.updateSite(site.id, {
        name,
        domain,
        sitemap_url: sitemapUrl,
        gsc_url: gscUrl,
        googleAccountId: googleAccountId || null
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e).replace('Error: ', ''));
    }
    setLoading(false);
  }

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2 className="modal-title">Edit Site</h2>
        <p className="modal-subtitle">Modify site configuration and Google Account association.</p>

        <div className="flex-col gap-3">
          <div className="input-group">
            <label className="input-label">Site Name</label>
            <input className="input" placeholder="My Website" value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="input-group">
            <label className="input-label">Domain</label>
            <input className="input" placeholder="example.com" value={domain} onChange={e => setDomain(e.target.value)} />
            <span className="input-hint">Without https:// or trailing slash</span>
          </div>
          <div className="input-group">
            <label className="input-label">Sitemap URL</label>
            <input className="input" placeholder="https://example.com/sitemap.xml" value={sitemapUrl} onChange={e => setSitemapUrl(e.target.value)} />
          </div>
          <div className="input-group">
            <label className="input-label">Google Search Console URL</label>
            <input className="input" placeholder="https://example.com/ or sc-domain:example.com" value={gscUrl} onChange={e => setGscUrl(e.target.value)} />
          </div>

          {/* Google Account Selector */}
          <div className="input-group">
            <label className="input-label">Google Account</label>
            <select
              className="input mt-1"
              value={googleAccountId}
              onChange={e => setGoogleAccountId(e.target.value)}
            >
              <option value="">None (IndexNow Only)</option>
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>
                  {acc.email || `Account (${acc.id.slice(0, 8)})`}
                </option>
              ))}
            </select>
            <span className="input-hint" style={{ marginTop: 4 }}>
              Select which Google Account manages this site's Search Console access.
            </span>
          </div>

          {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name || !domain || !sitemapUrl || !gscUrl || loading} onClick={save}>
            {loading ? <><span className="spinner" /> Saving…</> : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── IndexNow Setup Info ───────────────────────────────────────────────────────

function IndexNowSetupCard({ site }: { site: Site }) {
  const { status, refresh } = useApp();
  const [verifying, setVerifying] = useState(false);
  const [result, setResult]       = useState<{ reachable: boolean; keyMatch: boolean; error?: string } | null>(null);
  const [copied, setCopied]       = useState(false);
  const [activeTab, setActiveTab] = useState<'manual' | 'frameworks' | 'proxy' | 'cloudflare'>('manual');
  const [running, setRunning]     = useState(false);
  const [runSuccess, setRunSuccess] = useState('');

  async function verify() {
    setVerifying(true);
    setResult(null);
    try {
      const r = await api.verifyIndexNow(site.id);
      setResult(r);
      await refresh();
    } catch (e) {
      setResult({
        reachable: false,
        keyMatch: false,
        error: String(e).replace('Error: ', ''),
      });
    }
    setVerifying(false);
  }

  async function runSiteIndexing() {
    setRunning(true);
    setRunSuccess('');
    try {
      await api.triggerRun({ siteIds: [site.id] });
      setRunSuccess('Indexing run triggered successfully for this site! Check the dashboard or activity logs to view progress.');
      setTimeout(() => setRunSuccess(''), 8000);
    } catch (e) {
      setResult({
        reachable: false,
        keyMatch: false,
        error: `Failed to start indexing: ${String(e).replace('Error: ', '')}`,
      });
    }
    setRunning(false);
  }

  function copyKey() {
    navigator.clipboard.writeText(site.indexNowKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const keyFileUrl = `https://${site.domain}/${site.indexNowKey}.txt`;

  return (
    <div className="card mt-3" style={{ border: '1px solid var(--border)', background: 'var(--bg-card-hover)' }}>
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck size={14} style={{ color: site.indexNowVerified ? 'var(--ok)' : 'var(--warn)' }} />
        <span style={{ fontWeight: 600, fontSize: 13 }}>IndexNow Key Verification</span>
        {site.indexNowVerified
          ? <span className="badge badge-ok ml-auto">Verified ✓</span>
          : <span className="badge badge-warn ml-auto">Verification Required</span>}
      </div>

      {/* Guide Tabs */}
      <div className="flex gap-1 mb-3 border-b pb-2" style={{ borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        <button
          className="btn btn-sm"
          style={{
            background: activeTab === 'manual' ? 'var(--accent-dim)' : 'transparent',
            color: activeTab === 'manual' ? 'var(--accent)' : 'var(--text-secondary)',
            borderColor: activeTab === 'manual' ? 'var(--accent)' : 'transparent',
            padding: '4px 10px',
            fontSize: 11
          }}
          onClick={() => setActiveTab('manual')}
        >
          Manual Upload
        </button>
        <button
          className="btn btn-sm"
          style={{
            background: activeTab === 'frameworks' ? 'var(--accent-dim)' : 'transparent',
            color: activeTab === 'frameworks' ? 'var(--accent)' : 'var(--text-secondary)',
            borderColor: activeTab === 'frameworks' ? 'var(--accent)' : 'transparent',
            padding: '4px 10px',
            fontSize: 11
          }}
          onClick={() => setActiveTab('frameworks')}
        >
          Frameworks (Next.js/Astro/WP)
        </button>
        <button
          className="btn btn-sm"
          style={{
            background: activeTab === 'proxy' ? 'var(--accent-dim)' : 'transparent',
            color: activeTab === 'proxy' ? 'var(--accent)' : 'var(--text-secondary)',
            borderColor: activeTab === 'proxy' ? 'var(--accent)' : 'transparent',
            padding: '4px 10px',
            fontSize: 11
          }}
          onClick={() => setActiveTab('proxy')}
        >
          Nginx / Multi-Site Proxy
        </button>
        <button
          className="btn btn-sm"
          style={{
            background: activeTab === 'cloudflare' ? 'var(--accent-dim)' : 'transparent',
            color: activeTab === 'cloudflare' ? 'var(--accent)' : 'var(--text-secondary)',
            borderColor: activeTab === 'cloudflare' ? 'var(--accent)' : 'transparent',
            padding: '4px 10px',
            fontSize: 11
          }}
          onClick={() => setActiveTab('cloudflare')}
        >
          Cloudflare Redirect
        </button>
      </div>

      {/* Tab Contents */}
      <div className="mb-3">
        {activeTab === 'manual' && (
          <div className="alert alert-info">
            <div className="alert-content" style={{ fontSize: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Option 1: Static File Upload</div>
              <p style={{ margin: '4px 0', color: 'var(--text-secondary)' }}>
                Download or create a plain text verification file at the root of your website:
              </p>
              <ol style={{ paddingLeft: 16, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <li>Create a file named: <code style={{ color: 'var(--text-code)', fontWeight: 600 }}>{site.indexNowKey}.txt</code></li>
                <li>Write exactly this key as its contents (no spaces, no newlines): <code style={{ color: 'var(--text-code)' }}>{site.indexNowKey}</code></li>
                <li>Make sure the file is publicly readable at: <a href={keyFileUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>{site.indexNowKey}.txt <ExternalLink size={10} style={{ display: 'inline' }} /></a></li>
              </ol>
            </div>
          </div>
        )}

        {activeTab === 'frameworks' && (
          <div className="alert alert-info flex-col gap-3" style={{ padding: 12 }}>
            <div className="alert-content" style={{ fontSize: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Next.js (App Router)</div>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>Create a file at <code style={{ color: 'var(--text-code)' }}>app/{site.indexNowKey}.txt/route.ts</code> to serve the key dynamically:</p>
              <pre style={{ background: 'var(--bg-overlay)', padding: 10, borderRadius: 6, fontFamily: 'JetBrains Mono', color: 'var(--text-code)', overflowX: 'auto', fontSize: 10 }}>
{`export function GET() {
  return new Response("${site.indexNowKey}", {
    headers: { "Content-Type": "text/plain" }
  });
}`}
              </pre>
            </div>
            
            <div className="alert-content" style={{ fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Astro / Vite Static Sites</div>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>Place the verification file directly inside the public assets folder:</p>
              <pre style={{ background: 'var(--bg-overlay)', padding: 10, borderRadius: 6, fontFamily: 'JetBrains Mono', color: 'var(--text-code)', overflowX: 'auto', fontSize: 10 }}>
{`# Create file in public/ directory
echo "${site.indexNowKey}" > public/${site.indexNowKey}.txt`}
              </pre>
            </div>

            <div className="alert-content" style={{ fontSize: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>WordPress</div>
              <p style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>Upload the keyfile to your WordPress root, or paste this block at the top of your theme's <code style={{ color: 'var(--text-code)' }}>functions.php</code>:</p>
              <pre style={{ background: 'var(--bg-overlay)', padding: 10, borderRadius: 6, fontFamily: 'JetBrains Mono', color: 'var(--text-code)', overflowX: 'auto', fontSize: 10 }}>
{`if ($_SERVER['REQUEST_URI'] === '/${site.indexNowKey}.txt') {
    header('Content-Type: text/plain');
    echo '${site.indexNowKey}';
    exit;
}`}
              </pre>
            </div>
          </div>
        )}

        {activeTab === 'proxy' && (
          <div className="alert alert-info">
            <div className="alert-content" style={{ fontSize: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Ideal for Multi-Site (10 to 100+ sites)</div>
              <p style={{ color: 'var(--text-secondary)' }}>
                If you run multiple websites behind Caddy, Nginx, or an Apache reverse proxy, you don't need to manually upload files!
                Add this dynamic redirect location block to all your sites' Nginx server configs to forward verification requests back to this tool automatically:
              </p>
              <pre style={{ background: 'var(--bg-overlay)', padding: 10, borderRadius: 6, marginTop: 8, fontFamily: 'JetBrains Mono', color: 'var(--text-code)', overflowX: 'auto', fontSize: 10 }}>
{`# Forward IndexNow key queries dynamically
location ~ ^/[a-f0-9]{32}\\.txt$ {
    proxy_pass http://<your-indexer-container-ip>:3000;
}`}
              </pre>
              <span style={{ fontSize: 11, color: 'var(--text-dim)', display: 'block', marginTop: 6 }}>
                Once added, every site will instantly pass ownership verification without you ever uploading or deploying keyfiles again!
              </span>
            </div>
          </div>
        )}

        {activeTab === 'cloudflare' && (
          <div className="alert alert-info">
            <div className="alert-content" style={{ fontSize: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Cloudflare CDN Dynamic Redirect</div>
              <p style={{ color: 'var(--text-secondary)' }}>
                Search engines follow redirects to fetch keyfiles! If your website is on Cloudflare, you can automate verification by adding a Redirect Rule to forward requests to this indexer container:
              </p>
              <ol style={{ paddingLeft: 16, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-secondary)' }}>
                <li>Go to Cloudflare → Websites → Your Site → <strong>Rules</strong> → <strong>Redirect Rules</strong> → Create Rule</li>
                <li>Expression: <code style={{ color: 'var(--text-code)' }}>{"(http.request.uri.path eq \"/" + site.indexNowKey + ".txt\")"}</code></li>
                <li>Type: <strong>Static Redirect</strong></li>
                <li>Target URL: <code style={{ color: 'var(--text-code)' }}>https://YOUR_INDEXER_PUBLIC_URL/{site.indexNowKey}.txt</code></li>
                <li>Status: <strong>302 Found</strong></li>
              </ol>
            </div>
          </div>
        )}
      </div>

      <div className="flex-col gap-2 mb-3" style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-input)', padding: 10, borderRadius: 6 }}>
        <div className="flex items-center justify-between">
          <span><span className="text-dim">Key Value:</span> <code className="font-mono" style={{ color: 'var(--text-code)' }}>{site.indexNowKey}</code></span>
          <button className="btn btn-ghost btn-sm" style={{ padding: '2px 6px' }} onClick={copyKey}>
            {copied ? <Check size={11} style={{ color: 'var(--ok)' }} /> : <Copy size={11} />}
          </button>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
        <div>
          <span className="text-dim">Expected key file path: </span>
          <a href={keyFileUrl} target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>
            /{site.indexNowKey}.txt <ExternalLink size={10} style={{ display: 'inline', verticalAlign: 'middle' }} />
          </a>
        </div>
      </div>

      {result && (
        <div className={`alert ${result.reachable && result.keyMatch ? 'alert-ok' : 'alert-error'} mt-3`}>
          <div className="alert-content" style={{ fontSize: 12 }}>
            {result.reachable && result.keyMatch
              ? '✓ Key file found and verified! IndexNow submissions will succeed.'
              : result.error}
          </div>
        </div>
      )}

      {runSuccess && (
        <div className="alert alert-ok mt-3">
          <div className="alert-content" style={{ fontSize: 12 }}>
            🎉 {runSuccess}
          </div>
        </div>
      )}

      <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
        <button className="btn btn-secondary btn-sm" disabled={verifying || running} onClick={verify}>
          {verifying ? <><span className="spinner" /> Verifying…</> : <><ShieldCheck size={12} /> Verify Key File</>}
        </button>
        <a
          href={keyFileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost btn-sm"
        >
          <ExternalLink size={12} /> Open Key File
        </a>
        <button
          className="btn btn-primary btn-sm"
          style={{ marginLeft: 'auto' }}
          disabled={running || verifying || (!site.indexNowVerified && !status?.auth.authenticated)}
          onClick={runSiteIndexing}
        >
          {running ? <><span className="spinner" /> Indexing…</> : <><Play size={12} /> Run Indexing Now</>}
        </button>
      </div>
    </div>
  );
}

// ── Sites Page ────────────────────────────────────────────────────────────────

export default function SitesPage() {
  const { sites, refresh } = useApp();
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [showAdd, setShowAdd]     = useState(false);
  const [editingSite, setEditingSite] = useState<Site | null>(null);
  const [expanded, setExpanded]   = useState<string | null>(null);
  const [deleting, setDeleting]   = useState<string | null>(null);

  useEffect(() => {
    api.getAccounts()
      .then(setAccounts)
      .catch(err => console.warn('Could not load Google Accounts:', err));
  }, []);

  async function deleteSite(id: string) {
    if (!confirm('Delete this site? All stored URL state will be lost.')) return;
    setDeleting(id);
    try {
      await api.deleteSite(id);
      await refresh();
    } catch { /* ignore */ }
    setDeleting(null);
  }

  return (
    <div>
      <div className="page-header flex items-center justify-between">
        <div>
          <h1 className="page-title">Sites</h1>
          <p className="page-subtitle">Manage websites and IndexNow key verification</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          <Plus size={14} /> Add Site
        </button>
      </div>

      {showAdd && (
        <AddSiteModal
          accounts={accounts}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); refresh(); }}
        />
      )}

      {editingSite && (
        <EditSiteModal
          site={editingSite}
          accounts={accounts}
          onClose={() => setEditingSite(null)}
          onSaved={() => { setEditingSite(null); refresh(); }}
        />
      )}

      {sites.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '48px 28px' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🌐</div>
          <h2 style={{ fontWeight: 700, marginBottom: 8 }}>No sites yet</h2>
          <p className="text-secondary text-sm mb-4">Add your first website to start submitting URLs.</p>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Plus size={14} /> Add Site
          </button>
        </div>
      ) : (
        <div className="flex-col gap-4">
          {sites.map(site => (
            <div key={site.id} className="card">
              <div className="flex items-center gap-3">
                <div style={{
                  width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                  background: site.indexNowVerified ? 'var(--ok)' : 'var(--warn)',
                  boxShadow: site.indexNowVerified ? '0 0 8px var(--ok)' : 'none',
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{site.name}</div>
                  <div className="text-dim text-xs" style={{ marginBottom: 4 }}>{site.domain}</div>
                  {accounts.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span className="text-dim" style={{ fontSize: 11 }}>Account:</span>
                      {site.google_account_id ? (
                        <span className="badge" style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--border)', fontWeight: 500 }}>
                          {accounts.find(a => a.id === site.google_account_id)?.email || 'Unknown Profile'}
                        </span>
                      ) : (
                        <span className="badge" style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'var(--bg-input)', color: 'var(--text-dim)', border: '1px solid var(--border)' }}>
                          None (IndexNow Only)
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setExpanded(expanded === site.id ? null : site.id)}
                  >
                    {expanded === site.id ? 'Hide' : 'IndexNow Setup'}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm flex items-center gap-1"
                    onClick={() => setEditingSite(site)}
                  >
                    <Edit size={12} /> Edit
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    disabled={deleting === site.id}
                    onClick={() => deleteSite(site.id)}
                  >
                    {deleting === site.id ? <span className="spinner" /> : <Trash2 size={12} />}
                  </button>
                </div>
              </div>

              <div className="grid-2 mt-3" style={{ fontSize: 12, color: 'var(--text-secondary)', gridTemplateColumns: '1fr 1fr' }}>
                <div>
                  <span className="text-dim">Sitemap: </span>
                  <a href={site.sitemap_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                    {site.sitemap_url} <ExternalLink size={10} style={{ display: 'inline', verticalAlign: 'middle' }} />
                  </a>
                </div>
                <div>
                  <span className="text-dim">GSC URL: </span>
                  <code className="font-mono" style={{ fontSize: 11 }}>{site.gsc_url}</code>
                </div>
              </div>

              {expanded === site.id && <IndexNowSetupCard site={site} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
