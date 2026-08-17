import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock, CheckCircle2, ChevronRight, CircleAlert, ClipboardCheck, Clock3, Copy, ExternalLink,
  FileText, Filter, Globe2, Plus, RefreshCw, RotateCcw, Search, ShieldCheck, Sparkles, UserRound, X,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { api, type Site, type WorkItem, type WorkspaceMember } from '../api';
import { Modal } from '../components/Modal';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { useToast } from '../AppContext';

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const STATUS_LABEL: Record<string, string> = { open: 'Open', in_progress: 'In progress', done: 'Done', dismissed: 'Dismissed' };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pageUrls(item: WorkItem): string[] {
  const evidence = item.evidence || {}; const values: unknown[] = [item.page_url, evidence.url, evidence.target];
  if (Array.isArray(evidence.urls)) values.push(...evidence.urls);
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value)))];
}

function evidenceValue(value: unknown): string {
  if (value == null || value === '') return 'Not supplied';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = Array.isArray(value) ? value.map(entry => typeof entry === 'object' ? JSON.stringify(entry) : String(entry)).join('\n') :
    typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  return text.length > 6_000 ? `${text.slice(0, 6_000)}\n…` : text;
}

function evidenceRows(item: WorkItem): Array<[string, string]> {
  return Object.entries(item.evidence || {}).filter(([key]) => key !== 'remediation').map(([key, value]) => [key.replaceAll('_', ' '), evidenceValue(value)]);
}

function issueBrief(item: WorkItem, pageUrl = item.page_url || ''): string {
  const evidence = evidenceRows(item).map(([key, value]) => `- ${key}: ${value}`).join('\n');
  return [
    'SEO / GEO remediation brief',
    `Website: ${item.site_name || item.site_domain || 'Workspace-wide'}`,
    item.site_domain ? `Domain: ${item.site_domain}` : '',
    `Page: ${pageUrl || 'Site-wide / no page URL attached'}`,
    `Priority: ${item.severity}`,
    `Source: ${item.source.replaceAll('_', ' ')}`,
    `Issue: ${item.title}`,
    `Details: ${item.description || 'No additional description supplied.'}`,
    '',
    'Observed evidence:',
    evidence || '- No structured evidence supplied.',
    '',
    'Task:',
    'Diagnose the root cause, propose the smallest safe fix, explain how to verify it, and preserve existing behaviour that is unrelated to this issue.',
  ].filter((line, index, lines) => line || lines[index - 1] !== '').join('\n').slice(0, 12_000);
}

export default function ActionCenterPage() {
  const { active } = useWorkspace(); const toast = useToast();
  const canManage = !!active?.permissions?.manage_content;
  const [items, setItems] = useState<WorkItem[]>([]); const [members, setMembers] = useState<WorkspaceMember[]>([]); const [sites, setSites] = useState<Site[]>([]);
  const [timeline, setTimeline] = useState<Array<{ id: string; kind: string; title: string; note: string | null; event_at: string }>>([]);
  const [status, setStatus] = useState('active'); const [siteFilter, setSiteFilter] = useState('all'); const [query, setQuery] = useState(''); const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null); const [composer, setComposer] = useState(false); const [detail, setDetail] = useState<WorkItem | null>(null);
  const [pageTarget, setPageTarget] = useState(''); const [remediationNote, setRemediationNote] = useState('');
  const [draft, setDraft] = useState({ title: '', description: '', severity: 'medium', assignee_user_id: '', due_at: '', site_id: '', page_url: '' });

  const load = useCallback(async () => {
    const [work, events, people, websites] = await Promise.all([
      api.getWorkItems({ include_snoozed: status === 'all', limit: 300 }), api.getTimeline(),
      active ? api.getWorkspaceMembers(active.id) : Promise.resolve([]), api.getSites(),
    ]);
    setItems(work); setTimeline(events); setMembers(people); setSites(websites);
    setDetail(current => current ? work.find(item => item.id === current.id) || null : null);
  }, [active, status]);
  useEffect(() => { load().catch(() => null); }, [load]);

  const visible = useMemo(() => items.filter(item => {
    if (status === 'active' && ['done', 'dismissed'].includes(item.status)) return false;
    if (status !== 'active' && status !== 'all' && item.status !== status) return false;
    if (siteFilter !== 'all' && (siteFilter === 'workspace' ? !!item.site_id : item.site_id !== siteFilter)) return false;
    const haystack = `${item.title} ${item.description ?? ''} ${item.source} ${item.site_name ?? ''} ${item.site_domain ?? ''} ${item.page_url ?? ''} ${JSON.stringify(item.evidence)}`;
    return haystack.toLowerCase().includes(query.toLowerCase());
  }), [items, status, siteFilter, query]);
  const counts = useMemo(() => ({
    critical: items.filter(i => i.severity === 'critical' && !['done', 'dismissed'].includes(i.status)).length,
    open: items.filter(i => i.status === 'open').length, progress: items.filter(i => i.status === 'in_progress').length,
    done: items.filter(i => i.status === 'done').length,
  }), [items]);

  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); toast('success', `${label} copied`); }
    catch { toast('error', 'Your browser blocked clipboard access.'); }
  }
  function review(item: WorkItem) {
    setDetail(item); setPageTarget(pageUrls(item)[0] || ''); setRemediationNote('');
  }
  async function update(id: string, changes: Parameters<typeof api.updateWorkItem>[1]) {
    setBusy(id); try { const updated = await api.updateWorkItem(id, changes); setDetail(current => current?.id === id ? updated : current); await load(); toast('success', 'Action updated'); }
    catch (error) { toast('error', String(error).replace('Error: ', '')); } setBusy(null);
  }
  async function remediate(action: 'mark_fixed' | 'google_validate' | 'resolve' | 'reopen') {
    if (!detail) return; setBusy(`remediation:${action}`);
    try {
      const result = await api.remediateWorkItem(detail.id, { action, note: remediationNote.trim() || undefined, page_url: pageTarget || undefined });
      setDetail(result.item); setRemediationNote(''); await load();
      const message = action === 'google_validate' ? result.verified ? 'Google currently reports this page as indexed' : 'Google check completed — review the returned evidence' :
        action === 'mark_fixed' ? 'Fix deployment recorded' : action === 'resolve' ? 'Action resolved with proof retained' : 'Action reopened';
      toast(result.verified === false && action === 'google_validate' ? 'info' : 'success', message);
    } catch (error) { toast('error', String(error).replace('Error: ', '')); }
    setBusy(null);
  }
  async function bulkDone() {
    setBusy('bulk'); try {
      const preview = await api.bulkWorkItems(selected, { status: 'done' }, true); const affected = preview.affected ?? 0;
      if (!confirm(`Mark ${affected} action${affected === 1 ? '' : 's'} complete? This preview has not changed anything yet.`)) { setBusy(null); return; }
      await api.bulkWorkItems(selected, { status: 'done' }); setSelected([]); await load(); toast('success', 'Selected actions completed');
    } catch (error) { toast('error', String(error).replace('Error: ', '')); } setBusy(null);
  }
  async function create() {
    if (!draft.title.trim()) return; setBusy('create');
    try {
      await api.createWorkItem({ ...draft, severity: draft.severity as WorkItem['severity'], site_id: draft.site_id || undefined,
        page_url: draft.page_url || undefined, assignee_user_id: draft.assignee_user_id || undefined, due_at: draft.due_at || undefined, title: draft.title });
      setDraft({ title: '', description: '', severity: 'medium', assignee_user_id: '', due_at: '', site_id: '', page_url: '' });
      setComposer(false); await load(); toast('success', 'Action created');
    } catch (error) { toast('error', String(error).replace('Error: ', '')); } setBusy(null);
  }

  const detailPages = detail ? pageUrls(detail) : [];
  const remediation = detail ? asRecord(detail.evidence.remediation) : {};
  const google = asRecord(remediation.google); const inspection = asRecord(google.inspection); const sitemap = asRecord(google.sitemap);
  const fixStatus = typeof remediation.fix_status === 'string' ? remediation.fix_status : '';

  return <div className="ops-page action-centre-page">
    <header className="ops-page-header"><div><span className="eyebrow"><ClipboardCheck size={13}/> Remediation workspace</span><h1>Action centre</h1><p>See the affected website and page, copy a complete repair brief, verify the result with Google, and retain the evidence.</p></div><button className="btn btn-primary" disabled={!canManage} onClick={() => setComposer(true)}><Plus size={15}/> New action</button></header>
    <section className="ops-stat-strip">
      <button onClick={() => setStatus('active')}><CircleAlert/><span><small>Critical now</small><strong>{counts.critical}</strong></span></button>
      <button onClick={() => setStatus('open')}><Clock3/><span><small>Open</small><strong>{counts.open}</strong></span></button>
      <button onClick={() => setStatus('in_progress')}><UserRound/><span><small>Fixing</small><strong>{counts.progress}</strong></span></button>
      <button onClick={() => setStatus('done')}><CheckCircle2/><span><small>Resolved</small><strong>{counts.done}</strong></span></button>
    </section>
    <div className="ops-split action-split">
      <section className="ops-card action-board">
        <div className="ops-toolbar action-toolbar"><div className="ops-search"><Search size={15}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search issue, website, page or evidence…"/></div><select className="action-site-filter" aria-label="Filter by website" value={siteFilter} onChange={e => setSiteFilter(e.target.value)}><option value="all">All websites</option><option value="workspace">Workspace-wide</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select><div className="ops-segment"><Filter size={13}/>{['active', 'open', 'in_progress', 'done', 'all'].map(value => <button key={value} className={status === value ? 'active' : ''} onClick={() => setStatus(value)}>{value === 'in_progress' ? 'fixing' : value}</button>)}</div></div>
        {selected.length > 0 && <div className="bulk-bar"><strong>{selected.length} selected</strong><button className="btn btn-secondary btn-sm" disabled={!canManage || busy === 'bulk'} onClick={bulkDone}><CheckCircle2 size={13}/> Mark resolved</button><button className="btn-icon btn-icon-ghost" onClick={() => setSelected([])}><X size={14}/></button></div>}
        <div className="work-list">
          {visible.map(item => <article className={`work-item severity-${item.severity}`} key={item.id}>
            <input type="checkbox" aria-label={`Select ${item.title}`} checked={selected.includes(item.id)} onChange={e => setSelected(current => e.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))}/>
            <span className="severity-rail"/><div className="work-copy"><div><span className={`signal-badge ${item.severity}`}>{item.severity}</span><span className="source-badge">{item.source.replaceAll('_', ' ')}</span>{item.site_name && <span className="site-badge"><Globe2 size={11}/>{item.site_name}</span>}{item.due_at && <span className="due-badge"><CalendarClock size={11}/>{new Date(item.due_at).toLocaleDateString()}</span>}</div><h3>{item.title}</h3><p>{item.description || 'No description supplied.'}</p>{item.page_url ? <div className="work-page"><FileText size={13}/><button title="Copy page URL" onClick={() => copy(item.page_url!, 'Page URL')}>{item.page_url}</button><button className="btn-icon btn-icon-ghost" title="Copy page URL" onClick={() => copy(item.page_url!, 'Page URL')}><Copy size={13}/></button><a className="btn-icon btn-icon-ghost" href={item.page_url} target="_blank" rel="noreferrer" title="Open page"><ExternalLink size={13}/></a></div> : <div className="work-page muted"><Globe2 size={13}/>{item.site_id ? 'Site-wide action' : 'Workspace-wide action'}</div>}<footer><span>{item.assignee_name || item.assignee_email || 'Unassigned'}</span><span>{STATUS_LABEL[item.status]}</span><span>Updated {formatDistanceToNow(new Date(item.updated_at), { addSuffix: true })}</span></footer></div>
            <div className="work-controls"><button className="btn btn-secondary btn-sm" onClick={() => copy(issueBrief(item), 'Repair brief')}><Sparkles size={13}/> Copy brief</button><button className="btn btn-primary btn-sm" onClick={() => review(item)}>Review fix <ChevronRight size={14}/></button></div>
          </article>)}
          {!visible.length && <div className="ops-empty"><CheckCircle2/><h3>Nothing waiting in this view</h3><p>New regressions, connector failures and manual actions will land here with their website and evidence.</p></div>}
        </div>
      </section>
      <aside className="ops-card evidence-timeline"><div className="ops-card-head"><div><span className="eyebrow">Causal record</span><h2>Timeline</h2></div><button className="btn btn-ghost btn-sm" onClick={() => setComposer(true)}><Plus size={12}/> Note</button></div><div className="timeline-list">{timeline.slice(0, 18).map(event => <div key={event.id}><i/><time>{new Date(event.event_at).toLocaleDateString()}</time><strong>{event.title}</strong>{event.note && <p>{event.note}</p>}<span>{event.kind}</span></div>)}{!timeline.length && <div className="ops-empty compact">Fixes and Google verification checks appear here.</div>}</div></aside>
    </div>

    {detail && <Modal onClose={() => setDetail(null)} size="xl" className="remediation-modal" title={detail.title} eyebrow="Page remediation" description={detail.description || 'Review the evidence, record the fix and verify the exact page.'} icon={<ShieldCheck/>} footer={<><button className="btn btn-ghost" onClick={() => setDetail(null)}>Close</button>{detail.deep_link && <a className="btn btn-secondary" href={detail.deep_link}>Open source evidence</a>}</>}>
      <div className="remediation-layout"><main>
        <section className="remediation-identity"><div><span className="eyebrow">Affected website</span><strong><Globe2 size={15}/>{detail.site_name || detail.site_domain || 'Workspace-wide'}</strong>{detail.site_domain && <small>{detail.site_domain}</small>}</div><div><span className="eyebrow">Affected page</span>{detailPages.length > 1 ? <select aria-label="Affected page" value={pageTarget} onChange={e => setPageTarget(e.target.value)}>{detailPages.map(url => <option key={url}>{url}</option>)}</select> : pageTarget ? <div className="page-target"><code>{pageTarget}</code><button className="btn-icon btn-icon-ghost" onClick={() => copy(pageTarget, 'Page URL')} title="Copy page URL"><Copy size={14}/></button><a className="btn-icon btn-icon-ghost" href={pageTarget} target="_blank" rel="noreferrer" title="Open page"><ExternalLink size={14}/></a></div> : <p>No page URL is attached. This action can be resolved locally, but Google verification needs an exact page.</p>}</div></section>
        <section className="remediation-section"><div className="remediation-section-head"><div><span className="eyebrow">Ready for your LLM</span><h3>Copyable repair brief</h3></div><button className="btn btn-secondary btn-sm" onClick={() => copy(issueBrief(detail, pageTarget), 'Repair brief')}><Copy size={13}/> Copy brief</button></div><textarea className="repair-brief" readOnly value={issueBrief(detail, pageTarget)} rows={10}/></section>
        <section className="remediation-section"><div className="remediation-section-head"><div><span className="eyebrow">Observed facts</span><h3>Evidence</h3></div></div>{evidenceRows(detail).length ? <div className="evidence-grid">{evidenceRows(detail).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</div> : <p className="muted-copy">No structured evidence was supplied with this action.</p>}</section>
        {Object.keys(google).length > 0 && <section className={`google-proof ${google.verified ? 'passed' : 'attention'}`}><div><span className="eyebrow">Latest Google evidence</span><h3>{google.verified ? 'Page is currently indexed' : inspection.success ? 'Google needs attention' : 'Google check failed'}</h3><p>{String(inspection.coverageState || inspection.indexingState || inspection.message || 'No verdict returned')}</p></div><dl><div><dt>Verdict</dt><dd>{String(inspection.verdict || 'Unknown')}</dd></div><div><dt>Fetch</dt><dd>{String(inspection.pageFetchState || 'Unknown')}</dd></div><div><dt>Robots</dt><dd>{String(inspection.robotsTxtState || 'Unknown')}</dd></div><div><dt>Last crawl</dt><dd>{inspection.lastCrawlTime ? new Date(String(inspection.lastCrawlTime)).toLocaleString() : 'Not returned'}</dd></div><div><dt>Sitemap</dt><dd>{sitemap.success ? 'Re-submitted' : String(sitemap.message || 'Not accepted')}</dd></div>{Boolean(inspection.googleCanonical) && <div><dt>Google canonical</dt><dd>{String(inspection.googleCanonical)}</dd></div>}</dl><small>Checked {google.checked_at ? new Date(String(google.checked_at)).toLocaleString() : 'recently'}</small></section>}
      </main><aside className="remediation-sidebar">
        <section><span className="eyebrow">Resolution flow</span><div className="remediation-steps"><div className="complete"><i>1</i><span><strong>Diagnose</strong><small>Use the evidence or copy the brief.</small></span></div><div className={['deployed', 'verified', 'resolved'].includes(fixStatus) ? 'complete' : ''}><i>2</i><span><strong>Deploy fix</strong><small>Record what changed.</small></span></div><div className={['verified', 'resolved'].includes(fixStatus) ? 'complete' : ''}><i>3</i><span><strong>Check Google</strong><small>Re-submit sitemap and inspect this page.</small></span></div><div className={detail.status === 'done' ? 'complete' : ''}><i>4</i><span><strong>Resolve</strong><small>Close only when the outcome is proven.</small></span></div></div></section>
        <label>Fix / verification note<textarea rows={4} value={remediationNote} onChange={e => setRemediationNote(e.target.value)} placeholder="What changed, deployment reference, or remaining concern…"/></label>
        <div className="remediation-actions"><button className="btn btn-secondary" disabled={!canManage || !!busy || detail.status === 'done'} onClick={() => remediate('mark_fixed')}><CheckCircle2 size={14}/> Record fix deployed</button><button className="btn btn-primary" disabled={!canManage || !!busy || !detail.site_id || !pageTarget || !detail.google_connected} onClick={() => remediate('google_validate')}><RefreshCw className={busy === 'remediation:google_validate' ? 'spin' : ''} size={14}/> Re-submit &amp; check Google</button><p>This re-submits the website sitemap and runs a fresh URL Inspection for the selected page. Google does not expose a general “mark fixed” or reindex API for ordinary pages.</p>{detail.status === 'done' ? <button className="btn btn-secondary" disabled={!canManage || !!busy} onClick={() => remediate('reopen')}><RotateCcw size={14}/> Reopen action</button> : <button className="btn btn-success" disabled={!canManage || !!busy} onClick={() => remediate('resolve')}><ShieldCheck size={14}/> Mark resolved</button>}</div>
        {!detail.google_connected && detail.site_id && <div className="inline-callout warn"><strong>Google account required</strong><p>Connect a Search Console account to this website to run page verification. Workspace members can use the account already linked to the website.</p></div>}
        <section className="remediation-controls"><span className="eyebrow">Ownership</span><label>Status<select value={detail.status} disabled={!canManage || busy === detail.id} onChange={e => update(detail.id, { status: e.target.value })}>{Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Owner<select value={detail.assignee_user_id || ''} disabled={!canManage || busy === detail.id} onChange={e => update(detail.id, { assignee_user_id: e.target.value || null })}><option value="">Unassigned</option>{members.map(member => <option value={member.user_id} key={member.user_id}>{member.name || member.email}</option>)}</select></label><label>Priority<select value={detail.severity} disabled={!canManage || busy === detail.id} onChange={e => update(detail.id, { severity: e.target.value })}>{SEVERITIES.map(value => <option key={value}>{value}</option>)}</select></label><label>Due date<input type="date" value={detail.due_at?.slice(0, 10) || ''} disabled={!canManage || busy === detail.id} onChange={e => update(detail.id, { due_at: e.target.value || null })}/></label></section>
      </aside></div>
    </Modal>}

    {composer && <Modal onClose={() => setComposer(false)} size="lg" title="New action" eyebrow="Create accountable work" description="Attach a website and exact page whenever possible so the fix can be copied, checked and proven." icon={<ClipboardCheck/>} footer={<><button className="btn btn-ghost" onClick={() => setComposer(false)}>Cancel</button><button className="btn btn-primary" disabled={!canManage || busy === 'create' || !draft.title.trim()} onClick={create}>{busy === 'create' ? 'Creating…' : 'Create action'}</button></>}><div className="form-grid"><label>Website<select value={draft.site_id} onChange={e => setDraft({ ...draft, site_id: e.target.value, page_url: '' })}><option value="">Workspace-wide</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name} · {site.domain}</option>)}</select></label><label>Page URL<input type="url" disabled={!draft.site_id} value={draft.page_url} onChange={e => setDraft({ ...draft, page_url: e.target.value })} placeholder="https://example.com/affected-page"/></label><label className="full">Title<input value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} data-autofocus placeholder="What needs to change?"/></label><label className="full">Description<textarea value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} rows={4} placeholder="Why it matters and what evidence supports it"/></label><label>Severity<select value={draft.severity} onChange={e => setDraft({ ...draft, severity: e.target.value })}>{SEVERITIES.map(value => <option key={value}>{value}</option>)}</select></label><label>Owner<select value={draft.assignee_user_id} onChange={e => setDraft({ ...draft, assignee_user_id: e.target.value })}><option value="">Unassigned</option>{members.map(member => <option key={member.user_id} value={member.user_id}>{member.name || member.email}</option>)}</select></label><label>Due date<input type="date" value={draft.due_at} onChange={e => setDraft({ ...draft, due_at: e.target.value })}/></label></div></Modal>}
  </div>;
}
