import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, ClipboardCheck, ExternalLink, Plus, RefreshCw, Save, Store, Trash2, X } from 'lucide-react';
import { useToast } from '../AppContext';
import { errorMessage } from '../ads/api';
import {
  DAY_LABEL, DAYS, reviewsApi, type Day, type HoursPeriod, type ProfileEdit, type ProfileOverview, type ReviewLocation, type SpecialHours,
} from './api';
import { changeOutcome } from './format';

const MAX_DESCRIPTION = 750;

/** Shared location picker for the Profile, Posts and Photos tabs. */
export function LocationPicker({ locations, location, onPick }: { locations: ReviewLocation[]; location: ReviewLocation; onPick: (id: string) => void }) {
  if (locations.length < 2) return null;
  return (
    <select className="input ads-account-select" aria-label="Location" value={location.id} onChange={e => onPick(e.target.value)}>
      {locations.map(l => <option key={l.id} value={l.id}>{l.title ?? l.location_name}</option>)}
    </select>
  );
}

export function BusinessProfileTab({ locations, locationId, canManage, onPick, reload }: {
  locations: ReviewLocation[]; locationId: string; canManage: boolean; onPick: (id: string) => void; reload: () => Promise<void>;
}) {
  const toast = useToast();
  const location = locations.find(l => l.id === locationId) ?? locations[0];
  const [overview, setOverview] = useState<ProfileOverview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback((fresh = false) => reviewsApi.profile(location.id, fresh)
    .then(o => { setOverview(o); setError(''); })
    .catch(e => { setOverview(null); setError(errorMessage(e)); }), [location.id]);
  useEffect(() => { void load(); }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    try { await fn(); toast('success', done); await Promise.all([load(true), reload()]); }
    catch (e) { toast('error', errorMessage(e)); }
    setBusy(null);
  }

  const updates = overview?.google_updates;
  const settleable = updates && Object.keys(updates.google).length > 0;

  return (
    <div className="ads-setup">
      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">Profile health</span><h2>{location.title ?? location.location_name}</h2></div>
          <div className="header-actions">
            <LocationPicker locations={locations} location={location} onPick={onPick} />
            <button className="btn btn-ghost btn-sm" disabled={busy === 'refresh'} onClick={() => { setBusy('refresh'); void load(true).finally(() => setBusy(null)); }}><RefreshCw size={13} /> Refresh</button>
          </div>
        </div>
        {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}
        {!overview && !error && <div className="page-loading">Reading the profile from Google…</div>}
        {overview && (
          <>
            <div className="gbp-score"><strong>{overview.checklist.score}%</strong><span>complete and up to date</span></div>
            <ul className="gbp-checklist">
              {overview.checklist.items.map(item => (
                <li key={item.id} className={item.status}>
                  {item.status === 'done' ? <CheckCircle2 size={16} /> : item.status === 'warn' ? <AlertTriangle size={16} /> : <Circle size={16} />}
                  <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                </li>
              ))}
            </ul>
            {(overview.photos_error || overview.posts_error) && <p className="ads-hint">{overview.photos_error ?? overview.posts_error}</p>}
          </>
        )}
      </section>

      {overview && (updates?.fields.length || updates?.pending.length) ? (
        <section className="ops-card gbp-google-updates">
          <div className="ops-card-head"><div><span className="eyebrow">Google-suggested edits</span><h2>Google shows something different</h2></div><AlertTriangle size={18} /></div>
          {!!updates.fields.length && <p className="card-intro">Google (or someone using "Suggest an edit") changed the {updates.fields.join(', ')}. Google shows its version until you settle it.</p>}
          {!!updates.pending.length && <p className="ads-hint">Your own edits to the {updates.pending.join(', ')} are still waiting for Google to publish them.</p>}
          {settleable && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Field</th><th>Your version</th><th>Google's version</th></tr></thead>
                <tbody>
                  {updates.google.description !== undefined && <tr><td>Description</td><td><small>{overview.profile.description || '—'}</small></td><td><small>{updates.google.description || '—'}</small></td></tr>}
                  {updates.google.primary_phone !== undefined && <tr><td>Phone</td><td>{overview.profile.primary_phone ?? '—'}</td><td>{updates.google.primary_phone ?? '—'}</td></tr>}
                  {updates.google.website !== undefined && <tr><td>Website</td><td>{overview.profile.website ?? '—'}</td><td>{updates.google.website ?? '—'}</td></tr>}
                  {updates.google.regular_hours && <tr><td>Opening hours</td><td><small>{hoursText(overview.profile.regular_hours)}</small></td><td><small>{hoursText(updates.google.regular_hours)}</small></td></tr>}
                  {updates.google.special_hours && <tr><td>Special hours</td><td><small>{overview.profile.special_hours.map(s => s.date).join(', ') || '—'}</small></td><td><small>{updates.google.special_hours.map(s => s.date).join(', ') || '—'}</small></td></tr>}
                </tbody>
              </table>
            </div>
          )}
          <div className="ads-row-actions">
            {settleable && <button className="btn btn-primary btn-sm" disabled={!canManage || !!busy} onClick={() => run('mine', () => reviewsApi.resolveGoogleUpdates(location.id, 'mine'), 'Your version was sent back to Google')}>Keep my version</button>}
            {settleable && <button className="btn btn-secondary btn-sm" disabled={!canManage || !!busy} onClick={() => run('google', () => reviewsApi.resolveGoogleUpdates(location.id, 'google'), 'Google\'s version accepted')}>Accept Google's version</button>}
            <a className="btn btn-ghost btn-sm" href="https://business.google.com/locations" target="_blank" rel="noreferrer"><ExternalLink size={13} /> Business Profile Manager</a>
            <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => run('check', () => reviewsApi.checkGoogleUpdates(location.id), 'Checked with Google')}><RefreshCw size={13} /> Check again</button>
          </div>
          {!settleable && <p className="ads-hint">Name, category and address changes can only be settled in Business Profile Manager.</p>}
        </section>
      ) : null}

      {overview && <ProfileEditor key={location.id} location={location} overview={overview} canManage={canManage} onSaved={async () => { await Promise.all([load(true), reload()]); }} />}

      {overview && !!overview.pending_changes.length && (
        <section className="ops-card">
          <div className="ops-card-head"><div><span className="eyebrow">Waiting for approval</span><h2>Changes an AI assistant proposed</h2></div><ClipboardCheck size={18} /></div>
          <p className="card-intro">Approve or reject them on the Approvals tab.</p>
          <ul className="gbp-pending">{overview.pending_changes.map(c => <li key={c.id}><strong>{c.kind.replace('_', ' ')}</strong> {c.summary}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

function hoursText(periods: HoursPeriod[]): string {
  if (!periods.length) return 'Closed every day';
  return DAYS.map(d => {
    const day = periods.filter(p => p.day === d);
    return day.length ? `${DAY_LABEL[d].slice(0, 3)} ${day.map(p => (p.open === '00:00' && p.close === '24:00' ? '24 hours' : `${p.open}–${p.close}`)).join(', ')}` : null;
  }).filter(Boolean).join(' · ');
}

function ProfileEditor({ location, overview, canManage, onSaved }: { location: ReviewLocation; overview: ProfileOverview; canManage: boolean; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const p = overview.profile;
  const [description, setDescription] = useState(p.description);
  const [phone, setPhone] = useState(p.primary_phone ?? '');
  const [website, setWebsite] = useState(p.website ?? '');
  const [hours, setHours] = useState<HoursPeriod[]>(p.regular_hours);
  const [special, setSpecial] = useState<SpecialHours[]>(p.special_hours);
  const [busy, setBusy] = useState(false);

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const edit: ProfileEdit = {
    ...(description !== p.description ? { description } : {}),
    ...(phone.trim() && phone !== (p.primary_phone ?? '') ? { primary_phone: phone } : {}),
    ...(website.trim() && website !== (p.website ?? '') ? { website } : {}),
    ...(!same(hours, p.regular_hours) ? { regular_hours: hours } : {}),
    ...(!same(special, p.special_hours) ? { special_hours: special } : {}),
  };
  const dirty = Object.keys(edit).length > 0;

  async function save() {
    setBusy(true);
    try {
      const change = await reviewsApi.editProfile(location.id, edit);
      toast(change.status === 'published' ? 'success' : 'warning', changeOutcome(change));
      await onSaved();
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(false);
  }

  const setPeriod = (index: number, patch: Partial<HoursPeriod>) => setHours(list => list.map((h, i) => (i === index ? { ...h, ...patch } : h)));

  return (
    <section className="ops-card">
      <div className="ops-card-head"><div><span className="eyebrow">Business information</span><h2>Edit the profile</h2></div><Store size={18} /></div>
      <p className="card-intro">
        {p.primary_category ? `${p.primary_category}${p.additional_categories.length ? `, ${p.additional_categories.join(', ')}` : ''}. ` : ''}
        {p.address ?? (p.service_area.length ? `Serves ${p.service_area.join(', ')}.` : '')}
        {' '}Name, categories and address are edited in Business Profile Manager, because Google may ask you to verify again.
      </p>
      <fieldset className="reviews-fieldset" disabled={!canManage}>
        <legend>Contact</legend>
        <label>Phone number<input className="input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+44 113 496 0000" /></label>
        <label>Website<input className="input" type="url" value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://" /></label>
        <label className="reviews-wide">Description <small className="text-dim">{description.length} / {MAX_DESCRIPTION}</small>
          <textarea className="input" rows={5} maxLength={MAX_DESCRIPTION} value={description} onChange={e => setDescription(e.target.value)} placeholder="What the business does, where, and what makes it different. No links." />
        </label>
      </fieldset>
      <fieldset className="reviews-fieldset" disabled={!canManage}>
        <legend>Opening hours</legend>
        <div className="gbp-hours reviews-wide">
          {DAYS.map(day => {
            const rows = hours.map((h, i) => ({ h, i })).filter(r => r.h.day === day);
            return (
              <div key={day} className="gbp-hours-day">
                <strong>{DAY_LABEL[day]}</strong>
                <div>
                  {rows.map(({ h, i }) => (
                    <span key={i} className="gbp-hours-period">
                      <input className="input" aria-label={`${DAY_LABEL[day]} opens`} value={h.open} onChange={e => setPeriod(i, { open: e.target.value })} placeholder="09:00" />
                      <span>to</span>
                      <input className="input" aria-label={`${DAY_LABEL[day]} closes`} value={h.close} onChange={e => setPeriod(i, { close: e.target.value })} placeholder="17:00" />
                      <button type="button" className="btn-icon btn-icon-ghost" aria-label={`Remove ${DAY_LABEL[day]} period`} onClick={() => setHours(list => list.filter((_, j) => j !== i))}><X size={13} /></button>
                    </span>
                  ))}
                  {!rows.length && <small className="text-dim">Closed</small>}
                  {rows.length < 3 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHours(list => [...list, { day: day as Day, open: '09:00', close: '17:00' }])}><Plus size={12} /> Add hours</button>}
                </div>
              </div>
            );
          })}
          <small className="text-dim">24-hour times. A closing time before the opening time runs past midnight; 00:00 to 24:00 is open all day.</small>
        </div>
      </fieldset>
      <fieldset className="reviews-fieldset" disabled={!canManage}>
        <legend>Special and holiday hours</legend>
        <div className="gbp-special reviews-wide">
          {special.map((s, i) => (
            <div key={i} className="gbp-special-row">
              <input className="input" type="date" aria-label="Date" value={s.date} onChange={e => setSpecial(list => list.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
              <label className="ads-inline-check"><input type="checkbox" checked={s.closed} onChange={e => setSpecial(list => list.map((x, j) => (j === i ? { ...x, closed: e.target.checked, open: e.target.checked ? undefined : x.open ?? '10:00', close: e.target.checked ? undefined : x.close ?? '16:00' } : x)))} /> Closed</label>
              {!s.closed && <>
                <input className="input" aria-label="Opens" value={s.open ?? ''} onChange={e => setSpecial(list => list.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))} placeholder="10:00" />
                <span>to</span>
                <input className="input" aria-label="Closes" value={s.close ?? ''} onChange={e => setSpecial(list => list.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))} placeholder="16:00" />
              </>}
              <button type="button" className="btn-icon btn-icon-ghost" aria-label="Remove date" onClick={() => setSpecial(list => list.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSpecial(list => [...list, { date: new Date().toISOString().slice(0, 10), closed: true }])}><Plus size={12} /> Add a date</button>
        </div>
      </fieldset>
      <div className="ads-row-actions">
        <button className="btn btn-ghost" disabled={!dirty || busy} onClick={() => { setDescription(p.description); setPhone(p.primary_phone ?? ''); setWebsite(p.website ?? ''); setHours(p.regular_hours); setSpecial(p.special_hours); }}>Undo changes</button>
        <button className="btn btn-primary" disabled={!canManage || !dirty || busy} onClick={save}><Save size={14} /> {busy ? 'Saving…' : 'Save to Google'}</button>
      </div>
    </section>
  );
}
