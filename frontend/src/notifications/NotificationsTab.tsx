/**
 * Settings → Notifications for one workspace: which events to send, the
 * channels (Slack, Discord, ntfy, Telegram, WhatsApp, webhook, email), named
 * email lists that each pick their events, and a grid that narrows which
 * events each channel gets. Messages about something waiting for a decision
 * carry a link straight to it in this workspace.
 */
import { useEffect, useState } from 'react';
import {
  AtSign, Bell, CheckCircle2, Clock, ExternalLink, Link2, Loader2, MessageCircle, MessageSquare, Plus, Route, Save, Send, Trash2, Users, Webhook, XCircle,
} from 'lucide-react';
import { api, type NotificationDelivery, type NotifyChannel, type NotifyChannelResult } from '../api';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { workspacePath } from '../api/client';
import './notifications.css';

type EventId =
  | 'review_approvals' | 'ads_approvals' | 'ads_alerts'
  | 'review_alerts' | 'profile_alerts' | 'google_connection' | 'citation_changes'
  | 'run_complete' | 'run_failed' | 'playbook_ready';

interface EventInfo { id: EventId; label: string; description: string }
const EVENT_GROUPS: Array<{ title: string; events: EventInfo[] }> = [
  {
    title: 'Needs a decision',
    events: [
      { id: 'review_approvals', label: 'Business Profile approvals', description: 'A review reply, profile edit, post or photo from an AI assistant is waiting for you. The message links straight to it to approve or reject.' },
      { id: 'ads_approvals', label: 'Google Ads approvals', description: 'A Google Ads change from an AI assistant is outside the client\'s guardrails and needs a person. The message links straight to it.' },
      { id: 'ads_alerts', label: 'Google Ads changes that failed', description: 'Google refused a change an AI assistant tried to apply.' },
    ],
  },
  {
    title: 'Alerts',
    events: [
      { id: 'review_alerts', label: 'Google review alerts', description: 'A new low-rated Google review arrives, or Google rejects a reply (threshold set per location).' },
      { id: 'profile_alerts', label: 'Business Profile changes', description: 'Google, or someone using "Suggest an edit", changed a Business Profile you manage (checked daily, sent once per change).' },
      { id: 'google_connection', label: 'Google connection problems', description: 'A Google connection needs reconnecting, a new permission, or a Google API switched on. Sent once per change.' },
      { id: 'citation_changes', label: 'AI citation movement', description: 'A tracked answer engine gains or loses your domain.' },
    ],
  },
  {
    title: 'Runs and reports',
    events: [
      { id: 'run_complete', label: 'Successful runs', description: 'A workspace run finishes normally.' },
      { id: 'run_failed', label: 'Failed or stopped runs', description: 'A run fails, is stopped, or cannot complete.' },
      { id: 'playbook_ready', label: 'Ranking playbook ready', description: 'Weekly summary of new ranking opportunities and their estimated upside.' },
    ],
  },
];
const EVENTS = EVENT_GROUPS.flatMap(g => g.events);
const ALL_EVENT_IDS = EVENTS.map(e => e.id);

interface NotifyField { key: string; label: string; placeholder?: string; secret?: boolean }
interface NotifyProvider {
  id: NotifyChannel; name: string; icon: typeof Bell; blurb: string; fields: NotifyField[];
  /** Keys that must all be set for the channel to count as on. */
  required: string[];
  steps: Array<{ text: string; href?: string; linkLabel?: string }>;
}

const NOTIFY_PROVIDERS: NotifyProvider[] = [
  {
    id: 'email', name: 'Email', icon: AtSign,
    blurb: 'Email alerts with buttons that open the item. Needs SMTP set up on the server (SMTP_HOST and friends). Add named lists below to send different events to different people.',
    fields: [{ key: 'notify_email_to', label: 'Default recipients (get every event unless narrowed in the grid below)', placeholder: 'you@example.com, ops@example.com' }],
    required: [],
    steps: [{ text: 'Set the SMTP_* environment variables on the container (see the README), then add recipients here or in a list.' }],
  },
  {
    id: 'whatsapp', name: 'WhatsApp', icon: MessageCircle,
    blurb: 'Send alerts to WhatsApp numbers through the WhatsApp Business Cloud API (Meta). Free for a business to set up; Meta charges per message beyond its free tier.',
    fields: [
      { key: 'notify_whatsapp_token', label: 'Access token', placeholder: 'EAAG… (a permanent System User token)', secret: true },
      { key: 'notify_whatsapp_phone_id', label: 'Phone number ID', placeholder: 'e.g. 106540352242922 (WhatsApp → API Setup)' },
      { key: 'notify_whatsapp_to', label: 'Send to', placeholder: '+44 7700 900123, +1 415 555 0100' },
      { key: 'notify_whatsapp_template', label: 'Message template (recommended)', placeholder: 'e.g. seo_alert — an approved template whose body has one {{1}}' },
      { key: 'notify_whatsapp_lang', label: 'Template language', placeholder: 'en (must match the template, e.g. en_GB)' },
    ],
    required: ['notify_whatsapp_token', 'notify_whatsapp_phone_id', 'notify_whatsapp_to'],
    steps: [
      { text: 'Create a Meta app of type Business and add the WhatsApp product.', href: 'https://developers.facebook.com/apps', linkLabel: 'Meta for Developers' },
      { text: 'WhatsApp → API Setup: add your business phone number (or use the test number) and copy its Phone number ID.' },
      { text: 'Business Settings → System users: add one, assign it the app with the whatsapp_business_messaging permission, and generate a token that never expires.', href: 'https://business.facebook.com/settings/system-users', linkLabel: 'System users' },
      { text: 'WhatsApp Manager → Message templates: create a Utility template whose body is e.g. "SEO alert: {{1}}" and wait for approval. Enter its name above. Without a template WhatsApp only delivers to people who have messaged your number in the last 24 hours.', href: 'https://business.facebook.com/wa/manage/message-templates/', linkLabel: 'Message templates' },
      { text: 'Recipients are full international numbers. Spaces and + are fine; separate numbers with commas.' },
    ],
  },
  {
    id: 'slack', name: 'Slack', icon: MessageSquare,
    blurb: 'Post alerts into a Slack channel via an Incoming Webhook. Links show as clickable text.',
    fields: [{ key: 'notify_slack_webhook', label: 'Incoming Webhook URL', placeholder: 'https://hooks.slack.com/services/…' }],
    required: ['notify_slack_webhook'],
    steps: [
      { text: 'Create a Slack app and add an Incoming Webhook, or use a legacy webhook.', href: 'https://api.slack.com/messaging/webhooks', linkLabel: 'Slack Incoming Webhooks' },
      { text: 'Pick the channel to post to and copy the webhook URL.' },
    ],
  },
  {
    id: 'discord', name: 'Discord', icon: MessageSquare,
    blurb: 'Post to a Discord channel via a channel webhook.',
    fields: [{ key: 'notify_discord_webhook', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…' }],
    required: ['notify_discord_webhook'],
    steps: [
      { text: 'Channel → Edit Channel → Integrations → Webhooks → New Webhook.' },
      { text: 'Copy the webhook URL.' },
    ],
  },
  {
    id: 'ntfy', name: 'ntfy', icon: Bell,
    blurb: 'Push to your phone or desktop via ntfy (self-hosted or ntfy.sh). Free, no account needed. Links become tappable buttons.',
    fields: [
      { key: 'notify_ntfy_topic', label: 'Topic', placeholder: 'my-seo-alerts (or a full https://…/topic URL)' },
      { key: 'notify_ntfy_server', label: 'Server', placeholder: 'https://ntfy.sh (default)' },
      { key: 'notify_ntfy_token', label: 'Access token (optional)', placeholder: 'tk_… for protected topics', secret: true },
    ],
    required: ['notify_ntfy_topic'],
    steps: [
      { text: 'Pick a hard-to-guess topic name and subscribe to it in the ntfy app.', href: 'https://ntfy.sh/', linkLabel: 'ntfy.sh' },
      { text: 'For a private or self-hosted server, set the server URL and an access token.' },
    ],
  },
  {
    id: 'telegram', name: 'Telegram', icon: Send,
    blurb: 'Message yourself or a group through a Telegram bot.',
    fields: [
      { key: 'notify_telegram_token', label: 'Bot token', placeholder: '123456:ABC-DEF…', secret: true },
      { key: 'notify_telegram_chat', label: 'Chat ID', placeholder: 'e.g. 123456789 or -100… for groups' },
    ],
    required: ['notify_telegram_token', 'notify_telegram_chat'],
    steps: [
      { text: 'Create a bot with @BotFather and copy its token.', href: 'https://t.me/BotFather', linkLabel: '@BotFather' },
      { text: 'Message your bot once, then get your chat id from https://api.telegram.org/bot<token>/getUpdates.' },
    ],
  },
  {
    id: 'webhook', name: 'Generic webhook', icon: Webhook,
    blurb: 'POST JSON to any endpoint (Zapier, Make, n8n, your own service). Slack, Discord and ntfy URLs here are still detected for backwards compatibility.',
    fields: [{ key: 'notify_webhook_url', label: 'Webhook URL', placeholder: 'https://example.com/hook' }],
    required: ['notify_webhook_url'],
    steps: [{ text: 'Your endpoint receives a POST with a JSON body: {"title": "…", "body": "…", "links": [{"label": "…", "url": "…"}], "event": "review_approvals"}.' }],
  },
];

const CHANNEL_LABEL: Record<NotifyChannel, string> = { email: 'Email', whatsapp: 'WhatsApp', slack: 'Slack', discord: 'Discord', ntfy: 'ntfy', telegram: 'Telegram', webhook: 'Webhook' };

interface EmailList { id: string; name: string; to: string; events: EventId[] | null }
type Routes = Partial<Record<NotifyChannel, EventId[]>>;

function parse<T>(value: string | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

const SIMPLE_KEYS = [...new Set([...NOTIFY_PROVIDERS.flatMap(p => p.fields.map(f => f.key)), ...ALL_EVENT_IDS.map(e => `notify_${e}`)])];

export function NotificationsTab() {
  const { active } = useWorkspace();
  const canManage = !!active?.permissions?.manage_notifications;
  const [vals, setVals] = useState<Record<string, string>>({});
  const [lists, setLists] = useState<EmailList[]>([]);
  const [routes, setRoutes] = useState<Routes>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<NotifyChannelResult[] | null>(null);
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);

  useEffect(() => {
    api.getNotifyConfig().then(rec => {
      const next: Record<string, string> = {};
      for (const k of SIMPLE_KEYS) next[k] = rec[k] ?? '';
      setVals(next);
      setLists(parse<EmailList[]>(rec.notify_email_lists, []));
      setRoutes(parse<Routes>(rec.notify_routes, {}));
      api.getNotificationDeliveries().then(setDeliveries).catch(() => setDeliveries([]));
    }).finally(() => setLoaded(true));
  }, [active?.id]);

  const touched = () => { setSaved(false); setError(''); };
  function set(key: string, v: string) { setVals(prev => ({ ...prev, [key]: v })); touched(); }
  const eventOn = (id: EventId) => vals[`notify_${id}`] !== 'false';

  async function save() {
    setSaving(true); setError('');
    try {
      await api.saveNotifyConfig({ ...vals, notify_email_lists: JSON.stringify(lists), notify_routes: JSON.stringify(routes) });
      setSaved(true); setTimeout(() => setSaved(false), 3000);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : 'Saving failed'); return false; }
    finally { setSaving(false); }
  }
  async function sendTest() {
    setTesting(true); setResults(null);
    try { if (await save()) { const r = await api.testNotifications(); setResults(r.results); setDeliveries(await api.getNotificationDeliveries()); } }
    finally { setTesting(false); }
  }

  const providerConfigured = (p: NotifyProvider) => p.id === 'email'
    ? !!vals.notify_email_to?.trim() || lists.some(l => l.to.trim())
    : p.required.every(k => !!vals[k]?.trim());
  const routable = NOTIFY_PROVIDERS.filter(p => providerConfigured(p) && (p.id !== 'email' || !!vals.notify_email_to?.trim()));

  function toggleRoute(channel: NotifyChannel, event: EventId) {
    setRoutes(prev => {
      const current = prev[channel] ?? ALL_EVENT_IDS;
      const next = current.includes(event) ? current.filter(e => e !== event) : [...current, event];
      const copy = { ...prev };
      if (ALL_EVENT_IDS.every(e => next.includes(e))) delete copy[channel];
      else copy[channel] = next;
      return copy;
    });
    touched();
  }
  const routeOn = (channel: NotifyChannel, event: EventId) => (routes[channel] ?? ALL_EVENT_IDS).includes(event);

  function updateList(index: number, patch: Partial<EmailList>) {
    setLists(prev => prev.map((l, i) => i === index ? { ...l, ...patch } : l));
    touched();
  }
  function addList() {
    setLists(prev => [...prev, { id: `list-${Date.now().toString(36)}`, name: '', to: '', events: ['review_approvals', 'ads_approvals'] }]);
    touched();
  }

  if (!loaded) return <div className="card"><div className="empty-note">Loading…</div></div>;

  return (
    <>
      <div className="card mb-4">
        <div className="card-title"><Bell size={13} /> Notifications{active ? ` — ${active.name}` : ''}</div>
        <p className="text-dim" style={{ fontSize: 12 }}>
          These channels belong to the <strong>{active?.name ?? 'current'}</strong> workspace — each workspace notifies its own places.
          Pick the events to send, set up one or more channels, and narrow what each channel gets in the grid at the bottom.
          {!canManage && <> <em>You can view these, but a workspace admin has revoked notification management for your role.</em></>}
        </p>
        <p className="notify-deeplink-note">
          <Link2 size={13} />
          <span>
            Messages about something waiting for a decision link straight to it, inside this workspace
            (<code>{workspacePath(active?.slug ?? 'workspace', '/approve/…')}</code>). Opening a link needs someone signed in with access to this workspace,
            so nothing can be approved from the message itself or by a forwarded email. Proposals that arrive together are gathered for a minute and sent as one message.
          </span>
        </p>
      </div>

      {EVENT_GROUPS.map(group => (
        <section key={group.title} className="mb-4">
          <h3 className="notify-group-title">{group.title}</h3>
          <div className="notification-events">
            {group.events.map(e => (
              <label key={e.id}>
                <input type="checkbox" checked={eventOn(e.id)} disabled={!canManage} onChange={ev => set(`notify_${e.id}`, ev.target.checked ? 'true' : 'false')} />
                <span><strong>{e.label}</strong><small>{e.description}</small></span>
              </label>
            ))}
          </div>
        </section>
      ))}

      <h3 className="notify-group-title">Channels</h3>
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
                <label className="input-label" htmlFor={`notify-${f.key}`}>{f.label}</label>
                <input
                  id={`notify-${f.key}`}
                  className="input"
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  placeholder={f.placeholder}
                  value={vals[f.key] ?? ''}
                  disabled={!canManage}
                  onChange={e => set(f.key, e.target.value)}
                />
              </div>
            ))}
            {p.id === 'email' && (
              <EmailLists lists={lists} canManage={canManage} onChange={updateList} onAdd={addList}
                onRemove={i => { setLists(prev => prev.filter((_, n) => n !== i)); touched(); }} />
            )}
            <ol className="key-guide-steps">
              {p.steps.map((s, i) => (
                <li key={i}>{s.text}{s.href && <> <a href={s.href} target="_blank" rel="noopener noreferrer" className="key-guide-link"><ExternalLink size={10} /> {s.linkLabel ?? s.href}</a></>}</li>
              ))}
            </ol>
          </div>
        </details>
      ))}

      <section className="card mt-3">
        <div className="card-title"><Route size={13} /> Where each event goes</div>
        <p className="text-dim" style={{ fontSize: 12, marginBottom: 10 }}>
          Every channel gets every event you've switched on, unless you untick it here — for example, send approvals to WhatsApp and leave run summaries to email.
          Email lists pick their own events above.
        </p>
        {routable.length === 0
          ? <div className="empty-note">Set up a channel above to choose what it receives.</div>
          : (
            <div className="table-wrap">
              <table className="table notify-routes">
                <thead>
                  <tr><th>Event</th>{routable.map(p => <th key={p.id}>{p.id === 'email' ? 'Email (default)' : CHANNEL_LABEL[p.id]}</th>)}</tr>
                </thead>
                <tbody>
                  {EVENTS.filter(e => eventOn(e.id)).map(e => (
                    <tr key={e.id}>
                      <td>{e.label}</td>
                      {routable.map(p => (
                        <td key={p.id}>
                          <input type="checkbox" aria-label={`${e.label} to ${CHANNEL_LABEL[p.id]}`} checked={routeOn(p.id, e.id)} disabled={!canManage} onChange={() => toggleRoute(p.id, e.id)} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <div className="flex items-center gap-3" style={{ marginTop: 14, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" disabled={saving || !canManage} onClick={() => { void save(); }}>
          {saving ? <><Loader2 className="spin" size={13} /> Saving…</> : saved ? <><Save size={13} /> Saved ✓</> : <><Save size={13} /> Save notifications</>}
        </button>
        <button className="btn btn-secondary" disabled={testing || !canManage} onClick={sendTest}>
          {testing ? <><Loader2 className="spin" size={13} /> Sending…</> : <><Send size={13} /> Save & send test</>}
        </button>
        {error && <span style={{ fontSize: 12, color: 'var(--error)' }}>{error}</span>}
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
                    <span className="member-name">{CHANNEL_LABEL[r.channel] ?? r.channel}</span>
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

      <div className="card mt-3">
        <div className="card-title"><Clock size={13} /> Recent deliveries</div>
        {deliveries.length === 0 ? <div className="empty-note">No notification attempts recorded for this workspace yet.</div> : (
          <div className="delivery-list">
            {deliveries.slice(0, 20).map(delivery => (
              <div key={delivery.id}>
                <span className={`delivery-status ${delivery.status}`} />
                <span><strong>{delivery.title}</strong><small>{delivery.event_type.replaceAll('_', ' ')} · {new Date(`${delivery.created_at}Z`).toLocaleString()}{delivery.error ? ` · ${delivery.error}` : ''}</small></span>
                <span className="badge">{delivery.channel}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function EmailLists({ lists, canManage, onChange, onAdd, onRemove }: {
  lists: EmailList[]; canManage: boolean;
  onChange: (index: number, patch: Partial<EmailList>) => void; onAdd: () => void; onRemove: (index: number) => void;
}) {
  return (
    <div className="notify-lists">
      <div className="notify-lists-head">
        <span><Users size={13} /> Email lists</span>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!canManage} onClick={onAdd}><Plus size={13} /> Add a list</button>
      </div>
      {lists.length === 0 && <p className="text-dim" style={{ fontSize: 12 }}>No lists yet. A list sends chosen events to its own people — for example Google Ads approvals to the paid-search team, review approvals to the account manager.</p>}
      {lists.map((list, i) => (
        <div key={list.id} className="notify-list">
          <div className="notify-list-row">
            <input className="input" aria-label="List name" placeholder="List name, e.g. Paid search team" value={list.name} disabled={!canManage} onChange={e => onChange(i, { name: e.target.value })} />
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${list.name || 'this list'}`} disabled={!canManage} onClick={() => onRemove(i)}><Trash2 size={13} /></button>
          </div>
          <input className="input" aria-label="List addresses" placeholder="ana@agency.com, ben@client.com" value={list.to} disabled={!canManage} onChange={e => onChange(i, { to: e.target.value })} />
          <label className="notify-list-all">
            <input type="checkbox" checked={list.events === null} disabled={!canManage} onChange={e => onChange(i, { events: e.target.checked ? null : [] })} />
            Every event
          </label>
          {list.events !== null && (
            <div className="notify-chips" role="group" aria-label={`Events for ${list.name || 'this list'}`}>
              {EVENTS.map(ev => {
                const on = list.events!.includes(ev.id);
                return (
                  <label key={ev.id} className={on ? 'on' : ''}>
                    <input type="checkbox" checked={on} disabled={!canManage}
                      onChange={() => onChange(i, { events: on ? list.events!.filter(x => x !== ev.id) : [...list.events!, ev.id] })} />
                    {ev.label}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
