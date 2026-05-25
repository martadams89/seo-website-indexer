import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Smartphone, ChevronRight, Copy, Check, ExternalLink, Key } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../AppContext';

// ── Steps ─────────────────────────────────────────────────────────────────────

type Step = 'welcome' | 'creds' | 'auth' | 'done';

export default function SetupPage() {
  const { status, refresh } = useApp();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('welcome');
  const [dfClientId, setDfClientId]         = useState('');
  const [dfClientSecret, setDfClientSecret] = useState('');
  const [dfLoading, setDfLoading]           = useState(false);
  const [dfError, setDfError]               = useState('');
  const [copied, setCopied]                 = useState(false);
  const [authChecking, setAuthChecking]     = useState(false);

  const hasBuiltin = status?.auth?.hasBuiltinCredentials ?? false;
  const redirectUri = window.location.origin + '/api/auth/google/callback';

  // If already authenticated, redirect to done
  useEffect(() => {
    if (status?.auth?.authenticated) {
      setStep('done');
    }
  }, [status]);

  // Listen for callback postMessage
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      if (event.data?.type === 'GOOGLE_AUTH_SUCCESS') {
        await refresh();
        setStep('done');
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [refresh]);

  async function startGoogleAuth() {
    setDfError('');
    setDfLoading(true);
    try {
      // 1. Save custom credentials if not using builtin env fallback
      if (!hasBuiltin) {
        await api.saveCredentials(dfClientId.trim(), dfClientSecret.trim());
      }

      // 2. Fetch current client ID
      const activeClientId = hasBuiltin ? (status?.auth?.clientId || '') : dfClientId.trim();
      if (!activeClientId) {
        throw new Error('Google OAuth Client ID is missing. Please save credentials first.');
      }

      // 3. Initiate Standard Web Application OAuth Flow
      const scope = 'https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/indexing';
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${activeClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`;

      // 4. Open in popup window
      const width = 600;
      const height = 700;
      const left = window.screen.width / 2 - width / 2;
      const top = window.screen.height / 2 - height / 2;
      
      const popup = window.open(
        authUrl,
        'google-auth',
        `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes,scrollbars=yes`
      );

      if (!popup) {
        throw new Error(
          'Popup was blocked by your browser. Please allow popups for this site, or click the Google Authorization link below to authenticate.'
        );
      }

      setStep('auth');
    } catch (e) {
      setDfError(String(e).replace('Error: ', ''));
    }
    setDfLoading(false);
  }

  async function checkAuthStatus() {
    setAuthChecking(true);
    setDfError('');
    try {
      await refresh();
      const currentStatus = await api.getStatus();
      if (currentStatus?.auth?.authenticated) {
        setStep('done');
      } else {
        setDfError('Still not authenticated. Please complete the Google authorization flow first.');
      }
    } catch (e) {
      setDfError(String(e).replace('Error: ', ''));
    }
    setAuthChecking(false);
  }

  function copyRedirectUri() {
    navigator.clipboard.writeText(redirectUri);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── Wizard steps header ───────────────────────────────────────────────────

  const STEPS = ['Connect Google', 'Authorise', 'All Done'];
  const stepIdx = step === 'welcome' || step === 'creds' ? 0
    : step === 'auth' ? 1
    : 2;

  function formatError(err: string) {
    if (err.includes('invalid_client') || err.includes('Invalid client type') || err.includes('OAuth Client ID or Client Secret is missing')) {
      return (
        <div style={{ textAlign: 'left' }}>
          <strong style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>Error: Invalid Client Configuration</strong>
          <span style={{ fontSize: 11, lineHeight: '1.4', display: 'block' }}>
            It looks like Google did not recognize your Client ID, or the client type is incorrect.
            <br /><br />
            <strong>How to configure your Web OAuth Client:</strong>
            <ol style={{ paddingLeft: 16, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <li>Go back to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', color: 'var(--accent)', fontWeight: 600 }}>Google Cloud Credentials <ExternalLink size={10} style={{ display: 'inline' }} /></a>.</li>
              <li>Click <strong>Create Credentials</strong> → <strong>OAuth client ID</strong>.</li>
              <li>Under <strong>Application type</strong>, choose <strong>Web application</strong> (do not choose "Desktop app" or "TV app").</li>
              <li>Add this exact Authorized Redirect URI under <strong>Authorized redirect URIs</strong>:
                <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-input)', padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)' }}>
                  <code style={{ fontSize: 10, color: 'var(--text-primary)' }}>{redirectUri}</code>
                </div>
              </li>
              <li>Copy-paste the new Client ID and Secret and try again!</li>
            </ol>
          </span>
        </div>
      );
    }
    return err;
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <div className="page-header">
        <h1 className="page-title">Welcome to SEO Website Indexer</h1>
        <p className="page-subtitle">Let's connect your Google account to get started.</p>
      </div>

      {/* Step indicator */}
      <div className="wizard-steps mb-4">
        {STEPS.map((label, i) => (
          <div key={label} className={`wizard-step ${i < stepIdx ? 'completed' : i === stepIdx ? 'active' : ''}`}>
            <div className="step-circle">
              {i < stepIdx ? <Check size={14} /> : i + 1}
            </div>
            <span className="step-label">{label}</span>
          </div>
        ))}
      </div>

      {/* ── Step 1: Welcome / Sign-in ── */}
      {step === 'welcome' && (
        <div className="flex-col gap-4">
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>
            This application uses the <strong>Google Indexing API</strong> and <strong>Search Console API</strong> to automate indexing.
            We authenticate using secure Google OAuth 2.0 Web Application Flow.
          </p>

          {hasBuiltin ? (
            <div className="card text-center" style={{ padding: '32px 24px' }}>
              <div style={{ background: 'var(--ok-dim)', width: 48, height: 48, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <Smartphone size={24} style={{ color: 'var(--ok)' }} />
              </div>
              <h2 style={{ fontWeight: 700, fontSize: 18, marginBottom: 8 }}>One-Click Google Sign-In</h2>
              <p className="text-secondary text-sm mb-4">
                This Docker container is pre-configured with Google Cloud API credentials.
                No complex console setup required.
              </p>

              {dfError && <div className="alert alert-error mb-3"><div className="alert-content">{formatError(dfError)}</div></div>}

              <button
                className="btn btn-primary btn-lg"
                style={{ width: '100%', maxWidth: 280, margin: '0 auto' }}
                disabled={dfLoading}
                onClick={startGoogleAuth}
              >
                {dfLoading ? <><span className="spinner" /> Connecting…</> : 'Sign in with Google'}
              </button>
            </div>
          ) : (
            <div className="card text-center" style={{ padding: '32px 24px' }}>
              <div style={{ background: 'var(--accent-dim)', width: 48, height: 48, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                <Key size={24} style={{ color: 'var(--accent)' }} />
              </div>
              <h2 style={{ fontWeight: 700, fontSize: 18, marginBottom: 8 }}>Custom Google Cloud Setup</h2>
              <p className="text-secondary text-sm mb-4">
                No built-in credentials detected. You will need to supply your own Google Cloud
                OAuth Client ID and Client Secret (Web application) to authenticate.
              </p>
              <button
                className="btn btn-primary"
                onClick={() => setStep('creds')}
              >
                Configure Custom Credentials <ChevronRight size={14} style={{ display: 'inline', marginLeft: 4 }} />
              </button>
            </div>
          )}

          <div className="alert alert-info" style={{ marginTop: 4 }}>
            <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div className="alert-content">
              <div className="alert-title">Secure &amp; Authorized Integration</div>
              <div style={{ fontSize: 12, marginTop: 2 }}>
                This indexing tool connects directly to Google using secure OAuth 2.0. 
                Your credentials are stored safely in your local SQLite database, 
                granting you direct API access to all your Search Console properties instantly.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 1b: Custom credentials entry ── */}
      {step === 'creds' && (
        <div className="card">
          <h2 style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>OAuth 2.0 Credentials</h2>
          <p className="text-secondary text-sm mb-3">
            Create an OAuth 2.0 Client ID of type <strong>Web application</strong> in your&nbsp;
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--accent)' }}>Google Cloud Console <ExternalLink size={11} /></a>.
            Enable the <strong>Google Search Console API</strong> and <strong>Web Search Indexing API</strong>.
          </p>

          <div className="alert alert-info mb-3">
            <div className="alert-content" style={{ fontSize: 12 }}>
              <strong style={{ display: 'block', marginBottom: 6 }}>Authorized Redirect URI:</strong>
              <p style={{ margin: '0 0 8px 0', color: 'var(--text-secondary)' }}>
                You must paste this Redirect URI into your Google Cloud Client configuration under <strong>Authorized redirect URIs</strong>:
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-input)', padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                <code style={{ fontSize: 11, wordBreak: 'break-all', flexGrow: 1, color: 'var(--text-primary)' }}>{redirectUri}</code>
                <button className="btn btn-ghost btn-sm" onClick={copyRedirectUri} style={{ padding: 4 }} title="Copy Redirect URI">
                  {copied ? <Check size={14} style={{ color: 'var(--ok)' }} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          </div>

          <div className="input-group mb-3">
            <label className="input-label">Client ID</label>
            <input className="input" placeholder="1234567890-abc...apps.googleusercontent.com"
              value={dfClientId} onChange={e => setDfClientId(e.target.value)} />
          </div>

          <div className="input-group mb-3">
            <label className="input-label">Client Secret</label>
            <input className="input" type="password" placeholder="GOCSPX-..."
              value={dfClientSecret} onChange={e => setDfClientSecret(e.target.value)} />
          </div>

          {dfError && <div className="alert alert-error mb-3"><div className="alert-content">{formatError(dfError)}</div></div>}

          <div className="flex gap-3 justify-end">
            <button className="btn btn-secondary" onClick={() => setStep('welcome')}>Back</button>
            <button
              className="btn btn-primary"
              disabled={!dfClientId.trim() || !dfClientSecret.trim() || dfLoading}
              onClick={startGoogleAuth}
            >
              {dfLoading ? <><span className="spinner" /> Saving &amp; Redirection…</> : 'Start Google Sign-In'}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Authorise ── */}
      {step === 'auth' && (
        <div className="card">
          <h2 style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Authorise with Google</h2>
          <p className="text-secondary text-sm mb-4">
            A Google sign-in window was opened. Complete the authorization there to link your account.
          </p>

          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
              <div className="spinner" style={{ width: 40, height: 40, borderWidth: 4, borderColor: 'var(--accent) transparent var(--accent) transparent' }} />
              <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Awaiting secure login completion...</p>
            </div>
            
            <div style={{ marginTop: 24, fontSize: 12, color: 'var(--text-secondary)' }}>
              Did the popup fail to open, or did you close it?
              <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn btn-ghost btn-sm" onClick={startGoogleAuth}>
                  Re-open Sign-In Window <ExternalLink size={12} style={{ marginLeft: 4 }} />
                </button>
              </div>
            </div>
          </div>

          {dfError && <div className="alert alert-error mb-3"><div className="alert-content">{formatError(dfError)}</div></div>}

          <div className="flex gap-3 justify-between" style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={() => hasBuiltin ? setStep('welcome') : setStep('creds')}>Back</button>
            <button
              className="btn btn-primary"
              disabled={authChecking}
              onClick={checkAuthStatus}
            >
              {authChecking
                ? <><span className="spinner" /> Checking…</>
                : "Check Authorization Status"}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Done ── */}
      {step === 'done' && (
        <div className="card" style={{ textAlign: 'center', padding: '40px 28px' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
          <h2 style={{ fontWeight: 700, fontSize: 20, marginBottom: 8 }}>You're connected!</h2>
          <p className="text-secondary mb-4">Google authentication is configured. Now add your sites.</p>
          <button className="btn btn-primary btn-lg" onClick={() => navigate('/sites')}>
            Add Your First Site →
          </button>
        </div>
      )}
    </div>
  );
}
