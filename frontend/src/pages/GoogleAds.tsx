import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, Bot, CheckCheck, Megaphone, RefreshCw, Settings2, Users } from 'lucide-react';
import { adsApi, errorMessage, type AdsAccount, type AdsSetup } from '../ads/api';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { AdsSetupView } from '../ads/AdsSetup';
import { AdsClients } from '../ads/AdsClients';
import { AdsOverviewView } from '../ads/AdsOverview';
import { AdsChanges } from '../ads/AdsChanges';
import { AdsRoutine } from '../ads/AdsRoutine';
import '../ads/ads.css';

type Tab = 'overview' | 'changes' | 'clients' | 'routine' | 'setup';
const TABS: Array<{ id: Tab; label: string; icon: typeof BarChart3 }> = [
  { id: 'overview', label: 'Performance', icon: BarChart3 },
  { id: 'changes', label: 'Approvals & history', icon: CheckCheck },
  { id: 'clients', label: 'Clients & guardrails', icon: Users },
  { id: 'routine', label: 'AI routine', icon: Bot },
  { id: 'setup', label: 'Setup', icon: Settings2 },
];

export default function GoogleAdsPage() {
  const { active } = useWorkspace();
  const canManage = !!active?.permissions?.manage_ads;
  const [params, setParams] = useSearchParams();
  const [setup, setSetup] = useState<AdsSetup | null>(null);
  const [accounts, setAccounts] = useState<AdsAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      const [s, a] = await Promise.all([adsApi.setup(fresh), adsApi.accounts()]);
      setSetup(s);
      setAccounts(a);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load, active?.id]);

  const needsSetup = !!setup && (!setup.steps.ads_scope || !setup.steps.accounts_linked);
  const tab = (params.get('tab') as Tab | null) ?? (needsSetup ? 'setup' : 'overview');
  const accountId = params.get('account') ?? accounts.find(a => a.enabled)?.id ?? accounts[0]?.id ?? '';
  const account = useMemo(() => accounts.find(a => a.id === accountId) ?? null, [accounts, accountId]);
  const pending = accounts.reduce((sum, a) => sum + a.pending_approvals, 0);

  function go(next: { tab?: Tab; account?: string; change?: string | null }) {
    const p = new URLSearchParams(params);
    if (next.tab) p.set('tab', next.tab);
    if (next.account) p.set('account', next.account);
    if (next.change === null) p.delete('change');
    else if (next.change) p.set('change', next.change);
    setParams(p, { replace: true });
  }

  return (
    <div className="ops-page ads-page">
      <header className="ops-page-header">
        <div>
          <span className="eyebrow"><Megaphone size={13} /> Paid search</span>
          <h1>Google Ads</h1>
          <p>Audit, optimise and pace every client's Google Ads from one place — by hand or with an AI routine that works inside the budgets and guardrails you set here.</p>
        </div>
        <div className="header-actions">
          {accounts.length > 0 && (
            <select className="input ads-account-select" aria-label="Client ad account" value={accountId} onChange={e => go({ account: e.target.value })}>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name ?? a.customer_id_formatted}{a.enabled ? '' : ' (paused)'}</option>)}
            </select>
          )}
          <button className="btn btn-secondary" disabled={loading} onClick={() => load(true)}>
            <RefreshCw size={14} className={loading ? 'spin' : undefined} /> Refresh
          </button>
        </div>
      </header>

      <nav className="ops-tabs ads-tabs" aria-label="Google Ads sections">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={tab === id ? 'active' : ''} aria-pressed={tab === id} onClick={() => go({ tab: id, change: null })}>
            <Icon size={14} /> {label}
            {id === 'changes' && pending > 0 && <span className="badge badge-warn">{pending}</span>}
            {id === 'setup' && needsSetup && <span className="badge badge-accent">Start here</span>}
          </button>
        ))}
      </nav>

      {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}
      {!canManage && <div className="alert alert-info"><div className="alert-content">You can view Google Ads data in this workspace. Changing budgets, guardrails or approving changes needs the “Manage Google Ads” permission.</div></div>}

      {tab === 'setup' && <AdsSetupView setup={setup} accounts={accounts} canManage={canManage} reload={load} onLinked={() => go({ tab: 'clients' })} />}
      {tab === 'clients' && <AdsClients accounts={accounts} canManage={canManage} reload={load} onOpen={id => go({ tab: 'overview', account: id })} />}
      {tab === 'overview' && (account
        ? <AdsOverviewView key={account.id} account={account} />
        : <EmptyState onSetup={() => go({ tab: 'setup' })} loading={loading} />)}
      {tab === 'changes' && <AdsChanges accounts={accounts} canManage={canManage} highlight={params.get('change')} reload={load} />}
      {tab === 'routine' && <AdsRoutine accounts={accounts} canManage={canManage} reload={load} />}
    </div>
  );
}

function EmptyState({ onSetup, loading }: { onSetup: () => void; loading: boolean }) {
  if (loading) return <div className="page-loading">Loading Google Ads…</div>;
  return (
    <section className="ops-card">
      <div className="ops-empty">
        <Megaphone />
        <h3>No client ad accounts linked yet</h3>
        <p>Connect a Google account with Google Ads access and link the client accounts you manage.</p>
        <button className="btn btn-primary" onClick={onSetup}>Open setup</button>
      </div>
    </section>
  );
}
