import { useEffect, useState, useCallback, useRef } from 'react';
import { Bot, Play, Plus, Trash2, CheckCircle2, XCircle, KeyRound, Send, ExternalLink, MessageSquare, Loader2, Sparkles, Target, TrendingUp, Trophy, Save, Globe2, ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { api, type AiInsights, type AiPrompt, type AiPromptCategory, type AiResult } from '../api';
import { Markdown } from '../components/Markdown';
import { useApp } from '../AppContext';

const PROVIDER_LABEL: Record<string, string> = {
  openai: 'ChatGPT',
  anthropic: 'Claude',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  xai: 'Grok',
  brave: 'Brave Search',
};
const CATEGORY_LABEL: Record<AiPromptCategory, string> = {
  discovery: 'Discovery', comparison: 'Comparison', commercial: 'Commercial', brand: 'Brand', support: 'Support',
};

const EMPTY_INSIGHTS: AiInsights = {
  overview: { prompts: 0, configuredProviders: 0, checks: 0, cited: 0, visibility: 0, previousVisibility: null, change: null, sourceDomains: 0 },
  providers: [], trend: [], sources: [], opportunities: [], movements: [],
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
                  <div className="ai-bubble-text"><Markdown text={r.excerpt ?? ''} /></div>
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
  const [insights, setInsights] = useState<AiInsights>(EMPTY_INSIGHTS);
  const [newPrompt, setNewPrompt] = useState('');
  const [newSiteId, setNewSiteId] = useState('');
  const [newCategory, setNewCategory] = useState<AiPromptCategory>('discovery');
  const [competitorDomains, setCompetitorDomains] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [running, setRunning] = useState<number | 'all' | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [activeProvider, setActiveProvider] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const [prov, pr, res, nextInsights, config] = await Promise.all([api.getAiProviders(), api.getAiPrompts(), api.getAiResults(), api.getAiInsights(), api.getAiConfig()]);
      setProviders(prov);
      setPrompts(pr);
      setResults(res);
      setInsights(nextInsights);
      setCompetitorDomains(config.competitorDomains);
      setActiveProvider(prev => prev || prov.configured[0] || prov.all[0] || '');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Failed to load');
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!newPrompt.trim()) return;
    try {
      await api.addAiPrompt(newPrompt.trim(), newSiteId || null, newCategory);
      setNewPrompt('');
      load();
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Failed to add'); }
  }

  async function saveCompetitors() {
    setSavingConfig(true);
    try { await api.saveAiConfig(competitorDomains); toast('success', 'Competitor set saved'); await load(); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Could not save competitors'); }
    setSavingConfig(false);
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
  for (const r of results.filter(result => result.parent_id == null)) {
    const k = `${r.prompt_id}:${r.provider}`;
    if (!latest.has(k)) latest.set(k, r);
  }

  const noKeys = providers.configured.length === 0;
  const expandedPrompt = prompts.find(p => p.id === expanded);

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="eyebrow"><Sparkles size={13} /> Generative engine intelligence</div>
          <h1 className="page-title">AI Visibility</h1>
          <p className="page-subtitle">Measure where answer engines mention you, who earns the sources, and which buyer questions to win next.</p>
        </div>
        <button className="btn btn-primary btn-sm" disabled={running !== null || noKeys || prompts.length === 0} onClick={() => run('all')}>
          {running === 'all' ? <><Loader2 size={12} className="spin" /> Running…</> : <><Play size={12} /> Run all</>}
        </button>
      </div>

      {running !== null && (
        <div className="alert alert-info mb-4" role="status">
          <div className="alert-content" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            <Loader2 size={14} className="spin" />
            Querying {running === 'all' ? 'all prompts across every configured provider' : 'the selected prompt'}… each provider does a live web search, so this can take up to a minute or so per provider. Results appear here when done.
          </div>
        </div>
      )}

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

      <section className="geo-overview">
        <div className="geo-kpi primary">
          <span><Target size={17} /> Portfolio visibility</span>
          <strong>{insights.overview.checks ? `${insights.overview.visibility}%` : '—'}</strong>
          <small>
            {insights.overview.change == null ? 'Run twice to establish movement' : insights.overview.change >= 0
              ? <><ArrowUpRight size={12} /> {insights.overview.change} points vs previous checks</>
              : <><ArrowDownRight size={12} /> {Math.abs(insights.overview.change)} points vs previous checks</>}
          </small>
        </div>
        <div className="geo-kpi"><span><MessageSquare size={16} /> Prompt set</span><strong>{insights.overview.prompts}</strong><small>buyer questions tracked</small></div>
        <div className="geo-kpi"><span><CheckCircle2 size={16} /> Citations won</span><strong>{insights.overview.cited}<em>/{insights.overview.checks}</em></strong><small>latest successful checks</small></div>
        <div className="geo-kpi"><span><Globe2 size={16} /> Source landscape</span><strong>{insights.overview.sourceDomains}</strong><small>domains shaping answers</small></div>
      </section>

      <section className="geo-grid">
        <div className="command-panel geo-provider-panel">
          <div className="command-panel-head"><div><span className="eyebrow">Answer engines</span><h2>Visibility by provider</h2></div><TrendingUp size={16} /></div>
          <div className="geo-provider-list">
            {providers.all.map(provider => {
              const item = insights.providers.find(row => row.provider === provider);
              const configured = providers.configured.includes(provider);
              return <div key={provider} className={!configured ? 'disabled' : ''}>
                <span><Bot size={14} /><strong>{PROVIDER_LABEL[provider] ?? provider}</strong><small>{configured ? `${item?.cited ?? 0} of ${item?.checks ?? 0} prompts` : 'API key needed'}</small></span>
                <div className="geo-progress"><i style={{ width: `${item?.visibility ?? 0}%` }} /></div>
                <b>{configured ? `${item?.visibility ?? 0}%` : '—'}</b>
              </div>;
            })}
          </div>
        </div>

        <div className="command-panel geo-sources-panel">
          <div className="command-panel-head"><div><span className="eyebrow">Citation graph</span><h2>Sources winning answers</h2></div><Trophy size={16} /></div>
          <div className="source-list">
            {insights.sources.slice(0, 8).map((source, index) => <div key={source.domain} className={source.owned ? 'owned' : source.competitor ? 'competitor' : ''}>
              <span className="source-rank">{index + 1}</span><span><strong>{source.domain}</strong><small>{source.providers.map(provider => PROVIDER_LABEL[provider] ?? provider).join(' · ')}</small></span>
              {source.owned && <em>your site</em>}{source.competitor && <em>competitor</em>}<b>{source.citations}</b>
            </div>)}
            {!insights.sources.length && <div className="command-empty compact"><Globe2 size={22} /><strong>No citation graph yet</strong><span>Run your prompt set to map the domains that ground AI answers.</span></div>}
          </div>
        </div>
      </section>

      <section className="geo-grid geo-opportunity-grid">
        <div className="command-panel">
          <div className="command-panel-head"><div><span className="eyebrow">Gaps to close</span><h2>Prompt opportunities</h2></div><span className="signal-count">{insights.opportunities.length}</span></div>
          <div className="opportunity-list">
            {insights.opportunities.slice(0, 6).map(item => <button key={item.promptId} onClick={() => setExpanded(item.promptId)}>
              <span className={`category-chip category-${item.category}`}>{CATEGORY_LABEL[item.category]}</span>
              <span><strong>{item.prompt}</strong><small>Missing from {item.missingProviders.map(provider => PROVIDER_LABEL[provider] ?? provider).join(', ')}</small></span><span>{item.citedProviders.length}/{providers.configured.length}</span>
            </button>)}
            {!insights.opportunities.length && <div className="command-empty compact"><CheckCircle2 size={22} /><strong>No current gaps</strong><span>Add more prompts or providers to broaden coverage.</span></div>}
          </div>
        </div>
        <div className="command-panel competitor-panel">
          <div className="command-panel-head"><div><span className="eyebrow">Competitive context</span><h2>Watchlist</h2></div><Target size={16} /></div>
          <p>Flag known competitors inside the source graph. Use domains separated by commas or spaces.</p>
          <textarea className="input" rows={4} placeholder="competitor.com, another-rival.co.uk" value={competitorDomains} onChange={event => setCompetitorDomains(event.target.value)} />
          <button className="btn btn-secondary btn-sm" onClick={saveCompetitors} disabled={savingConfig}>{savingConfig ? <Loader2 size={12} className="spin" /> : <Save size={12} />} Save watchlist</button>
        </div>
      </section>


      <div className="prompt-composer">
        <input
          className="input"
          placeholder='e.g. "What is the best damp survey app for UK surveyors?"'
          value={newPrompt}
          onChange={e => setNewPrompt(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
        />
        <select className="input" value={newCategory} onChange={event => setNewCategory(event.target.value as AiPromptCategory)}>
          {Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select className="input" value={newSiteId} onChange={event => setNewSiteId(event.target.value)}>
          <option value="">Whole workspace</option>
          {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
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
                  <td><span className={`category-chip category-${p.category}`}>{CATEGORY_LABEL[p.category] ?? p.category}</span><span className="prompt-table-text"><MessageSquare size={11} />{p.prompt}</span></td>
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
                      title={running === p.id ? 'Running…' : 'Run this prompt'}
                      onClick={e => { e.stopPropagation(); run(p.id); }}>
                      {running === p.id ? <Loader2 size={13} className="spin" style={{ color: 'var(--accent)' }} /> : <Play size={12} />}
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
