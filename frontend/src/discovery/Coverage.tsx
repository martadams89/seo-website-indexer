import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { discovery } from './api';
export function Coverage() {
  const [rows, setRows] = useState<
    Array<{
      id: string;
      name: string;
      domain: string;
      enabled: number;
      audit: { observed_at: string; pages: number; failures: number } | null;
      backlinks: number;
      verified_backlinks: number;
      listings: number;
      search_latest: string | null;
    }>
  >([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const c = new AbortController();
    discovery
      .get<typeof rows>('coverage', c.signal)
      .then(setRows)
      .catch((e) => {
        if (!c.signal.aborted) setError(String(e));
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, []);
  return (
    <section>
      <header className="discovery-section-heading">
        <div>
          <h2>Evidence coverage</h2>
          <p>See what is measured, how fresh it is and where the next check is needed.</p>
        </div>
      </header>
      {error && (
        <p role="alert" className="discovery-error">
          {error}
        </p>
      )}
      {loading && <p role="status">Loading portfolio coverage…</p>}
      <div className="discovery-opportunities">
        {rows.map((row) => (
          <article key={row.id} className="discovery-panel">
            <h3>{row.name}</h3>
            <p>
              {row.domain} · {row.enabled ? 'Scheduled site' : 'Site scheduling paused'}
            </p>
            <dl>
              <dt>Website audit</dt>
              <dd>
                {row.audit
                  ? `${row.audit.pages} pages, ${row.audit.failures} fetch failures · ${new Date(row.audit.observed_at).toLocaleString()}`
                  : 'Not measured yet'}
              </dd>
              <dt>Latest Search Console day</dt>
              <dd>{row.search_latest || 'No cached search evidence'}</dd>
              <dt>Backlinks</dt>
              <dd>
                {row.verified_backlinks} observed present / {row.backlinks} tracked
              </dd>
              <dt>Saved app listings</dt>
              <dd>{row.listings}</dd>
            </dl>
            <div className="discovery-actions">
              <Link
                className="btn btn-primary"
                to={`/discovery?tab=audit&site=${encodeURIComponent(row.id)}`}
              >
                Inspect website
              </Link>
              <Link
                className="btn btn-secondary"
                to={`/discovery?tab=backlinks&site=${encodeURIComponent(row.id)}`}
              >
                Review backlinks
              </Link>
            </div>
          </article>
        ))}
      </div>
      {!loading && !rows.length && (
        <div className="discovery-empty">
          <h3>Add your first site</h3>
          <p>Coverage will distinguish unmeasured areas from actual findings.</p>
          <Link className="btn btn-primary" to="/sites">
            Open sites
          </Link>
        </div>
      )}
    </section>
  );
}
