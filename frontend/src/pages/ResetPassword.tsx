/**
 * Public password-reset page (reached from the emailed link, outside the auth
 * gate). Reads the token from the URL, lets the user set a new password, then
 * points them back to sign in.
 */
import { useState } from 'react';
import { KeyRound, Loader2, CheckCircle2 } from 'lucide-react';
import { api, type ApiError } from '../api';

export default function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError((err as ApiError).message || 'Could not reset your password.');
    }
    setBusy(false);
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">🔑</div>
        {done ? (
          <>
            <h1 className="auth-title">Password reset</h1>
            <p className="auth-sub"><CheckCircle2 size={13} style={{ verticalAlign: '-2px' }} /> Your password has been updated. You've been signed out everywhere.</p>
            <a className="btn btn-primary" href="/" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>Go to sign in</a>
          </>
        ) : !token ? (
          <>
            <h1 className="auth-title">Invalid link</h1>
            <p className="auth-sub">This reset link is missing its token. Request a new one from the sign-in page.</p>
            <a className="btn btn-secondary" href="/" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>Back to sign in</a>
          </>
        ) : (
          <form onSubmit={submit}>
            <h1 className="auth-title">Choose a new password</h1>
            <p className="auth-sub">Enter a new password for your account.</p>
            <label className="auth-field">
              <span>New password</span>
              <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="At least 8 characters" autoComplete="new-password" required />
            </label>
            <label className="auth-field">
              <span>Confirm password</span>
              <input className="input" type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                autoComplete="new-password" required />
            </label>
            {error && <div className="auth-error">{error}</div>}
            <button className="btn btn-primary" type="submit" disabled={busy || password.length < 8}
              style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
              {busy ? <Loader2 className="spin" size={14} /> : <KeyRound size={14} />} Reset password
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
