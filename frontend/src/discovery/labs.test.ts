import { it, expect } from 'vitest';
import { runLab } from './labs';
it('Add a local search-snippet preview and escaped metadata export without presenting character counts as ranking rules.', () => {
  expect(runLab('snippet', { title: '<unsafe>', description: 'A & B' }).output).toContain('&lt;unsafe&gt;');
});
it('Campaign URL builder \u2014 create correctly encoded analytics campaign links.', () => {
  const url = new URL(
    runLab('campaign', {
      url: 'https://example.com/?keep=yes#part',
      source: 'a b',
      medium: 'email',
      campaign: 'autumn',
    }).output,
  );
  expect(url.searchParams.get('utm_source')).toBe('a b');
  expect(url.hash).toBe('#part');
});
it('Structured-data inspector \u2014 validate JSON syntax and inspect declared schema types.', () => {
  expect(runLab('schema', { json: '{"@graph":[{"@type":"Article"}]}' }).summary.join(' ')).toContain(
    'Article',
  );
  expect(() => runLab('schema', { json: '{' })).toThrow();
});
it('Sitemap inspector \u2014 inspect XML, duplicate locations and URL-entry limits.', () => {
  expect(
    runLab('sitemap', {
      xml: '<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/</loc></url></urlset>',
    }).summary,
  ).toContain('1 duplicate locations');
  expect(() => runLab('sitemap', { xml: '<!DOCTYPE x><urlset/>' })).toThrow();
});
it('Language-alternate builder \u2014 generate escaped hreflang declarations and reject duplicate tags.', () => {
  expect(runLab('hreflang', { alternates: 'en-GB https://example.com/uk' }).output).toContain(
    'hreflang="en-GB"',
  );
  expect(() =>
    runLab('hreflang', { alternates: 'en https://example.com/\nen https://example.com/en' }),
  ).toThrow();
});
it('Robots declaration explorer \u2014 inspect crawler groups and flag unfamiliar or malformed directives.', () => {
  expect(
    runLab('robots', { robots: 'User-agent: *\nDisallow: /private\nAllow: /public\nUnknown: x' }).summary,
  ).toContain('1 unknown or malformed lines');
});
it('Robots-meta builder \u2014 explain and prepare intentional indexing and snippet controls.', () => {
  expect(runLab('directives', { index: 'noindex', follow: 'follow', snippet: 'nosnippet' }).output).toContain(
    'noindex, follow, nosnippet',
  );
});
it('FAQ markup builder \u2014 prepare JSON-LD exclusively from supplied question-and-answer pairs.', () => {
  const data = JSON.parse(runLab('faq', { pairs: 'Does it work offline? | Yes, for saved surveys.' }).output);
  expect(data.mainEntity[0].acceptedAnswer.text).toBe('Yes, for saved surveys.');
});
it('Redirect-map inspector \u2014 identify duplicate sources, redirect chains and loops before deployment.', () => {
  expect(
    runLab('redirects', {
      mapping: 'https://example.com/a | https://example.com/b\nhttps://example.com/b | https://example.com/a',
    }).summary.some((s) => s.startsWith('Loop')),
  ).toBe(true);
});
it('Conversion comparison \u2014 compare actual conversion rates with uncertainty intervals instead of invented uplift.', () => {
  const r = JSON.parse(
    runLab('conversion', { a_visits: '100', a_conversions: '0', b_visits: '100', b_conversions: '10' })
      .output,
  );
  expect(r.variants[0].lower).toBe(0);
  expect(r.variants[0].upper).toBeGreaterThan(0);
  expect(() => runLab('conversion', { a_visits: '1', a_conversions: '2' })).toThrow();
});
