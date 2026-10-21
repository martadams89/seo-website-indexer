import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Link2, Pencil, RefreshCw, ShieldCheck, Trash2, Users } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useToast } from '../AppContext';
import { adsApi, errorMessage, money, type AdsAccount, type AdsBrief, type AdsGuardrails, type DiscoveryResult, type Ga4PropertiesResult } from './api';
import { GOALS, MODE_LABEL } from './constants';

export function AdsClients({ accounts, canManage, reload, onOpen }: {
  accounts: AdsAccount[]; canManage: boolean; reload: (fresh?: boolean) => Promise<void>; onOpen: (id: string) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<AdsAccount | null>(null);
  const [linking, setLinking] = useState(false);

  async function unlink(account: AdsAccount) {
    if (!confirm(`Unlink ${account.name ?? account.customer_id_formatted} from this workspace? Its change history and routine notes are deleted; nothing changes in Google Ads.`)) return;
    try { await adsApi.unlink(account.id); await reload(); toast('success', 'Account unlinked'); }
    catch (e) { toast('error', errorMessage(e)); }
  }

  return (
    <section className="ops-card">
      <div className="ops-card-head">
        <div><span className="eyebrow"><Users size={13} /> Clients</span><h2>Linked ad accounts</h2></div>
        <button className="btn btn-primary btn-sm" disabled={!canManage} onClick={() => setLinking(true)}><Link2 size={13} /> Link accounts</button>
      </div>
      <p className="card-intro">Each linked account is one client. Its monthly budget and guardrails are enforced on every change — from this dashboard or from an AI assistant.</p>
      {accounts.length ? (
        <div className="table-wrap">
          <table className="table ads-table">
            <thead>
              <tr><th>Client</th><th>Customer ID</th><th>Monthly budget</th><th>Mode</th><th>Waiting</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {accounts.map(a => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.name ?? 'Unnamed account'}</strong>
                    {a.test_account && <span className="badge badge-info">Test</span>}
                    {a.is_manager && <span className="badge badge-info">Manager</span>}
                    {a.ga4_property_id && <span className="badge badge-ok" title={`GA4 ${a.ga4_property_id}${a.ga4_property_name ? ` · ${a.ga4_property_name}` : ''}`}>GA4</span>}
                    {!a.enabled && <span className="badge badge-warn">Paused in app</span>}
                    {a.connection_lost && (
                      <small className="ads-error-line">
                        Its Google connection was disconnected.{' '}
                        <button className="link-button" disabled={!canManage} onClick={() => setLinking(true)}>Relink it</button> by selecting it under the Google login that has access.
                      </small>
                    )}
                    {a.last_error && !a.connection_lost && <small className="ads-error-line">{a.last_error}</small>}
                  </td>
                  <td><code>{a.customer_id_formatted}</code>{a.login_customer_id && <small className="text-dim"> via manager</small>}</td>
                  <td>{a.monthly_budget === null ? <span className="badge badge-warn">Not set</span> : money(a.monthly_budget, a.currency, 0)}</td>
                  <td><span className={`badge badge-${a.guardrails.mode === 'guarded' ? 'ok' : a.guardrails.mode === 'review' ? 'accent' : 'info'}`}>{MODE_LABEL[a.guardrails.mode]}</span></td>
                  <td>{a.pending_approvals ? <span className="badge badge-warn">{a.pending_approvals}</span> : '—'}</td>
                  <td>
                    <div className="ads-cell-actions">
                      <button className="btn-icon btn-icon-ghost" aria-label={`Performance for ${a.name}`} onClick={() => onOpen(a.id)}><BarChart3 size={14} /></button>
                      <button className="btn-icon btn-icon-ghost" aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)}><Pencil size={14} /></button>
                      <button className="btn-icon btn-icon-ghost" aria-label={`Unlink ${a.name}`} disabled={!canManage} onClick={() => unlink(a)}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="ops-empty compact"><Users /><strong>No clients linked</strong><span>Link the ad accounts you manage to start.</span></div>
      )}
      {editing && <EditClientModal account={editing} canManage={canManage} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); }} />}
      {linking && <LinkAccountsModal onClose={() => setLinking(false)} onLinked={async () => { setLinking(false); await reload(true); }} />}
    </section>
  );
}

/** Find every ad account the connected Google users can reach and link the chosen ones. */
export function LinkAccountsModal({ onClose, onLinked }: { onClose: () => void; onLinked: () => void | Promise<void> }) {
  const toast = useToast();
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Record<string, { googleAccountId: string; loginCustomerId: string | null }>>({});
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(true);

  const scan = useCallback(() => adsApi.discover()
    .then(next => { setResult(next); setError(''); })
    .catch(e => setError(errorMessage(e)))
    .finally(() => setScanning(false)), []);
  useEffect(() => { void scan(); }, [scan]);

  function rescan() {
    setScanning(true);
    setError('');
    void scan();
  }

  async function link() {
    setBusy(true);
    let ok = 0;
    for (const [customerId, choice] of Object.entries(selected)) {
      try { await adsApi.link({ customerId, googleAccountId: choice.googleAccountId, loginCustomerId: choice.loginCustomerId }); ok++; }
      catch (e) { toast('error', `${customerId}: ${errorMessage(e)}`); }
    }
    setBusy(false);
    if (ok) { toast('success', `Linked ${ok} account${ok === 1 ? '' : 's'}. Set each client's monthly budget next.`); await onLinked(); }
  }

  const count = Object.keys(selected).length;
  return (
    <Modal onClose={onClose} size="lg" title="Link client ad accounts" eyebrow="Google Ads" icon={<Link2 />}
      description="Accounts the connected Google users can reach, including clients under your manager accounts."
      footer={<><button className="btn btn-ghost" disabled={scanning} onClick={rescan}><RefreshCw size={13} /> {scanning && result ? 'Scanning…' : 'Scan again'}</button><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!count || busy} onClick={link}>{busy ? 'Linking…' : `Link ${count || ''} account${count === 1 ? '' : 's'}`}</button></>}>
      {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}
      {!result && scanning && <div className="page-loading">Asking Google which accounts you can manage…</div>}
      {result?.connections.map(conn => (
        <div key={conn.google_account_id} className="ads-discovery-group">
          <h3>{conn.email ?? conn.google_account_id}</h3>
          {conn.errors.map(err => <p key={err} className="ads-hint">{err}{conn.hint ? ` — ${conn.hint}` : ''}</p>)}
          {conn.customers.map(c => {
            const linked = !!c.linked_account_id && !c.needs_relink;
            const checked = !!selected[c.customer_id];
            return (
              <label key={c.customer_id} className={`ads-discovery-row ${linked ? 'linked' : ''}`} style={{ paddingLeft: 10 + c.level * 18 }}>
                <input type="checkbox" disabled={linked || !!c.error} checked={linked || checked} onChange={e => {
                  setSelected(current => {
                    const next = { ...current };
                    if (e.target.checked) next[c.customer_id] = { googleAccountId: conn.google_account_id, loginCustomerId: c.login_customer_id };
                    else delete next[c.customer_id];
                    return next;
                  });
                }} />
                <span>
                  <strong>{c.name ?? c.customer_id}</strong>
                  <small>{c.customer_id.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3')}{c.currency ? ` · ${c.currency}` : ''}{c.manager ? ' · manager account' : ''}{c.test_account ? ' · test account' : ''}{c.status && c.status !== 'ENABLED' ? ` · ${c.status.toLowerCase()}` : ''}{linked ? ' · already linked' : ''}{c.needs_relink ? ' · connection lost, select to relink' : ''}</small>
                  {c.error && <small className="ads-error-line">{c.error}</small>}
                </span>
              </label>
            );
          })}
          {!conn.customers.length && !conn.errors.length && <p className="ads-hint">No accounts found for this Google user.</p>}
        </div>
      ))}
    </Modal>
  );
}

const num = (v: string): number | null => v.trim() === '' ? null : Number(v);

export function EditClientModal({ account, canManage, onClose, onSaved }: { account: AdsAccount; canManage: boolean; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const toast = useToast();
  const [budget, setBudget] = useState(account.monthly_budget === null ? '' : String(account.monthly_budget));
  const [brief, setBrief] = useState<AdsBrief & { competitorsText: string }>({ ...account.brief, competitorsText: (account.brief.competitors ?? []).join('\n') });
  const [guard, setGuard] = useState<AdsGuardrails>(account.guardrails);
  const [enabled, setEnabled] = useState(account.enabled);
  const [ga4, setGa4] = useState(account.ga4_property_id ?? '');
  const [ga4Options, setGa4Options] = useState<Ga4PropertiesResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    adsApi.ga4Properties().then(r => { if (live) setGa4Options(r); }).catch(() => { if (live) setGa4Options({ logins: [] }); });
    return () => { live = false; };
  }, []);
  const ga4Properties = (ga4Options?.logins ?? []).flatMap(l => l.properties);
  const ga4Problems = (ga4Options?.logins ?? []).filter(l => l.error);

  async function save() {
    setBusy(true);
    try {
      const { competitorsText, ...rest } = brief;
      await adsApi.update(account.id, {
        monthlyBudget: num(budget),
        brief: { ...rest, competitors: competitorsText.split(/[\n,]/).map(s => s.trim()).filter(Boolean) },
        guardrails: guard, enabled,
        ...(ga4.trim() !== (account.ga4_property_id ?? '') ? { ga4PropertyId: ga4.trim() || null } : {}),
      });
      toast('success', 'Client saved');
      await onSaved();
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(false);
  }

  const field = (key: keyof AdsBrief) => ({
    value: (brief[key] as string | number | undefined) ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setBrief({ ...brief, [key]: e.target.value }),
    disabled: !canManage,
  });

  return (
    <Modal onClose={onClose} size="xl" title={account.name ?? account.customer_id_formatted} eyebrow={`Client · ${account.customer_id_formatted}`} icon={<ShieldCheck />}
      description="The brief tells the AI what this client is trying to achieve. The budget and guardrails decide what it may change without asking you."
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!canManage || busy} onClick={save}>{busy ? 'Saving…' : 'Save client'}</button></>}>
      <h3 className="ads-form-heading">Budget and goal</h3>
      <div className="form-grid">
        <label>Monthly budget ({account.currency ?? 'account currency'})<input className="input" type="number" min={0} step="1" value={budget} disabled={!canManage} onChange={e => setBudget(e.target.value)} placeholder="e.g. 1500" /><small>The most this client wants to spend in a calendar month.</small></label>
        <label>Primary goal<select className="input" {...field('goal')}><option value="">Not specified</option>{GOALS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
        <label>Target CPA (cost per conversion)<input className="input" type="number" min={0} step="0.01" {...field('target_cpa')} placeholder="optional" /></label>
        <label>Target ROAS (e.g. 4 = 400%)<input className="input" type="number" min={0} step="0.1" {...field('target_roas')} placeholder="optional" /></label>
      </div>
      <h3 className="ads-form-heading">Brief</h3>
      <div className="form-grid">
        <label>Website<input className="input" {...field('website')} placeholder="https://" /></label>
        <label>Markets / locations<input className="input" {...field('markets')} placeholder="e.g. Leeds, Bradford, 20 miles" /></label>
        <label className="full">Offer and selling points<textarea rows={2} {...field('offer')} placeholder="What they sell, prices, guarantees, what makes them different" /></label>
        <label>Audience<textarea rows={2} {...field('audience')} /></label>
        <label>Competitors (one per line)<textarea rows={2} value={brief.competitorsText} disabled={!canManage} onChange={e => setBrief({ ...brief, competitorsText: e.target.value })} placeholder="Leave blank and the AI will find them" /></label>
        <label>Brand voice<textarea rows={2} {...field('brand_voice')} /></label>
        <label>Never do<textarea rows={2} {...field('never_do')} placeholder="e.g. never bid on competitor brand names; no discount messaging" /></label>
        <label className="full">Notes<textarea rows={2} {...field('notes')} /></label>
      </div>
      <h3 className="ads-form-heading">Google Analytics 4</h3>
      <div className="form-grid">
        <label>GA4 property
          <input className="input" list={`ga4-${account.id}`} value={ga4} disabled={!canManage} onChange={e => setGa4(e.target.value.replace(/^properties\//, ''))} placeholder="e.g. 449058214" />
          <datalist id={`ga4-${account.id}`}>
            {ga4Properties.map(p => <option key={p.property_id} value={p.property_id}>{`${p.property_name} · ${p.account_name}`}</option>)}
          </datalist>
          <small>
            {account.ga4_property_name && ga4 === account.ga4_property_id ? `Linked: ${account.ga4_property_name}. ` : ''}
            The AI reads this property's paid-search traffic on every routine run. A connected Google login needs Viewer access to it; it's checked when you save.
          </small>
        </label>
        <div className="ads-hint">
          {ga4Options === null ? 'Looking up the GA4 properties your Google logins can read…'
            : ga4Properties.length ? `${ga4Properties.length} GA4 propert${ga4Properties.length === 1 ? 'y' : 'ies'} available. Start typing a name or ID.`
              : 'No GA4 properties found for your connected Google logins. Enter the property ID from GA4 → Admin → Property details.'}
          {ga4Problems.map(l => <div key={l.google_login} className="ads-error-line">{l.google_login}: {l.error}{l.hint ? ` ${l.hint}` : ''}</div>)}
        </div>
      </div>
      <h3 className="ads-form-heading">Guardrails</h3>
      <div className="form-grid">
        <label>What may the AI do?<select className="input" value={guard.mode} disabled={!canManage} onChange={e => setGuard({ ...guard, mode: e.target.value as AdsGuardrails['mode'] })}>
          <option value="guarded">Apply changes inside the limits below; ask me for the rest</option>
          <option value="review">Propose only — I approve every change</option>
          <option value="read_only">Read-only — no changes at all</option>
        </select></label>
        <label>Projected spend may exceed the monthly budget by (%)<input className="input" type="number" min={0} max={100} value={guard.budget_tolerance_pct} disabled={!canManage} onChange={e => setGuard({ ...guard, budget_tolerance_pct: Number(e.target.value) })} /></label>
        <label>Largest budget increase per change (%)<input className="input" type="number" min={0} max={500} value={guard.max_budget_increase_pct} disabled={!canManage} onChange={e => setGuard({ ...guard, max_budget_increase_pct: Number(e.target.value) })} /></label>
        <label>Largest bid change per change (± %)<input className="input" type="number" min={0} max={500} value={guard.max_bid_change_pct} disabled={!canManage} onChange={e => setGuard({ ...guard, max_bid_change_pct: Number(e.target.value) })} /></label>
        <label>Operations per change before approval<input className="input" type="number" min={1} max={1000} value={guard.max_operations} disabled={!canManage} onChange={e => setGuard({ ...guard, max_operations: Number(e.target.value) })} /></label>
        <div className="ads-toggle-list">
          <label><input type="checkbox" checked={guard.allow_enable_campaigns} disabled={!canManage} onChange={e => setGuard({ ...guard, allow_enable_campaigns: e.target.checked })} /> Turn paused campaigns on (still within the budget)</label>
          <label><input type="checkbox" checked={guard.allow_bidding_changes} disabled={!canManage} onChange={e => setGuard({ ...guard, allow_bidding_changes: e.target.checked })} /> Change bid strategies and CPA/ROAS targets</label>
          <label><input type="checkbox" checked={guard.allow_removals} disabled={!canManage} onChange={e => setGuard({ ...guard, allow_removals: e.target.checked })} /> Remove campaigns, ads or keywords (permanent)</label>
          <label><input type="checkbox" checked={enabled} disabled={!canManage} onChange={e => setEnabled(e.target.checked)} /> Include this client in AI routines</label>
        </div>
      </div>
      <p className="ads-hint">Always needs your approval, whatever the settings: conversion and account settings, new campaigns that start enabled, and any spend increase when no monthly budget is set.</p>
    </Modal>
  );
}
