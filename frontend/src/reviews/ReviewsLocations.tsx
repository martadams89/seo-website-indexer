import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Link2, MapPin, Pencil, RefreshCw, ShieldCheck, Star, Trash2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useToast } from '../AppContext';
import { errorMessage } from '../ads/api';
import { AI_MODE_LABEL, MODE_LABEL, reviewsApi, type AiMode, type ConnectionStatus, type DiscoveryResult, type ProfileRules, type ReplyRules, type ReviewBrief, type ReviewLocation } from './api';
import { connectionLabel } from './format';

export function ReviewsLocations({ locations, connections, canManage, reload, onOpen }: {
  locations: ReviewLocation[]; connections: ConnectionStatus[]; canManage: boolean; reload: (fresh?: boolean) => Promise<void>; onOpen: (id: string) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<ReviewLocation | null>(null);
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function sync(l: ReviewLocation) {
    setBusy(l.id);
    try {
      const r = await reviewsApi.sync(l.id);
      toast('success', `Synced ${r.fetched} review${r.fetched === 1 ? '' : 's'}${r.created ? `, ${r.created} new` : ''}`);
      await reload();
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(null);
  }

  async function unlink(l: ReviewLocation) {
    if (!window.confirm(`Unlink ${l.title ?? l.location_name}? Its synced reviews and reply history are removed from this app (nothing changes on Google).`)) return;
    try { await reviewsApi.unlink(l.id); toast('success', 'Location unlinked'); await reload(); }
    catch (e) { toast('error', errorMessage(e)); }
  }

  return (
    <section className="ops-card">
      <div className="ops-card-head">
        <div><span className="eyebrow">Locations</span><h2>Linked Business Profiles</h2></div>
        <button className="btn btn-primary btn-sm" disabled={!canManage} onClick={() => setLinking(true)}><Link2 size={13} /> Link locations</button>
      </div>
      <p className="card-intro">Each location has its own rules for what an AI assistant may publish on its own (replies, posts, photos and profile edits), a brief that shapes how replies sound, and the Google connection it uses. People on this dashboard always publish directly.</p>
      {locations.length ? (
        <div className="reviews-location-list">
          {locations.map(l => (
            <article key={l.id} className={l.enabled ? '' : 'paused'}>
              <div className="reviews-location-main">
                <strong>{l.title ?? l.location_name}</strong>
                <small>{l.address ?? l.location_name}</small>
                <div className="ads-badges">
                  {l.average_rating !== null && <span className="badge badge-info"><Star size={11} /> {l.average_rating.toFixed(1)} · {l.total_reviews ?? 0} reviews</span>}
                  <span className={`badge badge-${l.rules.mode === 'read_only' ? 'info' : l.rules.mode === 'review' ? 'warn' : 'ok'}`}><ShieldCheck size={11} /> {MODE_LABEL[l.rules.mode]}{l.rules.mode === 'guarded' ? ` (${l.rules.auto_min_rating}★+)` : ''}</span>
                  {l.stats.unreplied > 0 && <span className="badge badge-accent">{l.stats.unreplied} unanswered</span>}
                  {l.stats.awaiting_approval > 0 && <span className="badge badge-warn">{l.stats.awaiting_approval} awaiting approval</span>}
                  {l.stats.changes_awaiting_approval > 0 && <span className="badge badge-warn">{l.stats.changes_awaiting_approval} profile change{l.stats.changes_awaiting_approval === 1 ? '' : 's'} waiting</span>}
                  {!l.enabled && <span className="badge badge-info">Paused</span>}
                </div>
                {(() => {
                  const conn = connections.find(c => c.id === l.google_account_id);
                  return <small className="text-dim">Google connection: {conn ? connectionLabel(conn) : l.google_account_id ?? 'none (pick one in settings)'}</small>;
                })()}
                {l.last_error && <small className="ads-error-line">{l.last_error}</small>}
              </div>
              <div className="ads-cell-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => onOpen(l.id)}>Reviews</button>
                <button className="btn-icon btn-icon-ghost" aria-label={`Sync ${l.title ?? 'location'} now`} disabled={busy === l.id} onClick={() => sync(l)}><RefreshCw size={13} className={busy === l.id ? 'spin' : undefined} /></button>
                {l.maps_uri && <a className="btn-icon btn-icon-ghost" href={l.maps_uri} target="_blank" rel="noreferrer" aria-label="Open in Google Maps"><ExternalLink size={13} /></a>}
                <button className="btn-icon btn-icon-ghost" aria-label={`Edit ${l.title ?? 'location'}`} onClick={() => setEditing(l)}><Pencil size={13} /></button>
                <button className="btn-icon btn-icon-ghost" aria-label={`Unlink ${l.title ?? 'location'}`} disabled={!canManage} onClick={() => unlink(l)}><Trash2 size={13} /></button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="ops-empty compact"><MapPin /><strong>No locations linked</strong><span>Link the Business Profiles you manage to start.</span></div>
      )}
      {editing && <LocationSettingsModal location={editing} connections={connections} canManage={canManage} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(true); }} />}
      {linking && <LinkLocationsModal onClose={() => setLinking(false)} onLinked={async () => { setLinking(false); await reload(true); }} />}
    </section>
  );
}

/** Find every location the connected Google users manage and link the chosen ones. */
/** Pick Business Profile locations to link; `googleAccountId` limits it to one connection (for example one just signed in). */
export function LinkLocationsModal({ onClose, onLinked, googleAccountId, description }: {
  onClose: () => void; onLinked: () => void | Promise<void>; googleAccountId?: string; description?: string;
}) {
  const toast = useToast();
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(true);
  const [selected, setSelected] = useState<Record<string, { googleAccountId: string; accountName: string }>>({});
  const [busy, setBusy] = useState(false);

  const scan = useCallback(() => reviewsApi.discover(googleAccountId)
    .then(next => { setResult(next); setError(''); })
    .catch(e => setError(errorMessage(e)))
    .finally(() => setScanning(false)), [googleAccountId]);
  useEffect(() => { void scan(); }, [scan]);

  async function link() {
    setBusy(true);
    let ok = 0;
    for (const [locationName, choice] of Object.entries(selected)) {
      try { await reviewsApi.link({ locationName, ...choice }); ok++; }
      catch (e) { toast('error', `${locationName}: ${errorMessage(e)}`); }
    }
    setBusy(false);
    if (ok) { toast('success', `Linked ${ok} location${ok === 1 ? '' : 's'} and imported their reviews.`); await onLinked(); }
  }

  async function moveHere(locationId: string, googleAccountId: string) {
    setBusy(true);
    try { await reviewsApi.update(locationId, { googleAccountId }); toast('success', 'Location now uses this connection'); await scan(); await onLinked(); }
    catch (e) { toast('error', errorMessage(e)); }
    setBusy(false);
  }

  const count = Object.keys(selected).length;
  return (
    <Modal onClose={onClose} size="lg" title="Link Business Profile locations" eyebrow="Google reviews" icon={<Link2 />}
      description={description ?? 'Locations the connected Google users own or manage.'}
      footer={<>
        <button className="btn btn-ghost" disabled={scanning} onClick={() => { setScanning(true); setError(''); void scan(); }}><RefreshCw size={13} /> {scanning && result ? 'Scanning…' : 'Scan again'}</button>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!count || busy} onClick={link}>{busy ? 'Linking…' : `Link ${count || ''} location${count === 1 ? '' : 's'}`}</button>
      </>}>
      {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}
      {!result && scanning && <div className="page-loading">Asking Google which Business Profiles you manage…</div>}
      {result?.connections.map(conn => (
        <div key={conn.google_account_id} className="ads-discovery-group">
          <h3>{conn.email ?? conn.google_account_id}</h3>
          {conn.error && <p className="ads-hint">{conn.error}{conn.hint ? ` — ${conn.hint}` : ''}</p>}
          {conn.accounts.map(acc => (
            <div key={acc.account_name}>
              <small className="reviews-account-title">{acc.account_title}</small>
              {acc.error && <p className="ads-hint">{acc.error}</p>}
              {acc.locations.map(loc => {
                const linked = !!loc.linked_location_id;
                const checked = !!selected[loc.location_name];
                return (
                  <label key={loc.location_name} className={`ads-discovery-row ${linked ? 'linked' : ''}`}>
                    <input type="checkbox" disabled={linked} checked={linked || checked} onChange={e => setSelected(current => {
                      const next = { ...current };
                      if (e.target.checked) next[loc.location_name] = { googleAccountId: conn.google_account_id, accountName: acc.account_name };
                      else delete next[loc.location_name];
                      return next;
                    })} />
                    <span>
                      <strong>{loc.title ?? loc.location_name}</strong>
                      <small>{[loc.address, loc.website].filter(Boolean).join(' · ')}{loc.verified === false ? ' · not verified (replies are refused until it is)' : ''}{linked ? (loc.linked_via === conn.google_account_id ? ' · linked through this connection' : ' · linked through another connection') : ''}</small>
                    </span>
                    {linked && loc.linked_via !== conn.google_account_id && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={e => { e.preventDefault(); void moveHere(loc.linked_location_id!, conn.google_account_id); }}>Use this connection</button>
                    )}
                  </label>
                );
              })}
              {!acc.locations.length && !acc.error && <p className="ads-hint">No locations in this account.</p>}
            </div>
          ))}
          {!conn.accounts.length && !conn.error && <p className="ads-hint">No Business Profile accounts found for this Google user.</p>}
        </div>
      ))}
    </Modal>
  );
}

const linesOf = (value: string) => value.split(/\n/).map(s => s.trim()).filter(Boolean);

function LocationSettingsModal({ location, connections, canManage, onClose, onSaved }: { location: ReviewLocation; connections: ConnectionStatus[]; canManage: boolean; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const toast = useToast();
  const [rules, setRules] = useState<ReplyRules>(location.rules);
  const [profileRules, setProfileRules] = useState<ProfileRules>(location.profile_rules);
  const [connectionId, setConnectionId] = useState(location.google_account_id ?? '');
  const choices = connections.filter(c => c.has_business_scope);
  const [brief, setBrief] = useState<ReviewBrief>(location.brief);
  const [banned, setBanned] = useState(location.rules.banned_phrases.join('\n'));
  const [enabled, setEnabled] = useState(location.enabled);
  const [busy, setBusy] = useState(false);
  const field = (key: keyof ReviewBrief) => ({ value: brief[key] ?? '', onChange: (e: { target: { value: string } }) => setBrief(b => ({ ...b, [key]: e.target.value })) });

  async function save() {
    setBusy(true);
    try {
      await reviewsApi.update(location.id, {
        rules: { ...rules, banned_phrases: linesOf(banned) }, profileRules, brief, enabled,
        ...(connectionId && connectionId !== location.google_account_id ? { googleAccountId: connectionId } : {}),
      });
      toast('success', 'Location saved');
      await onSaved();
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(false);
  }

  return (
    <Modal onClose={onClose} size="lg" title={location.title ?? location.location_name} eyebrow="Location settings" icon={<Star />}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!canManage || busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <fieldset className="reviews-fieldset" disabled={!canManage}>
        <legend>Google connection</legend>
        <label className="reviews-wide">Read and manage this profile through
          <select className="input" value={connectionId} onChange={e => setConnectionId(e.target.value)}>
            {!connectionId && <option value="">Choose a connection</option>}
            {choices.map(c => <option key={c.id} value={c.id}>{connectionLabel(c)}{c.api === 'not_approved' ? ' — waiting for Google approval' : ''}</option>)}
          </select>
        </label>
        <small className="text-dim reviews-wide">Switch to another Google user, or the same user through another Cloud project (for example the one Google approved for Business Profile). The app checks the new connection can see this location first; reviews, rules and history stay.</small>
      </fieldset>
      <fieldset className="reviews-fieldset" disabled={!canManage}>
        <legend>What AI assistants may publish without you</legend>
        <label>Mode
          <select className="input" value={rules.mode} onChange={e => setRules(r => ({ ...r, mode: e.target.value as ReplyRules['mode'] }))}>
            {(['guarded', 'review', 'autopilot', 'read_only'] as const).map(m => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
        </label>
        {rules.mode === 'guarded' && (
          <label>Auto-publish replies to reviews rated at least
            <select className="input" value={rules.auto_min_rating} onChange={e => setRules(r => ({ ...r, auto_min_rating: Number(e.target.value) }))}>
              {[5, 4, 3, 2, 1].map(n => <option key={n} value={n}>{n} star{n === 1 ? '' : 's'}</option>)}
            </select>
          </label>
        )}
        <label>Longest reply without approval (characters)
          <input className="input" type="number" min={50} max={4000} value={rules.max_length} onChange={e => setRules(r => ({ ...r, max_length: Number(e.target.value) }))} />
        </label>
        <label>Alert me about new reviews rated
          <select className="input" value={rules.alert_max_rating} onChange={e => setRules(r => ({ ...r, alert_max_rating: Number(e.target.value) }))}>
            <option value={0}>Never</option>
            {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n === 5 ? 'Any rating' : `${n} star${n === 1 ? '' : 's'} or fewer`}</option>)}
          </select>
        </label>
        <div className="reviews-checks">
          <label className="ads-inline-check"><input type="checkbox" checked={rules.allow_links} onChange={e => setRules(r => ({ ...r, allow_links: e.target.checked }))} /> Allow links</label>
          <label className="ads-inline-check"><input type="checkbox" checked={rules.allow_contact_details} onChange={e => setRules(r => ({ ...r, allow_contact_details: e.target.checked }))} /> Allow phone numbers and emails</label>
          <label className="ads-inline-check"><input type="checkbox" checked={rules.allow_replace_existing} onChange={e => setRules(r => ({ ...r, allow_replace_existing: e.target.checked }))} /> Allow replacing a published reply</label>
          <label className="ads-inline-check"><input type="checkbox" checked={rules.allow_delete} onChange={e => setRules(r => ({ ...r, allow_delete: e.target.checked }))} /> Allow deleting a published reply</label>
          <label className="ads-inline-check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Sync this location</label>
        </div>
        <label className="reviews-wide">Phrases that always need approval (one per line)
          <textarea className="input" rows={3} value={banned} onChange={e => setBanned(e.target.value)} placeholder={'refund\ncompensation'} />
        </label>
      </fieldset>
      <fieldset className="reviews-fieldset" disabled={!canManage}>
        <legend>Profile, posts and photos from AI assistants</legend>
        {([['profile', 'Profile edits (description and hours)'], ['posts', 'New posts'], ['photos', 'New photos']] as const).map(([key, label]) => (
          <label key={key}>{label}
            <select className="input" value={profileRules[key]} onChange={e => setProfileRules(r => ({ ...r, [key]: e.target.value as AiMode }))}>
              {(['approval', 'auto', 'auto_all', 'off'] as const).map(m => <option key={m} value={m}>{AI_MODE_LABEL[m]}</option>)}
            </select>
          </label>
        ))}
        <div className="reviews-checks">
          <label className="ads-inline-check"><input type="checkbox" checked={profileRules.alert_google_updates} onChange={e => setProfileRules(r => ({ ...r, alert_google_updates: e.target.checked }))} /> Alert me when Google changes the profile</label>
        </div>
        <small className="text-dim reviews-wide"><b>Publish within the checks</b> still holds phone and website changes, offers, deletions and new logo, cover or profile photos for approval. <b>Publish everything</b> approves those automatically too; only text that still looks like a template (for example [NAME]) waits.</small>
      </fieldset>
      <fieldset className="reviews-fieldset" disabled={!canManage}>
        <legend>How replies should sound</legend>
        <label>Business name<input className="input" {...field('business_name')} /></label>
        <label>Sign off as<input className="input" {...field('sign_off')} placeholder="Dave and the Acme team" /></label>
        <label className="reviews-wide">Voice<textarea className="input" rows={2} {...field('brand_voice')} placeholder="Warm, plain English, no exclamation marks" /></label>
        <label className="reviews-wide">Where unhappy customers should go<input className="input" {...field('contact_for_issues')} placeholder="hello@acme.example or 0113 000 0000" /></label>
        <label>Language<input className="input" {...field('language')} placeholder="Match the reviewer" /></label>
        <label className="reviews-wide">Never<textarea className="input" rows={2} {...field('never_do')} placeholder="Mention prices, blame staff, discuss insurance claims" /></label>
        <label className="reviews-wide">Notes<textarea className="input" rows={2} {...field('notes')} /></label>
      </fieldset>
    </Modal>
  );
}
