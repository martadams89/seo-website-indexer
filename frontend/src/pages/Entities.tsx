import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, BadgeCheck, Building2, CircleHelp, ExternalLink, Globe2, Link2, MapPin,
  Plus, RefreshCw, Search, Sparkles, Star, Trash2, X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, type EntityDiscovery, type LocalEntity, type Site } from '../api';
import { useToast } from '../AppContext';
import { useWorkspace } from '../workspace/WorkspaceContext';

interface IdentifierRow { id: string; kind: string; customKind: string; value: string }
interface ListingRow { id: string; provider: string; url: string; status: string; rating: string; reviewCount: string }
interface EntityDraft {
  name: string; market: string; locale: string; entityType: string; siteId: string; primaryUrl: string;
  address: string; phone: string; description: string; legalName: string; logoUrl: string;
  reviewRating: string; reviewCount: string; identifiers: IdentifierRow[]; listings: ListingRow[];
}

const IDENTIFIER_TYPES = [
  ['wikidata', 'Wikidata'], ['wikipedia', 'Wikipedia'], ['google_knowledge_panel', 'Google Knowledge Panel'],
  ['linkedin', 'LinkedIn'], ['crunchbase', 'Crunchbase'], ['youtube', 'YouTube'], ['instagram', 'Instagram'],
  ['facebook', 'Facebook'], ['x', 'X / Twitter'], ['google_business_profile', 'Google Business Profile'],
] as const;
const KNOWN_IDENTIFIER_KEYS = new Set<string>(IDENTIFIER_TYPES.map(([key]) => key));
const LISTING_PROVIDERS = [
  'Google Business Profile', 'Google Play', 'Apple App Store', 'Apple Business Connect', 'Bing Places',
  'G2', 'Capterra', 'GetApp', 'Software Advice', 'TrustRadius', 'Trustpilot', 'Product Hunt', 'SourceForge',
  'Chrome Web Store', 'Microsoft Store', 'Yelp', 'Tripadvisor', 'Facebook', 'Other',
];
const LOCALES = ['en-GB', 'en-US', 'en-CA', 'en-AU', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL', 'pt-BR', 'ja-JP'];

const rowId = () => crypto.randomUUID();
const textKnowledge = (knowledge: Record<string, unknown>, key: string) => typeof knowledge[key] === 'string' ? knowledge[key] : '';

function siteHomepage(site?: Site): string {
  if (!site) return '';
  const raw = site.domain.replace(/^sc-domain:/i, '');
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function identifierRows(values: Record<string, string>): IdentifierRow[] {
  return Object.entries(values).map(([key, value]) => ({
    id: rowId(), kind: KNOWN_IDENTIFIER_KEYS.has(key) ? key : 'custom', customKind: KNOWN_IDENTIFIER_KEYS.has(key) ? '' : key, value,
  }));
}

function listingRows(values: LocalEntity['listings']): ListingRow[] {
  return values.map(row => ({ id: rowId(), provider: row.provider, url: row.url || '', status: row.status || 'needs_review',
    rating: row.rating == null ? '' : String(row.rating), reviewCount: row.review_count == null ? '' : String(row.review_count) }));
}

function newDraft(site?: Site): EntityDraft {
  return {
    name: site?.name || '', market: 'Global', locale: 'en-GB', entityType: 'brand', siteId: site?.id || '', primaryUrl: siteHomepage(site),
    address: '', phone: '', description: '', legalName: '', logoUrl: '', reviewRating: '', reviewCount: '', identifiers: [], listings: [],
  };
}

function editDraft(entity: LocalEntity): EntityDraft {
  return {
    name: entity.name, market: entity.market, locale: entity.locale, entityType: entity.entity_type, siteId: entity.site_id || '',
    primaryUrl: entity.primary_url || '', address: entity.address || '', phone: entity.phone || '',
    description: textKnowledge(entity.knowledge, 'description'), legalName: textKnowledge(entity.knowledge, 'legal_name'),
    logoUrl: textKnowledge(entity.knowledge, 'logo_url'), reviewRating: entity.review_rating == null ? '' : String(entity.review_rating),
    reviewCount: entity.review_count == null ? '' : String(entity.review_count), identifiers: identifierRows(entity.identifiers), listings: listingRows(entity.listings),
  };
}

function identifierObject(rows: IdentifierRow[]): Record<string, string> {
  return Object.fromEntries(rows.map(row => [row.kind === 'custom' ? row.customKind.trim() : row.kind, row.value.trim()])
    .filter(([key, value]) => key && value));
}

function mergeListings(current: ListingRow[], discovered: LocalEntity['listings']): ListingRow[] {
  const merged = [...current];
  for (const row of listingRows(discovered)) {
    if (!merged.some(existing => (existing.url && existing.url === row.url) || (existing.provider === row.provider && !row.url))) merged.push(row);
  }
  return merged;
}

export default function EntitiesPage() {
  const { active } = useWorkspace();
  const toast = useToast();
  const canManage = !!active?.permissions?.manage_content;
  const [entities, setEntities] = useState<LocalEntity[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [composer, setComposer] = useState(false);
  const [editing, setEditing] = useState<LocalEntity | null>(null);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<EntityDiscovery | null>(null);
  const [draft, setDraft] = useState<EntityDraft>(() => newDraft());

  const load = useCallback(async () => {
    const [entityRows, siteRows] = await Promise.all([api.getLocalEntities(), api.getSites()]);
    setEntities(entityRows); setSites(siteRows);
  }, []);
  useEffect(() => { load().catch(() => null); }, [load, active?.id]);

  const selectedSite = useMemo(() => sites.find(site => site.id === draft.siteId), [sites, draft.siteId]);

  function open(row?: LocalEntity) {
    setEditing(row || null); setDiscovery(null);
    setDraft(row ? editDraft(row) : newDraft(sites.length === 1 ? sites[0] : undefined));
    setComposer(true);
  }

  function close() { setComposer(false); setEditing(null); setDiscovery(null); }

  function chooseSite(siteId: string) {
    const site = sites.find(row => row.id === siteId);
    setDraft(current => ({
      ...current, siteId,
      name: !editing && (!current.name || sites.some(row => row.name === current.name)) ? site?.name || '' : current.name,
      primaryUrl: !editing && (!current.primaryUrl || sites.some(row => siteHomepage(row) === current.primaryUrl)) ? siteHomepage(site) : current.primaryUrl,
    }));
    setDiscovery(null);
  }

  async function discover() {
    if (!draft.siteId) return toast('info', 'Choose a website to scan first.');
    setDiscovering(true);
    try {
      const result = await api.discoverLocalEntity(draft.siteId);
      const found = result.data;
      setDiscovery(result);
      setDraft(current => ({
        ...current,
        name: found.name || current.name,
        market: found.market || current.market,
        locale: found.locale || current.locale,
        entityType: found.entity_type || current.entityType,
        primaryUrl: found.primary_url || current.primaryUrl,
        address: found.address || current.address,
        phone: found.phone || current.phone,
        description: textKnowledge(found.knowledge, 'description') || current.description,
        legalName: textKnowledge(found.knowledge, 'legal_name') || current.legalName,
        logoUrl: textKnowledge(found.knowledge, 'logo_url') || current.logoUrl,
        reviewRating: found.review_rating == null ? current.reviewRating : String(found.review_rating),
        reviewCount: found.review_count == null ? current.reviewCount : String(found.review_count),
        identifiers: identifierRows({ ...identifierObject(current.identifiers), ...found.identifiers }),
        listings: mergeListings(current.listings, found.listings),
      }));
      toast('success', `Found ${result.found_fields.length} editable facts. Review them before saving.`);
    } catch (error) { toast('error', String(error).replace('Error: ', '')); }
    finally { setDiscovering(false); }
  }

  async function save() {
    setBusy(true);
    try {
      const knowledge: Record<string, unknown> = { ...(editing?.knowledge || {}) };
      for (const [key, value] of [['description', draft.description], ['legal_name', draft.legalName], ['logo_url', draft.logoUrl]]) {
        if (value.trim()) knowledge[key] = value.trim(); else delete knowledge[key];
      }
      if (discovery) knowledge.discovery = {
        source_url: discovery.source_url,
        discovered_at: discovery.discovered_at,
        schema_types: discovery.schema_types,
        selection: discovery.selection,
      };
      const listings = draft.listings.filter(row => row.provider.trim()).map(row => ({
        provider: row.provider.trim(), url: row.url.trim() || undefined, status: row.status,
        rating: row.rating ? Number(row.rating) : undefined, review_count: row.reviewCount ? Number(row.reviewCount) : undefined,
      }));
      await api.saveLocalEntity({
        id: editing?.id, name: draft.name.trim(), market: draft.market.trim(), locale: draft.locale.trim(), entity_type: draft.entityType,
        site_id: draft.siteId || null, primary_url: draft.primaryUrl.trim() || null, address: draft.address.trim() || null,
        phone: draft.phone.trim() || null, identifiers: identifierObject(draft.identifiers), listings, knowledge,
        review_rating: draft.reviewRating ? Number(draft.reviewRating) : null, review_count: draft.reviewCount ? Number(draft.reviewCount) : null,
      });
      close(); await load(); toast('success', 'Entity source of truth saved.');
    } catch (error) { toast('error', String(error).replace('Error: ', '')); }
    finally { setBusy(false); }
  }

  async function remove(row: LocalEntity) {
    if (!confirm(`Delete ${row.name} in ${row.market}?`)) return;
    try { await api.deleteLocalEntity(row.id); await load(); toast('success', 'Entity deleted.'); }
    catch (error) { toast('error', String(error).replace('Error: ', '')); }
  }

  function addIdentifier() {
    setDraft(current => ({ ...current, identifiers: [...current.identifiers, { id: rowId(), kind: 'wikidata', customKind: '', value: '' }] }));
  }

  function addListing() {
    setDraft(current => ({ ...current, listings: [...current.listings, { id: rowId(), provider: 'Google Business Profile', url: '', status: 'needs_review', rating: '', reviewCount: '' }] }));
  }

  if (composer) return <div className="ops-page entity-editor-page">
    <header className="entity-editor-header">
      <button className="btn btn-ghost" onClick={close}><ArrowLeft size={14}/> Back to entities</button>
      <div><span className="eyebrow">Workspace knowledge source</span><h1>{editing ? `Manage ${editing.name}` : 'Add a brand or market entity'}</h1><p>Discover public facts from your website, review them in normal fields, then save the approved source of truth.</p></div>
      <span className="entity-editor-state">{editing ? 'Editing saved record' : 'New record'}</span>
    </header>

    <div className="entity-editor-shell">
      <aside className="entity-editor-guide">
        <div className="entity-discovery-panel">
          <span className="entity-guide-icon"><Search/></span>
          <h2>Start with your website</h2>
          <p>We scan the selected homepage for Organization, LocalBusiness, Person or Product structured data, canonical URLs, profiles and reviews.</p>
          {sites.length ? <>
            <label>Website<select value={draft.siteId} onChange={event => chooseSite(event.target.value)}><option value="">Choose a website</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name} · {site.domain}</option>)}</select></label>
            <button className="btn btn-primary" disabled={!draft.siteId || discovering} onClick={discover}>{discovering ? <RefreshCw className="spin" size={14}/> : <Sparkles size={14}/>} {discovering ? 'Scanning website…' : discovery ? 'Scan again' : 'Discover public facts'}</button>
            <small>{selectedSite ? `Reads ${selectedSite.domain}. ` : ''}Public HTML only; your website is never changed.</small>
          </> : <div className="entity-no-site"><p>Add a website first so we have a trusted source to inspect.</p><Link className="btn btn-secondary btn-sm" to="/sites">Go to websites</Link></div>}
          {discovery && <div className="entity-discovery-result">
            <div><BadgeCheck/><strong>{discovery.found_fields.length} facts discovered</strong></div>
            <section className="entity-selected-identity"><span>Selected identity</span><strong>{discovery.selection.selected_name}</strong><small>{discovery.selection.selected_type}</small><p>{discovery.selection.reason}</p></section>
            {discovery.selection.candidates.length > 1 && <details><summary>Other identities found ({discovery.selection.candidates.length - 1})</summary><ul>{discovery.selection.candidates.filter(candidate => !candidate.selected).map(candidate => <li key={`${candidate.type}-${candidate.name}-${candidate.url}`}><span><strong>{candidate.name}</strong><small>{candidate.type}{candidate.relationship ? ` · ${candidate.relationship}` : ''}</small></span>{candidate.url && <a href={candidate.url} target="_blank" rel="noreferrer" aria-label={`Open ${candidate.name}`}><ExternalLink/></a>}</li>)}</ul></details>}
            <span>{discovery.sources.join(' + ')}</span>{discovery.schema_types.length > 0 && <span>Schema found: {discovery.schema_types.join(', ')}</span>}{discovery.warnings.map(warning => <p key={warning}>{warning}</p>)}
          </div>}
        </div>

        <div className="entity-howto">
          <h3>What this section does</h3>
          <ol><li><b>Discover</b><span>Read facts your site already publishes.</span></li><li><b>Review</b><span>Correct the data and add authoritative profiles.</span></li><li><b>Monitor</b><span>Track completeness and listing consistency by market.</span></li></ol>
          <p><CircleHelp/> Saving here creates an internal reference record. It does not publish schema or edit third-party listings.</p>
        </div>

        <details className="entity-example"><summary>Show an example record</summary><dl><div><dt>Name</dt><dd>Acme SEO London</dd></div><div><dt>Market</dt><dd>London</dd></div><div><dt>Type</dt><dd>Location</dd></div><div><dt>Profile</dt><dd>Wikidata Q12345</dd></div><div><dt>Listing</dt><dd>Google Business Profile</dd></div></dl></details>
      </aside>

      <main className="entity-editor-form">
        <section className="entity-form-section">
          <header><span>1</span><div><h2>Identity and market</h2><p>The canonical facts answer engines and customers should agree on.</p></div></header>
          <div className="entity-field-grid">
            <label>Name<input autoFocus value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Acme SEO London"/><small>Brand, location, person or product name.</small></label>
            <label>Entity type<select value={draft.entityType} onChange={event => setDraft({ ...draft, entityType: event.target.value })}><option value="brand">Brand / organisation</option><option value="location">Physical location</option><option value="person">Person</option><option value="product">Product</option></select></label>
            <label>Market or service area<input value={draft.market} onChange={event => setDraft({ ...draft, market: event.target.value })} placeholder="e.g. London, United Kingdom or Global"/></label>
            <label>Language / locale<input list="entity-locales" value={draft.locale} onChange={event => setDraft({ ...draft, locale: event.target.value })} placeholder="en-GB"/><datalist id="entity-locales">{LOCALES.map(locale => <option key={locale} value={locale}/>)}</datalist></label>
            <label className="full">Canonical URL<input type="url" value={draft.primaryUrl} onChange={event => setDraft({ ...draft, primaryUrl: event.target.value })} placeholder="https://example.com/locations/london"/><small>The single page that best represents this entity.</small></label>
            <label className="full">Short description<textarea rows={3} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder="A plain-language description of who or what this entity is."/></label>
            <label>Legal name<input value={draft.legalName} onChange={event => setDraft({ ...draft, legalName: event.target.value })} placeholder="Optional registered name"/></label>
            <label>Logo URL<input type="url" value={draft.logoUrl} onChange={event => setDraft({ ...draft, logoUrl: event.target.value })} placeholder="https://example.com/logo.png"/></label>
          </div>
        </section>

        <section className="entity-form-section">
          <header><span>2</span><div><h2>Location and reviews</h2><p>Use customer-facing contact details only. Leave location fields empty for global or online-only brands.</p></div></header>
          <div className="entity-field-grid">
            <label className="full">Public address<textarea rows={2} value={draft.address} onChange={event => setDraft({ ...draft, address: event.target.value })} placeholder="Street, locality, region, postcode, country"/></label>
            <label>Public phone<input type="tel" value={draft.phone} onChange={event => setDraft({ ...draft, phone: event.target.value })} placeholder="+44 20 0000 0000"/></label>
            <div/>
            <label>Overall review rating<input type="number" min="0" max="5" step="0.1" value={draft.reviewRating} onChange={event => setDraft({ ...draft, reviewRating: event.target.value })} placeholder="4.8"/></label>
            <label>Overall review count<input type="number" min="0" value={draft.reviewCount} onChange={event => setDraft({ ...draft, reviewCount: event.target.value })} placeholder="120"/></label>
          </div>
        </section>

        <section className="entity-form-section">
          <header><span>3</span><div><h2>Authoritative profiles</h2><p>Links or IDs that prove this entity is the same organization, person or product elsewhere. No JSON required.</p></div><button className="btn btn-secondary btn-sm" onClick={addIdentifier}><Plus size={12}/> Add profile</button></header>
          {!draft.identifiers.length && <div className="entity-row-empty"><Link2/><span>No profiles yet. Discovery can find sameAs links from your website, or add one manually.</span></div>}
          <div className="entity-repeat-list">{draft.identifiers.map((row, index) => <div className="entity-identifier-row" key={row.id}>
            <select aria-label={`Profile type ${index + 1}`} value={row.kind} onChange={event => setDraft(current => ({ ...current, identifiers: current.identifiers.map(item => item.id === row.id ? { ...item, kind: event.target.value } : item) }))}>{IDENTIFIER_TYPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="custom">Other identifier</option></select>
            {row.kind === 'custom' && <input aria-label={`Custom profile name ${index + 1}`} value={row.customKind} onChange={event => setDraft(current => ({ ...current, identifiers: current.identifiers.map(item => item.id === row.id ? { ...item, customKind: event.target.value } : item) }))} placeholder="Identifier name"/>}
            <input aria-label={`Profile URL or ID ${index + 1}`} value={row.value} onChange={event => setDraft(current => ({ ...current, identifiers: current.identifiers.map(item => item.id === row.id ? { ...item, value: event.target.value } : item) }))} placeholder="Profile URL or stable ID"/>
            <button className="btn-icon btn-icon-ghost" aria-label={`Remove profile ${index + 1}`} onClick={() => setDraft(current => ({ ...current, identifiers: current.identifiers.filter(item => item.id !== row.id) }))}><X size={13}/></button>
          </div>)}</div>
        </section>

        <section className="entity-form-section">
          <header><span>4</span><div><h2>Listings and review sources</h2><p>Add public business profiles and mark whether their facts match this approved record.</p></div><button className="btn btn-secondary btn-sm" onClick={addListing}><Plus size={12}/> Add listing</button></header>
          {!draft.listings.length && <div className="entity-row-empty"><Star/><span>No listings yet. Website discovery recognises common Google, Bing, Apple, Yelp and Tripadvisor links.</span></div>}
          {draft.listings.length > 0 && <div className="entity-listing-labels"><span>Provider</span><span>Listing URL</span><span>Fact status</span><span>Rating</span><span>Reviews</span><span/></div>}
          <div className="entity-repeat-list">{draft.listings.map((row, index) => <div className="entity-listing-row" key={row.id}>
            <select aria-label={`Listing provider ${index + 1}`} value={row.provider} onChange={event => setDraft(current => ({ ...current, listings: current.listings.map(item => item.id === row.id ? { ...item, provider: event.target.value } : item) }))}>{!LISTING_PROVIDERS.includes(row.provider) && <option value={row.provider}>{row.provider}</option>}{LISTING_PROVIDERS.map(provider => <option key={provider} value={provider}>{provider}</option>)}</select>
            <input type="url" aria-label={`Listing URL ${index + 1}`} value={row.url} onChange={event => setDraft(current => ({ ...current, listings: current.listings.map(item => item.id === row.id ? { ...item, url: event.target.value } : item) }))} placeholder="https://…"/>
            <select aria-label={`Listing status ${index + 1}`} value={row.status} onChange={event => setDraft(current => ({ ...current, listings: current.listings.map(item => item.id === row.id ? { ...item, status: event.target.value } : item) }))}><option value="needs_review">Needs review</option><option value="consistent">Facts match</option><option value="inconsistent">Needs correction</option></select>
            <input type="number" min="0" max="5" step="0.1" aria-label={`Listing rating ${index + 1}`} value={row.rating} onChange={event => setDraft(current => ({ ...current, listings: current.listings.map(item => item.id === row.id ? { ...item, rating: event.target.value } : item) }))} placeholder="4.8"/>
            <input type="number" min="0" aria-label={`Listing review count ${index + 1}`} value={row.reviewCount} onChange={event => setDraft(current => ({ ...current, listings: current.listings.map(item => item.id === row.id ? { ...item, reviewCount: event.target.value } : item) }))} placeholder="120"/>
            <button className="btn-icon btn-icon-ghost" aria-label={`Remove listing ${index + 1}`} onClick={() => setDraft(current => ({ ...current, listings: current.listings.filter(item => item.id !== row.id) }))}><X size={13}/></button>
          </div>)}</div>
        </section>

        <footer className="entity-editor-actions"><div><strong>Ready to save?</strong><span>You can re-scan the linked website or edit these facts at any time.</span></div><button className="btn btn-ghost" onClick={close}>Cancel</button><button className="btn btn-primary" disabled={busy || !draft.name.trim() || !draft.market.trim()} onClick={save}>{busy ? <RefreshCw size={13} className="spin"/> : <BadgeCheck size={13}/>} {busy ? 'Saving…' : 'Save source of truth'}</button></footer>
      </main>
    </div>
  </div>;

  return <div className="ops-page entities-page">
    <header className="ops-page-header"><div><span className="eyebrow"><MapPin size={13}/> Brand and market knowledge</span><h1>Markets & entities</h1><p>A reviewed source of truth for the brands, locations, people and products that search engines and answer engines need to understand.</p></div><button className="btn btn-primary" disabled={!canManage} onClick={() => open()}><Sparkles size={14}/> Add or discover entity</button></header>

    <section className="entity-purpose"><div><span className="entity-guide-icon"><CircleHelp/></span><div><span className="eyebrow">What this is for</span><h2>Make your public identity consistent and measurable</h2><p>Connect an entity to a website, discover the facts already published in structured data, then review its canonical URL, contact details, profiles, listings and reviews. The score highlights missing or unverified evidence; nothing is published automatically.</p></div></div><ol><li><b>1</b><span>Scan a website</span></li><li><b>2</b><span>Review normal fields</span></li><li><b>3</b><span>Track consistency</span></li></ol></section>

    <section className="entity-summary"><div><Globe2/><strong>{new Set(entities.map(row => row.market)).size}</strong><span>markets</span></div><div><Building2/><strong>{entities.length}</strong><span>entities</span></div><div><Star/><strong>{entities.length ? Math.round(entities.reduce((sum, row) => sum + row.consistency_score, 0) / entities.length) : 0}%</strong><span>evidence completeness</span></div><p>Each record is tenant-scoped and can be linked to one website or kept workspace-wide. Re-scan whenever public schema changes, then verify listings before they contribute to the score.</p></section>

    <div className="entity-grid">{entities.map(row => <article key={row.id}><header><span className="site-monogram">{row.name.slice(0, 1).toUpperCase()}</span><div><span className="eyebrow">{row.entity_type} · {row.locale}</span><h2>{row.name}</h2><p><MapPin size={10}/>{row.market}</p></div><button className="btn-icon btn-icon-ghost" aria-label={`Delete ${row.name}`} disabled={!canManage} onClick={() => remove(row)}><Trash2 size={13}/></button></header><div className="entity-score"><div style={{ '--entity-score': `${row.consistency_score}%` } as React.CSSProperties}/><strong>{row.consistency_score}%</strong><span>evidence completeness</span></div><dl><div><dt>Canonical identity</dt><dd>{row.primary_url ? <a href={row.primary_url} target="_blank" rel="noreferrer">Open <ExternalLink/></a> : 'Add primary URL'}</dd></div><div><dt>Contact facts</dt><dd>{row.address && row.phone ? 'Complete' : 'Needs detail'}</dd></div><div><dt>Profiles</dt><dd>{Object.keys(row.identifiers).length}</dd></div><div><dt>Verified listings</dt><dd>{row.listings.filter(item => item.status === 'consistent' || item.status === 'verified').length} / {row.listings.length}</dd></div><div><dt>Reviews</dt><dd>{row.review_rating ? `${row.review_rating.toFixed(1)} · ${row.review_count || 0}` : 'Not connected'}</dd></div></dl><footer><span>Updated {new Date(row.updated_at).toLocaleDateString()}</span><button className="btn btn-secondary btn-sm" disabled={!canManage} onClick={() => open(row)}>Review facts</button></footer></article>)}
      {!entities.length && <div className="ops-empty entity-empty"><Sparkles/><h3>Discover your first entity from a website</h3><p>We can read public Organization or LocalBusiness schema and page metadata, pre-fill normal form fields, and show exactly what still needs review.</p>{sites.length ? <button className="btn btn-primary" disabled={!canManage} onClick={() => open()}><Search size={13}/> Start website discovery</button> : <Link className="btn btn-secondary" to="/sites">Add a website first</Link>}<button className="btn btn-ghost btn-sm" disabled={!canManage} onClick={() => open()}><Plus size={12}/> Or enter facts manually</button></div>}
    </div>
  </div>;
}
