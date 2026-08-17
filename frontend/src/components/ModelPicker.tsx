/**
 * Per-provider AI model picker. Probes each configured provider's live model
 * list, defaults to the newest (Gemini pins to gemini-flash-latest, OpenAI to
 * the latest undated -mini), and saves a per-workspace override. Lives next to
 * the API keys in Settings.
 */
import { useState, useEffect } from 'react';
import { Bot } from 'lucide-react';
import { api, type ProviderModels } from '../api';

const LABEL: Record<string, string> = {
  openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini', perplexity: 'Perplexity', xai: 'Grok',
};

export function ModelPicker() {
  const [providers, setProviders] = useState<ProviderModels[]>([]);
  const [loading, setLoading] = useState(true);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getAiModels().then(r => setProviders(r.providers.filter(p => p.configured)))
      .catch(() => setProviders([])).finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const [prov, model] of Object.entries(choices)) payload[`model_${prov}`] = model;
      if (Object.keys(payload).length) await api.saveAiModels(payload);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } finally { setSaving(false); }
  }

  return (
    <div className="card mt-4">
      <div className="card-title">
        <Bot size={13} /> AI models
        {loading && <span className="text-dim" style={{ fontSize: 12, fontWeight: 400 }}> · probing providers…</span>}
      </div>
      <p className="text-dim" style={{ fontSize: 12, margin: '0 0 10px' }}>
        Which model each provider uses (for AI citation checks and llms.txt generation). Probed live and defaulted to the
        newest available — Gemini uses <code>gemini-flash-latest</code>, ChatGPT the latest undated <code>-mini</code>. Override below.
      </p>
      {loading ? (
        <div className="text-dim" style={{ fontSize: 12 }}>Querying each configured provider's model list…</div>
      ) : providers.length === 0 ? (
        <div className="empty-note">No AI providers configured yet — add a key above and reopen this tab.</div>
      ) : (
        <>
          <div className="model-rows">
            {providers.map(p => {
              const current = choices[p.provider] ?? p.selected;
              const opts = Array.from(new Set([p.recommended, ...p.models, p.selected])).filter(Boolean);
              const isAuto = !p.isOverride && current === p.recommended;
              return (
                <div className="model-row" key={p.provider}>
                  <span className="model-row-name">{LABEL[p.provider] ?? p.provider}</span>
                  <select className="input model-row-select" value={current}
                    onChange={e => setChoices(prev => ({ ...prev, [p.provider]: e.target.value }))}>
                    {opts.map(m => <option key={m} value={m}>{m}{m === p.recommended ? '  — latest' : ''}</option>)}
                  </select>
                  <span className={`model-row-tag${isAuto ? ' is-auto' : ''}`}>{isAuto ? 'auto' : 'custom'}</span>
                </div>
              );
            })}
          </div>
          <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} disabled={saving} onClick={save}>
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save models'}
          </button>
        </>
      )}
    </div>
  );
}
