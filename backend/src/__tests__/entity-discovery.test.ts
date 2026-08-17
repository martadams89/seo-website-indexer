import { describe, expect, it } from 'vitest';
import { parseEntityDiscovery, siteHomepage } from '../platform/entity-discovery.js';

describe('entity discovery', () => {
  it('turns public organization JSON-LD into editable entity facts', () => {
    const result = parseEntityDiscovery(`<!doctype html><html lang="en-GB"><head>
      <link rel="canonical" href="https://example.com/" />
      <script type="application/ld+json">{
        "@context":"https://schema.org",
        "@graph":[
          {"@type":"WebSite","name":"Example website","url":"https://example.com/"},
          {"@type":["Organization","LocalBusiness"],"name":"Example Group","legalName":"Example Group Ltd",
           "url":"https://example.com/","telephone":"+44 20 0000 0000",
           "description":"A useful local business.","logo":{"url":"https://example.com/logo.png"},
           "address":{"@type":"PostalAddress","streetAddress":"1 Example Street","addressLocality":"London","postalCode":"SW1A 1AA","addressCountry":"GB"},
           "sameAs":["https://www.wikidata.org/wiki/Q123","https://www.google.com/maps?cid=123","https://www.linkedin.com/company/example"],
           "aggregateRating":{"ratingValue":"4.8","reviewCount":"120"}}
        ]
      }</script></head></html>`, { siteName: 'Fallback name', siteUrl: 'https://example.com/' });

    expect(result.data).toMatchObject({
      name: 'Example Group', market: 'London', locale: 'en-GB', entity_type: 'location',
      primary_url: 'https://example.com/', phone: '+44 20 0000 0000', review_rating: 4.8, review_count: 120,
    });
    expect(result.data.address).toContain('1 Example Street');
    expect(result.data.identifiers).toMatchObject({
      wikidata: 'https://www.wikidata.org/wiki/Q123',
      google_business_profile: 'https://www.google.com/maps?cid=123',
      linkedin: 'https://www.linkedin.com/company/example',
    });
    expect(result.data.listings).toEqual([{ provider: 'Google Business Profile', url: 'https://www.google.com/maps?cid=123', status: 'needs_review' }]);
    expect(result.data.knowledge).toMatchObject({ legal_name: 'Example Group Ltd', description: 'A useful local business.', logo_url: 'https://example.com/logo.png' });
    expect(result.schema_types).toEqual(expect.arrayContaining(['Organization', 'LocalBusiness']));
  });

  it('falls back to page metadata without inventing local facts', () => {
    const result = parseEntityDiscovery(`<!doctype html><html lang="en-US"><head>
      <title>Example Software</title><meta property="og:site_name" content="Example Inc" />
      <meta name="description" content="Example description" />
      <link href="https://example.com/" rel="canonical" />
    </head></html>`, { siteName: 'Configured site', siteUrl: 'https://example.com/' });

    expect(result.data).toMatchObject({
      name: 'Example Inc', market: '', locale: 'en-US', entity_type: 'brand', primary_url: 'https://example.com/',
      address: '', phone: '', review_rating: null, review_count: null,
    });
    expect(result.data.knowledge).toMatchObject({ description: 'Example description' });
    expect(result.warnings[0]).toMatch(/No valid JSON-LD/);
  });

  it('normalizes configured domains into scannable homepages', () => {
    expect(siteHomepage({ domain: 'sc-domain:example.com' } as never)).toBe('https://example.com/');
    expect(siteHomepage({ domain: 'https://example.com/store' } as never)).toBe('https://example.com/store');
  });
});
