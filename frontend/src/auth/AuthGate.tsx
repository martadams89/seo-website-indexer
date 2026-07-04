/**
 * Authentication gate — wraps the whole app. Resolves the current user from the
 * session cookie; if there's no session it shows the login screen (or first-run
 * signup when no admin exists yet). The authed user + logout are exposed via
 * useAuth() so the rest of the app can render the current profile.
 */
import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { KeyRound, ShieldCheck, Loader2 } from 'lucide-react';
import { api, type CurrentUser, type ApiError } from '../api';

interface AuthValue {
  user: CurrentUser;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
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

  if (phase === 'loading') {
    return <div className="auth-screen"><Loader2 className="spin" size={22} /></div>;
  }
  if (phase === 'authed' && user) {
    return <AuthContext.Provider value={{ user, refreshUser, logout }}>{children}</AuthContext.Provider>;
  }
  return <AuthForm mode={phase === 'signup' ? 'signup' : 'login'} onAuthed={resolve} />;
}

function AuthForm({ mode, onAuthed }: { mode: 'login' | 'signup'; onAuthed: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [totpStep, setTotpStep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">🔍</div>
        <h1 className="auth-title">{mode === 'signup' ? 'Create the admin account' : 'Sign in'}</h1>
        <p className="auth-sub">
          {mode === 'signup'
            ? 'This is a fresh install — the first account becomes the super-admin.'
            : 'SEO Website Indexer'}
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
      </form>
    </div>
  );
}
