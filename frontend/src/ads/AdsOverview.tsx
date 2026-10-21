import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, ClipboardCheck, Filter, Gauge, RefreshCw, Stethoscope } from 'lucide-react';
import { MetricChart } from '../components/Charts';
import { adsApi, errorMessage, money, type AdsAccount, type AdsOverview, type AuditFinding, type Pacing, type SearchTermRow } from './api';

const PERIODS = [7, 30, 90];

export function AdsOverviewView({ account }: { account: AdsAccount }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AdsOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [audit, setAudit] = useState<{ findings: AuditFinding[]; errors: string[]; checked_at: string } | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [terms, setTerms] = useState<SearchTermRow[] | null>(null);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try { setData(await adsApi.overview(account.id, days, fresh)); setError(''); }
    catch (e) { setError(errorMessage(e)); }
    setLoading(false);
  }, [account.id, days]);
  useEffect(() => { void load(); }, [load]);

  async function runAudit() {
    setAuditing(true);
    try { setAudit(await adsApi.audit(account.id)); }
    catch (e) { setError(errorMessage(e)); }
    setAuditing(false);
  }

  async function loadTerms() {
    try { setTerms((await adsApi.searchTerms(account.id, true)).terms); }
    catch (e) { setError(errorMessage(e)); }
  }

  const c = account.currency;
  return (
    <div className="ads-overview">
      <div className="ads-toolbar">
        <div className="ops-tabs" role="group" aria-label="Reporting period">
          {PERIODS.map(p => <button key={p} type="button" className={days === p ? 'active' : ''} aria-pressed={days === p} onClick={() => setDays(p)}>Last {p} days</button>)}
        </div>
        <span className="text-dim">{data ? `${data.period.start} → ${data.period.end}, compared with the ${days} days before` : ''}</span>
        <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => load(true)}><RefreshCw size={13} className={loading ? 'spin' : undefined} /> Refresh</button>
      </div>

      {error && <div className="alert alert-error"><AlertTriangle size={14} /><div className="alert-content">{error}</div></div>}
      {loading && !data && <div className="page-loading">Loading performance from Google Ads…</div>}

      {data && (
        <>
          <div className="ads-kpis">
            <Kpi label="Spend" value={money(data.totals.cost, c)} change={data.change_pct.cost} neutral />
            <Kpi label="Conversions" value={data.totals.conversions.toLocaleString()} change={data.change_pct.conversions} />
            <Kpi label="Cost / conversion" value={money(data.totals.cpa, c)} change={data.change_pct.cpa} lowerIsBetter target={account.brief.target_cpa ? `Target ${money(account.brief.target_cpa, c)}` : undefined} />
            <Kpi label="ROAS" value={data.totals.roas === null ? '—' : `${data.totals.roas.toFixed(2)}×`} change={data.change_pct.roas} target={account.brief.target_roas ? `Target ${account.brief.target_roas}×` : undefined} />
            <Kpi label="Clicks" value={data.totals.clicks.toLocaleString()} change={data.change_pct.clicks} />
            <Kpi label="CTR" value={data.totals.ctr === null ? '—' : `${data.totals.ctr}%`} change={data.change_pct.ctr} />
          </div>

          <div className="ops-split">
            <section className="ops-card">
              <div className="ops-card-head"><div><span className="eyebrow">Daily spend</span><h2>{money(data.totals.cost, c)} over {days} days</h2></div></div>
              <MetricChart points={data.daily.map(d => ({ date: d.date, value: d.cost }))} format={n => money(n, c, 0)} label="Daily spend" height={190} />
            </section>
            <PacingCard pacing={data.pacing} currency={c} />
          </div>

          <section className="ops-card">
            <div className="ops-card-head"><div><span className="eyebrow">Campaigns</span><h2>{data.campaigns.length} campaigns</h2></div></div>
            <div className="table-wrap">
              <table className="table ads-table">
                <thead><tr><th>Campaign</th><th>Status</th><th>Budget / day</th><th>Spend</th><th>Conv.</th><th>CPA</th><th>ROAS</th><th title="Search impression share lost because of budget">Lost IS (budget)</th><th title="Search impression share lost because of ad rank">Lost IS (rank)</th></tr></thead>
                <tbody>
                  {data.campaigns.map(row => (
                    <tr key={row.id}>
                      <td><strong>{row.name}</strong><small className="text-dim">{[row.channel, row.bidding].filter(Boolean).join(' · ').toLowerCase().replaceAll('_', ' ')}</small></td>
                      <td><span className={`badge badge-${row.status === 'ENABLED' ? 'ok' : 'info'}`}>{row.status.toLowerCase()}</span></td>
                      <td>{row.channel === 'LOCAL_SERVICES' ? <span className="text-dim" title="Google sets a placeholder budget for Local Services; it is billed per lead.">Per lead</span> : money(row.daily_budget, c)}{row.budget_shared && <small className="text-dim"> shared</small>}</td>
                      <td>{money(row.kpis.cost, c)}</td>
                      <td>{row.kpis.conversions}</td>
                      <td>{money(row.kpis.cpa, c)}</td>
                      <td>{row.kpis.roas === null ? '—' : `${row.kpis.roas}×`}</td>
                      <td className={row.lost_is_budget !== null && row.lost_is_budget >= 10 ? 'ads-warn-cell' : ''}>{row.lost_is_budget === null ? '—' : `${row.lost_is_budget}%`}</td>
                      <td>{row.lost_is_rank === null ? '—' : `${row.lost_is_rank}%`}</td>
                    </tr>
                  ))}
                  {!data.campaigns.length && <tr><td colSpan={9} className="text-dim">No campaigns in this account.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow"><Stethoscope size={13} /> Health check</span><h2>Audit</h2></div>
          <button className="btn btn-secondary btn-sm" disabled={auditing} onClick={runAudit}>{auditing ? <RefreshCw size={13} className="spin" /> : <ClipboardCheck size={13} />} {audit ? 'Run again' : 'Run audit'}</button>
        </div>
        {!audit && <p className="card-intro">Checks conversion tracking, pacing, budget- and rank-limited campaigns, wasted search terms, Quality Score, ad policy, ad coverage and ad strength. Your AI routine runs the same checks.</p>}
        {audit && (
          <div className="ads-findings">
            {audit.findings.map((f, i) => (
              <article key={`${f.check}-${i}`} className={`sev-${f.severity}`}>
                <span className={`badge badge-${f.severity === 'ok' ? 'ok' : f.severity === 'critical' || f.severity === 'high' ? 'error' : f.severity === 'medium' ? 'warn' : 'info'}`}>{f.severity}</span>
                <div>
                  <strong>{f.title}</strong>
                  <p>{f.detail}</p>
                  {f.suggested_action && <p className="ads-suggestion">→ {f.suggested_action}</p>}
                  {f.evidence !== undefined && <details><summary>Evidence</summary><pre>{JSON.stringify(f.evidence, null, 2)}</pre></details>}
                </div>
              </article>
            ))}
            {audit.errors.map(err => <p key={err} className="ads-hint">Couldn't run {err}</p>)}
          </div>
        )}
      </section>

      <section className="ops-card">
        <div className="ops-card-head">
          <div><span className="eyebrow"><Filter size={13} /> Search terms</span><h2>Spend with no conversions (last 30 days)</h2></div>
          {!terms && <button className="btn btn-secondary btn-sm" onClick={loadTerms}>Show terms</button>}
        </div>
        {terms && (
          <div className="table-wrap">
            <table className="table ads-table">
              <thead><tr><th>Search term</th><th>Campaign / ad group</th><th>Spend</th><th>Clicks</th></tr></thead>
              <tbody>
                {terms.map(t => <tr key={`${t.search_term}-${t.ad_group_id}`}><td>{t.search_term}</td><td><small>{t.campaign} / {t.ad_group}</small></td><td>{money(t.cost, c)}</td><td>{t.clicks}</td></tr>)}
                {!terms.length && <tr><td colSpan={4} className="text-dim">No non-converting search terms with spend. 🎉</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value, change, lowerIsBetter, neutral, target }: { label: string; value: string; change: number | null | undefined; lowerIsBetter?: boolean; neutral?: boolean; target?: string }) {
  const good = change === null || change === undefined ? null : neutral ? null : lowerIsBetter ? change < 0 : change > 0;
  return (
    <div className="ads-kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      <small className={good === null ? '' : good ? 'good' : 'bad'}>
        {change === null || change === undefined ? 'no comparison' : <>{change >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{Math.abs(change)}% vs previous</>}
      </small>
      {target && <small className="text-dim">{target}</small>}
    </div>
  );
}

export function PacingCard({ pacing, currency }: { pacing: Pacing; currency: string | null }) {
  const budget = pacing.monthly_budget;
  const pct = budget ? Math.min(100, (pacing.month_to_date_spend / budget) * 100) : 0;
  const expected = budget && pacing.expected_spend_by_now !== null ? Math.min(100, (pacing.expected_spend_by_now / budget) * 100) : null;
  const label = { no_budget: 'No budget set', under: 'Under-pacing', on_track: 'On track', over: 'Over-pacing' }[pacing.status];
  const tone = { no_budget: 'warn', under: 'warn', on_track: 'ok', over: 'error' }[pacing.status];
  return (
    <section className="ops-card ads-pacing">
      <div className="ops-card-head">
        <div><span className="eyebrow"><Gauge size={13} /> Month to date</span><h2>Budget pacing</h2></div>
        <span className={`badge badge-${tone}`}>{label}</span>
      </div>
      <div className="ads-meter" role="img" aria-label={`Spent ${money(pacing.month_to_date_spend, currency)} of ${budget === null ? 'no budget' : money(budget, currency)}`}>
        <i style={{ width: `${pct}%` }} className={pacing.status === 'over' ? 'danger' : ''} />
        {expected !== null && <b style={{ left: `${expected}%` }} title="Where spend should be by today" />}
      </div>
      <dl className="ads-pacing-facts">
        <div><dt>Spent</dt><dd>{money(pacing.month_to_date_spend, currency)}</dd></div>
        <div><dt>Monthly budget</dt><dd>{money(budget, currency)}</dd></div>
        <div><dt>Projected</dt><dd>{money(pacing.projected_month_spend, currency)}</dd></div>
        <div><dt>Daily budgets now</dt><dd>{money(pacing.enabled_daily_budgets, currency)}</dd></div>
        {!!pacing.per_lead_daily_spend && <div><dt>Local Services (per lead)</dt><dd>~{money(pacing.per_lead_daily_spend, currency)}/day</dd></div>}
        <div><dt>Suggested daily total</dt><dd>{money(pacing.recommended_daily_budget_total, currency)}</dd></div>
        <div><dt>Days left</dt><dd>{pacing.remaining_days_including_today}</dd></div>
      </dl>
      <p className="ads-hint">{pacing.note}</p>
    </section>
  );
}
