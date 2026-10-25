import { useCallback, useEffect, useState } from 'react';
import { Bot, Check, CheckCheck, History, X } from 'lucide-react';
import { useToast } from '../AppContext';
import { errorMessage } from '../ads/api';
import { reviewsApi, type ReplyPlan, type Review } from './api';
import { Stars } from './ReviewsInbox';

type Row = ReplyPlan & { review: Review | null; location_title: string | null };

const STATUS: Record<ReplyPlan['status'], { label: string; tone: string }> = {
  needs_approval: { label: 'Waiting for approval', tone: 'warn' },
  blocked: { label: 'Blocked by rules', tone: 'error' },
  publishing: { label: 'Publishing', tone: 'info' },
  published: { label: 'Published', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'info' },
  failed: { label: 'Google refused it', tone: 'error' },
  superseded: { label: 'Replaced', tone: 'info' },
};

export function ReviewsApprovals({ canManage, reload }: { canManage: boolean; reload: () => Promise<void> }) {
  const [waiting, setWaiting] = useState<Row[]>([]);
  const [history, setHistory] = useState<Row[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(() => Promise.all([reviewsApi.replies('needs_approval'), reviewsApi.replies()])
    .then(([w, all]) => {
      setWaiting(w);
      setHistory(all.filter(r => r.status !== 'needs_approval').slice(0, 50));
      setError('');
    })
    .catch(e => setError(errorMessage(e))), []);
  useEffect(() => { void load(); }, [load]);
  const changed = async () => { await Promise.all([load(), reload()]); };

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
        <div className="ops-card-head"><div><span className="eyebrow">History</span><h2>Recent replies made through the app</h2></div><History size={18} /></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Location</th><th>Review</th><th>Reply</th><th>By</th><th>Status</th></tr></thead>
            <tbody>
              {history.map(row => (
                <tr key={row.id}>
                  <td><small>{new Date(row.created_at.replace(' ', 'T') + (row.created_at.includes('Z') ? '' : 'Z')).toLocaleString()}</small></td>
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
    </div>
  );
}

function ApprovalCard({ row, canManage, onDone }: { row: Row; canManage: boolean; onDone: () => Promise<void> }) {
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
  return (
    <article className="review-card">
      <header>
        {r && <Stars rating={r.rating} />}
        <strong>{r?.anonymous ? 'Anonymous' : r?.reviewer_name ?? 'Google user'}</strong>
        <small>{row.location_title ?? ''}</small>
      </header>
      {r && <p className={r.comment ? '' : 'muted'}>{r.comment ?? 'Rating only — no text.'}</p>}
      {row.previous_reply && <div className="review-reply"><div className="review-reply-head"><span>Current reply</span></div><p>{row.previous_reply}</p></div>}
      <div className="review-draft"><Bot size={13} /> {row.source === 'mcp' ? 'AI assistant' : 'Draft'} — {row.findings.map(f => f.message).join(' ') || 'Waiting for approval.'}{row.rationale ? ` Rationale: ${row.rationale}` : ''}</div>
      {row.action === 'delete'
        ? <p><b>Proposed:</b> delete the current reply.</p>
        : <textarea className="input" rows={4} value={text} onChange={e => setText(e.target.value)} aria-label="Reply to approve" disabled={!canManage} />}
      <div className="ads-row-actions">
        <button className="btn btn-ghost btn-sm" disabled={!canManage || busy} onClick={() => decide(false)}><X size={13} /> Reject</button>
        <button className="btn btn-primary btn-sm" disabled={!canManage || busy || (row.action === 'reply' && !text.trim())} onClick={() => decide(true)}><Check size={13} /> {row.action === 'delete' ? 'Approve deletion' : text !== row.text ? 'Publish edited reply' : 'Approve and publish'}</button>
      </div>
    </article>
  );
}
