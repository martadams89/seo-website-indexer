import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Smartphone, ChevronRight, Copy, Check, ExternalLink, Key } from 'lucide-react';
import { api, type DeviceFlowState } from '../api';
import { useApp } from '../AppContext';

// ── Steps ─────────────────────────────────────────────────────────────────────

type Step = 'welcome' | 'device-flow-creds' | 'device-flow-auth' | 'done';

export default function SetupPage() {
  const { status, refresh } = useApp();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('welcome');
  const [dfClientId, setDfClientId]         = useState('');
  const [dfClientSecret, setDfClientSecret] = useState('');
  const [dfState, setDfState]               = useState<DeviceFlowState | null>(null);
  const [dfLoading, setDfLoading]           = useState(false);
  const [dfError, setDfError]               = useState('');
  const [dfPolling, setDfPolling]           = useState(false);
  const [copied, setCopied]                 = useState(false);

  const hasBuiltin = status?.auth?.hasBuiltinCredentials ?? false;

  // If already authenticated, redirect to sites
  useEffect(() => {
    if (status?.auth?.authenticated) {
      setStep('done');
    }
  }, [status]);

  // ── Device Flow ───────────────────────────────────────────────────────────

  async function startDeviceFlow() {
    setDfError('');
    setDfLoading(true);
    try {
      // If we have builtin, we don't pass anything (backend defaults to env vars)
      const state = await api.startDeviceFlow(
        hasBuiltin ? undefined : dfClientId.trim(),
        hasBuiltin ? undefined : dfClientSecret.trim()
      );
      setDfState(state);
      setStep('device-flow-auth');
    } catch (e) {
      setDfError(String(e).replace('Error: ', ''));
    }
    setDfLoading(false);
  }

  async function pollDeviceFlow() {
    if (!dfState) return;
    setDfError('');
    setDfPolling(true);
    try {
      await api.pollDeviceFlow(dfState.device_code, dfState.interval, dfState.expires_in);
      await refresh();
      setStep('done');
    } catch (e) {
      setDfError(String(e).replace('Error: ', ''));
    }
    setDfPolling(false);
  }

  function copyCode() {
    if (dfState) {
      navigator.clipboard.writeText(dfState.user_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  // ── Wizard steps header ───────────────────────────────────────────────────

  const STEPS = ['Connect Google', 'Authorise', 'All Done'];
  const stepIdx = step === 'welcome' || step === 'device-flow-creds' ? 0
    : step === 'device-flow-auth' ? 1
    : 2;

  function formatError(err: string) {
    if (err.includes('Invalid client type') || err.includes('invalid_client')) {
      return (
        <div style={{ textAlign: 'left' }}>
          <strong style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>Error: Invalid Client Type</strong>
          <span style={{ fontSize: 11, lineHeight: '1.4', display: 'block' }}>
            It looks like you created a <strong>Web application</strong> Client ID in your Google Cloud Console. 
            Because this tool runs headlessly in Docker and uses Google's secure Device Flow (like a smart TV or a CLI tool does), Google <strong>requires</strong> the credential to be a <strong>Desktop app</strong>.
            <br /><br />
            <strong>How to fix this in 30 seconds:</strong>
            <ol style={{ paddingLeft: 16, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <li>Go back to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', color: 'var(--accent)', fontWeight: 600 }}>Google Cloud Credentials <ExternalLink size={10} style={{ display: 'inline' }} /></a>.</li>
              <li>Click <strong>Create Credentials</strong> → <strong>OAuth client ID</strong>.</li>
              <li>Under <strong>Application type</strong>, choose <strong>Desktop app</strong> (do <em>not</em> choose "Web application").</li>
              <li>Name it (e.g. <code>SEO Indexer</code>) and click <strong>Create</strong>. Copy-paste the new Client ID and Secret here!</li>
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
            We authenticate using secure Google OAuth Device Flow.
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
                onClick={startDeviceFlow}
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
                OAuth Client ID and Client Secret (Desktop App) to authenticate.
              </p>
              <button
                className="btn btn-primary"
                onClick={() => setStep('device-flow-creds')}
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
                This indexing tool connects directly to Google using secure OAuth Device Flow. 
                Your credentials are stored safely in your local SQLite database, 
                granting you direct API access to all your Search Console properties instantly.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 1b: Custom credentials entry ── */}
      {step === 'device-flow-creds' && (
        <div className="card">
          <h2 style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>OAuth 2.0 Credentials</h2>
          <p className="text-secondary text-sm mb-3">
            Create an OAuth 2.0 Client ID of type <strong>Desktop app</strong> in your&nbsp;
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer"
              style={{ color: 'var(--accent)' }}>Google Cloud Console <ExternalLink size={11} /></a>.
            Enable the <strong>Google Search Console API</strong> and <strong>Web Search Indexing API</strong>.
          </p>

          <div className="alert alert-info mb-3">
            <div className="alert-content" style={{ fontSize: 12 }}>
              <strong>Quick Steps:</strong> APIs &amp; Services → Credentials → Create Credentials → OAuth client ID → Desktop app.
              Copy-paste the client ID and secret here.
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
              onClick={startDeviceFlow}
            >
              {dfLoading ? <><span className="spinner" /> Starting…</> : 'Start Device Flow'}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Authorise ── */}
      {step === 'device-flow-auth' && dfState && (
        <div className="card">
          <h2 style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Authorise on Any Device</h2>
          <p className="text-secondary text-sm mb-4">
            Open the link below on your phone, laptop, or any browser — then enter the code shown.
          </p>

          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <a
              href={dfState.verification_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 16, display: 'block', marginBottom: 16 }}
            >
              {dfState.verification_url} <ExternalLink size={14} style={{ display: 'inline', verticalAlign: 'middle' }} />
            </a>

            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 12,
              background: 'var(--bg-input)', border: '2px solid var(--accent)',
              borderRadius: 12, padding: '16px 28px',
            }}>
              <span style={{ fontFamily: 'JetBrains Mono', fontSize: 28, fontWeight: 700, letterSpacing: 4, color: 'var(--text-primary)' }}>
                {dfState.user_code}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={copyCode} title="Copy code">
                {copied ? <Check size={14} style={{ color: 'var(--ok)' }} /> : <Copy size={14} />}
              </button>
            </div>
          </div>

          {dfError && <div className="alert alert-error mb-3"><div className="alert-content">{formatError(dfError)}</div></div>}

          <div className="flex gap-3 justify-end">
            <button className="btn btn-secondary" onClick={() => hasBuiltin ? setStep('welcome') : setStep('device-flow-creds')}>Back</button>
            <button
              className="btn btn-primary"
              disabled={dfPolling}
              onClick={pollDeviceFlow}
            >
              {dfPolling
                ? <><span className="spinner" /> Checking…</>
                : "I've Authorised — Continue"}
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
