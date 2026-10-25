import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart3, Bot, CheckCheck, Inbox, MapPin, RefreshCw, Settings2, Star } from 'lucide-react';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { errorMessage } from '../ads/api';
import { reviewsApi, type ReviewLocation, type ReviewsSetup } from '../reviews/api';
import { ReviewsInbox } from '../reviews/ReviewsInbox';
import { ReviewsApprovals } from '../reviews/ReviewsApprovals';
import { ReviewsLocations } from '../reviews/ReviewsLocations';
import { ReviewsInsights } from '../reviews/ReviewsInsights';
import { ReviewsRoutine } from '../reviews/ReviewsRoutine';
import { ReviewsSetupView } from '../reviews/ReviewsSetup';
import '../ads/ads.css';
import '../reviews/reviews.css';

type Tab = 'inbox' | 'approvals' | 'insights' | 'locations' | 'routine' | 'setup';
const TABS: Array<{ id: Tab; label: string; icon: typeof Inbox }> = [
  { id: 'inbox', label: 'Reviews', icon: Inbox },
  { id: 'approvals', label: 'Approvals & history', icon: CheckCheck },
  { id: 'insights', label: 'Insights', icon: BarChart3 },
  { id: 'locations', label: 'Locations & reply rules', icon: MapPin },
  { id: 'routine', label: 'AI routine', icon: Bot },
  { id: 'setup', label: 'Setup', icon: Settings2 },
];

export default function ReviewsPage() {
  const { active } = useWorkspace();
  const canManage = !!active?.permissions?.manage_reviews;
  const [params, setParams] = useSearchParams();
  const [setup, setSetup] = useState<ReviewsSetup | null>(null);
  const [locations, setLocations] = useState<ReviewLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback((fresh = false) => Promise.all([reviewsApi.setup(fresh), reviewsApi.locations()])
    .then(([s, l]) => { setSetup(s); setLocations(l); setError(''); })
    .catch(e => setError(errorMessage(e)))
    .finally(() => setLoading(false)), []);

  useEffect(() => { void load(); }, [load, active?.id]);

  const needsSetup = !!setup && (!setup.steps.business_scope || !setup.steps.locations_linked);
  const tab = (params.get('tab') as Tab | null) ?? (needsSetup ? 'setup' : 'inbox');
  const locationId = params.get('location') ?? '';
  const waiting = locations.reduce((sum, l) => sum + l.stats.awaiting_approval, 0);
  const unreplied = locations.reduce((sum, l) => sum + l.stats.unreplied, 0);

  function go(next: { tab?: Tab; location?: string | null }) {
    const p = new URLSearchParams(params);
    if (next.tab) p.set('tab', next.tab);
    if (next.location === null) p.delete('location');
    else if (next.location) p.set('location', next.location);
    setParams(p, { replace: true });
  }

  return (
    <div className="ops-page ads-page reviews-page">
      <header className="ops-page-header">
        <div>
          <span className="eyebrow"><Star size={13} /> Local</span>
          <h1>Google reviews</h1>
          <p>Read and answer every client's Google reviews in one place — by hand, or with an AI assistant that replies within the rules you set for each location.</p>
        </div>
        <div className="header-actions">
          {locations.length > 1 && (
            <select className="input ads-account-select" aria-label="Location" value={locationId} onChange={e => go({ location: e.target.value || null })}>
              <option value="">All locations</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.title ?? l.location_name}{l.enabled ? '' : ' (paused)'}</option>)}
            </select>
          )}
          <button className="btn btn-secondary" disabled={loading} onClick={() => { setLoading(true); void load(true); }}>
            <RefreshCw size={14} className={loading ? 'spin' : undefined} /> Refresh
          </button>
        </div>
      </header>

      <nav className="ops-tabs ads-tabs" aria-label="Google reviews sections">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={tab === id ? 'active' : ''} aria-pressed={tab === id} onClick={() => go({ tab: id })}>
            <Icon size={14} /> {label}
            {id === 'inbox' && unreplied > 0 && <span className="badge badge-info">{unreplied}</span>}
            {id === 'approvals' && waiting > 0 && <span className="badge badge-warn">{waiting}</span>}
            {id === 'setup' && needsSetup && <span className="badge badge-accent">Start here</span>}
          </button>
        ))}
      </nav>

      {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}
      {!canManage && <div className="alert alert-info"><div className="alert-content">You can read reviews in this workspace. Replying, approving replies or changing reply rules needs the “Manage Google reviews” permission.</div></div>}

      {tab === 'setup' && <ReviewsSetupView setup={setup} canManage={canManage} reload={load} onLinked={() => go({ tab: 'locations' })} />}
      {tab === 'inbox' && (locations.length
        ? <ReviewsInbox locations={locations} locationId={locationId} canManage={canManage} reload={load} />
        : <EmptyState loading={loading} onSetup={() => go({ tab: 'setup' })} />)}
      {tab === 'approvals' && <ReviewsApprovals canManage={canManage} reload={load} />}
      {tab === 'insights' && (locations.length
        ? <ReviewsInsights locations={locations} locationId={locationId || locations[0].id} onPick={id => go({ location: id })} />
        : <EmptyState loading={loading} onSetup={() => go({ tab: 'setup' })} />)}
      {tab === 'locations' && <ReviewsLocations locations={locations} canManage={canManage} reload={load} onOpen={id => go({ tab: 'inbox', location: id })} />}
      {tab === 'routine' && <ReviewsRoutine locations={locations} />}
    </div>
  );
}

function EmptyState({ onSetup, loading }: { onSetup: () => void; loading: boolean }) {
  if (loading) return <div className="page-loading">Loading reviews…</div>;
  return (
    <section className="ops-card">
      <div className="ops-empty">
        <Star />
        <h3>No Business Profile locations linked yet</h3>
        <p>Connect a Google account that manages your clients' Business Profiles, then link their locations.</p>
        <button className="btn btn-primary" onClick={onSetup}>Open setup</button>
      </div>
    </section>
  );
}
