import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Bot, Braces, Cloud, Download, Gauge, Globe2, Play, Radar, RefreshCw, Save, Search, ShieldCheck, Sparkles, TrendingUp } from 'lucide-react';
import { api, type MetricObservation, type PlatformOverview } from '../api';
import { useToast } from '../AppContext';
import { useWorkspace } from '../workspace/WorkspaceContext';

const SOURCE_META: Record<string,{label:string;icon:typeof Activity;color:string}> = {
  ga4:{label:'Google Analytics 4',icon:Activity,color:'green'}, pagespeed:{label:'PageSpeed',icon:Gauge,color:'amber'},
  cloudflare:{label:'Cloudflare edge',icon:Cloud,color:'orange'}, plausible:{label:'Plausible',icon:Radar,color:'cyan'},
  matomo:{label:'Matomo',icon:Globe2,color:'violet'}, content_audit:{label:'Content inventory',icon:Search,color:'blue'},
  server_log:{label:'Crawl & server logs',icon:Braces,color:'pink'},
};
const pretty = (value:string)=>value.replace(/^lighthouse_/,'').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
const formatValue=(metric:MetricObservation)=>metric.unit==='percent'?`${metric.value.toFixed(1)}%`:metric.unit==='bytes'?`${(metric.value/1_000_000).toFixed(1)} MB`:metric.unit==='ms'?`${Math.round(metric.value)} ms`:metric.value.toLocaleString(undefined,{maximumFractionDigits:1});

function MiniSeries({rows}:{rows:MetricObservation[]}) {
  const points=[...rows].sort((a,b)=>a.observed_at.localeCompare(b.observed_at)).slice(-30); if(points.length<2)return <div className="series-empty">More history needed</div>;
  const min=Math.min(...points.map(p=>p.value)),max=Math.max(...points.map(p=>p.value)); const path=points.map((p,i)=>`${i?'L':'M'}${(i/(points.length-1)*280).toFixed(1)},${(70-((p.value-min)/(max-min||1))*58).toFixed(1)}`).join(' ');
  return <svg className="intel-series" viewBox="0 0 280 78" preserveAspectRatio="none"><path d={`${path} L280,78 L0,78Z`} className="fill"/><path d={path} className="line"/></svg>;
}

export default function IntelligencePage(){
  const {active}=useWorkspace(); const toast=useToast(); const canManage=!!active?.permissions?.manage_integrations;
  const [renderedAt]=useState(()=>Date.now());
  const [overview,setOverview]=useState<PlatformOverview|null>(null); const [metrics,setMetrics]=useState<MetricObservation[]>([]);
  const [source,setSource]=useState('all'); const [query,setQuery]=useState(''); const [busy,setBusy]=useState(false); const [range,setRange]=useState(30);
  const [views,setViews]=useState<Array<{id:string;name:string;config:Record<string,unknown>;is_default:number}>>([]);
  const load=useCallback(async()=>{const from=new Date(Date.now()-range*86_400_000).toISOString();const [o,m,v]=await Promise.all([api.getPlatformOverview(),api.getMetrics({limit:3000,from}),api.getSavedViews()]);setOverview(o);setMetrics(m);setViews(v);},[range]);
  useEffect(()=>{load().catch(()=>null)},[load,active?.id]);
  const latest=useMemo(()=>{const map=new Map<string,MetricObservation>();for(const metric of metrics){const key=`${metric.source}:${metric.metric}:${metric.dimension}`;if(!map.has(key))map.set(key,metric)}return [...map.values()]},[metrics]);
  const filtered=latest.filter(metric=>(source==='all'||metric.source===source)&&`${metric.metric} ${metric.dimension}`.toLowerCase().includes(query.toLowerCase()));
  const groups=useMemo(()=>{const map=new Map<string,MetricObservation[]>();for(const metric of metrics){const key=`${metric.source}:${metric.metric}`;map.set(key,[...(map.get(key)||[]),metric])}return map},[metrics]);
  async function run(){setBusy(true);try{const result=await api.runPlatformAutomation();toast('success',`Refreshed ${result.integrations||0} connections and ${result.audited||0} audited pages`);await load();}catch(e){toast('error',String(e).replace('Error: ',''))}setBusy(false)}
  async function saveCurrentView(){const name=prompt('Name this intelligence view');if(!name?.trim())return;try{await api.saveView({name:name.trim(),config:{source,query,range}});await load();toast('success','View saved')}catch(e){toast('error',String(e).replace('Error: ',''))}}
  function applyView(id:string){const view=views.find(item=>item.id===id);if(!view)return;setSource(String(view.config.source||'all'));setQuery(String(view.config.query||''));setRange(Number(view.config.range)||30)}
  const connected=overview?.integrations.filter(i=>i.status==='connected').reduce((sum,i)=>sum+i.count,0)||0;
  const fresh=overview?.freshness.filter(row=>renderedAt-new Date(row.observed_at).getTime()<2*86_400_000).length||0;
  return <div className="ops-page intelligence-page">
    <header className="ops-page-header"><div><span className="eyebrow"><Sparkles size={13}/> Evidence, joined</span><h1>Unified intelligence</h1><p>Business outcomes, search demand, page experience, edge delivery, content and AI discovery—with provenance attached.</p></div><div className="header-actions"><a className="btn btn-secondary" href="/api/platform/metrics/export.csv"><Download size={14}/> Export evidence</a><button className="btn btn-primary" disabled={busy||!canManage} onClick={run}>{busy?<RefreshCw className="spin" size={14}/>:<Play size={14}/>} Refresh sources</button></div></header>
    <section className="intelligence-controls"><div className="ops-segment"><span>Date range</span>{[7,30,90].map(days=><button key={days} className={range===days?'active':''} onClick={()=>setRange(days)}>{days} days</button>)}</div><select aria-label="Saved view" value="" onChange={event=>applyView(event.target.value)}><option value="">Saved views…</option>{views.map(view=><option key={view.id} value={view.id}>{view.name}</option>)}</select><button className="btn btn-ghost btn-sm" onClick={saveCurrentView}><Save size={12}/> Save view</button></section>
    <section className="intel-hero-grid"><div className="intel-score"><div className="orb"><Radar/><strong>{connected}</strong><span>live sources</span></div><div><span className="eyebrow">Data confidence</span><h2>{fresh===overview?.freshness.length?'Everything is fresh':'Some evidence needs refreshing'}</h2><p>{metrics.length.toLocaleString()} observations retained across {overview?.freshness.length||0} sources. Each value keeps its origin, scope and collection time.</p></div></div><div className="intel-proof"><ShieldCheck/><div><small>Observe → decide → act → verify</small><strong>{overview?.content_actions.find(x=>x.status==='verified')?.count||0} verified changes</strong><span>{overview?.work_items.filter(x=>x.status==='done').reduce((s,x)=>s+x.count,0)||0} completed actions with retained evidence</span></div></div></section>
    <section className="source-ribbon"><button className={source==='all'?'active':''} onClick={()=>setSource('all')}><Sparkles/><span><strong>All evidence</strong><small>{metrics.length.toLocaleString()} observations</small></span></button>{overview?.freshness.map(row=>{const meta=SOURCE_META[row.source]||{label:pretty(row.source),icon:Bot,color:'neutral'};const Icon=meta.icon;const age=renderedAt-new Date(row.observed_at).getTime();return <button key={row.source} className={`${source===row.source?'active':''} ${meta.color}`} onClick={()=>setSource(row.source)}><Icon/><span><strong>{meta.label}</strong><small>{age<86_400_000?'Fresh today':`${Math.floor(age/86_400_000)}d old`} · {row.observations}</small></span><i className={age<2*86_400_000?'fresh':'stale'}/></button>})}</section>
    {!!overview?.forecasts?.length&&<section><div className="section-heading"><span className="eyebrow"><TrendingUp size={12}/> Explainable outlook</span><h2>30-day baseline forecasts</h2></div><div className="forecast-grid">{overview.forecasts.slice(0,4).map(item=><article key={`${item.source}:${item.metric}`}><span>{pretty(item.source)} · {pretty(item.metric)}</span><strong>{Math.round(item.forecast).toLocaleString()}</strong><small>{Math.round(item.lower).toLocaleString()}–{Math.round(item.upper).toLocaleString()} confidence range</small><i className={item.daily_slope>=0?'up':'down'}>{item.daily_slope>=0?'+':''}{item.daily_slope.toFixed(1)} / day</i><footer title={item.method}>{item.history_days} days of real evidence · transparent linear baseline</footer></article>)}</div></section>}
    <section className="ops-card"><div className="ops-toolbar"><div className="ops-search"><Search size={15}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Filter metrics, pages and dimensions…"/></div><span className="result-count">{filtered.length} current signals</span></div>
      <div className="metric-gallery">{filtered.slice(0,36).map(metric=>{const series=groups.get(`${metric.source}:${metric.metric}`)||[];const meta=SOURCE_META[metric.source]||{label:pretty(metric.source),icon:Activity,color:'neutral'};const Icon=meta.icon;return <article key={`${metric.source}:${metric.metric}:${metric.dimension}`}><header><span className={`metric-source ${meta.color}`}><Icon size={13}/>{meta.label}</span><time>{new Date(metric.observed_at).toLocaleDateString()}</time></header><small>{pretty(metric.metric)}</small><strong>{formatValue(metric)}</strong>{metric.dimension&&<p title={metric.dimension}>{metric.dimension}</p>}<MiniSeries rows={series.filter(row=>row.dimension===metric.dimension)}/><footer><span>Provenance retained</span><span>{metric.unit||'value'}</span></footer></article>})}{!filtered.length&&<div className="ops-empty"><Activity/><h3>No observations in this view</h3><p>Connect a source or broaden your filters. Sample data never replaces real tenant evidence.</p></div>}</div>
    </section>
  </div>
}
