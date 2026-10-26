// GoogleConnectForm — sign another Google user in, through a Cloud project the
// app already knows (its OAuth client stays on the server), the built-in one,
// or a new project's OAuth client. A connection can be limited to one product,
// because Google grants API access and quota per project: a workspace often
// has one project for Search Console, one for Google Ads and one for Business
// Profile.
import { useCallback, useEffect, useState } from 'react';
import { Copy, Plus } from 'lucide-react';
import { apiFetch } from '../api/client';
import { useToast } from '../AppContext';
import { openGoogleConsent, useGoogleAuthSuccess } from '../ads/googleConnect';
import './google-connect.css';

type Product = 'ads' | 'business';

interface GoogleProject {
  project: string | null;
  source_id: string;
  builtin: boolean;
  connections: Array<{ id: string; email: string | null; limited_to: Product[] | null; in_workspace: boolean; sites: number; ads_clients: number; locations: number }>;
}

const PRODUCT_LABEL: Record<Product, string> = { ads: 'Google Ads', business: 'Business Profile' };

function projectSummary(p: GoogleProject): string {
  const uses = (c: GoogleProject['connections'][number]) => [
    c.sites ? `${c.sites} site${c.sites === 1 ? '' : 's'}` : '',
    c.ads_clients ? `${c.ads_clients} Ads client${c.ads_clients === 1 ? '' : 's'}` : '',
    c.locations ? `${c.locations} location${c.locations === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(', ');
  return p.connections.slice(0, 3).map(c => `${c.email ?? c.id}${uses(c) ? ` (${uses(c)})` : ''}`).join('; ') + (p.connections.length > 3 ? '…' : '');
}

/**
 * `product` is what the page connects for: 'ads' or 'business' offer a
 * connection limited to that product; 'all' is a full connection with
 * optional Google Ads and Business Profile access.
 */
export function GoogleConnectForm({ product, canManage, onConnected }: { product: Product | 'all'; canManage: boolean; onConnected?: () => void }) {
  const toast = useToast();
  const [projects, setProjects] = useState<GoogleProject[]>([]);
  const [builtinAvailable, setBuiltinAvailable] = useState(false);
  const [choice, setChoice] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [limited, setLimited] = useState(false);
  const [autoSetup, setAutoSetup] = useState(false);
  const [withAds, setWithAds] = useState(false);
  const [withBusiness, setWithBusiness] = useState(false);
  const [busy, setBusy] = useState(false);
  const redirectUri = `${window.location.origin}/api/auth/google/callback`;

  const load = useCallback(() => apiFetch<{ builtin_available: boolean; projects: GoogleProject[] }>('/api/auth/google/projects')
    .then(r => {
      setProjects(r.projects);
      setBuiltinAvailable(r.builtin_available);
      // Default to the project the workspace already uses, so nobody retypes a client they've already set up.
      setChoice(current => current || (r.projects[0] ? `existing:${r.projects[0].source_id}` : r.builtin_available ? 'builtin' : 'custom'));
    })
    .catch(() => setChoice(current => current || 'custom')), []);
  useEffect(() => { void load(); }, [load]);
  useGoogleAuthSuccess(useCallback(() => { void load(); onConnected?.(); }, [load, onConnected]));

  const custom = choice === 'custom';
  const showBuiltin = builtinAvailable && !projects.some(p => p.builtin);

  function pick(next: string) {
    setChoice(next);
    // A separate project is usually there for one product's API access, so ask Google for just that.
    if (product !== 'all') setLimited(next === 'custom');
  }

  async function start() {
    setBusy(true);
    try {
      if (custom && (!clientId.trim() || !clientSecret.trim())) throw new Error('Enter the OAuth client ID and secret from that Google Cloud project first.');
      await openGoogleConsent({
        ...(choice.startsWith('existing:') ? { projectFrom: choice.slice('existing:'.length) } : {}),
        ...(custom ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() } : {}),
        ads: product === 'ads' || withAds,
        business: product === 'business' || withBusiness,
        ...(product !== 'all' && limited ? { only: [product] } : {}),
        autoSetup,
      });
    } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  }

  return (
    <div className="google-connect-form">
      <label className="google-connect-project">Google Cloud project
        <select className="input" value={choice} disabled={!canManage} onChange={e => pick(e.target.value)}>
          {projects.map(p => (
            <option key={p.source_id} value={`existing:${p.source_id}`}>
              {`Project ${p.project ?? 'unknown'}${p.builtin ? ' (built-in)' : ''}: ${projectSummary(p)}`}
            </option>
          ))}
          {showBuiltin && <option value="builtin">This server's built-in project</option>}
          <option value="custom">Another project (enter its OAuth client)</option>
        </select>
        <small className="text-dim">
          {custom
            ? 'For a project with its own API access or quota, for example the one Google approved for Business Profile or with Google Ads Basic access.'
            : 'Reuses that project\'s OAuth client; there\'s nothing to re-enter. Google asks which account to sign in with, so you can add a different Google user here too.'}
        </small>
      </label>
      {custom && (
        <div className="google-connect-custom">
          <div className="form-grid">
            <label>OAuth client ID<input className="input" value={clientId} onChange={e => setClientId(e.target.value)} placeholder="1234567890-abc….apps.googleusercontent.com" /></label>
            <label>OAuth client secret<input className="input" type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder="GOCSPX-…" /></label>
          </div>
          <span className="google-connect-hint">Create a <b>Web application</b> client in that project and add this redirect URI:</span>
          <span className="mcp-copy-row"><code>{redirectUri}</code><button type="button" className="btn-icon btn-icon-ghost" aria-label="Copy redirect URI" onClick={() => { navigator.clipboard.writeText(redirectUri); toast('success', 'Copied to clipboard'); }}><Copy size={13} /></button></span>
        </div>
      )}
      {product === 'all' ? (
        <>
          <label className="autosetup-row">
            <input type="checkbox" checked={withAds} onChange={e => setWithAds(e.target.checked)} />
            <div><strong>Also allow Google Ads management</strong><div className="text-dim">Report on and manage the ad accounts this Google user can reach, within each client's budget and guardrails.</div></div>
          </label>
          <label className="autosetup-row">
            <input type="checkbox" checked={withBusiness} onChange={e => setWithBusiness(e.target.checked)} />
            <div><strong>Also allow Google Business Profile</strong><div className="text-dim">Read and answer reviews, edit profiles and post for the locations this Google user manages.</div></div>
          </label>
        </>
      ) : (
        <label className="autosetup-row">
          <input type="checkbox" checked={limited} onChange={e => setLimited(e.target.checked)} />
          <div>
            <strong>Only ask Google for {PRODUCT_LABEL[product]} access</strong>
            <div className="text-dim">
              The consent screen shows just {PRODUCT_LABEL[product]}, so that project doesn't need Search Console or Analytics set up, and the
              connection is never used for sites. Leave it unticked to also use this Google user for Search Console.
            </div>
          </div>
        </label>
      )}
      <label className="autosetup-row">
        <input type="checkbox" checked={autoSetup} onChange={e => setAutoSetup(e.target.checked)} />
        <div>
          <strong>Also keep Cloud access on this connection</strong>
          <div className="text-dim">Not needed to switch APIs on: "Switch on for me" does that with a one-off sign-in. Keeping Cloud access lets the app enable APIs without asking, but managed Google Workspace accounts can then be signed out every few hours by Google Cloud session control.</div>
        </div>
      </label>
      <div className="google-connect-actions">
        <button type="button" className="btn btn-primary" disabled={!canManage || busy || !choice} onClick={start}><Plus size={14} /> {busy ? 'Opening Google…' : 'Sign in with Google'}</button>
      </div>
      <p className="google-connect-hint">The same Google account can be connected once per project, so it can use one project for Search Console and another for {product === 'all' ? 'Google Ads or Business Profile' : PRODUCT_LABEL[product]}.</p>
    </div>
  );
}
