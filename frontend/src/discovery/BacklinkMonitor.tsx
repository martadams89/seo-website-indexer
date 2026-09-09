import { LinkDiscovery } from './LinkDiscovery';
import { useEffect, useState } from 'react';
import { Download, Link2, RefreshCw } from 'lucide-react';
import { discovery, type Backlink } from './api';
import { exportCsv } from './export';
import { exportJson } from './WebsiteAudit';
export function BacklinkMonitor({
  siteId,
  canEdit,
  setBusy,
}: {
  siteId: string;
  canEdit: boolean;
  setBusy: (value: boolean) => void;
}) {
  const [order, setOrder] = useState('newest');
  const [monitorFilter, setMonitorFilter] = useState('all');
  const [relFilter, setRelFilter] = useState('all');
  const [rows, setRows] = useState<Backlink[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [csv, setCsv] = useState('source_url,target_url\n');
  const [provenance, setProvenance] = useState('Search Console export');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [rejected, setRejected] = useState<Array<{ row: number; reason: string }>>([]);
  const [history, setHistory] = useState<{
    id: string;
    checks: Array<{ id: number; status: string; checked_at: string }>;
  } | null>(null);
  useEffect(() => {
    const c = new AbortController();
    discovery
      .get<Backlink[]>(`backlinks?site_id=${encodeURIComponent(siteId)}`, c.signal)
      .then(setRows)
      .catch((e) => {
        if (!c.signal.aborted) setError(String(e));
      });
    return () => c.abort();
  }, [siteId]);
  async function act(importing: boolean, preview = false) {
    setWorking(true);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (importing) {
        const result = await discovery.post<{ added: number; duplicates: number; rejected: typeof rejected }>(
          'backlinks/import',
          { site_id: siteId, csv, provenance, preview },
        );
        setMessage(
          `${preview ? 'Preview only: ' : ''}${result.added} ${preview ? 'would be imported' : 'imported'}, ${result.duplicates} already tracked, ${result.rejected.length} rejected.`,
        );
        setRejected(result.rejected);
      } else {
        const result = await discovery.post<{ checked: number; busy: boolean }>('backlinks/check', {
          site_id: siteId,
        });
        setMessage(
          result.busy
            ? 'A check is already running for this site.'
            : `${result.checked} source pages checked.`,
        );
      }
      setRows(await discovery.get<Backlink[]>(`backlinks?site_id=${encodeURIComponent(siteId)}`));
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
      setBusy(false);
    }
  }
  const filtered = rows
    .filter(
      (r) =>
        (monitorFilter === 'all' || Boolean(r.enabled) === (monitorFilter === 'active')) &&
        (relFilter === 'all' || (r.status === 'present' && r.evidence.rel?.includes(relFilter))) &&
        (status === 'all' || r.status === status) &&
        `${r.source_url} ${r.target_url} ${r.evidence.anchors?.join(' ')}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      order === 'oldest-check'
        ? (a.checked_at || '').localeCompare(b.checked_at || '')
        : order === 'host'
          ? new URL(a.source_url).hostname.localeCompare(new URL(b.source_url).hostname)
          : b.first_seen.localeCompare(a.first_seen),
    );
  const hosts = new Set(rows.map((r) => new URL(r.source_url).hostname.replace(/^www\./, ''))).size;
  return (
    <section>
      <header className="discovery-section-heading">
        <div>
          <h2>Backlink monitor</h2>
          <p>Know who links to you, what the link says, and whether it is still there.</p>
        </div>
        <div className="discovery-actions">
          <button
            className="btn btn-secondary"
            disabled={!rows.length}
            onClick={() => exportJson(rows, 'backlink-evidence.json')}
          >
            <Download size={15} />
            Export
          </button>
          <button
            className="btn btn-secondary"
            disabled={!rows.length}
            onClick={() =>
              exportCsv(
                [
                  [
                    'source_url',
                    'target_url',
                    'status',
                    'anchors',
                    'rel',
                    'checked_at',
                    'provenance',
                    'notes',
                  ],
                  ...filtered.map((r) => [
                    r.source_url,
                    r.target_url,
                    r.status,
                    r.evidence.anchors?.join(' | '),
                    r.evidence.rel?.join(' '),
                    r.checked_at,
                    r.provenance,
                    r.notes,
                  ]),
                ],
                'backlinks.csv',
              )
            }
          >
            Export filtered CSV
          </button>
          <button
            className="btn btn-primary"
            disabled={!canEdit || working || !rows.length}
            onClick={() => act(false)}
          >
            <RefreshCw size={15} className={working ? 'spin' : ''} />
            {working ? 'Working…' : 'Check next 25'}
          </button>
        </div>
      </header>
      <LinkDiscovery
        siteId={siteId}
        canEdit={canEdit && !working}
        monitor
        onBusy={(value) => {
          setWorking(value);
          setBusy(value);
        }}
        onComplete={async () =>
          setRows(await discovery.get<Backlink[]>(`backlinks?site_id=${encodeURIComponent(siteId)}`))
        }
      />
      {error && (
        <p className="discovery-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="discovery-note" role="status">
          {message}
        </p>
      )}
      <div className="discovery-metrics">
        <div>
          <span>Imported links</span>
          <strong>{rows.length}</strong>
          <p>Sources you chose to track</p>
        </div>
        <div>
          <span>Referring hosts</span>
          <strong>{hosts}</strong>
          <p>Unique source hostnames</p>
        </div>
        <div>
          <span>Present</span>
          <strong>{rows.filter((r) => r.status === 'present').length}</strong>
          <p>Observed in response HTML</p>
        </div>
        <div>
          <span>Needs review</span>
          <strong>{rows.filter((r) => ['missing', 'unreachable'].includes(r.status)).length}</strong>
          <p>Missing or unreachable</p>
        </div>
      </div>
      <details className="discovery-panel" open={!rows.length}>
        <summary>Import backlink sources</summary>
        <p>
          Export linking-page URLs from{' '}
          <a href="https://support.google.com/webmasters/answer/9049606" target="_blank" rel="noreferrer">
            Search Console’s Links report
          </a>
          , another provider, or your own research. Use a source_url column; target_url is optional. Without a
          target, we look for any link to the selected site. Up to 500 rows per import.
        </p>
        <div className="discovery-form">
          <label>
            Source label
            <input
              disabled={!canEdit || working}
              value={provenance}
              onChange={(e) => setProvenance(e.target.value)}
            />
          </label>
          <label>
            Load a CSV file
            <input
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              disabled={!canEdit || working}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                try {
                  if (file.size > 500000) throw new Error('Import files must be at most 500 KB.');
                  setCsv(await file.text());
                  setError('');
                } catch (error) {
                  setError(String(error));
                }
              }}
            />
          </label>
          <label>
            CSV
            <textarea
              rows={6}
              disabled={!canEdit || working}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              spellCheck={false}
            />
          </label>
        </div>
        <button className="btn btn-primary" disabled={!canEdit || working} onClick={() => act(true)}>
          Import sources
        </button>
        <button className="btn btn-secondary" disabled={!canEdit || working} onClick={() => act(true, true)}>
          Preview import
        </button>
        {rejected.map((r) => (
          <p key={r.row} className="discovery-error-text">
            Row {r.row}: {r.reason}
          </p>
        ))}
      </details>
      <details className="discovery-panel">
        <summary>Referring host breakdown</summary>
        {Object.entries(
          rows.reduce<Record<string, number>>((out, row) => {
            const name = new URL(row.source_url).hostname.replace(/^www\./, '');
            out[name] = (out[name] || 0) + 1;
            return out;
          }, {}),
        )
          .sort((a, b) => b[1] - a[1])
          .slice(0, 50)
          .map(([name, count]) => (
            <p key={name}>
              {name} · {count} tracked sources
            </p>
          ))}
      </details>
      <details className="discovery-panel">
        <summary>Observed anchor text</summary>
        {Object.entries(
          rows
            .filter((r) => r.status === 'present')
            .reduce<Record<string, number>>((out, row) => {
              for (const anchor of new Set(row.evidence.anchors || []))
                out[anchor || '(empty)'] = (out[anchor || '(empty)'] || 0) + 1;
              return out;
            }, {}),
        )
          .sort((a, b) => b[1] - a[1])
          .slice(0, 50)
          .map(([anchor, count]) => (
            <p key={anchor}>
              {anchor} · {count} source records
            </p>
          ))}
      </details>
      <div className="discovery-filters">
        <label>
          Find a source, target or anchor
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search backlinks…" />
        </label>
        <label>
          Link attribute
          <select value={relFilter} onChange={(e) => setRelFilter(e.target.value)}>
            <option value="all">All attributes</option>
            {['nofollow', 'sponsored', 'ugc'].map((rel) => (
              <option key={rel}>{rel}</option>
            ))}
          </select>
        </label>
        <label>
          Monitoring
          <select value={monitorFilter} onChange={(e) => setMonitorFilter(e.target.value)}>
            <option value="all">All sources</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </label>
        <label>
          Sort sources
          <select value={order} onChange={(e) => setOrder(e.target.value)}>
            <option value="newest">Newest imported</option>
            <option value="oldest-check">Oldest check first</option>
            <option value="host">Source hostname</option>
          </select>
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All statuses</option>
            {['unverified', 'present', 'missing', 'unreachable'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="discovery-backlinks">
        {filtered.map((r) => (
          <article key={r.id} className="discovery-panel">
            <div className="discovery-row">
              <span
                className={`discovery-badge ${r.status === 'present' ? 'good' : r.status === 'missing' ? 'medium' : ''}`}
              >
                {r.status}
              </span>
              <small>
                {r.checked_at
                  ? `Checked ${new Date(r.checked_at).toLocaleString()}`
                  : 'Awaiting verification'}
              </small>
            </div>
            <h3>
              <a href={r.source_url} target="_blank" rel="noreferrer">
                {r.source_url}
              </a>
            </h3>
            <p>
              <strong>Target</strong> {r.target_url || 'Any page on this site'}
            </p>
            {r.evidence.targets?.map((t) => (
              <p key={t}>
                <Link2 size={13} /> {t}
              </p>
            ))}
            <div className="discovery-change">
              <span>Anchor: {r.evidence.anchors?.join(' · ') || 'Not observed'}</span>
              <span>
                Rel:{' '}
                {r.evidence.rel?.join(', ') ||
                  (r.status === 'present' ? 'No rel attribute observed' : 'Unknown')}
              </span>
            </div>
            {!!r.evidence.links?.length && (
              <details>
                <summary>Individual link evidence ({r.evidence.links.length})</summary>
                {r.evidence.links.map((link, index) => (
                  <p key={index}>
                    <strong>{link.anchor || '(empty anchor)'}</strong>
                    <br />
                    {link.url}
                    <br />
                    rel: {link.rel.join(', ') || 'none observed'}
                  </p>
                ))}
              </details>
            )}
            {!!r.evidence.changes?.length && (
              <p className="discovery-note">Changed since previous check: {r.evidence.changes.join(', ')}</p>
            )}
            {r.evidence.error && <p>{r.evidence.error}</p>}
            <div className="discovery-row">
              <small>Source: {r.provenance}</small>
              <button
                className="btn btn-ghost"
                onClick={() =>
                  discovery
                    .get<Array<{ id: number; status: string; checked_at: string }>>(
                      `backlinks/${r.id}/history`,
                    )
                    .then((checks) => setHistory({ id: r.id, checks }))
                    .catch((e) => setError(String(e)))
                }
              >
                Check history
              </button>
            </div>
            <button
              className="btn btn-ghost"
              disabled={!canEdit || working}
              onClick={async () => {
                try {
                  await discovery.post(`backlinks/${r.id}/monitoring`, { enabled: !r.enabled });
                  setRows((previous) =>
                    previous.map((row) => (row.id === r.id ? { ...row, enabled: row.enabled ? 0 : 1 } : row)),
                  );
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              {r.enabled ? 'Pause monitoring' : 'Resume monitoring'}
            </button>
            <button
              className="btn btn-ghost"
              disabled={!canEdit || working || !r.enabled}
              onClick={async () => {
                setWorking(true);
                setBusy(true);
                try {
                  await discovery.post('backlinks/check', { site_id: siteId, id: r.id });
                  setRows(await discovery.get<Backlink[]>(`backlinks?site_id=${encodeURIComponent(siteId)}`));
                } catch (e) {
                  setError(String(e));
                } finally {
                  setWorking(false);
                  setBusy(false);
                }
              }}
            >
              Recheck this source
            </button>
            <BacklinkNotes row={r} canEdit={canEdit} />
            {history?.id === r.id && (
              <div className="discovery-history">
                {history.checks.length ? (
                  history.checks.map((c) => (
                    <p key={c.id}>
                      {new Date(c.checked_at).toLocaleString()} · {c.status}
                    </p>
                  ))
                ) : (
                  <p>No checks yet.</p>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
      {!filtered.length && (
        <div className="discovery-empty">
          <Link2 size={28} />
          <h3>{rows.length ? 'No matching backlinks' : 'Build a backlink evidence library'}</h3>
          <p>
            Import sources to start monitoring. A self-hosted checker cannot discover the whole web without an
            external link index.
          </p>
        </div>
      )}
      <details className="discovery-panel">
        <summary>What this proves—and what it does not</summary>
        <p>
          Checks fetch public HTML with outbound-network protection. JavaScript-rendered links may be missed.
          “Missing” means absent from that response; “unreachable” means we could not verify. Link attributes
          do not measure quality or guarantee ranking credit. No domain-authority or toxicity scores are
          invented.
        </p>
        <p>
          Enabled sites are rechecked in batches, with a seven-day freshness interval. The most recent 30
          checks per link are retained. We never purchase links, contact publishers or submit disavow files.
        </p>
      </details>
    </section>
  );
}

function BacklinkNotes({ row, canEdit }: { row: Backlink; canEdit: boolean }) {
  const [notes, setNotes] = useState(row.notes || '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <details>
      <summary>Review notes</summary>
      <label>
        Notes for this source
        <textarea
          aria-label={`Notes for ${row.source_url}`}
          maxLength={4000}
          rows={3}
          value={notes}
          disabled={!canEdit || busy}
          onChange={(e) => {
            setNotes(e.target.value);
            setMessage('');
          }}
        />
      </label>
      <button
        className="btn btn-secondary"
        disabled={!canEdit || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await discovery.post(`backlinks/${row.id}/review`, { notes });
            setMessage('Notes saved');
          } catch (e) {
            setMessage(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Save notes
      </button>
      <p role="status">{message}</p>
    </details>
  );
}
