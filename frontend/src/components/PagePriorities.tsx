import { useCallback, useEffect, useState } from 'react';
import { Link2, Type, Gauge, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react';
import { api, type InternalLinkReport, type SnippetChange, type PageVitalsReport } from '../api';

const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, '') || '/';
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const VERDICT: Record<SnippetChange['verdict'], { label: string; cls: string }> = {
  improved: { label: 'CTR up', cls: 'badge-ok' },
  worse: { label: 'CTR down', cls: 'badge-error' },
  no_change: { label: 'No clear change', cls: '' },
  collecting: { label: 'Collecting data', cls: 'badge-warn' },
  insufficient_data: { label: 'Too few impressions', cls: '' },
};

const RATING: Record<string, { label: string; cls: string }> = {
  good: { label: 'Good', cls: 'badge-ok' },
  needs_improvement: { label: 'Needs improvement', cls: 'badge-warn' },
  poor: { label: 'Poor', cls: 'badge-error' },
};

/**
 * Page-level priorities for one site: internal-link gaps, title/description
 * change results and Core Web Vitals on the pages with the most Google clicks.
 */
export function PagePriorities({ siteId, onError }: { siteId: string; onError: (message: string) => void }) {
  const [links, setLinks] = useState<InternalLinkReport | null>(null);
  const [snippets, setSnippets] = useState<SnippetChange[] | null>(null);
  const [vitals, setVitals] = useState<PageVitalsReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [l, s, v] = await Promise.allSettled([api.getInternalLinks(siteId), api.getSnippetChanges(siteId), api.getPageVitals(siteId)]);
    if (l.status === 'fulfilled') setLinks(l.value);
    if (s.status === 'fulfilled') setSnippets(s.value);
    if (v.status === 'fulfilled') setVitals(v.value);
    const failed = [l, s, v].find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) onError(failed.reason instanceof Error ? failed.reason.message : 'Failed to load page priorities');
  }, [siteId, onError]);

  useEffect(() => { void load(); }, [load]);

  async function refreshVitals() {
    setRefreshing(true);
    try {
      const r = await api.refreshPageVitals(siteId);
      setVitals({ configured: r.configured, pages: r.pages });
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Core Web Vitals refresh failed');
    }
    setRefreshing(false);
  }

  return (
    <>
      {/* Internal links */}
      <div className="panel" id="internal-links">
        <h3 className="panel-title"><Link2 size={13} /> Internal links</h3>
        {!links ? <div className="text-dim" style={{ fontSize: 12 }}>Loading…</div> : (
          <>
            <p className="text-dim" style={{ fontSize: 12, margin: '0 0 8px' }}>
              {links.inventoried} of {links.sitemapPages} sitemap pages mapped ({Math.round(links.coverage * 100)}%).{' '}
              {links.orphansConfirmed
                ? <>{links.weakOrOrphanUrls.length} page(s) have two or fewer internal links. Pages already ranking on page one or two are listed first, because stronger internal links help them most.</>
                : <>Each run maps up to 150 more pages. Orphan detection starts once 90% are mapped, so these counts are provisional.</>}
            </p>
            {links.targets.length === 0 ? (
              <div className="empty-note"><CheckCircle2 size={12} /> Every mapped page has at least three internal links.</div>
            ) : (
              <table className="mini-table">
                <thead><tr><th>Page</th><th>Links in</th><th>Position</th><th>Impr. 28d</th><th>Suggested linking pages</th></tr></thead>
                <tbody>
                  {links.targets.slice(0, 25).map(t => (
                    <tr key={t.url}>
                      <td className="cell-url">
                        {path(t.url)}{' '}
                        {t.kind === 'orphan' && <span className="badge badge-error">orphan</span>}{' '}
                        {t.pageTwo && <span className="badge badge-warn">page two</span>}
                      </td>
                      <td>{t.inbound}</td>
                      <td>{t.position ?? '—'}</td>
                      <td>{t.impressions.toLocaleString()}</td>
                      <td style={{ fontSize: 12 }}>
                        {t.suggestions.length === 0 ? <span className="text-dim">No related pages found</span> : (
                          <>
                            {(expanded === t.url ? t.suggestions : t.suggestions.slice(0, 2)).map(sg => (
                              <div key={sg.source}>
                                <span className="cell-url">{path(sg.source)}</span>
                                {sg.sharedTerms.length > 0 && <span className="text-dim"> · {sg.sharedTerms.slice(0, 3).join(', ')}</span>}
                              </div>
                            ))}
                            {t.suggestions.length > 2 && (
                              <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(expanded === t.url ? null : t.url)}>
                                {expanded === t.url ? 'Show fewer' : `+${t.suggestions.length - 2} more`}
                              </button>
                            )}
                            {t.anchorHint && <div className="text-dim">Anchor idea: “{t.anchorHint}”</div>}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      {/* Title / description changes */}
      <div className="panel">
        <h3 className="panel-title"><Type size={13} /> Title &amp; description changes</h3>
        <p className="text-dim" style={{ fontSize: 12, margin: '0 0 8px' }}>
          Detected automatically when a page's title or meta description changes. Google click-through rate and position are compared for up to 28 days before and after, once 14 days of post-change data exist.
        </p>
        {!snippets ? <div className="text-dim" style={{ fontSize: 12 }}>Loading…</div> : snippets.length === 0 ? (
          <div className="empty-note">No changes recorded yet. Edit a page's title or description and the next run will record it.</div>
        ) : (
          <table className="mini-table">
            <thead><tr><th>Page</th><th>Change</th><th>CTR before → after</th><th>Position</th><th>Result</th></tr></thead>
            <tbody>
              {snippets.slice(0, 25).map(c => (
                <tr key={c.id}>
                  <td className="cell-url">{path(c.url)}<div className="text-dim" style={{ fontSize: 12 }}>{new Date(c.changed_at).toLocaleDateString()}</div></td>
                  <td style={{ fontSize: 12 }}>
                    {c.old_title !== c.new_title
                      ? <><s className="text-dim">{c.old_title || '(none)'}</s><br />{c.new_title || '(none)'}</>
                      : <span className="text-dim">Meta description</span>}
                  </td>
                  <td>{c.verdict === 'collecting' ? '—' : `${pct(c.before.ctr)} → ${pct(c.after.ctr)}`}</td>
                  <td>{c.positionChange === null ? '—' : `${c.before.position.toFixed(1)} → ${c.after.position.toFixed(1)}`}</td>
                  <td>
                    <span className={`badge ${VERDICT[c.verdict].cls}`}>{VERDICT[c.verdict].label}</span>
                    {c.verdict === 'collecting' && <div className="text-dim" style={{ fontSize: 12 }}>ready {c.readyOn}</div>}
                    {c.ctrChangePct !== null && <div className="text-dim" style={{ fontSize: 12 }}>{c.ctrChangePct > 0 ? '+' : ''}{c.ctrChangePct.toFixed(0)}% CTR</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Page-level Core Web Vitals */}
      <div className="panel">
        <div className="flex items-center gap-2" style={{ justifyContent: 'space-between' }}>
          <h3 className="panel-title" style={{ margin: 0 }}><Gauge size={13} /> Core Web Vitals on top pages</h3>
          {vitals?.configured && (
            <button className="btn btn-secondary btn-sm" onClick={refreshVitals} disabled={refreshing}>
              <RefreshCw size={12} /> {refreshing ? 'Checking…' : 'Check now'}
            </button>
          )}
        </div>
        {!vitals ? <div className="text-dim" style={{ fontSize: 12 }}>Loading…</div> : !vitals.configured ? (
          <div className="empty-note">Add a Chrome UX Report API key in Settings to check real-user Core Web Vitals for the 25 pages with the most Google clicks.</div>
        ) : vitals.pages.length === 0 ? (
          <div className="empty-note">No data yet. Pages are checked weekly once Search Console page data has synced.</div>
        ) : (
          <table className="mini-table" style={{ marginTop: 10 }}>
            <thead><tr><th>Page</th><th>Clicks 28d</th><th>LCP</th><th>INP</th><th>CLS</th><th>Mobile rating</th></tr></thead>
            <tbody>
              {vitals.pages.map(v => (
                <tr key={v.url}>
                  <td className="cell-url">{path(v.url)}</td>
                  <td>{v.clicks.toLocaleString()}</td>
                  <td>{v.lcp_ms === null ? '—' : `${(v.lcp_ms / 1000).toFixed(1)} s`}</td>
                  <td>{v.inp_ms === null ? '—' : `${Math.round(v.inp_ms)} ms`}</td>
                  <td>{v.cls === null ? '—' : v.cls.toFixed(2)}</td>
                  <td>
                    {v.rating ? <span className={`badge ${RATING[v.rating].cls}`}>{RATING[v.rating].label}</span> : <span className="text-dim" style={{ fontSize: 12 }}>Not enough real-user data</span>}{' '}
                    {v.rating && v.rating !== 'good' && (
                      <a href={`https://pagespeed.web.dev/analysis?url=${encodeURIComponent(v.url)}&form_factor=mobile`} target="_blank" rel="noopener noreferrer" title="Diagnose in PageSpeed Insights"><ExternalLink size={12} /></a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
