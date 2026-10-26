/**
 * Approve — one item an AI assistant proposed, opened from the "Approve or
 * reject" link in a notification: /w/<workspace>/approve/<kind>/<id>, where
 * kind is reply (review reply), business (Business Profile change) or ads
 * (Google Ads change). The link only works for someone signed in to the
 * workspace, so a forwarded email or a link scanner can't decide anything.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCheck, Megaphone, Star } from 'lucide-react';
import { useToast } from '../AppContext';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { AdsChangeCard } from '../ads/AdsChanges';
import { adsApi, errorMessage, type AdsChange } from '../ads/api';
import { reviewsApi, type ProfileChange } from '../reviews/api';
import { ApprovalCard, ChangeCard, type ReplyRow } from '../reviews/ReviewsApprovals';
import '../ads/ads.css';
import '../reviews/reviews.css';

type Kind = 'reply' | 'business' | 'ads';
type AdsItem = Awaited<ReturnType<typeof adsApi.change>>;
type Item = { kind: 'reply'; row: ReplyRow } | { kind: 'business'; change: ProfileChange } | { kind: 'ads'; change: AdsItem };

const TITLE: Record<Kind, string> = { reply: 'Review reply', business: 'Business Profile change', ads: 'Google Ads change' };
const BACK: Record<Kind, { to: string; label: string }> = {
  reply: { to: '/reviews?tab=approvals', label: 'All Business Profile approvals' },
  business: { to: '/reviews?tab=approvals', label: 'All Business Profile approvals' },
  ads: { to: '/ads?tab=changes', label: 'All Google Ads changes' },
};

async function fetchItem(kind: Kind, id: string): Promise<Item> {
  if (kind === 'reply') return { kind, row: await reviewsApi.replyPlan(id) };
  if (kind === 'business') return { kind, change: await reviewsApi.change(id) };
  return { kind, change: await adsApi.change(id) };
}

export default function ApprovePage() {
  const params = useParams();
  const kind = (['reply', 'business', 'ads'] as const).find(k => k === params.kind) ?? null;
  const id = params.id ?? '';
  const { active } = useWorkspace();
  const toast = useToast();
  const [item, setItem] = useState<Item | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => (kind && id ? fetchItem(kind, id) : Promise.reject(new Error('This link isn\'t complete.')))
    .then(next => { setItem(next); setError(''); }, e => setError(errorMessage(e))), [kind, id]);
  useEffect(() => { void load(); }, [load]);

  if (!kind) return <div className="ops-page"><div className="alert alert-error"><div className="alert-content">This link isn't one the app recognises.</div></div></div>;

  const canManage = kind === 'ads' ? !!active?.permissions?.manage_ads : !!active?.permissions?.manage_reviews;
  const waiting = !item ? false
    : item.kind === 'reply' ? item.row.status === 'needs_approval'
    : item.kind === 'business' ? item.change.status === 'needs_approval'
    : ['needs_approval', 'pending', 'blocked'].includes(item.change.status);
  const failed = (item?.kind === 'reply' ? item.row.status : item?.change.status) === 'failed';

  async function actOnAds(change: AdsChange, action: 'approve' | 'reject' | 'revert') {
    if (action === 'approve' && !confirm(`Apply this change to Google Ads now?\n\n${change.summary}`)) return;
    if (action === 'revert' && !confirm('Propose undoing this change?')) return;
    setBusy(true);
    try {
      const result = await adsApi[action](change.id);
      toast(result.status === 'failed' ? 'error' : 'success',
        action === 'approve' ? (result.status === 'applied' ? 'Change applied in Google Ads' : `Change ${result.status.replace('_', ' ')}`)
          : action === 'reject' ? 'Change rejected' : 'Revert proposed — it is in the Google Ads change log');
      await load();
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(false);
  }

  const Icon = kind === 'ads' ? Megaphone : Star;
  return (
    <div className="ops-page ads-page reviews-page approve-page">
      <header className="ops-page-header">
        <div>
          <span className="eyebrow"><Icon size={13} /> {active?.name ?? 'Workspace'}</span>
          <h1>{TITLE[kind]}</h1>
          <p>{!item ? (error ? 'This link couldn\'t be opened.' : 'Opening the item from your notification…')
            : waiting ? 'An AI assistant proposed this and it needs a person to decide. Approving publishes it to Google straight away.' : 'Here is what happened to this item.'}</p>
        </div>
        <div className="header-actions">
          <Link className="btn btn-secondary" to={BACK[kind].to}><ArrowLeft size={14} /> {BACK[kind].label}</Link>
        </div>
      </header>

      {error && <div className="alert alert-error"><div className="alert-content">{error === 'Reply not found.' || error === 'Change not found.' ? `${error} It may belong to another workspace, or have been removed.` : error}</div></div>}
      {item && !canManage && <div className="alert alert-info"><div className="alert-content">You can see this, but approving it needs the “{kind === 'ads' ? 'Manage Google Ads' : 'Manage Google Business Profile'}” permission in this workspace.</div></div>}
      {item && !waiting && (failed
        ? <div className="alert alert-warn"><div className="alert-content">Google didn't accept this — the error is below. Ask the assistant to try again, or make the change yourself.</div></div>
        : <div className="alert alert-ok"><div className="alert-content"><CheckCheck size={14} /> Nothing to do — this has already been decided.</div></div>)}

      {(item || !error) && <section className="ops-card">
        {!item && <div className="page-loading">Loading…</div>}
        {item?.kind === 'reply' && <div className="review-list"><ApprovalCard key={`${item.row.id}:${item.row.status}`} row={item.row} canManage={canManage} onDone={load} /></div>}
        {item?.kind === 'business' && <div className="review-list"><ChangeCard key={`${item.change.id}:${item.change.status}`} change={item.change} canManage={canManage} onDone={load} /></div>}
        {item?.kind === 'ads' && (
          <div className="ads-change-list">
            <AdsChangeCard change={item.change} canManage={canManage} busy={busy}
              accountLabel={item.change.account ? `${item.change.account.name ?? 'Google Ads'} (${item.change.account.customer_id})` : 'Unknown account'}
              currency={item.change.account?.currency ?? null} onAct={action => actOnAds(item.change, action)} />
          </div>
        )}
      </section>}
    </div>
  );
}
