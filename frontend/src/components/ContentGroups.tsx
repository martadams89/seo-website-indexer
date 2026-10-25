import { useCallback, useEffect, useState } from 'react';
import { FolderTree, Pencil, Plus, Trash2, X } from 'lucide-react';
import { apiFetch } from '../api/client';
import { useToast } from '../AppContext';
import { Modal } from './Modal';
import './search-extras.css';

type Match = 'prefix' | 'contains' | 'exact' | 'regex';
interface Rule { match: Match; value: string }
interface Totals { clicks: number; impressions: number; ctr: number; position: number }
interface Group {
  id: string | null; name: string; include: Rule[]; exclude: Rule[]; pages: number; current: Totals; previous: Totals;
  clicks_change_pct: number | null; impressions_change_pct: number | null; position_change: number | null;
  top_pages: Array<{ page: string } & Totals>;
}
interface Result { period: { start: string; end: string; days: number }; groups: Group[]; ungrouped: Group; has_history: boolean }

const MATCH_LABEL: Record<Match, string> = { prefix: 'starts with', contains: 'contains', exact: 'is exactly', regex: 'matches regex' };
const pct = (v: number | null) => v === null ? '—' : `${v > 0 ? '+' : ''}${v}%`;
const ruleText = (rules: Rule[]) => rules.map(r => `${MATCH_LABEL[r.match]} ${r.value}`).join(' or ');

/** Pages grouped by URL rules with group-level Search Console performance (OpenGSC-style content groups). */
export function ContentGroups({ siteId, canManage }: { siteId: string; canManage: boolean }) {
  const toast = useToast();
  const [days, setDays] = useState(28);
  const [data, setData] = useState<Result | null>(null);
  const [editing, setEditing] = useState<Group | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => apiFetch<Result>(`/api/sites/${siteId}/content-groups?days=${days}`)
    .then(setData)
    .catch(e => toast('error', String(e?.message ?? e))), [siteId, days, toast]);
  useEffect(() => { void load(); }, [load]);

  async function remove(g: Group) {
    if (!g.id || !window.confirm(`Delete the "${g.name}" group? Only the grouping is removed.`)) return;
    try { await apiFetch(`/api/sites/${siteId}/content-groups/${g.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { toast('error', String((e as Error)?.message ?? e)); }
  }

  const rows = data ? [...data.groups, ...(data.ungrouped.pages ? [data.ungrouped] : [])] : [];
  return (
    <section className="ops-card content-groups">
      <div className="ops-card-head">
        <div><span className="eyebrow"><FolderTree size={12} /> Content groups</span><h2>Performance by section of the site</h2></div>
        <div className="search-compare-controls">
          <select className="input" aria-label="Period" value={days} onChange={e => setDays(Number(e.target.value))}>
            {[7, 28, 90].map(d => <option key={d} value={d}>Last {d} days</option>)}
          </select>
          <button className="btn btn-primary btn-sm" disabled={!canManage} onClick={() => setEditing('new')}><Plus size={13} /> Add group</button>
        </div>
      </div>
      {data && !data.has_history && <p className="ads-hint">Page history builds up after the first Search Console sync; groups fill in then.</p>}
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Group</th><th>Pages</th><th>Clicks</th><th>Impressions</th><th>CTR</th><th>Position</th><th /></tr></thead>
          <tbody>
            {rows.map(g => (
              <tr key={g.id ?? 'ungrouped'} className={g.id ? '' : 'muted-row'}>
                <td>
                  <button type="button" className="cg-name" aria-expanded={open === (g.id ?? 'u')} onClick={() => setOpen(open === (g.id ?? 'u') ? null : g.id ?? 'u')}><strong>{g.name}</strong></button>
                  {g.id && <small className="content-group-rules">{ruleText(g.include)}{g.exclude.length ? `, except ${ruleText(g.exclude)}` : ''}</small>}
                  {open === (g.id ?? 'u') && (
                    <ul className="content-group-pages">
                      {g.top_pages.map(p => <li key={p.page}><span title={p.page}>{p.page.replace(/^https?:\/\/[^/]+/, '') || '/'}</span><small>{p.clicks} clicks · pos {p.position || '—'}</small></li>)}
                      {!g.top_pages.length && <li><small className="text-dim">No clicks in this period.</small></li>}
                    </ul>
                  )}
                </td>
                <td>{g.pages}</td>
                <td>{g.current.clicks.toLocaleString()} <small className={(g.clicks_change_pct ?? 0) < 0 ? 'text-warn' : 'text-ok'}>{pct(g.clicks_change_pct)}</small></td>
                <td>{g.current.impressions.toLocaleString()} <small className="text-dim">{pct(g.impressions_change_pct)}</small></td>
                <td>{g.current.ctr.toFixed(2)}%</td>
                <td>{g.current.position ? g.current.position.toFixed(1) : '—'}{g.position_change !== null && <small className="text-dim"> ({g.position_change > 0 ? '+' : ''}{g.position_change})</small>}</td>
                <td className="content-group-actions">
                  {g.id && canManage && <>
                    <button className="btn-icon btn-icon-ghost" aria-label={`Edit ${g.name}`} onClick={() => setEditing(g)}><Pencil size={13} /></button>
                    <button className="btn-icon btn-icon-ghost" aria-label={`Delete ${g.name}`} onClick={() => remove(g)}><Trash2 size={13} /></button>
                  </>}
                </td>
              </tr>
            ))}
            {data && !rows.length && <tr><td colSpan={7}><small className="text-dim">No groups yet. Add one — for example Blog for pages starting with /blog/.</small></td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <GroupModal siteId={siteId} group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />}
    </section>
  );
}

function RuleEditor({ label, rules, onChange }: { label: string; rules: Rule[]; onChange: (rules: Rule[]) => void }) {
  const set = (i: number, patch: Partial<Rule>) => onChange(rules.map((r, j) => j === i ? { ...r, ...patch } : r));
  return (
    <fieldset className="cg-fieldset">
      <legend>{label}</legend>
      {rules.map((r, i) => (
        <div key={i} className="content-group-rule">
          <select className="input" aria-label="Match" value={r.match} onChange={e => set(i, { match: e.target.value as Match })}>
            {(Object.keys(MATCH_LABEL) as Match[]).map(m => <option key={m} value={m}>URL {MATCH_LABEL[m]}</option>)}
          </select>
          <input className="input" aria-label="Value" value={r.value} onChange={e => set(i, { value: e.target.value })} placeholder={r.match === 'regex' ? '/(damp|mould)-' : '/blog/'} />
          <button className="btn-icon btn-icon-ghost" aria-label="Remove rule" onClick={() => onChange(rules.filter((_, j) => j !== i))}><X size={13} /></button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" onClick={() => onChange([...rules, { match: 'prefix', value: '' }])}><Plus size={13} /> Add rule</button>
    </fieldset>
  );
}

function GroupModal({ siteId, group, onClose, onSaved }: { siteId: string; group: Group | null; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const toast = useToast();
  const [name, setName] = useState(group?.name ?? '');
  const [include, setInclude] = useState<Rule[]>(group?.include.length ? group.include : [{ match: 'prefix', value: '' }]);
  const [exclude, setExclude] = useState<Rule[]>(group?.exclude ?? []);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await apiFetch(`/api/sites/${siteId}/content-groups`, { method: 'POST', body: JSON.stringify({ id: group?.id ?? undefined, name, include: include.filter(r => r.value.trim()), exclude: exclude.filter(r => r.value.trim()) }) });
      toast('success', 'Group saved');
      await onSaved();
    } catch (e) { toast('error', String((e as Error)?.message ?? e)); }
    setBusy(false);
  }

  return (
    <Modal onClose={onClose} title={group ? `Edit ${group.name}` : 'New content group'} eyebrow="Content groups" icon={<FolderTree />}
      description='Values starting with "/" match the page path; anything else matches the full URL. Matching ignores case.'
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save group'}</button></>}>
      <label className="cg-wide">Name<input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Blog" /></label>
      <RuleEditor label="Pages that match any of" rules={include} onChange={setInclude} />
      <RuleEditor label="Except pages that match" rules={exclude} onChange={setExclude} />
    </Modal>
  );
}
