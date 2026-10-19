import { useCallback, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, Cloud, Copy, ExternalLink, KeyRound, Link2, Plus, Scale, Zap } from 'lucide-react';
import { useToast } from '../AppContext';
import { McpConnect } from '../components/McpConnect';
import { adsApi, errorMessage, type AdsAccount, type AdsConnectionStatus, type AdsSetup } from './api';
import { openGoogleConsent, useGoogleAuthSuccess } from './googleConnect';
import { LinkAccountsModal } from './AdsClients';

const API_LABEL: Record<string, { text: string; tone: 'ok' | 'warn' | 'error' | 'info' }> = {
  ok: { text: 'Ready', tone: 'ok' },
  no_scope: { text: 'No Google Ads access', tone: 'warn' },
  api_disabled: { text: 'API not enabled', tone: 'error' },
  access_level: { text: 'Test access only', tone: 'error' },
  needs_reauth: { text: 'Reconnect required', tone: 'error' },
  error: { text: 'Check failed', tone: 'warn' },
  unchecked: { text: 'Not checked', tone: 'info' },
};

export function AdsSetupView({ setup, accounts, canManage, reload, onLinked }: {
  setup: AdsSetup | null; accounts: AdsAccount[]; canManage: boolean; reload: (fresh?: boolean) => Promise<void>; onLinked: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [autoSetup, setAutoSetup] = useState(true);
  const [custom, setCustom] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [linking, setLinking] = useState(false);
  const redirectUri = `${window.location.origin}/api/auth/google/callback`;

  const refreshAfterConsent = useCallback(() => { void reload(true); }, [reload]);
  useGoogleAuthSuccess(refreshAfterConsent);

  function copy(value: string) {
    navigator.clipboard.writeText(value);
    toast('success', 'Copied to clipboard');
  }

  async function connect(accountId?: string) {
    setBusy(accountId ?? 'new');
    try {
      const useCustom = !accountId && (custom || !setup?.builtin_oauth_client);
      if (useCustom && (!clientId.trim() || !clientSecret.trim())) throw new Error('Enter the OAuth client ID and secret from your Google Cloud project first.');
      await openGoogleConsent({
        accountId, ads: true, autoSetup,
        ...(useCustom ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() } : {}),
      });
    } catch (e) {
      toast('error', errorMessage(e));
    }
    setBusy(null);
  }

  async function enableApi(conn: AdsConnectionStatus) {
    setBusy(`enable:${conn.id}`);
    try {
      const result = await adsApi.enableApi(conn.id);
      toast(result.ok ? 'success' : 'warning', result.message);
      await reload(true);
    } catch (e) {
      toast('error', errorMessage(e));
    }
    setBusy(null);
  }

  if (!setup) return <div className="page-loading">Checking your Google Ads setup…</div>;
  const s = setup.steps;
  const steps = [
    { done: s.google_connected && s.ads_scope, title: 'Connect Google with Google Ads access', detail: 'Sign in with the Google user that manages your clients (ideally the one on your manager account).' },
    { done: s.api_enabled, title: `Enable the Google Ads API${setup.project ? ` on project ${setup.project}` : ''}`, detail: 'Done automatically when you allow Cloud access while connecting, or with one click below.' },
    { done: s.production_access, title: 'Production API access (Explorer or Basic)', detail: 'New Cloud projects start on Test access, which only reaches test accounts. Apply once per project.' },
    { done: s.accounts_linked, title: 'Link your clients\' ad accounts', detail: 'Accounts under your manager account are found automatically.' },
    { done: s.budgets_set, title: 'Set each client\'s monthly budget and guardrails', detail: 'The AI can only raise spend inside these limits; everything else waits for your approval.' },
  ];

  return (
    <div className="ads-setup">
      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">Checklist</span><h2>{setup.ready && s.accounts_linked ? 'Google Ads is ready' : 'Get Google Ads ready'}</h2></div>
          <button className="btn btn-ghost btn-sm" onClick={() => reload(true)}>Re-check</button>
        </div>
        <ol className="ads-checklist">
          {steps.map((step, index) => (
            <li key={step.title} className={step.done ? 'done' : index === steps.findIndex(s => !s.done) ? 'current' : ''}>
              {step.done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
              <span><strong>{step.title}</strong><small>{step.detail}</small></span>
            </li>
          ))}
        </ol>
      </section>

      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">Google connections</span><h2>Who the app signs in to Google as</h2></div>
        </div>
        <div className="ads-connection-list">
          {setup.connections.map(conn => {
            const api = API_LABEL[conn.api] ?? API_LABEL.unchecked;
            const access = API_LABEL[conn.access] ?? API_LABEL.unchecked;
            return (
              <article key={conn.id}>
                <div className="ads-connection-main">
                  <strong>{conn.email ?? conn.id}</strong>
                  <small>Cloud project {conn.project ?? 'unknown'}{conn.accessible_customers !== null ? ` · ${conn.accessible_customers} directly accessible ad account(s)` : ''}</small>
                  <div className="ads-badges">
                    <span className={`badge badge-${conn.has_ads_scope ? 'ok' : 'warn'}`}>{conn.has_ads_scope ? 'Google Ads access' : 'No Google Ads access'}</span>
                    {conn.has_ads_scope && <span className={`badge badge-${api.tone}`}>API: {api.text}</span>}
                    {conn.has_ads_scope && conn.api === 'ok' && <span className={`badge badge-${access.tone}`}>Access level: {access.text}</span>}
                    {conn.has_cloud_scope && <span className="badge badge-info">Cloud access</span>}
                  </div>
                  {(conn.message || conn.hint) && conn.api !== 'no_scope' && <p className="ads-hint">{conn.message}{conn.hint ? ` — ${conn.hint}` : ''}</p>}
                </div>
                <div className="ads-connection-actions">
                  {(!conn.has_ads_scope || conn.needs_reauth) && (
                    <button className="btn btn-primary btn-sm" disabled={!canManage || busy === conn.id} onClick={() => connect(conn.id)}>
                      <KeyRound size={13} /> {conn.needs_reauth ? 'Reconnect' : 'Add Google Ads access'}
                    </button>
                  )}
                  {conn.api === 'api_disabled' && conn.has_cloud_scope && (
                    <button className="btn btn-secondary btn-sm" disabled={!canManage || busy === `enable:${conn.id}`} onClick={() => enableApi(conn)}><Zap size={13} /> Enable automatically</button>
                  )}
                  {conn.api === 'api_disabled' && <a className="btn btn-ghost btn-sm" href={`https://console.cloud.google.com/apis/library/googleads.googleapis.com?project=${conn.project ?? ''}`} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Cloud console</a>}
                  {conn.access === 'access_level' && <a className="btn btn-secondary btn-sm" href={`https://console.cloud.google.com/google/ads-apis/overview?project=${conn.project ?? ''}`} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Apply for access</a>}
                </div>
              </article>
            );
          })}
          {!setup.connections.length && <div className="ops-empty compact">No Google account is connected to this workspace yet.</div>}
        </div>

        <div className="ads-connect-new">
          <label className="autosetup-row">
            <input type="checkbox" checked={autoSetup} onChange={e => setAutoSetup(e.target.checked)} />
            <div>
              <strong>Let the app enable the Google APIs it needs</strong>
              <div className="text-dim">Asks Google for Cloud access so the Google Ads, Search Console, Indexing and Analytics APIs are switched on for you. Managed Google Workspace accounts may then need to sign in again periodically — untick to enable APIs by hand instead.</div>
            </div>
          </label>
          {setup.builtin_oauth_client && (
            <label className="ads-inline-check">
              <input type="checkbox" checked={custom} onChange={e => setCustom(e.target.checked)} /> Use a different Google Cloud project (a client's own OAuth client)
            </label>
          )}
          {(custom || !setup.builtin_oauth_client) && (
            <div className="form-grid">
              <label>OAuth client ID<input className="input" value={clientId} onChange={e => setClientId(e.target.value)} placeholder="1234567890-abc….apps.googleusercontent.com" /></label>
              <label>OAuth client secret<input className="input" type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder="GOCSPX-…" /></label>
            </div>
          )}
          <div className="ads-row-actions">
            <button className="btn btn-primary" disabled={!canManage || busy === 'new'} onClick={() => connect()}><Plus size={14} /> Connect a Google account with Google Ads</button>
            {setup.connections.some(c => c.has_ads_scope) && (
              <button className="btn btn-secondary" disabled={!canManage} onClick={() => setLinking(true)}><Link2 size={14} /> Find and link client accounts</button>
            )}
          </div>
          <p className="ads-hint">Already connected for Search Console? Use <b>Add Google Ads access</b> on that connection above — it keeps its existing permissions and sites.</p>
        </div>
      </section>

      <details className="ops-card ads-guide" open={!setup.builtin_oauth_client && !setup.connections.length}>
        <summary><Cloud size={15} /> One-time Google Cloud setup (only if you run your own OAuth client)</summary>
        <ol className="ads-guide-steps">
          <li>
            <strong>Create or pick a Google Cloud project and link billing.</strong>
            <span>Billing must be a paid account: Google currently rejects Google Ads API access for projects on the Free Trial.</span>
            <span className="ads-links"><a href={setup.links.new_project} target="_blank" rel="noreferrer">New project <ExternalLink size={12} /></a><a href={setup.links.billing} target="_blank" rel="noreferrer">Billing <ExternalLink size={12} /></a></span>
          </li>
          <li>
            <strong>Enable the APIs.</strong> Paste this into Cloud Shell (top-right terminal icon in the Cloud console):
            <CopyBlock value={`gcloud services enable googleads.googleapis.com searchconsole.googleapis.com indexing.googleapis.com analyticsdata.googleapis.com --project ${setup.project ?? 'YOUR_PROJECT_ID'}`} onCopy={copy} />
            <span>Or skip this and tick “Let the app enable the Google APIs it needs” when connecting.</span>
          </li>
          <li>
            <strong>Configure the consent screen</strong> (Google Auth Platform → Branding, Audience). Choose <b>Internal</b> if everyone uses your Google Workspace; otherwise <b>External</b> and click <b>Publish app</b> — apps left in Testing get refresh tokens that expire after seven days.
            <span className="ads-links"><a href={setup.links.oauth_consent} target="_blank" rel="noreferrer">Google Auth Platform <ExternalLink size={12} /></a></span>
          </li>
          <li>
            <strong>Create an OAuth client</strong> (Clients → Create client → Web application) with this authorised redirect URI. Google has no API for creating these, so this is the one step that can't be automated.
            <CopyBlock value={redirectUri} onCopy={copy} />
            <span>Paste the client ID and secret above, or set <code>GOOGLE_OAUTH_CLIENT_ID</code> and <code>GOOGLE_OAUTH_CLIENT_SECRET</code> on the container so every user gets one-click sign-in.</span>
            <span className="ads-links"><a href={setup.links.credentials} target="_blank" rel="noreferrer">Credentials <ExternalLink size={12} /></a></span>
          </li>
          <li>
            <strong>Apply for Google Ads API access</strong> on the Google Ads API overview page of the same project. <b>Explorer</b> is approved quickly (2,880 operations a day, no Keyword Planner); <b>Basic</b> needs brand verification (15,000 a day, includes keyword ideas). Developer tokens are no longer used.
            <span className="ads-links"><a href={setup.links.access_level} target="_blank" rel="noreferrer">Google Ads API access <ExternalLink size={12} /></a></span>
          </li>
        </ol>
      </details>

      <section className="ops-card ads-policy">
        <Scale size={18} />
        <div>
          <strong>Stay inside Google's API policy</strong>
          <p>Use your own Google Cloud project and reach clients through your own manager (MCC) account — that is your own use of the API. Don't let clients sign in to this install with their own Google accounts on your project; if a client wants direct access, connect them with their own OAuth client (“Use a different Google Cloud project”) or give them their own install.</p>
        </div>
      </section>

      <McpConnect compact />

      {accounts.length === 0 && setup.connections.some(c => c.has_ads_scope) && !linking && (
        <div className="alert alert-info"><AlertTriangle size={14} /><div className="alert-content">Next: link the client accounts you manage — <button className="link-button" onClick={() => setLinking(true)}>find accounts</button>.</div></div>
      )}
      {linking && <LinkAccountsModal onClose={() => setLinking(false)} onLinked={async () => { setLinking(false); await reload(true); onLinked(); }} />}
    </div>
  );
}

function CopyBlock({ value, onCopy }: { value: string; onCopy: (value: string) => void }) {
  return (
    <div className="mcp-copy-row">
      <code>{value}</code>
      <button className="btn-icon btn-icon-ghost" aria-label="Copy" onClick={() => onCopy(value)}><Copy size={13} /></button>
    </div>
  );
}
