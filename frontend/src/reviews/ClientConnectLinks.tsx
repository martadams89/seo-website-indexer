// ClientConnectLinks — send a client a link so they connect their own Google
// account's Business Profile through your approved Cloud project, the way
// social schedulers do. Calls use the client's own sign-in but count against
// your project's Business Profile API approval.
import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2, Send, X } from 'lucide-react';
import { apiFetch } from '../api/client';
import { useToast } from '../AppContext';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { errorMessage } from '../ads/api';
import { reviewsApi, type ConnectInvite } from './api';

interface Project {
  project: string | null; source_id: string; builtin: boolean; label: string | null;
  connections: Array<{ email: string | null; limited_to: string[] | null; locations: number }>;
}

const STATUS: Record<ConnectInvite['status'], { label: string; tone: string }> = {
  open: { label: 'Waiting for the client', tone: 'info' },
  connected: { label: 'Connected', tone: 'ok' },
  expired: { label: 'Expired', tone: 'warn' },
  revoked: { label: 'Cancelled', tone: 'info' },
};

const projectLabel = (p: Project) => `${p.label ? `${p.label} — ` : ''}Project ${p.project ?? 'unknown'}${p.builtin ? ' (built-in)' : ''}${p.connections[0]?.email ? ` · ${p.connections[0].email}` : ''}`;
/** The project most likely to hold the Business Profile approval: one already serving locations, then one limited to Business Profile. */
const businessScore = (p: Project) => p.connections.reduce((n, c) => n + c.locations * 10 + (c.limited_to?.includes('business') ? 1 : 0), 0);

export function ClientConnectLinks({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const { active } = useWorkspace();
  const allowed = canManage && !!active?.permissions?.manage_integrations;
  const [projects, setProjects] = useState<Project[]>([]);
  const [builtin, setBuiltin] = useState(false);
  const [project, setProject] = useState('');
  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ConnectInvite | null>(null);
  const [invites, setInvites] = useState<ConnectInvite[]>([]);

  const load = useCallback(() => Promise.all([
    apiFetch<{ builtin_available: boolean; projects: Project[] }>('/api/auth/google/projects'),
    reviewsApi.connectInvites(),
  ]).then(([p, list]) => {
    const sorted = [...p.projects].sort((a, b) => businessScore(b) - businessScore(a));
    setProjects(sorted);
    setBuiltin(p.builtin_available && !p.projects.some(x => x.builtin));
    setProject(current => current || sorted[0]?.source_id || (p.builtin_available ? 'builtin' : ''));
    setInvites(list);
  }, () => undefined), []);
  useEffect(() => { void load(); }, [load]);

  const copy = (url: string) => { void navigator.clipboard.writeText(url); toast('success', 'Link copied'); };

  async function create() {
    setBusy(true);
    try {
      const invite = await reviewsApi.createConnectInvite({ projectFrom: project, clientName: clientName.trim() || undefined, clientEmail: clientEmail.trim() || undefined, days });
      setCreated(invite);
      setClientName(''); setClientEmail('');
      toast('success', invite.emailed ? `Link emailed to ${invite.client_email}` : 'Link ready — send it to your client');
      await load();
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(false);
  }

  async function revoke(invite: ConnectInvite) {
    if (!confirm(`Cancel the link${invite.client_name ? ` for ${invite.client_name}` : ''}? It stops working straight away.`)) return;
    try { await reviewsApi.revokeConnectInvite(invite.id); await load(); if (created?.id === invite.id) setCreated(null); }
    catch (e) { toast('error', errorMessage(e)); }
  }

  return (
    <section className="ops-card">
      <div className="ops-card-head">
        <div><span className="eyebrow">Your client's own Google account</span><h2>Send a client a connect link</h2></div>
        <Link2 size={18} />
      </div>
      <p className="card-intro">
        Google approves the Business Profile API for a Cloud project, not a Google account. With a link, your client signs in with
        <b> their own</b> Google account through your approved project, grants Business Profile access only, and picks which of their profiles to share.
        Nobody needs to add you as a manager on the profile, and the client doesn't need an account here.
      </p>
      <div className="form-grid">
        <label>Cloud project they sign in through
          <select className="input" value={project} disabled={!allowed} onChange={e => setProject(e.target.value)}>
            {projects.map(p => <option key={p.source_id} value={p.source_id}>{projectLabel(p)}</option>)}
            {builtin && <option value="builtin">This server's built-in project</option>}
            {!projects.length && !builtin && <option value="">Connect Google first (above)</option>}
          </select>
        </label>
        <label>Link works for
          <select className="input" value={days} disabled={!allowed} onChange={e => setDays(Number(e.target.value))}>
            {[3, 7, 14, 30].map(d => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
        <label>Client (optional)<input className="input" value={clientName} maxLength={120} disabled={!allowed} onChange={e => setClientName(e.target.value)} placeholder="e.g. Bright Smiles Dental" /></label>
        <label>Email it to (optional)<input className="input" type="email" value={clientEmail} disabled={!allowed} onChange={e => setClientEmail(e.target.value)} placeholder="owner@client.com" /></label>
      </div>
      <div className="ads-row-actions">
        <button className="btn btn-primary" disabled={!allowed || busy || !project} onClick={create}><Send size={14} /> {clientEmail.trim() ? 'Create and email link' : 'Create link'}</button>
      </div>
      {!allowed && canManage && <p className="ads-hint">Creating a link adds a Google connection, so it also needs the “Manage integrations and API keys” permission.</p>}
      <p className="ads-hint">
        Pick the project Google approved for the Business Profile API. Its OAuth consent screen must be <b>External</b> and <b>In production</b>:
        an <i>Internal</i> app only lets people from your own Google Workspace sign in, and in <i>Testing</i> only listed test users can, and their access expires after 7 days.
      </p>
      {created?.url && (
        <div className="mcp-copy-row client-link-created"><code>{created.url}</code><button type="button" className="btn-icon btn-icon-ghost" aria-label="Copy link" onClick={() => copy(created.url!)}><Copy size={13} /></button></div>
      )}
      {invites.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Client</th><th>Status</th><th>Google account</th><th>Shared</th><th /></tr></thead>
            <tbody>
              {invites.map(i => (
                <tr key={i.id}>
                  <td><small>{i.client_name ?? i.client_email ?? '—'}{i.client_name && i.client_email ? ` · ${i.client_email}` : ''}</small></td>
                  <td>
                    <span className={`badge badge-${STATUS[i.status].tone}`}>{STATUS[i.status].label}</span>
                    {i.status === 'open' && <small className="text-dim"> until {new Date(i.expires_at).toLocaleDateString()}</small>}
                  </td>
                  <td><small>{i.google_email ?? '—'}</small></td>
                  <td><small>{i.shared_locations.length ? i.shared_locations.join(', ') : i.status === 'connected' ? 'Choosing…' : '—'}</small></td>
                  <td className="ads-row-actions">
                    {i.url && <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(i.url!)}><Copy size={13} /> Copy link</button>}
                    {i.status === 'open' && <button type="button" className="btn btn-ghost btn-sm" disabled={!allowed} onClick={() => revoke(i)}><X size={13} /> Cancel</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
