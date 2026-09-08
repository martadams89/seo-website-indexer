export type LabResult = { summary: string[]; output: string };
export const labTools: Array<{
  id: string;
  name: string;
  note: string;
  fields: Array<{ key: string; label: string; multiline?: boolean }>;
}> = [
  {
    id: 'snippet',
    name: 'Search snippet preview',
    note: 'An approximate text preview. Search engines choose their own titles and snippets; character count is not a ranking factor.',
    fields: [
      { key: 'url', label: 'Page URL' },
      { key: 'title', label: 'Title' },
      { key: 'description', label: 'Description', multiline: true },
    ],
  },
  {
    id: 'campaign',
    name: 'Campaign URL builder',
    note: 'Build a campaign URL while preserving existing parameters. Use campaign tags for external campaigns, not internal site links.',
    fields: [
      { key: 'url', label: 'Destination URL' },
      { key: 'source', label: 'Campaign source' },
      { key: 'medium', label: 'Campaign medium' },
      { key: 'campaign', label: 'Campaign name' },
    ],
  },
  {
    id: 'schema',
    name: 'Structured-data inspector',
    note: 'Checks JSON syntax and declared types only. Use the appropriate rich-results validator to assess eligibility.',
    fields: [{ key: 'json', label: 'JSON-LD document', multiline: true }],
  },
  {
    id: 'sitemap',
    name: 'Sitemap inspector',
    note: 'Inspect sitemap XML locally. No URLs are fetched. This is a bounded document check, not proof of indexing.',
    fields: [{ key: 'xml', label: 'Sitemap XML', multiline: true }],
  },
  {
    id: 'hreflang',
    name: 'Language-alternate builder',
    note: 'Enter one language tag and absolute URL per line, separated by a space. Include the current page and reciprocal declarations on each version.',
    fields: [
      {
        key: 'alternates',
        label: 'Language alternates (for example en-GB https://example.com/uk)',
        multiline: true,
      },
    ],
  },
  {
    id: 'robots',
    name: 'Robots declaration explorer',
    note: 'Inspect the declarations in a pasted robots.txt. This explorer does not simulate crawler decisions or override each provider\u2019s documented behaviour.',
    fields: [{ key: 'robots', label: 'robots.txt contents', multiline: true }],
  },
  {
    id: 'directives',
    name: 'Robots-meta builder',
    note: 'Prepare a robots meta tag from explicit index/follow and snippet choices. Exclusions may be intentional; do not change them merely for an audit.',
    fields: [
      { key: 'index', label: 'Index policy: index or noindex' },
      { key: 'follow', label: 'Link policy: follow or nofollow' },
      { key: 'snippet', label: 'Snippet policy: allow or nosnippet' },
    ],
  },
  {
    id: 'faq',
    name: 'FAQ markup builder',
    note: 'Use only questions and answers that are visible on the page. Markup does not guarantee a rich result or AI citation.',
    fields: [{ key: 'pairs', label: 'Question | Answer (one pair per line)', multiline: true }],
  },
  {
    id: 'redirects',
    name: 'Redirect-map inspector',
    note: 'Enter source URL | target URL on each line. Checks the supplied map for loops and chains; it does not fetch live redirects.',
    fields: [{ key: 'mapping', label: 'Redirect map', multiline: true }],
  },
  {
    id: 'conversion',
    name: 'Conversion comparison',
    note: 'Compare observed conversion rates with individual 95% Wilson intervals. This is not a significance test, winner declaration or causal claim.',
    fields: [
      { key: 'a_visits', label: 'Variant A visitors' },
      { key: 'a_conversions', label: 'Variant A conversions' },
      { key: 'b_visits', label: 'Variant B visitors' },
      { key: 'b_conversions', label: 'Variant B conversions' },
    ],
  },
];
const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const webUrl = (text: string) => {
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP(S) URL without embedded credentials.');
  return url;
};
export function runLab(tool: string, values: Record<string, string>): LabResult {
  if (Object.values(values).some((v) => v.length > 200000))
    throw new Error('Keep each input below 200,000 characters.');
  if (tool === 'snippet') {
    const url = webUrl(values.url || 'https://example.com/');
    return {
      summary: [
        `Title: ${Array.from(values.title || '').length} characters`,
        `Description: ${Array.from(values.description || '').length} characters`,
      ],
      output: `<title>${escapeHtml(values.title || '')}</title>\n<meta name="description" content="${escapeHtml(values.description || '')}">\n<!-- Preview URL: ${escapeHtml(url.href)} -->`,
    };
  }
  if (tool === 'campaign') {
    const url = webUrl(values.url);
    for (const key of ['source', 'medium', 'campaign']) {
      if (!values[key]?.trim()) throw new Error(`Enter a campaign ${key}.`);
      url.searchParams.set(`utm_${key}`, values[key].trim());
    }
    return { summary: ['Existing non-campaign parameters and fragment are preserved.'], output: url.href };
  }
  if (tool === 'schema') {
    const value = JSON.parse(values.json || '');
    if (!value || typeof value !== 'object') throw new Error('JSON-LD must be an object or array.');
    const types = new Set<string>();
    let objects = 0;
    const visit = (v: unknown, depth = 0) => {
      if (depth > 30) throw new Error('Document nesting exceeds 30 levels.');
      if (!v || typeof v !== 'object') return;
      if (++objects > 10000) throw new Error('Document is too large to inspect.');
      if (Array.isArray(v)) {
        v.forEach((x) => visit(x, depth + 1));
        return;
      }
      const record = v as Record<string, unknown>;
      for (const type of [record['@type']].flat()) if (typeof type === 'string') types.add(type);
      Object.values(record).forEach((x) => visit(x, depth + 1));
    };
    visit(value);
    return {
      summary: [
        'JSON syntax is valid.',
        `Declared types: ${[...types].join(', ') || 'none'}`,
        'Syntax validity does not imply schema validity or rich-result eligibility.',
      ],
      output: JSON.stringify(value, null, 2),
    };
  }
  if (tool === 'sitemap') {
    if (/<!DOCTYPE|<!ENTITY/i.test(values.xml || ''))
      throw new Error('DTD and entity declarations are not accepted.');
    const doc = new DOMParser().parseFromString(values.xml || '', 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Malformed XML.');
    if (!['urlset', 'sitemapindex'].includes(doc.documentElement.localName))
      throw new Error('Expected urlset or sitemapindex.');
    const raw = [...doc.getElementsByTagName('loc')].map((el) => el.textContent?.trim() || '');
    const valid = raw.map((v) => webUrl(v).href);
    const duplicates = valid.length - new Set(valid).size;
    return {
      summary: [
        `${valid.length} location entries`,
        `${duplicates} duplicate locations`,
        valid.length > 50000 ? 'Exceeds the 50,000 entry limit.' : 'Within the 50,000 entry limit.',
      ],
      output: valid.join('\n'),
    };
  }
  if (tool === 'hreflang') {
    const seen = new Set<string>();
    const lines = (values.alternates || '')
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        const [locale, ...rest] = line.trim().split(/\s+/);
        if (!/^(?:x-default|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/i.test(locale))
          throw new Error(`Invalid language tag: ${locale}`);
        if (seen.has(locale.toLowerCase())) throw new Error(`Duplicate language tag: ${locale}`);
        seen.add(locale.toLowerCase());
        return `<link rel="alternate" hreflang="${escapeHtml(locale)}" href="${escapeHtml(webUrl(rest.join(' ')).href)}">`;
      });
    if (!lines.length) throw new Error('Add at least one alternate.');
    return {
      summary: [
        `${lines.length} alternate declarations prepared.`,
        'Language-tag syntax checked; verify that each URL serves the stated language.',
      ],
      output: lines.join('\n'),
    };
  }
  if (tool === 'robots') {
    const agents = new Set<string>();
    let disallows = 0;
    let allows = 0;
    const unknown: string[] = [];
    const cleaned = (values.robots || '')
      .split('\n')
      .map((l) => l.split('#')[0].trim())
      .filter(Boolean);
    for (const line of cleaned) {
      const colon = line.indexOf(':');
      if (colon < 0) {
        unknown.push(line);
        continue;
      }
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === 'user-agent') agents.add(value);
      else if (name === 'disallow' && value) disallows++;
      else if (name === 'allow') allows++;
      else if (!['sitemap', 'crawl-delay', 'disallow'].includes(name)) unknown.push(line);
    }
    return {
      summary: [
        `User agents: ${[...agents].join(', ') || 'none'}`,
        `${allows} allow and ${disallows} non-empty disallow declarations`,
        `${unknown.length} unknown or malformed lines`,
        'Robots access rules do not themselves prevent a URL from being indexed.',
      ],
      output: cleaned.join('\n'),
    };
  }
  if (tool === 'directives') {
    const index = (values.index || 'index').trim().toLowerCase();
    const follow = (values.follow || 'follow').trim().toLowerCase();
    const snippet = (values.snippet || 'allow').trim().toLowerCase();
    if (
      !['index', 'noindex'].includes(index) ||
      !['follow', 'nofollow'].includes(follow) ||
      !['allow', 'nosnippet'].includes(snippet)
    )
      throw new Error('Use the choices shown in the field labels.');
    const directives = [index, follow, ...(snippet === 'nosnippet' ? [snippet] : [])];
    return {
      summary: [
        index === 'noindex' ? 'Page exclusion requested.' : 'Indexing permitted, not guaranteed.',
        snippet === 'nosnippet'
          ? 'Snippets are restricted. Review AI search eligibility implications.'
          : 'Snippets are allowed.',
      ],
      output: `<meta name="robots" content="${directives.join(', ')}">`,
    };
  }
  if (tool === 'faq') {
    const pairs = (values.pairs || '')
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        const split = line.indexOf('|');
        if (split < 1 || !line.slice(split + 1).trim())
          throw new Error('Each line needs a question, a | separator and an answer.');
        return {
          '@type': 'Question',
          name: line.slice(0, split).trim(),
          acceptedAnswer: { '@type': 'Answer', text: line.slice(split + 1).trim() },
        };
      });
    if (!pairs.length) throw new Error('Add at least one question and answer.');
    return {
      summary: [
        `${pairs.length} supplied questions prepared.`,
        'Verify that all answers match visible page content.',
      ],
      output: JSON.stringify(
        { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: pairs },
        null,
        2,
      ),
    };
  }
  if (tool === 'redirects') {
    const map = new Map<string, string>();
    for (const line of (values.mapping || '').split('\n').filter((l) => l.trim())) {
      const parts = line.split('|');
      if (parts.length !== 2) throw new Error('Use source URL | target URL.');
      const source = webUrl(parts[0].trim()).href;
      const target = webUrl(parts[1].trim()).href;
      if (map.has(source)) throw new Error(`Duplicate source: ${source}`);
      map.set(source, target);
    }
    if (!map.size) throw new Error('Add at least one redirect.');
    const issues: string[] = [];
    for (const [source, target] of map) {
      const seen = new Set([source]);
      let next = target;
      let hops = 1;
      while (map.has(next)) {
        if (seen.has(next)) {
          issues.push(`Loop from ${source}`);
          break;
        }
        seen.add(next);
        next = map.get(next)!;
        hops++;
      }
      if (hops > 1) issues.push(`${hops} hops from ${source}`);
    }
    return {
      summary: [
        `${map.size} mappings`,
        ...issues,
        ...(!issues.length ? ['No chains or loops in this map.'] : []),
      ],
      output: [...map].map(([a, b]) => `${a} | ${b}`).join('\n'),
    };
  }
  if (tool === 'conversion') {
    const rows = ['a', 'b'].map((label) => {
      const n = Number(values[`${label}_visits`]);
      const k = Number(values[`${label}_conversions`]);
      if (
        !Number.isSafeInteger(n) ||
        !Number.isSafeInteger(k) ||
        n < 1 ||
        k < 0 ||
        k > n ||
        !values[`${label}_conversions`]?.trim()
      )
        throw new Error('Use positive integer visitor counts and conversions between zero and visitors.');
      const rate = k / n;
      const z = 1.96;
      const denominator = 1 + (z * z) / n;
      const center = (rate + (z * z) / (2 * n)) / denominator;
      const margin = (z * Math.sqrt((rate * (1 - rate)) / n + (z * z) / (4 * n * n))) / denominator;
      return {
        variant: label.toUpperCase(),
        visitors: n,
        conversions: k,
        rate,
        lower: Math.max(0, center - margin),
        upper: Math.min(1, center + margin),
      };
    });
    return {
      summary: rows.map(
        (row) =>
          `${row.variant}: ${(row.rate * 100).toFixed(2)}% (95% interval ${(row.lower * 100).toFixed(2)}–${(row.upper * 100).toFixed(2)}%)`,
      ),
      output: JSON.stringify(
        { method: 'Individual 95% Wilson intervals; not a two-sample significance test', variants: rows },
        null,
        2,
      ),
    };
  }
  throw new Error('Choose a supported tool.');
}
