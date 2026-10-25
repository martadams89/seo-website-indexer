import { useCallback, useState } from 'react';
import { CheckCircle2, Circle, Copy, ExternalLink, KeyRound, Link2, Plus, ShieldCheck, Zap } from 'lucide-react';
import { useToast } from '../AppContext';
import { McpConnect } from '../components/McpConnect';
import { errorMessage } from '../ads/api';
import { openApiEnable, openGoogleConsent, useApisEnabled, useGoogleAuthSuccess } from '../ads/googleConnect';
import { reviewsApi, type ConnectionStatus, type ReviewsSetup } from './api';
import { LinkLocationsModal } from './ReviewsLocations';

const API_LABEL: Record<ConnectionStatus['api'], { text: string; tone: 'ok' | 'warn' | 'error' | 'info' }> = {
  ok: { text: 'Ready', tone: 'ok' },
  no_scope: { text: 'No Business Profile access', tone: 'warn' },
  api_disabled: { text: 'APIs not enabled', tone: 'error' },
  not_approved: { text: 'Waiting for Google approval', tone: 'warn' },
  needs_reauth: { text: 'Reconnect required', tone: 'error' },
  error: { text: 'Check failed', tone: 'warn' },
  unchecked: { text: 'Not checked', tone: 'info' },
};

const BUSINESS_SERVICES = ['mybusinessaccountmanagement.googleapis.com', 'mybusinessbusinessinformation.googleapis.com', 'mybusiness.googleapis.com', 'businessprofileperformance.googleapis.com'];

export function ReviewsSetupView({ setup, canManage, reload, onLinked }: {
  setup: ReviewsSetup | null; canManage: boolean; reload: (fresh?: boolean) => Promise<void>; onLinked: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  // Off by default: Cloud access puts Workspace accounts under Google Cloud
  // session control, which forces them to sign in again every few hours.
  const [autoSetup, setAutoSetup] = useState(false);
  // A Business Profile project Google approved separately: its own OAuth client, and only the Business Profile scope.
  const [ownProject, setOwnProject] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [businessOnly, setBusinessOnly] = useState(false);
  const redirectUri = `${window.location.origin}/api/auth/google/callback`;
  const refreshAfterConsent = useCallback(() => { void reload(true); }, [reload]);
  useGoogleAuthSuccess(refreshAfterConsent);
  useApisEnabled(useCallback(result => {
    toast(result.ok ? 'success' : 'warning', result.ok
      ? 'Business Profile APIs switched on. Google can take a few minutes to apply it.'
      : `Couldn't switch on ${result.skipped.join(', ') || 'the APIs'}. Your Google user needs the Service Usage Admin (or Owner/Editor) role on the project.`);
    void reload(true);
  }, [reload, toast]));

  function copy(value: string) {
    navigator.clipboard.writeText(value);
    toast('success', 'Copied to clipboard');
  }

  async function connect(accountId?: string) {
    setBusy(accountId ?? 'new');
    try {
      const custom = !accountId && (ownProject || !setup?.builtin_oauth_client);
      if (custom && (!clientId.trim() || !clientSecret.trim())) throw new Error('Enter the OAuth client ID and secret from the Business Profile Cloud project first.');
      await openGoogleConsent({
        accountId, business: true, autoSetup,
        ...(accountId ? {} : { businessOnly }),
        ...(custom ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() } : {}),
      });
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(null);
  }

  async function enableApis(conn: ConnectionStatus) {
    setBusy(`enable:${conn.id}`);
    try {
      if (conn.has_cloud_scope) {
        const result = await reviewsApi.enableApi(conn.id);
        toast(result.ok ? 'success' : 'warning', result.message);
        await reload(true);
      } else {
        // One-off sign-in; the popup reports back through useApisEnabled.
        await openApiEnable(conn.id, BUSINESS_SERVICES);
      }
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(null);
  }

  if (!setup) return <div className="page-loading">Checking your Business Profile setup…</div>;
  const s = setup.steps;
  const steps = [
    { done: s.google_connected && s.business_scope, title: 'Connect Google with Business Profile access', detail: 'Sign in as a Google user who is an owner or manager of your clients\' Business Profiles.' },
    { done: s.api_enabled, title: `Enable the Business Profile APIs${setup.project ? ` on project ${setup.project}` : ''}`, detail: 'One click below (a one-off Google sign-in; the saved connection keeps no Cloud access), or by hand in the Cloud console.' },
    { done: s.access_approved, title: 'Get the project approved by Google', detail: 'Google only serves these APIs to approved projects. Apply once; approval usually takes a few days.' },
    { done: s.locations_linked, title: 'Link your clients\' locations', detail: 'Every location the connected users manage is listed for you to pick.' },
  ];
  const waiting = setup.connections.filter(c => c.api === 'not_approved');
  // One entry per Cloud project waiting for Google, or the main project before anything has been checked.
  const approvals = waiting.length
    ? [...new Map(waiting.map(c => [c.project ?? c.id, c])).values()].map(c => ({ project: c.project, links: c.links }))
    : !s.access_approved && s.api_enabled ? [{ project: setup.project, links: setup.links }] : [];

  return (
    <div className="ads-setup">
      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">Checklist</span><h2>{setup.ready ? 'Business Profile is ready' : 'Get Business Profile ready'}</h2></div>
          <button className="btn btn-ghost btn-sm" onClick={() => reload(true)}>Re-check</button>
        </div>
        <ol className="ads-checklist">
          {steps.map((step, index) => (
            <li key={step.title} className={step.done ? 'done' : index === steps.findIndex(x => !x.done) ? 'current' : ''}>
              {step.done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
              <span><strong>{step.title}</strong><small>{step.detail}</small></span>
            </li>
          ))}
        </ol>
      </section>

      {approvals.map(({ project, links }) => (
        <section key={project ?? 'project'} className="ops-card reviews-approval">
          <div className="ops-card-head"><div><span className="eyebrow">Google approval</span><h2>Apply for Business Profile API access</h2></div><ShieldCheck size={18} /></div>
          <ol className="ads-guide-steps">
            <li><strong>Check you're eligible.</strong> <span>Google wants a Business Profile that has been verified and active for at least 60 days, with a website listed on it. It can be your agency's own profile or a client's you manage.</span></li>
            <li><strong>Open the request form</strong> and choose <b>Application for Basic API Access</b>. Send it from an email address that is an owner or manager on that Business Profile, ideally on the same domain as its website.
              <span className="ads-links"><a href={links.access_form} target="_blank" rel="noreferrer">Business Profile API request form <ExternalLink size={12} /></a></span>
            </li>
            <li><strong>Give this Cloud project number:</strong>
              <span className="mcp-copy-row"><code>{project ?? 'unknown'}</code><button className="btn-icon btn-icon-ghost" aria-label="Copy project number" onClick={() => copy(project ?? '')}><Copy size={13} /></button></span>
            </li>
            <li><strong>Wait for Google's email.</strong> <span>Approval shows as a 300 requests-per-minute quota on the project (0 means not approved yet). Then click Re-check above.</span>
              <span className="ads-links"><a href={links.quotas} target="_blank" rel="noreferrer">Check the quota <ExternalLink size={12} /></a></span>
            </li>
            <li><strong>Already approved on another project?</strong> <span>Connect through that project instead (below), then move your locations onto it from the Locations tab.</span></li>
          </ol>
        </section>
      ))}

      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">Google connections</span><h2>Who the app signs in to Google as</h2></div>
        </div>
        <div className="ads-connection-list">
          {setup.connections.map(conn => {
            const api = API_LABEL[conn.api] ?? API_LABEL.unchecked;
            return (
              <article key={conn.id}>
                <div className="ads-connection-main">
                  <strong>{conn.email ?? conn.id}</strong>
                  <small>Cloud project {conn.project ?? 'unknown'}{conn.accounts !== null ? ` · ${conn.accounts} Business Profile account(s)` : ''}{conn.locations ? ` · used by ${conn.locations} linked location${conn.locations === 1 ? '' : 's'}` : ''}</small>
                  <div className="ads-badges">
                    <span className={`badge badge-${conn.has_business_scope ? 'ok' : 'warn'}`}>{conn.has_business_scope ? 'Business Profile access' : 'No Business Profile access'}</span>
                    {conn.business_only && <span className="badge badge-accent" title="This connection asked Google for Business Profile only">Business Profile only</span>}
                    {conn.has_business_scope && <span className={`badge badge-${api.tone}`}>API: {api.text}</span>}
                    {conn.has_cloud_scope && <span className="badge badge-info">Cloud access</span>}
                  </div>
                  {(conn.message || conn.hint) && conn.api !== 'no_scope' && conn.api !== 'not_approved' && <p className="ads-hint">{conn.message}{conn.hint ? ` — ${conn.hint}` : ''}</p>}
                </div>
                <div className="ads-connection-actions">
                  {(!conn.has_business_scope || conn.needs_reauth || conn.api === 'needs_reauth') && (
                    <button className="btn btn-primary btn-sm" disabled={!canManage || busy === conn.id} onClick={() => connect(conn.id)}>
                      <KeyRound size={13} /> {conn.needs_reauth || conn.api === 'needs_reauth' ? 'Reconnect' : 'Add Business Profile access'}
                    </button>
                  )}
                  {conn.api === 'api_disabled' && (
                    <button className="btn btn-secondary btn-sm" disabled={!canManage || busy === `enable:${conn.id}`} onClick={() => enableApis(conn)} title="Switches the APIs on with a one-off Google sign-in; the saved connection keeps no Cloud access"><Zap size={13} /> Switch on for me</button>
                  )}
                  {conn.api === 'api_disabled' && <a className="btn btn-ghost btn-sm" href={conn.links.enable_apis} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Cloud console</a>}
                  {conn.api === 'not_approved' && <a className="btn btn-ghost btn-sm" href={conn.links.quotas} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Quota</a>}
                </div>
              </article>
            );
          })}
          {!setup.connections.length && <div className="ops-empty compact">No Google account is connected to this workspace yet.</div>}
        </div>
        {setup.connections.some(c => c.api === 'ok') && (
          <div className="ads-row-actions"><button className="btn btn-secondary" disabled={!canManage} onClick={() => setLinking(true)}><Link2 size={14} /> Find and link locations</button></div>
        )}
        <p className="ads-hint">
          Already connected for Search Console or Google Ads? Use <b>Add Business Profile access</b> on that connection; it keeps everything it already has.
        </p>
      </section>

      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">Another account or project</span><h2>Connect Business Profile separately</h2></div>
        </div>
        <p className="card-intro">
          Google approves the Business Profile APIs per Cloud project. If that approval sits on a different project, or with a different Google
          user, connect it here. The same Google account can be connected once per project: Search Console keeps using its connection, and your
          locations use this one.
        </p>
        <label className="autosetup-row">
          <input type="checkbox" checked={ownProject || !setup.builtin_oauth_client} disabled={!setup.builtin_oauth_client}
            onChange={e => { setOwnProject(e.target.checked); setBusinessOnly(e.target.checked); }} />
          <div>
            <strong>Use a different Google Cloud project</strong>
            <div className="text-dim">Enter the OAuth client (Web application) from the project Google approved for Business Profile.</div>
          </div>
        </label>
        {(ownProject || !setup.builtin_oauth_client) && (
          <div className="reviews-own-project">
            <div className="form-grid">
              <label>OAuth client ID<input className="input" value={clientId} onChange={e => setClientId(e.target.value)} placeholder="1234567890-abc….apps.googleusercontent.com" /></label>
              <label>OAuth client secret<input className="input" type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder="GOCSPX-…" /></label>
            </div>
            <span className="ads-hint">Add this redirect URI to that OAuth client in the Cloud console:</span>
            <span className="mcp-copy-row"><code>{redirectUri}</code><button className="btn-icon btn-icon-ghost" aria-label="Copy redirect URI" onClick={() => copy(redirectUri)}><Copy size={13} /></button></span>
          </div>
        )}
        <label className="autosetup-row">
          <input type="checkbox" checked={businessOnly} onChange={e => setBusinessOnly(e.target.checked)} />
          <div>
            <strong>Only ask Google for Business Profile access</strong>
            <div className="text-dim">
              The consent screen shows just Business Profile, so that project doesn't need Search Console or Analytics set up. Leave it unticked
              when you're connecting a new Google account through the main project and also want Search Console from it.
            </div>
          </div>
        </label>
        <label className="autosetup-row">
          <input type="checkbox" checked={autoSetup} onChange={e => setAutoSetup(e.target.checked)} />
          <div>
            <strong>Also keep Cloud access on this connection</strong>
            <div className="text-dim">Not needed to switch the APIs on: "Switch on for me" does that with a one-off sign-in. Keeping Cloud access lets the app enable APIs without asking, but managed Google Workspace accounts can then be signed out every few hours by Google Cloud session control.</div>
          </div>
        </label>
        <div className="ads-row-actions">
          <button className="btn btn-primary" disabled={!canManage || busy === 'new'} onClick={() => connect()}><Plus size={14} /> Sign in with Google</button>
        </div>
        <p className="ads-hint">On Google's screen, pick the Google user that manages the profiles. Moving a linked location onto the new connection keeps its reviews, rules and history (Locations tab).</p>
      </section>

      <McpConnect compact />
      {linking && <LinkLocationsModal onClose={() => setLinking(false)} onLinked={async () => { setLinking(false); await reload(true); onLinked(); }} />}
    </div>
  );
}
