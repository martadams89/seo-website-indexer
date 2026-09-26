import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import {
  ArrowRight, BriefcaseBusiness, CheckCircle2, Copy, ExternalLink, Eye, EyeOff, RefreshCw, Rocket, Sparkles, XCircle,
} from 'lucide-react';
import {
  api, type ApiError, type PlaybookBlocker, type PlaybookConfidence, type PlaybookDraft, type PlaybookEffort, type PlaybookKind,
  type PlaybookOpportunity, type PlaybookResult, type PlaybookStatus, type PlaybookSummarySite, type PlaybookView,
} from '../api';
import { Modal } from '../components/Modal';
import { SortTh, useSort } from '../components/SortableTable';
import { useApp } from '../AppContext';
import { useInsights } from '../insights/InsightsContext';
import { useWorkspace } from '../workspace/WorkspaceContext';

// ── Labels and helpers ────────────────────────────────────────────────────────

const KIND_LABEL: Record<PlaybookKind, string> = {
  ctr_gap: 'Snippet',
  striking_distance: 'Striking distance',
  cannibalisation: 'Cannibalisation',
  content_decay: 'Content decay',
};
const KINDS: PlaybookKind[] = ['ctr_gap', 'striking_distance', 'cannibalisation', 'content_decay'];
const EFFORT_LABEL: Record<PlaybookEffort, string> = { S: '~1 h', M: '~½ day', L: 'days' };
const EFFORT_RANK: Record<PlaybookEffort, number> = { S: 1, M: 2, L: 3 };
const CONFIDENCE_RANK: Record<PlaybookConfidence, number> = { high: 3, medium: 2, low: 1 };
const CONFIDENCE_CLASS: Record<PlaybookConfidence, string> = { high: 'badge-ok', medium: 'badge-warn', low: '' };
const BLOCKER_CHIP: Record<PlaybookBlocker['kind'], { label: string; cls: string }> = {
  index_blocker: { label: 'Fix first', cls: 'badge-error' },
  site_wide_decline: { label: 'Site-wide', cls: 'badge-warn' },
  vitals: { label: 'Protect', cls: 'badge-info' },
};
const MIN_VISIBLE_HIGH = 10;

const pathOf = (url: string) => (url || '').replace(/^https?:\/\/[^/]+/, '') || '/';
const fmtInt = (n: number) => Math.round(n).toLocaleString();
const fmtRange = (low: number, high: number) => `+${fmtInt(low)}–${fmtInt(high)}`;
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
const fmtPos = (v: number) => v.toFixed(1);

function relative(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return formatDistanceToNow(date, { addSuffix: true });
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

interface EvidenceQuery {
  query: string; impressions?: number; clicks?: number; position?: number; expectedCtr?: number; gainLow?: number; gainHigh?: number;
  primaryPosition?: number; secondaryPosition?: number; primaryClicks?: number; secondaryClicks?: number;
}

function evidenceQueries(evidence: Record<string, unknown>): EvidenceQuery[] {
  const raw = evidence?.queries;
  if (!Array.isArray(raw)) return [];
  return raw.filter((row): row is EvidenceQuery => !!row && typeof row === 'object' && isText((row as { query?: unknown }).query));
}

// ── Small pieces ──────────────────────────────────────────────────────────────

function KindChip({ kind }: { kind: PlaybookKind }) {
  return <span className={`playbook-kind playbook-kind-${kind}`}>{KIND_LABEL[kind] ?? kind}</span>;
}

function ConfidenceBadge({ value }: { value: PlaybookConfidence }) {
  return <span className={`badge ${CONFIDENCE_CLASS[value] ?? ''}`.trim()}>{value} confidence</span>;
}

function CopyButton({ text, label = 'Copy', onCopy }: { text: string; label?: string; onCopy: (text: string) => void }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm playbook-copy" onClick={() => onCopy(text)} aria-label={`${label}: ${text.slice(0, 40)}`}>
      <Copy size={12} /> {label}
    </button>
  );
}

function StatusBadges({ opp }: { opp: PlaybookOpportunity }) {
  return (
    <>
      {opp.status === 'dismissed' && <span className="badge">Dismissed</span>}
      {opp.status === 'done' && <span className="badge badge-ok">Done</span>}
      {opp.changed === 1 && <span className="badge badge-info" title="The page changed since this was first seen">Changed</span>}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PlaybookPage() {
  const { siteScope, setSiteScope } = useInsights();
  const [searchParams] = useSearchParams();
  const requestedSite = searchParams.get('site');

  useEffect(() => {
    if (requestedSite && requestedSite !== siteScope) setSiteScope(requestedSite);
  }, [requestedSite, siteScope, setSiteScope]);

  if (siteScope === 'all' || siteScope === 'workspace') return <PlaybookOverview onPick={setSiteScope} />;
  return <SitePlaybook siteId={siteScope} />;
}

// ── All-sites overview ────────────────────────────────────────────────────────

function PlaybookOverview({ onPick }: { onPick: (siteId: string) => void }) {
  const { toast } = useApp();
  const [sites, setSites] = useState<PlaybookSummarySite[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getPlaybookSummary()
      .then(result => { if (!cancelled) setSites(result.sites); })
      .catch(error => { if (!cancelled) { setSites([]); toast('error', errorMessage(error, 'Failed to load the ranking playbook')); } });
    return () => { cancelled = true; };
  }, [toast]);

  if (!sites) return <div className="page-loading">Loading ranking playbook…</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Ranking playbook</h1>
          <p className="page-subtitle">Concrete changes ranked by the clicks they should gain, per website. Pick a website to see the full list.</p>
        </div>
      </div>
      {sites.length === 0 ? (
        <div className="empty-note">No websites yet. Add a website with Search Console access to build its playbook.</div>
      ) : (
        <div className="playbook-site-grid">
          {sites.map(site => {
            const summary = site.summary;
            return (
              <div key={site.id} className="panel playbook-site-card">
                <div className="playbook-site-head">
                  <div>
                    <div className="playbook-site-name">{site.name}</div>
                    <div className="text-dim playbook-meta">{site.domain} · {site.computedAt ? `computed ${relative(site.computedAt)}` : 'not computed yet'}</div>
                  </div>
                </div>
                {summary ? (
                  <p className="playbook-site-summary">
                    <strong>{summary.counted}</strong> {summary.counted === 1 ? 'opportunity' : 'opportunities'} · estimated <strong>{fmtRange(summary.low, summary.high)}</strong> clicks/month
                    {summary.blockers > 0 && <> · <span className="text-error">{summary.blockers} blocker{summary.blockers === 1 ? '' : 's'}</span></>}
                  </p>
                ) : (
                  <p className="text-dim playbook-meta">The first playbook appears after the nightly run once Search Console data has synced.</p>
                )}
                {site.top.length > 0 && (
                  <ol className="playbook-top-list">
                    {site.top.slice(0, 3).map(item => (
                      <li key={item.id}>
                        <span className="cell-url" title={item.page}>{pathOf(item.page)}</span>
                        <span>{item.headline}</span>
                        <b>{fmtRange(item.low, item.high)}/mo</b>
                      </li>
                    ))}
                  </ol>
                )}
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => onPick(site.id)}>
                  Open playbook <ArrowRight size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Single-site playbook ──────────────────────────────────────────────────────

type Row = {
  id: string; rank: number; kind: string; page: string; headline: string; high: number; low: number;
  effort: number; confidence: number; opp: PlaybookOpportunity; alsoOnPage: number;
};

function SitePlaybook({ siteId }: { siteId: string }) {
  const { toast } = useApp();
  const { active } = useWorkspace();
  const canManage = !!active?.permissions?.manage_sites;
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<PlaybookView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [kindFilter, setKindFilter] = useState<'all' | PlaybookKind>('all');
  const [showHidden, setShowHidden] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try { setView(await api.getPlaybook(siteId)); }
    catch (error) { setView(null); setLoadError(errorMessage(error, 'Failed to load the ranking playbook')); }
    setLoading(false);
  }, [siteId]);

  useEffect(() => { void load(); }, [load]);

  // Deep link: /insights/playbook?site=…&opportunity=… opens that item's details.
  const requestedOpportunity = searchParams.get('opportunity');
  useEffect(() => {
    if (!view || !requestedOpportunity) return;
    if (view.opportunities.some(o => o.id === requestedOpportunity)) setSelectedId(requestedOpportunity);
  }, [view, requestedOpportunity]);

  function closeDetails() {
    setSelectedId(null);
    if (requestedOpportunity) {
      const next = new URLSearchParams(searchParams);
      next.delete('opportunity');
      setSearchParams(next, { replace: true });
    }
  }

  function patchOpportunity(next: PlaybookOpportunity) {
    setView(current => current ? { ...current, opportunities: current.opportunities.map(o => o.id === next.id ? next : o) } : current);
  }

  async function refresh() {
    setRefreshing(true);
    try {
      setView(await api.refreshPlaybook(siteId));
      toast('success', 'Playbook refreshed from Google Search Console');
    } catch (error) {
      toast('error', errorMessage(error, 'Refresh failed'));
    }
    setRefreshing(false);
  }

  async function setStatus(opp: PlaybookOpportunity, status: PlaybookStatus) {
    setBusy(`${opp.id}:${status}`);
    try {
      const result = await api.setPlaybookStatus(siteId, opp.id, status);
      patchOpportunity(result.opportunity);
      toast('success', status === 'done' ? 'Marked done — results will be measured after 31 days' : status === 'dismissed' ? 'Opportunity dismissed' : 'Opportunity reopened');
      if (status !== 'open') closeDetails();
    } catch (error) {
      toast('error', errorMessage(error, 'Could not update the opportunity'));
    }
    setBusy(null);
  }

  async function draft(opp: PlaybookOpportunity) {
    setBusy(`${opp.id}:draft`);
    try {
      const result = await api.draftPlaybookFix(siteId, opp.id);
      patchOpportunity(result.opportunity);
      toast('success', 'Draft ready — review it before publishing');
    } catch (error) {
      const status = (error as ApiError).status;
      const message = errorMessage(error, 'Drafting failed');
      toast('error', status === 400 ? `${message} Add a provider under Settings → API keys.` : message);
    }
    setBusy(null);
  }

  async function sendToWork(opp: PlaybookOpportunity) {
    setBusy(`${opp.id}:work`);
    try {
      const result = await api.sendPlaybookToWork(siteId, opp.id);
      patchOpportunity(result.opportunity);
      toast('success', 'Sent to Work — it now appears in the Action Centre');
    } catch (error) {
      toast('error', errorMessage(error, 'Could not send to Work'));
    }
    setBusy(null);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast('success', 'Copied to clipboard');
    } catch {
      toast('error', 'Clipboard is unavailable in this browser');
    }
  }

  const opportunities = useMemo(() => view?.opportunities ?? [], [view]);
  const openByPage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const opp of opportunities) if (opp.status === 'open') counts.set(opp.page, (counts.get(opp.page) ?? 0) + 1);
    return counts;
  }, [opportunities]);

  // Dismissed, hidden and very small items only show when the toggle is on.
  const base = useMemo(() => opportunities.filter(opp => {
    if (opp.status === 'done' || opp.status === 'resolved') return false;
    if (showHidden) return true;
    return opp.status === 'open' && opp.hidden !== 1 && opp.high >= MIN_VISIBLE_HIGH;
  }), [opportunities, showHidden]);
  const kindCounts = useMemo(() => {
    const counts: Record<string, number> = { all: base.length };
    for (const opp of base) counts[opp.kind] = (counts[opp.kind] ?? 0) + 1;
    return counts;
  }, [base]);
  const rows = useMemo<Row[]>(() => base
    .filter(opp => kindFilter === 'all' || opp.kind === kindFilter)
    .map((opp, index) => ({
      id: opp.id, rank: index + 1, kind: KIND_LABEL[opp.kind] ?? opp.kind, page: pathOf(opp.page), headline: opp.headline,
      high: opp.high, low: opp.low, effort: EFFORT_RANK[opp.effort] ?? 9, confidence: CONFIDENCE_RANK[opp.confidence] ?? 0, opp,
      alsoOnPage: Math.max((openByPage.get(opp.page) ?? 0) - (opp.status === 'open' ? 1 : 0), 0),
    })), [base, kindFilter, openByPage]);
  const { sorted, sort, requestSort } = useSort(rows);
  const selected = selectedId ? opportunities.find(o => o.id === selectedId) ?? null : null;

  if (loading && !view) return <div className="page-loading">Loading ranking playbook…</div>;
  if (!view) return <div className="alert alert-error"><div className="alert-content">{loadError || 'This website has no playbook yet.'}</div></div>;

  const summary = view.summary;
  const ready = !!view.computedAt && !!summary;
  const kindBreakdown = summary ? KINDS.filter(kind => (summary.kinds[kind] ?? 0) > 0).map(kind => `${summary.kinds[kind]} ${KIND_LABEL[kind].toLowerCase()}`).join(' · ') : '';
  const workLink = `/actions?site=${encodeURIComponent(siteId)}`;

  return (
    <div className="playbook-page">
      <div className="page-header flex items-center gap-2" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 className="page-title">Ranking playbook</h1>
          <p className="page-subtitle">{view.site.name} · {view.computedAt ? `computed ${relative(view.computedAt)}` : 'not computed yet'}</p>
        </div>
        {canManage && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={refreshing} onClick={refresh}>
            {refreshing ? <><span className="spinner" /> Refreshing…</> : <><RefreshCw size={12} /> Refresh from Google</>}
          </button>
        )}
      </div>

      {ready && summary ? (
        <div className="playbook-tiles">
          <div className="playbook-tile">
            <small>Opportunities</small>
            <strong>{summary.counted}</strong>
            <span>{kindBreakdown || 'No opportunities counted yet'}</span>
          </div>
          <div className="playbook-tile">
            <small>Estimated upside</small>
            <strong>{fmtRange(summary.low, summary.high)}</strong>
            <span>estimated clicks/month{summary.capped && <> · <em title="The total is capped relative to the site's current clicks so estimates stay realistic">capped</em></>}</span>
          </div>
          <div className="playbook-tile">
            <small>Quick wins</small>
            <strong>{summary.quickWins.count}</strong>
            <span>{summary.quickWins.count > 0 ? `${fmtRange(summary.quickWins.low, summary.quickWins.high)} clicks/month · about an hour each` : 'None right now'}</span>
          </div>
          <DataReadiness view={view} />
        </div>
      ) : (
        <DayOneEmptyState view={view} />
      )}

      {view.blockers.length > 0 && (
        <div className="playbook-blockers" aria-label="Blockers">
          {view.blockers.map((blocker, index) => {
            const chip = BLOCKER_CHIP[blocker.kind] ?? { label: blocker.kind, cls: '' };
            return (
              <div key={`${blocker.kind}-${blocker.page ?? index}`} className="playbook-blocker">
                <span className={`badge ${chip.cls}`.trim()}>{chip.label}</span>
                <div className="playbook-blocker-body">
                  <strong>{blocker.headline}</strong>
                  <small className="text-dim">{blocker.page ? <><span className="cell-url" title={blocker.page}>{pathOf(blocker.page)}</span> · </> : null}{blocker.detail}</small>
                </div>
                {isNum(blocker.atStake) && <span className="playbook-at-stake">~{fmtInt(blocker.atStake)} clicks/month at stake</span>}
                <Link to={workLink} className="btn btn-ghost btn-sm">Open Work <ArrowRight size={12} /></Link>
              </div>
            );
          })}
        </div>
      )}

      {ready && (
        <>
          <div className="playbook-filters">
            <div className="playbook-chips" role="group" aria-label="Filter by kind">
              {(['all', ...KINDS] as const).map(kind => (
                <button key={kind} type="button" className={`playbook-chip${kindFilter === kind ? ' active' : ''}`} onClick={() => setKindFilter(kind)}>
                  {kind === 'all' ? 'All' : KIND_LABEL[kind]} <b>{kindCounts[kind] ?? 0}</b>
                </button>
              ))}
            </div>
            <label className="playbook-toggle">
              <input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />
              {showHidden ? <EyeOff size={12} /> : <Eye size={12} />} Show hidden and small items
            </label>
          </div>

          <div className="panel playbook-table-panel">
            {sorted.length === 0 ? (
              <div className="empty-note"><CheckCircle2 size={12} /> {base.length === 0 ? 'No open opportunities right now. New ones appear after each nightly run.' : 'Nothing matches this filter.'}</div>
            ) : (
              <div className="table-wrap">
                <table className="mini-table playbook-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <SortTh label="Kind" sortKey="kind" sort={sort} onSort={requestSort} />
                      <SortTh label="Page" sortKey="page" sort={sort} onSort={requestSort} />
                      <th>What to do</th>
                      <SortTh label="Estimated clicks/month" sortKey="high" sort={sort} onSort={requestSort} align="right" />
                      <SortTh label="Effort" sortKey="effort" sort={sort} onSort={requestSort} />
                      <SortTh label="Confidence" sortKey="confidence" sort={sort} onSort={requestSort} />
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(row => (
                      <tr key={row.id} className={row.opp.status === 'dismissed' ? 'playbook-row-dismissed' : ''}>
                        <td className="text-dim">{row.rank}</td>
                        <td>
                          <KindChip kind={row.opp.kind} />
                          {row.alsoOnPage > 0 && <span className="playbook-also" title="Another open opportunity targets this page">+{row.alsoOnPage} also</span>}
                        </td>
                        <td className="cell-url" title={row.opp.page}>{row.page}</td>
                        <td>
                          {row.headline}{' '}
                          <StatusBadges opp={row.opp} />
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {row.opp.counted === 0
                            ? <span className="text-dim" title="also on this page; not added to the total">{fmtRange(row.low, row.high)}</span>
                            : <strong>{fmtRange(row.low, row.high)}</strong>}
                        </td>
                        <td>{EFFORT_LABEL[row.opp.effort] ?? row.opp.effort}</td>
                        <td><ConfidenceBadge value={row.opp.confidence} /></td>
                        <td><button type="button" className="btn btn-secondary btn-sm" onClick={() => setSelectedId(row.id)}>Details</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <ResultsPanel results={view.results} />
        </>
      )}

      {view.methodology && <p className="text-dim playbook-methodology">{view.methodology}</p>}

      {selected && (
        <OpportunityModal
          opp={selected}
          siteId={siteId}
          canManage={canManage}
          busy={busy}
          onClose={closeDetails}
          onCopy={copy}
          onStatus={setStatus}
          onDraft={draft}
          onSendToWork={sendToWork}
        />
      )}
    </div>
  );
}

// ── Data readiness ────────────────────────────────────────────────────────────

function readinessItems(view: PlaybookView) {
  const data = view.data;
  const coverage = Math.round((data.inventoryCoverage ?? 0) * 100);
  const sync = data.querySync;
  return [
    {
      ok: data.searchConsoleDays >= 56,
      label: `Search Console history: ${data.searchConsoleDays} day${data.searchConsoleDays === 1 ? '' : 's'}`,
      note: data.searchConsoleDays >= 56 ? 'enough for content decay' : '56 days needed for content decay',
    },
    {
      ok: data.queryRows > 0 && !sync?.error,
      label: `Query rows synced: ${fmtInt(data.queryRows)}`,
      note: sync?.error ? `sync error: ${sync.error}` : sync?.truncated ? 'truncated — Google returned more rows than were stored' : sync?.success_at ? `last sync ${relative(sync.success_at)}` : 'not synced yet',
      warn: !!sync?.truncated,
    },
    { ok: coverage >= 90, label: `Inventory coverage: ${coverage}%`, note: coverage >= 90 ? 'internal links mapped' : 'mapping continues each run' },
    { ok: data.inspected > 0, label: `Pages inspected: ${fmtInt(data.inspected)} of ${fmtInt(data.sitemapPages)}`, note: data.inspected > 0 ? 'index status known' : 'no URL inspections yet' },
    { ok: data.cruxConfigured, label: data.cruxConfigured ? 'CrUX key configured' : 'CrUX key not configured', note: data.cruxConfigured ? 'Core Web Vitals blockers enabled' : 'optional — enables Core Web Vitals blockers' },
  ];
}

function ReadinessList({ view }: { view: PlaybookView }) {
  return (
    <ul className="playbook-readiness">
      {readinessItems(view).map(item => (
        <li key={item.label} className={item.ok ? (item.warn ? 'warn' : 'ok') : 'pending'}>
          {item.ok && !item.warn ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
          <span>{item.label}<small>{item.note}</small></span>
        </li>
      ))}
    </ul>
  );
}

function DataReadiness({ view }: { view: PlaybookView }) {
  const items = readinessItems(view);
  const okCount = items.filter(item => item.ok && !item.warn).length;
  return (
    <div className="playbook-tile playbook-tile-readiness">
      <small>Data readiness</small>
      <strong>{okCount}/{items.length}</strong>
      <ReadinessList view={view} />
    </div>
  );
}

function DayOneEmptyState({ view }: { view: PlaybookView }) {
  return (
    <div className="panel playbook-empty">
      <div className="playbook-empty-copy">
        <span className="eyebrow"><Rocket size={13} /> Day one</span>
        <h2>Your first playbook arrives after the nightly run.</h2>
        <p>
          Once Search Console data has synced, this page lists concrete changes — snippet rewrites, pages within striking distance of page one,
          cannibalisation to consolidate and decaying content to refresh — each with an estimated monthly click range, effort and confidence.
        </p>
        <ul className="playbook-connect-list">
          <li className={view.site.googleConnected ? 'ok' : 'pending'}>
            {view.site.googleConnected ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            <span>{view.site.googleConnected ? 'Google account connected' : <>Connect a Google account with Search Console access in <Link to="/settings?tab=accounts">Settings → Google accounts</Link></>}</span>
          </li>
          <li className={view.data.sitemapPages > 0 ? 'ok' : 'pending'}>
            {view.data.sitemapPages > 0 ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            <span>{view.data.sitemapPages > 0 ? `Sitemap read (${fmtInt(view.data.sitemapPages)} pages)` : <>Add a sitemap so pages can be inventoried in <Link to="/sites">Sites</Link></>}</span>
          </li>
          <li className={view.data.cruxConfigured ? 'ok' : 'pending'}>
            {view.data.cruxConfigured ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
            <span>{view.data.cruxConfigured ? 'CrUX key configured' : <>Optional: add a CrUX API key in <Link to="/settings?tab=keys">Settings → API keys</Link> to flag Core Web Vitals on traffic pages</>}</span>
          </li>
        </ul>
      </div>
      <div className="playbook-empty-readiness">
        <div className="panel-title">Data readiness</div>
        <ReadinessList view={view} />
      </div>
    </div>
  );
}

// ── Results ───────────────────────────────────────────────────────────────────

function ResultsPanel({ results }: { results: PlaybookResult[] }) {
  return (
    <div className="panel playbook-results">
      <h3 className="panel-title"><CheckCircle2 size={13} /> Results</h3>
      <p className="text-dim playbook-meta">Done items are measured 31 days after completion. Realised clicks are site-adjusted, so a site-wide rise or fall does not count for or against a change.</p>
      {results.length === 0 ? (
        <div className="empty-note">Nothing marked done yet. Mark an opportunity done and its result appears here a month later.</div>
      ) : (
        <div className="table-wrap">
          <table className="mini-table">
            <thead><tr><th>Page</th><th>Change</th><th>Done</th><th style={{ textAlign: 'right' }}>Estimate</th><th style={{ textAlign: 'right' }}>Realised</th><th>Outcome</th></tr></thead>
            <tbody>
              {results.map(result => (
                <tr key={result.id}>
                  <td className="cell-url" title={result.page}>{pathOf(result.page)}</td>
                  <td><KindChip kind={result.kind} /> {result.headline}</td>
                  <td>{shortDate(result.doneAt)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtRange(result.low, result.high)}/mo</td>
                  <td style={{ textAlign: 'right' }}>
                    {result.status === 'measured' && isNum(result.realised)
                      ? <strong className={result.realised >= 0 ? 'text-ok' : 'text-error'}>{result.realised >= 0 ? '+' : '−'}{fmtInt(Math.abs(result.realised))} clicks/month</strong>
                      : <span className="text-dim">measuring, ready {shortDate(result.readyOn)}</span>}
                  </td>
                  <td>
                    {result.status !== 'measured' ? <span className="badge badge-warn">Measuring</span>
                      : result.withinRange ? <span className="badge badge-ok">Inside range</span>
                      : <span className="badge badge-error">Below range</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Detail modal ──────────────────────────────────────────────────────────────

function OpportunityModal({ opp, siteId, canManage, busy, onClose, onCopy, onStatus, onDraft, onSendToWork }: {
  opp: PlaybookOpportunity; siteId: string; canManage: boolean; busy: string | null;
  onClose: () => void; onCopy: (text: string) => void;
  onStatus: (opp: PlaybookOpportunity, status: PlaybookStatus) => void;
  onDraft: (opp: PlaybookOpportunity) => void; onSendToWork: (opp: PlaybookOpportunity) => void;
}) {
  const evidence = opp.evidence ?? {};
  const queries = evidenceQueries(evidence);
  const cannibal = opp.kind === 'cannibalisation';
  const hasExpected = queries.some(q => isNum(q.expectedCtr));
  const hasGain = queries.some(q => isNum(q.gainLow) || isNum(q.gainHigh));
  const workLink = `/actions?site=${encodeURIComponent(siteId)}`;
  const isBusy = (action: string) => busy === `${opp.id}:${action}`;
  const anyBusy = busy != null && busy.startsWith(`${opp.id}:`);

  const keyNumbers: Array<[string, string]> = [];
  if (opp.secondary_page) keyNumbers.push(['Secondary page', opp.secondary_page]);
  if (isText(evidence.currentTitle)) keyNumbers.push(['Current title', evidence.currentTitle]);
  if (isText(evidence.currentH1)) keyNumbers.push(['Current H1', evidence.currentH1]);
  if (isText(evidence.oldTitle) || isText(evidence.newTitle)) keyNumbers.push(['Title change', `${isText(evidence.oldTitle) ? evidence.oldTitle : '—'} → ${isText(evidence.newTitle) ? evidence.newTitle : '—'}`]);
  if (isNum(evidence.baselineClicks) || isNum(evidence.currentClicks)) keyNumbers.push(['Clicks (baseline → now)', `${isNum(evidence.baselineClicks) ? fmtInt(evidence.baselineClicks) : '—'} → ${isNum(evidence.currentClicks) ? fmtInt(evidence.currentClicks) : '—'}`]);
  if (isNum(evidence.baselinePosition) || isNum(evidence.currentPosition)) keyNumbers.push(['Position (baseline → now)', `${isNum(evidence.baselinePosition) ? fmtPos(evidence.baselinePosition) : '—'} → ${isNum(evidence.currentPosition) ? fmtPos(evidence.currentPosition) : '—'}`]);
  if (isNum(evidence.sharedQueries)) keyNumbers.push(['Shared queries', fmtInt(evidence.sharedQueries)]);
  if (isNum(evidence.sharedSearches)) keyNumbers.push(['Shared searches', fmtInt(evidence.sharedSearches)]);
  if (Array.isArray(evidence.missingTerms) && evidence.missingTerms.length) keyNumbers.push(['Terms missing from the title', evidence.missingTerms.filter(isText).join(', ')]);
  if (isNum(evidence.inbound)) keyNumbers.push(['Internal links in', fmtInt(evidence.inbound)]);
  if (isNum(evidence.words)) keyNumbers.push(['Word count', fmtInt(evidence.words)]);

  const footer = (
    <>
      <button type="button" className="btn btn-secondary" onClick={onClose} data-autofocus>Close</button>
      {canManage && (
        <>
          {opp.status === 'dismissed'
            ? <button type="button" className="btn btn-ghost" disabled={anyBusy} onClick={() => onStatus(opp, 'open')}>{isBusy('open') ? 'Reopening…' : 'Reopen'}</button>
            : <button type="button" className="btn btn-ghost" disabled={anyBusy || opp.status === 'done'} onClick={() => onStatus(opp, 'dismissed')}>{isBusy('dismissed') ? 'Dismissing…' : 'Dismiss'}</button>}
          <button type="button" className="btn btn-secondary" disabled={anyBusy || opp.status === 'done'} onClick={() => onStatus(opp, 'done')}>
            <CheckCircle2 size={13} /> {isBusy('done') ? 'Saving…' : opp.status === 'done' ? 'Done' : 'Mark done'}
          </button>
          {opp.work_item_id
            ? <Link to={workLink} className="btn btn-primary" title="Already sent to Work"><BriefcaseBusiness size={13} /> In Work <ExternalLink size={12} /></Link>
            : <button type="button" className="btn btn-primary" disabled={anyBusy} onClick={() => onSendToWork(opp)}><BriefcaseBusiness size={13} /> {isBusy('work') ? 'Sending…' : 'Send to Work'}</button>}
        </>
      )}
      {!canManage && opp.work_item_id && <Link to={workLink} className="btn btn-secondary"><BriefcaseBusiness size={13} /> In Work</Link>}
    </>
  );

  return (
    <Modal
      open
      size="xl"
      onClose={onClose}
      eyebrow={KIND_LABEL[opp.kind] ?? opp.kind}
      title={opp.headline}
      description={`Estimated ${fmtRange(opp.low, opp.high)} clicks a month · ${EFFORT_LABEL[opp.effort] ?? opp.effort} · ${opp.confidence} confidence`}
      footer={footer}
      className="playbook-modal"
    >
      <div className="playbook-detail-page">
        <span className="cell-url" title={opp.page}>{pathOf(opp.page)}</span>
        <a href={opp.page} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm"><ExternalLink size={12} /> Open page</a>
        <StatusBadges opp={opp} />
        {!canManage && <span className="text-dim playbook-meta">Read-only: managing sites is required to change opportunities.</span>}
      </div>

      {queries.length > 0 && (
        <section className="playbook-section">
          <h4>Evidence · queries</h4>
          <div className="table-wrap">
            <table className="mini-table">
              <thead>
                {cannibal ? (
                  <tr><th>Query</th><th style={{ textAlign: 'right' }}>Searches</th><th style={{ textAlign: 'right' }}>Primary pos.</th><th style={{ textAlign: 'right' }}>Secondary pos.</th><th style={{ textAlign: 'right' }}>Primary clicks</th><th style={{ textAlign: 'right' }}>Secondary clicks</th></tr>
                ) : (
                  <tr><th>Query</th><th style={{ textAlign: 'right' }}>Impressions</th><th style={{ textAlign: 'right' }}>Clicks</th><th style={{ textAlign: 'right' }}>Position</th>{hasExpected && <th style={{ textAlign: 'right' }}>Expected CTR</th>}{hasGain && <th style={{ textAlign: 'right' }}>Gain/mo</th>}</tr>
                )}
              </thead>
              <tbody>
                {queries.slice(0, 25).map(q => cannibal ? (
                  <tr key={q.query}>
                    <td>{q.query}</td>
                    <td style={{ textAlign: 'right' }}>{isNum(q.impressions) ? fmtInt(q.impressions) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{isNum(q.primaryPosition) ? fmtPos(q.primaryPosition) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{isNum(q.secondaryPosition) ? fmtPos(q.secondaryPosition) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{isNum(q.primaryClicks) ? fmtInt(q.primaryClicks) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{isNum(q.secondaryClicks) ? fmtInt(q.secondaryClicks) : '—'}</td>
                  </tr>
                ) : (
                  <tr key={q.query}>
                    <td>{q.query}</td>
                    <td style={{ textAlign: 'right' }}>{isNum(q.impressions) ? fmtInt(q.impressions) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{isNum(q.clicks) ? fmtInt(q.clicks) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>{isNum(q.position) ? fmtPos(q.position) : '—'}</td>
                    {hasExpected && <td style={{ textAlign: 'right' }}>{isNum(q.expectedCtr) ? fmtPct(q.expectedCtr) : '—'}</td>}
                    {hasGain && <td style={{ textAlign: 'right' }}>{isNum(q.gainLow) || isNum(q.gainHigh) ? fmtRange(q.gainLow ?? 0, q.gainHigh ?? q.gainLow ?? 0) : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {keyNumbers.length > 0 && (
        <section className="playbook-section">
          <h4>Key numbers</h4>
          <dl className="playbook-key-numbers">
            {keyNumbers.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        </section>
      )}

      {opp.steps.length > 0 && (
        <section className="playbook-section">
          <h4>Steps</h4>
          <ol className="playbook-steps">
            {opp.steps.map((step, index) => (
              <li key={`${index}-${step.text.slice(0, 20)}`}>
                <span>{step.text}</span>
                {isText(step.copy) && <CopyButton text={step.copy} onCopy={onCopy} />}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="playbook-section">
        <h4><Sparkles size={13} /> AI draft</h4>
        {opp.draft ? (
          <DraftView draft={opp.draft} draftAt={opp.draft_at} onCopy={onCopy} />
        ) : (
          <p className="text-dim playbook-meta">No draft yet. The configured AI provider can draft a title, meta description, H1 and content additions from the evidence above. Always review before publishing.</p>
        )}
        {canManage && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={anyBusy} onClick={() => onDraft(opp)}>
            {isBusy('draft') ? <><span className="spinner" /> Drafting…</> : <><Sparkles size={12} /> {opp.draft ? 'Redraft' : 'Draft with AI'}</>}
          </button>
        )}
      </section>
    </Modal>
  );
}

function DraftView({ draft, draftAt, onCopy }: { draft: PlaybookDraft; draftAt: string | null; onCopy: (text: string) => void }) {
  const field = (label: string, value: string, limit?: number) => (
    <div className="playbook-draft-field">
      <div className="playbook-draft-label">
        <span>{label}</span>
        {limit != null && <small className={value.length > limit ? 'text-error' : 'text-dim'}>{value.length}/{limit}</small>}
        {value && <CopyButton text={value} onCopy={onCopy} />}
      </div>
      <p>{value || <span className="text-dim">—</span>}</p>
    </div>
  );
  return (
    <div className="playbook-draft">
      <p className="text-dim playbook-meta">Drafted {relative(draftAt)} by {draft.provider}{draft.model ? ` · ${draft.model}` : ''}. Estimates do not change because a draft exists.</p>
      {draft.needs_edit?.length > 0 && (
        <div className="alert alert-warn">
          <div className="alert-content">
            <div className="alert-title">Needs edit before publishing</div>
            <ul className="playbook-plain-list">{draft.needs_edit.map(item => <li key={item}>{item}</li>)}</ul>
          </div>
        </div>
      )}
      {field('Title', draft.title ?? '', 60)}
      {draft.title_alternatives?.length > 0 && (
        <div className="playbook-draft-field">
          <div className="playbook-draft-label"><span>Title alternatives</span></div>
          <ul className="playbook-plain-list">
            {draft.title_alternatives.map(alt => <li key={alt}>{alt} <small className="text-dim">{alt.length}/60</small> <CopyButton text={alt} onCopy={onCopy} /></li>)}
          </ul>
        </div>
      )}
      {field('Meta description', draft.meta_description ?? '', 155)}
      {field('H1', draft.h1 ?? '')}
      {draft.content_additions?.length > 0 && (
        <div className="playbook-draft-field">
          <div className="playbook-draft-label"><span>Content additions</span></div>
          <ul className="playbook-additions">
            {draft.content_additions.map(addition => (
              <li key={addition.heading}>
                <strong>{addition.heading}</strong> <CopyButton text={addition.heading} onCopy={onCopy} />
                <small>{addition.why}</small>
                {addition.queries?.length > 0 && <div className="playbook-query-chips">{addition.queries.map(query => <span key={query}>{query}</span>)}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {draft.internal_link_anchors?.length > 0 && (
        <div className="playbook-draft-field">
          <div className="playbook-draft-label"><span>Internal link anchors</span></div>
          <ul className="playbook-plain-list">
            {draft.internal_link_anchors.map(link => <li key={`${link.from}-${link.anchor}`}>“{link.anchor}” from <span className="cell-url" title={link.from}>{pathOf(link.from)}</span> <CopyButton text={link.anchor} onCopy={onCopy} /></li>)}
          </ul>
        </div>
      )}
      {isText(draft.rationale) && field('Rationale', draft.rationale)}
      {draft.unsure?.length > 0 && (
        <div className="playbook-draft-field">
          <div className="playbook-draft-label"><span>The model was unsure about</span></div>
          <ul className="playbook-plain-list">{draft.unsure.map(item => <li key={item}>{item}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
