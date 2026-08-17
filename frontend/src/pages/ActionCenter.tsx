import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, ChevronRight, CircleAlert, ClipboardCheck, Clock3, Filter, Plus, Search, UserRound, X } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { api, type WorkItem, type WorkspaceMember } from '../api';
import { Modal } from '../components/Modal';
import { useWorkspace } from '../workspace/WorkspaceContext';
import { useToast } from '../AppContext';

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const STATUS_LABEL: Record<string, string> = { open: 'Open', in_progress: 'In progress', done: 'Done', dismissed: 'Dismissed' };

export default function ActionCenterPage() {
  const { active } = useWorkspace(); const toast = useToast();
  const canManage = !!active?.permissions?.manage_content;
  const [items, setItems] = useState<WorkItem[]>([]); const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [timeline, setTimeline] = useState<Array<{ id: string; kind: string; title: string; note: string | null; event_at: string }>>([]);
  const [status, setStatus] = useState('active'); const [query, setQuery] = useState(''); const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null); const [composer, setComposer] = useState(false);
  const [draft, setDraft] = useState({ title: '', description: '', severity: 'medium', assignee_user_id: '', due_at: '' });

  const load = useCallback(async () => {
    const [work, events, people] = await Promise.all([api.getWorkItems({ include_snoozed: status === 'all', limit: 300 }), api.getTimeline(), active ? api.getWorkspaceMembers(active.id) : Promise.resolve([])]);
    setItems(work); setTimeline(events); setMembers(people);
  }, [active, status]);
  useEffect(() => { load().catch(() => null); }, [load]);

  const visible = useMemo(() => items.filter(item => {
    if (status === 'active' && ['done','dismissed'].includes(item.status)) return false;
    if (status !== 'active' && status !== 'all' && item.status !== status) return false;
    return `${item.title} ${item.description ?? ''} ${item.source}`.toLowerCase().includes(query.toLowerCase());
  }), [items, status, query]);
  const counts = useMemo(() => ({ critical: items.filter(i => i.severity === 'critical' && !['done','dismissed'].includes(i.status)).length,
    open: items.filter(i => i.status === 'open').length, progress: items.filter(i => i.status === 'in_progress').length,
    done: items.filter(i => i.status === 'done').length }), [items]);

  async function update(id: string, changes: Parameters<typeof api.updateWorkItem>[1]) {
    setBusy(id); try { await api.updateWorkItem(id, changes); await load(); toast('success', 'Action updated'); }
    catch (error) { toast('error', String(error).replace('Error: ', '')); } setBusy(null);
  }
  async function bulkDone() {
    setBusy('bulk'); try {
      const preview = await api.bulkWorkItems(selected, { status: 'done' }, true);
      const affected = preview.affected ?? 0;
      if (!confirm(`Mark ${affected} action${affected === 1 ? '' : 's'} complete? This preview has not changed anything yet.`)) { setBusy(null); return; }
      await api.bulkWorkItems(selected, { status: 'done' }); setSelected([]); await load(); toast('success', 'Selected actions completed');
    }
    catch (error) { toast('error', String(error).replace('Error: ', '')); } setBusy(null);
  }
  async function create() {
    if (!draft.title.trim()) return; setBusy('create');
    try { await api.createWorkItem({ ...draft, severity: draft.severity as WorkItem['severity'], assignee_user_id: draft.assignee_user_id || undefined, due_at: draft.due_at || undefined, title: draft.title }); setDraft({ title:'',description:'',severity:'medium',assignee_user_id:'',due_at:'' }); setComposer(false); await load(); toast('success','Action created'); }
    catch (error) { toast('error',String(error).replace('Error: ','')); } setBusy(null);
  }

  return <div className="ops-page action-centre-page">
    <header className="ops-page-header"><div><span className="eyebrow"><ClipboardCheck size={13}/> Operating rhythm</span><h1>Action inbox</h1><p>Turn every signal into owned, time-bound work—then retain the proof that it was resolved.</p></div><button className="btn btn-primary" disabled={!canManage} onClick={() => setComposer(true)}><Plus size={15}/> New action</button></header>
    <section className="ops-stat-strip">
      <button onClick={() => setStatus('active')}><CircleAlert/><span><small>Critical now</small><strong>{counts.critical}</strong></span></button>
      <button onClick={() => setStatus('open')}><Clock3/><span><small>Open</small><strong>{counts.open}</strong></span></button>
      <button onClick={() => setStatus('in_progress')}><UserRound/><span><small>In progress</small><strong>{counts.progress}</strong></span></button>
      <button onClick={() => setStatus('done')}><CheckCircle2/><span><small>Completed</small><strong>{counts.done}</strong></span></button>
    </section>
    <div className="ops-split action-split">
      <section className="ops-card action-board">
        <div className="ops-toolbar"><div className="ops-search"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search actions and evidence…"/></div><div className="ops-segment"><Filter size={13}/>{['active','open','in_progress','done','all'].map(value=><button key={value} className={status===value?'active':''} onClick={()=>setStatus(value)}>{value.replace('_',' ')}</button>)}</div></div>
        {selected.length>0&&<div className="bulk-bar"><strong>{selected.length} selected</strong><button className="btn btn-secondary btn-sm" disabled={!canManage||busy==='bulk'} onClick={bulkDone}><CheckCircle2 size={13}/> Mark complete</button><button className="btn-icon btn-icon-ghost" onClick={()=>setSelected([])}><X size={14}/></button></div>}
        <div className="work-list">
          {visible.map(item=><article className={`work-item severity-${item.severity}`} key={item.id}>
            <input type="checkbox" aria-label={`Select ${item.title}`} checked={selected.includes(item.id)} onChange={e=>setSelected(current=>e.target.checked?[...current,item.id]:current.filter(id=>id!==item.id))}/>
            <span className="severity-rail"/><div className="work-copy"><div><span className={`signal-badge ${item.severity}`}>{item.severity}</span><span className="source-badge">{item.source.replaceAll('_',' ')}</span>{item.due_at&&<span className="due-badge"><CalendarClock size={11}/>{new Date(item.due_at).toLocaleDateString()}</span>}</div><h3>{item.title}</h3><p>{item.description||'No description supplied.'}</p><footer><span>{item.assignee_name||item.assignee_email||'Unassigned'}</span><span>Updated {formatDistanceToNow(new Date(item.updated_at),{addSuffix:true})}</span></footer></div>
            <div className="work-controls"><select aria-label="Status" value={item.status} disabled={!canManage||busy===item.id} onChange={e=>update(item.id,{status:e.target.value})}>{Object.entries(STATUS_LABEL).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><select aria-label="Assignee" value={item.assignee_user_id||''} disabled={!canManage||busy===item.id} onChange={e=>update(item.id,{assignee_user_id:e.target.value||null})}><option value="">Unassigned</option>{members.map(member=><option value={member.user_id} key={member.user_id}>{member.name||member.email}</option>)}</select>{item.deep_link&&<a className="btn-icon btn-icon-ghost" href={item.deep_link} title="Open evidence"><ChevronRight size={16}/></a>}</div>
          </article>)}
          {!visible.length&&<div className="ops-empty"><CheckCircle2/><h3>Nothing waiting in this view</h3><p>New regressions, connector failures and manual actions will land here with their evidence.</p></div>}
        </div>
      </section>
      <aside className="ops-card evidence-timeline"><div className="ops-card-head"><div><span className="eyebrow">Causal record</span><h2>Timeline</h2></div><button className="btn btn-ghost btn-sm" onClick={()=>setComposer(true)}><Plus size={12}/> Note</button></div><div className="timeline-list">{timeline.slice(0,18).map(event=><div key={event.id}><i/><time>{new Date(event.event_at).toLocaleDateString()}</time><strong>{event.title}</strong>{event.note&&<p>{event.note}</p>}<span>{event.kind}</span></div>)}{!timeline.length&&<div className="ops-empty compact">Annotations and verified changes appear here.</div>}</div></aside>
    </div>
    {composer&&<Modal onClose={()=>setComposer(false)} title="New action" eyebrow="Create accountable work" description="Capture the outcome, owner and urgency so the work can move from evidence to completion." icon={<ClipboardCheck/>} footer={<><button className="btn btn-ghost" onClick={()=>setComposer(false)}>Cancel</button><button className="btn btn-primary" disabled={!canManage||busy==='create'||!draft.title.trim()} onClick={create}>{busy==='create'?'Creating…':'Create action'}</button></>}><div className="form-grid"><label className="full">Title<input value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} data-autofocus placeholder="What needs to change?"/></label><label className="full">Description<textarea value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})} rows={4} placeholder="Why it matters and what evidence supports it"/></label><label>Severity<select value={draft.severity} onChange={e=>setDraft({...draft,severity:e.target.value})}>{SEVERITIES.map(value=><option key={value}>{value}</option>)}</select></label><label>Owner<select value={draft.assignee_user_id} onChange={e=>setDraft({...draft,assignee_user_id:e.target.value})}><option value="">Unassigned</option>{members.map(member=><option key={member.user_id} value={member.user_id}>{member.name||member.email}</option>)}</select></label><label>Due date<input type="date" value={draft.due_at} onChange={e=>setDraft({...draft,due_at:e.target.value})}/></label></div></Modal>}
  </div>;
}
