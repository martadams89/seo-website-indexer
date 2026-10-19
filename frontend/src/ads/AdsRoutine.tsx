import { useEffect, useMemo, useState } from 'react';
import { Bot, CalendarClock, Copy, History, Sparkles, Wand2 } from 'lucide-react';
import { useToast } from '../AppContext';
import { adsApi, errorMessage, type AdsAccount, type AdsBrief, type RoutineConfig, type RoutineRun, type RoutineSettings } from './api';
import { GOALS } from './constants';

const TIMEZONES: string[] = (() => {
  try { return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { return []; }
})();

type ClientAnswers = { monthlyBudget: string; brief: AdsBrief & { competitorsText: string } };

function answersFor(account: AdsAccount): ClientAnswers {
  return {
    monthlyBudget: account.monthly_budget === null ? '' : String(account.monthly_budget),
    brief: { ...account.brief, competitorsText: (account.brief.competitors ?? []).join('\n') },
  };
}

const FOCUS_LABEL: Record<string, string> = {
  pacing: 'Pace spend to the monthly budget',
  waste: 'Cut wasted spend (negatives, pausing)',
  budget_shift: 'Move budget to what converts',
  bids: 'Tune bids and targets',
  ads: 'Refresh ads from competitor insight',
  keywords: 'Find new keywords',
  recommendations: 'Review Google recommendations',
  new_campaigns: 'Propose new campaigns',
};

export function AdsRoutine({ accounts, canManage, reload }: { accounts: AdsAccount[]; canManage: boolean; reload: () => Promise<void> }) {
  const toast = useToast();
  const [config, setConfig] = useState<RoutineConfig | null>(null);
  const [settings, setSettings] = useState<RoutineSettings | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, ClientAnswers>>({});
  const [connectorName, setConnectorName] = useState('SEO Website Indexer');
  const [result, setResult] = useState<{ prompt: string; schedule: string; cron: string } | null>(null);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([adsApi.routine(), adsApi.routineRuns()]).then(([cfg, history]) => {
      setConfig(cfg);
      setSettings({ ...cfg.settings, timezone: cfg.settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone });
      const saved = cfg.account_ids.filter(id => accounts.some(a => a.id === id));
      setSelected(saved.length ? saved : accounts.filter(a => a.enabled).map(a => a.id));
      setConnectorName(cfg.connector_name);
      setRuns(history);
    }).catch(e => toast('error', errorMessage(e)));
  }, [accounts, toast]);

  // Prefill each selected client's answers from what is already saved on it.
  const clientAnswers = useMemo(() => {
    const out: Record<string, ClientAnswers> = {};
    for (const id of selected) {
      const account = accounts.find(a => a.id === id);
      if (account) out[id] = answers[id] ?? answersFor(account);
    }
    return out;
  }, [selected, accounts, answers]);

  const missingBudget = selected.filter(id => !clientAnswers[id]?.monthlyBudget.trim());

  function updateAnswer(id: string, patch: Partial<ClientAnswers> | ((current: ClientAnswers) => ClientAnswers)) {
    setAnswers(current => {
      const base = current[id] ?? clientAnswers[id];
      return { ...current, [id]: typeof patch === 'function' ? patch(base) : { ...base, ...patch } };
    });
  }

  async function generate() {
    if (!settings) return;
    if (missingBudget.length) { toast('error', 'Set a monthly budget for every selected client — the routine paces spend against it.'); return; }
    setBusy(true);
    try {
      const clients: Record<string, { monthlyBudget: number | null; brief: AdsBrief }> = {};
      for (const id of selected) {
        const a = clientAnswers[id];
        const { competitorsText, ...brief } = a.brief;
        clients[id] = { monthlyBudget: Number(a.monthlyBudget), brief: { ...brief, competitors: competitorsText.split(/[\n,]/).map(s => s.trim()).filter(Boolean) } };
      }
      const built = await adsApi.buildPrompt({ settings, accountIds: selected, connectorName, clients });
      setResult(built);
      setAnswers({});
      await reload();
      toast('success', 'Routine prompt ready — budgets, briefs and guardrail mode saved to each client');
    } catch (e) { toast('error', errorMessage(e)); }
    setBusy(false);
  }

  function copy(value: string) {
    navigator.clipboard.writeText(value);
    toast('success', 'Copied to clipboard');
  }

  if (!config || !settings) return <div className="page-loading">Loading routine settings…</div>;
  if (!accounts.length) return <section className="ops-card"><div className="ops-empty compact"><Bot /><strong>Link a client ad account first</strong><span>The routine works through the clients you link on the Setup tab.</span></div></section>;

  const accountName = (id: string | null) => { const a = accounts.find(x => x.id === id); return a?.name ?? a?.customer_id_formatted ?? 'All clients'; };

  return (
    <div className="ads-routine">
      <section className="ops-card">
        <div className="ops-card-head"><div><span className="eyebrow"><Wand2 size={13} /> AI routine</span><h2>Set up a recurring Google Ads review</h2></div></div>
        <p className="card-intro">Answer a few questions and you'll get a prompt to schedule in any AI assistant or agent CLI connected to this app's MCP server. Each run reviews performance, researches the market and competitors, makes or proposes changes, and logs what it did here.</p>

        <h3 className="ads-form-heading">1. Which clients should it look after?</h3>
        <div className="ads-client-picks">
          {accounts.map(a => (
            <label key={a.id} className={selected.includes(a.id) ? 'selected' : ''}>
              <input type="checkbox" checked={selected.includes(a.id)} onChange={e => setSelected(e.target.checked ? [...selected, a.id] : selected.filter(id => id !== a.id))} />
              <span><strong>{a.name ?? a.customer_id_formatted}</strong><small>{a.customer_id_formatted}{a.currency ? ` · ${a.currency}` : ''}</small></span>
            </label>
          ))}
        </div>

        <h3 className="ads-form-heading">2. What is each client's budget and goal?</h3>
        {selected.map(id => {
          const a = clientAnswers[id];
          const account = accounts.find(x => x.id === id);
          if (!a || !account) return null;
          const setBrief = (key: keyof AdsBrief | 'competitorsText', value: string) => updateAnswer(id, current => ({ ...current, brief: { ...current.brief, [key]: value } }));
          return (
            <details key={id} className="ads-client-brief" open={!a.monthlyBudget}>
              <summary><strong>{account.name ?? account.customer_id_formatted}</strong> {a.monthlyBudget ? <span className="text-dim">{account.currency} {a.monthlyBudget}/month · {a.brief.goal || 'goal not set'}</span> : <span className="badge badge-warn">Budget needed</span>}</summary>
              <div className="form-grid">
                <label>Monthly budget ({account.currency ?? 'account currency'})<input className="input" type="number" min={0} value={a.monthlyBudget} onChange={e => updateAnswer(id, { monthlyBudget: e.target.value })} placeholder="Required" /></label>
                <label>Primary goal<select className="input" value={a.brief.goal ?? ''} onChange={e => setBrief('goal', e.target.value)}><option value="">Let the AI infer it</option>{GOALS.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
                <label>Target cost per conversion<input className="input" type="number" min={0} value={a.brief.target_cpa ?? ''} onChange={e => setBrief('target_cpa', e.target.value)} placeholder="optional" /></label>
                <label>Target ROAS (e.g. 4 = 400%)<input className="input" type="number" min={0} step="0.1" value={a.brief.target_roas ?? ''} onChange={e => setBrief('target_roas', e.target.value)} placeholder="optional" /></label>
                <label>Website<input className="input" value={a.brief.website ?? ''} onChange={e => setBrief('website', e.target.value)} placeholder="https://" /></label>
                <label>Markets / locations<input className="input" value={a.brief.markets ?? ''} onChange={e => setBrief('markets', e.target.value)} placeholder="e.g. UK nationwide; London" /></label>
                <label className="full">What they sell and why people choose them<textarea rows={2} value={a.brief.offer ?? ''} onChange={e => setBrief('offer', e.target.value)} /></label>
                <label>Known competitors (one per line)<textarea rows={2} value={a.brief.competitorsText} onChange={e => setBrief('competitorsText', e.target.value)} placeholder="Leave blank — the AI will find them" /></label>
                <label>Never do<textarea rows={2} value={a.brief.never_do ?? ''} onChange={e => setBrief('never_do', e.target.value)} placeholder="e.g. don't bid on competitor names" /></label>
              </div>
            </details>
          );
        })}
        {!selected.length && <p className="ads-hint">Pick at least one client, or leave all unticked to let the routine work through every enabled client.</p>}

        <h3 className="ads-form-heading">3. How often should it run?</h3>
        <div className="form-grid">
          <label>Cadence<select className="input" value={settings.cadence} onChange={e => setSettings({ ...settings, cadence: e.target.value as RoutineSettings['cadence'] })}>
            <option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="twice_weekly">Twice a week (Mon & Thu)</option><option value="weekly">Weekly (Monday)</option>
          </select></label>
          <label>Time<input className="input" type="time" value={settings.time} onChange={e => setSettings({ ...settings, time: e.target.value })} /></label>
          <label>Time zone{TIMEZONES.length ? (
            <select className="input" value={settings.timezone} onChange={e => setSettings({ ...settings, timezone: e.target.value })}>{TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}</select>
          ) : <input className="input" value={settings.timezone} onChange={e => setSettings({ ...settings, timezone: e.target.value })} />}</label>
          <label>Compare performance over<select className="input" value={settings.lookback_days} onChange={e => setSettings({ ...settings, lookback_days: Number(e.target.value) })}>
            {[7, 14, 30, 60, 90].map(d => <option key={d} value={d}>Last {d} days</option>)}
          </select></label>
        </div>

        <h3 className="ads-form-heading">4. How much freedom should it have?</h3>
        <div className="ads-mode-picks">
          <label className={settings.mode === 'autopilot' ? 'selected' : ''}>
            <input type="radio" name="routine-mode" checked={settings.mode === 'autopilot'} onChange={() => setSettings({ ...settings, mode: 'autopilot' })} />
            <span><strong>Autopilot within guardrails</strong><small>Applies changes that stay inside each client's limits (budget increases, bid changes, monthly budget). Anything bigger waits for you on the Approvals tab.</small></span>
          </label>
          <label className={settings.mode === 'propose' ? 'selected' : ''}>
            <input type="radio" name="routine-mode" checked={settings.mode === 'propose'} onChange={() => setSettings({ ...settings, mode: 'propose' })} />
            <span><strong>Propose only</strong><small>Every change waits for your approval. The selected clients are switched to “Approve every change”, enforced by the server.</small></span>
          </label>
        </div>
        <div className="form-grid">
          <label>Market and competitor research<select className="input" value={settings.research} onChange={e => setSettings({ ...settings, research: e.target.value as RoutineSettings['research'] })}>
            <option value="light">Light — quick news and seasonality check</option><option value="standard">Standard — market plus up to 5 competitors</option><option value="deep">Deep — thorough review of up to 8 competitors</option>
          </select></label>
          <label>Name of this connector in your AI app<input className="input" value={connectorName} onChange={e => setConnectorName(e.target.value)} /></label>
        </div>
        <div className="ads-focus">
          {Object.keys(config.focus_areas).map(key => (
            <label key={key}><input type="checkbox" checked={settings.focus.includes(key)} onChange={e => setSettings({ ...settings, focus: e.target.checked ? [...settings.focus, key] : settings.focus.filter(f => f !== key) })} /> {FOCUS_LABEL[key] ?? key}</label>
          ))}
        </div>
        <div className="form-grid">
          <label className="full">Anything else it should know?<textarea rows={2} value={settings.extra_instructions ?? ''} onChange={e => setSettings({ ...settings, extra_instructions: e.target.value })} placeholder="e.g. Email-style summary; focus on weekend performance; we launch a sale on the 1st" /></label>
        </div>
        <div className="ads-row-actions">
          <button className="btn btn-primary" disabled={!canManage || busy} onClick={generate}><Sparkles size={14} /> {busy ? 'Building…' : 'Save answers and build the prompt'}</button>
          {missingBudget.length > 0 && <span className="ads-hint">{missingBudget.length === 1 ? '1 client still needs' : `${missingBudget.length} clients still need`} a monthly budget.</span>}
        </div>
      </section>

      {result && (
        <section className="ops-card ads-prompt">
          <div className="ops-card-head">
            <div><span className="eyebrow"><CalendarClock size={13} /> Ready to schedule</span><h2>Runs {result.schedule}</h2></div>
            <button className="btn btn-primary btn-sm" onClick={() => copy(result.prompt)}><Copy size={13} /> Copy prompt</button>
          </div>
          <ol className="ads-guide-steps">
            <li><strong>Connect this app's MCP server</strong> to your AI app if you haven't (Setup tab → Connect an AI assistant). Allow <b>Manage Google Ads</b> when you approve it{settings.mode === 'propose' ? ' (needed to propose changes)' : ''}.</li>
            <li><strong>Schedule it</strong> to run {result.schedule}: use your AI app's scheduled tasks or automations, or run an agent CLI from cron on a server (below). Where a cron expression is asked for, use <code>{result.cron}</code> in {settings.timezone}.</li>
            <li><strong>Paste the prompt</strong> below and make sure the “{connectorName}” server and web search are enabled for the task.</li>
            <li><strong>Review</strong> the Approvals tab and the routine log below after each run.</li>
          </ol>
          <textarea className="ads-prompt-text" readOnly value={result.prompt} rows={18} aria-label="Routine prompt" onFocus={e => e.currentTarget.select()} />
          <details className="ads-cli-schedule">
            <summary>Run it from cron with an agent CLI instead</summary>
            <p className="ads-hint">Save the prompt as <code>ads-routine.md</code> on a machine where your agent CLI has this MCP server added and signed in, and is allowed to call its tools and web search without asking (see your CLI's auto-approve option). Cron uses the machine's time zone unless you set <code>CRON_TZ</code>.</p>
            {(() => {
              const cron = `CRON_TZ=${settings.timezone}
# pick one
${result.cron}  claude -p "$(cat ads-routine.md)" --allowedTools "mcp__seo-indexer,WebSearch,WebFetch"
${result.cron}  codex exec "$(cat ads-routine.md)"
${result.cron}  gemini -p "$(cat ads-routine.md)"`;
              return (
                <div className="mcp-code">
                  <pre>{cron}</pre>
                  <button className="btn-icon btn-icon-ghost" aria-label="Copy cron example" onClick={() => copy(cron)}><Copy size={13} /></button>
                </div>
              );
            })()}
          </details>
        </section>
      )}

      <section className="ops-card">
        <div className="ops-card-head"><div><span className="eyebrow"><History size={13} /> Routine log</span><h2>What the AI did</h2></div></div>
        <div className="ads-runs">
          {runs.map(run => (
            <article key={run.id}>
              <header><strong>{accountName(run.ads_account_id)}</strong><time>{new Date(run.created_at).toLocaleString()}</time></header>
              <p>{run.summary}</p>
              {run.actions.length > 0 && <><h4>Changes</h4><ul>{run.actions.map(a => <li key={a}>{a}</li>)}</ul></>}
              {run.findings.length > 0 && <><h4>Findings</h4><ul>{run.findings.map(f => <li key={f}>{f}</li>)}</ul></>}
              {run.market_notes && <><h4>Market and competitors</h4><p>{run.market_notes}</p></>}
              {run.next_steps.length > 0 && <><h4>Next time</h4><ul>{run.next_steps.map(n => <li key={n}>{n}</li>)}</ul></>}
            </article>
          ))}
          {!runs.length && <div className="ops-empty compact"><Bot /><strong>No routine runs yet</strong><span>Each run logs its summary here via the MCP server.</span></div>}
        </div>
      </section>
    </div>
  );
}
