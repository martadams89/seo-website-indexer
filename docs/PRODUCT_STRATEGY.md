# Product strategy: the organic-search command centre

The product should become the daily operating system for SEO and GEO teams:
one place to observe demand, diagnose discoverability, make changes, submit
them, and prove the result. The test for any new feature is therefore not
“could this data fit on a dashboard?” but “does this close an observe → decide
→ act → verify loop?”

## Product position

The clearest initial customers are agencies, consultants, in-house portfolio
teams, and managed hosts. They already carry the cost of switching between
Search Console, Bing, analytics, crawlers, answer engines, CMSs and client
reports. A self-hosted workspace gives them credential ownership and tenant
isolation; the commercial offer can add managed operations, reporting and
governance without withholding the useful open-source core.

The v1.27 platform completes the first broad implementation of this model. The
command centre now sits on a normalized evidence layer and links directly to an
assignable work centre, scheduled AI visibility, governed CMS publishing,
branded reporting, local-entity intelligence, usage controls and an authenticated
executive view. Each headline signal links back to the operating surface that can
resolve it.

## v1.27 delivery snapshot

The recommendations in this document are now represented in the product where
they are safe and useful in a single-container architecture:

- Normalized, provenance-retaining observations for GA4, PageSpeed,
  Cloudflare, Plausible, Matomo, Search Console, rank feeds and server logs,
  with source freshness, CSV export, saved views and explainable forecast
  ranges.
- Assignable actions with severity, status, due date, snooze, bulk preview,
  deep-linked evidence and a causal annotation/deployment timeline.
- Scheduled prompt groups with market, device and persona context, answer and
  source diffs, citation movement notifications and cost attribution.
- WordPress, Shopify and Webflow adapter contracts with a mandatory propose →
  approve → stage → publish → verify workflow and captured rollback state.
- Content inventory auditing, local-market entities/listings/reviews, scheduled
  branded reports, severity-routed digests and a branded authenticated
  executive view.
- Encrypted connectors, Bing OAuth plus API-key fallback, signed webhooks,
  hashed scoped service tokens and stable metric/event/log ingestion APIs.
- Workspace MFA and retention policies, an append-only usage ledger,
  per-user/per-workspace provider budgets and billback exports.

The remaining items are scale or commercialisation gates, not missing daily
workflow: SCIM, PostgreSQL/job-queue multi-replica operation, high availability,
managed backup restore and an optional hosted billing adapter. They should be
added when deployment evidence justifies their operating cost. Stripe remains
deliberately outside the core for the reasons below.

## What belongs in the product

Use four layers, in this order:

1. **System of record** — normalized workspace, site, page, query, prompt,
   source, event and integration entities with provenance and freshness.
2. **Intelligence** — changes, anomalies, opportunities, forecasts and clear
   confidence levels. Every recommendation must expose the evidence behind it.
3. **Action** — submit URLs, manage sitemaps, update machine-readable files,
   acknowledge/assign work, and eventually publish approved CMS changes.
4. **Proof** — before/after trends, annotations, audit history, client-ready
   reports and cost attribution.

Avoid a connector catalogue that only produces more tiles. An integration is
worth adding when it contributes a unique signal or supports a safe action.

## Delivery roadmap

### Near term — make the daily operating loop exceptional

- **Notification inbox and digests:** assignable actions, owner, due date,
  snooze, saved severity rules, daily/weekly workspace digest and deep links.
- **Scheduled AI visibility:** prompt groups, locales, devices/personas,
  configurable cadence, answer/source diffs, citation gain/loss alerts,
  share-of-voice and exportable client snapshots.
- **Google Analytics 4:** landing-page engagement, conversions and revenue
  joined to Search Console query/page demand. The official Data API supports
  standard, batch, pivot and real-time reports, making it suitable for the same
  cached-rollup pattern already used here:
  <https://developers.google.com/analytics/devguides/reporting/data/v1>
- **Page experience:** scheduled Lighthouse/PageSpeed lab checks plus CrUX
  history, budgets and regression alerts. PageSpeed Insights exposes
  performance, accessibility and SEO audits; field data should come directly
  from the CrUX APIs as Google is removing it from PSI:
  <https://developers.google.com/speed/docs/insights/v5/get-started>
- **Search Console expansion:** search appearance, country/device filters,
  sitemap and URL Inspection status, page-query joins, annotations and data
  freshness. Search Analytics is sampled/limited and normally lags by several
  days, so retain the current daily local rollup architecture:
  <https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data>
- **Report builder:** scheduled branded email/link reports assembled from the
  same cards, with commentary, annotations and workspace-level templates.
- **Operational polish:** saved dashboard views, global date range, accessible
  command palette, onboarding checklist, empty-state sample data and bulk
  operations with preview/undo where possible.

### Medium term — join delivery, traffic and content

- **Edge and origin analytics:** Cloudflare GraphQL Analytics for requests,
  crawlers, cache, status codes and security events. Use least-privilege API
  tokens scoped to the relevant account/zones:
  <https://developers.cloudflare.com/analytics/graphql-api/>
- **Privacy-first analytics adapters:** Matomo and Plausible alongside GA4,
  normalized to sessions, conversions and landing-page outcomes.
- **CMS action adapters:** WordPress first, then Shopify and Webflow. Start with
  drafts and approval workflows; never silently publish generated changes.
  WordPress exposes authenticated create/update operations through its REST
  API: <https://developer.wordpress.org/rest-api/reference/posts/>.
- **Content inventory and briefs:** cannibalization, decay, internal-link gaps,
  entity/topic coverage, schema recommendations and evidence-backed briefs.
- **Crawl and log intelligence:** scheduled crawler, rendered-page checks,
  server/CDN log ingestion, bot behavior and crawl-waste analysis.
- **Bing OAuth:** replace key-only onboarding with delegated OAuth where
  practical while retaining API keys for self-hosters. Bing documents both and
  recommends OAuth 2.0:
  <https://learn.microsoft.com/en-us/bingwebmaster/getting-access>.
- **Outbound platform hooks:** signed webhooks, scoped service-account tokens,
  n8n/Zapier-compatible events, BigQuery/S3/R2 export, and stable public APIs.

### Longer term — differentiated intelligence and enterprise operations

- Forecast clicks/conversions and quantify opportunity with ranges rather than
  false precision; track forecast accuracy over time.
- Correlate deployments, submissions, crawl changes, ranking movement and AI
  citation changes on one causal timeline.
- Multi-market/local SEO entities, listings/reviews, brand/entity knowledge
  consistency and regional AI visibility.
- Governed AI actions: propose schema, metadata, internal links and `llms.txt`
  changes, show diffs/evidence, require approval, publish through an adapter,
  verify the live result and support rollback.
- Public guest portals, approval queues, SCIM, enforced MFA,
  retention/export controls, PostgreSQL/job-queue scale and high availability.

## Integration priority score

Score candidates out of five on unique signal, actionability, customer reach,
API stability, setup friction and ongoing cost. Ship the highest score, not the
loudest logo. The current recommended sequence is:

| Priority | Integration | Why now |
| --- | --- | --- |
| 1 | GA4 | Connects search visibility to business outcomes. |
| 2 | PageSpeed + CrUX History | Converts page experience into trackable regressions and work. |
| 3 | Cloudflare | Adds bot/crawl/response evidence unavailable in search consoles. |
| 4 | WordPress | Closes the first safe draft → approve → publish → verify loop. |
| 5 | Matomo/Plausible | Broadens analytics coverage for privacy-first/self-hosted buyers. |
| 6 | Shopify/Webflow | High-value publishing workflows after the adapter contract is proven. |

Paid rank-data providers (Semrush, Ahrefs, DataForSEO, etc.) should be optional
adapters. Do not make the core depend on one provider or imply that scraped
rank positions are equivalent to first-party Search Console data.

## Commercial complexity: the line to hold

Do not put Stripe keys, invoices and tax logic into the core yet. It would add
large security, accounting and support surfaces before proving that customers
want the product to collect money on their behalf. Build entitlements, budgets,
an immutable usage ledger, cost estimates and billback exports first. Those are
valuable to agencies even when they invoice manually. Stripe can later be an
optional adapter to that proven model, as detailed in
[COMMERCIALIZATION.md](COMMERCIALIZATION.md).

Measure demand for paid packaging through design-partner conversations and
actual use of workspace limits, reports and exports. The strongest packages are
likely Agency (white label, reports, billback, support), Enterprise (identity,
audit, retention, scale) and Managed (upgrades, backups and monitoring), not a
generic reseller storefront.

## Product and reliability measures

- Time from sign-in to the first useful insight and first completed action.
- Weekly active workspaces and percentage with a completed observe/action/proof
  loop, not raw login counts.
- Alert precision: acknowledged/actioned versus ignored or muted.
- Median age of critical actions and submission failures.
- Search and AI coverage breadth, data freshness and connector failure rate.
- Notification delivery success and time to recovery.
- API cost per workspace and cost per useful insight/action.
- Release health: tenant-boundary tests, migration tests, endpoint authorization,
  frontend build/lint, container build and smoke/browser checks at desktop and
  mobile breakpoints.

Telemetry should be opt-in for self-hosted installations, aggregated, and
documented. The application must remain fully useful with telemetry disabled.
