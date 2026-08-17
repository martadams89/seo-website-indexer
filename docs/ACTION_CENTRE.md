# Action Centre

The Action Centre turns audit findings, connector failures and manual tasks into page-level repair work. Each action keeps the affected website, page, evidence, owner and verification history together.

## Everyday workflow

1. Filter by website, status or priority, or search for any page URL or evidence value.
2. Copy the page URL directly, or select **Copy brief** for an LLM-ready diagnosis prompt containing the site, page, issue and observed evidence.
3. Open **Review fix** to inspect the human-readable evidence. Findings that affect several pages provide a page selector.
4. Add a deployment reference or note and select **Record fix deployed**. This moves an open action into **In progress** without pretending the outcome has been verified.
5. If the website has a shared Google connection, select **Re-submit & check Google**.
6. Review Google's current coverage, fetch, robots, crawl and canonical evidence, then select **Mark resolved**. Reopen the action if the issue returns.

The timeline and audit log retain each deployment, Google check, resolution and reopen event. Changing the generic status alone remains available, but the guided buttons produce a more useful evidence trail.

## What the Google button does

For an ordinary web page, Google does not provide a general Search Console API that marks an issue fixed or requests immediate reindexing. The Action Centre therefore performs the supported workflow:

1. re-submit the website's configured sitemap to Search Console;
2. run a fresh URL Inspection for the selected page;
3. save the returned verdict and index evidence on the action; and
4. update the local URL history and usage ledger.

It does not automatically resolve the action or promise that Google will crawl the page on a particular schedule. A passing verdict means Google currently reports the inspected page as indexed; other results remain visible for diagnosis.

Google's separate Indexing API is not used for ordinary pages because it only supports pages containing `JobPosting` or a livestream `BroadcastEvent` in a `VideoObject`. See the official [Indexing API rules](https://developers.google.com/search/apis/indexing-api/v3/quickstart), [URL Inspection reference](https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult) and [sitemap submission reference](https://developers.google.com/webmaster-tools/v1/sitemaps/submit).

## Google access required

The website must have a Google account selected under **Sites & Submissions**. The OAuth grant needs the Search Console `webmasters` scope, and that Google identity must have access to the configured URL-prefix or domain property.

The connected account can belong to the current user or be shared with the workspace. Workspace members can run the check without seeing its OAuth tokens. Their workspace role must include **Manage content and actions**.

URL Inspection has a per-property daily allowance. The application tracks successful inspections across scheduled and Action Centre checks and returns a clear limit message instead of exceeding the configured `GSC_INSPECTION_DAILY_LIMIT`.

See [integration permissions](INTEGRATIONS.md) for OAuth setup and [indexing setup](INDEXING.md) for property, sitemap and account troubleshooting.

## Creating a manual action

Choose a website and paste its full affected page URL whenever the task is page-specific. The API rejects URLs outside the selected Search Console property, including lookalike domains. Choose **Workspace-wide** only for work that genuinely has no single website.

Use normal prose in the title and description. Structured evidence from automated audits is rendered as labelled fields; no JSON editing is required.

## Common problems

| Message or state | What to check |
| --- | --- |
| Google button is unavailable | The action needs a website, an exact page URL and a Google account linked to that website. |
| Page URL rejected | Use a page covered by the site's exact URL-prefix property or its domain property. |
| Sitemap not accepted | Confirm the configured sitemap URL is public and the connected Google identity can manage the Search Console property. The URL Inspection result is still retained if it succeeds. |
| Inspection needs attention | Read coverage, fetch, robots and canonical fields in the Google evidence card; copy the updated repair brief if another code or content change is required. |
| Daily limit reached | Wait for the next quota day or review `GSC_INSPECTION_DAILY_LIMIT`; do not raise it beyond the allowance available to the Google property. |

