import { safeFetch, readResponseText, readResponseJson } from '../security/outbound-url.js';
import { elements, attr, nodeText, plainText, listingText } from './public-html.js';
import type { ListingDraft } from './aso.js';
const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export interface StoreApp {
  id: string;
  name: string;
  publisher: string;
  url: string;
  platform: 'apple' | 'google';
}
const cache = new Map<string, { at: number; value: unknown }>();
const calls: number[] = [];
async function cached<T>(key: string, work: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.value as T;
  while (calls.length && calls[0] < Date.now() - 60_000) calls.shift();
  if (calls.length >= 15) throw bad('Store lookup limit reached. Try again in a minute.', 429);
  calls.push(Date.now());
  const value = await work();
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return value;
}
function params(platform: unknown, country: unknown, language: unknown) {
  if (platform !== 'apple' && platform !== 'google') throw bad('Choose Apple or Google Play.');
  if (typeof country !== 'string' || !/^[a-z]{2}$/i.test(country))
    throw bad('Use a two-letter storefront country.');
  if (typeof language !== 'string' || !/^[a-z]{2,3}(?:-[a-z]{2})?$/i.test(language))
    throw bad('Use a language such as en or en-GB.');
  return { platform: platform as 'apple' | 'google', country: country.toUpperCase(), language };
}
async function response(url: string) {
  const res = await safeFetch(
    url,
    {
      signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'text/html,application/json', 'User-Agent': 'seo-website-indexer/1.0' },
    },
    { maxRedirects: 3 },
  );
  if (!res.ok)
    throw bad(`Store request returned HTTP ${res.status}. Try another storefront or retry later.`, 502);
  return res;
}
function appleApp(r: Record<string, unknown>): StoreApp {
  return {
    id: String(r.trackId),
    name: String(r.trackName ?? ''),
    publisher: String(r.artistName ?? ''),
    url: `https://apps.apple.com/app/id${r.trackId}`,
    platform: 'apple',
  };
}
export function parsePlaySearch(html: string): StoreApp[] {
  const found = new Map<string, StoreApp>();
  for (const node of elements(html)) {
    if (node.tagName !== 'a') continue;
    const href = attr(node, 'href');
    if (!href.startsWith('/store/apps/details?')) continue;
    const id = new URL(href, 'https://play.google.com').searchParams.get('id');
    if (!id || !/^[\w.]+$/.test(id) || found.has(id)) continue;
    const descendants = elements(node);
    const title = descendants.find((n) => attr(n, 'class').split(/\s+/).includes('DdYX5'));
    const publisher = descendants.find((n) => attr(n, 'class').split(/\s+/).includes('wMUdtb'));
    found.set(id, {
      id,
      name: attr(node, 'aria-label') || (title ? nodeText(title) : nodeText(node)) || id,
      publisher: publisher ? nodeText(publisher) : 'Google Play',
      url: `https://play.google.com/store/apps/details?id=${encodeURIComponent(id)}`,
      platform: 'google',
    });
    if (found.size >= 10) break;
  }
  return [...found.values()];
}
export async function searchStore(
  platform: unknown,
  query: unknown,
  country: unknown = 'GB',
  language: unknown = 'en',
) {
  const p = params(platform, country, language);
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 150)
    throw bad('Search with 2–150 characters.');
  return cached(JSON.stringify(['search', p, query]), async () => {
    if (p.platform === 'apple') {
      const data = await readResponseJson<{ results?: Array<Record<string, unknown>> }>(
        await response(
          `https://itunes.apple.com/search?${new URLSearchParams({ term: query.trim(), entity: 'software', country: p.country, limit: '10' })}`,
        ),
        2_000_000,
        'Apple search',
      );
      return (data.results ?? [])
        .filter((r) => typeof r.trackId === 'number' && typeof r.trackName === 'string')
        .map(appleApp);
    }
    const html = await readResponseText(
      await response(
        `https://play.google.com/store/search?${new URLSearchParams({ q: query.trim(), c: 'apps', hl: p.language, gl: p.country })}`,
      ),
      5_000_000,
      'Google Play search',
    );
    const apps = parsePlaySearch(html);
    if (!apps.length)
      throw bad(
        'Google Play returned no readable app listings. Try a more specific name or another storefront.',
        502,
      );
    return apps;
  });
}
export function parsePlayListing(html: string) {
  const nodes = elements(html);
  let app: Record<string, unknown> | undefined;
  for (const node of nodes) {
    if (node.tagName === 'script' && attr(node, 'type') === 'application/ld+json') {
      try {
        const value = JSON.parse(nodeText(node));
        const rows = Array.isArray(value)
          ? value
          : [value, ...(Array.isArray(value['@graph']) ? value['@graph'] : [])];
        app = rows.find((r) => r && ['SoftwareApplication', 'MobileApplication'].includes(r['@type']));
        if (app) break;
      } catch {
        /* malformed structured data cannot become an invented listing */
      }
    }
  }
  if (!app || typeof app.name !== 'string' || typeof app.description !== 'string')
    throw bad(
      'Google Play did not return readable listing metadata. The page may be unavailable or its format may have changed.',
      502,
    );
  const og = nodes.find((n) => n.tagName === 'meta' && attr(n, 'property') === 'og:description');
  const short = og ? plainText(attr(og, 'content')) : '';
  const full = nodes.find((n) => attr(n, 'data-g-id') === 'description');
  return {
    name: plainText(app.name),
    description: full ? listingText(full) : plainText(app.description),
    descriptionComplete: !!full,
    subtitle: short.length <= 80 ? short : '',
    publisher:
      typeof app.author === 'object' && app.author
        ? String((app.author as { name?: string }).name ?? '')
        : '',
  };
}
export async function fetchStoreListing(
  platform: unknown,
  id: unknown,
  country: unknown = 'GB',
  language: unknown = 'en',
) {
  const p = params(platform, country, language);
  if (typeof id !== 'string' || !(p.platform === 'apple' ? /^\d{1,20}$/ : /^[\w.]{3,250}$/).test(id))
    throw bad('Invalid app identifier.');
  return cached(JSON.stringify(['listing', p, id]), async () => {
    let app: StoreApp;
    let description = '';
    let subtitle = '';
    let complete = true;
    let fetchedLanguage = p.language;
    if (p.platform === 'apple') {
      const data = await readResponseJson<{ results?: Array<Record<string, unknown>> }>(
        await response(
          `https://itunes.apple.com/lookup?${new URLSearchParams({ id, entity: 'software', country: p.country })}`,
        ),
        2_000_000,
        'Apple listing',
      );
      const row = data.results?.find((r) => String(r.trackId) === id);
      if (!row) throw bad('App not found in this storefront.', 404);
      app = appleApp(row);
      description = String(row.description ?? '');
      fetchedLanguage = 'en';
    } else {
      const url = `https://play.google.com/store/apps/details?${new URLSearchParams({ id, hl: p.language, gl: p.country })}`;
      const row = parsePlayListing(
        await readResponseText(await response(url), 5_000_000, 'Google Play listing'),
      );
      app = { id, name: row.name, publisher: row.publisher, url, platform: 'google' };
      description = row.descriptionComplete ? row.description : '';
      subtitle = row.subtitle;
      complete = row.descriptionComplete;
    }
    const draft: ListingDraft = {
      platform: p.platform,
      locale: `${fetchedLanguage.split('-')[0]}-${p.country}`,
      name: app.name,
      subtitle,
      description,
      keywords: '',
      promotional_text: '',
      target_terms: [],
      source_url: app.url,
      source_id: id,
      fetched_at: new Date().toISOString(),
    };
    return {
      app,
      draft,
      unavailable:
        p.platform === 'apple'
          ? ['subtitle', 'keywords', 'promotional_text']
          : [...(!subtitle ? ['subtitle'] : []), ...(!complete ? ['full description'] : [])],
      note:
        p.platform === 'apple'
          ? 'Apple lookup returns public listing text; keyword and promotional fields are not exposed. Confirm the language of the returned description.'
          : 'Google Play metadata is read from the public storefront; unavailable fields are left empty.',
    };
  });
}
