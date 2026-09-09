# Discovery workbench

Open **Discovery** in the main navigation. Choose a tool and site. Each result is an observation with its source, scope and next step. Core tools run on your own installation without a paid SEO or AI subscription.

| Tool | What it provides | Evidence required |
| --- | --- | --- |
| Website audit | SEO, AI search eligibility, accessibility, metadata and sampled internal-link checks; page evidence; history and comparisons; work-queue findings | Reachable response HTML from your site's inventory |
| Search opportunities | Queries to investigate using observed impressions, position and click movement | Automatically synced Google Search Console query history |
| App store studio | Apple and Google Play drafts, field limits, target-term coverage, locale/store variants, revisions and exports | Public Apple / Google Play search, or your listing copy |
| Backlinks | Online discovery, source-page verification, anchors, rel attributes, history, notes and monitoring controls | Web search, connected Bing Webmaster and saved citation sources; optional CSV import |
| Link candidates | Discover, review, filter, compare, export and promote linking pages into monitoring | Online discovery or optional public-crawl extracts |
| Content studio | Evidence-led briefs, outline assistance, sampled internal-link candidates, writing prompts and review handoff to Work | Your sources, audience and intent; an audit for link candidates |
| Measure changes | Saved hypotheses, before/after windows, coverage checks, outcomes and measurement exports | Cached daily Search Console site totals |
| Technical lab | Ten local tools for snippets, campaign URLs, JSON-LD, sitemaps, language alternates, robots declarations, robots metadata, FAQs, redirects and conversion intervals | Pasted input; these tools do not fetch the entered URLs |
| Evidence coverage | A portfolio view of measured pages, fetch failures, search-data freshness, tracked backlinks and saved listings | Existing workspace records; missing data stays visibly unmeasured |

## A useful first workflow

1. Add a website in Sites and let its sitemap build the inventory.
2. Run a 10-page website audit. Inspect the measured pages and any fetch failures before interpreting the findings.
3. Open Work to address significant findings. Exclusions and canonical choices can be intentional: read the evidence before changing them.
4. Record a measurement plan before a meaningful production change. Choose the metric and observation window in advance.
5. Run another audit after deployment. A finding is only labelled no longer observed when the relevant evidence can be compared.
6. Review observed search movement once the complete periods are available. Record other changes and what you learned.

## Backlinks: useful evidence, without an invented authority score

Links help people and search engines discover pages. Google's ranking systems use link analysis, including PageRank, alongside many other signals. A count alone does not describe the value of a link, and this application does not predict rankings from that count. See Google's [ranking systems guide](https://developers.google.com/search/docs/appearance/ranking-systems-guide) and [link spam policies](https://developers.google.com/search/docs/essentials/spam-policies).

Select a site and choose **Discover backlinks** or **Discover link candidates**. Add an optional publisher, topic or brand phrase to narrow the search. The application searches for external pages mentioning the domain, then fetches their HTML to find actual linking anchors.

Discovery uses your workspace's Brave Search key when configured, otherwise Bing's public RSS search. A connected Bing Webmaster account adds link-report pairs; saved AI citation sources for the selected site are inspected too. Results identify the sources used, pages checked, links observed and provider failures. Public search availability varies; Brave provides an explicit API integration. Neither source guarantees a complete backlink index.

A scan checks up to 12 source pages with three concurrent requests, eight seconds per source and a 55-second overall budget. It samples up to three Bing target pages and 30 reported links per target. A workspace can run one scan at a time, with 30 seconds between starts; an installation allows three concurrent scans. HTTPS/private-address policy and response-size limits apply to discovered URLs too.

In **Backlinks**, observed anchors become monitored links with a saved **Present** check. Bing-reported pairs without a successful live observation remain **Unverified**. In **Link candidates**, discovered pairs enter the review inbox; dismissed candidates remain dismissed. Search-only mentions never become backlinks. Candidates retain source provenance and an observation date where available.

CSV import remains available for other sources. Search Console's Links report supports exports; it is a sample rather than a complete backlink index and is not exposed by its Search Analytics API. See the [official Links report guide](https://support.google.com/webmasters/answer/9049606).

```csv
source_url,target_url
https://publisher.example/review,https://your-site.example/product
https://community.example/resources,
```

The source must be an external linking **page**, not just a referring domain. `target_url` is optional: leaving it blank checks for any link to the selected site or its subdomains. Source headers including `Linking page` and `Referring page URL` are accepted. Imports support quoted fields, BOM, CRLF and tab-separated exports.

Give every import a provenance label. Preview before importing: valid additions, duplicates and rejected rows are shown without saving. Each import accepts up to 500 rows and 500 KB. Repeated imports deduplicate the source/target pair. The screen currently loads the latest 5,000 tracked records per site.

| Status | Meaning |
| --- | --- |
| Unverified | Imported but not checked |
| Present | A matching anchor was found in fetched HTML |
| Missing | The fetched HTML was readable but no matching anchor was found within a complete link extraction |
| Unreachable | A timeout, fetch error, non-HTML response or extraction limit prevented verification |

Checks use three concurrent requests, a 15-second timeout and a 2 MB response limit. A batch checks up to 25 enabled records, oldest first; a single source can also be rechecked. The automation loop checks records due after seven days, on enabled sites. Pause individual records without losing their evidence or notes.

The last 30 checks per backlink retain observed anchors, targets, rel tokens and changes. A previously present link becoming missing creates a review item in Work. A fetch failure does not claim that the link disappeared. JavaScript-only links may not be visible in response HTML. Up to 5,000 anchors are inspected per source and up to 100 matching links retained.

Online discovery combines search and connected evidence with source-page verification. It does not operate a whole-web crawler or assign a paid authority metric. No outreach, link purchasing or disavow submission is performed.

## Website audits and GEO

The manual audit selects the first 10, 25 or 50 sorted, deduplicated inventory URLs belonging to the selected site, or its homepage when the inventory is empty. It fetches three pages at a time, limits each response to 2 MB and 20 seconds, and extracts up to 500 links per page. It does not execute page JavaScript or act as a full browser accessibility audit.

Manual jobs persist progress, resume polling when the screen is reopened, and can be cancelled. The server allows two manual jobs at once and prevents simultaneous audits of the same site. Server restarts mark interrupted jobs failed so they can be run again. Cancellation does not save a partial-success report. Scheduled audits reuse the same evidence engine on enabled sites when the previous snapshot is at least six days old.

Snapshots retain the latest 30 runs per site. Fetch failures and unvisited pages stay visible. Comparisons distinguish new, persisting, no-longer-observed and unverified findings; a smaller or failed sample cannot establish that a contextual finding was repaired. Download full JSON evidence or the filtered findings as spreadsheet-safe CSV.

GEO checks cover observable snippet/indexing restrictions and article attribution review. They do not claim to measure an AI model's preference or predict citations. Use the existing AI visibility screen for observed provider answers and citations. Google documents that ordinary SEO fundamentals apply to its AI features and that special AI files or special schema are not required: [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features).

Word count, `llms.txt` presence, schema presence and keyword density are not scored as ranking requirements. Valid JSON-LD syntax alone does not establish eligibility for a rich result.

## App listings and content

Open **Find your app in the stores** to find an app or publisher in Apple App Store or Google Play. Choose a country and language, search, then **Preview listing**. **Use listing as new draft** fills the editor, retains its source URL, store ID and fetch date, and protects an existing unsaved draft. Review the result and save normally.

Apple lookup uses the public [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html). It returns the public name and description; private keywords, subtitle and promotional text remain empty. Google's public Play page supplies the name, short description and full description where exposed. If the full description is unavailable, the preview says so. Public page structure can change. Country controls storefront availability; review the fetched language before saving a locale variant. Results are cached for five minutes and uncached requests are limited to 15 per minute per installation.

App store studio checks Apple name/subtitle/description/keyword/promotional-text limits and Google Play name/short-description/description limits. Counters use Unicode code points. Target terms use literal, normalised coverage, with word boundaries where appropriate; coverage is not search volume or a density target. Relevance and accuracy still need editorial review.

Drafts are workspace-scoped, can be associated with a website, and retain their last 30 revisions. You can duplicate a draft, prepare a locale or other-store variant, compare revisions, import JSON and export JSON or plain text. Saving never publishes to a store. Select a saved listing and choose **Delete draft** to remove it and its revision history. The confirmation names the saved draft; cancellation or a failed request preserves the editor. Unsaved drafts can be cleared with **New draft** and the discard confirmation. Platform guidance remains authoritative: [Apple product pages](https://developer.apple.com/app-store/product-page/) and [Google Play store listings](https://support.google.com/googleplay/android-developer/answer/13393723).

Content studio saves briefs and their last 30 revisions. Select a saved brief and choose **Delete brief** to remove it and its history. **Measure changes** also offers **Delete measurement plan** for the selected plan, including archived plans. Deletion requires edit permission, is workspace-scoped and leaves existing Work items and published content intact. Its outline and writing prompt organise user-supplied evidence; they do not generate invented facts. Internal-link candidates use title overlap in the latest sampled audit, so review relevance yourself. Sending a saved brief to Work creates a review item and never publishes content. Edited drafts warn before closing the page, following ordinary navigation links, changing tools/sites, or replacing the draft in the editor.

## Measurement rules

Search opportunities use the most recent 28-day query window ending two days before the current date, compared with the preceding 28 days. **All queries** includes recorded queries with at least one impression; **Priority opportunities** requires at least 100 impressions and a position or decline signal. Search filters both views. Opening a site fetches up to 50,000 daily query rows across both windows, caches successful syncs for six hours and displays the connected property, last successful sync, errors and truncated responses. **Refresh from Google** forces a refresh, with a 30-second retry interval. Complete successful responses replace the matching cached window; failures preserve that property's cached evidence. Changing the linked account/property clears its previous query cache to prevent misattribution. Google suppresses some low-volume queries, so query totals need not match site totals. A Google account connected in Settings must also be selected on the website in Sites with an accessible Search Console property. Position is impression-weighted; click-decline flags require enough days and baseline clicks. These are review heuristics, not traffic forecasts.

Measurement plans support 7-, 14- or 28-day periods before and after the chosen change date. Date boundaries use UTC, with the end date exclusive. CTR is total clicks divided by total impressions; position is weighted by impressions. Percentage changes stay unavailable until the follow-up period has ended, the two-day freshness buffer has elapsed, and every day in both periods has cached data. Missing days are not assumed to be zero. A zero baseline does not produce an infinite percentage increase.

Before/after movement does not establish causation. The local conversion tool reports individual 95% Wilson intervals; it does not declare an experiment winner or perform a two-sample significance test.

## Operations and API

No extra service is required. Startup migrations add SQLite tables for audit snapshots/jobs, backlink evidence, listing drafts and planning documents. Normal database backups include these records. Existing records are preserved; normal workspace deletion cascades through associated discovery data. Deleting a site removes its audits, backlinks and planning documents; app listings remain in the workspace with their site association cleared. Upgrade using the existing container deployment and backup procedure.

Endpoints live under `/api/platform/discovery`: `coverage`, `audits`, `jobs`, `opportunities`, `opportunities/sync`, `stores/search`, `stores/lookup`, `links/discover`, `listings`, `backlinks` and `documents`. They use the existing session, workspace and CSRF contract. Read endpoints stay scoped to the selected workspace, including for super-admins. Mutations, explicit refreshes, store search/lookup and link discovery require the `manage_content` capability; viewers can read reports (including automatic Search Console cache refresh) but cannot save or trigger discovery checks. These internal UI endpoints are not additional bearer-token routes under `/api/v1`.

Outbound requests use the existing HTTPS, private-address and redirect validation. Deployment-specific outbound exceptions remain controlled by the existing server configuration; the workbench does not weaken those controls.

The [112-cycle implementation log](IMPROVEMENT_CYCLES.md) records the delivered enhancements. **Link candidates** discovers links online and imports bounded public-crawl extracts for review, live-monitor promotion, notes, filters, exports, import history and investigation tasks. See the [candidate guide](CRAWL_CANDIDATES.md).

**Compare crawl extracts** retains each new import's observations (including duplicate pairs and their dates), compares two snapshots, and exports the filtered comparison without changing live backlink status. Historical receipts without snapshots remain unavailable for comparison.

Next idea (113): save named comparison presets for recurring extract reviews, recording the chosen sources and coverage assumptions.
