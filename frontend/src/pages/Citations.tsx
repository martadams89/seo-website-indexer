import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Bot, CalendarClock, CheckCircle2, CircleHelp,
  ExternalLink, Globe2, History, KeyRound, Library, Loader2, MessageSquare, Pencil, Play, Plus,
  Save, Search, Send, Settings2, Sparkles, Target, Trash2, TrendingUp, Trophy, WandSparkles, XCircle,
} from 'lucide-react';
import { api, type AiCitationConfig, type AiInsights, type AiMigrationPlan, type AiMigrationPolicy, type AiPrompt, type AiPromptCategory, type AiResult, type CitationAttribution } from '../api';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { useApp } from '../AppContext';
import { useInsights } from '../insights/InsightsContext';
import { Link } from 'react-router-dom';

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
  overview: { prompts: 0, configuredProviders: 0, checks: 0, cited: 0, visibility: 0, previousVisibility: null, change: null, sourceDomains: 0,
    directCitations: 0, thirdPartyCitations: 0, mentionOnlyCitations: 0 },
  providers: [], trend: [], sources: [], opportunities: [], movements: [],
};
const EMPTY_IDENTITY: AiCitationConfig['identity'] = { aliases: [], ownedDomains: [], profiles: [] };

interface PromptDraft {
  prompt: string; siteId: string; category: AiPromptCategory; group: string; locale: string;
  device: string; persona: string; cadence: AiPrompt['cadence']; enabled: boolean;
}

const blankPrompt = (): PromptDraft => ({
  prompt: '', siteId: '', category: 'discovery', group: 'Core buyer journey', locale: 'en-GB',
  device: 'desktop', persona: '', cadence: 'weekly', enabled: true,
});

const blankUpgrade = (): AiMigrationPolicy => ({
  group_name: 'Imported citation prompts', locale: 'en-GB', device: 'desktop', cadence: 'manual', categories: {},
});

function editPromptDraft(prompt: AiPrompt): PromptDraft {
  return { prompt: prompt.prompt, siteId: prompt.site_id || '', category: prompt.category, group: prompt.group_name, locale: prompt.locale, device: prompt.device, persona: prompt.persona || '', cadence: prompt.cadence, enabled: !!prompt.enabled };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

function CitationChips({ result }: { result: AiResult }) {
  const urls = parseJson<string[]>(result.citations, []);
  const attributions = parseJson<CitationAttribution[]>(result.attributions, []);
  if (!urls.length) return null;
  const attributionFor = (url: string) => {
    let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return undefined; }
    return attributions.find(item => item.url === url || (item.domain && (host === item.domain || host.endsWith(`.${item.domain}`))));
  };
  return <div className="cite-chips">{urls.map((url, index) => {
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep raw URL */ }
    const attribution = attributionFor(url);
    return <a key={`${url}:${index}`} href={url} target="_blank" rel="noopener noreferrer" className={`cite-chip${attribution?.kind === 'owned_site' ? ' ours' : attribution ? ' attributed' : ''}`} title={attribution ? `${attribution.source}: ${attribution.entity}` : url}><ExternalLink size={9}/> {host}{attribution && <small>{attribution.kind === 'owned_site' ? 'your site' : attribution.source}</small>}</a>;
  })}</div>;
}

function citationLabel(result: AiResult): { label: string; detail: string; kind: 'direct' | 'third-party' | 'mention' | 'none' } {
  const items = parseJson<CitationAttribution[]>(result.attributions, []);
  const direct = items.filter(item => item.kind === 'owned_site');
  if (direct.length) return { label: 'Direct website citation', detail: [...new Set(direct.map(item => item.matched))].join(', '), kind: 'direct' };
  const thirdParty = items.filter(item => item.kind === 'third_party_profile' || item.kind === 'marketplace');
  if (thirdParty.length) return { label: 'Third-party entity citation', detail: [...new Set(thirdParty.map(item => item.source))].join(', '), kind: 'third-party' };
  const mentions = items.filter(item => item.kind === 'brand_mention');
  if (mentions.length) return { label: 'Brand/entity mentioned', detail: [...new Set(mentions.map(item => item.entity))].join(', '), kind: 'mention' };
  return { label: 'Not cited', detail: 'No tracked website, profile, marketplace listing or brand name found', kind: 'none' };
}

function CitationBadge({ result }: { result: AiResult }) {
  const status = citationLabel(result);
  return <span className={`badge citation-status citation-status-${status.kind}`} title={status.detail}>{status.label}<small>{status.detail}</small></span>;
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
            : <div className={`ai-bubble assistant${result.cited ? ' cited' : ''}`}><div className="ai-bubble-meta">{PROVIDER_LABEL[provider]}{result.model ? ` · ${result.model}` : ''} · {new Date(`${result.created_at}Z`).toLocaleString()}<CitationBadge result={result}/></div><div className="ai-bubble-text"><Markdown text={result.excerpt ?? ''}/></div><CitationChips result={result}/></div>}
        </div>)}
      {sending && <div className="ai-bubble assistant pending">Thinking…</div>}
    </div>
    <div className="ai-reply-row"><input className="input" placeholder={!configured ? `${PROVIDER_LABEL[provider]} has no API key configured` : provider === 'brave' ? 'Brave is a retrieval check — no conversation to continue' : `Ask ${PROVIDER_LABEL[provider]} a follow-up…`} value={reply} disabled={!canReply || sending} onChange={event => setReply(event.target.value)} onKeyDown={event => event.key === 'Enter' && send()}/><button className="btn btn-primary btn-sm" disabled={!canReply || sending || !reply.trim()} onClick={send}><Send size={13}/> {sending ? '…' : 'Send'}</button></div>
  </div>;
}

export default function CitationsPage() {
  const { toast, sites } = useApp();
  const { siteScope, range } = useInsights();
  const [providers, setProviders] = useState<{ all: string[]; configured: string[] }>({ all: [], configured: [] });
  const [prompts, setPrompts] = useState<AiPrompt[]>([]);
  const [migration, setMigration] = useState<AiMigrationPlan>({ prompts: [], prompt_count: 0, result_count: 0 });
  const [results, setResults] = useState<AiResult[]>([]);
  const [insights, setInsights] = useState<AiInsights>(EMPTY_INSIGHTS);
  const [competitorDomains, setCompetitorDomains] = useState('');
  const [brandAliases, setBrandAliases] = useState('');
  const [identity, setIdentity] = useState<AiCitationConfig['identity']>(EMPTY_IDENTITY);
  const [savingConfig, setSavingConfig] = useState(false);
  const [running, setRunning] = useState<number | 'all' | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [activeProvider, setActiveProvider] = useState('');
  const [editorPrompt, setEditorPrompt] = useState<AiPrompt | 'new' | null>(null);
  const [draft, setDraft] = useState<PromptDraft>(() => blankPrompt());
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeDraft, setUpgradeDraft] = useState<AiMigrationPolicy>(() => blankUpgrade());
  const [upgrading, setUpgrading] = useState(false);
  const [watchlistOpen, setWatchlistOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AiPrompt | null>(null);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | AiPromptCategory>('all');

  const load = useCallback(async () => {
    try {
      const [providerRows, promptRows, resultRows, nextInsights, config, migrationPlan] = await Promise.all([api.getAiProviders(), api.getAiPrompts(), api.getAiResults(), api.getAiInsights({ siteId: siteScope === 'all' ? undefined : siteScope === 'workspace' ? null : siteScope, scoped: siteScope !== 'all', days: range }), api.getAiConfig(), api.getAiMigration()]);
      setProviders(providerRows); setPrompts(promptRows); setResults(resultRows); setInsights(nextInsights); setCompetitorDomains(config.competitorDomains); setBrandAliases(config.brandAliases); setIdentity(config.identity); setMigration(migrationPlan);
      setActiveProvider(previous => previous || providerRows.configured[0] || providerRows.all[0] || '');
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Failed to load'); }
  }, [toast, siteScope, range]);
  useEffect(() => { load(); }, [load]);

  const latest = useMemo(() => {
    const rows = new Map<string, AiResult>();
    for (const result of results.filter(row => row.parent_id == null)) { const key = `${result.prompt_id}:${result.provider}`; if (!rows.has(key)) rows.set(key, result); }
    return rows;
  }, [results]);
  const scopedPrompts = useMemo(() => prompts.filter(prompt => (
    siteScope === 'all' ? true : siteScope === 'workspace' ? prompt.site_id == null : prompt.site_id === siteScope
  )), [prompts, siteScope]);
  const visiblePrompts = useMemo(() => scopedPrompts.filter(prompt => {
    const text = `${prompt.prompt} ${prompt.group_name} ${prompt.persona || ''}`.toLowerCase();
    return (categoryFilter === 'all' || prompt.category === categoryFilter) && text.includes(query.trim().toLowerCase());
  }), [scopedPrompts, query, categoryFilter]);
  const expandedPrompt = prompts.find(prompt => prompt.id === expanded);
  const noKeys = !providers.configured.length;

  function openCreate(seed?: { category: AiPromptCategory; prompt: string }) {
    const scopedSite = siteScope === 'all' || siteScope === 'workspace' ? '' : siteScope;
    setDraft({ ...blankPrompt(), siteId: scopedSite, ...(seed ? { category: seed.category, prompt: seed.prompt } : {}) });
    setGuideOpen(false); setEditorPrompt('new');
  }
  function openEdit(prompt: AiPrompt) { setDraft(editPromptDraft(prompt)); setExpanded(null); setEditorPrompt(prompt); }
  function openResults(id: number) { setActiveProvider(providers.configured[0] || providers.all[0] || ''); setExpanded(id); }
  function openUpgrade() {
    setUpgradeDraft({ ...blankUpgrade(), categories: Object.fromEntries(migration.prompts.map(prompt => [String(prompt.id), prompt.suggested_category])) });
    setUpgradeOpen(true);
  }

  async function savePrompt() {
    if (!draft.prompt.trim() || savingPrompt) return;
    setSavingPrompt(true);
    try {
      const schedule = { group_name: draft.group, locale: draft.locale, device: draft.device, persona: draft.persona || null, cadence: draft.cadence };
      if (editorPrompt === 'new') await api.addAiPrompt(draft.prompt.trim(), draft.siteId || null, draft.category, schedule);
      else if (editorPrompt) await api.updateAiPrompt(editorPrompt.id, { prompt: draft.prompt.trim(), site_id: draft.siteId || null, category: draft.category, ...schedule, enabled: draft.enabled ? 1 : 0 });
      const wasNew = editorPrompt === 'new';
      const wasLegacy = editorPrompt !== 'new' && !!editorPrompt && editorPrompt.schema_version < 2;
      setEditorPrompt(null); await load();
      toast('success', wasNew ? 'Prompt added to the library.' : wasLegacy ? 'Prompt upgraded and settings saved. Historical answers were preserved.' : 'Prompt settings updated.');
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Could not save prompt'); }
    setSavingPrompt(false);
  }
  async function run(id: number | 'all') {
    setRunning(id);
    try { if (id === 'all') await api.runAllAiPrompts({ siteId: siteScope === 'all' ? undefined : siteScope === 'workspace' ? null : siteScope, scoped: siteScope !== 'all' }); else await api.runAiPrompt(id); toast('success', 'Citation check complete'); await load(); }
    catch (error) { toast('error', error instanceof Error ? error.message : 'Run failed'); }
    setRunning(null);
  }
  async function remove() {
    if (!deleteTarget) return;
    await api.deleteAiPrompt(deleteTarget.id).catch(() => null);
    if (expanded === deleteTarget.id) setExpanded(null);
    setDeleteTarget(null); await load(); toast('success', 'Prompt deleted.');
  }
  async function saveAttributionConfig() {
    setSavingConfig(true);
    try { await api.saveAiConfig({ competitorDomains, brandAliases }); toast('success', 'Citation identity and competitor watchlist saved. Stored answers have been reclassified.'); setWatchlistOpen(false); await load(); }
    catch (error) { toast('error', error instanceof Error ? error.message : 'Could not save citation identity'); }
    setSavingConfig(false);
  }
  async function upgradePrompts() {
    if (upgrading) return;
    setUpgrading(true);
    try {
      const result = await api.upgradeAiPrompts(upgradeDraft);
      setUpgradeOpen(false); await load();
      toast('success', `${result.prompts_upgraded} legacy prompt${result.prompts_upgraded === 1 ? '' : 's'} upgraded; ${result.results_preserved} historical answer${result.results_preserved === 1 ? '' : 's'} preserved.`);
    } catch (error) { toast('error', error instanceof Error ? error.message : 'Could not upgrade prompts'); }
    setUpgrading(false);
  }

  return <div className="ops-page citations-page">
    <header className="ops-page-header citations-header">
      <div><span className="eyebrow"><Sparkles size={13}/> Generative engine intelligence</span><h1>AI visibility</h1><p>Track the real questions buyers ask, compare how answer engines respond, and identify the sources and content gaps that shape visibility.</p></div>
      <div className="header-actions"><button className="btn btn-secondary" onClick={() => setGuideOpen(true)}><CircleHelp size={14}/> Prompt guide</button><button className="btn btn-secondary" onClick={() => openCreate()}><Plus size={14}/> New prompt</button><button className="btn btn-primary" title="Runs every prompt in the selected website scope; library search and category filters only change this list" disabled={running !== null || noKeys || !scopedPrompts.length} onClick={() => run('all')}>{running === 'all' ? <><Loader2 size={13} className="spin"/> Running…</> : <><Play size={13}/> Run selected scope ({scopedPrompts.length})</>}</button></div>
    </header>

    {running !== null && <div className="alert alert-info" role="status"><div className="alert-content citations-run-status"><Loader2 size={14} className="spin"/><span>Querying {running === 'all' ? 'the prompt library across every configured provider' : 'this prompt across configured providers'}… live searches can take about a minute per provider.</span></div></div>}

    {!!migration.prompt_count && <section className="citation-upgrade-banner" aria-label="Legacy citation upgrade available"><div className="citation-upgrade-icon"><WandSparkles/></div><div><span className="eyebrow">Safe in-place upgrade</span><h2>{migration.prompt_count} legacy citation prompt{migration.prompt_count === 1 ? '' : 's'} can use the new tracking format</h2><p>Add intent, locale, audience, device and cadence without replacing prompt IDs or losing {migration.result_count} stored answer{migration.result_count === 1 ? '' : 's'}.</p></div><button className="btn btn-primary" onClick={openUpgrade}><WandSparkles size={14}/> Review upgrade</button></section>}

    <div className="citation-provider-strip"><div><strong>Answer engines</strong><span>{providers.configured.length} of {providers.all.length} ready</span></div>{providers.all.map(provider => <span key={provider} className={providers.configured.includes(provider) ? 'ready' : ''}><i/><Bot size={12}/>{PROVIDER_LABEL[provider] ?? provider}<small>{providers.configured.includes(provider) ? 'Ready' : 'Needs key'}</small></span>)}{noKeys && <Link className="btn btn-ghost btn-sm" to="/settings?tab=keys"><KeyRound size={12}/> Configure API keys</Link>}</div>

    <section className="ops-card prompt-library">
      <header className="ops-card-head prompt-library-head"><div><span className="eyebrow"><Library size={12}/> Tracking workspace</span><h2>Prompt library</h2><p>One row per buyer question. Open a row to inspect answers; edit it to change scope, audience or schedule.</p></div><button className="btn btn-primary btn-sm" onClick={() => openCreate()}><Plus size={13}/> Add buyer question</button></header>
      <div className="ops-toolbar prompt-library-toolbar"><label className="ops-search"><Search size={14}/><input aria-label="Search prompts" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search questions, groups or personas…"/></label><div className="ops-segment"><button className={categoryFilter === 'all' ? 'active' : ''} onClick={() => setCategoryFilter('all')}>All</button>{Object.entries(CATEGORY_LABEL).map(([value, label]) => <button key={value} className={categoryFilter === value ? 'active' : ''} onClick={() => setCategoryFilter(value as AiPromptCategory)}>{label}</button>)}</div></div>
      {!prompts.length ? <div className="ops-empty prompt-empty"><MessageSquare/><h3>Build a balanced buyer-question set</h3><p>Start with a guided template or add a question you hear in sales, support or search research.</p><div><button className="btn btn-primary" onClick={() => setGuideOpen(true)}><Sparkles size={13}/> Browse examples</button><button className="btn btn-secondary" onClick={() => openCreate()}><Plus size={13}/> Write my own</button></div></div>
        : !visiblePrompts.length ? <div className="ops-empty compact"><Search/><strong>No prompts match these filters</strong><span>Try another category or search phrase.</span></div>
        : <div className="prompt-library-list">{visiblePrompts.map(prompt => {
          const checked = providers.all.filter(provider => latest.has(`${prompt.id}:${provider}`)).length;
          const cited = providers.all.filter(provider => latest.get(`${prompt.id}:${provider}`)?.cited).length;
          const site = sites.find(row => row.id === prompt.site_id);
          return <article key={prompt.id} className={!prompt.enabled ? 'disabled' : ''}><button className="prompt-library-copy" onClick={() => openResults(prompt.id)}><span><span className={`category-chip category-${prompt.category}`}>{CATEGORY_LABEL[prompt.category]}</span>{prompt.schema_version < 2 && <span className="prompt-legacy">Legacy</span>}{!prompt.enabled && <span className="prompt-paused">Paused</span>}</span><h3>{prompt.prompt}</h3><small><CalendarClock size={11}/>{prompt.group_name || 'Ungrouped'} · {site?.name || 'Whole workspace'} · {prompt.locale} · {prompt.device} · {prompt.cadence}</small></button><button className="prompt-result-summary" onClick={() => openResults(prompt.id)}><span><strong>{cited}</strong><small>citing</small></span><span><strong>{checked}</strong><small>checked</small></span><div>{providers.all.map(provider => { const result = latest.get(`${prompt.id}:${provider}`); return <i key={provider} className={!result ? '' : result.error ? 'error' : result.cited ? 'cited' : 'checked'} title={`${PROVIDER_LABEL[provider] ?? provider}: ${!result ? 'not run' : result.error ? 'error' : result.cited ? 'cited' : 'not cited'}`}/>})}</div></button><div className="prompt-row-actions"><button className="btn-icon btn-icon-ghost" aria-label={`Run ${prompt.prompt}`} title="Run this prompt" disabled={running !== null || noKeys || !prompt.enabled} onClick={() => run(prompt.id)}>{running === prompt.id ? <Loader2 size={13} className="spin"/> : <Play size={13}/>}</button><button className="btn btn-secondary btn-sm prompt-edit-action" aria-label={`Edit ${prompt.prompt}`} onClick={() => openEdit(prompt)}><Pencil size={12}/> Edit</button><button className="btn-icon btn-icon-ghost" aria-label={`Delete ${prompt.prompt}`} title="Delete prompt" onClick={() => setDeleteTarget(prompt)}><Trash2 size={13}/></button></div></article>;
        })}</div>}
    </section>

    <section className="geo-overview"><div className="geo-kpi primary"><span><Target size={17}/> Portfolio visibility</span><strong>{insights.overview.checks ? `${insights.overview.visibility}%` : '—'}</strong><small>{insights.overview.change == null ? 'Run twice to establish movement' : insights.overview.change >= 0 ? <><ArrowUpRight size={12}/> {insights.overview.change} points vs previous checks</> : <><ArrowDownRight size={12}/> {Math.abs(insights.overview.change)} points vs previous checks</>}</small></div><div className="geo-kpi"><span><MessageSquare size={16}/> Prompt set</span><strong>{insights.overview.prompts}</strong><small>buyer questions tracked</small></div><div className="geo-kpi"><span><CheckCircle2 size={16}/> Citations won</span><strong>{insights.overview.cited}<em>/{insights.overview.checks}</em></strong><small>{insights.overview.directCitations} direct · {insights.overview.thirdPartyCitations} third-party · {insights.overview.mentionOnlyCitations} mention-only</small></div><div className="geo-kpi"><span><Globe2 size={16}/> Source landscape</span><strong>{insights.overview.sourceDomains}</strong><small>domains shaping answers</small></div></section>

    <section className="geo-grid"><div className="command-panel geo-provider-panel"><div className="command-panel-head"><div><span className="eyebrow">Answer engines</span><h2>Visibility by provider</h2></div><TrendingUp size={16}/></div><div className="geo-provider-list">{providers.all.map(provider => { const item = insights.providers.find(row => row.provider === provider); const configured = providers.configured.includes(provider); return <div key={provider} className={!configured ? 'disabled' : ''}><span><Bot size={14}/><strong>{PROVIDER_LABEL[provider] ?? provider}</strong><small>{configured ? `${item?.cited ?? 0} of ${item?.checks ?? 0} prompts` : 'API key needed'}</small></span><div className="geo-progress"><i style={{ width: `${item?.visibility ?? 0}%` }}/></div><b>{configured ? `${item?.visibility ?? 0}%` : '—'}</b></div>; })}</div></div><div className="command-panel geo-sources-panel"><div className="command-panel-head"><div><span className="eyebrow">Citation graph</span><h2>Sources winning answers</h2></div><Trophy size={16}/></div><div className="source-list">{insights.sources.slice(0, 8).map((source, index) => <div key={source.domain} className={source.owned ? 'owned' : source.competitor ? 'competitor' : source.attributed ? 'attributed' : ''}><span className="source-rank">{index + 1}</span><span><strong>{source.domain}</strong><small>{source.providers.map(provider => PROVIDER_LABEL[provider] ?? provider).join(' · ')}</small></span>{source.owned && <em>your site</em>}{!source.owned && source.attributed && <em title={source.entities.join(', ')}>cites your entity</em>}{source.competitor && <em>competitor</em>}<b>{source.citations}</b></div>)}{!insights.sources.length && <div className="command-empty compact"><Globe2 size={22}/><strong>No citation graph yet</strong><span>Run your prompt set to map the domains that ground AI answers.</span></div>}</div></div></section>

    <section className="geo-grid geo-opportunity-grid"><div className="command-panel"><div className="command-panel-head"><div><span className="eyebrow">Gaps to close</span><h2>Prompt opportunities</h2></div><span className="signal-count">{insights.opportunities.length}</span></div><div className="opportunity-list">{insights.opportunities.slice(0, 6).map(item => <button key={item.promptId} onClick={() => openResults(item.promptId)}><span className={`category-chip category-${item.category}`}>{CATEGORY_LABEL[item.category]}</span><span><strong>{item.prompt}</strong><small>Missing from {item.missingProviders.map(provider => PROVIDER_LABEL[provider] ?? provider).join(', ')}</small></span><span>{item.citedProviders.length}/{providers.configured.length}</span></button>)}{!insights.opportunities.length && <div className="command-empty compact"><CheckCircle2 size={22}/><strong>No current gaps</strong><span>Add more prompts or providers to broaden coverage.</span></div>}</div></div><div className="command-panel competitor-panel attribution-panel"><div className="command-panel-head"><div><span className="eyebrow">Entity-aware measurement</span><h2>Your citation identity</h2></div><Settings2 size={16}/></div><p>Direct links, named mentions and citations through app stores, review marketplaces or other profiles all count—with the evidence type kept separate.</p><div className="attribution-summary"><span><strong>{identity.ownedDomains.length}</strong> owned domains</span><span><strong>{identity.aliases.length}</strong> names</span><span><strong>{identity.profiles.length}</strong> profiles</span></div><button className="btn btn-secondary btn-sm" onClick={() => setWatchlistOpen(true)}><Settings2 size={12}/> Manage attribution</button></div></section>

    {!!insights.movements.length && <section className="command-panel answer-diff-panel"><div className="command-panel-head"><div><span className="eyebrow">Answer and source diffs</span><h2>What changed since the previous check</h2></div><span className="signal-count">{insights.movements.length} changes</span></div><div className="answer-diff-list">{insights.movements.slice(0, 10).map(item => <button key={`${item.promptId}:${item.provider}`} onClick={() => openResults(item.promptId)}><span className={`movement-dot ${item.cited !== item.previousCited ? item.cited ? 'gained' : 'lost' : 'changed'}`}/><span><strong>{item.prompt}</strong><small>{PROVIDER_LABEL[item.provider] ?? item.provider}{item.cited !== item.previousCited ? ` · citation ${item.cited ? 'gained' : 'lost'}` : item.answerChanged ? ' · answer changed' : ''}</small></span><span>{!!item.addedSources.length && <em>+{item.addedSources.join(', ')}</em>}{!!item.removedSources.length && <em className="removed">−{item.removedSources.join(', ')}</em>}</span></button>)}</div></section>}

    {editorPrompt && !guideOpen && <Modal onClose={() => setEditorPrompt(null)} size="xl" className="prompt-editor-modal" eyebrow={editorPrompt === 'new' ? 'Add to the tracking library' : 'Update tracking policy'} title={editorPrompt === 'new' ? 'New buyer question' : 'Edit prompt'} description="Write one natural question, then define where and how it should be tracked." icon={<MessageSquare/>} footer={<><button className="btn btn-ghost" onClick={() => setEditorPrompt(null)}>Cancel</button><button className="btn btn-primary" disabled={!draft.prompt.trim() || savingPrompt} onClick={savePrompt}>{savingPrompt ? <Loader2 size={13} className="spin"/> : <Save size={13}/>} {savingPrompt ? 'Saving…' : editorPrompt === 'new' ? 'Add to library' : 'Save changes'}</button></>}><div className="prompt-editor-layout"><div className="prompt-editor-main"><section><header><span>1</span><div><h3>Buyer question</h3><p>Use the language a real person would type or say.</p></div></header><label>Question<textarea data-autofocus rows={4} value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} placeholder="What would your buyer ask an AI assistant?"/><small>{draft.prompt.trim().length} characters · one intent per prompt</small></label></section><section><header><span>2</span><div><h3>Intent</h3><p>Categories keep the library balanced across the buyer journey.</p></div></header><div className="prompt-category-picker">{Object.entries(CATEGORY_GUIDE).map(([value, guide]) => <button key={value} className={draft.category === value ? 'active' : ''} onClick={() => setDraft({ ...draft, category: value as AiPromptCategory })}><strong>{guide.label}</strong><span>{guide.purpose}</span></button>)}</div></section><section><header><span>3</span><div><h3>Tracking context</h3><p>Scope the question so repeated checks remain comparable.</p></div></header><div className="form-grid"><label>Website<select value={draft.siteId} onChange={event => setDraft({ ...draft, siteId: event.target.value })}><option value="">Whole workspace</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select><small>Use workspace-wide for category or brand-level questions.</small></label><label>Prompt group<input value={draft.group} onChange={event => setDraft({ ...draft, group: event.target.value })} placeholder="Core buyer journey"/></label><label>Locale<input value={draft.locale} onChange={event => setDraft({ ...draft, locale: event.target.value })} placeholder="en-GB"/></label><label>Device<select value={draft.device} onChange={event => setDraft({ ...draft, device: event.target.value })}><option value="desktop">Desktop</option><option value="mobile">Mobile</option></select></label><label>Persona<input value={draft.persona} onChange={event => setDraft({ ...draft, persona: event.target.value })} placeholder="Optional, e.g. small agency owner"/></label><label>Cadence<select value={draft.cadence} onChange={event => setDraft({ ...draft, cadence: event.target.value as AiPrompt['cadence'] })}><option value="manual">Manual only</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>{editorPrompt !== 'new' && <label className="checkbox-label full"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })}/> Tracking enabled</label>}</div></section></div><aside className="prompt-editor-guide"><span className={`category-chip category-${draft.category}`}>{CATEGORY_LABEL[draft.category]}</span><h3>Does this question work?</h3><p>{CATEGORY_GUIDE[draft.category].tip}</p><div><strong>Example</strong><button onClick={() => setDraft({ ...draft, prompt: CATEGORY_GUIDE[draft.category].example })}>{CATEGORY_GUIDE[draft.category].example}<span>Use this example</span></button></div><ul><li><CheckCircle2/> Sounds like a real buyer</li><li><CheckCircle2/> Has one clear intent</li><li><CheckCircle2/> Includes useful context</li><li><XCircle/> Does not force your brand into every question</li></ul><button className="btn btn-ghost btn-sm" onClick={() => setGuideOpen(true)}><CircleHelp size={12}/> Open the full guide</button></aside></div></Modal>}

    {upgradeOpen && <Modal onClose={() => setUpgradeOpen(false)} size="xl" className="prompt-upgrade-modal" eyebrow="Legacy citation uplift" title={`Upgrade ${migration.prompt_count} prompt${migration.prompt_count === 1 ? '' : 's'} safely`} description={`The same prompt and result IDs stay in place. ${migration.result_count} historical answer${migration.result_count === 1 ? '' : 's'} will be attached to ${migration.result_count === 1 ? 'its' : 'their'} original question before metadata changes.`} icon={<WandSparkles/>} footer={<><span className="upgrade-preservation"><History size={13}/> No citation history will be deleted</span><button className="btn btn-ghost" onClick={() => setUpgradeOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={upgrading} onClick={upgradePrompts}>{upgrading ? <Loader2 size={13} className="spin"/> : <WandSparkles size={13}/>} {upgrading ? 'Upgrading…' : 'Upgrade prompts'}</button></>}><div className="prompt-upgrade-layout"><section><header><span>1</span><div><h3>Shared tracking context</h3><p>These defaults make old checks comparable. You can edit each prompt again later.</p></div></header><div className="form-grid"><label>Website<select value={upgradeDraft.site_id ?? ''} onChange={event => setUpgradeDraft({ ...upgradeDraft, site_id: event.target.value || null })}><option value="">Keep current / whole workspace</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label><label>Prompt group<input value={upgradeDraft.group_name} onChange={event => setUpgradeDraft({ ...upgradeDraft, group_name: event.target.value })}/></label><label>Locale<input value={upgradeDraft.locale} onChange={event => setUpgradeDraft({ ...upgradeDraft, locale: event.target.value })} placeholder="en-GB"/></label><label>Device<select value={upgradeDraft.device} onChange={event => setUpgradeDraft({ ...upgradeDraft, device: event.target.value })}><option value="desktop">Desktop</option><option value="mobile">Mobile</option></select></label><label>Persona<input value={upgradeDraft.persona ?? ''} onChange={event => setUpgradeDraft({ ...upgradeDraft, persona: event.target.value || null })} placeholder="Optional audience context"/></label><label>Cadence<select value={upgradeDraft.cadence} onChange={event => setUpgradeDraft({ ...upgradeDraft, cadence: event.target.value as AiPrompt['cadence'] })}><option value="manual">Manual only</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label></div></section><section><header><span>2</span><div><h3>Review suggested intent</h3><p>Suggestions use wording only. Change anything that does not match the buyer journey.</p></div></header><div className="upgrade-prompt-list">{migration.prompts.map(prompt => <article key={prompt.id}><div><strong>{prompt.prompt}</strong><small><History size={11}/>{prompt.result_count} stored answer{prompt.result_count === 1 ? '' : 's'} preserved</small></div><label>Intent<select aria-label={`Intent for ${prompt.prompt}`} value={upgradeDraft.categories[String(prompt.id)] ?? prompt.suggested_category} onChange={event => setUpgradeDraft({ ...upgradeDraft, categories: { ...upgradeDraft.categories, [String(prompt.id)]: event.target.value as AiPromptCategory } })}>{Object.entries(CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></article>)}</div></section></div></Modal>}

    {guideOpen && <Modal onClose={() => setGuideOpen(false)} size="xl" className="prompt-guide-modal" eyebrow="Practical prompt design" title="Build a useful buyer-question set" description="Track questions that represent distinct moments in discovery, evaluation, purchase and support." icon={<Library/>} footer={<><span className="app-modal-footer-note">A strong starter library usually contains 8–15 questions across at least three intents.</span><button className="btn btn-primary" onClick={() => openCreate()}><Plus size={13}/> Create a prompt</button></>}><div className="prompt-guide-principles"><div><span>01</span><strong>Ask naturally</strong><p>Use the words a buyer would use, not an SEO keyword string.</p></div><div><span>02</span><strong>Change one variable</strong><p>Keep intent, market and persona stable so movement is meaningful.</p></div><div><span>03</span><strong>Balance the journey</strong><p>Combine unbranded discovery with comparison, commercial, brand and support checks.</p></div></div><div className="prompt-template-grid">{Object.entries(CATEGORY_GUIDE).map(([value, guide]) => <article key={value}><span className={`category-chip category-${value}`}>{guide.label}</span><h3>{guide.purpose}</h3><blockquote>{guide.example}</blockquote><p>{guide.tip}</p><button className="btn btn-secondary btn-sm" onClick={() => openCreate({ category: value as AiPromptCategory, prompt: guide.example })}><Plus size={12}/> Use template</button></article>)}</div></Modal>}

    {expandedPrompt && <Modal onClose={() => setExpanded(null)} size="xl" className="prompt-results-modal" eyebrow={<span className={`category-chip category-${expandedPrompt.category}`}>{CATEGORY_LABEL[expandedPrompt.category]}</span>} title={expandedPrompt.prompt} description={`${expandedPrompt.group_name || 'Ungrouped'} · ${sites.find(site => site.id === expandedPrompt.site_id)?.name || 'Whole workspace'} · ${expandedPrompt.locale} · ${expandedPrompt.device} · ${expandedPrompt.cadence}`} icon={<Bot/>} headerActions={<><button className="btn btn-secondary btn-sm" onClick={() => openEdit(expandedPrompt)}><Pencil size={12}/> Edit</button><button className="btn btn-primary btn-sm" disabled={running !== null || noKeys || !expandedPrompt.enabled} onClick={() => run(expandedPrompt.id)}>{running === expandedPrompt.id ? <Loader2 size={12} className="spin"/> : <Play size={12}/>} Run</button></>}><div className="prompt-provider-tabs">{providers.all.map(provider => { const result = latest.get(`${expandedPrompt.id}:${provider}`); const status = result ? citationLabel(result) : null; return <button key={provider} className={activeProvider === provider ? 'active' : ''} onClick={() => setActiveProvider(provider)}><Bot size={13}/><span><strong>{PROVIDER_LABEL[provider] ?? provider}</strong><small>{!providers.configured.includes(provider) ? 'Needs API key' : !result ? 'Not run yet' : result.error ? 'Run failed' : status?.label}</small></span>{result && !result.error && (result.cited ? <CheckCircle2 className="ok"/> : <XCircle/>)}</button>; })}</div>{activeProvider ? <Thread key={`${expandedPrompt.id}:${activeProvider}`} promptId={expandedPrompt.id} promptText={expandedPrompt.prompt} provider={activeProvider} configured={providers.configured.includes(activeProvider)} onCitedChange={load}/> : <div className="ops-empty"><Bot/><strong>No provider selected</strong><span>Configure an answer engine to start tracking this question.</span></div>}</Modal>}

    {watchlistOpen && <Modal onClose={() => setWatchlistOpen(false)} size="md" className="prompt-watchlist-modal attribution-config-modal" eyebrow="Entity-aware measurement" title="Citation identity & competitors" description="Define how the system recognises you. Existing stored answers are reclassified immediately; nothing is sent to an AI provider." icon={<Target/>} footer={<><button className="btn btn-ghost" onClick={() => setWatchlistOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={savingConfig} onClick={saveAttributionConfig}>{savingConfig ? <Loader2 size={13} className="spin"/> : <Save size={13}/>} Save attribution</button></>}><div className="attribution-config-layout"><section><h3>Automatically recognised</h3><p>Website names and domains come from Sites. Profile URLs and legal names come from Markets & Entities.</p><div className="identity-token-groups"><div><strong>Owned domains</strong><span>{identity.ownedDomains.length ? identity.ownedDomains.join(' · ') : 'Add a website first'}</span></div><div><strong>Entity profiles</strong><span>{identity.profiles.length ? identity.profiles.map(profile => `${profile.provider} (${profile.domain})`).join(' · ') : 'Add app-store, marketplace or profile URLs in Markets & Entities'}</span></div></div><Link className="btn btn-secondary btn-sm" to="/insights/entities"><Globe2 size={12}/> Review entity profiles</Link></section><label>Other brand or product names<textarea data-autofocus rows={5} value={brandAliases} onChange={event => setBrandAliases(event.target.value)} placeholder={'Trading name\nProduct name\nPrevious brand name'}/><small>One name per line. Use distinctive names; these are matched in answer text and recognised marketplace URLs.</small></label><label>Competitor domains<textarea rows={5} value={competitorDomains} onChange={event => setCompetitorDomains(event.target.value)} placeholder={'competitor.com\nanother-rival.co.uk'}/><small>These do not count as you. They are labelled separately in the source graph.</small></label></div></Modal>}

    {deleteTarget && <Modal onClose={() => setDeleteTarget(null)} size="sm" className="prompt-delete-modal" role="alertdialog" eyebrow={<span className="danger">Remove tracking history</span>} title="Delete this prompt?" description="The prompt and its stored provider results will be removed. This cannot be undone." icon={<AlertTriangle/>} footer={<><button className="btn btn-ghost" onClick={() => setDeleteTarget(null)}>Keep prompt</button><button className="btn btn-danger" onClick={remove}><Trash2 size={13}/> Delete prompt</button></>}><blockquote>{deleteTarget.prompt}</blockquote></Modal>}
  </div>;
}
