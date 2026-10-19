import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Copy, KeyRound, Link2, Plus, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../AppContext';
import '../ads/ads.css';

type McpToken = { id: string; name: string; scopes: string[]; last_used_at: string | null; revoked_at: string | null };
type ConnectedApp = { id: string; client_name: string; scopes: string[]; created_at: string; last_used_at: string | null };

const SCOPE_LABEL: Record<string, string> = { 'mcp:read': 'read', 'mcp:write': 'SEO actions', 'ads:write': 'Google Ads changes' };

/**
 * Connect Claude (or any MCP client) to this install. OAuth is the default:
 * paste the URL, sign in here and pick permissions. Personal tokens remain for
 * clients that need a static header.
 */
export function McpConnect({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const [info, setInfo] = useState<{ endpoint: string; claudeCodeCommand: string } | null>(null);
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [form, setForm] = useState({ name: 'Claude (Cowork)', allowWrite: false, allowAds: false });
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTokens, setShowTokens] = useState(!compact);

  const load = useCallback(async () => {
    const [i, t, a] = await Promise.all([
      api.getMcpInfo().catch(() => null),
      api.getMcpTokens().catch(() => []),
      api.getConnectedApps().catch(() => []),
    ]);
    setInfo(i); setTokens(t); setApps(a);
  }, []);
  useEffect(() => { load().catch(() => null); }, [load]);

  const endpoint = info?.endpoint ?? `${window.location.origin}/mcp`;
  const oauthCommand = `claude mcp add --transport http seo-indexer ${endpoint}`;
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

  return (
    <section className="ops-card mcp-connect">
      <div className="ops-card-head">
        <div>
          <span className="eyebrow">AI assistant access (MCP)</span>
          <h2>Connect Claude to your data</h2>
        </div>
      </div>
      <p className="card-intro">
        One MCP server for SEO and Google Ads, covering every workspace you can access. Claude can read your data and — only with the
        permissions you grant — run SEO actions and manage Google Ads within each client's guardrails.
      </p>

      <div className="mcp-step">
        <strong>Recommended: sign in with the connector URL</strong>
        <ol className="mcp-steps">
          <li>In Claude (web, desktop or Cowork), open <b>Settings → Connectors → Add custom connector</b>.</li>
          <li>Paste this URL. Leave the OAuth client fields empty — Claude registers itself.</li>
          <li>Claude sends you here to sign in and choose what it may do. Tick <b>Manage Google Ads</b> if routines should change campaigns.</li>
        </ol>
        <div className="mcp-copy-row">
          <span className="mcp-copy-label">Connector URL</span>
          <code>{endpoint}</code>
          <button className="btn-icon btn-icon-ghost" aria-label="Copy connector URL" onClick={() => copy(endpoint)}><Copy size={13} /></button>
        </div>
        <div className="mcp-copy-row">
          <span className="mcp-copy-label">Claude Code</span>
          <code>{oauthCommand}</code>
          <button className="btn-icon btn-icon-ghost" aria-label="Copy Claude Code command" onClick={() => copy(oauthCommand)}><Copy size={13} /></button>
        </div>
        <p className="mcp-note">In Claude Code, run <code>/mcp</code> afterwards to sign in. Access tokens last an hour and renew automatically; revoke an app below to cut it off.</p>
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

      {compact && !showTokens ? (
        <button type="button" className="btn btn-ghost btn-sm mcp-token-toggle" onClick={() => setShowTokens(true)}>
          <KeyRound size={13} /> Use a personal token instead
        </button>
      ) : (
        <>
          <div className="mcp-step">
            <strong>Alternative: a personal token (static header)</strong>
            <div className="mcp-token-form">
              <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Token name (e.g. Claude Desktop)" aria-label="MCP token name" />
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
                { title: 'Claude Code (terminal)', value: (info?.claudeCodeCommand ?? `claude mcp add --transport http seo-indexer ${endpoint} --header "Authorization: Bearer <token>"`).replace('<token>', created), label: 'Copy command' },
                { title: 'Header value (Authorization)', value: `Bearer ${created}`, label: 'Copy header value' },
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
        </>
      )}
    </section>
  );
}
