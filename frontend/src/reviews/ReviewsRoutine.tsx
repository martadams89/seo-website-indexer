import { useEffect, useState } from 'react';
import { Bot, CalendarClock, Copy, Wand2 } from 'lucide-react';
import { useToast } from '../AppContext';
import { errorMessage } from '../ads/api';
import { reviewsApi, type ReviewLocation, type ReviewRoutineSettings } from './api';

const TIMEZONES: string[] = (() => {
  try { return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { return []; }
})();

export function ReviewsRoutine({ locations }: { locations: ReviewLocation[] }) {
  const toast = useToast();
  const [settings, setSettings] = useState<ReviewRoutineSettings | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [connectorName, setConnectorName] = useState('SEO Website Indexer');
  const [result, setResult] = useState<{ prompt: string; schedule: string; cron: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    reviewsApi.routine().then(cfg => {
      setSettings({ ...cfg.settings, timezone: cfg.settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone });
      const saved = cfg.location_ids.filter(id => locations.some(l => l.id === id));
      setSelected(saved.length ? saved : locations.filter(l => l.enabled).map(l => l.id));
      setConnectorName(cfg.connector_name);
    }).catch(e => toast('error', errorMessage(e)));
  }, [locations, toast]);

  async function build() {
    if (!settings) return;
    setBusy(true);
    try { setResult(await reviewsApi.routinePrompt({ settings, locationIds: selected, connectorName })); }
    catch (e) { toast('error', errorMessage(e)); }
    setBusy(false);
  }

  function copy(value: string) {
    navigator.clipboard.writeText(value);
    toast('success', 'Copied to clipboard');
  }

  if (!settings) return <div className="page-loading">Loading…</div>;
  const set = <K extends keyof ReviewRoutineSettings>(key: K, value: ReviewRoutineSettings[K]) => setSettings(s => s ? { ...s, [key]: value } : s);

  return (
    <div className="ads-setup">
      <section className="ops-card">
        <div className="ops-card-head"><div><span className="eyebrow">AI routine</span><h2>Answer reviews on a schedule</h2></div><Bot size={18} /></div>
        <p className="card-intro">Answer a few questions to get a prompt for a scheduled task in any AI assistant connected to this app's MCP server. Each location's reply rules are enforced by the server, whatever the prompt says.</p>
        <div className="form-grid">
          <label>How often
            <select className="input" value={settings.cadence} onChange={e => set('cadence', e.target.value as ReviewRoutineSettings['cadence'])}>
              <option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="twice_weekly">Twice a week</option><option value="weekly">Weekly</option>
            </select>
          </label>
          <label>At<input className="input" type="time" value={settings.time} onChange={e => set('time', e.target.value)} /></label>
          <label>Time zone
            <select className="input" value={settings.timezone} onChange={e => set('timezone', e.target.value)}>
              {(TIMEZONES.length ? TIMEZONES : [settings.timezone]).map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </label>
          <label>Answer reviews from the last
            <select className="input" value={settings.lookback_days} onChange={e => set('lookback_days', Number(e.target.value))}>
              {[7, 14, 30, 90, 365].map(d => <option key={d} value={d}>{d} days</option>)}
            </select>
          </label>
          <label>Replies
            <select className="input" value={settings.mode} onChange={e => set('mode', e.target.value as ReviewRoutineSettings['mode'])}>
              <option value="within_rules">Publish what each location's rules allow</option>
              <option value="drafts_only">Draft everything for my approval</option>
            </select>
          </label>
          <label>MCP server name in your AI app<input className="input" value={connectorName} onChange={e => setConnectorName(e.target.value)} /></label>
        </div>
        <fieldset className="reviews-fieldset">
          <legend>Locations</legend>
          <div className="reviews-checks">
            {locations.map(l => (
              <label key={l.id} className="ads-inline-check">
                <input type="checkbox" checked={selected.includes(l.id)} onChange={e => setSelected(cur => e.target.checked ? [...cur, l.id] : cur.filter(id => id !== l.id))} /> {l.title ?? l.location_name}
              </label>
            ))}
            {!locations.length && <small className="text-dim">Link locations first.</small>}
          </div>
        </fieldset>
        <label className="reviews-wide">Anything else the assistant should know
          <textarea className="input" rows={3} value={settings.extra_instructions ?? ''} onChange={e => set('extra_instructions', e.target.value)} placeholder="e.g. We close over Christmas; mention the new Bradford branch to Leeds customers." />
        </label>
        <div className="ads-row-actions"><button className="btn btn-primary" disabled={busy || !selected.length} onClick={build}><Wand2 size={14} /> {busy ? 'Building…' : 'Build the prompt'}</button></div>
      </section>
      {result && (
        <section className="ops-card">
          <div className="ops-card-head"><div><span className="eyebrow"><CalendarClock size={12} /> Runs {result.schedule}</span><h2>Copy into a scheduled task</h2></div>
            <button className="btn btn-primary btn-sm" onClick={() => copy(result.prompt)}><Copy size={13} /> Copy prompt</button></div>
          <p className="ads-hint">Create a scheduled task (or routine) in your AI assistant with this prompt. Schedulers that take cron can use <code>{result.cron}</code> in {settings.timezone}.</p>
          <textarea className="ads-prompt-text" readOnly rows={16} value={result.prompt} aria-label="Routine prompt" onFocus={e => e.currentTarget.select()} />
        </section>
      )}
    </div>
  );
}
