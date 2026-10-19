# Google Ads

SEO Website Indexer can report on and manage the Google Ads accounts of the clients you look after. Each client is one workspace, so its ad accounts sit next to its websites, Search Console data and reports. You can work on the **Google Ads** page yourself, or connect any MCP-capable AI assistant (ChatGPT, Claude, Gemini, Cursor, VS Code, agent CLIs and others) and let an AI routine review and optimise the accounts on a schedule. Every change goes through the same monthly budgets and guardrails, whoever makes it.

- [How it fits together](#how-it-fits-together)
- [Set up](#set-up)
- [Clients, budgets and guardrails](#clients-budgets-and-guardrails)
- [How changes are made](#how-changes-are-made)
- [Connect an AI assistant](#connect-an-ai-assistant)
- [The AI routine](#the-ai-routine)
- [MCP tools](#mcp-tools)
- [Google's rules for API access](#googles-rules-for-api-access)
- [Troubleshooting](#troubleshooting)

## How it fits together

| Piece | What it does |
| --- | --- |
| Google connection | The Google user the app acts as. The opt-in Google Ads permission (`https://www.googleapis.com/auth/adwords`) is added to the same connection used for Search Console. |
| Linked ad account | One Google Ads customer linked to one workspace, with the client's monthly budget, brief and guardrails. Accounts under a manager (MCC) account are reached through that manager. |
| Change plan | Every change, from the dashboard or from an assistant, is first validated by Google (`validate_only`), then judged by the client's guardrails: ready to apply, needs approval, or blocked. The plans are also the change log. |
| MCP server | `https://YOUR-HOST/mcp`. Read tools mirror Google's open-source [google-ads-mcp](https://github.com/googleads/google-ads-mcp) server (`search`, `get_resource_metadata`, `list_accessible_customers`) and add audits, pacing, research helpers and guarded write tools. |
| AI routine | A prompt the app builds from your answers. You schedule it in your AI assistant (or run it from cron with an agent CLI); each run reviews, researches, changes or proposes, and logs what it did. |

The app talks to the Google Ads REST API (version `v26` by default; set `GOOGLE_ADS_API_VERSION` to move to a newer one). No extra service or container is needed.

## Set up

Open **Google Ads → Setup**. The checklist at the top shows what is left to do.

### 1. Connect Google with Google Ads access

- **Already connected for Search Console?** Click **Add Google Ads access** next to that connection. Google asks you to consent to the extra permission; everything the connection already had is kept (incremental authorisation), and no sites need relinking.
- **New connection:** click **Connect a Google account with Google Ads**. Sign in as the Google user that manages your clients, ideally the user on your manager (MCC) account.
- Leave **Let the app enable the Google APIs it needs** ticked to have the Google Ads, Search Console, Indexing and Analytics APIs switched on for you. This asks Google for Cloud access (`cloud-platform`). Managed Google Workspace accounts may then be asked to sign in again periodically; untick it and enable the APIs by hand if that becomes a nuisance.

The same options exist under **Settings → Google Accounts** (tick **Also allow Google Ads management**).

### 2. Enable the Google Ads API

If the checklist says the API is not enabled, click **Enable automatically** (needs the Cloud access above) or enable `googleads.googleapis.com` in the Cloud console for the project that owns your OAuth client.

### 3. Get production access for your Cloud project

Since 9 September 2026 Google Ads API access belongs to the **Google Cloud project that owns the OAuth client**; developer tokens are no longer used. A new project starts with **Test** access, which only reaches test accounts. Apply once on the project's [Google Ads API overview page](https://console.cloud.google.com/google/ads-apis/overview):

| Level | Daily operations | Notes |
| --- | --- | --- |
| Explorer | 2,880 on production accounts | Approved quickly. Excludes planning services, so `ads_keyword_ideas` is unavailable. |
| Basic | 15,000 | Needs brand verification for the project; approval is automated. Includes Keyword Planner. |
| Standard | Unlimited | Manual review. |

Google currently rejects projects on the Free Trial or with disabled billing: link a paid billing account first. With several clients and a daily routine, Basic is the comfortable choice.

### 4. Link your clients' ad accounts

Click **Find and link client accounts**. The app lists every account the connected users can reach, including clients up to two levels under a manager account, and links the ones you tick to the current workspace. Switch workspace (top-left) to link another client's accounts to that client's workspace.

### 5. Set budgets and guardrails

Open **Clients & guardrails** and edit each client: monthly budget, goal, targets, brief and guardrails (below). The AI routine questionnaire asks for the same answers and saves them here.

### Running your own OAuth client

If the container has no `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`, the Setup page shows a one-time guide:

1. Create or pick a Google Cloud project and link a paid billing account.
2. Enable the APIs — the page gives a copyable Cloud Shell command:

   ```bash
   gcloud services enable googleads.googleapis.com searchconsole.googleapis.com indexing.googleapis.com analyticsdata.googleapis.com --project YOUR_PROJECT_ID
   ```

3. Configure the consent screen (Google Auth Platform). Use **Internal** for a single Google Workspace; otherwise **External** and **Publish app**, because apps left in Testing get refresh tokens that expire after seven days.
4. Create an OAuth client of type **Web application** with the redirect URI `https://YOUR-HOST/api/auth/google/callback`. Google offers no API for creating these clients, so this is the one step that can't be automated.
5. Paste the client ID and secret when connecting, or set them on the container so every user gets one-click sign-in.
6. Apply for Google Ads API access (step 3 above).

## Clients, budgets and guardrails

### The brief

Goal, target CPA or ROAS, website, offer, audience, markets, competitors, brand voice, "never do" rules and notes. The assistant reads the brief before every run and can add what it learns (competitors, markets, notes) with `ads_update_client_brief`. It can't change the monthly budget or the guardrails — only a person can, on the dashboard.

### Modes

| Mode | Effect |
| --- | --- |
| Autopilot within limits (`guarded`) | Changes inside every rule below apply when the assistant (or you) applies them. Anything outside waits for approval. Default for new links. |
| Approve every change (`review`) | Every change waits for a person. Chosen automatically when the AI routine is set to *Propose only*. |
| Read-only (`read_only`) | No changes at all. |

### Rules

| Rule | Default | Outside the limit |
| --- | --- | --- |
| Projected month spend ≤ monthly budget (+ tolerance) | 0% tolerance | Needs approval. Projection = month-to-date spend + enabled daily budgets × remaining days (today included), in the account's time zone. |
| No monthly budget set | — | Any change that raises daily spend needs approval. |
| Largest daily-budget increase per change | 20% | Needs approval. |
| Largest bid change per change | ±25% | Needs approval. |
| Operations per change | 50 | Needs approval. |
| Turning paused campaigns on | Allowed | Optional approval; always subject to the monthly budget. |
| Bid strategy or CPA/ROAS target changes | Need approval | Can be allowed per client. |
| Removing campaigns, ad groups, ads, keywords or assets | Need approval | Can be allowed per client. |
| New campaigns created enabled | Always need approval | Create them paused. |
| Conversion actions, conversion goals, account settings | Always need approval | — |
| Applying budget, bidding, broad-match or Performance Max recommendations | Always need approval | — |

Shared budgets are counted once. Cutting spend is always inside the limits.

## How changes are made

1. **Propose.** A change tool (or the dashboard) builds REST `MutateOperation`s. Google validates them with `validate_only=true`; if Google rejects them the plan is stored as *failed* with Google's message. Otherwise the guardrails set the status: **Ready to apply** (`pending`), **Needs approval** or **Blocked**.
2. **Apply.** `ads_apply_change` applies a *pending* plan. The guardrails are checked again against fresh account state first, so two changes can't add up to more than the budget allows. A plan that now needs approval is left for a person.
3. **Approve.** On **Approvals & history**, *Approve & apply* applies a waiting plan straight away (a person's approval overrides approval rules, never *blocked* or read-only). *Reject* closes it.
4. **Revert.** *Revert* proposes the opposite of an applied change: previous budgets, bids and statuses are restored and anything it created is removed. The revert is a normal plan with the normal guardrails.

Plans expire after 24 hours if they aren't applied. Each applied change is recorded in the audit log (`google_ads.change_applied`) and in usage (`google_ads` / `mutate`, counted in operations), so workspace usage budgets can cap it.

## Connect an AI assistant

Any AI assistant that supports remote MCP servers can use the app: chat apps, IDEs and agent CLIs. Use **Governance & usage → API & webhooks → Connect an AI assistant** or the card at the bottom of **Google Ads → Setup**; it shows copyable setup for each client below.

### Recommended: OAuth sign-in

Add the server URL `https://YOUR-HOST/mcp` to your AI app. The app discovers this server's sign-in, opens it in your browser, and you sign in and choose what it may do:

- **Read your data** — always included;
- **Run SEO actions** (`mcp:write`);
- **Manage Google Ads** (`ads:write`) — needed for routines that make or propose changes.

The client then receives a one-hour access token and a 30-day rotating refresh token. Disconnect it under *Connected apps* at any time.

| Client | How to add the server |
| --- | --- |
| ChatGPT | Turn on developer mode for apps and connectors (Settings → Apps & Connectors → Advanced settings), create an app/connector with the URL and choose OAuth. Availability depends on the plan. |
| Claude (web, desktop, Cowork) | Settings → Connectors → Add custom connector, paste the URL, leave the OAuth client fields empty. |
| Claude Code | `claude mcp add --transport http seo-indexer https://YOUR-HOST/mcp`, then `/mcp` to sign in. |
| Codex CLI | `codex mcp add seo-indexer --url https://YOUR-HOST/mcp`, then `codex mcp login seo-indexer`. |
| Cursor | Add `{"mcpServers": {"seo-indexer": {"url": "https://YOUR-HOST/mcp"}}}` to `~/.cursor/mcp.json`, enable it and sign in. |
| Gemini CLI | `gemini mcp add --transport http seo-indexer https://YOUR-HOST/mcp`, then `/mcp auth seo-indexer`. |
| VS Code | Add `{"servers": {"seo-indexer": {"type": "http", "url": "https://YOUR-HOST/mcp"}}}` to `.vscode/mcp.json`, start it and sign in. |
| Anything else | Give it the URL. OAuth-capable clients find the sign-in automatically; others use a registered client or a personal token (below). |

Menu names in hosted apps change from time to time; the server URL and OAuth flow stay the same.

How clients identify themselves — all supported:

- **Dynamic client registration** (RFC 7591) — most clients.
- **Client ID Metadata Documents** — the client's `client_id` is an `https` URL to a JSON document listing its name and redirect URLs. The document is fetched through the app's outbound-URL guard and cached for an hour.
- **A client you register on the dashboard** — for apps that ask for a client ID and secret (and sometimes the authorization and token URLs). Under *Apps that need a client ID*, enter the redirect URL the app shows you; the app gives you the client ID, secret, authorization URL and token URL.

The server implements OAuth 2.1: protected-resource and authorisation-server metadata (RFC 9728/8414), authorisation code with PKCE (S256 only), issuer identification in the authorisation response (RFC 9207), refresh-token rotation and revocation (RFC 7009). Loopback redirects (`http://127.0.0.1`/`localhost`) may use any port, as native apps and CLIs pick a free port at sign-in (RFC 8252). `/mcp` also answers CORS requests, so browser-based MCP clients work; it never uses cookies. Set `PUBLIC_URL` so the advertised issuer and endpoints use your public HTTPS address, and consider `MCP_OAUTH_REDIRECT_ALLOWLIST` so only the AI apps you use can register (see [deployment](DEPLOYMENT.md)).

### Alternative: personal token

For clients that can only send a fixed header (for example workflow tools), create a token with **SEO actions** and/or **Google Ads changes** ticked and send it as `Authorization: Bearer seomcp_…`. A `?token=` URL also works for clients that can't send headers, but the token can then appear in reverse-proxy access logs — prefer OAuth.

### What a token can do

A token (OAuth or personal) reaches every workspace its owner can reach, and never more than the owner could do in the dashboard: viewers stay read-only, editors need the **Manage Google Ads** capability, and workspace MFA requirements apply.

## The AI routine

Open **Google Ads → AI routine** and answer:

1. **Which clients** it should look after.
2. **Each client's monthly budget and goal** (budget is required), targets, website, offer, markets, known competitors and "never do" rules. Answers are saved to the client.
3. **How often** it runs: daily, weekdays, twice a week or weekly, at a time and time zone; and the comparison window.
4. **How much freedom:** *Autopilot within guardrails* (clients set to `guarded`) or *Propose only* (clients set to `review`, enforced by the server). Research depth (light, standard, deep) and focus areas: pacing, waste, budget shifts, bids, ads, keywords, recommendations, new campaigns.

**Save answers and build the prompt** produces the prompt, the schedule in words and as a cron expression. Then:

1. Connect the MCP server to your AI assistant (above) with **Manage Google Ads** allowed.
2. Schedule the prompt at the chosen cadence — in the assistant's scheduled tasks or automations, or with cron on a server running an agent CLI. The page shows a crontab example for Claude Code (`claude -p`), Codex CLI (`codex exec`) and Gemini CLI (`gemini -p`); the CLI needs the server added and signed in, and permission to call its tools and web search without asking.
3. Make sure the MCP server and web search are enabled for the task.

Each run works client by client: brief and pacing → performance → audit and search terms → market and competitor research → changes through the change tools → `ads_record_routine_run`. Runs appear under **Routine log**, and anything outside the guardrails waits under **Approvals & history**.

## MCP tools

Read tools need `mcp:read`; change tools need `ads:write`. `account` accepts the app's account id or the Google Ads customer ID.

| Tool | Purpose |
| --- | --- |
| `ads_list_clients` | Linked accounts with budget, brief and guardrails. Start here. |
| `ads_get_client_brief` | One client's brief, waiting approvals and recent routine notes. |
| `ads_update_client_brief` | Save competitors, markets, offer, audience, website, notes. |
| `ads_list_accessible_customers` | Same as Google's `list_accessible_customers`. |
| `ads_discover_accounts` | Every reachable account, including manager hierarchies, and whether it is linked. |
| `ads_link_account` | Link an account to a workspace (verifies access first). |
| `ads_search` | Same contract as Google's `search`: fields, resource, conditions, orderings, limit. |
| `ads_query` | Run a complete GAQL query. |
| `ads_get_resource_metadata` | Same as Google's `get_resource_metadata`: selectable, filterable and sortable fields. |
| `ads_account_overview` | KPIs vs the previous period, daily series, campaigns, impression share lost, pacing. |
| `ads_budget_pacing` | Month-to-date spend, projection and recommended daily total. |
| `ads_audit_account` | Conversion tracking, pacing, budget/rank-limited campaigns, wasted search terms, Quality Score, policy, ad coverage and strength, optimisation score. |
| `ads_search_terms` | Search terms report, optionally non-converting only. |
| `ads_list_recommendations` | Google's recommendations with estimated impact. |
| `ads_keyword_ideas` | Keyword Planner ideas from seeds and/or a URL (Basic access). |
| `ads_find_locations` | Geo target IDs by place name. |
| `ads_list_changes`, `ads_get_routine_history` | Change log and routine notes. |
| `ads_set_status` | Pause, enable or remove campaigns, ad groups, ads, keywords, criteria, asset groups. |
| `ads_update_budget` | Set a campaign's daily budget. |
| `ads_update_bids` | Keyword and ad-group CPC bids. |
| `ads_add_keywords`, `ads_add_negative_keywords` | Keywords; negatives at campaign, ad group or shared-list level. |
| `ads_create_responsive_search_ad` | RSA with validation of Google's limits; created paused by default. |
| `ads_update_bidding_strategy` | Maximise conversions/value, maximise clicks, manual CPC, targets. |
| `ads_create_search_campaign` | Budget, paused campaign, targeting, ad group, keywords and ad in one atomic change. |
| `ads_mutate` | Any other `GoogleAdsService.Mutate` operations (assets, schedules, modifiers, audiences, experiments…). |
| `ads_recommendations` | Apply or dismiss recommendations. |
| `ads_apply_change`, `ads_revert_change` | Apply a pending plan; propose a revert. |
| `ads_record_routine_run` | Log a routine run for the dashboard and the next run. |

## Google's rules for API access

Google's [developer policy](https://support.google.com/adspolicy/answer/6169371) now prohibits third-party hosted interfaces, wrappers and MCP servers that only re-expose Google Ads API capabilities, and services that route multiple independent businesses through shared developer access. It explicitly allows your own programmatic use and open-source tools that users run with their own credentials, and expects agencies and advertisers to use their own Google Cloud accounts.

This app is self-hosted open-source software, so the safe pattern is:

- run it yourself with **your own** Google Cloud project and OAuth client;
- reach client accounts through **your own** manager (MCC) account;
- don't let clients sign in to your install with their own Google accounts on your project. If a client wants direct access, connect them with their own OAuth client (**Use a different Google Cloud project** when connecting) or give them their own install.

## Troubleshooting

Errors from Google are translated into a message and a next step.

| Message | Fix |
| --- | --- |
| *No Google Ads access* / insufficient scopes | Use **Add Google Ads access** on the connection. |
| *API not enabled* (`SERVICE_DISABLED`) | **Enable automatically**, or enable `googleads.googleapis.com` on the OAuth client's project. |
| *Test access only* (`CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`) | Apply for Explorer or Basic access; link paid billing first. |
| *User doesn't have permission to access customer* | Relink the account from its manager so the login customer ID is set, and check the Google user's access in Google Ads → Admin → Access and security. |
| Quota exceeded | Explorer allows 2,880 operations a day across all clients; apply for Basic. |
| Keyword ideas fail on Explorer | Planning services need Basic access. |
| Reconnect required | The refresh token was revoked or expired; reconnect the Google account. Publish the OAuth app so tokens don't expire after seven days. |
| *The server couldn't connect to googleads.googleapis.com* (`ENOTFOUND`, `ECONNREFUSED`, a timeout…) | The request never reached Google. Ad-blocking DNS (Pi-hole, AdGuard Home, NextDNS) often blocks Google Ads domains: allow `googleads.googleapis.com`, check the server's firewall for outbound HTTPS, then click **Scan again**. Search Console can keep working because it uses other hosts. |
| Google sign-in fails with `redirect_uri_mismatch`, or the callback starts with `http://` | The app is behind an HTTPS reverse proxy but builds its links from the plain-http request. Set `PUBLIC_URL=https://your-host` (or `TRUST_PROXY=true` if the proxy sends `X-Forwarded-Proto`) and restart. The dashboard shows a warning until this is fixed. |
| The AI app says the server failed to authenticate | Check `PUBLIC_URL`, that the reverse proxy forwards `/.well-known/*`, `/oauth/*` and `/mcp`, that the app's redirect URL is in `MCP_OAUTH_REDIRECT_ALLOWLIST` if you set it, and remove and re-add the server. |
| The AI app asks for a client ID and secret | Register a client under *Apps that need a client ID* with the redirect URL the app shows. |
