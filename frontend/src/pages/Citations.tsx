import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Bot, CalendarClock, CheckCircle2, CircleHelp,
  ExternalLink, Globe2, KeyRound, Library, Loader2, MessageSquare, Pencil, Play, Plus,
  Save, Search, Send, Settings2, Sparkles, Target, Trash2, TrendingUp, Trophy, X, XCircle,
} from 'lucide-react';
import { api, type AiInsights, type AiPrompt, type AiPromptCategory, type AiResult } from '../api';
import { Markdown } from '../components/Markdown';
import { useApp } from '../AppContext';

const PROVIDER_LABEL: Record<string, string> = {
  openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini', perplexity: 'Perplexity', xai: 'Grok', brave: 'Brave Search',
};
const CATEGORY_GUIDE: Record<AiPromptCategory, { label: string; purpose: string; example: string; tip: string }> = {
  discovery: { label: 'Discovery', purpose: 'Unbranded problem and category questions that reveal whether you enter the consideration set.', example: 'What tools help UK surveyors create damp inspection reports?', tip: 'Describe the problem naturally. Avoid mentioning your brand.' },
  comparison: { label: 'Comparison', purpose: 'Questions that compare approaches, products or named alternatives during evaluation.', example: 'How do the leading damp survey apps compare for small UK practices?', tip: 'Include the audience and comparison criteria.' },
  commercial: { label: 'Commercial', purpose: 'High-intent shortlist, recommendation and buying questions.', example: 'What is the best damp survey software for a five-person UK firm?', tip: 'Use a realistic buyer constraint, not marketing language.' },
  brand: { label: 'Brand', purpose: 'Questions that test how accurately answer engines understand and describe your brand.', example: 'What is Acme Surveyor and who is it designed for?', tip: 'Track factual positioning, reputation and use cases.' },
  support: { label: 'Support', purpose: 'Post-purchase and implementation questions that expose documentation or education gaps.', example: 'How do I turn a damp inspection into a client-ready report?', tip: 'Phrase it exactly as a customer would ask for help.' },
};
const CATEGORY_LABEL = Object.fromEntries(Object.entries(CATEGORY_GUIDE).map(([key, value]) => [key, value.label])) as Record<AiPromptCategory, string>;
const EMPTY_INSIGHTS: AiInsights = {
  overview: { prompts: 0, configuredProviders: 0, checks: 0, cited: 0, visibility: 0, previousVisibility: null, change: null, sourceDomains: 0 },
  providers: [], trend: [], sources: [], opportunities: [], movements: [],
};

interface PromptDraft {
  prompt: string; siteId: string; category: AiPromptCategory; group: string; locale: string;
  device: string; persona: string; cadence: AiPrompt['cadence']; enabled: boolean;
}

const blankPrompt = (): PromptDraft => ({
  prompt: '', siteId: '', category: 'discovery', group: 'Core buyer journey', locale: 'en-GB',
  device: 'desktop', persona: '', cadence: 'weekly', enabled: true,
});

function editPromptDraft(prompt: AiPrompt): PromptDraft {
  return { prompt: prompt.prompt, siteId: prompt.site_id || '', category: prompt.category, group: prompt.group_name, locale: prompt.locale, device: prompt.device, persona: prompt.persona || '', cadence: prompt.cadence, enabled: !!prompt.enabled };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

function CitationChips({ result }: { result: AiResult }) {
  const urls = parseJson<string[]>(result.citations, []);
  const ours = parseJson<string[]>(result.domains, []);
  if (!urls.length) return null;
  const isOurs = (url: string) => ours.some(domain => url.toLowerCase().includes(domain.toLowerCase()));
  return <div className="cite-chips">{urls.map((url, index) => {
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep raw URL */ }
    return <a key={`${url}:${index}`} href={url} target="_blank" rel="noopener noreferrer" className={`cite-chip${isOurs(url) ? ' ours' : ''}`} title={url}><ExternalLink size={9}/> {host}</a>;
  })}</div>;
}

function Thread({ promptId, promptText, provider, configured, onCitedChange }: {
  promptId: number; promptText: string; provider: string; configured: boolean; onCitedChange: () => void;
}) {
  const { toast } = useApp();
  const [thread, setThread] = useState<AiResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try { setThread(await api.getAiThread(promptId, provider)); } catch { setThread([]); }
    setLoading(false);
  }, [promptId, provider]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [thread.length, sending]);

  async function send() {
    const message = reply.trim();
    if (!message || sending) return;
    setSending(true);
    try { await api.replyAiThread(promptId, provider, message); setReply(''); await load(); onCitedChange(); }
    catch (error) { toast('error', error instanceof Error ? error.message : 'Reply failed'); }
    setSending(false);
  }

  const canReply = configured && provider !== 'brave';
  return <div className="ai-thread-wrap">
    <div className="ai-thread" ref={scrollRef}>
      {loading ? <div className="text-dim ai-thread-empty">Loading conversation…</div>
        : !thread.length ? <div className="text-dim ai-thread-empty">No runs yet for {PROVIDER_LABEL[provider] ?? provider}. Run this prompt to create the first answer.</div>
        : thread.map(result => <div key={result.id} className="ai-turn">
          <div className="ai-bubble user">{result.user_prompt ?? promptText}</div>
          {result.error ? <div className="ai-bubble assistant is-error"><div className="ai-bubble-meta">{PROVIDER_LABEL[provider]} · error</div>{result.error}</div>
            : <div className={`ai-bubble assistant${result.cited ? ' cited' : ''}`}><div className="ai-bubble-meta">{PROVIDER_LABEL[provider]}{result.model ? ` · ${result.model}` : ''} · {new Date(`${result.created_at}Z`).toLocaleString()}{result.cited ? <span className="badge badge-ok">cited: {parseJson<string[]>(result.domains, []).join(', ')}</span> : <span className="badge">not cited</span>}</div><div className="ai-bubble-text"><Markdown text={result.excerpt ?? ''}/></div><CitationChips result={result}/></div>}
        </div>)}
      {sending && <div className="ai-bubble assistant pending">Thinking…</div>}
    </div>
    <div className="ai-reply-row"><input className="input" placeholder={!configured ? `${PROVIDER_LABEL[provider]} has no API key configured` : provider === 'brave' ? 'Brave is a retrieval check — no conversation to continue' : `Ask ${PROVIDER_LABEL[provider]} a follow-up…`} value={reply} disabled={!canReply || sending} onChange={event => setReply(event.target.value)} onKeyDown={event => event.key === 'Enter' && send()}/><button className="btn btn-primary btn-sm" disabled={!canReply || sending || !reply.trim()} onClick={send}><Send size={13}/> {sending ? '…' : 'Send'}</button></div>
  </div>;
}

export default function CitationsPage() {
  const { toast, sites } = useApp();
  const [providers, setProviders] = useState<{ all: string[]; configured: string[] }>({ all: [], configured: [] });
  const [prompts, setPrompts] = useState<AiPrompt[]>([]);
  const [results, setResults] = useState<AiResult[]>([]);
  const [insights, setInsights] = useState<AiInsights>(EMPTY_INSIGHTS);
  const [competitorDomains, setCompetitorDomains] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [running, setRunning] = useState<number | 'all' | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [activeProvider, setActiveProvider] = useState('');
  const [editorPrompt, setEditorPrompt] = useState<AiPrompt | 'new' | null>(null);
  const [draft, setDraft] = useState<PromptDraft>(() => blankPrompt());
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [watchlistOpen, setWatchlistOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AiPrompt | null>(null);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | AiPromptCategory>('all');

  const load = useCallback(async () => {
    try {
      const [providerRows, promptRows, resultRows, nextInsights, config] = await Promise.all([api.getAiProviders(), api.getAiPrompts(), api.getAiResults(), api.getAiInsights(), api.getAiConfig()]);
      setProviders(providerRows); setPrompts(promptRows); setResults(resultRows); setInsights(nextInsights); setCompetitorDomains(config.competitorDomains);
      setActiveProvider(previous => previous || providerRows.configured[0] || providerRows.all[0] || '');
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Failed to load'); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const anyModalOpen = !!editorPrompt || guideOpen || watchlistOpen || !!deleteTarget || expanded != null;
  useEffect(() => {
    if (!anyModalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (guideOpen && editorPrompt) { setGuideOpen(false); return; }
      setEditorPrompt(null); setGuideOpen(false); setWatchlistOpen(false); setDeleteTarget(null); setExpanded(null);
    };
    window.addEventListener('keydown', close);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', close); };
  }, [anyModalOpen, guideOpen, editorPrompt]);

  const latest = useMemo(() => {
    const rows = new Map<string, AiResult>();
    for (const result of results.filter(row => row.parent_id == null)) { const key = `${result.prompt_id}:${result.provider}`; if (!rows.has(key)) rows.set(key, result); }
    return rows;
  }, [results]);
  const visiblePrompts = useMemo(() => prompts.filter(prompt => {
    const text = `${prompt.prompt} ${prompt.group_name} ${prompt.persona || ''}`.toLowerCase();
    return (categoryFilter === 'all' || prompt.category === categoryFilter) && text.includes(query.trim().toLowerCase());
  }), [prompts, query, categoryFilter]);
  const expandedPrompt = prompts.find(prompt => prompt.id === expanded);
  const noKeys = !providers.configured.length;

  function openCreate(seed?: { category: AiPromptCategory; prompt: string }) {
    setDraft({ ...blankPrompt(), ...(seed ? { category: seed.category, prompt: seed.prompt } : {}) });
    setGuideOpen(false); setEditorPrompt('new');
  }
  function openEdit(prompt: AiPrompt) { setDraft(editPromptDraft(prompt)); setExpanded(null); setEditorPrompt(prompt); }
  function openResults(id: number) { setActiveProvider(providers.configured[0] || providers.all[0] || ''); setExpanded(id); }

  async function savePrompt() {
    if (!draft.prompt.trim() || savingPrompt) return;
    setSavingPrompt(true);
    try {
      const schedule = { group_name: draft.group, locale: draft.locale, device: draft.device, persona: draft.persona || null, cadence: draft.cadence };
      if (editorPrompt === 'new') await api.addAiPrompt(draft.prompt.trim(), draft.siteId || null, draft.category, schedule);
      else if (editorPrompt) await api.updateAiPrompt(editorPrompt.id, { prompt: draft.prompt.trim(), site_id: draft.siteId || null, category: draft.category, ...schedule, enabled: draft.enabled ? 1 : 0 });
      const wasNew = editorPrompt === 'new'; setEditorPrompt(null); await load(); toast('success', wasNew ? 'Prompt added to the library.' : 'Prompt settings updated.');
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Could not save prompt'); }
    setSavingPrompt(false);
  }
  async function run(id: number | 'all') {
    setRunning(id);
    try { if (id === 'all') await api.runAllAiPrompts(); else await api.runAiPrompt(id); toast('success', 'Citation check complete'); await load(); }
    catch (error) { toast('error', error instanceof Error ? error.message : 'Run failed'); }
    setRunning(null);
  }
  async function remove() {
    if (!deleteTarget) return;
    await api.deleteAiPrompt(deleteTarget.id).catch(() => null);
    if (expanded === deleteTarget.id) setExpanded(null);
    setDeleteTarget(null); await load(); toast('success', 'Prompt deleted.');
  }
  async function saveCompetitors() {
    setSavingConfig(true);
    try { await api.saveAiConfig(competitorDomains); toast('success', 'Competitor watchlist saved'); setWatchlistOpen(false); await load(); }
    catch (error) { toast('error', error instanceof Error ? error.message : 'Could not save competitors'); }
    setSavingConfig(false);
  }

  return <div className="ops-page citations-page">
    <header className="ops-page-header citations-header">
      <div><span className="eyebrow"><Sparkles size={13}/> Generative engine intelligence</span><h1>AI visibility</h1><p>Track the real questions buyers ask, compare how answer engines respond, and identify the sources and content gaps that shape visibility.</p></div>
      <div className="header-actions"><button className="btn btn-secondary" onClick={() => setGuideOpen(true)}><CircleHelp size={14}/> Prompt guide</button><button className="btn btn-secondary" onClick={() => openCreate()}><Plus size={14}/> New prompt</button><button className="btn btn-primary" disabled={running !== null || noKeys || !prompts.length} onClick={() => run('all')}>{running === 'all' ? <><Loader2 size={13} className="spin"/> Running…</> : <><Play size={13}/> Run all prompts</>}</button></div>
    </header>

    {running !== null && <div className="alert alert-info" role="status"><div className="alert-content citations-run-status"><Loader2 size={14} className="spin"/><span>Querying {running === 'all' ? 'the prompt library across every configured provider' : 'this prompt across configured providers'}… live searches can take about a minute per provider.</span></div></div>}

    <div className="citation-provider-strip"><div><strong>Answer engines</strong><span>{providers.configured.length} of {providers.all.length} ready</span></div>{providers.all.map(provider => <span key={provider} className={providers.configured.includes(provider) ? 'ready' : ''}><i/><Bot size={12}/>{PROVIDER_LABEL[provider] ?? provider}<small>{providers.configured.includes(provider) ? 'Ready' : 'Needs key'}</small></span>)}{noKeys && <button className="btn btn-ghost btn-sm" onClick={() => window.location.assign('/settings')}><KeyRound size={12}/> Configure API keys</button>}</div>

    <section className="ops-card prompt-library">
      <header className="ops-card-head prompt-library-head"><div><span className="eyebrow"><Library size={12}/> Tracking workspace</span><h2>Prompt library</h2><p>One row per buyer question. Open a row to inspect answers; edit it to change scope, audience or schedule.</p></div><button className="btn btn-primary btn-sm" onClick={() => openCreate()}><Plus size={13}/> Add buyer question</button></header>
      <div className="ops-toolbar prompt-library-toolbar"><label className="ops-search"><Search size={14}/><input aria-label="Search prompts" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search questions, groups or personas…"/></label><div className="ops-segment"><button className={categoryFilter === 'all' ? 'active' : ''} onClick={() => setCategoryFilter('all')}>All</button>{Object.entries(CATEGORY_LABEL).map(([value, label]) => <button key={value} className={categoryFilter === value ? 'active' : ''} onClick={() => setCategoryFilter(value as AiPromptCategory)}>{label}</button>)}</div></div>
      {!prompts.length ? <div className="ops-empty prompt-empty"><MessageSquare/><h3>Build a balanced buyer-question set</h3><p>Start with a guided template or add a question you hear in sales, support or search research.</p><div><button className="btn btn-primary" onClick={() => setGuideOpen(true)}><Sparkles size={13}/> Browse examples</button><button className="btn btn-secondary" onClick={() => openCreate()}><Plus size={13}/> Write my own</button></div></div>
        : !visiblePrompts.length ? <div className="ops-empty compact"><Search/><strong>No prompts match these filters</strong><span>Try another category or search phrase.</span></div>
        : <div className="prompt-library-list">{visiblePrompts.map(prompt => {
          const checked = providers.all.filter(provider => latest.has(`${prompt.id}:${provider}`)).length;
          const cited = providers.all.filter(provider => latest.get(`${prompt.id}:${provider}`)?.cited).length;
          const site = sites.find(row => row.id === prompt.site_id);
          return <article key={prompt.id} className={!prompt.enabled ? 'disabled' : ''}><button className="prompt-library-copy" onClick={() => openResults(prompt.id)}><span><span className={`category-chip category-${prompt.category}`}>{CATEGORY_LABEL[prompt.category]}</span>{!prompt.enabled && <span className="prompt-paused">Paused</span>}</span><h3>{prompt.prompt}</h3><small><CalendarClock size={11}/>{prompt.group_name || 'Ungrouped'} · {site?.name || 'Whole workspace'} · {prompt.locale} · {prompt.device} · {prompt.cadence}</small></button><button className="prompt-result-summary" onClick={() => openResults(prompt.id)}><span><strong>{cited}</strong><small>citing</small></span><span><strong>{checked}</strong><small>checked</small></span><div>{providers.all.map(provider => { const result = latest.get(`${prompt.id}:${provider}`); return <i key={provider} className={!result ? '' : result.error ? 'error' : result.cited ? 'cited' : 'checked'} title={`${PROVIDER_LABEL[provider] ?? provider}: ${!result ? 'not run' : result.error ? 'error' : result.cited ? 'cited' : 'not cited'}`}/>})}</div></button><div className="prompt-row-actions"><button className="btn-icon btn-icon-ghost" aria-label={`Run ${prompt.prompt}`} title="Run this prompt" disabled={running !== null || noKeys || !prompt.enabled} onClick={() => run(prompt.id)}>{running === prompt.id ? <Loader2 size={13} className="spin"/> : <Play size={13}/>}</button><button className="btn-icon btn-icon-ghost" aria-label={`Edit ${prompt.prompt}`} title="Edit prompt" onClick={() => openEdit(prompt)}><Pencil size={13}/></button><button className="btn-icon btn-icon-ghost" aria-label={`Delete ${prompt.prompt}`} title="Delete prompt" onClick={() => setDeleteTarget(prompt)}><Trash2 size={13}/></button></div></article>;
        })}</div>}
    </section>

    <section className="geo-overview"><div className="geo-kpi primary"><span><Target size={17}/> Portfolio visibility</span><strong>{insights.overview.checks ? `${insights.overview.visibility}%` : '—'}</strong><small>{insights.overview.change == null ? 'Run twice to establish movement' : insights.overview.change >= 0 ? <><ArrowUpRight size={12}/> {insights.overview.change} points vs previous checks</> : <><ArrowDownRight size={12}/> {Math.abs(insights.overview.change)} points vs previous checks</>}</small></div><div className="geo-kpi"><span><MessageSquare size={16}/> Prompt set</span><strong>{insights.overview.prompts}</strong><small>buyer questions tracked</small></div><div className="geo-kpi"><span><CheckCircle2 size={16}/> Citations won</span><strong>{insights.overview.cited}<em>/{insights.overview.checks}</em></strong><small>latest successful checks</small></div><div className="geo-kpi"><span><Globe2 size={16}/> Source landscape</span><strong>{insights.overview.sourceDomains}</strong><small>domains shaping answers</small></div></section>

    <section className="geo-grid"><div className="command-panel geo-provider-panel"><div className="command-panel-head"><div><span className="eyebrow">Answer engines</span><h2>Visibility by provider</h2></div><TrendingUp size={16}/></div><div className="geo-provider-list">{providers.all.map(provider => { const item = insights.providers.find(row => row.provider === provider); const configured = providers.configured.includes(provider); return <div key={provider} className={!configured ? 'disabled' : ''}><span><Bot size={14}/><strong>{PROVIDER_LABEL[provider] ?? provider}</strong><small>{configured ? `${item?.cited ?? 0} of ${item?.checks ?? 0} prompts` : 'API key needed'}</small></span><div className="geo-progress"><i style={{ width: `${item?.visibility ?? 0}%` }}/></div><b>{configured ? `${item?.visibility ?? 0}%` : '—'}</b></div>; })}</div></div><div className="command-panel geo-sources-panel"><div className="command-panel-head"><div><span className="eyebrow">Citation graph</span><h2>Sources winning answers</h2></div><Trophy size={16}/></div><div className="source-list">{insights.sources.slice(0, 8).map((source, index) => <div key={source.domain} className={source.owned ? 'owned' : source.competitor ? 'competitor' : ''}><span className="source-rank">{index + 1}</span><span><strong>{source.domain}</strong><small>{source.providers.map(provider => PROVIDER_LABEL[provider] ?? provider).join(' · ')}</small></span>{source.owned && <em>your site</em>}{source.competitor && <em>competitor</em>}<b>{source.citations}</b></div>)}{!insights.sources.length && <div className="command-empty compact"><Globe2 size={22}/><strong>No citation graph yet</strong><span>Run your prompt set to map the domains that ground AI answers.</span></div>}</div></div></section>

    <section className="geo-grid geo-opportunity-grid"><div className="command-panel"><div className="command-panel-head"><div><span className="eyebrow">Gaps to close</span><h2>Prompt opportunities</h2></div><span className="signal-count">{insights.opportunities.length}</span></div><div className="opportunity-list">{insights.opportunities.slice(0, 6).map(item => <button key={item.promptId} onClick={() => openResults(item.promptId)}><span className={`category-chip category-${item.category}`}>{CATEGORY_LABEL[item.category]}</span><span><strong>{item.prompt}</strong><small>Missing from {item.missingProviders.map(provider => PROVIDER_LABEL[provider] ?? provider).join(', ')}</small></span><span>{item.citedProviders.length}/{providers.configured.length}</span></button>)}{!insights.opportunities.length && <div className="command-empty compact"><CheckCircle2 size={22}/><strong>No current gaps</strong><span>Add more prompts or providers to broaden coverage.</span></div>}</div></div><div className="command-panel competitor-panel"><div className="command-panel-head"><div><span className="eyebrow">Competitive context</span><h2>Source watchlist</h2></div><Settings2 size={16}/></div><p>Tag known competitor domains in the citation graph so wins and gaps are easier to interpret.</p><div className="competitor-summary"><strong>{competitorDomains.split(/[\s,]+/).filter(Boolean).length}</strong><span>competitor domains tracked</span></div><button className="btn btn-secondary btn-sm" onClick={() => setWatchlistOpen(true)}><Settings2 size={12}/> Manage watchlist</button></div></section>

    {!!insights.movements.length && <section className="command-panel answer-diff-panel"><div className="command-panel-head"><div><span className="eyebrow">Answer and source diffs</span><h2>What changed since the previous check</h2></div><span className="signal-count">{insights.movements.length} changes</span></div><div className="answer-diff-list">{insights.movements.slice(0, 10).map(item => <button key={`${item.promptId}:${item.provider}`} onClick={() => openResults(item.promptId)}><span className={`movement-dot ${item.cited !== item.previousCited ? item.cited ? 'gained' : 'lost' : 'changed'}`}/><span><strong>{item.prompt}</strong><small>{PROVIDER_LABEL[item.provider] ?? item.provider}{item.cited !== item.previousCited ? ` · citation ${item.cited ? 'gained' : 'lost'}` : item.answerChanged ? ' · answer changed' : ''}</small></span><span>{!!item.addedSources.length && <em>+{item.addedSources.join(', ')}</em>}{!!item.removedSources.length && <em className="removed">−{item.removedSources.join(', ')}</em>}</span></button>)}</div></section>}

    {editorPrompt && !guideOpen && <div className="ops-modal-backdrop" onMouseDown={() => setEditorPrompt(null)}><div className="ops-modal prompt-editor-modal" role="dialog" aria-modal="true" aria-labelledby="prompt-editor-title" onMouseDown={event => event.stopPropagation()}><header><div><span className="eyebrow">{editorPrompt === 'new' ? 'Add to the tracking library' : 'Update tracking policy'}</span><h2 id="prompt-editor-title">{editorPrompt === 'new' ? 'New buyer question' : 'Edit prompt'}</h2><p>Write one natural question, then define where and how it should be tracked.</p></div><button className="btn-icon btn-icon-ghost" aria-label="Close prompt editor" onClick={() => setEditorPrompt(null)}><X/></button></header><div className="prompt-editor-layout"><div className="prompt-editor-main"><section><header><span>1</span><div><h3>Buyer question</h3><p>Use the language a real person would type or say.</p></div></header><label>Question<textarea autoFocus rows={4} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} placeholder="What would your buyer ask an AI assistant?"/><small>{draft.prompt.trim().length} characters · one intent per prompt</small></label></section><section><header><span>2</span><div><h3>Intent</h3><p>Categories keep the library balanced across the buyer journey.</p></div></header><div className="prompt-category-picker">{Object.entries(CATEGORY_GUIDE).map(([value, guide]) => <button key={value} className={draft.category === value ? 'active' : ''} onClick={() => setDraft({ ...draft, category: value as AiPromptCategory })}><strong>{guide.label}</strong><span>{guide.purpose}</span></button>)}</div></section><section><header><span>3</span><div><h3>Tracking context</h3><p>Scope the question so repeated checks remain comparable.</p></div></header><div className="form-grid"><label>Website<select value={draft.siteId} onChange={event => setDraft({ ...draft, siteId: event.target.value })}><option value="">Whole workspace</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select><small>Use workspace-wide for category or brand-level questions.</small></label><label>Prompt group<input value={draft.group} onChange={event => setDraft({ ...draft, group: event.target.value })} placeholder="Core buyer journey"/></label><label>Locale<input value={draft.locale} onChange={event => setDraft({ ...draft, locale: event.target.value })} placeholder="en-GB"/></label><label>Device<select value={draft.device} onChange={event => setDraft({ ...draft, device: event.target.value })}><option value="desktop">Desktop</option><option value="mobile">Mobile</option></select></label><label>Persona<input value={draft.persona} onChange={event => setDraft({ ...draft, persona: event.target.value })} placeholder="Optional, e.g. small agency owner"/></label><label>Cadence<select value={draft.cadence} onChange={event => setDraft({ ...draft, cadence: event.target.value as AiPrompt['cadence'] })}><option value="manual">Manual only</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>{editorPrompt !== 'new' && <label className="checkbox-label full"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })}/> Tracking enabled</label>}</div></section></div><aside className="prompt-editor-guide"><span className={`category-chip category-${draft.category}`}>{CATEGORY_LABEL[draft.category]}</span><h3>Does this question work?</h3><p>{CATEGORY_GUIDE[draft.category].tip}</p><div><strong>Example</strong><button onClick={() => setDraft({ ...draft, prompt: CATEGORY_GUIDE[draft.category].example })}>{CATEGORY_GUIDE[draft.category].example}<span>Use this example</span></button></div><ul><li><CheckCircle2/> Sounds like a real buyer</li><li><CheckCircle2/> Has one clear intent</li><li><CheckCircle2/> Includes useful context</li><li><XCircle/> Does not force your brand into every question</li></ul><button className="btn btn-ghost btn-sm" onClick={() => setGuideOpen(true)}><CircleHelp size={12}/> Open the full guide</button></aside></div><footer><button className="btn btn-ghost" onClick={() => setEditorPrompt(null)}>Cancel</button><button className="btn btn-primary" disabled={!draft.prompt.trim() || savingPrompt} onClick={savePrompt}>{savingPrompt ? <Loader2 size={13} className="spin"/> : <Save size={13}/>} {savingPrompt ? 'Saving…' : editorPrompt === 'new' ? 'Add to library' : 'Save changes'}</button></footer></div></div>}

    {guideOpen && <div className="ops-modal-backdrop" onMouseDown={() => setGuideOpen(false)}><div className="ops-modal prompt-guide-modal" role="dialog" aria-modal="true" aria-labelledby="prompt-guide-title" onMouseDown={event => event.stopPropagation()}><header><div><span className="eyebrow">Practical prompt design</span><h2 id="prompt-guide-title">Build a useful buyer-question set</h2><p>Track questions that represent distinct moments in discovery, evaluation, purchase and support.</p></div><button className="btn-icon btn-icon-ghost" aria-label="Close prompt guide" onClick={() => setGuideOpen(false)}><X/></button></header><div className="prompt-guide-principles"><div><span>01</span><strong>Ask naturally</strong><p>Use the words a buyer would use, not an SEO keyword string.</p></div><div><span>02</span><strong>Change one variable</strong><p>Keep intent, market and persona stable so movement is meaningful.</p></div><div><span>03</span><strong>Balance the journey</strong><p>Combine unbranded discovery with comparison, commercial, brand and support checks.</p></div></div><div className="prompt-template-grid">{Object.entries(CATEGORY_GUIDE).map(([value, guide]) => <article key={value}><span className={`category-chip category-${value}`}>{guide.label}</span><h3>{guide.purpose}</h3><blockquote>{guide.example}</blockquote><p>{guide.tip}</p><button className="btn btn-secondary btn-sm" onClick={() => openCreate({ category: value as AiPromptCategory, prompt: guide.example })}><Plus size={12}/> Use template</button></article>)}</div><footer><span>A strong starter library usually contains 8–15 questions across at least three intents.</span><button className="btn btn-primary" onClick={() => openCreate()}><Plus size={13}/> Create a prompt</button></footer></div></div>}

    {expandedPrompt && <div className="ops-modal-backdrop" onMouseDown={() => setExpanded(null)}><div className="ops-modal prompt-results-modal" role="dialog" aria-modal="true" aria-labelledby="prompt-results-title" onMouseDown={event => event.stopPropagation()}><header><div><span className={`category-chip category-${expandedPrompt.category}`}>{CATEGORY_LABEL[expandedPrompt.category]}</span><h2 id="prompt-results-title">{expandedPrompt.prompt}</h2><p>{expandedPrompt.group_name || 'Ungrouped'} · {sites.find(site => site.id === expandedPrompt.site_id)?.name || 'Whole workspace'} · {expandedPrompt.locale} · {expandedPrompt.device} · {expandedPrompt.cadence}</p></div><div><button className="btn btn-secondary btn-sm" onClick={() => openEdit(expandedPrompt)}><Pencil size={12}/> Edit</button><button className="btn btn-primary btn-sm" disabled={running !== null || noKeys || !expandedPrompt.enabled} onClick={() => run(expandedPrompt.id)}>{running === expandedPrompt.id ? <Loader2 size={12} className="spin"/> : <Play size={12}/>} Run</button><button className="btn-icon btn-icon-ghost" aria-label="Close results" onClick={() => setExpanded(null)}><X/></button></div></header><div className="prompt-provider-tabs">{providers.all.map(provider => { const result = latest.get(`${expandedPrompt.id}:${provider}`); return <button key={provider} className={activeProvider === provider ? 'active' : ''} onClick={() => setActiveProvider(provider)}><Bot size={13}/><span><strong>{PROVIDER_LABEL[provider] ?? provider}</strong><small>{!providers.configured.includes(provider) ? 'Needs API key' : !result ? 'Not run yet' : result.error ? 'Run failed' : result.cited ? 'Citation found' : 'No citation'}</small></span>{result && !result.error && (result.cited ? <CheckCircle2 className="ok"/> : <XCircle/>)}</button>; })}</div>{activeProvider ? <Thread key={`${expandedPrompt.id}:${activeProvider}`} promptId={expandedPrompt.id} promptText={expandedPrompt.prompt} provider={activeProvider} configured={providers.configured.includes(activeProvider)} onCitedChange={load}/> : <div className="ops-empty"><Bot/><strong>No provider selected</strong><span>Configure an answer engine to start tracking this question.</span></div>}</div></div>}

    {watchlistOpen && <div className="ops-modal-backdrop" onMouseDown={() => setWatchlistOpen(false)}><div className="ops-modal prompt-watchlist-modal" role="dialog" aria-modal="true" aria-labelledby="watchlist-title" onMouseDown={event => event.stopPropagation()}><header><div><span className="eyebrow">Competitive context</span><h2 id="watchlist-title">Source watchlist</h2><p>When these domains appear in citations, the source graph will label them as competitors.</p></div><button className="btn-icon btn-icon-ghost" aria-label="Close watchlist" onClick={() => setWatchlistOpen(false)}><X/></button></header><label>Competitor domains<textarea rows={7} value={competitorDomains} onChange={event => setCompetitorDomains(event.target.value)} placeholder={'competitor.com\nanother-rival.co.uk'}/><small>Separate domains with spaces, commas or new lines. Do not include paths.</small></label><footer><button className="btn btn-ghost" onClick={() => setWatchlistOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={savingConfig} onClick={saveCompetitors}>{savingConfig ? <Loader2 size={13} className="spin"/> : <Save size={13}/>} Save watchlist</button></footer></div></div>}

    {deleteTarget && <div className="ops-modal-backdrop" onMouseDown={() => setDeleteTarget(null)}><div className="ops-modal prompt-delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-prompt-title" onMouseDown={event => event.stopPropagation()}><header><span className="prompt-delete-icon"><AlertTriangle/></span><div><span className="eyebrow danger">Remove tracking history</span><h2 id="delete-prompt-title">Delete this prompt?</h2><p>The prompt and its stored provider results will be removed. This cannot be undone.</p></div><button className="btn-icon btn-icon-ghost" aria-label="Close delete confirmation" onClick={() => setDeleteTarget(null)}><X/></button></header><blockquote>{deleteTarget.prompt}</blockquote><footer><button className="btn btn-ghost" onClick={() => setDeleteTarget(null)}>Keep prompt</button><button className="btn btn-danger" onClick={remove}><Trash2 size={13}/> Delete prompt</button></footer></div></div>}
  </div>;
}
