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

  it('recognises app stores and Gartner Digital Markets profiles from sameAs', () => {
    const result = parseEntityDiscovery(`<script type="application/ld+json">{
      "@context":"https://schema.org","@type":"SoftwareApplication","name":"Acme Scout",
      "sameAs":[
        "https://play.google.com/store/apps/details?id=com.acme.scout",
        "https://apps.apple.com/gb/app/acme-scout/id123",
        "https://www.g2.com/products/acme-scout/reviews",
        "https://www.capterra.com/p/123/acme-scout/",
        "https://www.getapp.com/operations-management-software/a/acme-scout/",
        "https://www.softwareadvice.com/project-management/acme-scout-profile/"
      ]
    }</script>`, { siteName: 'Acme Scout', siteUrl: 'https://acme.example.com/' });

    expect(result.data.listings.map(item => item.provider)).toEqual([
      'Google Play', 'Apple App Store', 'G2', 'Capterra', 'GetApp', 'Software Advice',
    ]);
  });

  it('selects an app identity instead of its parent company and merges split schema nodes', () => {
    const result = parseEntityDiscovery(`<!doctype html><html lang="en-GB"><head>
      <title>DampApp Pro™ - Damp &amp; Timber Survey Software</title>
      <meta property="og:site_name" content="DampApp Pro" />
      <link rel="canonical" href="https://dampapp.pro/" />
      <script type="application/ld+json">{
        "@context":"https://schema.org","@graph":[
          {"@type":"Organization","@id":"https://prosurvey.app/#organization","name":"ProSurvey Apps Limited","legalName":"ProSurvey Apps Limited","url":"https://prosurvey.app/","address":{"addressCountry":"GB"},"sameAs":["https://www.linkedin.com/company/prosurvey-apps"]},
          {"@type":"WebSite","@id":"https://dampapp.pro/#website","url":"https://dampapp.pro/","name":"DampApp Pro","publisher":{"@id":"https://prosurvey.app/#organization"}},
          {"@type":"SoftwareApplication","@id":"https://dampapp.pro/#product","name":"DampApp Pro","url":"https://dampapp.pro/","description":"Damp and timber survey software.","publisher":{"@id":"https://prosurvey.app/#organization"},"sameAs":["https://play.google.com/store/apps/details?id=pro.dampapp","https://apps.apple.com/gb/app/dampapp-pro/id123"]},
          {"@type":"SoftwareApplication","@id":"https://dampapp.pro/#product","aggregateRating":{"ratingValue":"4.9","ratingCount":"42"}}
        ]
      }</script></head></html>`, { siteName: 'DampApp.pro', siteUrl: 'https://dampapp.pro/' });

    expect(result.data).toMatchObject({
      name: 'DampApp Pro', entity_type: 'product', primary_url: 'https://dampapp.pro/', review_rating: 4.9, review_count: 42,
    });
    expect(result.data.knowledge).not.toHaveProperty('legal_name', 'ProSurvey Apps Limited');
    expect(result.data.listings.map(item => item.provider)).toEqual(['Google Play', 'Apple App Store']);
    expect(result.selection).toMatchObject({ selected_name: 'DampApp Pro', selected_type: 'SoftwareApplication' });
    expect(result.selection.reason).toContain('URL and name match dampapp.pro');
    expect(result.selection.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'DampApp Pro', type: 'SoftwareApplication', selected: true }),
      expect.objectContaining({ name: 'ProSurvey Apps Limited', type: 'Organization', selected: false, relationship: 'Publisher' }),
    ]));
  });

  it('normalizes configured domains into scannable homepages', () => {
    expect(siteHomepage({ domain: 'sc-domain:example.com' } as never)).toBe('https://example.com/');
    expect(siteHomepage({ domain: 'https://example.com/store' } as never)).toBe('https://example.com/store');
  });
});
