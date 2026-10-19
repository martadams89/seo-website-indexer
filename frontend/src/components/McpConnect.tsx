import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, AppWindow, Copy, KeyRound, Link2, Plus, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../AppContext';
import '../ads/ads.css';

type McpToken = { id: string; name: string; scopes: string[]; last_used_at: string | null; revoked_at: string | null };
type ConnectedApp = { id: string; client_name: string; scopes: string[]; created_at: string; last_used_at: string | null };
type OAuthClient = Awaited<ReturnType<typeof api.getOAuthClients>>[number];
type CreatedClient = Awaited<ReturnType<typeof api.createOAuthClient>>;

const SCOPE_LABEL: Record<string, string> = { 'mcp:read': 'read', 'mcp:write': 'SEO actions', 'ads:write': 'Google Ads changes' };

interface ClientGuide {
  id: string;
  label: string;
  steps: (endpoint: string) => ReactNode[];
  code?: (endpoint: string) => string;
}

// Setup for common MCP clients, alphabetically. Every one of them signs in with
// OAuth against this app; menu names in hosted apps can shift between releases.
const CLIENTS: ClientGuide[] = [
  {
    id: 'chatgpt', label: 'ChatGPT',
    steps: () => [
      <>Turn on developer mode for apps and connectors (<b>Settings → Apps &amp; Connectors → Advanced settings</b>). Availability depends on your plan.</>,
      <>Create a new app/connector, paste the server URL and choose <b>OAuth</b> authentication.</>,
      <>ChatGPT opens this app to sign in and choose permissions.</>,
    ],
  },
  {
    id: 'claude', label: 'Claude',
    steps: () => [
      <>Open <b>Settings → Connectors → Add custom connector</b> (web, desktop or Cowork).</>,
      <>Paste the server URL and leave the OAuth client fields empty.</>,
      <>Claude opens this app to sign in and choose permissions.</>,
    ],
  },
  {
    id: 'claude-code', label: 'Claude Code',
    steps: () => [<>Run this, then <code>/mcp</code> inside Claude Code to sign in.</>],
    code: endpoint => `claude mcp add --transport http seo-indexer ${endpoint}`,
  },
  {
    id: 'codex', label: 'Codex CLI',
    steps: () => [<>Add the server, then sign in with <code>codex mcp login seo-indexer</code>.</>],
    code: endpoint => `codex mcp add seo-indexer --url ${endpoint}\ncodex mcp login seo-indexer`,
  },
  {
    id: 'cursor', label: 'Cursor',
    steps: () => [<>Add this to <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code> in a project), then enable the server in Cursor's MCP settings and sign in when asked.</>],
    code: endpoint => JSON.stringify({ mcpServers: { 'seo-indexer': { url: endpoint } } }, null, 2),
  },
  {
    id: 'gemini', label: 'Gemini CLI',
    steps: () => [<>Add the server, then run <code>/mcp auth seo-indexer</code> inside Gemini CLI to sign in.</>],
    code: endpoint => `gemini mcp add --transport http seo-indexer ${endpoint}`,
  },
  {
    id: 'vscode', label: 'VS Code',
    steps: () => [<>Add this to <code>.vscode/mcp.json</code> (or your user MCP configuration), click <b>Start</b> and sign in when asked.</>],
    code: endpoint => JSON.stringify({ servers: { 'seo-indexer': { type: 'http', url: endpoint } } }, null, 2),
  },
  {
    id: 'other', label: 'Other MCP clients',
    steps: () => [
      <>Any client that supports remote MCP servers over Streamable HTTP can connect with the server URL.</>,
      <>If it supports OAuth it finds the sign-in automatically (dynamic registration or a client metadata document).</>,
      <>If it asks for a client ID and secret, register one under <b>Apps that need a client ID</b>. If it can only send a fixed header, create a personal token.</>,
    ],
  },
];

/**
 * Connect an MCP client (chat app, IDE or agent CLI) to this install. OAuth is
 * the default: add the URL, sign in here and pick permissions. Manually
 * registered OAuth clients and personal tokens cover clients that can't
 * register themselves or can only send a static header.
 */
export function McpConnect({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.getMcpInfo>> | null>(null);
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [guide, setGuide] = useState('chatgpt');
  const [form, setForm] = useState({ name: 'AI assistant', allowWrite: false, allowAds: false });
  const [created, setCreated] = useState<string | null>(null);
  const [clientForm, setClientForm] = useState({ name: '', redirects: '', confidential: true });
  const [createdClient, setCreatedClient] = useState<CreatedClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(!compact);

  const load = useCallback(async () => {
    const [i, t, a, c] = await Promise.all([
      api.getMcpInfo().catch(() => null),
      api.getMcpTokens().catch(() => []),
      api.getConnectedApps().catch(() => []),
      api.getOAuthClients().catch(() => []),
    ]);
    setInfo(i); setTokens(t); setApps(a); setClients(c);
  }, []);
  useEffect(() => { load().catch(() => null); }, [load]);

  const endpoint = info?.endpoint ?? `${window.location.origin}/mcp`;
  const origin = info?.oauth?.issuer ?? window.location.origin;
  const active = CLIENTS.find(c => c.id === guide) ?? CLIENTS[0];
  function copy(value: string) {
    navigator.clipboard.writeText(value);
    toast('success', 'Copied to clipboard');
  }

  async function createToken() {
    setBusy(true);
    try {
      const scopes = ['mcp:read', ...(form.allowWrite ? ['mcp:write'] : []), ...(form.allowAds ? ['ads:write'] : [])];
      const result = await api.createMcpToken({ name: form.name, scopes });
      setCreated(result.token);
      await load();
      toast('success', "MCP token created—copy it now, it won't be shown again");
    } catch (e) {
      toast('error', String(e).replace('Error: ', ''));
    }
    setBusy(false);
  }

  async function registerClient() {
    setBusy(true);
    try {
      const result = await api.createOAuthClient({
        name: clientForm.name.trim() || 'AI assistant',
        redirect_uris: clientForm.redirects.split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
        confidential: clientForm.confidential,
      });
      setCreatedClient(result);
      setClientForm({ name: '', redirects: '', confidential: true });
      await load();
    } catch (e) {
      toast('error', String(e).replace('Error: ', ''));
    }
    setBusy(false);
  }

  const copyRow = (label: string, value: string, aria: string) => (
    <div className="mcp-copy-row">
      <span className="mcp-copy-label">{label}</span>
      <code>{value}</code>
      <button className="btn-icon btn-icon-ghost" aria-label={aria} onClick={() => copy(value)}><Copy size={13} /></button>
    </div>
  );

  return (
    <section className="ops-card mcp-connect">
      <div className="ops-card-head">
        <div>
          <span className="eyebrow">AI assistant access (MCP)</span>
          <h2>Connect an AI assistant</h2>
        </div>
      </div>
      <p className="card-intro">
        One MCP server for SEO and Google Ads, covering every workspace you can access. Any assistant that supports remote MCP
        servers — chat apps, IDEs and agent CLIs — can read your data and, only with the permissions you grant, run SEO actions
        and manage Google Ads within each client's guardrails.
      </p>

      {copyRow('Server URL', endpoint, 'Copy MCP server URL')}

      <div className="mcp-clients" role="group" aria-label="Choose your AI app">
        {CLIENTS.map(c => (
          <button key={c.id} type="button" className={c.id === guide ? 'active' : ''} aria-pressed={c.id === guide} onClick={() => setGuide(c.id)}>{c.label}</button>
        ))}
      </div>
      <div className="mcp-guide">
        <ol className="mcp-steps">{active.steps(endpoint).map((step, i) => <li key={i}>{step}</li>)}</ol>
        {active.code && (
          <div className="mcp-code">
            <pre>{active.code(endpoint)}</pre>
            <button className="btn-icon btn-icon-ghost" aria-label={`Copy ${active.label} setup`} onClick={() => copy(active.code!(endpoint))}><Copy size={13} /></button>
          </div>
        )}
        <p className="mcp-note">
          Tick <b>Manage Google Ads</b> on the sign-in screen if routines should make or propose Google Ads changes. Access tokens last an
          hour and renew automatically; disconnect an app below to cut it off. Hosted AI apps need this server on a public HTTPS address.
        </p>
      </div>

      <div className="automation-list">
        {apps.map(app => (
          <article key={app.id}>
            <Link2 />
            <div>
              <strong>{app.client_name}</strong>
              <small>{app.scopes.map(s => SCOPE_LABEL[s] ?? s).join(', ')}</small>
              <span>{app.last_used_at ? `Last used ${new Date(app.last_used_at).toLocaleString()}` : `Connected ${new Date(app.created_at).toLocaleString()}`}</span>
            </div>
            <button className="btn-icon btn-icon-ghost" aria-label={`Disconnect ${app.client_name}`} onClick={() => api.revokeConnectedApp(app.id).then(load)}>
              <Trash2 size={13} />
            </button>
          </article>
        ))}
        {!apps.length && <div className="ops-empty compact">No connected apps yet.</div>}
      </div>

      {compact && !showAdvanced ? (
        <button type="button" className="btn btn-ghost btn-sm mcp-token-toggle" onClick={() => setShowAdvanced(true)}>
          <KeyRound size={13} /> Client ID and secret, or a personal token
        </button>
      ) : (
        <>
          <div className="mcp-step">
            <strong><AppWindow size={13} /> Apps that need a client ID</strong>
            <p className="mcp-note">Some AI apps ask for an OAuth client ID and secret instead of registering themselves. Enter the redirect (callback) URL the app shows you.</p>
            <div className="mcp-token-form">
              <input className="input" value={clientForm.name} onChange={e => setClientForm({ ...clientForm, name: e.target.value })} placeholder="App name (e.g. Copilot Studio)" aria-label="OAuth client name" />
              <input className="input mcp-redirect-input" value={clientForm.redirects} onChange={e => setClientForm({ ...clientForm, redirects: e.target.value })} placeholder="Redirect URL(s) from the app" aria-label="Redirect URLs" />
              <label><input type="checkbox" checked={clientForm.confidential} onChange={e => setClientForm({ ...clientForm, confidential: e.target.checked })} /> Issue a client secret</label>
              <button className="btn btn-secondary btn-sm" disabled={busy || !clientForm.redirects.trim()} onClick={registerClient}><Plus size={12} /> Register client</button>
            </div>
          </div>

          {createdClient && (
            <div className="mcp-reveal">
              <div className="mcp-reveal-head">
                <strong>Enter these in your AI app</strong>
                <button className="btn-icon btn-icon-ghost" aria-label="Done" onClick={() => setCreatedClient(null)}><X size={14} /></button>
              </div>
              {createdClient.client_secret && <p className="mcp-warning"><AlertTriangle size={12} /> The client secret is shown once. Copy it now.</p>}
              {copyRow('Client ID', createdClient.client_id, 'Copy client ID')}
              {createdClient.client_secret && copyRow('Client secret', createdClient.client_secret, 'Copy client secret')}
              {copyRow('Authorization URL', createdClient.authorization_endpoint, 'Copy authorization URL')}
              {copyRow('Token URL', createdClient.token_endpoint, 'Copy token URL')}
              {copyRow('Scopes', 'mcp:read mcp:write ads:write', 'Copy scopes')}
              <p className="mcp-note">PKCE (S256) is required. People still choose the permissions on the sign-in screen.</p>
            </div>
          )}

          <div className="automation-list">
            {clients.map(c => (
              <article key={c.id}>
                <AppWindow />
                <div>
                  <strong>{c.name}</strong>
                  <small>{c.id}</small>
                  <span>{c.redirect_uris.join(', ')}</span>
                </div>
                <button className="btn-icon btn-icon-ghost" aria-label={`Delete OAuth client ${c.name}`} onClick={() => api.deleteOAuthClient(c.id).then(load)}>
                  <Trash2 size={13} />
                </button>
              </article>
            ))}
          </div>

          <div className="mcp-step">
            <strong><KeyRound size={13} /> Personal token (fixed header)</strong>
            <p className="mcp-note">For clients that can't sign in with OAuth. The token is sent as <code>Authorization: Bearer …</code>.</p>
            <div className="mcp-token-form">
              <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Token name (e.g. n8n workflow)" aria-label="MCP token name" />
              <label><input type="checkbox" checked={form.allowWrite} onChange={e => setForm({ ...form, allowWrite: e.target.checked })} /> SEO actions</label>
              <label><input type="checkbox" checked={form.allowAds} onChange={e => setForm({ ...form, allowAds: e.target.checked })} /> Google Ads changes</label>
              <button className="btn btn-secondary btn-sm" disabled={busy || !form.name.trim()} onClick={createToken}><Plus size={12} /> Create token</button>
            </div>
          </div>

          {created && (
            <div className="mcp-reveal">
              <div className="mcp-reveal-head">
                <strong>Copy your connection details</strong>
                <button className="btn-icon btn-icon-ghost" aria-label="Done" onClick={() => setCreated(null)}><X size={14} /></button>
              </div>
              <p className="mcp-warning"><AlertTriangle size={12} /> This token is shown once. Copy what you need now — you can’t see it again.</p>
              {[
                { title: 'Header', value: `Authorization: Bearer ${created}`, label: 'Copy header' },
                { title: 'JSON configuration (most IDEs and CLIs)', value: JSON.stringify({ url: endpoint, headers: { Authorization: `Bearer ${created}` } }, null, 2), label: 'Copy JSON configuration' },
                { title: 'URL with the token in it (only if your client can’t send headers — it may end up in proxy logs)', value: `${endpoint}?token=${created}`, label: 'Copy URL with token' },
              ].map(row => (
                <div className="mcp-copy-group" key={row.title}>
                  <span className="mcp-copy-title">{row.title}</span>
                  <div className="mcp-copy-row">
                    <code>{row.value}</code>
                    <button className="btn-icon btn-icon-ghost" aria-label={row.label} onClick={() => copy(row.value)}><Copy size={13} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="automation-list">
            {tokens.filter(t => !t.revoked_at).map(row => (
              <article key={row.id}>
                <KeyRound />
                <div>
                  <strong>{row.name}</strong>
                  <small>{row.scopes.map(s => SCOPE_LABEL[s] ?? s).join(', ')}</small>
                  <span>{row.last_used_at ? `Last used ${new Date(row.last_used_at).toLocaleString()}` : 'Never used'}</span>
                </div>
                <button className="btn-icon btn-icon-ghost" aria-label={`Revoke MCP token ${row.name}`} onClick={() => api.revokeMcpToken(row.id).then(load)}>
                  <Trash2 size={13} />
                </button>
              </article>
            ))}
            {!tokens.filter(t => !t.revoked_at).length && <div className="ops-empty compact">No active personal tokens.</div>}
          </div>
          <p className="mcp-note">OAuth issuer: <code>{origin}</code></p>
        </>
      )}
    </section>
  );
}
