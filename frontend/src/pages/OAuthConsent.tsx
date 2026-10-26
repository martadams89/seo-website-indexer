import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, Loader2, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import '../ads/ads.css';

type ConsentRequest = Awaited<ReturnType<typeof api.getOAuthRequest>>;

/**
 * Consent screen for MCP clients (chat apps, IDEs, agent CLIs). The
 * person is already signed in (AuthGate), sees which app is asking and where
 * it will be sent back to, and chooses the permissions to grant.
 */
export default function OAuthConsentPage() {
  const [params] = useSearchParams();
  const requestId = params.get('request') ?? '';
  const [request, setRequest] = useState<ConsentRequest | null>(null);
  const [scopes, setScopes] = useState<string[]>(['mcp:read']);
  const [loadError, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const error = requestId ? loadError : 'This page needs a connection request. Start the connection again from your AI app.';

  useEffect(() => {
    if (!requestId) return;
    api.getOAuthRequest(requestId)
      .then(r => { setRequest(r); setScopes(['mcp:read', ...r.requested_scopes.filter(s => s !== 'mcp:read')]); })
      .catch(e => setError(String(e).replace('Error: ', '')));
  }, [requestId]);

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      const { redirect } = await api.decideOAuthRequest(requestId, approve, scopes);
      window.location.assign(redirect);
    } catch (e) {
      setError(String(e).replace('Error: ', ''));
      setBusy(false);
    }
  }

  const toggle = (id: string) => setScopes(current => current.includes(id) ? current.filter(s => s !== id) : [...current, id]);

  return (
    <main className="consent-page">
      <section className="consent-card" aria-labelledby="consent-title">
        <span className="eyebrow"><ShieldCheck size={13} /> Connect an AI assistant</span>
        {error && <div className="alert alert-error"><AlertTriangle size={14} /><div className="alert-content">{error}</div></div>}
        {!request && !error && <div className="consent-loading"><Loader2 className="spin" size={18} /> Loading request…</div>}
        {request && (
          <>
            <h1 id="consent-title"><strong>{request.client_name}</strong> wants to access SEO Website Indexer</h1>
            <p className="consent-meta">
              Signed in as <b>{request.user.email}</b>.{request.client_domain && <> This app is identified by <code>{request.client_domain}</code>.</>} After you decide you'll be sent back to <code>{request.redirect_host}</code>.
              Only continue if you just started this from your AI app.
            </p>
            <fieldset className="consent-scopes">
              <legend>Allow it to</legend>
              {request.scopes.map(scope => (
                <label key={scope.id} className={scopes.includes(scope.id) ? 'selected' : ''}>
                  <input type="checkbox" checked={scopes.includes(scope.id)} disabled={scope.id === 'mcp:read' || busy} onChange={() => toggle(scope.id)} />
                  <span><strong>{scope.label}</strong><small>{scope.description}</small></span>
                </label>
              ))}
            </fieldset>
            <p className="consent-meta">
              Applies to {request.workspaces.length === 1 ? 'your workspace' : `all ${request.workspaces.length} workspaces you can access`}
              {request.workspaces.length ? ` (${request.workspaces.slice(0, 6).join(', ')}${request.workspaces.length > 6 ? '…' : ''})` : ''}.
              Your own role in each workspace still limits what it can do. Tools for anything you leave unticked are hidden from the app;
              you can change its access later (<b>Change access</b> under Connect an AI assistant) or disconnect it under Governance &amp; usage.
            </p>
            <div className="consent-actions">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => decide(false)}>Deny</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => decide(true)}>
                {busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />} Allow access
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
