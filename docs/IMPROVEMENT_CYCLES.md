# 112 improvement cycles

Baseline: the discovery workbench, SEO/GEO audit snapshots, Search Console opportunities, versioned ASO drafts, backlink imports/verification and initial responsive fixes were implemented first (commits `5fc33a5` and `65cfd7b`). The cycles below extend that baseline. A cycle is a specific implemented improvement, not a promise or an entire competing SaaS product.

Each entry records the idea, resulting behaviour and verification. Related cycles may share an integration test or final browser pass. Automatic checks measure observable conditions; editorial review prompts are not ranking guarantees.

| Cycle | Idea and implemented outcome | Verification |
| --- | --- | --- |
| 001 | Detect multiple page titles so publishers can repair ambiguous search metadata. | Dedicated HTML fixture passed; backend typecheck passed |
| 002 | Detect duplicate description tags rather than joining conflicting snippets silently. | Dedicated HTML fixture passed; backend typecheck passed |
| 003 | Identify conflicting canonical declarations, including distinct relative destinations. | Dedicated HTML fixture passed; backend typecheck passed |
| 004 | Flag HTTPS pages embedding HTTP resources that browsers may block. | Dedicated HTML fixture passed; backend typecheck passed |
| 005 | Check language-alternate declarations for malformed language tags or unsafe URLs. | Dedicated HTML fixture passed; backend typecheck passed |
| 006 | Check heading-level jumps as a reading and assistive-technology review. | Dedicated HTML fixture passed; backend typecheck passed |
| 007 | Find unnamed links while accepting accessible labels and linked-image alt text. | Dedicated HTML fixture passed; backend typecheck passed |
| 008 | Identify duplicate HTML IDs that can break anchors, labels and page navigation. | Dedicated HTML fixture passed; backend typecheck passed |
| 009 | Expose timed meta refresh navigation for review instead of hiding it behind a successful HTTP status. | Dedicated HTML fixture passed; backend typecheck passed |
| 010 | Surface restrictive mobile zoom settings as an accessibility finding. | Dedicated HTML fixture passed; backend typecheck passed |
| 011 | Build a sampled internal-link graph with unique incoming sources and unchecked destinations. | Dedicated page/link fixture passed; backend typecheck passed |
| 012 | Find possible orphan pages while explicitly limiting the claim to the observed sample. | Dedicated page/link fixture passed; backend typecheck passed |
| 013 | Locate the source pages linking to sampled HTTP errors, making broken-link repairs actionable. | Dedicated page/link fixture passed; backend typecheck passed |
| 014 | Show where internal navigation still points through redirects. | Dedicated page/link fixture passed; backend typecheck passed |
| 015 | Connect noindex observations to the internal pages linking to them, with intent-aware guidance. | Dedicated page/link fixture passed; backend typecheck passed |
| 016 | Check reciprocal language alternates when both linked pages were measured. | Dedicated page/link fixture passed; backend typecheck passed |
| 017 | Review language-alternate sets that omit the current page. | Dedicated page/link fixture passed; backend typecheck passed |
| 018 | Find generic anchor text for contextual accessibility review. | Dedicated page/link fixture passed; backend typecheck passed |
| 019 | Distinguish an invalid canonical declaration from one that is simply absent. | Dedicated page/link fixture passed; backend typecheck passed |
| 020 | Validate sharing-image URL schemes instead of accepting any non-empty metadata. | Dedicated page/link fixture passed; backend typecheck passed |
| 021 | Identify Apple keyword entries already represented in the name or subtitle. | Dedicated ASO fixture passed; backend typecheck passed |
| 022 | Detect wasted empty Apple keyword entries caused by repeated or trailing commas. | Dedicated ASO fixture passed; backend typecheck passed |
| 023 | Make target-term coverage word-aware so app does not match happy, while supporting CJK phrases. | Dedicated ASO fixture passed; backend typecheck passed |
| 024 | Normalise Unicode compatibility forms when checking target-term coverage. | Dedicated ASO fixture passed; backend typecheck passed |
| 025 | Deduplicate target terms across case and Unicode variants before saving drafts. | Dedicated ASO fixture passed; backend typecheck passed |
| 026 | Export store-ready plain text with field labels for easy handoff to the store console. | Frontend typecheck and production build passed |
| 027 | Duplicate a saved app listing into a new draft while preserving the original revision history. | Frontend typecheck and production build passed |
| 028 | Import exported ASO draft JSON into an unsaved draft with size and shape validation. | Frontend typecheck and production build passed |
| 029 | Turn uncovered user-supplied target terms into an explicit editorial review list without inventing demand. | Frontend typecheck and production build passed |
| 030 | Compare saved revision text with the current editor before restoring a previous listing. | Frontend typecheck and production build passed |
| 031 | Create a locale variant that preserves copy while requiring an explicit new locale. | Frontend typecheck and production build passed |
| 032 | Adapt a listing into a separate draft for the other store, then revalidate that store’s limits. | Frontend typecheck and production build passed |
| 033 | Search saved listings by app name or locale to keep larger ASO portfolios navigable. | Frontend typecheck and production build passed |
| 034 | Filter the saved ASO portfolio by store without hiding the currently edited draft. | Frontend typecheck and production build passed |
| 035 | Give listing fields stable accessible names and announce over-limit fields as invalid. | Frontend typecheck and production build passed |
| 036 | Save source-specific backlink review notes separately from machine observations. | Backend and frontend typechecks passed; production build passed |
| 037 | Pause and resume individual backlink monitoring while retaining all evidence and notes. | Backend and frontend typechecks passed; production build passed |
| 038 | Load backlink CSV exports directly from a local file, with the same size boundary as pasted data. | Backend and frontend typechecks passed; production build passed |
| 039 | Accept tab-separated backlink exports alongside quoted CSV files. | Backend and frontend typechecks passed; production build passed |
| 040 | Recognise common source and destination column names from external backlink exports. | Backend and frontend typechecks passed; production build passed |
| 041 | Preview valid, duplicate and rejected import rows without saving any backlinks. | Backend and frontend typechecks passed; production build passed |
| 042 | Recheck one chosen backlink source without cycling through the full monitoring queue. | Backend and frontend typechecks passed; production build passed |
| 043 | Retain each observed anchor, target and rel combination so mixed qualified links are not conflated. | Backend and frontend typechecks passed; production build passed |
| 044 | Highlight changes in anchor text, link attributes and destinations between successful checks. | Backend and frontend typechecks passed; production build passed |
| 045 | Add a referring-host breakdown to reveal where the tracked backlink portfolio is concentrated. | Backend and frontend typechecks passed; production build passed |
| 046 | Show anchor-text distribution using observed present links instead of imported marketing metrics. | Backend and frontend typechecks passed; production build passed |
| 047 | Filter observed backlinks by nofollow, sponsored or user-generated-content attributes. | Backend and frontend typechecks passed; production build passed |
| 048 | Export filtered backlink evidence as spreadsheet-safe CSV, including provenance and review notes. | Backend and frontend typechecks passed; production build passed |
| 049 | Separate active and paused backlink sources in the monitor without discarding historical evidence. | Backend and frontend typechecks passed; production build passed |
| 050 | Sort backlink reviews by oldest check, source hostname or newest import to prioritise the next investigation. | Backend and frontend typechecks passed; production build passed |
| 051 | Add a tenant-scoped content studio with saved, editable briefs for real audience questions and useful outlines. | Backend and frontend typechecks and production build passed |
| 052 | Attach source references and original evidence to content briefs, without fetching or fabricating citations. | Backend and frontend typechecks and production build passed |
| 053 | Capture the audience and reader intent so content plans solve a specific job instead of chasing generic keywords. | Backend and frontend typechecks and production build passed |
| 054 | Provide an evidence-led outline starter that prompts original answers, fair comparisons and clear limitations. | Backend and frontend typechecks and production build passed |
| 055 | Suggest internal-link candidates from actual audited page titles, with explicit relevance-review guidance. | Backend and frontend typechecks and production build passed |
| 056 | Generate a copyable writing prompt grounded in the saved brief and source notes, with explicit evidence-gap handling. | Backend and frontend typechecks and production build passed |
| 057 | Hand a saved content brief to the existing assigned-work workflow without publishing anything. | Backend and frontend typechecks and production build passed |
| 058 | Add a human review record covering evidence, accuracy, accessibility and the intended reader action. | Backend and frontend typechecks and production build passed |
| 059 | Expose the most recent 30 saved brief revisions so editorial decisions remain reviewable. | Backend and frontend typechecks and production build passed |
| 060 | Export complete content briefs as portable Markdown for self-hosted editorial workflows. | Backend and frontend typechecks and production build passed |
| 061 | Add a saved measurement-plan workspace for recording site changes and hypotheses before assessing results. | Backend and frontend typechecks and production build passed |
| 062 | Choose a primary observed metric and equal 7-, 14- or 28-day comparison windows, validated by the API. | Backend and frontend typechecks and production build passed |
| 063 | Measure saved plans against cached Search Console totals with weighted position and aggregate CTR. | Backend and frontend typechecks and production build passed |
| 064 | Suppress comparison deltas until both full periods have daily observations and the reporting-lag buffer has elapsed. | Backend and frontend typechecks and production build passed |
| 065 | Record seasonality, concurrent edits and other confounders alongside each measurement plan. | Backend and frontend typechecks and production build passed |
| 066 | Place new measurement plans on the existing workspace timeline with their date, hypothesis and metric. | Backend and frontend typechecks and production build passed |
| 067 | Visualise measured before and after values with labelled bars, preserving numeric values and coverage warnings. | Backend and frontend typechecks and production build passed |
| 068 | Save a human-reviewed outcome and learning notes without labelling an observational increase as a proven win. | Backend and frontend typechecks and production build passed |
| 069 | Archive completed measurement plans while preserving their saved hypotheses and results for later review. | Backend and frontend typechecks and production build passed |
| 070 | Export measured values, coverage, dates and methodology as spreadsheet-safe CSV for independent review. | Backend and frontend typechecks and production build passed |
| 071 | Add a local search-snippet preview and escaped metadata export without presenting character counts as ranking rules. | Dedicated tool fixture, frontend typecheck and production build passed |
| 072 | Campaign URL builder — create correctly encoded analytics campaign links. | Dedicated tool fixture, frontend typecheck and production build passed |
| 073 | Structured-data inspector — validate JSON syntax and inspect declared schema types. | Dedicated tool fixture, frontend typecheck and production build passed |
| 074 | Sitemap inspector — inspect XML, duplicate locations and URL-entry limits. | Dedicated tool fixture, frontend typecheck and production build passed |
| 075 | Language-alternate builder — generate escaped hreflang declarations and reject duplicate tags. | Dedicated tool fixture, frontend typecheck and production build passed |
| 076 | Robots declaration explorer — inspect crawler groups and flag unfamiliar or malformed directives. | Dedicated tool fixture, frontend typecheck and production build passed |
| 077 | Robots-meta builder — explain and prepare intentional indexing and snippet controls. | Dedicated tool fixture, frontend typecheck and production build passed |
| 078 | FAQ markup builder — prepare JSON-LD exclusively from supplied question-and-answer pairs. | Dedicated tool fixture, frontend typecheck and production build passed |
| 079 | Redirect-map inspector — identify duplicate sources, redirect chains and loops before deployment. | Dedicated tool fixture, frontend typecheck and production build passed |
| 080 | Conversion comparison — compare actual conversion rates with uncertainty intervals instead of invented uplift. | Dedicated tool fixture, frontend typecheck and production build passed |
| 081 | Run audits as persistent background jobs with capacity limits and explicit restart failure states instead of holding one long browser request. | Backend and frontend typechecks and production build passed |
| 082 | Show audit progress and reconnect the interface to a running job after navigation or refresh. | Backend and frontend typechecks and production build passed |
| 083 | Offer 10-, 25- and 50-page audit samples to balance coverage with self-hosted resource use. | Backend and frontend typechecks and production build passed |
| 084 | Keep sampled inventory URLs within the selected site’s host boundary and deduplicate fragment variants. | Backend and frontend typechecks and production build passed |
| 085 | Cancel an active audit with request aborts and an explicit cancelled state, without saving a misleading partial-success snapshot. | Backend and frontend typechecks and production build passed |
| 086 | Stop audit polling on unmount and clean up timers and requests while allowing the server job to finish independently. | Backend and frontend typechecks and production build passed |
| 087 | Bound link extraction and stored metadata, avoid recursive HTML traversal, and keep truncated backlink scans from becoming false missing-link claims. | Backend and frontend typechecks and production build passed |
| 088 | Check reciprocal hreflang declarations independently of anchor navigation, including head-only language links. | Backend and frontend typechecks and production build passed |
| 089 | Require comparable context before treating duplicate, orphan or internal-link findings as no longer observed. | Backend and frontend typechecks and production build passed |
| 090 | Load compact audit-history summaries and only the selected report, avoiding full-page payloads for all 30 historical snapshots. | Backend and frontend typechecks and production build passed |
| 091 | Order audit findings by severity and page so the most consequential work is consistently visible first. | Backend and frontend typechecks and production build passed |
| 092 | Add a page-evidence inspector showing measured metadata, headings, canonical, status and extracted content size. | Backend and frontend typechecks and production build passed |
| 093 | Protect edited ASO drafts, content briefs and measurement plans against accidental close or navigation, with explicit discard choices. | Backend and frontend typechecks and production build passed |
| 094 | Export the current filtered audit worklist as spreadsheet-safe CSV with evidence, next steps and source guidance. | Backend and frontend typechecks and production build passed |
| 095 | Replace the growing tool-tab grid with a compact labelled selector on phones while keeping direct tool URLs. | Backend and frontend typechecks and production build passed |
| 096 | Separate Google connection status from the user’s sign-in status so an offline provider is not mistaken for failed authentication. | Backend and frontend typechecks and production build passed |
| 097 | Improve phone touch targets, readable field labels and checkbox sizing across the new workspaces. | Backend and frontend typechecks and production build passed |
| 098 | Make the mobile drawer keyboard-safe with focus trapping, Escape dismissal, an internal close button and inert hidden navigation. | Backend and frontend typechecks and production build passed |
| 099 | Expose loading and retry states for audit history and clear stale evidence after a failed snapshot request. | Backend and frontend typechecks and production build passed |
| 100 | Add a portfolio evidence-coverage screen that distinguishes unmeasured sites, audit failures, data freshness, tracked backlinks and saved app listings. | Backend and frontend typechecks and production build passed |
| 101 | Import bounded public-crawl WAT/NDJSON metadata into a tenant-scoped candidate inbox with provenance and transactional preview. | Backend and frontend production builds passed |
| 102 | Add reversible candidate dismissal and inbox restoration while preserving historical evidence. | Backend and frontend production builds passed |
| 103 | Promote reviewed crawl candidates into live backlink monitoring without marking them verified or overwriting existing checks. | Backend and frontend production builds passed |
| 104 | Review up to fifty selected candidates in a bounded bulk action with per-candidate failure reporting. | Backend and frontend production builds passed |
| 105 | Keep private review notes on crawl candidates with explicit saving and permission checks. | Backend and frontend production builds passed |
| 106 | Add a searchable pending-review inbox with promoted and dismissed views and safe selection reset on filtering. | Backend and frontend production builds passed |
| 107 | Export the filtered candidate evidence and review notes as spreadsheet-safe CSV. | Backend and frontend production builds passed |
| 108 | Group candidate opportunities by referring host and drill into a host without inventing authority scores. | Backend and frontend production builds passed |
| 109 | Separate recent, older and undated crawl evidence so stale candidates do not masquerade as fresh links. | Backend and frontend production builds passed |
| 110 | Retain and display import receipts with crawl provenance, duplicate counts and rejection totals; previews leave no history. | Backend and frontend production builds passed |
| 111 | Turn historical backlink candidates into deduplicated investigation tasks with their source evidence attached. | Backend and frontend production builds passed |

| 112 | Retain bounded per-import observations and compare crawl extracts with dated anchor evidence, sample-aware absence labels, filters and CSV export; preserve live backlink states. | Backend comparison, retention and scope tests; frontend interaction tests; builds and lint |
