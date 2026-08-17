# Markets and entities

Markets & Entities is the workspace's reviewed source of truth for a brand, organisation, person, product or local business. It records the facts that search engines, AI assistants, directories and customers should agree on: identity, canonical website, market, contact details, authoritative profiles, listings and review totals.

It does not publish changes to your website or directory accounts. Saving a record only stores approved facts in the current workspace so the app can show completeness and listing consistency. Publishing and direct provider synchronisation can be added separately without making discovery unsafe.

## Start from a website

1. Add the website under **Sites & Submissions**.
2. Open **Markets & Entities** and choose **Add entity**.
3. Select the website and click **Discover public facts**.
4. Review every populated field, correct anything stale and mark a listing verified only after checking it.
5. Save the source of truth.

Discovery makes a read-only request to the selected site's public homepage. It looks for Organization, LocalBusiness, Person, Product and related JSON-LD, plus the canonical URL, language, description, Open Graph site name and image. It can also recognise common public profile and listing URLs from `sameAs`, including Google Business Profile, Bing Places, Yelp, Tripadvisor and Apple Business Connect.

Discovery never changes the website. If the site blocks automated requests or does not publish structured data, use the ordinary fields instead. No JSON writing is required.

## What to record

| Field group | Examples |
| --- | --- |
| Identity | Public name, legal name, entity type, description and logo URL |
| Market | Global, United Kingdom, London, New York, French market, or another useful operating region |
| Locale | `en-GB`, `en-US`, `fr-FR`, or the language-region used for that record |
| Contact | Canonical website, postal address and public phone number |
| Profiles | Wikidata, Wikipedia, Crunchbase, LinkedIn and other authoritative identifiers or URLs |
| Listings | Google Business Profile, Bing Places, Yelp, Tripadvisor, Apple Business Connect and relevant specialist directories |
| Reviews | Aggregate rating and review count, with provider-specific values on individual listings where available |

Use one record per meaningfully different market or location. For example, a global software brand may need one record, while a business with separate London and Manchester locations should use two records with the correct local contact details and listings.

## Example

| Field | Value |
| --- | --- |
| Name | Acme SEO London |
| Entity type | Local business |
| Market | London |
| Locale | `en-GB` |
| Canonical URL | `https://example.com/london` |
| Authoritative profile | Wikidata — `https://www.wikidata.org/wiki/Q123` |
| Listing | Google Business Profile — needs review |

## Consistency score

The score is evidence completeness, not a search-engine ranking score. Core identity fields contribute half of the score. Verified or consistent listings contribute up to a quarter; discovered listings begin as **Needs review** and do not count until checked. Profiles and stored knowledge contribute up to 15 points, and review rating/count contribute the final 10.

This deliberately avoids awarding a high score merely because a URL was found. Recheck records after a rebrand, move, phone-number change, domain migration or material review-count update.
