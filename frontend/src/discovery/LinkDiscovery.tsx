import { useState } from 'react';
import { discovery } from './api';
interface Result {
  searched: number;
  checked: number;
  observed: number;
  reported: number;
  added: number;
  duplicates: number;
  monitored: number;
  sources: string[];
  warnings: string[];
  pages: Array<{ url: string; status: string; links: number }>;
}
export function LinkDiscovery({
  siteId,
  canEdit,
  monitor,
  onComplete,
  onBusy,
}: {
  siteId: string;
  canEdit: boolean;
  monitor: boolean;
  onComplete: () => Promise<void>;
  onBusy: (value: boolean) => void;
}) {
  const [query, setQuery] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<Result | null>(null);
  async function discover() {
    setBusy(true);
    onBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await discovery.post<Result>('links/discover', { site_id: siteId, query, monitor }));
      await onComplete();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <section className="discovery-panel">
      <h3>Find links online</h3>
      <p>
        Search for pages mentioning this website and inspect their links. Uses Brave Search when configured,
        otherwise public search, plus connected Bing Webmaster data and saved AI citation sources.
      </p>
      <div className="discovery-form">
        <label>
          Narrow the search (optional)
          <input
            value={query}
            maxLength={150}
            disabled={!canEdit || busy}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Publisher, topic or brand phrase"
          />
        </label>
      </div>
      <button className="btn btn-primary" disabled={!canEdit || busy} onClick={discover}>
        {busy
          ? 'Discovering and checking sources…'
          : monitor
            ? 'Discover backlinks'
            : 'Discover link candidates'}
      </button>
      {busy && <p role="status">Checking up to 12 source pages. This may take about a minute.</p>}
      {error && (
        <p role="alert" className="discovery-error">
          {error}
        </p>
      )}
      {result && (
        <div>
          <p role="status">
            {result.searched} source pages found · {result.checked} checked · {result.observed} link
            observations · {result.added} new candidates · {result.duplicates} already known
            {monitor ? ` · ${result.monitored} newly monitored` : ''}
          </p>
          <p>Sources: {result.sources.join(', ') || 'No provider returned results'}</p>
          {!!result.reported && (
            <p>
              {result.reported} pairs reported by Bing. Provider reports without a live observation remain
              unverified.
            </p>
          )}
          {result.warnings.map((w, i) => (
            <p className="discovery-note" key={i}>
              {w}
            </p>
          ))}
          <details>
            <summary>Source checks</summary>
            {result.pages.map((p) => (
              <article key={p.url}>
                <p>
                  <a href={p.url} target="_blank" rel="noreferrer">
                    {p.url}
                  </a>
                </p>
                <p>
                  {p.status} · {p.links} matching links
                </p>
              </article>
            ))}
          </details>
          {!result.added && !result.duplicates && (
            <p>
              No backlink pairs were found in this sample. Try a publisher or topic, or connect Brave
              Search/Bing Webmaster for another source. A search result alone is not proof of a backlink.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
