import { DeleteDraft } from './DeleteDraft';
import { useUnsavedChanges } from './useUnsavedChanges';
import { useEffect, useState } from 'react';
import { exportCsv } from './export';
import { discovery } from './api';
import type { DiscoveryDocument } from './ContentStudio';
export function Experiments({
  siteId,
  canEdit,
  setBusy,
}: {
  siteId: string;
  canEdit: boolean;
  setBusy: (v: boolean) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const confirmDiscard = useUnsavedChanges(dirty);
  const [showArchived, setShowArchived] = useState(false);
  const [result, setResult] = useState<{
    metric: string;
    days: number;
    before: Record<string, number | string | null>;
    after: Record<string, number | string | null>;
    status: string;
    delta: number | null;
    change_percent: number | null;
    methodology: string;
  } | null>(null);
  const [docs, setDocs] = useState<DiscoveryDocument[]>([]);
  const [id, setId] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({
    title: '',
    hypothesis: '',
    start_date: new Date().toISOString().slice(0, 10),
    window_days: '28',
    metric: 'clicks',
  });
  const [busy, working] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    const c = new AbortController();
    discovery
      .get<DiscoveryDocument[]>(`documents?kind=experiment&site_id=${encodeURIComponent(siteId)}`, c.signal)
      .then(setDocs)
      .catch((e) => {
        if (!c.signal.aborted) setError(String(e));
      });
    return () => c.abort();
  }, [siteId]);
  async function save() {
    setResult(null);
    working(true);
    setBusy(true);
    try {
      const row = await discovery.post<DiscoveryDocument>('documents', {
        kind: 'experiment',
        site_id: siteId,
        ...(id ? { id } : {}),
        body: draft,
      });
      setId(row.id);
      setDocs((previous) => [row, ...previous.filter((r) => r.id !== row.id)]);
      setDirty(false);
      setMessage('Measurement plan saved');
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      working(false);
      setBusy(false);
    }
  }
  return (
    <section>
      <header className="discovery-section-heading">
        <div>
          <h2>Measure changes</h2>
          <p>Record the change and hypothesis before checking what happened to search performance.</p>
        </div>
        <button
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => {
            if (!confirmDiscard()) return;
            setDirty(false);
            setResult(null);
            setId('');
            setDraft({
              title: '',
              hypothesis: '',
              start_date: new Date().toISOString().slice(0, 10),
              window_days: '28',
              metric: 'clicks',
            });
            setMessage('');
          }}
        >
          New measurement plan
        </button>
      </header>
      {id && (
        <DeleteDraft
          path={`documents/${encodeURIComponent(id)}`}
          title={docs.find((row) => row.id === id)?.body.title || draft.title}
          label="Delete measurement plan"
          disabled={!canEdit || busy}
          onBusy={(value) => {
            working(value);
            setBusy(value);
          }}
          onDeleted={() => {
            setDocs((rows) => rows.filter((row) => row.id !== id));
            setId('');
            setDraft({
              title: '',
              hypothesis: '',
              start_date: new Date().toISOString().slice(0, 10),
              window_days: '28',
              metric: 'clicks',
            });
            setDirty(false);
            setResult(null);
            setError('');
            setMessage('Measurement plan deleted');
          }}
        />
      )}

      {error && (
        <p role="alert" className="discovery-error">
          {error}
        </p>
      )}
      <div className="discovery-opportunities">
        <aside className="discovery-panel">
          <h3>Measurement plans</h3>
          <label>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />{' '}
            Show archived plans
          </label>
          {docs
            .filter((doc) => showArchived || doc.body.state !== 'archived')
            .map((doc) => (
              <button
                key={doc.id}
                className={`discovery-saved ${id === doc.id ? 'active' : ''}`}
                disabled={busy}
                onClick={() => {
                  if (!confirmDiscard()) return;
                  setDirty(false);
                  setResult(null);
                  setId(doc.id);
                  setDraft(doc.body);
                  setMessage('');
                }}
              >
                <span>
                  <strong>{doc.body.title}</strong>
                  <small>{doc.body.start_date}</small>
                </span>
              </button>
            ))}
          {!docs.length && <p>Save a plan before making the next meaningful site change.</p>}
        </aside>
        <div className="discovery-panel">
          <div className="discovery-form" onChangeCapture={() => setDirty(true)}>
            <label>
              Change title
              <input
                value={draft.title || ''}
                disabled={!canEdit || busy}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </label>
            <label>
              Other changes and possible confounders
              <textarea
                rows={3}
                value={draft.confounders || ''}
                disabled={!canEdit || busy}
                onChange={(e) => setDraft((d) => ({ ...d, confounders: e.target.value }))}
              />
            </label>
            <label>
              Review outcome
              <select
                value={draft.outcome || 'unreviewed'}
                disabled={!canEdit || busy}
                onChange={(e) => setDraft((d) => ({ ...d, outcome: e.target.value }))}
              >
                {['unreviewed', 'promising', 'no clear improvement', 'inconclusive'].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              What we learned
              <textarea
                rows={3}
                value={draft.learning || ''}
                disabled={!canEdit || busy}
                onChange={(e) => setDraft((d) => ({ ...d, learning: e.target.value }))}
              />
            </label>
            <label>
              Plan status
              <select
                value={draft.state || 'active'}
                disabled={!canEdit || busy}
                onChange={(e) => setDraft((d) => ({ ...d, state: e.target.value }))}
              >
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </label>
            <label>
              Hypothesis
              <textarea
                rows={3}
                value={draft.hypothesis || ''}
                disabled={!canEdit || busy}
                onChange={(e) => setDraft((d) => ({ ...d, hypothesis: e.target.value }))}
              />
            </label>
            <label>
              Change date
              <input
                type="date"
                value={draft.start_date || ''}
                disabled={!canEdit || busy}
                onChange={(e) => setDraft((d) => ({ ...d, start_date: e.target.value }))}
              />
            </label>
            <label>
              Primary metric
              <select
                value={draft.metric || 'clicks'}
                disabled={!canEdit || busy}
                onChange={(e) => setDraft((d) => ({ ...d, metric: e.target.value }))}
              >
                {['clicks', 'impressions', 'ctr', 'position'].map((metric) => (
                  <option key={metric}>{metric}</option>
                ))}
              </select>
            </label>
            <label>
              Comparison window
              <select
                value={draft.window_days || '28'}
                disabled={!canEdit || busy}
                onChange={(e) => setDraft((d) => ({ ...d, window_days: e.target.value }))}
              >
                {['7', '14', '28'].map((days) => (
                  <option key={days} value={days}>
                    {days} days before and after
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            className="btn btn-primary"
            disabled={!canEdit || busy || !draft.title?.trim()}
            onClick={save}
          >
            {busy ? 'Saving…' : 'Save measurement plan'}
          </button>
          {id && (
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                discovery
                  .get<NonNullable<typeof result>>(`documents/${id}/measurement`)
                  .then(setResult)
                  .catch((e) => setError(String(e)))
              }
            >
              Measure saved plan
            </button>
          )}
          <p role="status">{message}</p>
        </div>
      </div>
      {result && (
        <section className="discovery-panel">
          <h3>Observed comparison · {result.metric}</h3>
          <button
            className="btn btn-secondary"
            onClick={() =>
              exportCsv(
                [
                  ['period', 'from', 'to_exclusive', 'observed_days', result.metric],
                  [
                    'before',
                    result.before.from,
                    result.before.to,
                    result.before.observed_days,
                    result.before[result.metric],
                  ],
                  [
                    'after',
                    result.after.from,
                    result.after.to,
                    result.after.observed_days,
                    result.after[result.metric],
                  ],
                  ['status', result.status],
                  ['methodology', result.methodology],
                ],
                'measurement-results.csv',
              )
            }
          >
            Export measured results
          </button>
          <div className="discovery-metrics">
            <div>
              <span>Before</span>
              <strong>
                {result.before[result.metric] === null
                  ? '—'
                  : Number(result.before[result.metric]).toFixed(2)}
              </strong>
              <p>
                {String(result.before.from)} to {String(result.before.to)} (exclusive)
              </p>
            </div>
            <div>
              <span>After</span>
              <strong>
                {result.after[result.metric] === null ? '—' : Number(result.after[result.metric]).toFixed(2)}
              </strong>
              <p>
                {String(result.after.from)} to {String(result.after.to)} (exclusive)
              </p>
            </div>
            <div>
              <span>Observed change</span>
              <strong>{result.change_percent === null ? '—' : `${result.change_percent.toFixed(1)}%`}</strong>
              <p>{result.status}</p>
              <p>
                {String(result.before.observed_days)} / {result.days} baseline days;{' '}
                {String(result.after.observed_days)} / {result.days} follow-up days
              </p>
            </div>
          </div>
          <div className="discovery-comparison-bars" aria-label="Observed before and after values">
            {['before', 'after'].map((period) => {
              const value = Number(result[period as 'before' | 'after'][result.metric] || 0);
              const max = Math.max(
                Number(result.before[result.metric] || 0),
                Number(result.after[result.metric] || 0),
                1,
              );
              return (
                <div key={period}>
                  <span>
                    {period}: {value.toFixed(2)}
                  </span>
                  <div style={{ height: 12, borderRadius: 4, background: 'var(--bg-input)' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.max(0, (value / max) * 100)}%`,
                        background: 'var(--accent)',
                        borderRadius: 4,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <p>{result.methodology}</p>
        </section>
      )}
      <p className="discovery-note">
        Before/after comparisons are observational. Seasonality, algorithm changes, other edits and incomplete
        data can explain differences. This is not a controlled A/B test or proof of causation.
      </p>
    </section>
  );
}
