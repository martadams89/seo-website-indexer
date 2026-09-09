import { useState } from 'react';
import { discovery } from './api';
import { exportCsv } from './export';
interface Import {
  id: string;
  provenance: string;
  imported_at: string;
  comparable: number;
}
interface Evidence {
  anchor: string;
  crawl_date: string | null;
}
interface Row {
  source_url: string;
  target_url: string;
  status: string;
  evidence_changed: boolean;
  before: Evidence[];
  after: Evidence[];
}
interface Comparison {
  before: Import & { rejected_records: number; observations: number };
  after: Import & { rejected_records: number; observations: number };
  rows: Row[];
  counts: { newly_observed: number; not_observed: number; observed_both: number; evidence_changed: number };
  methodology: string;
}
const labels: Record<string, string> = {
  newly_observed: 'New in comparison extract',
  not_observed: 'Not observed in comparison extract',
  observed_both: 'Observed in both extracts',
};
export function CrawlComparison({ siteId }: { siteId: string }) {
  const [imports, setImports] = useState<Import[]>([]),
    [before, setBefore] = useState(''),
    [after, setAfter] = useState('');
  const [result, setResult] = useState<Comparison | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false),
    [filter, setFilter] = useState('all'),
    [page, setPage] = useState(0);
  async function load() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const rows = await discovery.get<Import[]>(`candidates/imports?site_id=${encodeURIComponent(siteId)}`);
      setImports(rows);
      const ready = rows.filter((r) => r.comparable);
      setAfter(ready[0]?.id ?? '');
      setBefore(ready[1]?.id ?? '');
      setLoaded(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function compare() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(
        await discovery.get<Comparison>(
          `candidates/compare?${new URLSearchParams({ site_id: siteId, before_id: before, after_id: after })}`,
        ),
      );
      setPage(0);
      setFilter('all');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const rows =
    result?.rows.filter(
      (r) => filter === 'all' || (filter === 'changed' ? r.evidence_changed : r.status === filter),
    ) ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / 50));
  const option = (r: Import) =>
    `${r.provenance} · ${new Date(r.imported_at).toLocaleString()} · ${r.id.slice(0, 8)}${r.comparable ? '' : ' · no snapshot'}`;
  return (
    <details className="discovery-panel">
      <summary>Compare crawl extracts</summary>
      <p>
        Compare historical observations from two imports. A link absent from one extract may simply be outside
        its coverage.
      </p>
      <button className="btn btn-secondary" disabled={busy} onClick={load}>
        {loaded ? 'Refresh comparison imports' : 'Load comparison imports'}
      </button>
      {error && (
        <p role="alert" className="discovery-error">
          {error}
        </p>
      )}
      {loaded && (
        <>
          <div className="discovery-form">
            <label>
              Baseline extract
              <select
                value={before}
                disabled={busy}
                onChange={(e) => {
                  setBefore(e.target.value);
                  setResult(null);
                }}
              >
                <option value="">Choose an import</option>
                {imports.map((r) => (
                  <option key={r.id} value={r.id} disabled={!r.comparable}>
                    {option(r)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Comparison extract
              <select
                value={after}
                disabled={busy}
                onChange={(e) => {
                  setAfter(e.target.value);
                  setResult(null);
                }}
              >
                <option value="">Choose an import</option>
                {imports.map((r) => (
                  <option key={r.id} value={r.id} disabled={!r.comparable}>
                    {option(r)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            className="btn btn-primary"
            disabled={busy || !before || !after || before === after}
            onClick={compare}
          >
            Compare extracts
          </button>
          {imports.filter((r) => r.comparable).length < 2 && (
            <p>
              Import two extracts to compare them. Earlier receipts without snapshots cannot be reconstructed;
              reimport the original records.
            </p>
          )}
        </>
      )}
      {busy && <p role="status">Loading comparison…</p>}
      {result && (
        <>
          <p className="discovery-note">{result.methodology}</p>
          <p>
            {result.counts.newly_observed} new in comparison · {result.counts.not_observed} not observed ·{' '}
            {result.counts.observed_both} in both · {result.counts.evidence_changed} with changed anchor/date
            evidence
          </p>
          <p>
            Baseline: {result.before.provenance} ({result.before.observations} observations,{' '}
            {result.before.rejected_records} rejected records). Comparison: {result.after.provenance} (
            {result.after.observations} observations, {result.after.rejected_records} rejected records).
          </p>
          <div className="discovery-form">
            <label>
              Comparison results
              <select
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(0);
                }}
              >
                <option value="all">All pairs</option>
                {Object.entries(labels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
                <option value="changed">Changed anchor/date evidence</option>
              </select>
            </label>
          </div>
          <div className="discovery-actions">
            <button
              className="btn btn-secondary"
              disabled={!rows.length}
              onClick={() =>
                exportCsv(
                  [
                    [
                      'source_url',
                      'target_url',
                      'observation_status',
                      'evidence_changed',
                      'baseline_import',
                      'comparison_import',
                      'baseline_provenance',
                      'comparison_provenance',
                      'baseline_evidence_json',
                      'comparison_evidence_json',
                    ],
                    ...rows.map((r) => [
                      r.source_url,
                      r.target_url,
                      r.status,
                      r.evidence_changed,
                      result.before.id,
                      result.after.id,
                      result.before.provenance,
                      result.after.provenance,
                      JSON.stringify(r.before),
                      JSON.stringify(r.after),
                    ]),
                  ],
                  'crawl-comparison.csv',
                )
              }
            >
              Export comparison
            </button>
            <button className="btn btn-secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous comparison page
            </button>
            <span>
              Page {page + 1} of {pages}
            </span>
            <button
              className="btn btn-secondary"
              disabled={page + 1 >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next comparison page
            </button>
          </div>
          {!rows.length && <p>No matching observations in these extracts.</p>}
          {rows.slice(page * 50, (page + 1) * 50).map((r) => (
            <article className="discovery-panel" key={JSON.stringify([r.source_url, r.target_url])}>
              <h3>{r.source_url}</h3>
              <p>Target: {r.target_url}</p>
              <p>
                {labels[r.status]}
                {r.evidence_changed ? ' · Anchor/date evidence changed' : ''}
              </p>
              <details>
                <summary>Compare observed anchors and dates</summary>
                {(
                  [
                    ['Baseline', r.before],
                    ['Comparison', r.after],
                  ] as const
                ).map(([label, observations]) => (
                  <div key={label}>
                    <h4>{label}</h4>
                    {!observations.length ? (
                      <p>No observation in this extract</p>
                    ) : (
                      observations.map((o, i) => (
                        <p key={i}>
                          {o.anchor || 'No anchor supplied'} · {o.crawl_date || 'Unknown crawl date'}
                        </p>
                      ))
                    )}
                  </div>
                ))}
              </details>
            </article>
          ))}
        </>
      )}
    </details>
  );
}
