import { useEffect, useState, useCallback } from 'react';
import { Bot, Play, Plus, Trash2, CheckCircle2, XCircle, KeyRound } from 'lucide-react';
import { api, type AiPrompt, type AiResult } from '../api';
import { useApp } from '../AppContext';

const PROVIDER_LABEL: Record<string, string> = {
  openai: 'ChatGPT',
  anthropic: 'Claude',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  xai: 'Grok',
};

export default function CitationsPage() {
  const { toast, sites } = useApp();
  const [providers, setProviders] = useState<{ all: string[]; configured: string[] }>({ all: [], configured: [] });
  const [prompts, setPrompts] = useState<AiPrompt[]>([]);
  const [results, setResults] = useState<AiResult[]>([]);
  const [newPrompt, setNewPrompt] = useState('');
  const [running, setRunning] = useState<number | 'all' | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [prov, pr, res] = await Promise.all([api.getAiProviders(), api.getAiPrompts(), api.getAiResults()]);
      setProviders(prov);
      setPrompts(pr);
      setResults(res);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to load');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!newPrompt.trim()) return;
    try {
      await api.addAiPrompt(newPrompt.trim());
      setNewPrompt('');
      load();
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Failed to add'); }
  }

  async function run(id: number | 'all') {
    setRunning(id);
    try {
      if (id === 'all') await api.runAllAiPrompts();
      else await api.runAiPrompt(id);
      toast('success', 'Citation check complete');
      load();
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Run failed'); }
    setRunning(null);
  }

  async function remove(id: number) {
    await api.deleteAiPrompt(id).catch(() => null);
    load();
  }

  // Latest result per prompt × provider
  const latest = new Map<string, AiResult>();
  for (const r of results) {
    const k = `${r.prompt_id}:${r.provider}`;
    if (!latest.has(k)) latest.set(k, r); // results are newest-first
  }

  const noKeys = providers.configured.length === 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">AI Citations</h1>
          <p className="page-subtitle">Do the answer engines cite your sites? Tracked prompts across {providers.configured.length || 'no'} configured provider{providers.configured.length === 1 ? '' : 's'}.</p>
        </div>
        <button className="btn btn-primary btn-sm" disabled={running !== null || noKeys || prompts.length === 0} onClick={() => run('all')}>
          <Play size={12} /> {running === 'all' ? 'Running…' : 'Run all'}
        </button>
      </div>

      {/* Provider status */}
      <div className="flex gap-2" style={{ flexWrap: 'wrap', marginBottom: 18 }}>
        {providers.all.map(p => (
          <span key={p} className={`badge ${providers.configured.includes(p) ? 'badge-ok' : ''}`}>
            <Bot size={11} /> {PROVIDER_LABEL[p] ?? p} {providers.configured.includes(p) ? 'ready' : 'no key'}
          </span>
        ))}
      </div>
      {noKeys && (
        <div className="empty-note" style={{ marginBottom: 16 }}>
          <KeyRound size={12} /> Add at least one provider API key in <strong>Settings → AI providers</strong> to start tracking. Tracked domains come from your configured sites ({sites.length}).
        </div>
      )}

      {/* Add prompt */}
      <div className="flex gap-2" style={{ marginBottom: 18 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder='e.g. "What is the best damp survey app for UK surveyors?"'
          value={newPrompt}
          onChange={e => setNewPrompt(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
        />
        <button className="btn btn-primary btn-sm" onClick={add}><Plus size={13} /> Add prompt</button>
      </div>

      {/* Prompt matrix */}
      {prompts.length === 0 ? (
        <div className="empty-note">No tracked prompts yet. Add the questions your customers ask AI assistants — brand queries, "best X app" queries, comparisons.</div>
      ) : (
        <div className="table-scroll">
          <table className="mini-table citations-table">
            <thead>
              <tr>
                <th style={{ width: '40%' }}>Prompt</th>
                {providers.all.map(p => <th key={p} style={{ textAlign: 'center' }}>{PROVIDER_LABEL[p] ?? p}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {prompts.map(p => (
                <tr key={p.id} onClick={() => setExpanded(expanded === p.id ? null : p.id)} style={{ cursor: 'pointer' }}>
                  <td>{p.prompt}</td>
                  {providers.all.map(prov => {
                    const r = latest.get(`${p.id}:${prov}`);
                    return (
                      <td key={prov} style={{ textAlign: 'center' }}>
                        {!r ? <span className="text-dim">—</span>
                          : r.error ? <span title={r.error} style={{ color: 'var(--warn)' }}>!</span>
                          : r.cited ? <CheckCircle2 size={15} style={{ color: 'var(--ok)' }} />
                          : <XCircle size={15} style={{ color: 'var(--text-dim)' }} />}
                      </td>
                    );
                  })}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-ghost btn-sm" disabled={running !== null || noKeys}
                      onClick={e => { e.stopPropagation(); run(p.id); }}>
                      {running === p.id ? '…' : <Play size={12} />}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={e => { e.stopPropagation(); remove(p.id); }}>
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Expanded excerpts */}
      {expanded !== null && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h3 className="panel-title">Latest answers</h3>
          {providers.all.map(prov => {
            const r = latest.get(`${expanded}:${prov}`);
            if (!r) return null;
            const domains = JSON.parse(r.domains || '[]') as string[];
            return (
              <div key={prov} className="excerpt-block">
                <div className="excerpt-head">
                  <strong>{PROVIDER_LABEL[prov] ?? prov}</strong>
                  <span className="text-dim" style={{ fontSize: 11 }}>{r.model ?? ''} · {new Date(r.created_at + 'Z').toLocaleString()}</span>
                  {r.cited ? <span className="badge badge-ok">cited: {domains.join(', ')}</span> : <span className="badge">not cited</span>}
                </div>
                {r.error ? <div style={{ color: 'var(--warn)', fontSize: 12 }}>{r.error}</div>
                  : <p className="excerpt-text">{r.excerpt}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
