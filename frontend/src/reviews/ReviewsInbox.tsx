import { useCallback, useEffect, useState } from 'react';
import { Bot, Image, MessageSquareReply, Search, Star, Trash2 } from 'lucide-react';
import { useToast } from '../AppContext';
import { errorMessage } from '../ads/api';
import { reviewsApi, type Review, type ReviewFilter, type ReviewLocation } from './api';

const FILTERS: Array<{ id: ReviewFilter; label: string }> = [
  { id: 'unreplied', label: 'Needs a reply' },
  { id: 'negative', label: '1–3 stars' },
  { id: 'awaiting_approval', label: 'Draft awaiting approval' },
  { id: 'reply_rejected', label: 'Reply rejected by Google' },
  { id: 'all', label: 'All reviews' },
];

const PAGE = 25;

export function Stars({ rating }: { rating: number }) {
  return (
    <span className="review-stars" aria-label={rating ? `${rating} out of 5 stars` : 'No star rating'}>
      {[1, 2, 3, 4, 5].map(n => <Star key={n} size={13} className={n <= rating ? 'on' : ''} />)}
    </span>
  );
}

const when = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

export function ReviewsInbox({ locations, locationId, canManage, reload }: {
  locations: ReviewLocation[]; locationId: string; canManage: boolean; reload: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<ReviewFilter>('unreplied');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [reviews, setReviews] = useState<Review[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback((offset = 0) => reviewsApi.reviews({ locationId: locationId || undefined, filter, search: query, limit: PAGE, offset })
    .then(res => {
      setReviews(current => offset ? [...current, ...res.reviews] : res.reviews);
      setTotal(res.total);
      setError('');
    })
    .catch(e => setError(errorMessage(e)))
    .finally(() => setLoading(false)), [locationId, filter, query]);
  useEffect(() => { void load(); }, [load]);

  const titles = Object.fromEntries(locations.map(l => [l.id, l.title ?? l.location_name]));
  const changed = async () => { await Promise.all([load(), reload()]); };

  return (
    <section className="ops-card">
      <div className="ads-toolbar reviews-toolbar">
        <div className="ops-tabs" role="group" aria-label="Show">
          {FILTERS.map(f => <button key={f.id} type="button" className={filter === f.id ? 'active' : ''} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
        <form className="reviews-search" onSubmit={e => { e.preventDefault(); setQuery(search.trim()); }}>
          <Search size={13} />
          <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search reviews" aria-label="Search reviews" />
        </form>
      </div>
      {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}
      <div className="review-list">
        {reviews.map(r => <ReviewCard key={r.id} review={r} locationTitle={locationId ? null : titles[r.location_id] ?? null} canManage={canManage} onChanged={changed} />)}
        {!loading && !reviews.length && (
          <div className="ops-empty compact"><Star /><strong>{filter === 'unreplied' ? 'Every review has a reply' : 'No reviews match'}</strong><span>{filter === 'unreplied' ? 'New reviews are synced about every hour.' : 'Try another filter.'}</span></div>
        )}
      </div>
      {reviews.length < total && <button className="btn btn-ghost reviews-more" disabled={loading} onClick={() => { setLoading(true); void load(reviews.length); }}>{loading ? 'Loading…' : `Show more (${total - reviews.length})`}</button>}
    </section>
  );
}

function ReviewCard({ review, locationTitle, canManage, onChanged }: { review: Review; locationTitle: string | null; canManage: boolean; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState(review.reply_comment ?? '');
  const [busy, setBusy] = useState(false);

  async function publish() {
    setBusy(true);
    try {
      await reviewsApi.reply(review.id, text);
      toast('success', 'Reply published. Google checks replies before showing them.');
      setComposing(false);
      await onChanged();
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(false);
  }

  async function remove() {
    if (!window.confirm('Delete this reply on Google?')) return;
    setBusy(true);
    try { await reviewsApi.deleteReply(review.id); toast('success', 'Reply deleted'); await onChanged(); }
    catch (e) { toast('error', errorMessage(e)); }
    setBusy(false);
  }

  const state = review.reply_state;
  return (
    <article className={`review-card ${review.rating && review.rating <= 3 ? 'negative' : ''}`}>
      <header>
        <Stars rating={review.rating} />
        <strong>{review.anonymous ? 'Anonymous' : review.reviewer_name ?? 'Google user'}</strong>
        <small>{when(review.create_time)}{locationTitle ? ` · ${locationTitle}` : ''}</small>
      </header>
      <p className={review.comment ? '' : 'muted'}>{review.comment ?? 'Rating only — no text.'}</p>
      {review.media.length > 0 && <small className="review-media"><Image size={12} /> {review.media.length} photo{review.media.length === 1 ? '' : 's'} or video{review.media.length === 1 ? '' : 's'}</small>}
      {review.reply_comment && !composing && (
        <div className="review-reply">
          <div className="review-reply-head">
            <span>Your reply · {when(review.reply_update_time)}</span>
            {state === 'PENDING' && <span className="badge badge-info">Google is checking it</span>}
            {state === 'REJECTED' && <span className="badge badge-error">Rejected by Google{review.reply_policy_violation ? `: ${review.reply_policy_violation.toLowerCase().replace(/_/g, ' ')}` : ''}</span>}
          </div>
          <p>{review.reply_comment}</p>
        </div>
      )}
      {review.pending_reply && (
        <div className="review-draft"><Bot size={13} /> An AI draft is waiting for approval: “{review.pending_reply.text ?? 'delete the reply'}” — see Approvals.</div>
      )}
      {composing ? (
        <div className="review-composer">
          <textarea className="input" rows={4} value={text} onChange={e => setText(e.target.value)} aria-label="Reply" autoFocus />
          <div className="ads-row-actions">
            <small className="text-dim">{text.length} characters</small>
            <button className="btn btn-ghost btn-sm" onClick={() => { setComposing(false); setText(review.reply_comment ?? ''); }}>Cancel</button>
            <button className="btn btn-primary btn-sm" disabled={busy || !text.trim()} onClick={publish}>{busy ? 'Publishing…' : 'Publish reply'}</button>
          </div>
        </div>
      ) : canManage && (
        <div className="ads-row-actions">
          <button className="btn btn-secondary btn-sm" onClick={() => setComposing(true)}><MessageSquareReply size={13} /> {review.reply_comment ? 'Edit reply' : 'Reply'}</button>
          {review.reply_comment && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={remove}><Trash2 size={13} /> Delete reply</button>}
        </div>
      )}
    </article>
  );
}
