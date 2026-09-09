import { CrawlComparison } from './CrawlComparison';
import { useUnsavedChanges } from './useUnsavedChanges';
import { exportCsv } from './export';
import { useEffect, useState } from 'react';
import { discovery } from './api';
export type CrawlCandidate = {
  id: string;
  source_url: string;
  target_url: string;
  anchor: string;
  crawl_date: string | null;
  provenance: string;
  imported_at: string;
  state: string;
  notes: string;
};
type ImportResult = {
  added: number;
  duplicates: number;
  skipped: number;
  records: number;
  preview: boolean;
  rejected: Array<{ line: number; reason: string }>;
};
export function CrawlCandidates({
  siteId,
  canEdit,
  setBusy,
}: {
  siteId: string;
  canEdit: boolean;
  setBusy: (v: boolean) => void;
}) {
  const [history, setHistory] = useState<
    Array<{ id: string; provenance: string; imported_at: string; summary: ImportResult }>
  >([]);
  const [age, setAge] = useState('all');
  const [page, setPage] = useState(0);
  const [ageReference, setAgeReference] = useState(() => Date.now());
  const [domain, setDomain] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState('pending');
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [rows, setRows] = useState<CrawlCandidate[]>([]);
  const [text, setText] = useState('');
  const [provenance, setProvenance] = useState('');
  const [busy, working] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  useEffect(() => {
    const c = new AbortController();
    discovery
      .get<CrawlCandidate[]>(`candidates?site_id=${encodeURIComponent(siteId)}`, c.signal)
      .then(setRows)
      .catch((e) => {
        if (!c.signal.aborted) setError(String(e));
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [siteId]);
  async function refresh() {
    setRows(await discovery.get<CrawlCandidate[]>(`candidates?site_id=${encodeURIComponent(siteId)}`));
  }
  async function ingest(preview: boolean) {
    working(true);
    setBusy(true);
    setError('');
    try {
      setResult(
        await discovery.post<ImportResult>('candidates/import', {
          site_id: siteId,
          text,
          provenance,
          preview,
        }),
      );
      if (!preview) await refresh();
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      working(false);
      setBusy(false);
    }
  }
  async function review(id: string, action: string) {
    working(true);
    setBusy(true);
    setError('');
    try {
      await discovery.post(`candidates/${id}/review`, { site_id: siteId, action });
      await refresh();
      setMessage(
        action === 'work' ? 'Investigation task is in the Work queue.' : 'Candidate review updated.',
      );
    } catch (e) {
      setError(String(e));
    } finally {
      working(false);
      setBusy(false);
    }
  }
  async function bulk(action: string) {
    working(true);
    setBusy(true);
    setError('');
    try {
      const results = await discovery.post<Array<{ id: string; ok: boolean; error?: string }>>(
        'candidates/bulk',
        { site_id: siteId, ids: selected, action },
      );
      setMessage(
        `${results.filter((r) => r.ok).length} updated; ${results.filter((r) => !r.ok).length} failed.`,
      );
      setError(
        results
          .filter((r) => !r.ok)
          .map((r) => r.error)
          .join(' · '),
      );
      setSelected(results.filter((r) => !r.ok).map((r) => r.id));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      working(false);
      setBusy(false);
    }
  }
  const visible = rows.filter(
    (row) =>
      (age === 'all' ||
        (age === 'unknown'
          ? !row.crawl_date
          : !!row.crawl_date &&
            (age === 'recent'
              ? ageReference - Date.parse(row.crawl_date) <= 180 * 86400000
              : ageReference - Date.parse(row.crawl_date) > 180 * 86400000))) &&
      (!domain || new URL(row.source_url).hostname === domain) &&
      (state === 'all' || row.state === state) &&
      `${row.source_url} ${row.target_url} ${row.anchor} ${row.provenance} ${row.notes}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <section>
      <header className="discovery-section-heading">
        <div>
          <h2>Backlink candidates</h2>
          <p>Discover potential links in public-crawl extracts, then review their source pages.</p>
        </div>
      </header>
      <p className="discovery-note">
        Crawl evidence is historical, not a live backlink. Import a bounded Common Crawl WAT JSON extract or
        normalised NDJSON. This tool does not search the whole web or download entire crawl archives.
      </p>
      {error && (
        <p role="alert" className="discovery-error">
          {error}
        </p>
      )}
      <details className="discovery-panel" open={!rows.length}>
        <summary>Import public-crawl metadata</summary>
        <div className="discovery-form">
          <label>
            Extract source and crawl release
            <input
              maxLength={200}
              disabled={!canEdit || busy}
              value={provenance}
              onChange={(e) => {
                setProvenance(e.target.value);
                setResult(null);
              }}
              placeholder="Common Crawl CC-MAIN-2026-34 · selected WAT records"
            />
          </label>
          <label>
            Load NDJSON
            <input
              type="file"
              accept=".ndjson,.jsonl,application/x-ndjson"
              disabled={!canEdit || busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                try {
                  if (file.size > 500000) throw new Error('Use an extract up to 500 KB.');
                  setText(await file.text());
                  setResult(null);
                  setError('');
                } catch (e) {
                  setError(String(e));
                }
              }}
            />
          </label>
          <label>
            Crawl records
            <textarea
              rows={6}
              value={text}
              disabled={!canEdit || busy}
              onChange={(e) => {
                setText(e.target.value);
                setResult(null);
              }}
            />
          </label>
        </div>
        <div className="discovery-actions">
          <button
            className="btn btn-secondary"
            disabled={!canEdit || busy || !text.trim() || !provenance.trim()}
            onClick={() => ingest(true)}
          >
            Preview candidates
          </button>
          <button
            className="btn btn-primary"
            disabled={!canEdit || busy || !text.trim() || !provenance.trim()}
            onClick={() => ingest(false)}
          >
            Import candidates
          </button>
        </div>
        <p>
          Up to 500 records, 500 candidates and 500 KB per import; 20,000 examined links. No network requests
          are made during import.
        </p>
        <a href="https://commoncrawl.org/get-started" target="_blank" rel="noreferrer">
          Common Crawl data formats ↗
        </a>
        {result && (
          <div role="status">
            <p>
              {result.preview ? 'Preview only' : 'Imported'}: {result.added} new, {result.duplicates}{' '}
              duplicates, {result.rejected.length} rejected records, {result.skipped} skipped records or
              links.
            </p>
            {result.rejected.map((r) => (
              <p key={r.line}>
                Line {r.line}: {r.reason}
              </p>
            ))}
          </div>
        )}
      </details>
      <div className="discovery-filters">
        <label>
          Find candidates
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelected([]);
              setPage(0);
            }}
            placeholder="Source, target, anchor, notes or crawl release"
          />
        </label>
        <label>
          Crawl age
          <select
            value={age}
            onChange={(e) => {
              setAge(e.target.value);
              setAgeReference(Date.now());
              setSelected([]);
              setPage(0);
            }}
          >
            <option value="all">All crawl dates</option>
            <option value="recent">Within 180 days</option>
            <option value="old">Older than 180 days</option>
            <option value="unknown">Unknown date</option>
          </select>
        </label>
        <label>
          Review state
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setSelected([]);
              setPage(0);
            }}
          >
            {['pending', 'promoted', 'dismissed', 'all'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      <p>{visible.length} matching candidates · showing up to 50 per page</p>
      <div className="discovery-actions">
        <button
          className="btn btn-secondary"
          disabled={busy || page === 0}
          onClick={() => {
            setPage((p) => p - 1);
            setSelected([]);
          }}
        >
          Previous candidates
        </button>
        <span>
          Page {Math.min(page + 1, Math.max(1, Math.ceil(visible.length / 50)))} of{' '}
          {Math.max(1, Math.ceil(visible.length / 50))}
        </span>
        <button
          className="btn btn-secondary"
          disabled={busy || (page + 1) * 50 >= visible.length}
          onClick={() => {
            setPage((p) => p + 1);
            setSelected([]);
          }}
        >
          Next candidates
        </button>
      </div>
      <button
        className="btn btn-secondary"
        disabled={!visible.length}
        onClick={() =>
          exportCsv(
            [
              [
                'source_url',
                'target_url',
                'historical_anchor',
                'crawl_date',
                'provenance',
                'review_state',
                'notes',
              ],
              ...visible.map((r) => [
                r.source_url,
                r.target_url,
                r.anchor,
                r.crawl_date,
                r.provenance,
                r.state,
                r.notes,
              ]),
            ],
            'crawl-candidates.csv',
          )
        }
      >
        Export filtered candidates
      </button>
      <details className="discovery-panel">
        <summary>Referring-host opportunities</summary>
        <p>
          Counts describe imported candidate pairs, not link quality or authority. All review states are
          included.
        </p>
        <button
          className="btn btn-secondary"
          onClick={() => {
            setDomain('');
            setSelected([]);
            setPage(0);
          }}
        >
          All source hosts
        </button>
        {Object.entries(
          rows.reduce<Record<string, number>>((counts, row) => {
            const host = new URL(row.source_url).hostname;
            counts[host] = (counts[host] || 0) + 1;
            return counts;
          }, {}),
        )
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 100)
          .map(([host, count]) => (
            <button
              key={host}
              className="discovery-saved"
              aria-pressed={domain === host}
              onClick={() => {
                setDomain(host);
                setSelected([]);
                setPage(0);
              }}
            >
              {host} · {count}
            </button>
          ))}
      </details>
      {domain && <p>Filtering source host: {domain}</p>}
      <CrawlComparison siteId={siteId} />
      <details className="discovery-panel">
        <summary>Import history</summary>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() =>
            discovery
              .get<typeof history>(`candidates/imports?site_id=${encodeURIComponent(siteId)}`)
              .then(setHistory)
              .catch((e) => setError(String(e)))
          }
        >
          Load last 30 imports
        </button>
        {history.map((h) => (
          <article key={h.id}>
            <h3>{h.provenance}</h3>
            <p>
              {new Date(h.imported_at).toLocaleString()} · {h.summary.added} new · {h.summary.duplicates}{' '}
              duplicates · {h.summary.rejected.length} rejected records
            </p>
          </article>
        ))}
      </details>
      <p>
        {rows.length} / 5,000 candidates retained. Candidates stay separate from monitored backlinks.
        Promotion adds an unverified source and preserves existing live checks.
      </p>
      <a className="btn btn-secondary" href={`/discovery?tab=backlinks&site=${encodeURIComponent(siteId)}`}>
        Open backlink monitor
      </a>
      {loading && <p role="status">Loading candidates…</p>}
      <div className="discovery-actions">
        <button
          className="btn btn-secondary"
          disabled={!canEdit || busy || !selected.length}
          onClick={() => bulk('promote')}
        >
          Monitor selected ({selected.length}/50)
        </button>
        <button
          className="btn btn-secondary"
          disabled={!canEdit || busy || !selected.length}
          onClick={() => bulk('dismissed')}
        >
          Dismiss selected
        </button>
        <button className="btn btn-ghost" onClick={() => setSelected([])} disabled={busy || !selected.length}>
          Clear selection
        </button>
      </div>
      <p role="status">{message}</p>
      <div className="discovery-opportunities">
        {visible
          .slice(
            Math.min(page, Math.max(0, Math.ceil(visible.length / 50) - 1)) * 50,
            (Math.min(page, Math.max(0, Math.ceil(visible.length / 50) - 1)) + 1) * 50,
          )
          .map((row) => (
            <article className="discovery-panel" key={row.id}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`Select ${row.source_url}`}
                  disabled={
                    !canEdit ||
                    busy ||
                    row.state !== 'pending' ||
                    (!selected.includes(row.id) && selected.length >= 50)
                  }
                  checked={selected.includes(row.id)}
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked ? [...ids, row.id] : ids.filter((id) => id !== row.id),
                    )
                  }
                />{' '}
                Select candidate
              </label>
              <span className="discovery-badge">{row.state}</span>
              <h3>{row.source_url}</h3>
              <p>Target: {row.target_url}</p>
              <p>Historical anchor: {row.anchor || 'Not supplied'}</p>
              <p>Crawled: {row.crawl_date ? new Date(row.crawl_date).toLocaleDateString() : 'Unknown'}</p>
              <p>Source: {row.provenance}</p>
              <CandidateNotes
                row={row}
                canEdit={canEdit && !busy}
                onSaved={(notes) =>
                  setRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, notes } : r)))
                }
              />
              <div className="discovery-actions">
                <button
                  className="btn btn-secondary"
                  disabled={!canEdit || busy}
                  onClick={() => review(row.id, 'work')}
                >
                  Create investigation task
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!canEdit || busy || row.state !== 'pending'}
                  onClick={() => review(row.id, 'promote')}
                >
                  Add to backlink monitor
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={!canEdit || busy || row.state === 'promoted'}
                  onClick={() => review(row.id, row.state === 'dismissed' ? 'pending' : 'dismissed')}
                >
                  {row.state === 'dismissed' ? 'Restore to inbox' : 'Dismiss candidate'}
                </button>
              </div>
            </article>
          ))}
      </div>
      {!loading && !visible.length && (
        <p className="discovery-empty">
          No candidates to display. Import an extract containing external anchor links to this site.
        </p>
      )}
    </section>
  );
}

function CandidateNotes({
  row,
  canEdit,
  onSaved,
}: {
  row: CrawlCandidate;
  canEdit: boolean;
  onSaved: (notes: string) => void;
}) {
  const [notes, setNotes] = useState(row.notes);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  useUnsavedChanges(notes !== row.notes);
  return (
    <details>
      <summary>Review notes</summary>
      <label>
        Notes for {new URL(row.source_url).hostname}
        <textarea
          rows={3}
          maxLength={4000}
          disabled={!canEdit || saving}
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            setMessage('');
          }}
        />
      </label>
      <button
        className="btn btn-secondary"
        disabled={!canEdit || saving}
        onClick={async () => {
          setSaving(true);
          try {
            await discovery.post(`candidates/${row.id}/notes`, { notes });
            onSaved(notes);
            setMessage('Notes saved');
          } catch (e) {
            setMessage(String(e));
          } finally {
            setSaving(false);
          }
        }}
      >
        Save notes
      </button>
      <p role="status">{message}</p>
    </details>
  );
}
