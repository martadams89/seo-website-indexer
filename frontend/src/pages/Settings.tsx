import { useState, useEffect } from 'react';
import { Save, LogOut, KeyRound, Bell, Clock, User, ExternalLink } from 'lucide-react';
import { useApp } from '../AppContext';
import { api } from '../api';

type Tab = 'schedule' | 'google' | 'keys' | 'notify';

interface KeyGuide {
  key: string;
  label: string;
  hint: string;
  free?: string;
  steps: Array<{ text: string; href?: string; linkLabel?: string }>;
}

const KEY_GUIDES: KeyGuide[] = [
  {
    key: 'bing_api_key',
    label: 'Bing Webmaster API key',
    hint: 'Direct URL submission into your verified Bing properties + daily quota. Optional — IndexNow already notifies Bing.',
    free: 'free',
    steps: [
      { text: 'Open Bing Webmaster Tools and sign in.', href: 'https://www.bing.com/webmasters/', linkLabel: 'bing.com/webmasters' },
      { text: 'Verify your sites — "Import from Google Search Console" does it in one click.' },
      { text: 'Gear icon (top right) → API access → API Key → generate & copy. One key covers all your verified sites.' },
    ],
  },
  {
    key: 'crux_api_key',
    label: 'CrUX API key (Core Web Vitals)',
    hint: 'Real-user p75 LCP / INP / CLS per site, straight from Chrome telemetry.',
    free: 'free',
    steps: [
      { text: 'Enable the Chrome UX Report API on your Google Cloud project (the same project as your OAuth client is fine) — click "Enable".', href: 'https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com', linkLabel: 'Enable Chrome UX Report API' },
      { text: 'Create an API key: Credentials → Create credentials → API key.', href: 'https://console.cloud.google.com/apis/credentials', linkLabel: 'Credentials console' },
      { text: 'Recommended: edit the key → API restrictions → restrict to "Chrome UX Report API".' },
      { text: 'Heads-up: CrUX only has data for origins with enough real Chrome traffic. Low-traffic sites return "origin not in the dataset" — that is Google, not a broken key.' },
    ],
  },
  {
    key: 'gemini_api_key',
    label: 'Gemini API key',
    hint: 'Gemini citation checks with Google Search grounding.',
    free: 'free tier',
    steps: [
      { text: 'Easiest: use the ⚡ one-click button below — it creates a service-restricted key on your own Google project via your linked account.' },
      { text: 'Manual alternative: create a key in Google AI Studio.', href: 'https://aistudio.google.com/apikey', linkLabel: 'aistudio.google.com/apikey' },
    ],
  },
  {
    key: 'brave_api_key',
    label: 'Brave Search API key',
    hint: 'Retrieval-layer presence — Brave grounds Claude’s web search. Strong zero-cost citation signal.',
    free: 'free ~2k/mo, no card',
    steps: [
      { text: 'Sign up for the free "Data for Search" plan (no payment card needed).', href: 'https://brave.com/search/api/', linkLabel: 'brave.com/search/api' },
      { text: 'Dashboard → API Keys → copy your subscription token.' },
    ],
  },
  {
    key: 'openai_api_key',
    label: 'OpenAI API key',
    hint: 'ChatGPT citation checks with web search.',
    steps: [
      { text: 'Create a key in the OpenAI platform (billing must be enabled; each check costs well under a penny).', href: 'https://platform.openai.com/api-keys', linkLabel: 'platform.openai.com/api-keys' },
    ],
  },
  {
    key: 'anthropic_api_key',
    label: 'Anthropic API key',
    hint: 'Claude citation checks with web search.',
    steps: [
      { text: 'Create a key in the Anthropic console (billing required).', href: 'https://console.anthropic.com/settings/keys', linkLabel: 'console.anthropic.com' },
    ],
  },
  {
    key: 'perplexity_api_key',
    label: 'Perplexity API key',
    hint: 'Perplexity (sonar) checks — returns explicit citation lists.',
    steps: [
      { text: 'Settings → API → generate (requires API credits).', href: 'https://www.perplexity.ai/settings/api', linkLabel: 'perplexity.ai/settings/api' },
    ],
  },
  {
    key: 'xai_api_key',
    label: 'xAI API key',
    hint: 'Grok citation checks with live search.',
    steps: [
      { text: 'Create a key in the xAI console.', href: 'https://console.x.ai/', linkLabel: 'console.x.ai' },
    ],
  },
];

const CRON_PRESETS = [
  { label: 'Every hour',   value: '0 * * * *' },
  { label: 'Every 6h',     value: '0 */6 * * *' },
  { label: '3am daily',    value: '0 3 * * *' },
  { label: 'Every Monday', value: '0 3 * * 1' },
];

const TABS: Array<{ id: Tab; label: string; icon: typeof Clock }> = [
  { id: 'schedule', label: 'Scheduling', icon: Clock },
  { id: 'google',   label: 'Google',     icon: User },
  { id: 'keys',     label: 'API Keys',   icon: KeyRound },
  { id: 'notify',   label: 'Notifications', icon: Bell },
];

export default function SettingsPage() {
  const { status, refresh } = useApp();
  const [tab, setTab] = useState<Tab>('schedule');
  const [cronSchedule, setCronSchedule] = useState('');
  const [projectId, setProjectId] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [configured, setConfigured] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Tab | null>(null);
  const [saved, setSaved] = useState<Tab | null>(null);
  const [clearLoading, setClearLoading] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionMsg, setProvisionMsg] = useState<string | null>(null);

  async function loadSettings() {
    const s = await api.getSettings().catch(() => null);
    if (!s) return;
    const rec = s as Record<string, string | boolean>;
    setCronSchedule((rec.cron_schedule as string) ?? '0 3 * * *');
    setWebhookUrl((rec.notify_webhook_url as string) ?? '');
    setProjectId((rec.google_project_id as string) ?? '');
    const conf: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k.endsWith('_configured')) conf[k.replace(/_configured$/, '')] = !!v;
    }
    setConfigured(conf);
  }

  useEffect(() => { loadSettings(); }, []);

  async function save(which: Tab, payload: Record<string, string>) {
    setSaving(which);
    setSaved(null);
    try {
      await api.updateSettings(payload);
      setKeys({});
      await loadSettings();
      await refresh();
      setSaved(which);
      setTimeout(() => setSaved(s => (s === which ? null : s)), 3000);
    } catch { /* badge state reflects reality */ }
    setSaving(null);
  }

  async function clearAuth() {
    if (!confirm('Clear all Google authentication credentials? You will need to re-authenticate.')) return;
    setClearLoading(true);
    await api.clearAuth();
    await refresh();
    setClearLoading(false);
    window.location.href = '/setup';
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Scheduling, accounts, keys and notifications</p>
      </div>

      {/* Tab bar */}
      <div className="settings-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`settings-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            <t.icon size={13} /> {t.label}
            {t.id === 'keys' && (
              <span className="settings-tab-count">{KEY_GUIDES.filter(g => configured[g.key]).length}/{KEY_GUIDES.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Scheduling ── */}
      {tab === 'schedule' && (
        <div className="card">
          <div className="card-title">Indexing schedule</div>
          <div className="input-group mb-3">
            <label className="input-label">Cron Expression</label>
            <input
              className="input"
              style={{ fontFamily: 'JetBrains Mono' }}
              value={cronSchedule}
              onChange={e => setCronSchedule(e.target.value)}
              placeholder="0 3 * * *"
            />
            <span className="input-hint">Server timezone (UTC). Current: <code style={{ fontFamily: 'JetBrains Mono' }}>{status?.scheduler.cronSchedule}</code></span>
          </div>
          <div className="flex gap-2 flex-wrap mb-3">
            {CRON_PRESETS.map(p => (
              <button key={p.value} className="btn btn-secondary btn-sm" onClick={() => setCronSchedule(p.value)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="alert alert-info mb-3">
            <div className="alert-content" style={{ fontSize: 12 }}>
              <strong>Google Indexing API limit:</strong> 200 URLs/day per Google Cloud project. The scheduler
              round-robins the budget across sites, prioritising new and changed URLs (via sitemap <code>&lt;lastmod&gt;</code>).
              IndexNow key setup lives on the <strong>Sites</strong> page (per-site verify), with full options in the
              {' '}<a href="https://github.com/martadams89/seo-website-indexer#indexnow--setting-up-the-key-file" target="_blank" rel="noopener noreferrer">README ↗</a>.
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button className="btn btn-primary" disabled={saving === 'schedule'} onClick={() => save('schedule', { cron_schedule: cronSchedule })}>
              {saving === 'schedule' ? <><span className="spinner" /> Saving…</> : saved === 'schedule' ? <><Save size={13} /> Saved ✓</> : <><Save size={13} /> Save Schedule</>}
            </button>
            {saved === 'schedule' && <span className="text-ok text-sm">Schedule updated and restarted.</span>}
          </div>
        </div>
      )}

      {/* ── Google ── */}
      {tab === 'google' && (
        <div className="card">
          <div className="card-title">Google account</div>
          <div className="flex items-center gap-3 mb-3">
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: status?.auth.authenticated ? 'var(--ok)' : 'var(--error)',
              boxShadow: status?.auth.authenticated ? '0 0 8px var(--ok)' : 'none',
            }} />
            <div>
              {status?.auth.authenticated ? (
                <>
                  <span className="text-ok" style={{ fontWeight: 600 }}>Connected (Google OAuth 2.0)</span>
                  {status.auth.expiresAt && (
                    <div className="text-dim text-xs mt-1">
                      Session active — token expires: {new Date(status.auth.expiresAt).toLocaleDateString()} (auto-refresh enabled)
                    </div>
                  )}
                </>
              ) : (
                <span className="text-error" style={{ fontWeight: 600 }}>Not authenticated</span>
              )}
            </div>
          </div>
          <div className="flex gap-2 mb-4">
            {!status?.auth.authenticated && (
              <a href="/setup" className="btn btn-primary btn-sm">Set Up Authentication</a>
            )}
            {status?.auth.authenticated && (
              <button className="btn btn-danger btn-sm" disabled={clearLoading} onClick={clearAuth}>
                {clearLoading ? <><span className="spinner" /> Clearing…</> : <><LogOut size={12} /> Clear Credentials</>}
              </button>
            )}
          </div>

          <div className="input-group mb-3">
            <label className="input-label">Google Cloud project ID <span className="text-dim" style={{ fontWeight: 400 }}>(optional)</span></label>
            <input
              className="input"
              placeholder="auto-derived from your linked OAuth client — set only to override"
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
            />
            <span className="input-hint">Used by the one-click Gemini key. Leave blank to use the project that owns your OAuth client.</span>
          </div>
          <button className="btn btn-primary" disabled={saving === 'google'} onClick={() => save('google', { google_project_id: projectId.trim() })}>
            {saving === 'google' ? <><span className="spinner" /> Saving…</> : saved === 'google' ? <><Save size={13} /> Saved ✓</> : <><Save size={13} /> Save</>}
          </button>
        </div>
      )}

      {/* ── API Keys ── */}
      {tab === 'keys' && (
        <div className="card">
          <div className="card-title">API keys</div>
          <p className="text-dim" style={{ fontSize: 12, marginBottom: 14 }}>
            Everything here is optional — the indexing loop needs none of it. Keys are write-only: stored server-side,
            never echoed back. Expand a key for the exact steps to get one.
          </p>
          {KEY_GUIDES.map(g => (
            <details key={g.key} className="key-guide">
              <summary>
                <span className="key-guide-label">{g.label}</span>
                {g.free && <span className="badge badge-ok">{g.free}</span>}
                {configured[g.key]
                  ? <span className="badge badge-ok" style={{ marginLeft: 'auto' }}>configured</span>
                  : <span className="badge" style={{ marginLeft: 'auto' }}>not set</span>}
              </summary>
              <div className="key-guide-body">
                <p className="text-dim" style={{ fontSize: 12, margin: '0 0 8px' }}>{g.hint}</p>
                <ol className="key-guide-steps">
                  {g.steps.map((s, i) => (
                    <li key={i}>
                      {s.text}
                      {s.href && (
                        <> <a href={s.href} target="_blank" rel="noopener noreferrer" className="key-guide-link"><ExternalLink size={10} /> {s.linkLabel ?? s.href}</a></>
                      )}
                    </li>
                  ))}
                </ol>
                <input
                  className="input"
                  type="password"
                  placeholder={configured[g.key] ? '•••••••• (set — paste a new value to replace, save empty to keep)' : 'paste key…'}
                  value={keys[g.key] ?? ''}
                  onChange={e => setKeys(prev => ({ ...prev, [g.key]: e.target.value }))}
                  autoComplete="off"
                />
                {g.key === 'gemini_api_key' && (
                  <div style={{ marginTop: 8 }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={provisioning}
                      onClick={async () => {
                        setProvisioning(true);
                        setProvisionMsg(null);
                        try {
                          await api.provisionGeminiKey();
                          setProvisionMsg('Gemini key created on your Google project and saved — no copy-paste needed.');
                          setConfigured(prev => ({ ...prev, gemini_api_key: true }));
                        } catch (e) {
                          setProvisionMsg(e instanceof Error ? e.message : 'Provisioning failed');
                        }
                        setProvisioning(false);
                      }}
                    >
                      {provisioning ? 'Provisioning…' : '⚡ Generate with linked Google account'}
                    </button>
                    {provisionMsg && <div style={{ fontSize: 11, marginTop: 4, color: provisionMsg.startsWith('Gemini key created') ? 'var(--ok)' : 'var(--warn)' }}>{provisionMsg}</div>}
                  </div>
                )}
              </div>
            </details>
          ))}
          <button
            className="btn btn-primary"
            style={{ marginTop: 12 }}
            disabled={saving === 'keys'}
            onClick={() => {
              const payload: Record<string, string> = {};
              for (const [k, v] of Object.entries(keys)) if (v.trim()) payload[k] = v.trim();
              save('keys', payload);
            }}
          >
            <Save size={13} /> {saving === 'keys' ? 'Saving…' : saved === 'keys' ? 'Saved ✓' : 'Save keys'}
          </button>
        </div>
      )}

      {/* ── Notifications ── */}
      {tab === 'notify' && (
        <div className="card">
          <div className="card-title">Notifications</div>
          <div className="input-group mb-3">
            <label className="input-label">Webhook URL {webhookUrl && <span className="badge badge-ok">set</span>}</label>
            <input
              className="input"
              placeholder="https://hooks.slack.com/… · https://discord.com/api/webhooks/… · https://ntfy.sh/your-topic"
              value={webhookUrl}
              onChange={e => setWebhookUrl(e.target.value)}
            />
            <span className="input-hint">
              Run summaries and alerts (index drops, schema regressions, quota) are pushed after every run.
              Slack, Discord and ntfy payloads are detected automatically; anything else receives generic JSON
              <code style={{ fontFamily: 'JetBrains Mono', margin: '0 4px' }}>{'{title, body}'}</code>.
              Save empty to disable.
            </span>
          </div>
          <button className="btn btn-primary" disabled={saving === 'notify'} onClick={() => save('notify', { notify_webhook_url: webhookUrl })}>
            {saving === 'notify' ? <><span className="spinner" /> Saving…</> : saved === 'notify' ? <><Save size={13} /> Saved ✓</> : <><Save size={13} /> Save</>}
          </button>
        </div>
      )}
    </div>
  );
}
