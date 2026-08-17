# Markets and entities

Markets & Entities is the workspace's reviewed source of truth for a brand, organisation, person, product or local business. It records the facts that search engines, AI assistants, directories and customers should agree on: identity, canonical website, market, contact details, authoritative profiles, listings and review totals.

It does not publish changes to your website or directory accounts. Saving a record only stores approved facts in the current workspace so the app can show completeness and listing consistency. Publishing and direct provider synchronisation can be added separately without making discovery unsafe.

## Start from a website

1. Add the website under **Sites & Submissions**.
2. Open **Markets & Entities** and choose **Add entity**.
3. Select the website and click **Discover public facts**.
4. Review every populated field, correct anything stale and mark a listing verified only after checking it.
5. Save the source of truth.

Discovery makes a read-only request to the selected site's public homepage. It looks for Organization, LocalBusiness, Person, Product and related JSON-LD, plus the canonical URL, language, description, Open Graph site name and image. It can also recognise common public profile and listing URLs from `sameAs`, including Google Business Profile, Google Play, the Apple App Store, G2, Capterra, GetApp, Software Advice, TrustRadius, Trustpilot, Product Hunt, SourceForge, the Chrome Web Store, Microsoft Store, Bing Places, Yelp, Tripadvisor and Apple Business Connect.

When a page describes more than one identity, discovery prefers the record whose URL and name match the website being scanned. This is particularly important for product and app sites: a `SoftwareApplication` on the selected domain is used instead of its parent `Organization` on a different domain. The discovery panel shows the selected identity, why it was selected and any publisher, parent or alternative identities found on the page. Split JSON-LD records that share an `@id` are combined before their fields are imported.

Discovery never changes the website. If the site blocks automated requests or does not publish structured data, use the ordinary fields instead. No JSON writing is required.

## What to record

| Field group | Examples |
| --- | --- |
| Identity | Public name, legal name, entity type, description and logo URL |
| Market | Global, United Kingdom, London, New York, French market, or another useful operating region |
| Locale | `en-GB`, `en-US`, `fr-FR`, or the language-region used for that record |
| Contact | Canonical website, postal address and public phone number |
| Profiles | Wikidata, Wikipedia, Crunchbase, LinkedIn and other authoritative identifiers or URLs |
| Listings | Google Business Profile, app stores, G2/Gartner Digital Markets properties, review platforms and relevant specialist directories |
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

## How AI visibility uses this record

AI Visibility reads the entity name, legal name, owned domain, identifiers and listing URLs from the active workspace. It classifies each stored or new provider answer as one or more of:

- **Direct website citation** — the answer or source points to an owned domain.
- **Third-party entity citation** — a source matches a recorded profile or marketplace listing, such as Google Play, the App Store, G2, Capterra, GetApp or Software Advice.
- **Brand/entity mention** — the answer names a tracked entity but does not provide a recognised direct or third-party link.

Add trading names, product names or previous names under **AI Visibility → Your citation identity**. Existing answer history is reclassified from its retained answer text and source URLs whenever it is viewed, so improving the entity record does not require rerunning paid prompts.
