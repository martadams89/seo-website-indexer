import { useEffect, useState, useCallback, useRef } from 'react';
import { Bot, Play, Plus, Trash2, CheckCircle2, XCircle, KeyRound, Send, ExternalLink, MessageSquare } from 'lucide-react';
import { api, type AiPrompt, type AiResult } from '../api';
import { useApp } from '../AppContext';

const PROVIDER_LABEL: Record<string, string> = {
  openai: 'ChatGPT',
  anthropic: 'Claude',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  xai: 'Grok',
  brave: 'Brave Search',
};

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; }
}

function CitationChips({ result }: { result: AiResult }) {
  const urls = parseJson<string[]>(result.citations, []);
  const ours = parseJson<string[]>(result.domains, []);
  if (urls.length === 0) return null;
  const isOurs = (u: string) => ours.some(d => u.toLowerCase().includes(d.toLowerCase()));
  return (
    <div className="cite-chips">
      {urls.map((u, i) => {
        let host = u;
        try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
        return (
          <a key={i} href={u} target="_blank" rel="noopener noreferrer"
             className={`cite-chip${isOurs(u) ? ' ours' : ''}`} title={u}>
            <ExternalLink size={9} /> {host}
          </a>
        );
      })}
    </div>
  );
}

function Thread({ promptId, promptText, provider, configured, onCitedChange }: {
  promptId: number;
  promptText: string;
  provider: string;
  configured: boolean;
  onCitedChange: () => void;
}) {
  const { toast } = useApp();
  const [thread, setThread] = useState<AiResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setThread(await api.getAiThread(promptId, provider)); }
    catch { /* empty thread is fine */ }
    setLoading(false);
  }, [promptId, provider]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [thread.length, sending]);

  async function send() {
    const msg = reply.trim();
    if (!msg || sending) return;
    setSending(true);
    try {
      await api.replyAiThread(promptId, provider, msg);
      setReply('');
      await load();
      onCitedChange();
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Reply failed');
    }
    setSending(false);
  }

  const canReply = configured && provider !== 'brave';

  return (
    <div className="ai-thread-wrap">
      <div className="ai-thread" ref={scrollRef}>
        {loading ? (
          <div className="text-dim" style={{ padding: 16, textAlign: 'center' }}>Loading conversation…</div>
        ) : thread.length === 0 ? (
          <div className="text-dim" style={{ padding: 16, textAlign: 'center' }}>
            No runs yet for {PROVIDER_LABEL[provider] ?? provider} — hit ▶ on the prompt row first.
          </div>
        ) : (
          thread.map(r => (
            <div key={r.id} className="ai-turn">
              <div className="ai-bubble user">
                {r.user_prompt ?? promptText}
              </div>
              {r.error ? (
                <div className="ai-bubble assistant is-error">
                  <div className="ai-bubble-meta">{PROVIDER_LABEL[provider]} · error</div>
                  {r.error}
                </div>
              ) : (
                <div className={`ai-bubble assistant${r.cited ? ' cited' : ''}`}>
                  <div className="ai-bubble-meta">
                    {PROVIDER_LABEL[provider]}{r.model ? ` · ${r.model}` : ''} · {new Date(r.created_at + 'Z').toLocaleString()}
                    {r.cited ? <span className="badge badge-ok">cited: {parseJson<string[]>(r.domains, []).join(', ')}</span>
                             : <span className="badge">not cited</span>}
                  </div>
                  <div className="ai-bubble-text">{r.excerpt}</div>
                  <CitationChips result={r} />
                </div>
              )}
            </div>
          ))
        )}
        {sending && <div className="ai-bubble assistant pending">Thinking…</div>}
      </div>

      <div className="ai-reply-row">
        <input
          className="input"
          placeholder={
            !configured ? `${PROVIDER_LABEL[provider]} has no API key configured`
            : provider === 'brave' ? 'Brave is a retrieval check — no conversation to continue'
            : `Ask ${PROVIDER_LABEL[provider]} a follow-up…`
          }
          value={reply}
          disabled={!canReply || sending}
          onChange={e => setReply(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
        />
        <button className="btn btn-primary btn-sm" disabled={!canReply || sending || !reply.trim()} onClick={send}>
          <Send size={13} /> {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

export default function CitationsPage() {
  const { toast, sites } = useApp();
  const [providers, setProviders] = useState<{ all: string[]; configured: string[] }>({ all: [], configured: [] });
  const [prompts, setPrompts] = useState<AiPrompt[]>([]);
  const [results, setResults] = useState<AiResult[]>([]);
  const [newPrompt, setNewPrompt] = useState('');
  const [running, setRunning] = useState<number | 'all' | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [activeProvider, setActiveProvider] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const [prov, pr, res] = await Promise.all([api.getAiProviders(), api.getAiPrompts(), api.getAiResults()]);
      setProviders(prov);
      setPrompts(pr);
      setResults(res);
      setActiveProvider(prev => prev || prov.configured[0] || prov.all[0] || '');
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
    if (expanded === id) setExpanded(null);
    load();
  }

  // Latest result per prompt × provider for the matrix ticks
  const latest = new Map<string, AiResult>();
  for (const r of results) {
    const k = `${r.prompt_id}:${r.provider}`;
    if (!latest.has(k)) latest.set(k, r);
  }

  const noKeys = providers.configured.length === 0;
  const expandedPrompt = prompts.find(p => p.id === expanded);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">AI Citations</h1>
          <p className="page-subtitle">Do the answer engines cite your sites? Click a prompt to open its conversations.</p>
        </div>
        <button className="btn btn-primary btn-sm" disabled={running !== null || noKeys || prompts.length === 0} onClick={() => run('all')}>
          <Play size={12} /> {running === 'all' ? 'Running…' : 'Run all'}
        </button>
      </div>

      <div className="flex gap-2" style={{ flexWrap: 'wrap', marginBottom: 18 }}>
        {providers.all.map(p => (
          <span key={p} className={`badge ${providers.configured.includes(p) ? 'badge-ok' : ''}`}>
            <Bot size={11} /> {PROVIDER_LABEL[p] ?? p} {providers.configured.includes(p) ? 'ready' : 'no key'}
          </span>
        ))}
      </div>
      {noKeys && (
        <div className="empty-note" style={{ marginBottom: 16 }}>
          <KeyRound size={12} /> Add at least one provider API key in <strong>Settings → API Keys</strong> to start tracking. Tracked domains come from your configured sites ({sites.length}).
        </div>
      )}

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
                <tr key={p.id} className={expanded === p.id ? 'row-active' : ''} onClick={() => setExpanded(expanded === p.id ? null : p.id)} style={{ cursor: 'pointer' }}>
                  <td><MessageSquare size={11} style={{ opacity: 0.5, marginRight: 6 }} />{p.prompt}</td>
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

      {expandedPrompt && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="flex items-center gap-2" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
            <h3 className="panel-title" style={{ margin: 0, flex: 1, minWidth: 200 }}>"{expandedPrompt.prompt}"</h3>
            <div className="flex gap-1" style={{ flexWrap: 'wrap' }}>
              {providers.all.map(prov => {
                const r = latest.get(`${expandedPrompt.id}:${prov}`);
                return (
                  <button key={prov}
                    className={`btn btn-sm ${activeProvider === prov ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setActiveProvider(prov)}>
                    {PROVIDER_LABEL[prov] ?? prov}
                    {r && !r.error && (r.cited
                      ? <CheckCircle2 size={11} style={{ marginLeft: 4, color: activeProvider === prov ? 'inherit' : 'var(--ok)' }} />
                      : <XCircle size={11} style={{ marginLeft: 4, opacity: 0.5 }} />)}
                  </button>
                );
              })}
            </div>
          </div>
          {activeProvider && (
            <Thread
              key={`${expandedPrompt.id}:${activeProvider}`}
              promptId={expandedPrompt.id}
              promptText={expandedPrompt.prompt}
              provider={activeProvider}
              configured={providers.configured.includes(activeProvider)}
              onCitedChange={load}
            />
          )}
        </div>
      )}
    </div>
  );
}
