import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, ExternalLink, Megaphone, RefreshCw, Send, Tag, Trash2 } from 'lucide-react';
import { useToast } from '../AppContext';
import { errorMessage } from '../ads/api';
import { reviewsApi, type BusinessPost, type PostDraft, type ReviewLocation } from './api';
import { LocationPicker } from './BusinessProfileTab';
import { changeOutcome } from './format';

const MAX_POST = 1500;
const BUTTONS: Array<{ id: string; label: string }> = [
  { id: '', label: 'No button' }, { id: 'LEARN_MORE', label: 'Learn more' }, { id: 'BOOK', label: 'Book' }, { id: 'ORDER', label: 'Order online' },
  { id: 'SHOP', label: 'Buy' }, { id: 'SIGN_UP', label: 'Sign up' }, { id: 'CALL', label: 'Call now' },
];
const TOPIC_LABEL: Record<string, string> = { STANDARD: 'Update', EVENT: 'Event', OFFER: 'Offer', ALERT: 'Alert' };
const STATE_TONE: Record<string, string> = { LIVE: 'ok', PROCESSING: 'info', REJECTED: 'error' };
const PHONE_RE = /(?:\+?\d[\s().-]?){9,}/;

const blank = (): PostDraft => ({ topic: 'STANDARD', summary: '', cta_type: '', cta_url: '', photo_url: '' });

export function BusinessPostsTab({ locations, locationId, canManage, onPick, reload }: {
  locations: ReviewLocation[]; locationId: string; canManage: boolean; onPick: (id: string) => void; reload: () => Promise<void>;
}) {
  const toast = useToast();
  const location = locations.find(l => l.id === locationId) ?? locations[0];
  const [posts, setPosts] = useState<BusinessPost[] | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<PostDraft>(blank);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback((fresh = false) => reviewsApi.posts(location.id, fresh)
    .then(p => { setPosts(p); setError(''); })
    .catch(e => { setPosts(null); setError(errorMessage(e)); }), [location.id]);
  useEffect(() => { void load(); }, [load]);

  const set = <K extends keyof PostDraft>(key: K, value: PostDraft[K]) => setDraft(d => ({ ...d, [key]: value }));
  const dated = draft.topic === 'EVENT' || draft.topic === 'OFFER';
  const phoneInText = PHONE_RE.test(draft.summary ?? '');

  async function publish() {
    setBusy('publish');
    try {
      const body = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== '' && v !== undefined)) as unknown as PostDraft;
      const change = await reviewsApi.createPost(location.id, body);
      toast(change.status === 'published' ? 'success' : 'warning', changeOutcome(change));
      setDraft(blank());
      await Promise.all([load(true), reload()]);
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(null);
  }

  async function remove(post: BusinessPost) {
    if (!window.confirm('Delete this post from Google?')) return;
    setBusy(post.name);
    try { const change = await reviewsApi.deletePost(location.id, post.name); toast('success', changeOutcome(change)); await load(true); }
    catch (e) { toast('error', errorMessage(e)); }
    setBusy(null);
  }

  return (
    <div className="ads-setup">
      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">New post</span><h2>Post to {location.title ?? 'the profile'}</h2></div>
          <LocationPicker locations={locations} location={location} onPick={onPick} />
        </div>
        <p className="card-intro">Posts show on the profile in Search and Maps. Weekly updates, offers and events keep it looking active.</p>
        <fieldset className="reviews-fieldset" disabled={!canManage}>
          <label>Type
            <select className="input" value={draft.topic} onChange={e => set('topic', e.target.value as PostDraft['topic'])}>
              <option value="STANDARD">Update</option><option value="EVENT">Event</option><option value="OFFER">Offer</option>
            </select>
          </label>
          <label>Photo (public image address)<input className="input" type="url" value={draft.photo_url ?? ''} onChange={e => set('photo_url', e.target.value)} placeholder="https://…/photo.jpg" /></label>
          {dated && <>
            <label className="reviews-wide">{draft.topic === 'EVENT' ? 'Event' : 'Offer'} title<input className="input" maxLength={58} value={draft.event_title ?? ''} onChange={e => set('event_title', e.target.value)} /></label>
            <label>Starts<span className="gbp-date-time"><input className="input" type="date" value={draft.start_date ?? ''} onChange={e => set('start_date', e.target.value)} /><input className="input" aria-label="Start time" value={draft.start_time ?? ''} onChange={e => set('start_time', e.target.value)} placeholder="optional 09:00" /></span></label>
            <label>Ends<span className="gbp-date-time"><input className="input" type="date" value={draft.end_date ?? ''} onChange={e => set('end_date', e.target.value)} /><input className="input" aria-label="End time" value={draft.end_time ?? ''} onChange={e => set('end_time', e.target.value)} placeholder="optional 17:00" /></span></label>
          </>}
          <label className="reviews-wide">Text <small className="text-dim">{(draft.summary ?? '').length} / {MAX_POST}</small>
            <textarea className="input" rows={5} maxLength={MAX_POST} value={draft.summary ?? ''} onChange={e => set('summary', e.target.value)} placeholder="What's new, in plain words." />
          </label>
          {phoneInText && <small className="ads-error-line reviews-wide">Google rejects posts that contain a phone number. Remove it and use the "Call now" button instead.</small>}
          <label>Button
            <select className="input" value={draft.cta_type ?? ''} onChange={e => set('cta_type', e.target.value)}>
              {BUTTONS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
          </label>
          {draft.cta_type && draft.cta_type !== 'CALL' && <label>Button link<input className="input" type="url" value={draft.cta_url ?? ''} onChange={e => set('cta_url', e.target.value)} placeholder="https://" /></label>}
          {draft.topic === 'OFFER' && <>
            <label>Coupon code<input className="input" maxLength={58} value={draft.coupon_code ?? ''} onChange={e => set('coupon_code', e.target.value)} /></label>
            <label>Redeem online link<input className="input" type="url" value={draft.redeem_url ?? ''} onChange={e => set('redeem_url', e.target.value)} placeholder="https://" /></label>
            <label className="reviews-wide">Terms and conditions<textarea className="input" rows={2} value={draft.terms ?? ''} onChange={e => set('terms', e.target.value)} /></label>
          </>}
        </fieldset>
        <div className="ads-row-actions">
          <button className="btn btn-primary" disabled={!canManage || busy === 'publish' || phoneInText || (draft.topic === 'STANDARD' ? !draft.summary?.trim() : !draft.event_title?.trim() || !draft.start_date || !draft.end_date)} onClick={publish}>
            <Send size={14} /> {busy === 'publish' ? 'Posting…' : 'Publish to Google'}
          </button>
        </div>
      </section>

      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">Posts</span><h2>On the profile now</h2></div>
          <button className="btn btn-ghost btn-sm" onClick={() => void load(true)}><RefreshCw size={13} /> Refresh</button>
        </div>
        {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}
        {!posts && !error && <div className="page-loading">Loading posts…</div>}
        {posts && !posts.length && <div className="ops-empty compact"><Megaphone /><strong>No posts yet</strong><span>Post an update, offer or event above.</span></div>}
        <div className="review-list">
          {posts?.map(post => (
            <article key={post.name} className="review-card gbp-post">
              <header>
                <span className="badge badge-info">{post.topic === 'EVENT' ? <CalendarDays size={11} /> : post.topic === 'OFFER' ? <Tag size={11} /> : <Megaphone size={11} />} {TOPIC_LABEL[post.topic] ?? post.topic}</span>
                {post.state && <span className={`badge badge-${STATE_TONE[post.state] ?? 'info'}`}>{post.state === 'LIVE' ? 'Live' : post.state === 'REJECTED' ? 'Rejected by Google' : post.state.toLowerCase()}</span>}
                {post.title && <strong>{post.title}</strong>}
                <small>{post.created ? new Date(post.created).toLocaleDateString() : ''}{post.start ? ` · ${post.start}${post.end && post.end !== post.start ? ` to ${post.end}` : ''}` : ''}</small>
              </header>
              <div className="gbp-post-body">
                {post.photo && <img src={post.photo} alt="" loading="lazy" />}
                <p>{post.summary ?? ''}</p>
              </div>
              <div className="ads-row-actions">
                {post.button && <small className="text-dim">Button: {BUTTONS.find(b => b.id === post.button!.type)?.label ?? post.button.type}{post.coupon_code ? ` · code ${post.coupon_code}` : ''}</small>}
                {post.url && <a className="btn btn-ghost btn-sm" href={post.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> View on Google</a>}
                <button className="btn btn-ghost btn-sm" disabled={!canManage || busy === post.name} onClick={() => remove(post)}><Trash2 size={13} /> Delete</button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
