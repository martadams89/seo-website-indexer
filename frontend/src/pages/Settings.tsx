import { useState, useEffect, useCallback } from 'react';
import { Save, LogOut, KeyRound, Bell, Clock, User, ExternalLink, ShieldCheck, Copy, Check, Building2, Users, Trash2, Fingerprint, Plus, Send, Loader2, CheckCircle2, XCircle, MessageSquare, AtSign, Webhook } from 'lucide-react';
import { useAuth } from '../auth/AuthGate';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { useApp } from '../AppContext';
import { api, type WorkspaceMember, type BingAccount, type CurrentUser, type PasskeyInfo, type NotifyChannel, type NotifyChannelResult } from '../api';
import { ModelPicker } from '../components/ModelPicker';
import AccountsPage from './Accounts';
import { registerPasskey } from '../auth/webauthn';

type Tab = 'account' | 'workspace' | 'users' | 'schedule' | 'google' | 'keys' | 'notify';

interface KeyGuide {
  key: string;
  label: string;
  hint: string;
  free?: string;
  steps: Array<{ text: string; href?: string; linkLabel?: string }>;
}

const KEY_GUIDES: KeyGuide[] = [
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

const TABS: Array<{ id: Tab; label: string; icon: typeof Clock; superAdmin?: boolean }> = [
  { id: 'account',   label: 'Account & Security', icon: ShieldCheck },
  { id: 'workspace', label: 'Workspace', icon: Building2 },
  { id: 'keys',      label: 'API Keys',   icon: KeyRound },
  { id: 'notify',    label: 'Notifications', icon: Bell },
  { id: 'users',     label: 'Users', icon: Users, superAdmin: true },
  { id: 'schedule',  label: 'Scheduling', icon: Clock, superAdmin: true },
  { id: 'google',    label: 'Google Accounts', icon: User },
];

function AccountTab() {
  const { user, refreshUser } = useAuth();
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  // TOTP enrolment
  const [totpSetup, setTotpSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpMsg, setTotpMsg] = useState<string | null>(null);
  const [disablePw, setDisablePw] = useState('');
  const [copied, setCopied] = useState(false);
  // Passkeys
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [pkName, setPkName] = useState('');
  const [pkMsg, setPkMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pkBusy, setPkBusy] = useState(false);

  async function loadPasskeys() { setPasskeys(await api.listPasskeys().catch(() => [])); }
  useEffect(() => { loadPasskeys(); }, []);

  async function addPasskey() {
    setPkBusy(true); setPkMsg(null);
    try {
      await registerPasskey(pkName.trim() || 'Passkey');
      setPkName('');
      setPkMsg({ ok: true, text: 'Passkey added.' });
      await loadPasskeys();
    } catch (e) {
      setPkMsg({ ok: false, text: e instanceof Error ? e.message : 'Registration cancelled or failed.' });
    }
    setPkBusy(false);
  }
  async function removePasskey(id: string) {
    await api.deletePasskey(id).catch(() => null);
    await loadPasskeys();
  }

  async function changePassword() {
    setPwBusy(true); setPwMsg(null);
    try {
      await api.changePassword(curPw, newPw);
      setPwMsg({ ok: true, text: 'Password changed.' });
      setCurPw(''); setNewPw('');
    } catch (e) { setPwMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' }); }
    setPwBusy(false);
  }

  async function startTotp() {
    setTotpMsg(null);
    try { setTotpSetup(await api.totpSetup()); } catch (e) { setTotpMsg(e instanceof Error ? e.message : 'Failed'); }
  }
  async function enableTotp() {
    setTotpMsg(null);
    try {
      await api.totpEnable(totpCode);
      setTotpSetup(null); setTotpCode('');
      await refreshUser();
    } catch (e) { setTotpMsg(e instanceof Error ? e.message : 'Invalid code'); }
  }
  async function disableTotp() {
    setTotpMsg(null);
    try { await api.totpDisable(disablePw); setDisablePw(''); await refreshUser(); }
    catch (e) { setTotpMsg(e instanceof Error ? e.message : 'Failed'); }
  }

  return (
    <>
      <div className="card mb-4">
        <div className="card-title"><User size={13} /> Profile</div>
        <div className="site-facts">
          <div className="site-fact"><span className="site-fact-label">Name</span><span className="site-fact-value">{user.name || '—'}</span></div>
          <div className="site-fact"><span className="site-fact-label">Email</span><span className="site-fact-value">{user.email}</span></div>
          <div className="site-fact"><span className="site-fact-label">Role</span><span className="site-fact-value">{user.is_super_admin ? 'Super-admin' : user.role}</span></div>
          <div className="site-fact"><span className="site-fact-label">2FA</span><span className="site-fact-value">{user.totp_enabled ? 'Enabled' : 'Off'}</span></div>
        </div>
      </div>

      <div className="card mb-4">
        <div className="card-title">Change password</div>
        <div className="site-form" style={{ maxWidth: 420 }}>
          <div className="input-group mb-3">
            <label className="input-label">Current password</label>
            <input className="input" type="password" value={curPw} onChange={e => setCurPw(e.target.value)} autoComplete="current-password" />
          </div>
          <div className="input-group mb-3">
            <label className="input-label">New password</label>
            <input className="input" type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
          </div>
          <div className="flex items-center gap-3">
            <button className="btn btn-primary btn-sm" disabled={pwBusy || !curPw || newPw.length < 8} onClick={changePassword}>
              <Save size={13} /> {pwBusy ? 'Saving…' : 'Change password'}
            </button>
            {pwMsg && <span style={{ fontSize: 12, color: pwMsg.ok ? 'var(--ok)' : 'var(--error)' }}>{pwMsg.text}</span>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title"><ShieldCheck size={13} /> Two-factor authentication (TOTP)</div>
        {user.totp_enabled ? (
          <div className="site-form" style={{ maxWidth: 420 }}>
            <div className="empty-note" style={{ marginBottom: 10 }}><ShieldCheck size={12} /> 2FA is enabled on your account.</div>
            <div className="input-group mb-3">
              <label className="input-label">Confirm password to disable</label>
              <input className="input" type="password" value={disablePw} onChange={e => setDisablePw(e.target.value)} autoComplete="current-password" />
            </div>
            <button className="btn btn-danger btn-sm" disabled={!disablePw} onClick={disableTotp}>Disable 2FA</button>
            {totpMsg && <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 6 }}>{totpMsg}</div>}
          </div>
        ) : totpSetup ? (
          <div className="site-form" style={{ maxWidth: 460 }}>
            <p className="text-dim" style={{ fontSize: 12 }}>
              Scan this QR code with your authenticator app (Google Authenticator, 1Password, Authy…), or enter the key manually — then type the 6-digit code to confirm.
            </p>
            <div className="totp-qr">
              <img src={totpSetup.qr} alt="TOTP QR code" width={200} height={200} />
            </div>
            <div className="input-group mb-2">
              <label className="input-label">Or enter this key manually</label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <code style={{ flex: 1, fontSize: 12, wordBreak: 'break-all', background: 'var(--bg-input)', padding: '6px 10px', borderRadius: 6 }}>{totpSetup.secret}</code>
                <button className="btn-icon btn-icon-ghost" onClick={() => { navigator.clipboard.writeText(totpSetup.uri); setCopied(true); setTimeout(() => setCopied(false), 1500); }} title="Copy otpauth URI">
                  {copied ? <Check size={14} style={{ color: 'var(--ok)' }} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
            <div className="input-group mb-3">
              <label className="input-label">6-digit code</label>
              <input className="input" value={totpCode} onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" inputMode="numeric" />
            </div>
            <div className="flex gap-2">
              <button className="btn btn-primary btn-sm" disabled={totpCode.length !== 6} onClick={enableTotp}>Enable 2FA</button>
              <button className="btn btn-secondary btn-sm" onClick={() => { setTotpSetup(null); setTotpMsg(null); }}>Cancel</button>
            </div>
            {totpMsg && <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 6 }}>{totpMsg}</div>}
          </div>
        ) : (
          <div className="site-form" style={{ maxWidth: 420 }}>
            <p className="text-dim" style={{ fontSize: 12, marginBottom: 10 }}>Protect your account with a time-based one-time code from an authenticator app.</p>
            <button className="btn btn-primary btn-sm" onClick={startTotp}><ShieldCheck size={13} /> Set up 2FA</button>
            {totpMsg && <div style={{ fontSize: 12, color: 'var(--error)', marginTop: 6 }}>{totpMsg}</div>}
          </div>
        )}
      </div>

      <div className="card mt-4">
        <div className="card-title"><Fingerprint size={13} /> Passkeys</div>
        <p className="text-dim" style={{ fontSize: 12, marginBottom: 10 }}>
          Sign in without a password using Face ID, Touch ID, Windows Hello or a security key. You can register more than one.
        </p>
        <div className="member-list">
          {passkeys.map(pk => (
            <div key={pk.id} className="member-row">
              <div className="member-info">
                <span className="member-name">{pk.name || 'Passkey'}</span>
                <span className="member-role">Added {new Date(pk.created_at).toLocaleDateString()}</span>
              </div>
              <button className="btn-icon btn-icon-ghost" title="Remove" onClick={() => removePasskey(pk.id)}><Trash2 size={13} /></button>
            </div>
          ))}
          {passkeys.length === 0 && <div className="empty-note">No passkeys yet.</div>}
        </div>
        <div className="flex gap-2 mt-3" style={{ maxWidth: 420 }}>
          <input className="input" placeholder="Name (e.g. MacBook Touch ID)" value={pkName} onChange={e => setPkName(e.target.value)} />
          <button className="btn btn-primary btn-sm" disabled={pkBusy} onClick={addPasskey}>
            {pkBusy ? '…' : <><Fingerprint size={13} /> Add passkey</>}
          </button>
        </div>
        {pkMsg && <div style={{ fontSize: 12, marginTop: 8, color: pkMsg.ok ? 'var(--ok)' : 'var(--error)' }}>{pkMsg.text}</div>}
      </div>
    </>
  );
}

// ── Workspace tab: rename, members, Bing accounts ────────────────────────────
function WorkspaceTab() {
  const { active, refreshWorkspaces } = useWorkspace();
  const [name, setName] = useState(active?.name ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [memberEmail, setMemberEmail] = useState('');

  const canManage = !!active?.is_owner;

  async function load() {
    if (!active) return;
    setMembers(await api.getWorkspaceMembers(active.id).catch(() => []));
  }
  useEffect(() => { setName(active?.name ?? ''); load(); }, [active?.id]);

  async function rename() {
    if (!active) return;
    setMsg(null);
    try { await api.renameWorkspace(active.id, name.trim()); await refreshWorkspaces(); setMsg('Saved.'); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
  }
  async function addMember() {
    if (!active || !memberEmail.trim()) return;
    setMsg(null);
    try { await api.addWorkspaceMember(active.id, memberEmail.trim()); setMemberEmail(''); await load(); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
  }
  async function removeMember(userId: string) {
    if (!active) return;
    await api.removeWorkspaceMember(active.id, userId).catch(() => null);
    await load();
  }

  if (!active) return <div className="card"><div className="empty-note">No workspace selected.</div></div>;

  return (
    <>
      <div className="card mb-4">
        <div className="card-title"><Building2 size={13} /> Workspace</div>
        <div className="site-form" style={{ maxWidth: 420 }}>
          <div className="input-group mb-3">
            <label className="input-label">Name</label>
            <input className="input" value={name} onChange={e => setName(e.target.value)} disabled={!canManage} />
          </div>
          {canManage && (
            <button className="btn btn-primary btn-sm" disabled={!name.trim() || name.trim() === active.name} onClick={rename}>
              <Save size={13} /> Save name
            </button>
          )}
          {!canManage && <p className="text-dim" style={{ fontSize: 12 }}>You're a member of this workspace. Only the owner can change its settings.</p>}
          {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg === 'Saved.' ? 'var(--ok)' : 'var(--error)' }}>{msg}</div>}
        </div>
      </div>

      <div className="card mb-4">
        <div className="card-title"><Users size={13} /> Members</div>
        <div className="member-list">
          {members.map(m => (
            <div key={m.user_id} className="member-row">
              <div className="member-info">
                <span className="member-name">{m.name || m.email}</span>
                <span className="member-role">{m.is_owner ? 'Owner' : m.role}</span>
              </div>
              {canManage && !m.is_owner && (
                <button className="btn-icon btn-icon-ghost" title="Remove" onClick={() => removeMember(m.user_id)}><Trash2 size={13} /></button>
              )}
            </div>
          ))}
          {members.length === 0 && <div className="empty-note">Just you so far.</div>}
        </div>
        {canManage && (
          <div className="flex gap-2 mt-3" style={{ maxWidth: 420 }}>
            <input className="input" placeholder="teammate@example.com" value={memberEmail}
              onChange={e => setMemberEmail(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addMember(); }} />
            <button className="btn btn-secondary btn-sm" disabled={!memberEmail.trim()} onClick={addMember}><Plus size={13} /> Add</button>
          </div>
        )}
        {canManage && <p className="text-dim" style={{ fontSize: 11, marginTop: 8 }}>The user must already have an account (create them under the Users tab).</p>}
      </div>
    </>
  );
}

// ── Users tab (super-admin): create / manage accounts ────────────────────────
function UsersTab() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<CurrentUser[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [superAdmin, setSuperAdmin] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() { setUsers(await api.listUsers().catch(() => [])); }
  useEffect(() => { load(); }, []);

  async function create() {
    setMsg(null);
    try {
      await api.createUser({ email: email.trim(), password, name: name.trim() || undefined, superAdmin });
      setEmail(''); setName(''); setPassword(''); setSuperAdmin(false);
      setMsg({ ok: true, text: 'User created with their own workspace.' });
      await load();
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' }); }
  }
  async function remove(id: string) {
    if (!confirm('Delete this user? Their owned workspaces and data are removed.')) return;
    await api.deleteUser(id).catch((e) => setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' }));
    await load();
  }
  async function toggleAdmin(u: CurrentUser) {
    await api.updateUser(u.id, { superAdmin: !u.is_super_admin }).catch((e) => setMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed' }));
    await load();
  }

  return (
    <>
      <div className="card mb-4">
        <div className="card-title"><Users size={13} /> Users</div>
        <div className="member-list">
          {users.map(u => (
            <div key={u.id} className="member-row">
              <div className="member-info">
                <span className="member-name">{u.name || u.email}{u.id === me.id && <span className="text-dim"> (you)</span>}</span>
                <span className="member-role">{u.is_super_admin ? 'Super-admin' : u.role}{u.totp_enabled ? ' · 2FA' : ''}</span>
              </div>
              <div className="flex gap-1">
                <button className="btn btn-secondary btn-sm" onClick={() => toggleAdmin(u)} disabled={u.id === me.id}>
                  {u.is_super_admin ? 'Revoke admin' : 'Make admin'}
                </button>
                <button className="btn-icon btn-icon-ghost" title="Delete" onClick={() => remove(u.id)} disabled={u.id === me.id}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title"><Plus size={13} /> Add a user</div>
        <div className="site-form" style={{ maxWidth: 420 }}>
          <div className="input-group mb-3">
            <label className="input-label">Email</label>
            <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="off" />
          </div>
          <div className="input-group mb-3">
            <label className="input-label">Name <span className="text-dim" style={{ fontWeight: 400 }}>(optional)</span></label>
            <input className="input" value={name} onChange={e => setName(e.target.value)} autoComplete="off" />
          </div>
          <div className="input-group mb-3">
            <label className="input-label">Temporary password</label>
            <input className="input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
          </div>
          <label className="flex items-center gap-2 mb-3" style={{ fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={superAdmin} onChange={e => setSuperAdmin(e.target.checked)} /> Super-admin (full access to every workspace)
          </label>
          <button className="btn btn-primary btn-sm" disabled={!email.trim() || password.length < 8} onClick={create}>
            <Plus size={13} /> Create user
          </button>
          {msg && <div style={{ fontSize: 12, marginTop: 8, color: msg.ok ? 'var(--ok)' : 'var(--error)' }}>{msg.text}</div>}
        </div>
      </div>
    </>
  );
}

// ── Notifications tab: each provider is a first-class, separately-configured channel ──
interface NotifyField { key: string; label: string; placeholder?: string; secret?: boolean }
interface NotifyProvider { id: NotifyChannel; name: string; icon: typeof Bell; blurb: string; fields: NotifyField[]; steps: Array<{ text: string; href?: string; linkLabel?: string }> }

const NOTIFY_PROVIDERS: NotifyProvider[] = [
  {
    id: 'slack', name: 'Slack', icon: MessageSquare,
    blurb: 'Post run summaries and alerts into a Slack channel via an Incoming Webhook.',
    fields: [{ key: 'notify_slack_webhook', label: 'Incoming Webhook URL', placeholder: 'https://hooks.slack.com/services/…' }],
    steps: [
      { text: 'Create a Slack app and add an Incoming Webhook, or use a legacy webhook.', href: 'https://api.slack.com/messaging/webhooks', linkLabel: 'Slack Incoming Webhooks' },
      { text: 'Pick the channel to post to and copy the webhook URL.' },
    ],
  },
  {
    id: 'discord', name: 'Discord', icon: MessageSquare,
    blurb: 'Post to a Discord channel via a channel webhook.',
    fields: [{ key: 'notify_discord_webhook', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…' }],
    steps: [
      { text: 'Channel → Edit Channel → Integrations → Webhooks → New Webhook.' },
      { text: 'Copy the webhook URL.' },
    ],
  },
  {
    id: 'ntfy', name: 'ntfy', icon: Bell,
    blurb: 'Push to your phone/desktop via ntfy (self-hosted or ntfy.sh). Free, no account needed.',
    fields: [
      { key: 'notify_ntfy_topic', label: 'Topic', placeholder: 'my-seo-alerts (or a full https://…/topic URL)' },
      { key: 'notify_ntfy_server', label: 'Server', placeholder: 'https://ntfy.sh (default)' },
      { key: 'notify_ntfy_token', label: 'Access token (optional)', placeholder: 'tk_… for protected topics', secret: true },
    ],
    steps: [
      { text: 'Pick a hard-to-guess topic name and subscribe to it in the ntfy app.', href: 'https://ntfy.sh/', linkLabel: 'ntfy.sh' },
      { text: 'For a private/self-hosted server, set the server URL and an access token.' },
    ],
  },
  {
    id: 'telegram', name: 'Telegram', icon: Send,
    blurb: 'Message yourself or a group through a Telegram bot.',
    fields: [
      { key: 'notify_telegram_token', label: 'Bot token', placeholder: '123456:ABC-DEF…', secret: true },
      { key: 'notify_telegram_chat', label: 'Chat ID', placeholder: 'e.g. 123456789 or -100… for groups' },
    ],
    steps: [
      { text: 'Create a bot with @BotFather and copy its token.', href: 'https://t.me/BotFather', linkLabel: '@BotFather' },
      { text: 'Message your bot once, then get your chat id from https://api.telegram.org/bot<token>/getUpdates.' },
    ],
  },
  {
    id: 'webhook', name: 'Generic webhook', icon: Webhook,
    blurb: 'POST a JSON {title, body} to any endpoint. (Slack/Discord/ntfy URLs here are still auto-detected for backwards compatibility.)',
    fields: [{ key: 'notify_webhook_url', label: 'Webhook URL', placeholder: 'https://example.com/hook' }],
    steps: [{ text: 'Your endpoint receives a POST with a JSON body: {"title": "…", "body": "…"}.' }],
  },
  {
    id: 'email', name: 'Email', icon: AtSign,
    blurb: 'Email run summaries and alerts. Requires SMTP to be configured on the server (SMTP_HOST env).',
    fields: [{ key: 'notify_email_to', label: 'Send to', placeholder: 'you@example.com, ops@example.com' }],
    steps: [{ text: 'Set the SMTP_* environment variables on the container (see the README), then add recipient addresses here.' }],
  },
];

function NotificationsTab() {
  const { active } = useWorkspace();
  const canManage = !!active?.is_owner;
  const [vals, setVals] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<NotifyChannelResult[] | null>(null);

  useEffect(() => {
    api.getNotifyConfig().then(rec => {
      const keys = NOTIFY_PROVIDERS.flatMap(p => p.fields.map(f => f.key));
      const next: Record<string, string> = {};
      for (const k of keys) next[k] = rec[k] ?? '';
      setVals(next);
    }).finally(() => setLoaded(true));
  }, [active?.id]);

  function set(key: string, v: string) { setVals(prev => ({ ...prev, [key]: v })); setSaved(false); }

  async function save() {
    setSaving(true);
    try { await api.saveNotifyConfig(vals); setSaved(true); setTimeout(() => setSaved(false), 3000); }
    finally { setSaving(false); }
  }
  async function sendTest() {
    setTesting(true); setResults(null);
    try { await save(); const r = await api.testNotifications(); setResults(r.results); }
    finally { setTesting(false); }
  }

  const providerConfigured = (p: NotifyProvider) =>
    p.id === 'telegram'
      ? !!(vals.notify_telegram_token && vals.notify_telegram_chat)
      : !!vals[p.fields[0].key];

  if (!loaded) return <div className="card"><div className="empty-note">Loading…</div></div>;

  return (
    <>
      <div className="card mb-4">
        <div className="card-title"><Bell size={13} /> Notifications{active ? ` — ${active.name}` : ''}</div>
        <p className="text-dim" style={{ fontSize: 12 }}>
          These channels belong to the <strong>{active?.name ?? 'current'}</strong> workspace — each workspace notifies its own places.
          Run summaries and alerts for this workspace's sites are pushed after every run; a notification is sent to <strong>all</strong> configured channels.
          {!canManage && <> <em>You can view these, but only the workspace owner can change them.</em></>}
        </p>
      </div>

      {NOTIFY_PROVIDERS.map(p => (
        <details key={p.id} className="key-guide" open={providerConfigured(p)}>
          <summary>
            <p.icon size={14} />
            <span className="key-guide-label">{p.name}</span>
            {providerConfigured(p)
              ? <span className="badge badge-ok" style={{ marginLeft: 'auto' }}>configured</span>
              : <span className="badge" style={{ marginLeft: 'auto' }}>off</span>}
          </summary>
          <div className="key-guide-body">
            <p className="text-dim" style={{ fontSize: 12, margin: '0 0 8px' }}>{p.blurb}</p>
            {p.fields.map(f => (
              <div className="input-group mb-2" key={f.key}>
                <label className="input-label">{f.label}</label>
                <input
                  className="input"
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  placeholder={f.placeholder}
                  value={vals[f.key] ?? ''}
                  onChange={e => set(f.key, e.target.value)}
                />
              </div>
            ))}
            <ol className="key-guide-steps">
              {p.steps.map((s, i) => (
                <li key={i}>{s.text}{s.href && <> <a href={s.href} target="_blank" rel="noopener noreferrer" className="key-guide-link"><ExternalLink size={10} /> {s.linkLabel ?? s.href}</a></>}</li>
              ))}
            </ol>
          </div>
        </details>
      ))}

      <div className="flex items-center gap-3" style={{ marginTop: 14, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" disabled={saving || !canManage} onClick={save}>
          {saving ? <><Loader2 className="spin" size={13} /> Saving…</> : saved ? <><Save size={13} /> Saved ✓</> : <><Save size={13} /> Save channels</>}
        </button>
        <button className="btn btn-secondary" disabled={testing || !canManage} onClick={sendTest}>
          {testing ? <><Loader2 className="spin" size={13} /> Sending…</> : <><Send size={13} /> Save & send test</>}
        </button>
      </div>

      {results && (
        <div className="card mt-3">
          <div className="card-title">Test results</div>
          {results.length === 0 ? (
            <div className="empty-note">No channels configured yet — add one above and save.</div>
          ) : (
            <div className="member-list">
              {results.map(r => (
                <div key={r.channel} className="member-row">
                  <div className="member-info">
                    <span className="member-name" style={{ textTransform: 'capitalize' }}>{r.channel}</span>
                    {r.error && <span className="member-role" style={{ color: 'var(--error)' }}>{r.error}</span>}
                  </div>
                  {r.ok
                    ? <CheckCircle2 size={16} style={{ color: 'var(--ok)' }} />
                    : <XCircle size={16} style={{ color: 'var(--error)' }} />}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// Bing Webmaster accounts — one or more API keys per workspace (each site can
// pick which to use). Lives in the API Keys tab alongside the other credentials.
function BingAccounts() {
  const { active } = useWorkspace();
  const canManage = !!active?.is_owner;
  const [bing, setBing] = useState<BingAccount[]>([]);
  const [bingName, setBingName] = useState('');
  const [bingKey, setBingKey] = useState('');

  const load = useCallback(async () => { setBing(await api.getBingAccounts().catch(() => [])); }, []);
  useEffect(() => { load(); }, [load, active?.id]);

  async function addBing() {
    if (!bingKey.trim()) return;
    await api.addBingAccount(bingName.trim() || 'Bing account', bingKey.trim()).catch(() => null);
    setBingName(''); setBingKey(''); await load();
  }
  async function removeBing(id: string) { await api.removeBingAccount(id).catch(() => null); await load(); }

  return (
    <div className="card mt-4">
      <div className="card-title"><KeyRound size={13} /> Bing Webmaster accounts{active ? ` — ${active.name}` : ''}</div>
      <p className="text-dim" style={{ fontSize: 12, marginBottom: 10 }}>
        Direct URL submission into your verified Bing properties (optional — IndexNow already pings Bing). Add one key, or
        several (one per client property) and pick which each site uses. Generate a key at{' '}
        <a href="https://www.bing.com/webmasters/" target="_blank" rel="noopener noreferrer" className="key-guide-link"><ExternalLink size={10} /> bing.com/webmasters</a> → Settings → API access.
      </p>
      <div className="member-list">
        {bing.map(b => (
          <div key={b.id} className="member-row">
            <span className="member-name">{b.name}</span>
            {canManage && <button className="btn-icon btn-icon-ghost" title="Remove" onClick={() => removeBing(b.id)}><Trash2 size={13} /></button>}
          </div>
        ))}
        {bing.length === 0 && <div className="empty-note">No Bing accounts yet.</div>}
      </div>
      {canManage && (
        <div className="flex gap-2 mt-3 flex-wrap" style={{ maxWidth: 520 }}>
          <input className="input" style={{ flex: '1 1 140px' }} placeholder="Label (e.g. Client A)" value={bingName} onChange={e => setBingName(e.target.value)} />
          <input className="input" style={{ flex: '2 1 200px' }} type="password" placeholder="Bing API key" value={bingKey} onChange={e => setBingKey(e.target.value)} />
          <button className="btn btn-secondary btn-sm" disabled={!bingKey.trim()} onClick={addBing}><Plus size={13} /> Add</button>
        </div>
      )}
    </div>
  );
}

// ── API Keys tab: per-workspace overrides, layered over super-admin platform defaults ──
function KeysTab() {
  const { user } = useAuth();
  const { active } = useWorkspace();
  const canManage = !!active?.is_owner;
  const isAdmin = user.is_super_admin;
  const [keyStatus, setKeyStatus] = useState<Record<string, { override: boolean; platform: boolean }>>({});
  const [wsVals, setWsVals] = useState<Record<string, string>>({});      // workspace override inputs
  const [platVals, setPlatVals] = useState<Record<string, string>>({});  // platform default inputs (super-admin)
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionMsg, setProvisionMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.getWorkspaceKeys().catch(() => ({ keys: {} as Record<string, { override: boolean; platform: boolean }> }));
    setKeyStatus(r.keys);
  }, []);
  useEffect(() => { load(); }, [load, active?.id]);

  async function save() {
    setSaving(true); setSaved(false);
    try {
      const wsPayload: Record<string, string> = {};
      for (const [k, v] of Object.entries(wsVals)) if (v !== undefined) wsPayload[k] = v.trim();
      if (Object.keys(wsPayload).length) await api.saveWorkspaceKeys(wsPayload);
      if (isAdmin) {
        const platPayload: Record<string, string> = {};
        for (const [k, v] of Object.entries(platVals)) if (v.trim()) platPayload[k] = v.trim();
        if (Object.keys(platPayload).length) await api.updateSettings(platPayload);
      }
      setWsVals({}); setPlatVals({});
      await load();
      setSaved(true); setTimeout(() => setSaved(false), 3000);
    } finally { setSaving(false); }
  }

  function statusBadge(key: string) {
    const s = keyStatus[key];
    if (s?.override) return <span className="badge badge-ok" style={{ marginLeft: 'auto' }}>this workspace</span>;
    if (s?.platform) return <span className="badge" style={{ marginLeft: 'auto', color: 'var(--accent)' }}>platform default</span>;
    return <span className="badge" style={{ marginLeft: 'auto' }}>not set</span>;
  }

  return (
    <>
    <div className="card">
      <div className="card-title"><KeyRound size={13} /> API keys{active ? ` — ${active.name}` : ''}</div>
      <p className="text-dim" style={{ fontSize: 12, marginBottom: 6 }}>
        Everything here is optional. Keys you set apply to <strong>this workspace</strong> and override any platform default.
        Leave a key blank to inherit the platform default{isAdmin ? ' (which you, as a super-admin, can set below each key for all workspaces)' : ' set by an administrator'}.
        Keys are write-only — stored server-side, never echoed back.
      </p>
      <p className="text-dim" style={{ fontSize: 11.5, marginBottom: 14 }}>
        <strong>Bing Webmaster</strong> keys are managed just below (one or several — one per client property).
      </p>
      {KEY_GUIDES.map(g => (
        <details key={g.key} className="key-guide" open={!!wsVals[g.key]}>
          <summary>
            <span className="key-guide-label">{g.label}</span>
            {g.free && <span className="badge badge-ok">{g.free}</span>}
            {statusBadge(g.key)}
          </summary>
          <div className="key-guide-body">
            <p className="text-dim" style={{ fontSize: 12, margin: '0 0 8px' }}>{g.hint}</p>
            <ol className="key-guide-steps">
              {g.steps.map((s, i) => (
                <li key={i}>{s.text}{s.href && <> <a href={s.href} target="_blank" rel="noopener noreferrer" className="key-guide-link"><ExternalLink size={10} /> {s.linkLabel ?? s.href}</a></>}</li>
              ))}
            </ol>
            <label className="input-label" style={{ fontSize: 11 }}>For this workspace ({active?.name})</label>
            <input
              className="input"
              type="password"
              disabled={!canManage}
              placeholder={keyStatus[g.key]?.override ? '•••••••• (override set — paste to replace, empty to clear → inherit)' : 'paste key for this workspace…'}
              value={wsVals[g.key] ?? ''}
              onChange={e => setWsVals(prev => ({ ...prev, [g.key]: e.target.value }))}
              autoComplete="off"
            />
            {isAdmin && (
              <div style={{ marginTop: 8 }}>
                <label className="input-label" style={{ fontSize: 11, color: 'var(--accent)' }}>Platform default (all workspaces)</label>
                <input
                  className="input"
                  type="password"
                  placeholder={keyStatus[g.key]?.platform ? '•••••••• (set — paste to replace)' : 'paste platform-wide key…'}
                  value={platVals[g.key] ?? ''}
                  onChange={e => setPlatVals(prev => ({ ...prev, [g.key]: e.target.value }))}
                  autoComplete="off"
                />
              </div>
            )}
            {g.key === 'gemini_api_key' && canManage && (
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-secondary btn-sm" disabled={provisioning} onClick={async () => {
                  setProvisioning(true); setProvisionMsg(null);
                  try { await api.provisionGeminiKey(); setProvisionMsg('Gemini key created on your Google project and saved to this workspace.'); await load(); }
                  catch (e) { setProvisionMsg(e instanceof Error ? e.message : 'Provisioning failed'); }
                  setProvisioning(false);
                }}>
                  {provisioning ? 'Provisioning…' : '⚡ Generate with linked Google account'}
                </button>
                {provisionMsg && <div style={{ fontSize: 11, marginTop: 4, color: provisionMsg.startsWith('Gemini key created') ? 'var(--ok)' : 'var(--warn)' }}>{provisionMsg}</div>}
              </div>
            )}
          </div>
        </details>
      ))}
      <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={saving || !canManage} onClick={save}>
        <Save size={13} /> {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save keys'}
      </button>
      {!canManage && <p className="text-dim" style={{ fontSize: 11, marginTop: 8 }}>Only the workspace owner can set keys for {active?.name}.</p>}
    </div>
    <BingAccounts />
    <ModelPicker />
    </>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  const { status, refresh } = useApp();
  const [tab, setTab] = useState<Tab>(user.is_super_admin ? 'schedule' : 'account');
  const [cronSchedule, setCronSchedule] = useState('');
  const [projectId, setProjectId] = useState('');
  const [saving, setSaving] = useState<Tab | null>(null);
  const [saved, setSaved] = useState<Tab | null>(null);
  const [clearLoading, setClearLoading] = useState(false);

  async function loadSettings() {
    const s = await api.getSettings().catch(() => null);
    if (!s) return;
    const rec = s as Record<string, string | boolean>;
    setCronSchedule((rec.cron_schedule as string) ?? '0 3 * * *');
    setProjectId((rec.google_project_id as string) ?? '');
  }

  useEffect(() => { loadSettings(); }, []);

  async function save(which: Tab, payload: Record<string, string>) {
    setSaving(which);
    setSaved(null);
    try {
      await api.updateSettings(payload);
      await loadSettings();
      await refresh();
      setSaved(which);
      setTimeout(() => setSaved(s => (s === which ? null : s)), 3000);
    } catch { /* badge state reflects reality */ }
    setSaving(null);
  }

  async function clearAuth() {
    if (!confirm('Disconnect all Google accounts from THIS workspace? Other workspaces are unaffected. You will need to re-connect them here.')) return;
    setClearLoading(true);
    await api.clearAuth();
    await refresh();
    setClearLoading(false);
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Scheduling, accounts, keys and notifications</p>
      </div>

      {/* Tab bar */}
      <div className="settings-tabs">
        {TABS.filter(t => !t.superAdmin || user.is_super_admin).map(t => (
          <button key={t.id} className={`settings-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {/* ── Account & Security ── */}
      {tab === 'account' && <AccountTab />}

      {/* ── Workspace ── */}
      {tab === 'workspace' && <WorkspaceTab />}

      {/* ── Users (super-admin) ── */}
      {tab === 'users' && user.is_super_admin && <UsersTab />}

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

      {/* ── Google Accounts ── */}
      {tab === 'google' && (
        <>
          <div className="card">
            <div className="card-title"><User size={13} /> Connected Google accounts</div>
            <AccountsPage embedded />
          </div>

          <div className="card mt-4">
            <div className="card-title">Advanced</div>
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
            <div className="flex gap-2" style={{ alignItems: 'center' }}>
              <button className="btn btn-primary btn-sm" disabled={saving === 'google'} onClick={() => save('google', { google_project_id: projectId.trim() })}>
                {saving === 'google' ? <><span className="spinner" /> Saving…</> : saved === 'google' ? <><Save size={13} /> Saved ✓</> : <><Save size={13} /> Save</>}
              </button>
              {status?.auth.authenticated && (
                <button className="btn btn-danger btn-sm" disabled={clearLoading} onClick={clearAuth} title="Disconnect every Google account in this workspace">
                  {clearLoading ? <><span className="spinner" /> Clearing…</> : <><LogOut size={12} /> Disconnect all</>}
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── API Keys ── */}
      {tab === 'keys' && <KeysTab />}

      {/* ── Notifications ── */}
      {tab === 'notify' && <NotificationsTab />}
    </div>
  );
}
