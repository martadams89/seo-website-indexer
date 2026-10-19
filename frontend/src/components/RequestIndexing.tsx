import { useCallback, useEffect, useState } from 'react';
import { Bot, Check, Copy, ExternalLink, Info, MousePointerClick } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../AppContext';
import '../ads/ads.css';

type Data = Awaited<ReturnType<typeof api.getRequestIndexing>>;

const SUPPORT: Record<string, { label: string; tone: string }> = {
  automatic: { label: 'Automatic', tone: 'ok' },
  available: { label: 'Available', tone: 'ok' },
  limited: { label: 'Limited', tone: 'warn' },
  not_available: { label: 'No API', tone: 'error' },
  not_google: { label: 'Not Google', tone: 'info' },
};

const REASON: Record<string, string> = {
  not_indexed: 'Not indexed',
  changed_since_crawl: 'Changed since last crawl',
  never_inspected: 'New / not inspected',
};

/**
 * What Google's APIs can and can't do for indexing, the pages worth a manual
 * "Request indexing", and copyable prompts for a browser agent to do it.
 */
export function RequestIndexingCard({ siteId, canManage }: { siteId: string; canManage: boolean }) {
  const toast = useToast();
  const [data, setData] = useState<Data | null>(null);
  const [maxPerRun, setMaxPerRun] = useState(10);
  const [variant, setVariant] = useState<'one_off' | 'routine'>('one_off');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setData(await api.getRequestIndexing(siteId, maxPerRun)); setError(''); }
    catch (e) { setError(String(e).replace('Error: ', '')); }
  }, [siteId, maxPerRun]);
  useEffect(() => { void load(); }, [load]);

  function copy(value: string) {
    navigator.clipboard.writeText(value);
    toast('success', 'Copied to clipboard');
  }

  async function markRequested(url: string) {
    try {
      await api.recordIndexingRequests(siteId, [{ url, outcome: 'requested', note: 'marked on the dashboard' }]);
      toast('success', 'Marked as requested — it will leave the queue for 7 days');
      await load();
    } catch (e) { toast('error', String(e).replace('Error: ', '')); }
  }

  return (
    <section className="ops-card full request-indexing">
      <div className="ops-card-head">
        <div>
          <span>Search Console</span>
          <h2>Ask Google to crawl specific pages</h2>
        </div>
        <MousePointerClick size={18} />
      </div>
      {error && <div className="alert alert-error"><div className="alert-content">{error}</div></div>}

      <details className="request-indexing-facts">
        <summary><Info size={14} /> What Google's APIs can and can't do</summary>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Action</th><th>How</th><th>Status</th><th>Notes</th></tr></thead>
            <tbody>
              {data?.capabilities.map(c => (
                <tr key={c.action}>
                  <td><strong>{c.action}</strong></td>
                  <td>{c.via}</td>
                  <td><span className={`badge badge-${SUPPORT[c.support]?.tone ?? 'info'}`}>{SUPPORT[c.support]?.label ?? c.support}</span></td>
                  <td><small>{c.notes}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <p className="card-intro">
        Search Console's <b>Request indexing</b> button has no API, and Google limits it to a handful of pages per property per day.
        These are the pages most worth spending that on. Request them yourself with the links, or let an AI browser agent do it
        in your own signed-in browser with the prompt below.
      </p>

      <div className="request-indexing-list">
        {data?.candidates.slice(0, 15).map(c => (
          <article key={c.url}>
            <span className={`badge badge-${c.reason === 'not_indexed' ? 'warn' : c.reason === 'changed_since_crawl' ? 'accent' : 'info'}`}>{REASON[c.reason] ?? c.reason}</span>
            <div>
              <code>{c.url}</code>
              {c.coverage && <small>{c.coverage}</small>}
            </div>
            <a className="btn-icon btn-icon-ghost" href={c.inspect_url} target="_blank" rel="noreferrer" aria-label={`Open URL Inspection for ${c.url}`}><ExternalLink size={13} /></a>
            <button type="button" className="btn-icon btn-icon-ghost" disabled={!canManage} aria-label={`Mark ${c.url} as requested`} onClick={() => markRequested(c.url)}><Check size={13} /></button>
          </article>
        ))}
        {data && !data.candidates.length && <div className="ops-empty compact"><Check /><strong>Nothing needs a manual request</strong><span>Every inspected page is indexed and unchanged since Google's last crawl, or was requested in the past week.</span></div>}
      </div>

      <div className="request-indexing-prompt">
        <div className="ads-toolbar">
          <div className="ops-tabs" role="group" aria-label="Prompt type">
            <button type="button" className={variant === 'one_off' ? 'active' : ''} aria-pressed={variant === 'one_off'} onClick={() => setVariant('one_off')}>One-off (any AI browser)</button>
            <button type="button" className={variant === 'routine' ? 'active' : ''} aria-pressed={variant === 'routine'} onClick={() => setVariant('routine')}><Bot size={13} /> Recurring routine (needs MCP)</button>
          </div>
          <label className="ads-inline-check">Pages per run
            <select className="input" value={maxPerRun} onChange={e => setMaxPerRun(Number(e.target.value))}>{[5, 10, 15, 20].map(n => <option key={n} value={n}>{n}</option>)}</select>
          </label>
          {data && <button type="button" className="btn btn-primary btn-sm" onClick={() => copy(data.prompts[variant])}><Copy size={13} /> Copy prompt</button>}
        </div>
        <ol className="ads-guide-steps">
          <li><strong>Sign in yourself first.</strong> Open <a href="https://search.google.com/search-console" target="_blank" rel="noreferrer">Search Console</a> in the Chrome profile the agent will use, with a Google account that has Owner or Full permission on <code>{data?.property ?? 'this property'}</code>. Stay signed in — the prompt tells the agent to stop rather than type passwords or 2-step codes.</li>
          {variant === 'routine'
            ? <li><strong>Connect this app's MCP server</strong> to an AI assistant that can also control your browser (Governance &amp; usage → Connect an AI assistant), with SEO actions allowed. Then create a scheduled task (daily suits Google's quota) with this prompt. Each run fetches a fresh queue and records what it requested.</li>
            : <li><strong>Paste the prompt</strong> into any AI browser agent — a browser extension or AI browser that acts in your own signed-in session. The page list is included, so no MCP connection is needed.</li>}
        </ol>
        <textarea className="ads-prompt-text" readOnly rows={12} value={data?.prompts[variant] ?? ''} aria-label="Browser agent prompt" onFocus={e => e.currentTarget.select()} />
      </div>
    </section>
  );
}
