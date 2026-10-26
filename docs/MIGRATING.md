# Moving from OpenGSC and Porter Metrics

SEO Website Indexer covers what OpenGSC and Porter Metrics are typically used for, so one install can replace both. This guide maps the features, then walks through moving over without losing anything.

## What maps to what

| You use | In OpenGSC / Porter | In SEO Website Indexer |
| --- | --- | --- |
| Search Console performance | OpenGSC dashboard | **Insights → Search** for each site (clicks, impressions, CTR, position, queries, pages, countries, devices) |
| Striking-distance keywords, cannibalisation, content decay, CTR gaps | OpenGSC analysis modules | **Ranking playbook**, ranked by estimated clicks gained, with steps and measured results |
| Period-on-period comparisons | OpenGSC compare | **Insights → Search → What changed**: any period vs the one before or the same dates last year, by query, page, country or device |
| Content groups | OpenGSC content groups | **Insights → Search → Content groups**: pages grouped by URL rules, with each group's performance vs the previous period |
| Rank tracking | OpenGSC rank tracker | Tracked keywords on **Insights → Search** (Google position from Search Console, with alerts when a keyword drops) |
| GA4, Bing Webmaster | OpenGSC connections | **Connections** (GA4) and the Bing settings on each site |
| Site audits and alerts | OpenGSC audits, alerts | **Discovery** audits, **Action Centre** and alerts (index drops, schema and `llms.txt` drift, hygiene, quota, citations) |
| AI-search visibility | OpenGSC AEO tracker | **AI visibility** (question library across AI and search providers) |
| Google Business Profile reporting: calls, directions, map views | Porter Metrics | **Reviews → Insights** and the *Google reviews and Business Profile* section of scheduled reports |
| Reviews | — | **Reviews**: read, answer and approve AI-drafted replies, with alerts |
| Scheduled client reports | Porter Metrics reports | **Reports**: templates with chosen sections (search, local, Google Ads, AI visibility…), schedule and email recipients |
| Working with an AI assistant | OpenGSC MCP server | This app's MCP server at `https://<your-host>/mcp` (Search Console, playbook, comparisons, content groups, Google Ads and reviews tools) |

Not carried over on purpose: OpenGSC's private indexing network, PBN, expired-domain and footprint tools. They conflict with Google's spam policies and put client sites at risk.

## Move over

1. **Add your sites.** Under **Sites**, add each site with its sitemap URL, then connect the Google account that owns them in Search Console. Search Console history (Google keeps about 16 months) and GA4 come from Google directly, so nothing needs exporting from OpenGSC. Add Bing Webmaster on each site if you used it.
2. **Add Business Profile.** Open **Business Profile → Setup**, add Business Profile access to the same Google connection, apply once for Google's Business Profile API approval (the page walks you through it), then link your locations.
3. **Copy your OpenGSC setup with an assistant.** Connect both MCP servers — OpenGSC and this app — to the same AI assistant and paste the prompt below. It copies content groups and tracked keywords and checks the numbers match. Give this app's server SEO actions (`mcp:write`) when you connect it.
4. **Build your report.** Under **Reports**, create a template with the sections you want (for example Search momentum and Google reviews and Business Profile), set the schedule and recipients, and generate one to check it.
5. **Run both side by side** for a week or two. When you're happy, retire OpenGSC and disconnect the Google Business Profile source in Porter Metrics (and cancel its plan if you have one).

### Migration prompt

```text
You have two MCP servers connected: "OpenGSC" (the old tool) and "SEO Website Indexer" (the new one). Copy my setup from OpenGSC to SEO Website Indexer. Do not change or delete anything in OpenGSC.

1. Call list_sites on both servers and match sites by domain. If a site exists in OpenGSC but not in SEO Website Indexer, stop and tell me which, so I can add it first.
2. For each matched site, read its content groups in OpenGSC (for example get_content_groups). Recreate each one with save_content_group on SEO Website Indexer, keeping the name. Translate each URL pattern into rules: a path that pages start with → match "prefix" with a value starting with "/"; a fragment anywhere in the URL → "contains"; one specific page → "exact"; a regular expression → "regex". Put patterns that exclude pages into "exclude". List any pattern you couldn't translate exactly.
3. Read the tracked keywords in OpenGSC (for example get_rank_tracker) and add each one with track_query on SEO Website Indexer.
4. Check the data matches: for each site, compare the last 28 days of clicks and impressions from OpenGSC (get_search_performance or compare_periods) with SEO Website Indexer's compare_periods (days: 28). Differences of a few percent are normal (different date cut-offs and data freshness); flag anything over 10%.
5. Call list_content_groups on SEO Website Indexer to confirm each group has pages in it.

Finish with a table per site: content groups copied, keywords copied, clicks and impressions in each tool, and anything I need to do by hand.
```

Data pulls that read search terms per page from OpenGSC (keyword lists per page, cannibalisation checks) can use `get_query_page_performance` instead. It returns search terms and pages together for any dates, filtered and paged, straight from Search Console. Pass `fresh: true` to include the latest, not yet final, days.

Content groups and tracked keywords can also be added by hand: **Insights → Search → Content groups → Add group**, and the tracked keywords panel on the same page.
