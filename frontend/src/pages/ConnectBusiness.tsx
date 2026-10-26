/**
 * The page a client opens from an agency's connect link (/connect/<token>),
 * outside the sign-in gate: they sign in with their own Google account
 * (through the agency's approved Cloud project, Business Profile access only)
 * and choose which of their Business Profiles to share.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, Loader2, MapPin, ShieldCheck, Store } from 'lucide-react';
import { connectApi, type ConnectLinkInfo, type ConnectLocation } from '../connect/api';
import '../connect/connect.css';

const key = (l: Pick<ConnectLocation, 'account_name' | 'location_name'>) => `${l.account_name}|${l.location_name}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ConnectBusinessPage() {
  const token = useParams().token ?? '';
  const [info, setInfo] = useState<ConnectLinkInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [locations, setLocations] = useState<ConnectLocation[] | null>(null);
  const [listError, setListError] = useState<{ error: string; hint: string | null } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ shared: string[]; errors: Array<{ location: string; error: string }> } | null>(null);

  const loadLocations = useCallback(() => connectApi.locations(token).then(r => {
    setLocations(r.locations);
    setListError(r.error ? { error: r.error, hint: r.hint } : null);
    // One profile: tick it; several: let them choose.
    const open = r.locations.filter(l => !l.shared);
    if (open.length === 1) setPicked(new Set([key(open[0])]));
  }, e => setListError({ error: message(e), hint: null })), [token]);

  useEffect(() => {
    connectApi.info(token).then(next => {
      setInfo(next);
      if (next.can_pick) void loadLocations();
    }, e => setError(message(e)));
  }, [token, loadLocations]);

  async function start() {
    setBusy(true); setError('');
    try { window.location.assign((await connectApi.start(token)).authorizationUrl); }
    catch (e) { setError(message(e)); setBusy(false); }
  }

  async function share() {
    setBusy(true); setError('');
    try {
      const chosen = (locations ?? []).filter(l => picked.has(key(l))).map(l => ({ accountName: l.account_name, locationName: l.location_name }));
      const r = await connectApi.share(token, chosen);
      setResult(r);
      setPicked(new Set());
      await loadLocations();
    } catch (e) { setError(message(e)); }
    setBusy(false);
  }

  const who = info ? `${info.from}${info.workspace ? ` (${info.workspace})` : ''}` : '';
  const toggle = (l: ConnectLocation) => setPicked(prev => { const next = new Set(prev); if (next.has(key(l))) next.delete(key(l)); else next.add(key(l)); return next; });

  return (
    <div className="auth-screen">
      <div className="auth-card connect-card">
        <div className="auth-logo"><Store size={22} /></div>
        {!info && !error && <Loader2 className="spin" size={22} />}
        {!info && error && (
          <>
            <h1 className="auth-title">This link doesn't work</h1>
            <p className="auth-sub">{error}</p>
          </>
        )}

        {info && (info.status === 'expired' || info.status === 'revoked') && (
          <>
            <h1 className="auth-title">This link {info.status === 'expired' ? 'has expired' : 'was cancelled'}</h1>
            <p className="auth-sub">Ask {who} for a new one.</p>
          </>
        )}

        {info?.status === 'open' && (
          <>
            <h1 className="auth-title">Connect your Google Business Profile</h1>
            <p className="auth-sub">{who} would like to help manage {info.client_name ? <strong>{info.client_name}</strong> : 'your business'} on Google.</p>
            <ul className="connect-what">
              <li>Reply to your Google reviews</li>
              <li>Keep your details, opening hours and holiday hours up to date</li>
              <li>Publish posts and photos, and see how your profile performs</li>
            </ul>
            <p className="connect-note">
              You'll sign in with Google and then choose which of your profiles to share. Pick the Google account you use for your Business Profile
              (the one you use at business.google.com). Google only asks for Business Profile access and your email address.
            </p>
            <button className="btn btn-primary connect-cta" disabled={busy} onClick={start}>{busy ? <Loader2 className="spin" size={14} /> : null} Connect with Google</button>
            <p className="connect-fine"><ShieldCheck size={12} /> You can remove access at any time in your Google Account, under Security → Your connections to third-party apps.</p>
          </>
        )}

        {info?.status === 'connected' && !info.can_pick && (
          <>
            <h1 className="auth-title">This link has been used</h1>
            <p className="auth-sub">If that was you, open the link in the browser you signed in to Google with. Otherwise ask {who} for a new link.</p>
          </>
        )}

        {info?.status === 'connected' && info.can_pick && (
          <>
            <h1 className="auth-title">Choose the profiles to share</h1>
            <p className="auth-sub">Signed in as <strong>{info.connected_email}</strong>. {who} can manage the profiles you share.</p>
            {result && result.shared.length > 0 && (
              <div className="alert alert-ok"><div className="alert-content"><CheckCircle2 size={14} /> Shared {result.shared.join(', ')}. You can close this page, or share more below.</div></div>
            )}
            {result?.errors.map(e => <div key={e.location} className="alert alert-error"><div className="alert-content">{e.location}: {e.error}</div></div>)}
            {listError && <div className="alert alert-warn"><div className="alert-content">{listError.error}{listError.hint ? ` ${listError.hint}` : ''}</div></div>}
            {!locations && !listError && <Loader2 className="spin" size={18} />}
            {locations && locations.length === 0 && !listError && (
              <p className="connect-note">No Business Profiles were found for {info.connected_email}. If you manage your profile with a different Google account, sign in again and choose that one.</p>
            )}
            {locations && locations.length > 0 && (
              <div className="connect-locations" role="group" aria-label="Your Business Profiles">
                {locations.map(l => (
                  <label key={key(l)} className={l.shared ? 'shared' : picked.has(key(l)) ? 'on' : ''}>
                    <input type="checkbox" checked={l.shared || picked.has(key(l))} disabled={l.shared || busy} onChange={() => toggle(l)} />
                    <span>
                      <strong>{l.title ?? l.location_name}</strong>
                      <small><MapPin size={11} /> {l.address ?? l.account_title}{l.shared ? ' · shared' : ''}</small>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {locations && locations.some(l => !l.shared) && (
              <button className="btn btn-primary connect-cta" disabled={busy || picked.size === 0} onClick={share}>
                {busy ? <Loader2 className="spin" size={14} /> : null} Share {picked.size || ''} profile{picked.size === 1 ? '' : 's'}
              </button>
            )}
            {info.can_start && (
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={start}>Use a different Google account</button>
            )}
          </>
        )}

        {info && error && <p className="connect-error">{error}</p>}
      </div>
    </div>
  );
}
