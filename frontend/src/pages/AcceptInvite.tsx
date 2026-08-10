/**
 * Public workspace-invite acceptance page (reached from the emailed link,
 * outside the auth gate). Looks up the invite by its token, then either
 * creates the invitee's account (if they don't have one) or just attaches
 * their existing account to the workspace — no setup wizard, no separate
 * default workspace, straight into the inviting workspace's existing content.
 */
import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, Mail } from 'lucide-react';
import { api, type ApiError, type InvitePreview } from '../api';

export default function AcceptInvitePage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    api.getInvite(token).then(setInvite).catch(err => setError((err as ApiError).message || 'This invite link is invalid or has expired.')).finally(() => setLoading(false));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (invite && !invite.hasAccount) {
      if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
      if (password !== confirm) { setError('Passwords do not match.'); return; }
    }
    setBusy(true);
    try {
      await api.acceptInvite(token, { password: password || undefined, name: name.trim() || undefined });
      setDone(true);
      setTimeout(() => { window.location.href = '/'; }, 1200);
    } catch (err) {
      setError((err as ApiError).message || 'Could not accept this invite.');
    }
    setBusy(false);
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">✉️</div>
        {loading ? (
          <Loader2 className="spin" size={22} />
        ) : done ? (
          <>
            <h1 className="auth-title">You're in</h1>
            <p className="auth-sub"><CheckCircle2 size={13} style={{ verticalAlign: '-2px' }} /> Redirecting to the dashboard…</p>
          </>
        ) : !invite ? (
          <>
            <h1 className="auth-title">Invalid invite</h1>
            <p className="auth-sub">{error || 'This invite link is invalid or has expired.'}</p>
            <a className="btn btn-secondary" href="/" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>Back to sign in</a>
          </>
        ) : (
          <form onSubmit={submit}>
            <h1 className="auth-title">Join {invite.workspaceName}</h1>
            <p className="auth-sub"><Mail size={13} style={{ verticalAlign: '-2px' }} /> Invited as <strong>{invite.email}</strong> ({invite.role})</p>
            {!invite.hasAccount && (
              <>
                <label className="auth-field">
                  <span>Your name <span style={{ fontWeight: 400 }}>(optional)</span></span>
                  <input className="input" value={name} onChange={e => setName(e.target.value)} autoComplete="name" />
                </label>
                <label className="auth-field">
                  <span>Choose a password</span>
                  <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="At least 8 characters" autoComplete="new-password" required />
                </label>
                <label className="auth-field">
                  <span>Confirm password</span>
                  <input className="input" type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                    autoComplete="new-password" required />
                </label>
              </>
            )}
            {invite.hasAccount && (
              <p className="auth-sub">You already have an account — accept the invite to add this workspace to it.</p>
            )}
            {error && <div className="auth-error">{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={busy}
              style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
              {busy ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />} Accept invite
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
