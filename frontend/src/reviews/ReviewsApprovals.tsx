import { useCallback, useEffect, useState } from 'react';
import { Bot, CalendarClock, Check, CheckCheck, History, Store, X } from 'lucide-react';
import { useToast } from '../AppContext';
import { errorMessage } from '../ads/api';
import { reviewsApi, type ProfileChange, type ReplyPlan, type Review } from './api';
import { Stars } from './ReviewsInbox';
import { CHANGE_STATUS, localTime, PLAN_STATUS as STATUS } from './format';

export type ReplyRow = ReplyPlan & { review: Review | null; location_title: string | null };
type Row = ReplyRow;

export function ReviewsApprovals({ canManage, reload }: { canManage: boolean; reload: () => Promise<void> }) {
  const [waiting, setWaiting] = useState<Row[]>([]);
  const [history, setHistory] = useState<Row[]>([]);
  const [changes, setChanges] = useState<ProfileChange[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(() => Promise.all([reviewsApi.replies('needs_approval'), reviewsApi.replies(), reviewsApi.changes()])
    .then(([w, all, c]) => {
      setWaiting(w);
      setHistory(all.filter(r => r.status !== 'needs_approval').slice(0, 50));
      setChanges(c);
      setError('');
    })
    .catch(e => setError(errorMessage(e))), []);
  const waitingChanges = changes.filter(c => c.status === 'needs_approval');
  const waitingMedia = waitingChanges.filter(c => c.kind === 'photo');
  const scheduled = changes.filter(c => c.status === 'scheduled').sort((a, b) => String(a.publish_at).localeCompare(String(b.publish_at)));
  const toast = useToast();
  const [approvingAll, setApprovingAll] = useState(false);
  const changeHistory = changes.filter(c => c.status !== 'needs_approval' && c.status !== 'scheduled').slice(0, 50);
  useEffect(() => { void load(); }, [load]);
  const changed = async () => { await Promise.all([load(), reload()]); };

  /** A day's photos from an assistant can be dozens of items: publish them in one go. */
  async function approveAllMedia() {
    if (!confirm(`Publish all ${waitingMedia.length} photos and videos to Google?`)) return;
    setApprovingAll(true);
    let published = 0; const failed: string[] = [];
    for (const c of waitingMedia) {
      try { const r = await reviewsApi.approveChange(c.id); if (r.status === 'published') published++; else failed.push(r.error ?? c.summary); }
      catch (e) { failed.push(errorMessage(e)); }
    }
    toast(failed.length ? 'error' : 'success', failed.length ? `Published ${published}; ${failed.length} failed: ${failed[0]}` : `Published ${published} to Google`);
    setApprovingAll(false);
    await changed();
  }

  return (
    <div className="ads-setup">
      <section className="ops-card">
        <div className="ops-card-head"><div><span className="eyebrow">Approvals</span><h2>Replies waiting for you</h2></div><CheckCheck size={18} /></div>
        {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}
        <div className="review-list">
          {waiting.map(row => <ApprovalCard key={row.id} row={row} canManage={canManage} onDone={changed} />)}
          {!waiting.length && <div className="ops-empty compact"><Check /><strong>Nothing waiting</strong><span>Replies an AI assistant can't publish on its own appear here.</span></div>}
        </div>
      </section>
      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">Business Profile</span><h2>Profile edits, posts and photos waiting for you</h2></div>
          {waitingMedia.length > 1
            ? <button type="button" className="btn btn-primary btn-sm" disabled={!canManage || approvingAll} onClick={approveAllMedia}><CheckCheck size={13} /> {approvingAll ? 'Publishing…' : `Approve all ${waitingMedia.length} photos and videos`}</button>
            : <Store size={18} />}
        </div>
        <div className="review-list">
          {waitingChanges.map(change => <ChangeCard key={change.id} change={change} canManage={canManage} onDone={changed} />)}
          {!waitingChanges.length && <div className="ops-empty compact"><Check /><strong>Nothing waiting</strong><span>Profile changes an AI assistant can't publish on its own appear here.</span></div>}
        </div>
      </section>
      {scheduled.length > 0 && (
        <section className="ops-card">
          <div className="ops-card-head"><div><span className="eyebrow">Business Profile</span><h2>Posts scheduled to publish</h2></div><CalendarClock size={18} /></div>
          <div className="review-list">
            {scheduled.map(change => <ChangeCard key={change.id} change={change} canManage={canManage} onDone={changed} />)}
          </div>
        </section>
      )}
      <section className="ops-card">
        <div className="ops-card-head"><div><span className="eyebrow">History</span><h2>Recent replies made through the app</h2></div><History size={18} /></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Location</th><th>Review</th><th>Reply</th><th>By</th><th>Status</th></tr></thead>
            <tbody>
              {history.map(row => (
                <tr key={row.id}>
                  <td><small>{when(row.created_at)}</small></td>
                  <td><small>{row.location_title ?? '—'}</small></td>
                  <td>{row.review && <Stars rating={row.review.rating} />}</td>
                  <td className="reviews-history-text"><small>{row.action === 'delete' ? 'Delete reply' : row.text}</small>{row.error && <small className="ads-error-line">{row.error}</small>}</td>
                  <td><small>{row.source === 'mcp' ? 'AI assistant' : 'Dashboard'}</small></td>
                  <td><span className={`badge badge-${STATUS[row.status].tone}`}>{STATUS[row.status].label}</span></td>
                </tr>
              ))}
              {!history.length && <tr><td colSpan={6}><small className="text-dim">No replies yet.</small></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="ops-card">
        <div className="ops-card-head"><div><span className="eyebrow">History</span><h2>Recent profile changes</h2></div><History size={18} /></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Location</th><th>Change</th><th>By</th><th>Status</th></tr></thead>
            <tbody>
              {changeHistory.map(c => (
                <tr key={c.id}>
                  <td><small>{when(c.created_at)}</small></td>
                  <td><small>{c.location_title ?? '—'}</small></td>
                  <td className="reviews-history-text"><small>{c.summary}</small>{c.error && <small className="ads-error-line">{c.error}</small>}</td>
                  <td><small>{c.source === 'mcp' ? 'AI assistant' : 'Dashboard'}</small></td>
                  <td><span className={`badge badge-${CHANGE_STATUS[c.status].tone}`}>{CHANGE_STATUS[c.status].label}</span>{c.status === 'scheduled' && <small className="text-dim"> {localTime(c.publish_at)}</small>}</td>
                </tr>
              ))}
              {!changeHistory.length && <tr><td colSpan={5}><small className="text-dim">No profile changes yet.</small></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// SQLite timestamps are UTC without a zone marker.
const when = (value: string) => new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z')).toLocaleString();

const KIND_LABEL: Record<ProfileChange['kind'], string> = { profile: 'Profile edit', post: 'New post', post_delete: 'Delete post', photo: 'New photo', photo_delete: 'Delete photo' };

/** A Business Profile change; the buttons only show while it waits for a decision. */
export function ChangeCard({ change, canManage, onDone }: { change: ProfileChange; canManage: boolean; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const media = change.kind === 'photo' ? change.payload.photo as { sourceUrl?: string; mediaFormat?: string } | undefined : undefined;
  const photo = media?.mediaFormat === 'VIDEO' ? undefined : media?.sourceUrl;
  const video = media?.mediaFormat === 'VIDEO' ? media.sourceUrl : undefined;
  const postPhoto = change.kind === 'post' ? (change.payload.post as { media?: Array<{ sourceUrl?: string }> } | undefined)?.media?.[0]?.sourceUrl : undefined;
  const postText = change.kind === 'post' ? (change.payload.post as { summary?: string } | undefined)?.summary : undefined;
  const waiting = change.status === 'needs_approval';
  // A scheduled post is approved, then published at its time (or straight away if that has passed).
  const scheduledLater = !!change.publish_at;

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      if (approve) {
        const result = await reviewsApi.approveChange(change.id);
        toast(result.status === 'failed' ? 'error' : 'success', result.status === 'published' ? 'Published to Google' : result.status === 'scheduled' ? `Approved: publishes ${localTime(result.publish_at)}` : result.error ?? 'Google refused it');
      }
      else { await reviewsApi.rejectChange(change.id); toast('success', change.status === 'scheduled' ? 'Scheduled post cancelled' : 'Rejected'); }
      await onDone();
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(false);
  }

  return (
    <article className="review-card">
      <header><span className="badge badge-info">{video ? 'New video' : KIND_LABEL[change.kind]}</span>{waiting ? null : <span className={`badge badge-${CHANGE_STATUS[change.status].tone}`}>{CHANGE_STATUS[change.status].label}</span>}<small>{change.location_title ?? ''} · {when(change.created_at)}</small></header>
      <p>{change.summary}</p>
      {change.publish_at && ['needs_approval', 'scheduled'].includes(change.status) && <p className="gbp-schedule-line"><CalendarClock size={13} /> Publishes {localTime(change.publish_at)}</p>}
      {postText && postText.length > 120 && <p className="muted">{postText}</p>}
      {(photo || postPhoto) && <img className="gbp-change-photo" src={photo ?? postPhoto} alt="Proposed" loading="lazy" />}
      {video && <video className="gbp-change-photo" src={video} controls preload="metadata" aria-label="Proposed video" />}
      <div className="review-draft"><Bot size={13} /> {change.source === 'mcp' ? 'AI assistant' : 'Draft'}: {change.findings.map(f => f.message).join(' ') || 'Waiting for approval.'}{change.rationale ? ` Rationale: ${change.rationale}` : ''}</div>
      {change.error && <p className="ads-error-line">{change.error}</p>}
      {waiting && <div className="ads-row-actions">
        <button className="btn btn-ghost btn-sm" disabled={!canManage || busy} onClick={() => decide(false)}><X size={13} /> Reject</button>
        <button className="btn btn-primary btn-sm" disabled={!canManage || busy} onClick={() => decide(true)}><Check size={13} /> {scheduledLater ? 'Approve' : 'Approve and publish'}</button>
      </div>}
      {change.status === 'scheduled' && <div className="ads-row-actions">
        <button className="btn btn-ghost btn-sm" disabled={!canManage || busy} onClick={() => decide(false)}><X size={13} /> Cancel the post</button>
      </div>}
    </article>
  );
}

/** A proposed review reply (editable before publishing); the buttons only show while it waits for a decision. */
export function ApprovalCard({ row, canManage, onDone }: { row: Row; canManage: boolean; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [text, setText] = useState(row.text ?? '');
  const [busy, setBusy] = useState(false);

  async function decide(approve: boolean) {
    setBusy(true);
    try {
      if (approve) { await reviewsApi.approve(row.id, row.action === 'delete' ? undefined : text); toast('success', row.action === 'delete' ? 'Reply deleted' : 'Reply published'); }
      else { await reviewsApi.reject(row.id); toast('success', 'Rejected'); }
      await onDone();
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(false);
  }

  const r = row.review;
  const waiting = row.status === 'needs_approval';
  return (
    <article className="review-card">
      <header>
        {r && <Stars rating={r.rating} />}
        <strong>{r?.anonymous ? 'Anonymous' : r?.reviewer_name ?? 'Google user'}</strong>
        <small>{row.location_title ?? ''}</small>
        {!waiting && <span className={`badge badge-${STATUS[row.status].tone}`}>{STATUS[row.status].label}</span>}
      </header>
      {r && <p className={r.comment ? '' : 'muted'}>{r.comment ?? 'Rating only — no text.'}</p>}
      {row.previous_reply && <div className="review-reply"><div className="review-reply-head"><span>Current reply</span></div><p>{row.previous_reply}</p></div>}
      <div className="review-draft"><Bot size={13} /> {row.source === 'mcp' ? 'AI assistant' : 'Draft'} — {row.findings.map(f => f.message).join(' ') || 'Waiting for approval.'}{row.rationale ? ` Rationale: ${row.rationale}` : ''}</div>
      {row.action === 'delete'
        ? <p><b>{waiting ? 'Proposed' : 'Asked'}:</b> delete the current reply.</p>
        : waiting
          ? <textarea className="input" rows={4} value={text} onChange={e => setText(e.target.value)} aria-label="Reply to approve" disabled={!canManage} />
          : <div className="review-reply"><div className="review-reply-head"><span>Reply</span></div><p>{row.text}</p></div>}
      {row.error && <p className="ads-error-line">{row.error}</p>}
      {waiting && <div className="ads-row-actions">
        <button className="btn btn-ghost btn-sm" disabled={!canManage || busy} onClick={() => decide(false)}><X size={13} /> Reject</button>
        <button className="btn btn-primary btn-sm" disabled={!canManage || busy || (row.action === 'reply' && !text.trim())} onClick={() => decide(true)}><Check size={13} /> {row.action === 'delete' ? 'Approve deletion' : text !== row.text ? 'Publish edited reply' : 'Approve and publish'}</button>
      </div>}
    </article>
  );
}
