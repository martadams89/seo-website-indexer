import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, ArrowUpRight, ScanSearch } from 'lucide-react';
import { Link } from 'react-router-dom';
import { discovery, waitForAudit, type AuditJob, type AuditData, type OpportunityData } from './api';
import { exportCsv } from './export';
import { saveBlob } from '../utils/download';
export function exportJson(value: unknown, name: string) {
  saveBlob(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), name);
}
export function WebsiteAudit({
  siteId,
  canEdit,
  setBusy,
}: {
  siteId: string;
  canEdit: boolean;
  setBusy: (value: boolean) => void;
}) {
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [checkingJob, setCheckingJob] = useState(true);
  const [limit, setLimit] = useState(50);
  const [job, setJob] = useState<AuditJob | null>(null);
  const [data, setData] = useState<AuditData | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [area, setArea] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [search, setSearch] = useState('');
  const [runId, setRunId] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    discovery
      .get<AuditData>(
        `audits?site_id=${encodeURIComponent(siteId)}${runId ? `&run_id=${encodeURIComponent(runId)}` : ''}`,
        controller.signal,
      )
      .then((value) => {
        setData(value);
        setError('');
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setData(null);
          setError(String(e));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [siteId, runId, retry]);
  useEffect(() => {
    let live = true;
    let resuming = false;
    const controller = new AbortController();
    discovery
      .get<AuditJob | null>(`jobs/current?site_id=${encodeURIComponent(siteId)}`, controller.signal)
      .then(async (active) => {
        if (!live || active?.state !== 'running') return;
        resuming = true;
        setRunning(true);
        setBusy(true);
        const result = await waitForAudit(
          active.id,
          (next) => {
            if (live) setJob(next);
          },
          controller.signal,
        );
        if (live) {
          if (result.state === 'succeeded')
            setData(await discovery.get<AuditData>(`audits?site_id=${encodeURIComponent(siteId)}`));
          else setError(result.error || 'Audit stopped.');
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setCheckingJob(false);
        if (live && resuming) {
          setRunning(false);
          setBusy(false);
        }
      });
    return () => {
      live = false;
      controller.abort();
      setBusy(false);
    };
  }, [siteId, setBusy]);
  const current = data?.report;
  const findings =
    current?.findings
      .filter(
        (f) =>
          (area === 'all' || f.area === area) &&
          (severity === 'all' || f.severity === severity) &&
          `${f.title} ${f.url} ${f.evidence}`.toLowerCase().includes(search.toLowerCase()),
      )
      .sort(
        (a, b) =>
          (({ high: 0, medium: 1, low: 2 })[a.severity as 'high' | 'medium' | 'low'] ?? 3) -
            ({ high: 0, medium: 1, low: 2 }[b.severity as 'high' | 'medium' | 'low'] ?? 3) ||
          a.url.localeCompare(b.url),
      ) ?? [];
  async function run() {
    setJob(null);
    setRunning(true);
    setBusy(true);
    setError('');
    try {
      const started = await discovery.post<AuditJob>('audits', { site_id: siteId, limit });
      const finished = await waitForAudit(started.id, setJob, lifetime.current?.signal);
      if (finished.state !== 'succeeded') throw new Error(finished.error || 'Audit did not complete.');
      setData(await discovery.get<AuditData>(`audits?site_id=${encodeURIComponent(siteId)}`));
      setRunId('');
    } catch (e) {
      if (!lifetime.current?.signal.aborted) setError(String(e));
    } finally {
      if (!lifetime.current?.signal.aborted) {
        setRunning(false);
        setBusy(false);
      }
    }
  }
  return (
    <section aria-busy={loading}>
      <header className="discovery-section-heading">
        <div>
          <h2>Website audit</h2>
          <p>SEO, AI search eligibility and accessibility checks with page-level evidence.</p>
        </div>
        <div className="discovery-actions">
          <label>
            Page sample
            <select
              aria-label="Audit page sample"
              disabled={running}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              {[10, 25, 50].map((n) => (
                <option key={n} value={n}>
                  {n} pages
                </option>
              ))}
            </select>
          </label>
          {current && (
            <button className="btn btn-secondary" onClick={() => exportJson(current, 'website-audit.json')}>
              <Download size={15} />
              Export evidence
            </button>
          )}
          {current && (
            <button
              className="btn btn-secondary"
              onClick={() =>
                exportCsv(
                  [
                    ['area', 'severity', 'title', 'url', 'evidence', 'next_step', 'source'],
                    ...findings.map((f) => [f.area, f.severity, f.title, f.url, f.evidence, f.fix, f.source]),
                  ],
                  'audit-findings.csv',
                )
              }
            >
              Export filtered findings
            </button>
          )}
          <button className="btn btn-primary" disabled={!canEdit || running || checkingJob} onClick={run}>
            <RefreshCw size={15} className={running ? 'spin' : ''} />
            {running ? 'Checking pages…' : 'Run audit'}
          </button>
        </div>
      </header>
      {error && (
        <div role="alert" className="discovery-error">
          <p>{error}</p>
          <button className="btn btn-secondary" onClick={() => setRetry((value) => value + 1)}>
            Retry loading history
          </button>
        </div>
      )}
      {running && job && (
        <button
          className="btn btn-secondary"
          disabled={!canEdit}
          onClick={() => discovery.post(`jobs/${job.id}/cancel`, {}).catch((e) => setError(String(e)))}
        >
          Cancel audit
        </button>
      )}
      {running && (
        <p role="status" className="discovery-note">
          Checked {job?.completed ?? 0} of {job?.total || '…'} pages. Slow sites can take several minutes.
          Other scheduled work continues independently.
        </p>
      )}
      {!current ? (
        <div className="discovery-empty">
          <ScanSearch size={30} />
          <h3>
            {loading
              ? 'Loading audit history…'
              : error
                ? 'Audit history unavailable'
                : 'Build your first evidence snapshot'}
          </h3>
          <p>
            A run checks response HTML, records failures and puts significant findings in your work queue. No
            AI provider is needed.
          </p>
        </div>
      ) : (
        <>
          <div className="discovery-metrics">
            <div>
              <span>Pages checked</span>
              <strong>
                {current.pages.length}
                <small> / {current.attempted}</small>
              </strong>
              <p>{current.inventory} inventory URLs</p>
            </div>
            <div>
              <span>Fetch failures</span>
              <strong>{current.failures.length}</strong>
              <p>Visible gaps in coverage</p>
            </div>
            <div>
              <span>Findings</span>
              <strong>{current.findings.length}</strong>
              <p>{current.findings.filter((f) => f.severity === 'high').length} high priority</p>
            </div>
            <div>
              <span>Snapshot</span>
              <strong className="discovery-date">{new Date(current.observed_at).toLocaleDateString()}</strong>
              <p>{new Date(current.observed_at).toLocaleTimeString()}</p>
            </div>
          </div>
          {data && data.history.length > 1 && data.comparison && (
            <div className="discovery-change">
              <strong>Since the previous run</strong>
              <span>{data.comparison.new.length} new</span>
              <span>{data.comparison.resolved.length} no longer observed</span>
              <span>{data.comparison.persisting.length} persisting</span>
              <span>{data.comparison.unverified.length} unverified</span>
            </div>
          )}
          <div className="discovery-filters">
            <label>
              Find a page or issue
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search findings…"
              />
            </label>
            <label>
              Area
              <select value={area} onChange={(e) => setArea(e.target.value)}>
                <option value="all">All areas</option>
                {['SEO', 'GEO', 'Accessibility'].map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            <label>
              Priority
              <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                <option value="all">All priorities</option>
                {['high', 'medium', 'low'].map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            <label>
              History
              <select value={runId} onChange={(e) => setRunId(e.target.value)}>
                <option value="">Latest snapshot</option>
                {data?.history.slice(1).map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.observed_at).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <details className="discovery-panel">
            <summary>Inspect measured pages ({current.pages.length})</summary>
            {current.pages.map((page) => (
              <details key={page.url} className="discovery-panel">
                <summary>{page.title || page.url}</summary>
                <p>{page.url}</p>
                <p>
                  HTTP {page.status} · {page.words} extracted words
                </p>
                <p>Canonical: {page.canonical || 'Not declared'}</p>
                <p>Headings: {page.h1.join(' · ') || 'No main heading found'}</p>
                <p>Schema types: {page.schemaTypes.join(', ') || 'None declared'}</p>
                <p>Description: {page.description || 'None declared'}</p>
              </details>
            ))}
          </details>
          <div className="discovery-findings">
            {findings.map((f) => (
              <details key={`${f.url}:${f.code}`} className="discovery-finding">
                <summary>
                  <span className={`discovery-badge ${f.severity}`}>{f.severity}</span>
                  <div>
                    <strong>{f.title}</strong>
                    <small>{f.url}</small>
                  </div>
                  <span className="discovery-badge">{f.area}</span>
                </summary>
                <div className="discovery-finding-body">
                  <p>
                    <strong>Evidence</strong>
                    {f.evidence}
                  </p>
                  <p>
                    <strong>Next step</strong>
                    {f.fix}
                  </p>
                  <a href={f.source} target="_blank" rel="noreferrer">
                    Read the guidance <ArrowUpRight size={14} />
                  </a>
                </div>
              </details>
            ))}
            {!findings.length && (
              <p className="discovery-note">
                {current.findings.length
                  ? 'No findings match these filters.'
                  : 'No findings from these checks. Review coverage and fetch failures before drawing a conclusion.'}
              </p>
            )}
          </div>
          {!!current.failures.length && (
            <details className="discovery-panel">
              <summary>Pages we could not check ({current.failures.length})</summary>
              {current.failures.map((f) => (
                <p key={f.url}>
                  <strong>{f.url}</strong>
                  <br />
                  {f.error}
                </p>
              ))}
            </details>
          )}
          <details className="discovery-panel">
            <summary>Methodology and limits</summary>
            <p>{current.methodology}</p>
            <p>
              GEO here checks observable eligibility and attribution. Actual citations are measured separately
              in <Link to="/insights/ai">AI visibility</Link>. A missing llms.txt file is not a Google ranking
              problem.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
export function SearchOpportunities({ siteId }: { siteId: string }) {
  const [data, setData] = useState<OpportunityData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    discovery
      .get<OpportunityData>(`opportunities?site_id=${encodeURIComponent(siteId)}`, c.signal)
      .then(setData)
      .catch((e) => {
        if (!c.signal.aborted) setError(String(e));
      });
    return () => c.abort();
  }, [siteId]);
  return (
    <section>
      <header className="discovery-section-heading">
        <div>
          <h2>Search opportunities</h2>
          <p>Priorities from observed search data, with the reasoning attached.</p>
        </div>
        {data && (
          <button className="btn btn-secondary" onClick={() => exportJson(data, 'search-opportunities.json')}>
            <Download size={15} />
            Export
          </button>
        )}
      </header>
      {error && (
        <p role="alert" className="discovery-error">
          {error}
        </p>
      )}
      {data && (
        <p className="discovery-note">
          28 days from {data.from} to {data.to} (end exclusive), compared with the preceding 28 days.
        </p>
      )}
      <div className="discovery-opportunities">
        {data?.opportunities.map((o) => (
          <article key={`${o.site_id}:${o.query}`} className="discovery-panel">
            <div className="discovery-row">
              <span className="discovery-badge">{o.kind}</span>
              <small>{o.confidence}</small>
            </div>
            <h3>{o.query}</h3>
            <div className="discovery-change">
              <span>{o.clicks} clicks</span>
              <span>{o.impressions} impressions</span>
              <span>{(o.ctr * 100).toFixed(1)}% CTR</span>
              <span>Position {o.position.toFixed(1)}</span>
            </div>
            <p>{o.reason}</p>
            <Link to={`/insights/search/${o.site_id}`}>Investigate search performance →</Link>
          </article>
        ))}
      </div>
      {data && !data.opportunities.length && (
        <div className="discovery-empty">
          <h3>No qualifying opportunities yet</h3>
          <p>
            Connect Search Console and build query history. This view needs at least 100 recorded impressions
            per query; it does not invent search demand.
          </p>
          <Link className="btn btn-secondary" to="/settings">
            Manage Google connection
          </Link>
        </div>
      )}
      {data && (
        <details className="discovery-panel">
          <summary>How priorities are selected</summary>
          <p>{data.methodology}</p>
        </details>
      )}
    </section>
  );
}
