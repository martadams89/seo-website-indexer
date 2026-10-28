import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Check, CheckCheck, Code2, MonitorSmartphone, RotateCcw, X } from 'lucide-react';
import { useToast } from '../AppContext';
import { adsApi, errorMessage, money, type AdsAccount, type AdsChange } from './api';

type Filter = 'waiting' | 'all' | 'applied';
const STATUS_TONE: Record<AdsChange['status'], string> = {
  pending: 'accent', needs_approval: 'warn', blocked: 'error', applying: 'info', applied: 'ok', rejected: 'info', failed: 'error', expired: 'info',
};
const STATUS_LABEL: Record<AdsChange['status'], string> = {
  pending: 'Ready to apply', needs_approval: 'Needs approval', blocked: 'Blocked', applying: 'Applying', applied: 'Applied', rejected: 'Rejected', failed: 'Failed', expired: 'Expired',
};

export function AdsChanges({ accounts, canManage, highlight, reload }: { accounts: AdsAccount[]; canManage: boolean; highlight: string | null; reload: () => Promise<void> }) {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('waiting');
  const [changes, setChanges] = useState<AdsChange[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const highlighted = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    const status = filter === 'waiting' ? 'needs_approval,pending,blocked' : filter === 'applied' ? 'applied' : undefined;
    try { setChanges(await adsApi.changes({ status })); }
    catch (e) { toast('error', errorMessage(e)); }
  }, [filter, toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { highlighted.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [changes]);

  async function act(change: AdsChange, action: 'approve' | 'reject' | 'revert') {
    if (action === 'approve' && !confirm(`Apply this change to Google Ads now?\n\n${change.summary}`)) return;
    setBusy(change.id);
    try {
      const result = await adsApi[action](change.id);
      toast(result.status === 'failed' ? 'error' : 'success',
        action === 'approve' ? (result.status === 'applied' ? 'Change applied in Google Ads' : `Change ${result.status.replace('_', ' ')}`)
          : action === 'reject' ? 'Change rejected' : `Revert proposed — ${STATUS_LABEL[result.status].toLowerCase()}`);
      await Promise.all([load(), reload()]);
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(null);
  }

  const accountName = (id: string) => { const a = accounts.find(x => x.id === id); return a?.name ?? a?.customer_id_formatted ?? 'Unknown account'; };
  const currency = (id: string) => accounts.find(x => x.id === id)?.currency ?? null;

  return (
    <section className="ops-card">
      <div className="ops-card-head">
        <div><span className="eyebrow"><CheckCheck size={13} /> Change log</span><h2>Approvals and history</h2></div>
        <div className="ops-tabs" role="group" aria-label="Filter changes">
          {(['waiting', 'applied', 'all'] as Filter[]).map(f => <button key={f} type="button" className={filter === f ? 'active' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'waiting' ? 'Waiting' : f}</button>)}
        </div>
      </div>
      <p className="card-intro">Every change — from you or an AI assistant — is validated by Google first and checked against the client's guardrails. Approving applies it immediately.</p>
      <div className="ads-change-list">
        {changes?.map(change => (
          <AdsChangeCard key={change.id} change={change} accountLabel={accountName(change.ads_account_id)} currency={currency(change.ads_account_id)}
            canManage={canManage} busy={busy === change.id} onAct={action => act(change, action)}
            highlight={change.id === highlight} cardRef={change.id === highlight ? (el => { highlighted.current = el; }) : undefined} />
        ))}
        {changes && !changes.length && <div className="ops-empty compact"><CheckCheck /><strong>{filter === 'waiting' ? 'Nothing waiting for you' : 'No changes yet'}</strong><span>Changes from the dashboard and from AI routines appear here.</span></div>}
        {!changes && <div className="page-loading">Loading changes…</div>}
      </div>
    </section>
  );
}

/** One proposed or applied change: what it does, why, its checks and impact, and the buttons to decide on it. */
export function AdsChangeCard({ change, accountLabel, currency: cur, canManage, busy, onAct, highlight = false, cardRef }: {
  change: AdsChange; accountLabel: string; currency: string | null; canManage: boolean; busy: boolean;
  onAct: (action: 'approve' | 'reject' | 'revert') => void; highlight?: boolean; cardRef?: (el: HTMLElement | null) => void;
}) {
  const impact = change.impact;
  return (
    <article ref={cardRef} className={`ads-change status-${change.status} ${highlight ? 'highlight' : ''}`}>
      <header>
        <span className={`badge badge-${STATUS_TONE[change.status]}`}>{STATUS_LABEL[change.status]}</span>
        <span className="ads-source">{change.source === 'mcp' ? <><Bot size={12} /> AI assistant</> : <><MonitorSmartphone size={12} /> Dashboard</>}</span>
        <span className="text-dim">{accountLabel} · {new Date(change.created_at).toLocaleString()}</span>
      </header>
      <h3>{change.summary}</h3>
      {change.rationale && <p>{change.rationale}</p>}
      {change.findings.length > 0 && (
        <ul className="ads-reasons">{change.findings.map(f => <li key={f.code + f.message} className={f.severity}>{f.message}</li>)}</ul>
      )}
      {(impact.daily_budget_before !== undefined && impact.daily_budget_before !== impact.daily_budget_after) && (
        <p className="ads-impact">Daily budgets {money(impact.daily_budget_before, cur)} → <b>{money(impact.daily_budget_after, cur)}</b>{impact.per_lead_daily_spend ? ` · Local Services ~${money(impact.per_lead_daily_spend, cur)}/day (per lead)` : ''} · projected month {money(impact.projected_month_spend, cur)}{impact.monthly_budget ? ` of ${money(impact.monthly_budget, cur)}` : ''}</p>
      )}
      {change.error && <p className="ads-error-line">{change.error}</p>}
      <details><summary><Code2 size={13} /> {change.operations.length} operation{change.operations.length === 1 ? '' : 's'}</summary><pre>{JSON.stringify(change.operations, null, 2)}</pre></details>
      <footer>
        {(change.status === 'needs_approval' || change.status === 'pending') && (
          <button className="btn btn-primary btn-sm" disabled={!canManage || busy} onClick={() => onAct('approve')}><Check size={13} /> {change.status === 'pending' ? 'Apply now' : 'Approve & apply'}</button>
        )}
        {['needs_approval', 'pending', 'blocked'].includes(change.status) && (
          <button className="btn btn-ghost btn-sm" disabled={!canManage || busy} onClick={() => onAct('reject')}><X size={13} /> Reject</button>
        )}
        {change.status === 'applied' && (
          <button className="btn btn-ghost btn-sm" disabled={!canManage || busy} onClick={() => onAct('revert')}><RotateCcw size={13} /> Revert</button>
        )}
        {change.applied_at && <span className="text-dim">Applied {new Date(change.applied_at).toLocaleString()}</span>}
      </footer>
    </article>
  );
}
