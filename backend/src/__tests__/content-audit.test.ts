import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeHtmlEntities, inspectPage } from '../platform/content-audit.js';

afterEach(() => vi.unstubAllGlobals());

describe('content audit HTML parsing', () => {
  it('decodes named, decimal and hexadecimal HTML entities', () => {
    expect(decodeHtmlEntities('Awaab&#39;s &amp; damp &#x26; mould &mdash; evidence')).toBe("Awaab's & damp & mould — evidence");
  });

  it('preserves apostrophes in double-quoted metadata and uses the final response host for links', async () => {
    const html = `<!doctype html><html><head>
      <title>Awaab&#39;s Law Evidence | HousingSurvey Pro</title>
      <meta content="Awaab's Law records remain complete." name="description">
      <link href="https://dennisfreight.co.uk/services" rel="alternate canonical">
      <script type="application/ld+json">{}</script>
    </head><body>
      <a href="/about">About</a>
      <a href="https://www.dennisfreight.co.uk/contact">Contact</a>
      <a href="https://example.com/">External</a>
    </body></html>`;
    const response = new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: 'https://dennisfreight.co.uk/services' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = await inspectPage('https://dennisfreight.com/services');

    expect(result.title).toBe("Awaab's Law Evidence | HousingSurvey Pro");
    expect(result.description).toBe("Awaab's Law records remain complete.");
    expect(result.canonical).toBe('https://dennisfreight.co.uk/services');
    expect(result.internalLinks).toBe(2);
    expect(result.externalLinks).toBe(1);
    expect(result.schemas).toBe(1);
  });
});
