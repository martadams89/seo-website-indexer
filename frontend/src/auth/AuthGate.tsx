/**
 * Authentication gate — wraps the whole app. Resolves the current user from the
 * session cookie; if there's no session it shows the login screen (or first-run
 * signup when no admin exists yet). The authed user + logout are exposed via
 * useAuth() so the rest of the app can render the current profile.
 */
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { KeyRound, ShieldCheck, Loader2, Fingerprint } from 'lucide-react';
import { api, type CurrentUser, type ApiError } from '../api';
import { loginWithPasskey } from './webauthn';

interface AuthValue {
  user: CurrentUser;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
  stopImpersonating: () => Promise<void>;
}
const AuthContext = createContext<AuthValue | null>(null);
export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used within AuthGate');
  return v;
}

type Phase = 'loading' | 'login' | 'signup' | 'authed';

export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<CurrentUser | null>(null);

  const resolve = useCallback(async () => {
    try {
      setUser(await api.me());
      setPhase('authed');
    } catch (e) {
      const needsBootstrap = (e as ApiError).body?.needsBootstrap === true;
      setPhase(needsBootstrap ? 'signup' : 'login');
    }
  }, []);

  useEffect(() => { resolve(); }, [resolve]);

  const refreshUser = useCallback(async () => { setUser(await api.me()); }, []);
  const logout = useCallback(async () => {
    await api.logout().catch(() => null);
    setUser(null);
    setPhase('login');
  }, []);
  const stopImpersonating = useCallback(async () => {
    const restored = await api.stopImpersonating();
    setUser(restored);
    window.location.reload();
  }, []);

  if (phase === 'loading') {
    return <div className="auth-screen"><Loader2 className="spin" size={22} /></div>;
  }
  if (phase === 'authed' && user) {
    if (user.must_change_password && !user.impersonation) {
      return <RequiredPasswordChange onDone={refreshUser} />;
    }
    return <AuthContext.Provider value={{ user, refreshUser, logout, stopImpersonating }}>{children}</AuthContext.Provider>;
  }
  return <AuthForm mode={phase === 'signup' ? 'signup' : 'login'} onAuthed={resolve} />;
}

function RequiredPasswordChange({ onDone }: { onDone: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      await api.setRequiredPassword(password);
      await onDone();
    } catch (err) {
      setError((err as ApiError).message || 'Could not update the password.');
    }
    setBusy(false);
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">🔐</div>
        <h1 className="auth-title">Choose your password</h1>
        <p className="auth-sub">An administrator issued a temporary password. Replace it before continuing.</p>
        <label className="auth-field"><span>New password</span>
          <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} minLength={8} autoComplete="new-password" required />
        </label>
        <label className="auth-field"><span>Confirm password</span>
          <input className="input" type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} minLength={8} autoComplete="new-password" required />
        </label>
        {error && <div className="auth-error">{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy || password.length < 8 || confirmPassword.length < 8} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? <Loader2 className="spin" size={14} /> : <KeyRound size={14} />} Set password
        </button>
      </form>
    </div>
  );
}

function AuthForm({ mode, onAuthed }: { mode: 'login' | 'signup'; onAuthed: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [totpStep, setTotpStep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ssoProviders, setSsoProviders] = useState<Array<{ id: string; name: string }>>([]);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState('');

  useEffect(() => {
    if (mode === 'login') {
      api.ssoProviders().then(setSsoProviders).catch(() => setSsoProviders([]));
      api.bootstrapStatus().then(s => setEmailEnabled(s.emailEnabled)).catch(() => setEmailEnabled(false));
    }
  }, [mode]);

  async function sendReset(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.forgotPassword(email.trim());
      setForgotSent(r.message);
    } catch (err) {
      setError((err as ApiError).message || 'Could not send the reset email.');
    }
    setBusy(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'signup') {
        await api.signup(email.trim(), password, name.trim() || undefined);
      } else {
        await api.login(email.trim(), password, totpStep ? totp : undefined);
      }
      onAuthed();
    } catch (err) {
      const e2 = err as ApiError;
      if (e2.body?.totpRequired) {
        setTotpStep(true);
        setError(totpStep ? (e2.message || 'Incorrect code') : '');
      } else {
        setError(e2.message || 'Something went wrong');
      }
    }
    setBusy(false);
  }

  async function passkeySignIn() {
    setBusy(true);
    setError('');
    try {
      await loginWithPasskey(email.trim() || undefined);
      onAuthed();
    } catch (err) {
      setError((err as ApiError).message || 'Passkey sign-in failed or was cancelled.');
    }
    setBusy(false);
  }

  if (forgot) {
    return (
      <div className="auth-screen">
        <form className="auth-card" onSubmit={sendReset}>
          <div className="auth-logo">🔑</div>
          <h1 className="auth-title">Reset your password</h1>
          {forgotSent ? (
            <>
              <p className="auth-sub">{forgotSent}</p>
              <button type="button" className="btn btn-secondary" onClick={() => { setForgot(false); setForgotSent(''); }}
                style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>Back to sign in</button>
            </>
          ) : (
            <>
              <p className="auth-sub">Enter your account email and we'll send you a reset link.</p>
              <label className="auth-field">
                <span>Email</span>
                <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="username" required />
              </label>
              {error && <div className="auth-error">{error}</div>}
              <button className="btn btn-primary" type="submit" disabled={busy || !email.trim()} style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
                {busy ? <Loader2 className="spin" size={14} /> : <KeyRound size={14} />} Send reset link
              </button>
              <button type="button" className="auth-link" onClick={() => { setForgot(false); setError(''); }}>Back to sign in</button>
            </>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="auth-screen auth-screen-premium">
      <div className="auth-stage">
        <section className="auth-story">
          <div className="auth-brand"><span>O</span><strong>Organic Command</strong></div>
          <div className="auth-story-copy">
            <span className="auth-kicker">Search intelligence, unified</span>
            <h2>Operate every search surface from one beautiful place.</h2>
            <p>Indexation, search performance, AI visibility and the next best action — connected across every workspace.</p>
          </div>
          <div className="auth-proof"><span><ShieldCheck size={15} /> Self-hosted control</span><span><Fingerprint size={15} /> Passkey ready</span><span><SparklineMark /> Live intelligence</span></div>
        </section>
        <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">O</div>
        <h1 className="auth-title">{mode === 'signup' ? 'Create your command centre' : 'Welcome back'}</h1>
        <p className="auth-sub">
          {mode === 'signup'
            ? 'This is a fresh install — the first account becomes the super-admin.'
            : 'Sign in to your organic search workspace.'}
        </p>

        {!totpStep && (
          <>
            {mode === 'signup' && (
              <label className="auth-field">
                <span>Name</span>
                <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" autoComplete="name" />
              </label>
            )}
            <label className="auth-field">
              <span>Email</span>
              <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="username" required />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required />
            </label>
            {mode === 'login' && emailEnabled && (
              <button type="button" className="auth-link" onClick={() => { setForgot(true); setError(''); }}>
                Forgot password?
              </button>
            )}
          </>
        )}

        {totpStep && (
          <label className="auth-field">
            <span><ShieldCheck size={12} /> Two-factor code</span>
            <input className="input" value={totp} onChange={e => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456" inputMode="numeric" autoFocus autoComplete="one-time-code" />
            <span className="text-dim" style={{ fontSize: 11 }}>Enter the 6-digit code from your authenticator app.</span>
          </label>
        )}

        {error && <div className="auth-error">{error}</div>}

        <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}>
          {busy ? <Loader2 className="spin" size={14} /> : <KeyRound size={14} />}
          {mode === 'signup' ? 'Create account' : totpStep ? 'Verify' : 'Sign in'}
        </button>

        {mode === 'login' && !totpStep && (
          <>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={passkeySignIn}
              style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}>
              <Fingerprint size={14} /> Sign in with a passkey
            </button>
            {ssoProviders.length > 0 && (
              <div className="auth-sso">
                <div className="auth-divider"><span>or</span></div>
                {ssoProviders.map(p => (
                  <a key={p.id} className="btn btn-secondary" href={`/api/auth/sso/${p.id}/start`}
                    style={{ width: '100%', justifyContent: 'center' }}>
                    Continue with {p.name}
                  </a>
                ))}
              </div>
            )}
          </>
        )}
        </form>
      </div>
    </div>
  );
}

function SparklineMark() {
  return <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true"><path d="M1 11 5 7l3 2 6-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
