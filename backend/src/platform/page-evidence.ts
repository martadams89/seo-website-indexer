import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { createHash } from 'node:crypto';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
export type Finding = {
  code: string;
  url: string;
  area: 'SEO' | 'GEO' | 'Accessibility';
  severity: 'high' | 'medium' | 'low';
  title: string;
  evidence: string;
  fix: string;
  source: string;
};
export interface PageEvidence {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  description: string;
  canonical: string;
  words: number;
  internalLinks: number;
  externalLinks: number;
  schemas: number;
  linksTruncated: boolean;
  signals: Record<string, number | string | string[]>;
  h1: string[];
  language: string;
  viewport: boolean;
  robots: string;
  schemaTypes: string[];
  schemaErrors: number;
  images: number;
  missingAlt: number;
  contentHash: string;
  links: Array<{ url: string; anchor: string; rel: string[] }>;
  headings: string[];
  hasAuthor: boolean;
  hasDate: boolean;
  hasSocialPreview: boolean;
  html: boolean;
}
export const SEO_SOURCE = 'https://developers.google.com/search/docs/fundamentals/seo-starter-guide';
export const GEO_SOURCE = 'https://developers.google.com/search/docs/appearance/ai-features';
export const normalizeUrl = (value: string, base?: string): string => {
  try {
    if (value.length > 4096) return '';
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
};
export const host = (value: string): string => {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};
export function parsePage(input: {
  url: string;
  finalUrl?: string;
  status: number;
  html: string;
  contentType?: string;
  robots?: string;
  maxLinks?: number;
}): PageEvidence {
  const root = parse(input.html);
  const elements: Element[] = [];
  const pending: Node[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if ('tagName' in node) elements.push(node);
    if ('childNodes' in node && !('tagName' in node && ['template', 'noscript'].includes(node.tagName)))
      for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]);
  }
  const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value ?? '';
  const text = (node: Node): string => {
    const parts: string[] = [];
    const stack: Node[] = [node];
    while (stack.length) {
      const current = stack.pop()!;
      if (current.nodeName === '#text') {
        parts.push((current as DefaultTreeAdapterMap['textNode']).value);
        continue;
      }
      if ('tagName' in current && ['script', 'style', 'template', 'noscript'].includes(current.tagName))
        continue;
      if ('childNodes' in current)
        for (let i = current.childNodes.length - 1; i >= 0; i--) stack.push(current.childNodes[i]);
    }
    return parts.join(' ');
  };
  const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
  const all = (tag: string) => elements.filter((el) => el.tagName === tag);
  const meta = (name: string) =>
    all('meta')
      .filter((el) => (attr(el, 'name') || attr(el, 'property')).toLowerCase() === name)
      .map((el) => attr(el, 'content'))
      .join(', ');
  const finalUrl = input.finalUrl || input.url;
  const baseHref = all('base')[0];
  const base = baseHref ? normalizeUrl(attr(baseHref, 'href'), finalUrl) || finalUrl : finalUrl;
  const anchors = all('a');
  const linkLimit = Math.min(Math.max(input.maxLinks ?? 5000, 1), 5000);
  const links = anchors
    .slice(0, linkLimit)
    .flatMap((el) => {
      const raw = attr(el, 'href');
      const url = raw ? normalizeUrl(raw, base) : '';
      return url
        ? [
            {
              url,
              anchor: clean(text(el)).slice(0, 300),
              rel: attr(el, 'rel').toLowerCase().split(/\s+/).filter(Boolean),
            },
          ]
        : [];
    })
    .slice(0, 5000);
  const blocks = all('script').filter((el) => attr(el, 'type').toLowerCase() === 'application/ld+json');
  let schemaErrors = 0;
  const schemaTypes = new Set<string>();
  let hasAuthor = !!meta('author');
  let hasDate = !!meta('article:published_time');
  const visitJson = (value: unknown, depth = 0) => {
    if (depth > 30 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v) => visitJson(v, depth + 1));
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const type of [obj['@type']].flat()) if (typeof type === 'string') schemaTypes.add(type);
    if (obj.author) hasAuthor = true;
    if (obj.datePublished || obj.dateModified) hasDate = true;
    Object.values(obj).forEach((v) => visitJson(v, depth + 1));
  };
  for (const block of blocks) {
    try {
      visitJson(
        JSON.parse(
          block.childNodes
            .map((n) => (n.nodeName === '#text' ? (n as DefaultTreeAdapterMap['textNode']).value : ''))
            .join(''),
        ),
      );
    } catch {
      schemaErrors++;
    }
  }
  const body = all('main')[0] ?? all('body')[0] ?? root;
  const content = clean(text(body));
  const canonical = all('link').find((el) =>
    attr(el, 'rel').toLowerCase().split(/\s+/).includes('canonical'),
  );
  const images = all('img');
  const signals: PageEvidence['signals'] = {};
  signals.titleCount = all('title').length;
  signals.descriptionCount = all('meta').filter(
    (el) => attr(el, 'name').toLowerCase() === 'description',
  ).length;
  signals.canonicals = [
    ...new Set(
      all('link')
        .filter((el) => attr(el, 'rel').toLowerCase().split(/\s+/).includes('canonical'))
        .map((el) => normalizeUrl(attr(el, 'href'), base))
        .filter(Boolean),
    ),
  ];
  signals.mixedResources = finalUrl.startsWith('https:')
    ? elements
        .filter((el) => ['img', 'script', 'iframe', 'audio', 'video', 'source'].includes(el.tagName))
        .map((el) => attr(el, 'src'))
        .filter((value) => value.startsWith('http:'))
        .slice(0, 20)
    : [];
  signals.invalidHreflang = all('link').filter(
    (el) =>
      attr(el, 'hreflang') &&
      (!/^(?:x-default|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/i.test(attr(el, 'hreflang')) ||
        !normalizeUrl(attr(el, 'href'), base)),
  ).length;
  signals.headingJumps = elements
    .filter((el) => /^h[1-6]$/.test(el.tagName))
    .map((el) => Number(el.tagName[1]))
    .filter((level, index, levels) => index > 0 && level > levels[index - 1] + 1).length;
  signals.unnamedLinks = all('a').filter(
    (el) =>
      normalizeUrl(attr(el, 'href'), base) &&
      !clean(text(el)) &&
      !attr(el, 'aria-label') &&
      !attr(el, 'aria-labelledby') &&
      !el.childNodes.some((n) => 'tagName' in n && n.tagName === 'img' && attr(n, 'alt')),
  ).length;
  const ids = elements.map((el) => attr(el, 'id')).filter(Boolean);
  const seenIds = new Set<string>();
  const repeatedIds = new Set<string>();
  for (const id of ids) {
    if (seenIds.has(id)) repeatedIds.add(id);
    seenIds.add(id);
  }
  signals.duplicateIds = [...repeatedIds].slice(0, 20).map((id) => id.slice(0, 200));
  signals.metaRefresh = all('meta')
    .filter((el) => attr(el, 'http-equiv').toLowerCase() === 'refresh')
    .map((el) => attr(el, 'content'))
    .join(', ');
  signals.zoomRestricted = /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\.0)?(?:[,;\s]|$)/i.test(
    meta('viewport'),
  )
    ? 1
    : 0;
  signals.alternateUrls = all('link')
    .filter((el) => attr(el, 'hreflang'))
    .map((el) => normalizeUrl(attr(el, 'href'), base))
    .filter(Boolean);
  signals.genericAnchors = links.filter((link) =>
    /^(click here|here|read more|learn more)$/i.test(link.anchor),
  ).length;
  signals.invalidCanonical =
    canonical && (!attr(canonical, 'href').trim() || !normalizeUrl(attr(canonical, 'href'), base)) ? 1 : 0;
  signals.invalidSocialImage = meta('og:image') && !normalizeUrl(meta('og:image'), base) ? 1 : 0;
  return {
    linksTruncated: anchors.length > linkLimit,
    signals,
    url: input.url,
    finalUrl,
    status: input.status,
    title: clean(all('title').map(text).join(' ')).slice(0, 2000),
    description: clean(meta('description')).slice(0, 4000),
    canonical: canonical ? normalizeUrl(attr(canonical, 'href'), base) : '',
    words: content.split(/\s+/).filter(Boolean).length,
    internalLinks: links.filter((link) => host(link.url) === host(finalUrl)).length,
    externalLinks: links.filter((link) => host(link.url) !== host(finalUrl)).length,
    schemas: blocks.length,
    schemaTypes: [...schemaTypes].slice(0, 100).map((type) => type.slice(0, 200)),
    schemaErrors,
    images: images.length,
    missingAlt: images.filter((el) => !el.attrs.some((a) => a.name === 'alt')).length,
    h1: all('h1')
      .map((el) => clean(text(el)))
      .filter(Boolean),
    headings: elements.filter((el) => /^h[1-6]$/.test(el.tagName)).map((el) => clean(text(el))),
    language: attr(all('html')[0], 'lang'),
    viewport: /width\s*=\s*device-width/i.test(meta('viewport')),
    robots: [meta('robots'), meta('googlebot'), input.robots].filter(Boolean).join(', ').toLowerCase(),
    contentHash: createHash('sha256').update(content).digest('hex'),
    links,
    hasAuthor,
    hasDate,
    hasSocialPreview: !!meta('og:title') && !!meta('og:image'),
    html: !input.contentType || /(?:text\/html|application\/xhtml\+xml)/i.test(input.contentType),
  };
}
export function pageFindings(page: PageEvidence): Finding[] {
  const findings: Finding[] = [];
  const add = (
    code: string,
    area: Finding['area'],
    severity: Finding['severity'],
    title: string,
    evidence: string,
    fix: string,
    source = SEO_SOURCE,
  ) => findings.push({ code, url: page.url, area, severity, title, evidence, fix, source });
  if (page.status >= 400) {
    add(
      'http-error',
      'SEO',
      'high',
      'Page returned an HTTP error',
      `HTTP ${page.status}`,
      'Restore this page, redirect it to a relevant replacement, or remove the URL from the sitemap.',
    );
    return findings;
  }
  if (!page.html) {
    add(
      'non-html',
      'SEO',
      'low',
      'HTML checks skipped',
      'The response is not HTML.',
      'Review whether this resource belongs in the HTML page inventory.',
    );
    return findings;
  }
  if (page.url !== page.finalUrl)
    add(
      'redirect',
      'SEO',
      'low',
      'Inventory URL redirects',
      page.finalUrl,
      'Link to the preferred destination directly and keep sitemap URLs current.',
    );
  if (/(?:^|[\s,:])(?:noindex|none)(?:$|[\s,;])/.test(page.robots))
    add(
      'noindex',
      'SEO',
      'high',
      'Indexing is restricted',
      page.robots,
      'Confirm that exclusion is intentional. Remove noindex only if this page should appear in search.',
    );
  if (/(?:^|[\s,:])nosnippet(?:$|[\s,;])|max-snippet\s*:\s*0(?:$|[\s,;])/.test(page.robots))
    add(
      'snippet-restricted',
      'GEO',
      'medium',
      'Search snippets are restricted',
      page.robots,
      'Review snippet controls against your publishing policy. Google AI search eligibility depends on snippet eligibility.',
      GEO_SOURCE,
    );
  if (!page.title)
    add(
      'missing-title',
      'SEO',
      'medium',
      'Missing page title',
      'No non-empty title element found.',
      'Write an accurate, distinctive title for this page.',
    );
  if (!page.description)
    add(
      'missing-description',
      'SEO',
      'low',
      'Missing meta description',
      'No description metadata found.',
      'Summarise this page for readers. Search engines may choose another snippet.',
    );
  if (!page.canonical)
    add(
      'missing-canonical',
      'SEO',
      'low',
      'No valid canonical declared',
      'No usable HTTP(S) canonical found.',
      'Review duplicates and declare the preferred URL where appropriate; a canonical is a hint.',
    );
  else if (page.canonical !== normalizeUrl(page.finalUrl))
    add(
      'canonical-other',
      'SEO',
      'medium',
      'Canonical points to another URL',
      page.canonical,
      'Confirm the target is the intended canonical and that internal links and sitemaps agree.',
    );
  if (!page.h1.length)
    add(
      'missing-heading',
      'Accessibility',
      'low',
      'No main heading found',
      'No non-empty H1 in the response HTML.',
      'Give the page a descriptive main heading that helps readers orient themselves.',
    );
  if (!page.viewport)
    add(
      'viewport',
      'Accessibility',
      'medium',
      'Responsive viewport missing',
      'No width=device-width viewport metadata.',
      'Add a responsive viewport and test the page on a narrow screen.',
    );
  if (!page.language)
    add(
      'language',
      'Accessibility',
      'low',
      'Document language missing',
      'The HTML lang attribute is empty.',
      'Set the language used by the page for assistive technology.',
    );
  if (page.missingAlt)
    add(
      'image-alt',
      'Accessibility',
      'low',
      'Images lack an alt attribute',
      `${page.missingAlt} of ${page.images} images. Empty alt attributes are accepted for decorative images.`,
      'Describe informative images; use alt="" for purely decorative images.',
    );
  if (page.schemaErrors)
    add(
      'invalid-jsonld',
      'SEO',
      'medium',
      'Structured data is invalid JSON',
      `${page.schemaErrors} of ${page.schemas} blocks could not be parsed.`,
      'Correct the JSON syntax, then validate supported types in the Rich Results Test.',
    );
  if (
    page.schemaTypes.some((t) => /^(Article|NewsArticle|BlogPosting)$/.test(t)) &&
    (!page.hasAuthor || !page.hasDate)
  )
    add(
      'article-provenance',
      'GEO',
      'low',
      'Review article attribution',
      `Author metadata: ${page.hasAuthor ? 'present' : 'not found'}; date metadata: ${page.hasDate ? 'present' : 'not found'}.`,
      'Check that readers can identify who wrote this article and when. Add truthful metadata consistent with visible content; this is an editorial review, not a ranking requirement.',
      GEO_SOURCE,
    );
  if (!page.hasSocialPreview)
    add(
      'social-preview',
      'SEO',
      'low',
      'Review link sharing preview',
      'Open Graph title or image was not found.',
      'Add an accurate title and preview image if this page is shared on social platforms. This is not a ranking requirement.',
    );
  if (Number(page.signals.titleCount) > 1)
    add(
      'multiple-titles',
      'SEO',
      'medium',
      'Multiple title elements',
      `${page.signals.titleCount} title elements found.`,
      'Keep one descriptive title in the document head.',
    );
  if (Number(page.signals.descriptionCount) > 1)
    add(
      'multiple-descriptions',
      'SEO',
      'low',
      'Multiple description tags',
      `${page.signals.descriptionCount} description tags found.`,
      'Keep one accurate meta description for this page.',
    );
  if (Array.isArray(page.signals.canonicals) && page.signals.canonicals.length > 1)
    add(
      'conflicting-canonicals',
      'SEO',
      'high',
      'Conflicting canonical URLs',
      page.signals.canonicals.join(', '),
      'Choose a single preferred canonical. Remove contradictory declarations.',
    );
  if (Array.isArray(page.signals.mixedResources) && page.signals.mixedResources.length)
    add(
      'mixed-resources',
      'Accessibility',
      'medium',
      'Insecure embedded resources',
      page.signals.mixedResources.join(', '),
      'Serve these resources over HTTPS and verify they load on real devices.',
    );
  if (Number(page.signals.invalidHreflang))
    add(
      'invalid-hreflang',
      'SEO',
      'medium',
      'Review language alternates',
      `${page.signals.invalidHreflang} invalid language tags or destinations.`,
      'Use a valid language tag and an HTTP(S) alternate URL; verify each regional version.',
    );
  if (Number(page.signals.headingJumps))
    add(
      'heading-jumps',
      'Accessibility',
      'low',
      'Review heading hierarchy',
      `${page.signals.headingJumps} skipped heading levels.`,
      'Organise headings into a clear outline. This is a navigation review, not a ranking penalty.',
    );
  if (Number(page.signals.unnamedLinks))
    add(
      'unnamed-links',
      'Accessibility',
      'medium',
      'Links have no apparent accessible name',
      `${page.signals.unnamedLinks} links need review.`,
      'Use descriptive visible text, a meaningful linked-image alt attribute or an accessible label.',
    );
  if (Array.isArray(page.signals.duplicateIds) && page.signals.duplicateIds.length)
    add(
      'duplicate-ids',
      'Accessibility',
      'medium',
      'Duplicate element IDs',
      page.signals.duplicateIds.join(', '),
      'Give referenced elements unique IDs and update their labels and fragment links.',
    );
  if (page.signals.metaRefresh)
    add(
      'meta-refresh',
      'SEO',
      'low',
      'Page uses meta refresh',
      String(page.signals.metaRefresh),
      'Prefer an HTTP redirect for permanent moves. Review timed navigation for accessibility.',
    );
  if (Number(page.signals.zoomRestricted))
    add(
      'zoom-restricted',
      'Accessibility',
      'medium',
      'Mobile zoom is restricted',
      'The viewport disables or limits user scaling.',
      'Allow readers to zoom. Test at 200% text size without loss of content or controls.',
    );
  if (
    Array.isArray(page.signals.alternateUrls) &&
    page.signals.alternateUrls.length &&
    !page.signals.alternateUrls.includes(normalizeUrl(page.finalUrl))
  )
    add(
      'hreflang-self',
      'SEO',
      'low',
      'Language alternates omit this page',
      page.signals.alternateUrls.join(', '),
      'Include the current page in a complete reciprocal set of language alternates.',
    );
  if (Number(page.signals.genericAnchors))
    add(
      'generic-anchors',
      'Accessibility',
      'low',
      'Review generic link text',
      `${page.signals.genericAnchors} links use phrases such as click here or read more.`,
      'Use meaningful text when a link must make sense outside its surrounding paragraph. Review context before changing it.',
    );
  if (Number(page.signals.invalidCanonical))
    add(
      'invalid-canonical',
      'SEO',
      'medium',
      'Canonical declaration has an invalid destination',
      'Empty or non-HTTP(S) canonical href.',
      'Set a usable preferred URL, or remove the invalid declaration.',
    );
  if (Number(page.signals.invalidSocialImage))
    add(
      'invalid-social-image',
      'SEO',
      'low',
      'Sharing image URL is unusable',
      'Open Graph image does not resolve to an HTTP(S) URL.',
      'Use a reachable image URL and preview the shared link on the target platform.',
    );
  return findings;
}
export function inventoryFindings(pages: PageEvidence[]): Finding[] {
  const findings = pages.flatMap(pageFindings);
  for (const node of internalLinkGraph(pages)) {
    if (pages.length > 1 && new URL(node.url).pathname !== '/' && !node.inbound.length)
      findings.push({
        code: 'sample-unlinked',
        url: node.url,
        area: 'SEO',
        severity: 'low',
        title: 'No incoming links in this sample',
        evidence: `None of ${pages.length} sampled pages links to this URL.`,
        fix: 'Check the full site before calling this an orphan. Add relevant contextual internal links where they help readers.',
        source: SEO_SOURCE,
      });
  }
  const knownPages = new Map(pages.map((page) => [normalizeUrl(page.url), page]));
  for (const source of pages.filter((page) => page.html && page.status === 200)) {
    for (const targetUrl of new Set(
      source.links.filter((link) => host(link.url) === host(source.finalUrl)).map((link) => link.url),
    )) {
      const target = knownPages.get(targetUrl);
      if (!target) continue;
      if (target.finalUrl !== target.url && target.status === 200)
        findings.push({
          code: `redirected-internal:${targetUrl}`,
          url: source.url,
          area: 'SEO',
          severity: 'low',
          title: 'Internal link goes through a redirect',
          evidence: `${targetUrl} → ${target.finalUrl}`,
          fix: 'Update the link to the final destination if the move is intentional.',
          source: SEO_SOURCE,
        });
      if (/(?:^|[\s,:])(?:noindex|none)(?:$|[\s,;])/.test(target.robots))
        findings.push({
          code: `excluded-internal:${targetUrl}`,
          url: source.url,
          area: 'SEO',
          severity: 'low',
          title: 'Link points to a page excluded from indexing',
          evidence: `${targetUrl}: ${target.robots}`,
          fix: 'Confirm this is intentional. Useful links to noindex pages can be valid; do not remove them solely for this finding.',
          source: SEO_SOURCE,
        });
      if (target.status >= 400)
        findings.push({
          code: `broken-internal:${targetUrl}`,
          url: source.url,
          area: 'SEO',
          severity: 'medium',
          title: 'Internal link points to an error page',
          evidence: `${targetUrl} returned HTTP ${target.status}.`,
          fix: 'Repair the target or update this link to the relevant working page.',
          source: SEO_SOURCE,
        });
    }
  }
  for (const source of pages.filter((page) => page.html && page.status === 200))
    for (const targetUrl of Array.isArray(source.signals.alternateUrls) ? source.signals.alternateUrls : []) {
      const target = knownPages.get(targetUrl);
      if (
        target?.html &&
        target.status === 200 &&
        Array.isArray(target.signals.alternateUrls) &&
        !target.signals.alternateUrls.includes(normalizeUrl(source.finalUrl))
      )
        findings.push({
          code: `hreflang-return:${targetUrl}`,
          url: source.url,
          area: 'SEO',
          severity: 'medium',
          title: 'Sampled language alternate has no return declaration',
          evidence: targetUrl,
          fix: 'Check reciprocal hreflang declarations on both language versions.',
          source: SEO_SOURCE,
        });
    }
  for (const [field, code, title] of [
    ['title', 'duplicate-title', 'Shared page title'],
    ['description', 'duplicate-description', 'Shared meta description'],
    ['contentHash', 'duplicate-content', 'Identical extracted text'],
  ] as const) {
    const groups = new Map<string, PageEvidence[]>();
    for (const page of pages.filter((p) => p.html && p.status === 200)) {
      const value = page[field].trim().toLowerCase();
      if (!value || (field === 'contentHash' && page.words < 50)) continue;
      groups.set(value, [...(groups.get(value) ?? []), page]);
    }
    for (const group of groups.values())
      if (group.length > 1)
        for (const page of group)
          findings.push({
            code,
            url: page.url,
            area: 'SEO',
            severity: 'low',
            title,
            evidence: `Also observed on: ${group
              .filter((p) => p !== page)
              .slice(0, 5)
              .map((p) => p.url)
              .join(', ')}`,
            fix: 'Review whether these pages serve distinct needs. Make meaningful distinctions, or consolidate true duplicates; do not pad text merely to satisfy an audit.',
            source: SEO_SOURCE,
          });
  }
  return findings;
}

/** Unique source pages in this sample, not a whole-site authority score. */
export function internalLinkGraph(pages: PageEvidence[]) {
  const known = new Set(pages.map((page) => normalizeUrl(page.url)));
  return pages.map((page) => {
    const inbound = pages
      .filter(
        (source) =>
          source.url !== page.url &&
          source.links.some((link) => normalizeUrl(link.url) === normalizeUrl(page.url)),
      )
      .map((source) => source.url);
    const outbound = [
      ...new Set(page.links.filter((link) => host(link.url) === host(page.finalUrl)).map((link) => link.url)),
    ];
    return {
      url: page.url,
      inbound,
      outbound,
      uncheckedTargets: outbound.filter((url) => !known.has(normalizeUrl(url))),
    };
  });
}
