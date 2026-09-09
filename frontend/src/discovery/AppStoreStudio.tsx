import { StoreSearch } from './StoreSearch';
import { useUnsavedChanges } from './useUnsavedChanges';
import { useEffect, useState } from 'react';
import { Save, Plus, Download, Smartphone } from 'lucide-react';
import { discovery, type AppListing, type ListingDraft, type ListingAnalysis } from './api';
import { saveBlob } from '../utils/download';
import { exportJson } from './WebsiteAudit';
const blank = (): ListingDraft => ({
  platform: 'apple',
  locale: 'en-GB',
  name: '',
  subtitle: '',
  description: '',
  keywords: '',
  promotional_text: '',
  target_terms: [],
});
export function AppStoreStudio({
  siteId,
  canEdit,
  setBusy,
}: {
  siteId: string;
  canEdit: boolean;
  setBusy: (value: boolean) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const confirmDiscard = useUnsavedChanges(dirty);
  const [storeFilter, setStoreFilter] = useState('all');
  const [listingSearch, setListingSearch] = useState('');
  const [listings, setListings] = useState<AppListing[]>([]);
  const [id, setId] = useState('');
  const [draft, setDraft] = useState<ListingDraft>(blank);
  const [terms, setTerms] = useState('');
  const [analysis, setAnalysis] = useState<ListingAnalysis | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState<Array<{ id: number; draft: ListingDraft; observed_at: string }>>([]);
  useEffect(() => {
    const c = new AbortController();
    discovery
      .get<AppListing[]>('listings', c.signal)
      .then(setListings)
      .catch((e) => {
        if (!c.signal.aborted) setError(String(e));
      });
    return () => c.abort();
  }, []);
  function open(row?: AppListing) {
    if (!confirmDiscard()) return;
    setDirty(false);
    setId(row?.id ?? '');
    setDraft(row?.draft ?? blank());
    setTerms(row?.draft.target_terms.join('\n') ?? '');
    setAnalysis(row?.analysis ?? null);
    setHistory([]);
    setSaved(false);
  }
  function change(field: keyof ListingDraft, value: string) {
    setDirty(true);
    setDraft((d) => ({ ...d, [field]: value }));
    setAnalysis(null);
    setSaved(false);
  }
  async function save() {
    setSaving(true);
    setBusy(true);
    setError('');
    try {
      const row = await discovery.post<AppListing>('listings', {
        ...(id ? { id } : {}),
        site_id: siteId || null,
        draft: {
          ...draft,
          target_terms: terms
            .split('\n')
            .map((t) => t.trim())
            .filter(Boolean),
        },
      });
      setListings((previous) => [row, ...previous.filter((r) => r.id !== row.id)]);
      setId(row.id);
      setAnalysis(row.analysis);
      setDirty(false);
      setSaved(true);
      setHistory([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
      setBusy(false);
    }
  }
  const fields: Array<{
    key: 'name' | 'subtitle' | 'description' | 'keywords' | 'promotional_text';
    label: string;
    limit: number;
    multiline?: boolean;
  }> = [
    { key: 'name', label: 'App name', limit: 30 },
    {
      key: 'subtitle',
      label: draft.platform === 'apple' ? 'Subtitle' : 'Short description',
      limit: draft.platform === 'apple' ? 30 : 80,
    },
    { key: 'description', label: 'Description', limit: 4000, multiline: true },
    ...(draft.platform === 'apple'
      ? [
          { key: 'keywords' as const, label: 'Keywords (comma-separated)', limit: 100 },
          { key: 'promotional_text' as const, label: 'Promotional text', limit: 170 },
        ]
      : []),
  ];
  return (
    <section>
      <header className="discovery-section-heading">
        <div>
          <h2>App store studio</h2>
          <p>Shape a clear listing, check metadata and keep a history of your revisions.</p>
        </div>
        <button className="btn btn-secondary" disabled={saving} onClick={() => open()}>
          <Plus size={16} />
          New draft
        </button>
      </header>
      <StoreSearch
        canEdit={canEdit && !saving}
        onBusy={setBusy}
        onUse={(listing) => {
          if (!confirmDiscard()) return;
          setId('');
          setDraft(listing);
          setTerms('');
          setAnalysis(null);
          setHistory([]);
          setDirty(true);
          setSaved(false);
        }}
      />
      {draft.source_url && (
        <p className="discovery-note">
          Imported from {draft.source_url} ·{' '}
          {draft.fetched_at ? new Date(draft.fetched_at).toLocaleString() : 'Date not supplied'}. Review and
          save the draft below.
        </p>
      )}
      {error && (
        <p role="alert" className="discovery-error">
          {error}
        </p>
      )}
      <div className="discovery-studio">
        <aside className="discovery-panel">
          <h3>Saved listings</h3>
          <select
            aria-label="Filter saved listings by store"
            value={storeFilter}
            onChange={(e) => setStoreFilter(e.target.value)}
          >
            <option value="all">Both stores</option>
            <option value="apple">App Store</option>
            <option value="google">Google Play</option>
          </select>
          <input
            aria-label="Find saved listings"
            placeholder="Find a listing…"
            value={listingSearch}
            onChange={(e) => setListingSearch(e.target.value)}
          />
          {listings
            .filter(
              (r) =>
                (storeFilter === 'all' || r.draft.platform === storeFilter) &&
                (!siteId || r.site_id === siteId || !r.site_id) &&
                `${r.draft.name} ${r.draft.locale}`.toLowerCase().includes(listingSearch.toLowerCase()),
            )
            .map((r) => (
              <button
                className={`discovery-saved ${id === r.id ? 'active' : ''}`}
                disabled={saving}
                key={r.id}
                onClick={() => open(r)}
              >
                <Smartphone size={17} />
                <span>
                  <strong>{r.draft.name || 'Untitled draft'}</strong>
                  <small>
                    {r.draft.platform === 'apple' ? 'App Store' : 'Google Play'} · {r.draft.locale}
                  </small>
                </span>
              </button>
            ))}
          {!listings.length && <p>Your first saved listing will appear here.</p>}
        </aside>
        <div className="discovery-panel">
          <div className="discovery-filters">
            <label>
              Store
              <select
                disabled={!canEdit || saving}
                value={draft.platform}
                onChange={(e) => change('platform', e.target.value)}
              >
                <option value="apple">Apple App Store</option>
                <option value="google">Google Play</option>
              </select>
            </label>
            <label>
              Locale
              <input
                disabled={!canEdit || saving}
                value={draft.locale}
                onChange={(e) => change('locale', e.target.value)}
                placeholder="en-GB"
              />
            </label>
          </div>
          <label className="discovery-file">
            Import a draft JSON file
            <input
              type="file"
              accept="application/json,.json"
              disabled={!canEdit || saving}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file || !confirmDiscard()) return;
                try {
                  if (file.size > 100000) throw new Error('Use a draft file smaller than 100 KB.');
                  const value = JSON.parse(await file.text()) as ListingDraft;
                  if (
                    !['apple', 'google'].includes(value.platform) ||
                    !['locale', 'name', 'subtitle', 'description', 'keywords', 'promotional_text'].every(
                      (k) => typeof value[k as keyof ListingDraft] === 'string',
                    ) ||
                    !Array.isArray(value.target_terms) ||
                    value.target_terms.some((t) => typeof t !== 'string')
                  )
                    throw new Error('Invalid listing draft format.');
                  setDirty(true);
                  setId('');
                  setDraft(value);
                  setTerms(value.target_terms.join('\n'));
                  setAnalysis(null);
                  setSaved(false);
                  setError('');
                } catch (error) {
                  setError(String(error));
                }
              }}
            />
          </label>
          <div className="discovery-form" onChangeCapture={() => setDirty(true)}>
            {fields.map(({ key, label, limit, multiline }) => (
              <label key={key}>
                <span className="discovery-row">
                  <strong>{label}</strong>
                  <span className={Array.from(draft[key]).length > limit ? 'discovery-error-text' : ''}>
                    {Array.from(draft[key]).length} / {limit}
                  </span>
                </span>
                {multiline ? (
                  <textarea
                    aria-label={label}
                    aria-invalid={Array.from(draft[key]).length > limit}
                    rows={8}
                    disabled={!canEdit || saving}
                    value={draft[key]}
                    onChange={(e) => change(key, e.target.value)}
                  />
                ) : (
                  <input
                    aria-label={label}
                    aria-invalid={Array.from(draft[key]).length > limit}
                    disabled={!canEdit || saving}
                    value={draft[key]}
                    onChange={(e) => change(key, e.target.value)}
                  />
                )}
              </label>
            ))}
            <label>
              <strong>Target terms (one per line, up to 30)</strong>
              <textarea
                rows={3}
                disabled={!canEdit || saving}
                value={terms}
                onChange={(e) => {
                  setTerms(e.target.value);
                  setAnalysis(null);
                  setSaved(false);
                }}
                placeholder="property inspection\ndamp survey"
              />
            </label>
          </div>
          <div className="discovery-actions">
            <button disabled={!canEdit || saving} className="btn btn-primary" onClick={save}>
              <Save size={15} />
              {saving ? 'Saving…' : 'Save & audit draft'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() =>
                exportJson(
                  { ...draft, target_terms: terms.split('\n').filter(Boolean) },
                  'app-listing-draft.json',
                )
              }
            >
              <Download size={15} />
              Export draft
            </button>
            <button
              className="btn btn-secondary"
              onClick={() =>
                saveBlob(
                  new Blob(
                    [
                      `Store: ${draft.platform}\nLocale: ${draft.locale}\n\n${fields.map((f) => `${f.label}\n${draft[f.key]}`).join('\n\n')}`,
                    ],
                    { type: 'text/plain' },
                  ),
                  'app-listing.txt',
                )
              }
            >
              Export text
            </button>
            {id && (
              <button
                className="btn btn-secondary"
                disabled={!canEdit || saving}
                onClick={() => {
                  setDirty(true);
                  setId('');
                  setHistory([]);
                  setSaved(false);
                }}
              >
                Duplicate draft
              </button>
            )}
            {id && (
              <button
                className="btn btn-secondary"
                disabled={!canEdit || saving}
                onClick={() => {
                  setDirty(true);
                  setId('');
                  setDraft((d) => ({ ...d, locale: '' }));
                  setHistory([]);
                  setAnalysis(null);
                  setSaved(false);
                }}
              >
                Create locale variant
              </button>
            )}
            {id && (
              <button
                className="btn btn-secondary"
                disabled={!canEdit || saving}
                onClick={() => {
                  setDirty(true);
                  setId('');
                  setDraft((d) => ({ ...d, platform: d.platform === 'apple' ? 'google' : 'apple' }));
                  setHistory([]);
                  setAnalysis(null);
                  setSaved(false);
                }}
              >
                Adapt for other store
              </button>
            )}
            {id && (
              <button
                className="btn btn-secondary"
                onClick={() =>
                  discovery
                    .get<typeof history>(`listings/${id}/history`)
                    .then(setHistory)
                    .catch((e) => setError(String(e)))
                }
              >
                Revision history
              </button>
            )}
          </div>
          {saved && (
            <p className="discovery-note" role="status">
              Draft and audit saved. Nothing has been published to the store.
            </p>
          )}
          {!!history.length && (
            <details open className="discovery-panel">
              <summary>Saved revisions ({history.length})</summary>
              {history.map((r) => (
                <div key={r.id} className="discovery-revision">
                  <details>
                    <summary>Compare with editor</summary>
                    {fields
                      .filter((f) => r.draft[f.key] !== draft[f.key])
                      .map((f) => (
                        <div key={f.key}>
                          <strong>{f.label}</strong>
                          <p>Saved: {r.draft[f.key] || '(empty)'}</p>
                          <p>Editor: {draft[f.key] || '(empty)'}</p>
                        </div>
                      ))}
                  </details>
                  <span>
                    {new Date(r.observed_at).toLocaleString()} · {r.draft.name}
                  </span>
                  <button
                    className="btn btn-ghost"
                    disabled={!canEdit || saving}
                    onClick={() => {
                      if (!confirmDiscard()) return;
                      setDirty(true);
                      setDraft(r.draft);
                      setTerms(r.draft.target_terms.join('\n'));
                      setAnalysis(null);
                      setSaved(false);
                    }}
                  >
                    Load into editor
                  </button>
                </div>
              ))}
            </details>
          )}
        </div>
        <aside className="discovery-panel">
          <h3>Listing preview</h3>
          <div className="discovery-store-preview">
            <div className="discovery-app-icon">
              <Smartphone size={28} />
            </div>
            <h3>{draft.name || 'Your app name'}</h3>
            <p>{draft.subtitle || 'Explain the value in one clear sentence.'}</p>
            <span className="discovery-badge">{draft.locale} · Draft preview</span>
          </div>
          <p>Text preview only. Store layouts, screenshots and truncation vary by device.</p>
          {analysis ? (
            <>
              <h3>Draft findings</h3>
              {analysis.findings.map((f, i) => (
                <div key={i} className="discovery-insight">
                  <strong>{f.title}</strong>
                  <p>{f.detail}</p>
                </div>
              ))}
              {!analysis.findings.length && (
                <p>
                  Metadata checks passed. Review accuracy, screenshots and store policies before publishing.
                </p>
              )}
              <h3>Term coverage</h3>
              {analysis.terms.some((t) => !t.fields.length) && (
                <div className="discovery-insight">
                  <strong>Relevant terms to review</strong>
                  <p>
                    {analysis.terms
                      .filter((t) => !t.fields.length)
                      .map((t) => t.term)
                      .join(', ')}
                  </p>
                  <small>
                    Use these only when they accurately describe the product. Coverage is not a target
                    density.
                  </small>
                </div>
              )}
              {analysis.terms.map((t) => (
                <p key={t.term}>
                  <strong>{t.term}</strong>
                  <br />
                  {t.fields.length ? t.fields.join(', ') : 'Not found in checked fields'}
                </p>
              ))}
              <details>
                <summary>Methodology</summary>
                <p>{analysis.methodology}</p>
                <a href={analysis.source} target="_blank" rel="noreferrer">
                  Official listing guidance ↗
                </a>
              </details>
            </>
          ) : (
            <p>Save the draft to check field limits and target-term coverage.</p>
          )}
        </aside>
      </div>
    </section>
  );
}
