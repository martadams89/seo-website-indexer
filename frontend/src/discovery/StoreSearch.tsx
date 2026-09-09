import { useState } from 'react';
import { discovery, type ListingDraft } from './api';
interface StoreApp {
  id: string;
  name: string;
  publisher: string;
  url: string;
  platform: 'apple' | 'google';
}
export function StoreSearch({
  canEdit,
  onUse,
  onBusy,
}: {
  canEdit: boolean;
  onUse: (draft: ListingDraft) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [platform, setPlatform] = useState('apple'),
    [country, setCountry] = useState('GB'),
    [language, setLanguage] = useState('en'),
    [query, setQuery] = useState('');
  const [rows, setRows] = useState<StoreApp[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [searched, setSearched] = useState(false);
  const [preview, setPreview] = useState<{
    app: StoreApp;
    draft: ListingDraft;
    unavailable: string[];
    note: string;
  } | null>(null);
  async function run(id?: string) {
    setBusy(true);
    onBusy(true);
    setError('');
    setPreview(null);
    try {
      if (id) setPreview(await discovery.post('stores/lookup', { platform, id, country, language }));
      else {
        setRows(await discovery.post('stores/search', { platform, query, country, language }));
        setSearched(true);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  function reset() {
    setRows([]);
    setSearched(false);
    setPreview(null);
  }
  return (
    <details className="discovery-panel" open>
      <summary>Find your app in the stores</summary>
      <div className="discovery-filters">
        <label>
          Store
          <select
            disabled={busy || !canEdit}
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value);
              reset();
            }}
          >
            <option value="apple">Apple App Store</option>
            <option value="google">Google Play</option>
          </select>
        </label>
        <label>
          Storefront country
          <input
            value={country}
            maxLength={2}
            disabled={busy || !canEdit}
            onChange={(e) => {
              setCountry(e.target.value.toUpperCase());
              reset();
            }}
          />
        </label>
        <label>
          Listing language
          <input
            value={language}
            maxLength={6}
            disabled={busy || !canEdit || platform === 'apple'}
            onChange={(e) => {
              setLanguage(e.target.value);
              reset();
            }}
          />
        </label>
        <label>
          Search app or publisher
          <input
            value={query}
            disabled={busy || !canEdit}
            onChange={(e) => {
              setQuery(e.target.value);
              reset();
            }}
            placeholder="Search by app or publisher name"
          />
        </label>
      </div>
      <button
        className="btn btn-primary"
        disabled={busy || !canEdit || query.trim().length < 2 || country.length !== 2}
        onClick={() => run()}
      >
        {busy ? 'Searching store…' : 'Search store'}
      </button>
      {error && (
        <p role="alert" className="discovery-error">
          {error}
        </p>
      )}
      {rows.map((row) => (
        <article key={row.id} className="discovery-panel">
          <h3>{row.name}</h3>
          <p>
            {row.publisher} · {row.id}
          </p>
          <div className="discovery-actions">
            <button className="btn btn-secondary" disabled={busy || !canEdit} onClick={() => run(row.id)}>
              Preview listing
            </button>
            <a href={row.url} target="_blank" rel="noreferrer">
              Open store page ↗
            </a>
          </div>
        </article>
      ))}
      {searched && !rows.length && !busy && <p>No apps returned for this search and storefront.</p>}
      {preview && (
        <div className="discovery-panel">
          <h3>{preview.app.name}</h3>
          <p>{preview.note}</p>
          {!!preview.unavailable.length && (
            <p>Not returned: {preview.unavailable.join(', ')}. These fields need your review.</p>
          )}
          <p>{preview.draft.subtitle}</p>
          <pre className="store-description-preview">{preview.draft.description}</pre>
          <button
            className="btn btn-primary"
            disabled={!canEdit || busy}
            onClick={() => onUse(preview.draft)}
          >
            Use listing as new draft
          </button>
        </div>
      )}
    </details>
  );
}
