# Ranking playbook

The ranking playbook turns a website's Search Console data into a ranked list of concrete changes, each with the page to change, the evidence, numbered steps and an estimated range of monthly Google clicks gained. It answers one question: what should we change this week to earn more clicks?

Open **Insights → Playbook**. With all sites selected it shows a card per website; choose a website for its full playbook.

## What it needs

The playbook is computed from data the scheduler already collects. Nothing runs until a website has a linked Google account and Search Console property.

| Data | Where it comes from | What it unlocks |
| --- | --- | --- |
| Daily clicks, impressions and position per page | Search Console, synced after each run (90-day backfill on the first sync) | Content decay and the click-through comparisons. Decay needs at least 56 days. |
| Query × page window | Search Console, a 28-day window synced daily (up to 75,000 rows) | Which queries each page ranks for: snippet gaps, striking-distance queries and cannibalisation. |
| Page inventory | The run's page fetch (title, H1, meta description, word count, internal links) | Missing terms in titles, internal-link suggestions and the AI draft's context. |
| URL Inspection results | The run's inspection step | Not-indexed blockers and canonical checks. |
| Core Web Vitals per page | Chrome UX Report, optional API key | The protect list. |

The **Data readiness** tile lists what has synced. Query rows can be marked truncated on very large sites; the playbook then lowers the confidence of query-based items.

## What it finds

| Item | Raised when | What the steps say |
| --- | --- | --- |
| Snippet (`ctr_gap`) | A page ranks on page one but earns well under the click-through rate expected at its positions, in both halves of the window. | Rewrite the title and meta description around the main queries. A variant flags a measured title change that cut click-through and offers the previous title. |
| Striking distance | Queries at positions 4–15 with enough searches where the page already owns the query. | Put the main query in the title and H1 if it is missing, add sections that answer the queries, add internal links from related indexed pages. |
| Cannibalisation | Two pages each take a real share of the same queries, neither is in the top three, and neither is the other's canonical. | Consolidate (redirect the weaker page into the stronger one) or differentiate (retitle the weaker page for its own queries and link it to the stronger one). |
| Content decay | A page's clicks fell at least 30% against a conservative baseline, for three of the last four weeks, further than the site as a whole, with its position slipping. | Refresh the page and answer the queries it is losing. Drops caused by falling demand are recorded but not surfaced. |

Blockers sit above the list and carry no estimate: pages Google cannot index (fix first), a site-wide decline of 25% or more (check coverage and manual actions before refreshing pages), and Core Web Vitals failures on pages that earn clicks (protect what already works).

Brand queries are excluded throughout. The brand terms come from the domain, the first word of the site name and the dominant title suffix, and are listed in the summary.

## How estimates work

Every item shows an estimated range of monthly clicks gained, low to high. The range is a judgement from Search Console data, not a forecast:

- The expected click-through rate per position comes from the site's own query rows, shrunk towards an industry curve when a position has little data and smoothed so it never rises with position. The range widens when the curve is thin.
- The low figure assumes a conservative share of the measured gap closes (25–50% depending on the item); the high figure assumes a good outcome, never a perfect one.
- One item per page counts towards the site total; other items on the same page show their own range but are not added. The total is capped at 60% of the site's current monthly clicks and says so when the cap applies.
- Items with low confidence, or under five clicks a month, are hidden by default.

Small sites (under 20,000 impressions in the window) use halved minimums so they still get a list.

## Working the list

- **Details** shows the queries, current title and H1, the numbered steps with copy buttons, and the AI draft.
- **Draft with AI** asks the workspace's configured provider (Anthropic, OpenAI, Gemini, xAI or Perplexity, in that order of preference) for a title, two alternatives, a meta description, an H1, the content sections to add and internal-link anchors, written from the queries the page already ranks for. Titles over 60 characters or descriptions over 155 are sent back once; anything still wrong is listed under **Needs edit**. Claims the model could not verify are listed under **Unsure**. The draft is saved on the item for review; the tool never publishes it. Drafting counts against the workspace's AI budget and a per-user daily allowance (`AI_DRAFT_DAILY_LIMIT`, default 25; owners and super-admins are exempt).
- **Send to Work** creates an Action Centre item carrying the steps and the draft. The nightly run also sends the top three new items per website to the Action Centre on its own, with at most eight open per website.
- **Dismiss** keeps an item out of the list across recomputes. It is flagged as changed if its upside later doubles.
- **Mark done** (or finishing the Action Centre item) records the page's clicks at that moment. Thirty-one days later the **Results** section shows the realised change, adjusted for how the rest of the site moved, and whether it landed inside the estimated range.

Items whose signal disappears are resolved automatically and their Action Centre items close.

## Schedule and notifications

The playbook is recomputed at the end of every scheduled run, after the performance rollups, from stored data only. **Refresh from Google** forces a fresh query × page window and a recompute.

Workspaces with notification channels receive **Ranking playbook ready** at most once a week, with the number of opportunities, the combined estimated range and the top item per website. Turn it off under **Settings → Notifications**.

## Limits

- Google anonymises low-volume queries, so query rows undercount page totals. Snippet items fall back to page-level comparison, at low confidence, when fewer than 40% of a page's impressions are covered by query rows.
- Seasonality is not yet checked against last year. Content decay is therefore never rated high confidence.
- Positions between 11 and 20 mix devices and result types; items priced mostly from page two carry lower confidence.
- Estimates are ranges for prioritisation. The Results section is the only measurement of what a change achieved.
