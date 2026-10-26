import { useCallback, useEffect, useState } from 'react';
import { Eye, ImagePlus, Images, RefreshCw, Trash2 } from 'lucide-react';
import { useToast } from '../AppContext';
import { errorMessage } from '../ads/api';
import { PHOTO_CATEGORIES, reviewsApi, type BusinessPhoto, type ReviewLocation } from './api';
import { LocationPicker } from './BusinessProfileTab';
import { changeOutcome } from './format';

const label = (category: string) => category.charAt(0) + category.slice(1).toLowerCase().replace(/_/g, ' ');

export function BusinessPhotosTab({ locations, locationId, canManage, onPick, reload }: {
  locations: ReviewLocation[]; locationId: string; canManage: boolean; onPick: (id: string) => void; reload: () => Promise<void>;
}) {
  const toast = useToast();
  const location = locations.find(l => l.id === locationId) ?? locations[0];
  const [data, setData] = useState<{ total: number; photos: BusinessPhoto[] } | null>(null);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState<string>('ADDITIONAL');
  const [description, setDescription] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback((fresh = false) => reviewsApi.photos(location.id, fresh)
    .then(d => { setData(d); setError(''); })
    .catch(e => { setData(null); setError(errorMessage(e)); }), [location.id]);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    setBusy('add');
    try {
      const change = await reviewsApi.addPhoto(location.id, { url: url.trim(), category, ...(description.trim() ? { description: description.trim() } : {}) });
      toast(change.status === 'published' ? 'success' : 'warning', `${changeOutcome(change)}. Google checks new photos before showing them.`);
      setUrl(''); setDescription('');
      await Promise.all([load(true), reload()]);
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(null);
  }

  async function remove(photo: BusinessPhoto) {
    if (!window.confirm('Delete this photo from the Business Profile?')) return;
    setBusy(photo.name);
    try { const change = await reviewsApi.deletePhoto(location.id, photo.name); toast('success', changeOutcome(change)); await load(true); }
    catch (e) { toast('error', errorMessage(e)); }
    setBusy(null);
  }

  const categories = [...new Set((data?.photos ?? []).map(p => p.category))];
  const shown = (data?.photos ?? []).filter(p => !filter || p.category === filter);

  return (
    <div className="ads-setup">
      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">Add a photo</span><h2>Photos for {location.title ?? 'the profile'}</h2></div>
          <LocationPicker locations={locations} location={location} onPick={onPick} />
        </div>
        <p className="card-intro">Google downloads the photo from a public address: JPG or PNG, at least 250 × 250 pixels (720 × 720 or larger looks best). Profiles with recent photos get more calls and direction requests.</p>
        <fieldset className="reviews-fieldset" disabled={!canManage}>
          <label className="reviews-wide">Image address<input className="input" type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/photos/team.jpg" /></label>
          <label>Category
            <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
              {PHOTO_CATEGORIES.map(c => <option key={c} value={c}>{label(c)}</option>)}
            </select>
          </label>
          <label>Description (optional)<input className="input" maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></label>
        </fieldset>
        <div className="ads-row-actions">
          <button className="btn btn-primary" disabled={!canManage || busy === 'add' || !/^https?:\/\//.test(url.trim())} onClick={add}><ImagePlus size={14} /> {busy === 'add' ? 'Adding…' : 'Add to Google'}</button>
        </div>
      </section>

      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow">On the profile</span><h2>{data ? `${data.total} photo${data.total === 1 ? '' : 's'}` : 'Photos'}</h2></div>
          <div className="header-actions">
            {categories.length > 1 && (
              <select className="input ads-account-select" aria-label="Category" value={filter} onChange={e => setFilter(e.target.value)}>
                <option value="">All categories</option>
                {categories.map(c => <option key={c} value={c}>{label(c)}</option>)}
              </select>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => void load(true)}><RefreshCw size={13} /> Refresh</button>
          </div>
        </div>
        {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}
        {!data && !error && <div className="page-loading">Loading photos…</div>}
        {data && !data.photos.length && <div className="ops-empty compact"><Images /><strong>No photos yet</strong><span>Add photos of the premises, team and work.</span></div>}
        <div className="gbp-photo-grid">
          {shown.map(photo => (
            <figure key={photo.name}>
              {photo.thumbnail ? <a href={photo.url ?? photo.thumbnail} target="_blank" rel="noreferrer"><img src={photo.thumbnail} alt={photo.description ?? label(photo.category)} loading="lazy" /></a> : <div className="gbp-photo-placeholder"><Images /></div>}
              <figcaption>
                <span className="badge badge-info">{label(photo.category)}</span>
                {photo.views !== null && <small><Eye size={11} /> {photo.views.toLocaleString()}</small>}
                <button className="btn-icon btn-icon-ghost" aria-label="Delete photo" disabled={!canManage || busy === photo.name} onClick={() => remove(photo)}><Trash2 size={13} /></button>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
    </div>
  );
}
