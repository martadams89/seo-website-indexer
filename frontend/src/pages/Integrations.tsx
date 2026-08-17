import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Check, Cloud, Code2, Database, Gauge, Globe2, Link2, LockKeyhole, Plus, RefreshCw, ShieldCheck, Store, Trash2, Webhook } from 'lucide-react';
import { api, type GoogleAccount, type IntegrationProvider, type PlatformIntegration, type Site } from '../api';
import { useToast } from '../AppContext';
import { Modal } from '../components/Modal';
import { useWorkspace } from '../workspace/WorkspaceContext';

type Field={key:string;label:string;placeholder?:string;secret?:boolean;help?:string;type?:'text'|'url'|'select';options?:Array<{value:string;label:string}>};
type ProviderDef={label:string;description:string;group:string;icon:typeof Activity;color:string;site:boolean;fields:Field[];value:string};
const BASE_DEFS:Record<IntegrationProvider,ProviderDef>={
  ga4:{label:'Google Analytics 4',description:'Join landing-page engagement, conversions and revenue to organic demand.',group:'Analytics',icon:BarChart3,color:'google',site:true,value:'Outcomes',fields:[{key:'google_account_id',label:'Google account',type:'select',options:[]},{key:'property_id',label:'GA4 property ID',placeholder:'123456789',help:'The numeric property ID, not the measurement ID.'}]},
  pagespeed:{label:'PageSpeed + CrUX',description:'Scheduled Lighthouse lab checks, experience budgets and regression evidence.',group:'Experience',icon:Gauge,color:'amber',site:true,value:'Regressions',fields:[{key:'url',label:'Audit URL',placeholder:'Defaults to the site home page',type:'url'},{key:'api_key',label:'PageSpeed API key',secret:true,help:'Optional when the workspace CrUX key is already configured.'}]},
  cloudflare:{label:'Cloudflare',description:'Edge traffic, cache behavior, response errors and crawler evidence.',group:'Edge & logs',icon:Cloud,color:'orange',site:true,value:'Delivery',fields:[{key:'zone_id',label:'Zone ID',placeholder:'32-character zone identifier'},{key:'api_token',label:'Analytics API token',secret:true,help:'Use a least-privilege token with Zone Analytics: Read.'}]},
  plausible:{label:'Plausible',description:'Privacy-first visits, engagement and landing-page outcomes.',group:'Analytics',icon:Activity,color:'cyan',site:true,value:'Outcomes',fields:[{key:'base_url',label:'Base URL',placeholder:'https://plausible.io',type:'url'},{key:'site_id',label:'Plausible site ID',placeholder:'example.com'},{key:'api_token',label:'Stats API token',secret:true}]},
  matomo:{label:'Matomo',description:'Self-hosted traffic, engagement and conversion reporting.',group:'Analytics',icon:Database,color:'violet',site:true,value:'Outcomes',fields:[{key:'base_url',label:'Matomo URL',placeholder:'https://analytics.example.com',type:'url'},{key:'site_id',label:'Site ID',placeholder:'1'},{key:'token_auth',label:'Auth token',secret:true}]},
  wordpress:{label:'WordPress',description:'Governed draft, review, publish and verification workflow.',group:'Publishing',icon:Globe2,color:'blue',site:true,value:'Action',fields:[{key:'base_url',label:'WordPress URL',placeholder:'https://example.com',type:'url'},{key:'username',label:'Username'},{key:'app_password',label:'Application password',secret:true}]},
  shopify:{label:'Shopify',description:'Approval-gated article and commerce content operations.',group:'Publishing',icon:Store,color:'green',site:true,value:'Action',fields:[{key:'shop_domain',label:'Shop domain',placeholder:'store.myshopify.com'},{key:'access_token',label:'Admin API access token',secret:true},{key:'api_version',label:'API version',placeholder:'2026-07'}]},
  webflow:{label:'Webflow',description:'Stage CMS items, approve, publish and verify separately.',group:'Publishing',icon:Code2,color:'pink',site:true,value:'Action',fields:[{key:'access_token',label:'Data API token',secret:true},{key:'collection_id',label:'Default collection ID'}]},
  log_ingest:{label:'Server log ingest',description:'Scoped API endpoint for bot behavior, response codes and crawl waste.',group:'Edge & logs',icon:Webhook,color:'neutral',site:false,value:'Evidence',fields:[]},
  rank_feed:{label:'External rank feed',description:'Optional Semrush, Ahrefs, DataForSEO or custom rank evidence through the normalized events API.',group:'Search data',icon:BarChart3,color:'violet',site:false,value:'Optional',fields:[]},
};

export default function IntegrationsPage(){
  const {active}=useWorkspace();const toast=useToast();const canManage=!!active?.permissions?.manage_integrations;
  const [integrations,setIntegrations]=useState<PlatformIntegration[]>([]);const [sites,setSites]=useState<Site[]>([]);const [accounts,setAccounts]=useState<GoogleAccount[]>([]);
  const [selected,setSelected]=useState<IntegrationProvider|null>(null);const [editing,setEditing]=useState<PlatformIntegration|null>(null);const [siteId,setSiteId]=useState('');const [name,setName]=useState('');const [config,setConfig]=useState<Record<string,string>>({});const [cadence,setCadence]=useState(1440);const [busy,setBusy]=useState<string|null>(null);
  const load=useCallback(async()=>{const [rows,nextSites,nextAccounts]=await Promise.all([api.getIntegrations(),api.getSites(),api.getAccounts()]);setIntegrations(rows);setSites(nextSites);setAccounts(nextAccounts)},[]);
  useEffect(()=>{load().catch(()=>null)},[load,active?.id]);
  const defs=useMemo(()=>({...BASE_DEFS,ga4:{...BASE_DEFS.ga4,fields:BASE_DEFS.ga4.fields.map(field=>field.key==='google_account_id'?{...field,options:accounts.map(account=>({value:account.id,label:account.email||account.id}))}:field)}}),[accounts]);
  function open(provider:IntegrationProvider,row?:PlatformIntegration){const def=defs[provider];setSelected(provider);setEditing(row||null);setSiteId(row?.site_id||'');setName(row?.name||def.label);setConfig(Object.fromEntries(Object.entries(row?.config||{}).map(([k,v])=>[k,String(v??'')])));setCadence(row?.cadence_minutes||1440)}
  async function save(){if(!selected)return;setBusy('save');try{if(editing)await api.updateIntegration(editing.id,{site_id:siteId||null,name,config,cadence_minutes:cadence});else await api.createIntegration({provider:selected,site_id:siteId||null,name,config,cadence_minutes:cadence});setSelected(null);await load();toast('success',`${defs[selected].label} saved`) }catch(e){toast('error',String(e).replace('Error: ',''))}setBusy(null)}
  async function sync(row:PlatformIntegration){setBusy(row.id);try{const result=await api.syncIntegration(row.id);toast('success',result.message);await load()}catch(e){toast('error',String(e).replace('Error: ',''))}setBusy(null)}
  async function remove(row:PlatformIntegration){if(!confirm(`Remove ${row.name}? Historical observations will be retained.`))return;setBusy(row.id);try{await api.deleteIntegration(row.id);await load();toast('success','Connection removed')}catch(e){toast('error',String(e).replace('Error: ',''))}setBusy(null)}
  const groups=['Analytics','Search data','Experience','Edge & logs','Publishing'];
  return <div className="ops-page integrations-page"><header className="ops-page-header"><div><span className="eyebrow"><Link2 size={13}/> Connected operating system</span><h1>Integrations</h1><p>Add a source only when it contributes unique evidence or closes a safe action loop.</p></div><div className="trust-chip"><ShieldCheck/><span><strong>Tenant encrypted</strong><small>Secrets are write-only and workspace scoped</small></span></div></header>
    {integrations.length>0&&<section className="ops-card connections-panel"><div className="ops-card-head"><div><span className="eyebrow">Live data plane</span><h2>Your connections</h2></div><span>{integrations.filter(i=>i.status==='connected').length}/{integrations.length} healthy</span></div><div className="connection-list">{integrations.map(row=>{const def=defs[row.provider];const Icon=def.icon;return <article key={row.id}><span className={`integration-logo ${def.color}`}><Icon/></span><div><strong>{row.name}</strong><small>{def.label}{row.site_id?` · ${sites.find(s=>s.id===row.site_id)?.name||'Site'}`:' · Workspace'}</small></div><span className={`connection-status ${row.status}`}><i/>{row.status}</span><div className="freshness"><small>Last refresh</small><span>{row.last_sync_at?new Date(row.last_sync_at).toLocaleString():'Not synced yet'}</span>{row.last_error&&<em title={row.last_error}>{row.last_error}</em>}</div><button className="btn btn-secondary btn-sm" disabled={busy===row.id||!canManage} onClick={()=>sync(row)}>{busy===row.id?<RefreshCw className="spin" size={12}/>:<RefreshCw size={12}/>} Sync</button><button className="btn-icon btn-icon-ghost" disabled={!canManage} onClick={()=>open(row.provider,row)} title="Configure"><Code2 size={14}/></button><button className="btn-icon btn-icon-ghost danger" disabled={!canManage} onClick={()=>remove(row)} title="Remove"><Trash2 size={14}/></button></article>})}</div></section>}
    {groups.map(group=><section className="integration-group" key={group}><div className="section-heading"><div><span className="eyebrow">{group}</span><h2>{group==='Analytics'?'Connect visibility to business outcomes':group==='Experience'?'Make regressions actionable':group==='Publishing'?'Close the change loop safely':'See what search crawlers actually receive'}</h2></div></div><div className="integration-catalog">{(Object.entries(defs) as Array<[IntegrationProvider,ProviderDef]>).filter(([,def])=>def.group===group).map(([provider,def])=>{const Icon=def.icon;const count=integrations.filter(i=>i.provider===provider).length;return <button key={provider} onClick={()=>open(provider)} disabled={!canManage}><span className={`integration-logo ${def.color}`}><Icon/></span><span className="catalog-value">{def.value}</span><h3>{def.label}</h3><p>{def.description}</p><footer>{count?<span className="connected-count"><Check size={12}/>{count} connected</span>:<span>Add connection</span>}<Plus size={15}/></footer></button>})}</div></section>)}
    {selected&&<Modal
      onClose={()=>setSelected(null)}
      size="lg"
      className="integration-modal"
      eyebrow={editing?'Configure connection':'New connection'}
      title={defs[selected].label}
      description={defs[selected].description}
      icon={(()=>{const Icon=defs[selected].icon;return <Icon/>})()}
      footer={<><button className="btn btn-ghost" onClick={()=>setSelected(null)}>Cancel</button><button className="btn btn-primary" disabled={busy==='save'||!name.trim()} onClick={save}>{busy==='save'?'Saving…':editing?'Save connection':'Connect source'}</button></>}
    >
      <div className="integration-setup-layout">
        <main>
          <section className="modal-form-section">
            <header><span>01</span><div><h3>Name and scope</h3><p>Choose where this connection can contribute data or actions.</p></div></header>
            <div className="form-grid">
              <label className="full">Connection name<input data-autofocus value={name} onChange={e=>setName(e.target.value)} placeholder={`e.g. ${defs[selected].label} · Production`}/><small>Use a name your team will recognise in reports and approval flows.</small></label>
              {defs[selected].site&&<label className="full">Website scope<select value={siteId} onChange={e=>setSiteId(e.target.value)}><option value="">All websites in this workspace</option>{sites.map(site=><option key={site.id} value={site.id}>{site.name} · {site.domain}</option>)}</select><small>Workspace-wide connections can be reused across every website you manage.</small></label>}
            </div>
          </section>
          <section className="modal-form-section">
            <header><span>02</span><div><h3>{defs[selected].fields.length?'Authentication and source details':'Connection details'}</h3><p>{defs[selected].fields.length?'Add the minimum credentials needed for this source.':'This source uses a generated workspace endpoint after it is connected.'}</p></div></header>
            {defs[selected].fields.length?<div className="form-grid integration-field-grid">{defs[selected].fields.map(field=><label className={field.help?'full':''} key={field.key}>{field.label}{field.type==='select'?<select value={config[field.key]||''} onChange={e=>setConfig({...config,[field.key]:e.target.value})}><option value="">Choose an account…</option>{field.options?.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>:<input autoComplete={field.secret?'new-password':undefined} type={field.secret?'password':field.type==='url'?'url':'text'} value={config[field.key]||''} placeholder={field.secret&&editing?.configured_secrets.includes(field.key)?'•••••••• saved — leave blank to keep':field.placeholder} onChange={e=>setConfig({...config,[field.key]:e.target.value})}/>} {field.help&&<small>{field.help}</small>}</label>)}</div>:<div className="integration-generated-note"><Webhook/><div><strong>No credentials needed here</strong><span>Save the connection first. The scoped ingest endpoint and setup instructions will then appear with the connection.</span></div></div>}
          </section>
          <section className="modal-form-section">
            <header><span>03</span><div><h3>Refresh policy</h3><p>Control how often this source updates the workspace evidence layer.</p></div></header>
            <label className="integration-cadence">Refresh cadence<select value={cadence} onChange={e=>setCadence(Number(e.target.value))}><option value={60}>Hourly</option><option value={360}>Every 6 hours</option><option value={1440}>Daily</option><option value={10080}>Weekly</option></select><small>You can always run an immediate sync from the connections list.</small></label>
          </section>
        </main>
        <aside className="integration-setup-aside">
          <div className="integration-preview">
            <span className={`integration-logo ${defs[selected].color}`}>{(()=>{const Icon=defs[selected].icon;return <Icon/>})()}</span>
            <span className="eyebrow">What this adds</span>
            <strong>{defs[selected].value}</strong>
            <p>{defs[selected].description}</p>
            <dl><div><dt>Scope</dt><dd>{defs[selected].site?(siteId?sites.find(site=>site.id===siteId)?.name||'Selected website':'Whole workspace'):'Whole workspace'}</dd></div><div><dt>Refresh</dt><dd>{cadence===60?'Hourly':cadence===360?'Every 6 hours':cadence===1440?'Daily':'Weekly'}</dd></div><div><dt>Secrets</dt><dd>{defs[selected].fields.some(field=>field.secret)?'Encrypted':'Not required'}</dd></div></dl>
          </div>
          <div className="secret-notice"><LockKeyhole/><span><strong>Credentials stay private</strong>Secrets are encrypted at rest, write-only and isolated to this workspace. {editing?'Leave a saved secret blank to keep it unchanged.':''}</span></div>
          <div className="integration-safety-note"><ShieldCheck/><span><strong>Safe by default</strong>Adding a source does not publish changes. Action integrations still use the approval queue.</span></div>
        </aside>
      </div>
    </Modal>}
  </div>
}
