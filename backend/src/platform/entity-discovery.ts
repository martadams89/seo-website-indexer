import type { Site } from '../db/database.js';
import { readResponseText, safeFetch } from '../security/outbound-url.js';

export interface DiscoveredListing {
  provider: string;
  url?: string;
  status?: string;
  rating?: number;
  review_count?: number;
}

export interface EntityDiscoveryData {
  name: string;
  market: string;
  locale: string;
  entity_type: string;
  primary_url: string;
  address: string;
  phone: string;
  identifiers: Record<string, string>;
  listings: DiscoveredListing[];
  knowledge: Record<string, unknown>;
  review_rating: number | null;
  review_count: number | null;
}

export interface EntityDiscoveryResult {
  source_url: string;
  discovered_at: string;
  schema_types: string[];
  sources: string[];
  found_fields: string[];
  warnings: string[];
  selection: {
    selected_name: string;
    selected_type: string;
    reason: string;
    candidates: Array<{
      name: string;
      type: string;
      url: string;
      selected: boolean;
      relationship?: string;
    }>;
  };
  data: EntityDiscoveryData;
}

type JsonLdNode = Record<string, unknown>;

const RELEVANT_TYPES = new Set(['organization', 'localbusiness', 'person', 'product', 'softwareapplication', 'mobileapplication', 'webapplication', 'corporation', 'professionalservice']);
const IDENTITY_TYPES = new Set([...RELEVANT_TYPES, 'brand', 'website']);

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').trim();
}

function textValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return textValue(row.name ?? row.value ?? row.url ?? row['@id']);
  }
  return '';
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function nodeTypes(node: JsonLdNode): string[] {
  return arrayValue(node['@type']).map(textValue).filter(Boolean);
}

function flattenJsonLd(value: unknown): JsonLdNode[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== 'object') return [];
  const node = value as JsonLdNode;
  return [node, ...flattenJsonLd(node['@graph'])];
}

function extractJsonLd(html: string): JsonLdNode[] {
  const nodes: JsonLdNode[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { nodes.push(...flattenJsonLd(JSON.parse(decodeHtml(match[1])))); }
    catch { /* Broken JSON-LD is reported as unavailable instead of breaking discovery. */ }
  }
  return nodes;
}

function mergeValues(current: unknown, next: unknown): unknown {
  if (current == null) return next;
  if (next == null) return current;
  if (Array.isArray(current) || Array.isArray(next)) {
    const values = [...arrayValue(current), ...arrayValue(next)];
    return values.filter((value, index) => values.findIndex(item => JSON.stringify(item) === JSON.stringify(value)) === index);
  }
  if (typeof current === 'object' && typeof next === 'object') {
    const merged = { ...(current as JsonLdNode) };
    for (const [key, value] of Object.entries(next as JsonLdNode)) merged[key] = mergeValues(merged[key], value);
    return merged;
  }
  return current === next ? current : next;
}

function mergeJsonLdNodes(nodes: JsonLdNode[]): JsonLdNode[] {
  const merged: JsonLdNode[] = [];
  const byId = new Map<string, number>();
  for (const node of nodes) {
    const id = textValue(node['@id']);
    if (!id || !byId.has(id)) {
      if (id) byId.set(id, merged.length);
      merged.push(node);
      continue;
    }
    const index = byId.get(id)!;
    merged[index] = mergeValues(merged[index], node) as JsonLdNode;
  }
  return merged;
}

function attr(html: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const value = pattern.exec(html)?.[1];
    if (value) return decodeHtml(value);
  }
  return '';
}

function meta(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return attr(html, [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["']`, 'i'),
  ]);
}

function canonical(html: string): string {
  return attr(html, [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)/i,
    /<link[^>]+href=["']([^"']*)["'][^>]+rel=["']canonical["']/i,
  ]);
}

function localeFromHtml(html: string): string {
  return attr(html, [/<html[^>]+lang=["']([^"']+)/i]).replace('_', '-');
}

function addressParts(value: unknown): { formatted: string; market: string } {
  if (typeof value === 'string') return { formatted: value.trim(), market: '' };
  if (!value || typeof value !== 'object') return { formatted: '', market: '' };
  const address = value as Record<string, unknown>;
  const locality = textValue(address.addressLocality);
  const region = textValue(address.addressRegion);
  const country = textValue(address.addressCountry);
  const parts = [
    textValue(address.streetAddress), locality, region, textValue(address.postalCode), country,
  ].filter((part, index, all) => part && all.indexOf(part) === index);
  return { formatted: parts.join(', '), market: locality || region || country };
}

function identifierKey(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('wikidata.org')) return 'wikidata';
  if (lower.includes('wikipedia.org')) return 'wikipedia';
  if (lower.includes('google.') && (lower.includes('/maps') || lower.includes('maps.app.goo.gl'))) return 'google_business_profile';
  if (lower.includes('google.') && lower.includes('kgmid')) return 'google_knowledge_panel';
  if (lower.includes('linkedin.com')) return 'linkedin';
  if (lower.includes('crunchbase.com')) return 'crunchbase';
  if (lower.includes('instagram.com')) return 'instagram';
  if (lower.includes('facebook.com')) return 'facebook';
  if (lower.includes('youtube.com')) return 'youtube';
  if (lower.includes('twitter.com') || lower.includes('x.com')) return 'x';
  try { return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '_'); }
  catch { return 'other'; }
}

function listingProvider(url: string): string | null {
  const lower = url.toLowerCase();
  if (lower.includes('play.google.com/store/apps')) return 'Google Play';
  if (lower.includes('apps.apple.com/')) return 'Apple App Store';
  if (lower.includes('g2.com/products/')) return 'G2';
  if (lower.includes('capterra.com/')) return 'Capterra';
  if (lower.includes('getapp.com/')) return 'GetApp';
  if (lower.includes('softwareadvice.com/')) return 'Software Advice';
  if (lower.includes('trustradius.com/products/')) return 'TrustRadius';
  if (lower.includes('trustpilot.com/review/')) return 'Trustpilot';
  if (lower.includes('producthunt.com/products/')) return 'Product Hunt';
  if (lower.includes('sourceforge.net/software/product/')) return 'SourceForge';
  if (lower.includes('chromewebstore.google.com/')) return 'Chrome Web Store';
  if (lower.includes('apps.microsoft.com/') || lower.includes('microsoft.com/store/apps/')) return 'Microsoft Store';
  if (lower.includes('google.') && (lower.includes('/maps') || lower.includes('maps.app.goo.gl'))) return 'Google Business Profile';
  if (lower.includes('bing.com/maps')) return 'Bing Places';
  if (lower.includes('yelp.')) return 'Yelp';
  if (lower.includes('tripadvisor.')) return 'Tripadvisor';
  if (lower.includes('maps.apple.com')) return 'Apple Business Connect';
  return null;
}

function schemaType(types: string[], hasAddress: boolean): string {
  const lower = types.map(type => type.toLowerCase());
  if (lower.includes('person')) return 'person';
  if (lower.some(type => ['product', 'softwareapplication', 'mobileapplication', 'webapplication'].includes(type))) return 'product';
  if (lower.some(type => type === 'localbusiness' || type === 'professionalservice') || hasAddress) return 'location';
  return 'brand';
}

function hostname(value: string): string {
  if (!value) return '';
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function identityText(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function namesMatch(candidateName: string, signals: string[]): 'exact' | 'partial' | '' {
  const candidate = identityText(candidateName);
  if (!candidate) return '';
  for (const signal of signals.map(identityText).filter(Boolean)) {
    if (candidate === signal) return 'exact';
    if (candidate.length >= 4 && (signal.includes(candidate) || candidate.includes(signal))) return 'partial';
  }
  return '';
}

interface RankedCandidate {
  node: JsonLdNode;
  score: number;
  name: string;
  type: string;
  url: string;
  signals: string[];
}

function candidateScore(node: JsonLdNode, context?: { siteHost: string; nameSignals: string[] }): RankedCandidate {
  const types = nodeTypes(node).map(type => type.toLowerCase());
  let score = types.some(type => RELEVANT_TYPES.has(type)) ? 20 : 0;
  for (const key of ['name', 'url', 'address', 'telephone', 'sameAs', 'aggregateRating']) if (node[key]) score += 5;
  if (types.some(type => ['product', 'softwareapplication', 'mobileapplication', 'webapplication'].includes(type))) score += 20;
  if (types.some(type => ['localbusiness', 'professionalservice'].includes(type))) score += 15;
  if (types.some(type => ['organization', 'corporation'].includes(type))) score += 10;

  const name = textValue(node.name ?? node.legalName);
  const url = textValue(node.url) || textValue(node['@id']);
  const signals: string[] = [];
  if (context) {
    const urlHost = hostname(textValue(node.url));
    const idHost = hostname(textValue(node['@id']));
    if (urlHost && urlHost === context.siteHost) {
      score += 80;
      signals.push('site URL');
    } else if (urlHost && context.siteHost) {
      score -= 35;
    }
    if (idHost && idHost === context.siteHost) {
      score += 40;
      signals.push('schema ID');
    }
    const nameMatch = namesMatch(name, context.nameSignals);
    if (nameMatch === 'exact') {
      score += 60;
      signals.push('site name');
    } else if (nameMatch === 'partial') {
      score += 35;
      signals.push('page title');
    }
  }
  return { node, score, name, type: nodeTypes(node).join(' / ') || 'Entity', url, signals };
}

function relationIds(node: JsonLdNode): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const [property, label] of [['publisher', 'Publisher'], ['parentOrganization', 'Parent organisation'], ['brand', 'Brand'], ['provider', 'Provider']] as const) {
    for (const value of arrayValue(node[property])) {
      if (!value || typeof value !== 'object') continue;
      const id = textValue((value as JsonLdNode)['@id']);
      if (id) relationships.set(id, label);
    }
  }
  return relationships;
}

function numeric(value: unknown): number | null {
  const text = textValue(value);
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function parseEntityDiscovery(html: string, input: { siteName: string; siteUrl: string }): EntityDiscoveryResult {
  const extractedNodes = extractJsonLd(html);
  const nodes = mergeJsonLdNodes(extractedNodes);
  const schemaTypes = [...new Set(extractedNodes.flatMap(nodeTypes))];
  const pageTitle = attr(html, [/<title[^>]*>([\s\S]*?)<\/title>/i]);
  const canonicalUrl = canonical(html);
  const siteHost = hostname(canonicalUrl) || hostname(input.siteUrl);
  const nameSignals = [meta(html, 'og:site_name'), pageTitle, input.siteName];
  const ranked = nodes
    .filter(node => nodeTypes(node).some(type => IDENTITY_TYPES.has(type.toLowerCase())))
    .map(node => candidateScore(node, { siteHost, nameSignals }))
    .sort((a, b) => b.score - a.score);
  const candidate = ranked[0]?.node;
  const types = candidate ? nodeTypes(candidate) : [];
  const address = addressParts(candidate?.address);
  const sameAs = arrayValue(candidate?.sameAs).map(textValue).filter(Boolean);
  const identifiers: Record<string, string> = {};
  const listings: DiscoveredListing[] = [];

  for (const url of sameAs) {
    let key = identifierKey(url); let suffix = 2;
    while (identifiers[key]) key = `${identifierKey(url)}_${suffix++}`;
    identifiers[key] = url;
    const provider = listingProvider(url);
    if (provider) listings.push({ provider, url, status: 'needs_review' });
  }

  for (const identifier of arrayValue(candidate?.identifier)) {
    if (!identifier || typeof identifier !== 'object') continue;
    const row = identifier as Record<string, unknown>;
    const key = textValue(row.propertyID ?? row.name).toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const value = textValue(row.value ?? row.url);
    if (key && value && !identifiers[key]) identifiers[key] = value;
  }

  const rating = candidate?.aggregateRating && typeof candidate.aggregateRating === 'object'
    ? candidate.aggregateRating as Record<string, unknown> : {};
  const primaryUrl = textValue(candidate?.url) || canonicalUrl || input.siteUrl;
  const name = textValue(candidate?.name ?? candidate?.legalName) || meta(html, 'og:site_name')
    || pageTitle || input.siteName;
  const locale = textValue(candidate?.inLanguage).replace('_', '-') || localeFromHtml(html) || 'en';
  const market = address.market || textValue(candidate?.areaServed);
  const knowledge: Record<string, unknown> = {};
  const description = textValue(candidate?.description) || meta(html, 'description');
  const legalName = textValue(candidate?.legalName);
  const logoUrl = textValue(candidate?.logo) || meta(html, 'og:image');
  if (description) knowledge.description = description;
  if (legalName) knowledge.legal_name = legalName;
  if (logoUrl) knowledge.logo_url = logoUrl;

  const data: EntityDiscoveryData = {
    name,
    market,
    locale,
    entity_type: schemaType(types, !!address.formatted),
    primary_url: primaryUrl,
    address: address.formatted,
    phone: textValue(candidate?.telephone),
    identifiers,
    listings,
    knowledge,
    review_rating: numeric(rating.ratingValue),
    review_count: numeric(rating.reviewCount ?? rating.ratingCount),
  };
  const foundFields = Object.entries(data)
    .filter(([, value]) => Array.isArray(value) ? value.length : value && (typeof value !== 'object' || Object.keys(value).length))
    .map(([field]) => field);
  const sources = candidate ? [`${types.join(' / ') || 'Entity'} JSON-LD`, 'Page metadata'] : ['Page metadata'];
  const warnings: string[] = [];
  if (!extractedNodes.length) warnings.push('No valid JSON-LD was found. Basic page metadata was used instead.');
  else if (!candidate) warnings.push('Structured data was found, but it did not contain a clear organization, location, person or product record.');
  if (!address.formatted) warnings.push('No public address was discovered. Add it only if this entity has a customer-facing location.');
  if (!sameAs.length) warnings.push('No sameAs profiles or public listing links were discovered.');

  const related = candidate ? relationIds(candidate) : new Map<string, string>();
  const candidates: EntityDiscoveryResult['selection']['candidates'] = [];
  const seenIdentities = new Set<string>();
  for (const row of ranked) {
    const candidateName = row.name || row.type;
    const identityKey = `${identityText(candidateName)}|${hostname(row.url) || row.url}`;
    if (seenIdentities.has(identityKey)) continue;
    seenIdentities.add(identityKey);
    candidates.push({
      name: candidateName,
      type: row.type,
      url: row.url,
      selected: row.node === candidate,
      ...(related.get(textValue(row.node['@id'])) ? { relationship: related.get(textValue(row.node['@id'])) } : {}),
    });
    if (candidates.length === 8) break;
  }
  const selected = ranked[0];
  const matchedBy = selected?.signals.includes('site URL') && selected.signals.some(signal => signal === 'site name' || signal === 'page title')
    ? `its URL and name match ${siteHost}`
    : selected?.signals.includes('site URL') || selected?.signals.includes('schema ID')
      ? `its structured-data URL matches ${siteHost}`
      : selected?.signals.includes('site name') || selected?.signals.includes('page title')
        ? 'its name matches the selected site'
        : 'it is the clearest identity record in the page structured data';
  const selection = candidate ? {
    selected_name: name,
    selected_type: types.join(' / ') || 'Entity',
    reason: `Selected ${name} because ${matchedBy}.`,
    candidates,
  } : {
    selected_name: name,
    selected_type: 'Page metadata',
    reason: 'No suitable JSON-LD identity was found, so page metadata was used.',
    candidates,
  };

  return {
    source_url: input.siteUrl,
    discovered_at: new Date().toISOString(),
    schema_types: schemaTypes,
    sources,
    found_fields: foundFields,
    warnings,
    selection,
    data,
  };
}

export function siteHomepage(site: Site): string {
  const raw = site.domain.trim().replace(/^sc-domain:/i, '');
  const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  parsed.hash = ''; parsed.search = '';
  if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/';
  return parsed.toString();
}

export async function discoverEntityFromSite(site: Site): Promise<EntityDiscoveryResult> {
  const url = siteHomepage(site);
  const response = await safeFetch(url, {
    headers: { 'User-Agent': 'OrganicCommandEntityDiscovery/1.0', Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  }, { label: 'Entity discovery URL' });
  if (!response.ok) throw new Error(`The website returned HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !/html|xhtml/i.test(contentType)) throw new Error('The website homepage did not return HTML.');
  const html = await readResponseText(response, 2_000_000, 'Entity discovery page');
  return parseEntityDiscovery(html, { siteName: site.name, siteUrl: response.url || url });
}
