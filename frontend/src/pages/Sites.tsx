import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Trash2, ShieldCheck, ExternalLink, Copy, Check, Play, Zap,
  Globe2, KeyRound, Settings2, UploadCloud, AlertTriangle, ChevronRight,
  Sparkles, Loader2, Save,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApp } from '../AppContext';
import { api, type Site, type GSCSite, type GoogleAccount, type BingAccount, type UrlState } from '../api';
import { Modal } from '../components/Modal';
import { useSort, SortTh } from '../components/SortableTable';
import { InfoTooltip } from '../components/Tooltip';

// ── Add Site Modal (GSC import wizard) ────────────────────────────────────────

function AddSiteModal({ accounts, onClose, onSaved }: { accounts: GoogleAccount[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName]           = useState('');
  const [domain, setDomain]       = useState('');
  const [sitemapUrl, setSitemapUrl] = useState('');
  const [gscUrl, setGscUrl]       = useState('');
  const [googleAccountId, setGoogleAccountId] = useState(() => accounts.length > 0 ? accounts[0].id : '');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [gscSites, setGscSites]   = useState<GSCSite[]>([]);
  const [loadingGsc, setLoadingGsc] = useState(false);

  useEffect(() => {
    if (!googleAccountId) {
      setGscSites([]);
      return;
    }
    setLoadingGsc(true);
    api.listGSCSites(googleAccountId)
      .then(setGscSites)
      .catch(() => setGscSites([]))
      .finally(() => setLoadingGsc(false));
  }, [googleAccountId]);

  function handleDomainBlur() {
    if (domain && !sitemapUrl) setSitemapUrl(`https://${domain}/sitemap.xml`);
    if (domain && !gscUrl) setGscUrl(`https://${domain}/`);
  }

  async function save() {
    setError('');
    setLoading(true);
    try {
      await api.addSite({
        name,
        domain,
        sitemapUrl,
        gscUrl,
        googleAccountId: googleAccountId || null,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e).replace('Error: ', ''));
    }
    setLoading(false);
  }

  return (
    <Modal
      onClose={onClose}
      size="lg"
      className="add-site-modal"
      title="Add a website"
      eyebrow="Workspace setup"
      description="Import a verified Search Console property or enter the website details manually. Delivery and GEO settings can be added afterwards."
      icon={<Globe2/>}
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!name || !domain || !sitemapUrl || !gscUrl || loading} onClick={save}>{loading ? <><span className="spinner" /> Saving…</> : 'Add website'}</button></>}
    >
        <div className="flex-col gap-3">
          {accounts.length > 0 && (
            <div className="input-group">
              <label className="input-label">Linked Google Account</label>
              <select className="input mt-1" value={googleAccountId} onChange={e => setGoogleAccountId(e.target.value)}>
                <option value="">None (IndexNow Only)</option>
                {accounts.map(acc => (
                  <option key={acc.id} value={acc.id}>{acc.email || `Account (${acc.id.slice(0, 8)})`}</option>
                ))}
              </select>
            </div>
          )}

          {googleAccountId && (
            <div className="input-group">
              <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                Import from Google Search Console
                {loadingGsc && <span className="spinner" style={{ width: 12, height: 12 }} />}
              </label>
              <select
                className="input mt-1"
                value=""
                onChange={e => {
                  const val = e.target.value;
                  if (!val) return;
                  let parsedDomain: string;
                  if (val.startsWith('sc-domain:')) {
                    parsedDomain = val.replace('sc-domain:', '');
                  } else {
                    try {
                      parsedDomain = new URL(val).hostname;
                    } catch {
                      parsedDomain = val;
                    }
                  }
                  setName(parsedDomain);
                  setDomain(parsedDomain);
                  setSitemapUrl(`https://${parsedDomain}/sitemap.xml`);
                  setGscUrl(val);
                }}
              >
                {loadingGsc ? (
                  <option value="">-- Loading properties… --</option>
                ) : gscSites.length === 0 ? (
                  <option value="">-- No verified Search Console properties found --</option>
                ) : (
                  <>
                    <option value="">-- Select a property to import --</option>
                    {gscSites.map(s => <option key={s.siteUrl} value={s.siteUrl}>{s.siteUrl}</option>)}
                  </>
                )}
              </select>
              <span className="input-hint">Selecting a verified property pre-fills everything below.</span>
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
            <label className="input-label">Search Console Property</label>
            <input className="input" placeholder="https://example.com/ or sc-domain:example.com"
              value={gscUrl} onChange={e => setGscUrl(e.target.value)} />
            <span className="input-hint">"sc-domain:example.com" for domain properties; full URL for URL-prefix properties.</span>
          </div>

          {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}
        </div>

    </Modal>
  );
}

// ── Overview tab: quick facts, per-site runs, URL crawl audit ─────────────────

function OverviewTab({ site, accounts }: { site: Site; accounts: GoogleAccount[] }) {
  const { status } = useApp();
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [urls, setUrls] = useState<UrlState[]>([]);
  const [loadingUrls, setLoadingUrls] = useState(true);

  const loadUrls = useCallback(() => {
    api.getSiteUrls(site.id).then(setUrls).catch(() => null).finally(() => setLoadingUrls(false));
  }, [site.id]);

  useEffect(() => { loadUrls(); }, [loadUrls]);

  const urlSort = useSort(urls as unknown as Array<Record<string, unknown>>);

  async function runSiteIndexing(dryRun = false) {
    setRunning(true);
    setRunMsg('');
    try {
      await api.triggerRun(dryRun
        ? { siteIds: [site.id], skipGoogle: true, skipIndexNow: true }
        : { siteIds: [site.id] });
      setRunMsg(dryRun
        ? 'Audit run triggered — the URL table refreshes shortly.'
        : 'Indexing run triggered — watch Live Logs for progress.');
      setTimeout(() => setRunMsg(''), 8000);
      setTimeout(loadUrls, 5000);
    } catch (e) {
      setRunMsg(String(e).replace('Error: ', ''));
    }
    setRunning(false);
  }

  const account = accounts.find(a => a.id === site.google_account_id);

  return (
    <div>
      <div className="site-facts">
        <div className="site-fact">
          <span className="site-fact-label">Sitemap</span>
          <a href={site.sitemap_url} target="_blank" rel="noopener noreferrer" className="site-fact-value link">
            {site.sitemap_url.replace(/^https?:\/\//, '')} <ExternalLink size={10} />
          </a>
        </div>
        <div className="site-fact">
          <span className="site-fact-label">GSC property</span>
          <span className="site-fact-value font-mono">{site.gsc_url}</span>
        </div>
        <div className="site-fact">
          <span className="site-fact-label">Google account</span>
          <span className="site-fact-value">{account?.email ?? 'None (IndexNow only)'}</span>
        </div>
        <div className="site-fact">
          <span className="site-fact-label">Analytics</span>
          <Link to={`/analytics/${site.id}`} className="site-fact-value link">Coverage, CWV &amp; GEO <ChevronRight size={11} /></Link>
        </div>
      </div>

      <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap', margin: '14px 0' }}>
        <button className="btn btn-secondary btn-sm" disabled={running} onClick={() => runSiteIndexing(true)}>
          <Zap size={12} /> Dry Run (Audits Only)
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={running || (!site.indexNowVerified && !status?.auth.authenticated)}
          onClick={() => runSiteIndexing(false)}
        >
          {running ? <><span className="spinner" /> Indexing…</> : <><Play size={12} /> Run Indexing Now</>}
        </button>
        {runMsg && <span className="text-dim" style={{ fontSize: 12 }}>{runMsg}</span>}
      </div>

      <h4 className="panel-title" style={{ marginTop: 4 }}>Crawl &amp; indexing audit ({urls.length} URLs)</h4>
      {loadingUrls ? (
        <div className="empty-note"><span className="spinner" /> Loading audit history…</div>
      ) : urls.length === 0 ? (
        <div className="empty-note">No URL crawl history yet — run an indexing run to populate.</div>
      ) : (
        <div className="table-scroll" style={{ maxHeight: 300, overflowY: 'auto' }}>
          <table className="mini-table">
            <thead>
              <tr>
                <SortTh label="URL" sortKey="url" sort={urlSort.sort} onSort={urlSort.requestSort} />
                <SortTh
                  label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Google state
                    <InfoTooltip
                      content={
                        'Common GSC Indexing States:\n\n' +
                        '• INDEXED: In Google Search results.\n' +
                        '• INDEXING_ALLOWED: Crawled, allowed, not yet public.\n' +
                        '• NOT_INDEXED: Crawled but not indexed (or 404).\n' +
                        '• BLOCKED_BY_ROBOTS / NOINDEX: Blocked.\n' +
                        '• Pending: not yet inspected by a run.'
                      }
                      label="ⓘ"
                      position="bottom"
                    />
                  </span>}
                  sortKey="gsc_indexing_state" sort={urlSort.sort} onSort={urlSort.requestSort}
                />
                <SortTh label="Schema" sortKey="has_schema" sort={urlSort.sort} onSort={urlSort.requestSort} />
                <SortTh label="Submitted" sortKey="google_submitted" sort={urlSort.sort} onSort={urlSort.requestSort} />
              </tr>
            </thead>
            <tbody>
              {(urlSort.sorted as unknown as UrlState[]).map(u => {
                const path = u.url.replace(`https://${site.domain}`, '').replace(`http://${site.domain}`, '');
                return (
                  <tr key={u.url}>
                    <td className="cell-url">
                      <a href={u.url} target="_blank" rel="noopener noreferrer">{path || '/'}</a>
                    </td>
                    <td>
                      {u.gsc_indexing_state ? (
                        <span className={`badge ${u.gsc_indexing_state.toLowerCase().includes('indexed') && !u.gsc_indexing_state.includes('NOT') ? 'badge-ok' : 'badge-warn'}`}>
                          {u.gsc_indexing_state}
                        </span>
                      ) : <span className="text-dim" style={{ fontSize: 12 }}>Pending</span>}
                      {u.gsc_last_inspected && (
                        <div className="text-dim" style={{ fontSize: 12, marginTop: 2 }}>
                          {new Date(u.gsc_last_inspected).toLocaleDateString()}
                        </div>
                      )}
                    </td>
                    <td>
                      {u.has_schema ? (
                        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                          {u.schema_types?.split(',').slice(0, 4).map(st => (
                            <span key={st} className="badge">{st.trim()}</span>
                          ))}
                        </div>
                      ) : <span className="text-dim" style={{ fontSize: 12 }}>—</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className={`badge ${u.google_submitted ? 'badge-ok' : ''}`}>G</span>{' '}
                      <span className={`badge ${u.indexnow_submitted ? 'badge-ok' : ''}`}>IN</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── IndexNow tab: key, verify, setup guides ───────────────────────────────────

function IndexNowTab({ site }: { site: Site }) {
  const { refresh } = useApp();
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<{ reachable: boolean; keyMatch: boolean; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const keyFileUrl = `https://${site.domain}/${site.indexNowKey}.txt`;

  async function verify() {
    setVerifying(true);
    setResult(null);
    try {
      const r = await api.verifyIndexNow(site.id);
      setResult(r);
      await refresh();
    } catch (e) {
      setResult({ reachable: false, keyMatch: false, error: String(e).replace('Error: ', '') });
    }
    setVerifying(false);
  }

  function copyKey() {
    navigator.clipboard.writeText(site.indexNowKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <div className="site-facts" style={{ marginBottom: 14 }}>
        <div className="site-fact">
          <span className="site-fact-label">Status</span>
          <span className="site-fact-value">
            {site.indexNowVerified
              ? <span className="badge badge-ok"><ShieldCheck size={11} /> Verified</span>
              : <span className="badge badge-warn">Verification required</span>}
          </span>
        </div>
        <div className="site-fact">
          <span className="site-fact-label">Key</span>
          <span className="site-fact-value font-mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {site.indexNowKey}
            <button type="button" className="btn-icon btn-icon-ghost" onClick={copyKey} aria-label="Copy key" style={{ width: 22, height: 22, padding: 0 }}>
              {copied ? <Check size={12} style={{ color: 'var(--ok)' }} /> : <Copy size={12} />}
            </button>
          </span>
        </div>
        <div className="site-fact">
          <span className="site-fact-label">Key file</span>
          <a href={keyFileUrl} target="_blank" rel="noopener noreferrer" className="site-fact-value link">
            /{site.indexNowKey}.txt <ExternalLink size={10} />
          </a>
        </div>
      </div>

      <div className="flex gap-2 mb-3">
        <button className="btn btn-primary btn-sm" disabled={verifying} onClick={verify}>
          {verifying ? <><span className="spinner" /> Verifying…</> : <><ShieldCheck size={12} /> Verify Key File</>}
        </button>
      </div>

      {result && (
        <div className={`alert ${result.reachable && result.keyMatch ? 'alert-ok' : 'alert-error'} mb-3`}>
          <div className="alert-content" style={{ fontSize: 12 }}>
            {result.reachable && result.keyMatch
              ? '✓ Key file found and verified! IndexNow submissions will succeed.'
              : result.error}
          </div>
        </div>
      )}

      <h4 className="panel-title">How to serve the key file</h4>

      <details className="key-guide">
        <summary><span className="key-guide-label">Static file upload (simplest)</span></summary>
        <div className="key-guide-body">
          <ol className="key-guide-steps">
            <li>Create a file named <code>{site.indexNowKey}.txt</code></li>
            <li>Its entire contents: <code>{site.indexNowKey}</code> (no spaces or newlines)</li>
            <li>Serve it at <a href={keyFileUrl} target="_blank" rel="noopener noreferrer" className="key-guide-link">{keyFileUrl}</a></li>
          </ol>
        </div>
      </details>

      <details className="key-guide">
        <summary><span className="key-guide-label">🚀 Auto-deploy (FTP / webhook)</span>
          {(site.ftp_host || site.deploy_webhook_url)
            ? <span className="badge badge-ok" style={{ marginLeft: 'auto' }}>active</span>
            : <span className="badge" style={{ marginLeft: 'auto' }}>not configured</span>}
        </summary>
        <div className="key-guide-body">
          <p className="text-dim" style={{ fontSize: 12 }}>
            Configure FTP credentials or a deploy webhook in this site's <strong>Delivery</strong> tab and the
            indexer pushes and verifies the key file automatically — no manual uploads.
          </p>
          <ul className="key-guide-steps" style={{ listStyle: 'disc' }}>
            <li>FTP: {site.ftp_host ? <strong style={{ color: 'var(--ok)' }}>active ({site.ftp_host})</strong> : 'inactive'}</li>
            <li>Webhook: {site.deploy_webhook_url ? <strong style={{ color: 'var(--ok)' }}>active</strong> : 'inactive'}</li>
          </ul>
        </div>
      </details>

      <details className="key-guide">
        <summary><span className="key-guide-label">Frameworks (Next.js / Astro / WordPress)</span></summary>
        <div className="key-guide-body">
          <p style={{ fontSize: 12, fontWeight: 600, margin: '0 0 4px' }}>Next.js (App Router) — <code>app/{site.indexNowKey}.txt/route.ts</code></p>
          <pre className="file-preview" style={{ maxHeight: 120 }}>{`export function GET() {
  return new Response("${site.indexNowKey}", {
    headers: { "Content-Type": "text/plain" }
  });
}`}</pre>
          <p style={{ fontSize: 12, fontWeight: 600, margin: '10px 0 4px' }}>Astro / Vite static</p>
          <pre className="file-preview" style={{ maxHeight: 80 }}>{`echo "${site.indexNowKey}" > public/${site.indexNowKey}.txt`}</pre>
          <p style={{ fontSize: 12, fontWeight: 600, margin: '10px 0 4px' }}>WordPress — top of <code>functions.php</code></p>
          <pre className="file-preview" style={{ maxHeight: 120 }}>{`if ($_SERVER['REQUEST_URI'] === '/${site.indexNowKey}.txt') {
    header('Content-Type: text/plain');
    echo '${site.indexNowKey}';
    exit;
}`}</pre>
        </div>
      </details>

      <details className="key-guide">
        <summary><span className="key-guide-label">Nginx / reverse proxy (best for many sites)</span></summary>
        <div className="key-guide-body">
          <p className="text-dim" style={{ fontSize: 12 }}>
            One location block on every site forwards key requests to this container — verification passes for all sites, forever:
          </p>
          <pre className="file-preview" style={{ maxHeight: 110 }}>{`# Forward IndexNow key queries dynamically
location ~ ^/[a-f0-9]{32}\\.txt$ {
    proxy_pass http://<your-indexer-container-ip>:3000;
}`}</pre>
        </div>
      </details>

      <details className="key-guide">
        <summary><span className="key-guide-label">Cloudflare redirect rule</span></summary>
        <div className="key-guide-body">
          <ol className="key-guide-steps">
            <li>Cloudflare → your site → <strong>Rules → Redirect Rules</strong> → Create</li>
            <li>Expression: <code>(http.request.uri.path eq "/{site.indexNowKey}.txt")</code></li>
            <li>Static redirect → <code>https://YOUR_INDEXER_PUBLIC_URL/{site.indexNowKey}.txt</code> (302)</li>
          </ol>
          <p className="text-dim" style={{ fontSize: 12 }}>Search engines follow redirects when fetching key files.</p>
        </div>
      </details>
    </div>
  );
}

// ── Configuration tab: identity + account (inline, replaces Edit modal) ───────

function ConfigTab({ site, accounts, onSaved }: { site: Site; accounts: GoogleAccount[]; onSaved: () => void }) {
  const [name, setName] = useState(site.name);
  const [domain, setDomain] = useState(site.domain);
  const [sitemapUrl, setSitemapUrl] = useState(site.sitemap_url);
  const [gscUrl, setGscUrl] = useState(site.gsc_url);
  const [googleAccountId, setGoogleAccountId] = useState(site.google_account_id || '');
  const [bingAccountId, setBingAccountId] = useState(site.bing_account_id || '');
  const [bingAccounts, setBingAccounts] = useState<BingAccount[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { api.getBingAccounts().then(setBingAccounts).catch(() => setBingAccounts([])); }, []);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const result = await api.updateSite(site.id, {
        name,
        domain,
        sitemap_url: sitemapUrl,
        gsc_url: gscUrl,
        googleAccountId: googleAccountId || null,
        bing_account_id: bingAccountId || null,
      });
      // Round-trip check: the backend echoes the persisted row.
      const persisted = result.site?.google_account_id ?? null;
      const expected = googleAccountId || null;
      if (result.site && persisted !== expected) {
        throw new Error(`Save did not persist (expected account "${expected ?? 'none'}", got "${persisted ?? 'none'}"). Please retry.`);
      }
      setMsg({ ok: true, text: 'Saved.' });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: String(e).replace('Error: ', '') });
    }
    setSaving(false);
  }

  return (
    <div className="site-form">
      <div className="site-form-grid">
        <div className="input-group">
          <label className="input-label">Site Name</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="input-group">
          <label className="input-label">Domain</label>
          <input className="input" value={domain} onChange={e => setDomain(e.target.value)} />
        </div>
      </div>
      <div className="input-group">
        <label className="input-label">Sitemap URL</label>
        <input className="input" value={sitemapUrl} onChange={e => setSitemapUrl(e.target.value)} />
        <span className="input-hint">Sitemaps declared in robots.txt (e.g. llms-sitemap.xml) are discovered automatically on every run.</span>
      </div>
      <div className="input-group">
        <label className="input-label">Search Console Property</label>
        <input className="input" value={gscUrl} onChange={e => setGscUrl(e.target.value)} />
        <span className="input-hint">"sc-domain:example.com" for domain properties; full URL for URL-prefix properties.</span>
      </div>
      <div className="input-group">
        <label className="input-label">Google Account</label>
        <select className="input" value={googleAccountId} onChange={e => setGoogleAccountId(e.target.value)}>
          <option value="">None (IndexNow Only)</option>
          {accounts.map(acc => (
            <option key={acc.id} value={acc.id}>{acc.email || `Account (${acc.id.slice(0, 8)})`}</option>
          ))}
        </select>
      </div>
      <div className="input-group">
        <label className="input-label">Bing Account</label>
        <select className="input" value={bingAccountId} onChange={e => setBingAccountId(e.target.value)}>
          <option value="">Workspace default (first Bing account)</option>
          {bingAccounts.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <span className="input-hint">Which Bing Webmaster key this site submits through. Manage keys in Settings → Workspace.</span>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary btn-sm" disabled={saving || !name || !domain || !sitemapUrl || !gscUrl} onClick={save}>
          {saving ? <><span className="spinner" /> Saving…</> : 'Save Configuration'}
        </button>
        {msg && <span style={{ fontSize: 12, color: msg.ok ? 'var(--ok)' : 'var(--error)' }}>{msg.text}</span>}
      </div>
    </div>
  );
}

// ── Delivery & GEO tab: FTP/webhook + managed vs monitor-only ─────────────────

// AI-generated llms.txt: gather the site's real pages and have a configured LLM
// write a comprehensive, spec-compliant manifest. Editable + saved per site.
function AiLlmsSection({ site, onSaved }: { site: Site; onSaved: () => void }) {
  const [content, setContent] = useState(site.llms_txt_content || '');
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [meta, setMeta] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.getLlmsAudit(site.id).then(a => { setAiProvider(a.aiProvider); if (a.custom) setContent(a.custom); }).catch(() => null);
  }, [site.id]);

  async function generate() {
    setGenerating(true); setMsg(null); setMeta(null);
    try {
      const r = await api.generateLlms(site.id);
      setContent(r.content);
      setMeta(`Generated with ${r.provider} (${r.model}) from ${r.pagesScanned} pages. Review, edit, then Save.`);
    } catch (e) {
      setMsg({ ok: false, text: String(e).replace('Error: ', '') });
    }
    setGenerating(false);
  }
  async function save() {
    setSaving(true); setMsg(null);
    try { await api.saveLlms(site.id, content); setMsg({ ok: true, text: 'Saved. This llms.txt will be deployed (managed mode).' }); onSaved(); }
    catch (e) { setMsg({ ok: false, text: String(e).replace('Error: ', '') }); }
    setSaving(false);
  }

  return (
    <div className="ai-llms">
      <h4 className="panel-title" style={{ marginTop: 20 }}><Sparkles size={13} /> llms.txt content</h4>
      <p className="text-dim" style={{ fontSize: 12, marginBottom: 10 }}>
        {aiProvider
          ? <>Generate a rich, spec-compliant <code>llms.txt</code> from your site's real pages using your <strong>{aiProvider}</strong> key, or write your own below. When set, this is what gets deployed (an <code>llms-sitemap.xml</code> is deployed alongside).</>
          : <>Write your <code>llms.txt</code> below, or add an AI provider key (Settings → API Keys) to generate one automatically from your site's pages.</>}
      </p>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <button className="btn btn-primary btn-sm" disabled={generating || !aiProvider} onClick={generate} title={aiProvider ? undefined : 'Add an OpenAI/Anthropic/Gemini/xAI/Perplexity key first'}>
          {generating ? <><Loader2 className="spin" size={13} /> Generating…</> : <><Sparkles size={13} /> Generate with AI</>}
        </button>
        {content && (
          <button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
          </button>
        )}
      </div>
      {meta && <div className="text-dim" style={{ fontSize: 12, marginBottom: 6 }}>{meta}</div>}
      <textarea
        className="input"
        style={{ minHeight: 240, fontFamily: 'JetBrains Mono, monospace', fontSize: 12, lineHeight: 1.5, resize: 'vertical' }}
        placeholder={'# Your Site\n\n> One-line summary of what your site is.\n\n## Docs\n- [Page title](https://example.com/page): what it covers.'}
        value={content}
        onChange={e => setContent(e.target.value)}
      />
      <div className="flex items-center gap-3 mt-2">
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>
          {saving ? <><Loader2 className="spin" size={13} /> Saving…</> : <><Save size={13} /> Save llms.txt</>}
        </button>
        {content && (
          <button className="btn btn-secondary btn-sm" disabled={saving} onClick={() => { setContent(''); api.saveLlms(site.id, '').then(() => { setMsg({ ok: true, text: 'Cleared — will fall back to the built-in template.' }); onSaved(); }); }}>
            Clear
          </button>
        )}
        {msg && <span style={{ fontSize: 12, color: msg.ok ? 'var(--ok)' : 'var(--error)' }}>{msg.text}</span>}
      </div>
    </div>
  );
}

function DeliveryTab({ site, onSaved }: { site: Site; onSaved: () => void }) {
  const [deployWebhookUrl, setDeployWebhookUrl] = useState(site.deploy_webhook_url || '');
  const [ftpHost, setFtpHost] = useState(site.ftp_host || '');
  const [ftpPort, setFtpPort] = useState(site.ftp_port || 21);
  const [ftpUser, setFtpUser] = useState(site.ftp_user || '');
  const [ftpPass, setFtpPass] = useState(site.ftp_pass || '');
  const [ftpPath, setFtpPath] = useState(site.ftp_path || '');
  const [geoManage, setGeoManage] = useState(!!site.geo_manage);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      await api.updateSite(site.id, {
        deploy_webhook_url: deployWebhookUrl || null,
        ftp_host: ftpHost || null,
        ftp_port: ftpPort ? Number(ftpPort) : 21,
        ftp_user: ftpUser || null,
        ftp_pass: ftpPass || null,
        ftp_path: ftpPath || null,
        geo_manage: geoManage ? 1 : 0,
      });
      setMsg({ ok: true, text: 'Saved.' });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: String(e).replace('Error: ', '') });
    }
    setSaving(false);
  }

  return (
    <div className="site-form">
      <h4 className="panel-title">GEO files — who owns llms.txt &amp; robots.txt?</h4>
      <label className="geo-mode-option">
        <input type="radio" name={`geo-${site.id}`} checked={!geoManage} onChange={() => setGeoManage(false)} />
        <div>
          <strong>Monitor-only</strong> <span className="badge badge-ok">recommended for hand-written files</span>
          <div className="text-dim" style={{ fontSize: 12 }}>
            Your live files are the source of truth. The tool lints and freshness-checks them but <strong>never deploys</strong>.
            Differences from the generated baseline are expected and never alerted.
          </div>
        </div>
      </label>
      <label className="geo-mode-option">
        <input type="radio" name={`geo-${site.id}`} checked={geoManage} onChange={() => setGeoManage(true)} />
        <div>
          <strong>Managed by this tool</strong>
          <div className="text-dim" style={{ fontSize: 12 }}>
            The tool generates robots.txt + llms.txt and deploys them on every run using the method below.
            <strong> Overwrites whatever is live.</strong> Drift raises alerts.
          </div>
        </div>
      </label>

      <AiLlmsSection site={site} onSaved={onSaved} />

      <h4 className="panel-title" style={{ marginTop: 16 }}>
        <UploadCloud size={13} /> Delivery method
        <span className="text-dim" style={{ fontWeight: 400, fontSize: 12, marginLeft: 6 }}>
          used for IndexNow key files{geoManage ? ' and GEO file deploys' : ''}
        </span>
      </h4>
      <div className="input-group">
        <label className="input-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Deploy Webhook URL</span>
          <InfoTooltip content="POST with JSON { key, filename, content } — lets headless CMS / Jamstack pipelines write the file." label="ⓘ" position="top" />
        </label>
        <input className="input" placeholder="https://api.yourhosting.com/deploy" value={deployWebhookUrl} onChange={e => setDeployWebhookUrl(e.target.value)} />
      </div>
      <div className="site-form-grid">
        <div className="input-group">
          <label className="input-label">FTP Host</label>
          <input className="input" placeholder="ftp.example.com" value={ftpHost} onChange={e => setFtpHost(e.target.value)} />
        </div>
        <div className="input-group">
          <label className="input-label">FTP Port</label>
          <input className="input" type="number" value={ftpPort || 21} onChange={e => setFtpPort(Number(e.target.value))} />
        </div>
        <div className="input-group">
          <label className="input-label">FTP Username</label>
          <input className="input" value={ftpUser} onChange={e => setFtpUser(e.target.value)} />
        </div>
        <div className="input-group">
          <label className="input-label">FTP Password</label>
          <input className="input" type="password" placeholder="••••••••" value={ftpPass} onChange={e => setFtpPass(e.target.value)} />
        </div>
      </div>
      <div className="input-group">
        <label className="input-label">FTP Remote Path</label>
        <input className="input" placeholder="/public_html/" value={ftpPath} onChange={e => setFtpPath(e.target.value)} />
        <span className="input-hint">Your site's public document root (e.g. /public_html/ or /www/).</span>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>
          {saving ? <><span className="spinner" /> Saving…</> : 'Save Delivery & GEO'}
        </button>
        {msg && <span style={{ fontSize: 12, color: msg.ok ? 'var(--ok)' : 'var(--error)' }}>{msg.text}</span>}
      </div>
    </div>
  );
}

// ── Danger tab ────────────────────────────────────────────────────────────────

function DangerTab({ site, onDeleted }: { site: Site; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  async function del() {
    if (!confirm(`Delete ${site.domain}? All stored URL state, stats and citation history for this site will be lost.`)) return;
    setDeleting(true);
    try {
      await api.deleteSite(site.id);
      onDeleted();
    } catch { /* surfaced by list refresh */ }
    setDeleting(false);
  }
  return (
    <div>
      <div className="empty-note" style={{ borderColor: 'var(--error)', marginBottom: 12 }}>
        <AlertTriangle size={12} /> Deleting removes the site and all its URL state, daily stats and alerts. This cannot be undone.
      </div>
      <button className="btn btn-danger btn-sm" disabled={deleting} onClick={del}>
        {deleting ? <><span className="spinner" /> Deleting…</> : <><Trash2 size={12} /> Delete this site</>}
      </button>
    </div>
  );
}

// ── Site detail: tabbed panel ─────────────────────────────────────────────────

type SiteTab = 'overview' | 'indexnow' | 'config' | 'delivery' | 'danger';

const SITE_TABS: Array<{ id: SiteTab; label: string; icon: typeof Globe2 }> = [
  { id: 'overview', label: 'Overview',      icon: Globe2 },
  { id: 'indexnow', label: 'IndexNow',      icon: KeyRound },
  { id: 'config',   label: 'Configuration', icon: Settings2 },
  { id: 'delivery', label: 'Delivery & GEO', icon: UploadCloud },
  { id: 'danger',   label: 'Danger',        icon: AlertTriangle },
];

function SiteDetail({ site, accounts, onChanged, onDeleted }: {
  site: Site;
  accounts: GoogleAccount[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [tab, setTab] = useState<SiteTab>('overview');
  return (
    <div className="panel site-detail">
      <div className="settings-tabs" style={{ marginBottom: 14 }}>
        {SITE_TABS.map(t => (
          <button key={t.id} className={`settings-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>
      {tab === 'overview' && <OverviewTab site={site} accounts={accounts} />}
      {tab === 'indexnow' && <IndexNowTab site={site} />}
      {tab === 'config'   && <ConfigTab site={site} accounts={accounts} onSaved={onChanged} />}
      {tab === 'delivery' && <DeliveryTab site={site} onSaved={onChanged} />}
      {tab === 'danger'   && <DangerTab site={site} onDeleted={onDeleted} />}
    </div>
  );
}

// ── Sites page ────────────────────────────────────────────────────────────────

export default function SitesPage() {
  const { sites, refresh } = useApp();
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    api.getAccounts().then(setAccounts).catch(() => null);
  }, []);

  const selectedSite = sites.find(s => s.id === selected);

  return (
    <div>
      <div className="page-header flex items-center justify-between">
        <div>
          <h1 className="page-title">Sites</h1>
          <p className="page-subtitle">Select a site to manage indexing, verification and delivery</p>
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
        <>
          <div className="table-scroll" style={{ marginBottom: 14 }}>
            <table className="mini-table sites-table">
              <thead>
                <tr>
                  <th>Site</th>
                  <th>Account</th>
                  <th>IndexNow</th>
                  <th>GEO files</th>
                  <th>AI access</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sites.map(site => (
                  <tr
                    key={site.id}
                    className={selected === site.id ? 'row-active' : ''}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelected(selected === site.id ? null : site.id)}
                  >
                    <td>
                      <div style={{ fontWeight: 700 }}>{site.name}</div>
                      <div className="text-dim" style={{ fontSize: 12 }}>{site.domain}</div>
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {site.google_account_id
                        ? (accounts.find(a => a.id === site.google_account_id)?.email ?? 'Unknown')
                        : <span className="text-dim">IndexNow only</span>}
                    </td>
                    <td>
                      {site.indexNowVerified
                        ? <span className="badge badge-ok">verified</span>
                        : <span className="badge badge-warn">setup needed</span>}
                    </td>
                    <td>
                      <span className="badge">{site.geo_manage ? 'managed' : 'monitor-only'}</span>
                    </td>
                    <td>
                      {site.robots_txt_status
                        ? <span className={`badge ${site.robots_txt_status === 'ALLOWED' ? 'badge-ok' : 'badge-warn'}`}>robots {site.robots_txt_status.toLowerCase()}</span>
                        : <span className="text-dim" style={{ fontSize: 12 }}>—</span>}
                      {' '}
                      {site.llms_txt_status
                        ? <span className={`badge ${site.llms_txt_status === 'OK' ? 'badge-ok' : 'badge-warn'}`}>llms {site.llms_txt_status.toLowerCase()}</span>
                        : null}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <ChevronRight size={14} className="text-dim" style={{ transform: selected === site.id ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedSite && (
            <SiteDetail
              key={selectedSite.id}
              site={selectedSite}
              accounts={accounts}
              onChanged={refresh}
              onDeleted={() => { setSelected(null); refresh(); }}
            />
          )}
        </>
      )}
    </div>
  );
}
