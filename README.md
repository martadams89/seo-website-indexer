<div align="center">

# SEO Website Indexer

**A self-hosted SEO, GEO, ASO, Google Ads and Google reviews workbench for indexing, search performance, paid search, local reputation, backlinks, content and website operations across multiple clients or teams — with an MCP server so any AI assistant (ChatGPT, Claude, Gemini, Cursor, VS Code, agent CLIs…) can do the work on a schedule.**

[![CI](https://github.com/martadams89/seo-website-indexer/actions/workflows/ci.yml/badge.svg)](https://github.com/martadams89/seo-website-indexer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/martadams89/seo-website-indexer?logo=github)](https://github.com/martadams89/seo-website-indexer/releases)
[![Container](https://img.shields.io/badge/container-ghcr.io-blue?logo=docker)](https://github.com/martadams89/seo-website-indexer/pkgs/container/seo-website-indexer)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)

It runs as one Docker container with a built-in SQLite database. There is no separate database, queue or worker service to maintain.

</div>

## What it does

SEO Website Indexer brings the routine work around technical SEO and AI search visibility into one place. It watches sitemaps, submits changes, records what happened, joins data from connected services and gives teams a clear list of work that needs attention.

| Area | What you can do |
| --- | --- |
| Indexing | Submit changed sitemaps to Google Search Console and changed URLs to IndexNow or Bing Webmaster. Send removal notices for retired pages, and act on Google's inspection and sitemap feedback. Inspect and clear failed submissions from the dashboard. See exactly what Google's APIs can and can't do, and get a prioritised "Request indexing" queue with copyable prompts for a browser agent. |
| Google Ads | Link each client's ad accounts (including through a manager account), set monthly budgets and guardrails, see performance, pacing and an audit, and approve, reject or revert changes. An AI routine builder turns a short questionnaire into a ready-to-schedule prompt for any MCP-capable assistant that reviews, researches competitors and optimises spend inside the guardrails. |
| Google Business Profile | Link each client's Business Profile locations, read and answer reviews, edit the profile (description, phone, website, opening and holiday hours), publish posts and photos, catch edits Google or the public made, and see calls, website clicks, direction requests and the searches that found each profile. A completeness checklist shows what each profile is missing. Per-location rules decide what an AI assistant may publish on its own. Locations can use their own Google account or Cloud project, for example the one Google approved for Business Profile. |
| Search performance | Track coverage, clicks, impressions, queries, pages, countries, devices, crawl freshness and Core Web Vitals. Compare any period with the one before or last year, see the biggest gainers and losers, and report on content groups (pages grouped by URL rules). Find orphaned and weakly linked pages with suggested links, measure title/description changes by click-through rate, and rank page-level Core Web Vitals failures by traffic. |
| Ranking playbook | A ranked list of what to change to earn more Google clicks: snippet rewrites, striking-distance pages, cannibalising pairs and decaying content, each with evidence, steps, an estimated monthly click range and an AI-drafted fix for review. Done items are measured after 31 days. Search opportunities automatically fetches query history, shows lower-volume queries and highlights priority opportunities. |
| AI visibility | Build and edit a structured buyer-question library, test it across supported AI and search providers, distinguish direct website citations from third-party marketplace/profile citations and brand mentions, compare competitors and safely upgrade older prompt history. |
| Site checks | Audit broken links, redirect chains, structured data, `robots.txt`, AI crawler access and `llms.txt`, with change-only history for live and deployed discovery files. |
| Discovery workbench | Inspect page evidence and audit changes, discover and verify backlinks online, search Apple and Google Play for listing drafts and content briefs, measure changes and use ten local technical tools. See portfolio evidence coverage without a paid SEO subscription. |
| Markets and entities | Discover brand, organisation or local-business facts from a site's public structured data, review them in normal fields and monitor listing consistency by market. |
| Data and integrations | Bring together GA4, PageSpeed, Cloudflare, Plausible, Matomo, server logs and external rank data. Switch Unified Intelligence between one site, the full portfolio or workspace-wide evidence; every signal names its website, source, scope, trend and suggested next step. |
| Work and publishing | Select multiple work items to start, resolve, dismiss, reopen or assign together. Repair findings with website/page context, copyable LLM briefs, deployment notes and saved Google verification; use approval-based publishing flows for WordPress, Shopify and Webflow. |
| Reports | Build scheduled reports with the sections you choose — search, Google reviews and Business Profile (calls, directions, views), Google Ads, AI visibility — send digests and provide an authenticated, read-only Executive View. |
| Teams and governance | Separate clients with workspaces, control permissions, share or bring your own connected accounts, audit admin activity, set usage budgets and use scoped API tokens. |

All external services are optional. A basic install can run sitemap checks and IndexNow without connecting an analytics or AI provider.

## Quick start

```bash
docker run -d \
  --name seo-indexer \
  --restart unless-stopped \
  -p 3000:3000 \
  -v seo-indexer-data:/data \
  ghcr.io/martadams89/seo-website-indexer:latest
```

Open [http://localhost:3000](http://localhost:3000). The first account created on a new installation becomes the super-admin.

You can also use the supplied Compose file:

```bash
curl -O https://raw.githubusercontent.com/martadams89/seo-website-indexer/main/docker-compose.yml
docker compose up -d
```

For an internet-facing installation, set a stable `APP_SECRET`, keep `/data` on persistent storage, put the app behind HTTPS and configure backups before adding credentials. See the [deployment guide](docs/DEPLOYMENT.md).

## First setup

After signing in:

1. Create or select a workspace.
2. Add a site and its sitemap URL under **Sites**.
3. Connect a Google account if you want Search Console data and submissions.
4. Put the site's IndexNow key file in place if you want URL submissions.
5. Add any analytics, AI, publishing or notification services you need.
6. Run an audit first, review the result, then enable scheduled submissions.
7. For paid search, open **Google Ads → Setup**: add Google Ads access to a Google connection, link your clients' ad accounts, set their monthly budgets and build an AI routine.
8. For local clients, open **Business Profile → Setup**: add Business Profile access (or connect the Google account or Cloud project Google approved for it), apply once for Google's Business Profile API approval if needed, then link their locations.

The [indexing guide](docs/INDEXING.md) covers Google OAuth, IndexNow verification, Bing, sitemap `lastmod`, `llms.txt` routing, failed-submission recovery, what Google's indexing APIs can and can't do, and requesting indexing with a browser agent.

The [Google Ads guide](docs/GOOGLE_ADS.md) covers Cloud project access levels, linking client accounts, budgets and guardrails, approvals, connecting an AI assistant and the AI routine. The [Google Business Profile guide](docs/REVIEWS.md) covers API approval, using a separate Google account or Cloud project, reply and profile rules, posts and photos, Google-suggested edits, alerts and working with an assistant.

The [Action Centre guide](docs/ACTION_CENTRE.md) explains the page-level repair flow, copyable issue briefs and the supported Search Console sitemap plus URL Inspection check. The [ranking playbook guide](docs/RANKING_PLAYBOOK.md) explains how opportunities are found, estimated and measured.

For brand and local knowledge, **Markets & Entities** can read public JSON-LD and page metadata from a configured site, turn the result into editable fields and keep the approved record as a workspace source of truth. See the [markets and entities guide](docs/MARKETS_AND_ENTITIES.md) for setup, examples and score semantics.

AI visibility uses that reviewed identity when classifying stored and future answers. A citation can therefore count when it points to your own site, a known App Store/Google Play/review-marketplace profile, or names the tracked brand without linking the website. The interface keeps those evidence types separate so indirect visibility is not misreported as a direct backlink.

The [Discovery workbench guide](docs/DISCOVERY.md) covers website audits, online backlink and candidate discovery, imports and monitoring, app-store search and drafts, content planning, measured changes and local technical tools. The [112-cycle implementation log](docs/IMPROVEMENT_CYCLES.md) lists the individual improvements. The [public-crawl candidate guide](docs/CRAWL_CANDIDATES.md) explains supported extracts, review, live verification, exports and resource limits.

### Automatic discovery

- **Search opportunities:** select a site to fetch its Search Console query history automatically. Google must be linked to that website with an accessible property; sync failures appear in the report. **All queries** includes observations below the priority threshold.
- **App store studio:** search Apple App Store or Google Play by app or publisher, preview public metadata and use it as a new editable draft. Delete saved ASO drafts, content briefs and measurement plans with confirmation. Private store fields remain blank.
- **Backlinks / Link candidates:** choose **Discover** to search online and inspect source pages. Uses configured Brave Search or public Bing search, connected Bing Webmaster link reports and saved AI citation sources. No upload is required; coverage depends on the sources available.

See the [Discovery guide](docs/DISCOVERY.md) for setup, source limits and verification semantics.

### Seeing updates in a Docker installation

Merging a feature into `main` updates the source. The published `latest` image changes after a tagged release's **Build & Publish Docker Image** workflow succeeds. Pulling an image alone does not replace an already-running container. With the supplied Compose configuration:

```sh
docker compose pull seo-indexer
docker compose up -d seo-indexer
```

Then reload the browser and open **Discovery**. Installations pinned to a version tag must update that tag first. The existing data volume is retained.

## Users and workspaces

A workspace is the tenant boundary. Sites, connected accounts, API keys, analytics, reports, notifications, usage and audit records belong to a workspace. A user sees only the active workspace unless they are a super-admin.

| Role | Access within a workspace |
| --- | --- |
| Owner | Full control, including ownership and deletion. Each workspace has one owner. |
| Admin | Runs the workspace and manages its members. Platform-wide user recovery and workspace ownership remain super-admin functions. |
| Editor | Can operate sites, integrations, notifications, publishing, reports and governance by default. Individual capabilities can be removed. |
| Viewer | Read-only. Write operations are blocked by the API as well as the interface. |

Workspace owners, admins and editors can do normal day-to-day work according to their capabilities. Super-admins can manage every user and workspace, including memberships, permissions, profile details, generated temporary passwords, reset emails, 2FA recovery, account disablement and audited impersonation.

Google connections belong to the person who adds them and can be shared with workspaces they can access. Members may use a connection already shared with their workspace or connect their own Google account when their role allows it.

See [users and workspaces](docs/USERS_AND_WORKSPACES.md) for invitations, capability overrides, account sharing, recovery and tenant rules.

## Connected services

Connections are configured in the dashboard and scoped to the active workspace unless clearly marked as a platform setting.

| Purpose | Supported services |
| --- | --- |
| Search and indexing | Google Search Console, IndexNow, Bing Webmaster |
| Paid search | Google Ads (API v26, access through your own Google Cloud project) |
| Local | Google Business Profile: reviews, replies, profile edits, posts, photos and performance (needs Google's one-time API approval for your Cloud project). Clients can connect their own Google account through your approved project with a connect link. |
| Analytics and performance | Google Analytics 4, PageSpeed and CrUX, Cloudflare, Plausible, Matomo |
| AI visibility | OpenAI, Anthropic, Gemini, Perplexity, xAI, Brave Search |
| Publishing | WordPress, Shopify, Webflow |
| Notifications | Email (with named lists), WhatsApp, Slack, Discord, ntfy, Telegram, generic webhooks; per-event routing and links to approve or reject AI proposals |
| Other data | Server-log ingestion and external rank feeds through the API |

Workspace-specific API keys override any platform default set by a super-admin. This allows one installation to use shared keys, client-owned keys or a mixture of both.

See the [integration permission and setup guide](docs/INTEGRATIONS.md) for the exact OAuth scopes, provider roles, token permissions, callback URLs, value locations and troubleshooting steps for every service in this table. The same minimum-access guide is available from each connection modal in the dashboard.

### Why does my Google connection keep expiring?

Once connected, the app keeps a Google account signed in indefinitely: it stores an offline refresh token, refreshes the access token automatically, and a background keep-alive task refreshes tokens shortly before they expire. You should only ever OAuth once. If Google **forces you to reconnect every few hours or days**, Google itself is expiring the grant — no app setting can override that. There are two causes:

- **Google Workspace (business) account — reauthentication every few hours** (the refresh fails with `invalid_grant` / `invalid_rapt`). Your Workspace's **Google Cloud session control** policy is expiring the session, and the connection is subject to it only because it carries a Google Cloud scope (the optional "Auto-configure Google APIs" box, which requests `cloud-platform`). Fix it one of two ways:
  - **Keep the Cloud scope:** in [Google Admin console](https://admin.google.com) → **Security → Access and data control → Google Cloud session control**, set the reauthentication frequency longer (max 24h) or to never, **or** add this app under **Apps access control → Trusted apps** and tick **"Exempt trusted apps"** in the Cloud session control setting. ([Google's guide](https://support.google.com/a/answer/9368756).)
  - **Drop the Cloud scope:** click **Reconnect** on the account with **"Auto-configure Google APIs" unchecked**. Search Console, Analytics, the Indexing API and Google Ads all work without it, and the connection then leaves Cloud session control entirely. (Versions up to v1.43.0 silently re-added a previously granted Cloud scope on reconnect, so update before reconnecting.)
- **Reconnect every 7 days (any account type):** the Accounts page shows *"Google issued a time-limited refresh grant"*. Your OAuth app's consent screen is still in **Testing**, so Google issues refresh tokens that expire after 7 days, whatever scopes you pick. In Google Cloud Console → **Google Auth Platform → Audience**, set the user type to **Internal** (Google Workspace) or click **Publish app**, then reconnect.

The Accounts page shows the exact Google error and the matching fix on any account that needs reconnecting.

### New permissions and switched-off APIs

Google never adds a permission silently: a new scope always needs one consent click. The app works out what each connection needs and asks only for that:

- **Missing permissions.** If a connection is linked to Google Ads clients or Business Profile locations but its grant lacks that scope (or lacks Search Console, Indexing or Analytics for the sites using it), **Settings → Google Accounts** lists what's missing and why, with an **Update permissions** button. It opens Google's consent screen for that account, keeps everything already granted and adds the rest. Nothing is disconnected and the refresh token keeps renewing.
- **Switched-off APIs.** Every 30 minutes, and whenever you open that page, the app checks the APIs each connection uses (Search Console, Analytics Admin, Google Ads, Business Profile). Anything Google reports as disabled gets a Cloud console link and a **Switch them on for me** button. That button starts a one-off sign-in that asks for Cloud access, uses it once to enable the APIs, and keeps nothing. The saved connection never carries the Cloud scope, so Workspace Cloud session control can't expire it. Your Google user needs the Service Usage Admin (or Owner/Editor) role on the project.
- **Several Google accounts in one browser.** Every Google sign-in shows Google's account chooser, including reconnects and adding access, so the browser's default Google account never gets picked for you. A reconnect that comes back as a different account changes nothing and says so. The sign-in window opens straight from the click so pop-up blockers leave it alone; if pop-ups are blocked anyway, the sign-in continues in the same tab and returns you to the page you started from.
- **Several accounts and projects.** Google grants API access and quota per Cloud project, so a workspace can use one project for Search Console, another for Google Ads and another for Business Profile, with the same or different Google users. A Google user can be connected once per project, and a connection can be limited to Google Ads or Business Profile only. New sign-ins pick a project the app already knows, so its OAuth client is never re-entered. See [Several Google accounts and projects](docs/GOOGLE_ADS.md#several-google-accounts-and-projects).
- **Alerts.** A banner on every page says when a connection needs attention. Each workspace also gets a notification (event *Google connections*) when a connection needs reconnecting, a permission or an API, sent once per change rather than every hour.

## How indexing works

Each scheduled run reads a site's configured sitemap and any additional `Sitemap:` entries in `robots.txt`. It compares the current URLs and `lastmod` values with the previous run, then submits only new or changed content where the receiving service supports it.

| Content | Google Search Console | Bing Webmaster | IndexNow |
| --- | :---: | :---: | :---: |
| HTML pages | Yes | Yes | Yes |
| `llms.txt`, `llms-full.txt` and other non-HTML files | No | No | Yes |

For Google, each run:

1. **Re-submits changed sitemaps.** Every sitemap (the configured one and any `robots.txt` declarations that list HTML pages) is fingerprinted by its URLs and `lastmod` values. When a fingerprint changes, that sitemap is re-submitted through the Search Console Sitemaps API (`sitemaps.submit`). Google has retired its anonymous sitemap ping endpoint, so this is the supported "look again" signal.
2. **Inspects the pages that matter first.** URL Inspection checks never-inspected pages first, then pages that were not indexed or changed after Google's last crawl, then the oldest checks. It records each page's verdict, coverage state and last crawl time.
3. **Optionally spends Indexing API quota on the pages that need it.** When a site opts in (**Sites → Config**), the Indexing API's daily quota (200 per Google Cloud project by default) goes only to pages URL Inspection reports as not indexed, or whose `lastmod` is newer than Google's last crawl. It does not rotate through every URL. Pages excluded for structural reasons, such as `noindex`, a canonical elsewhere or a 404, are skipped. A page is not notified again for the same `lastmod` within 14 days. Google documents the Indexing API for job-posting and livestream pages only, so its effect on other pages is not guaranteed. The option is off by default.

IndexNow covers Bing, Yandex, Seznam, Naver and the other participating engines, including non-HTML files such as `llms.txt`.

If a submission keeps failing, open the **Submission failures** panel on the Command Centre. You can check whether the URL is currently reachable without spending submission quota, clear one repaired record or clear all backoff records, then let the next run retry them.

## Configuration

Most settings live in the dashboard. These environment variables control the container and authentication around it:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port inside the container. |
| `HOST` | `0.0.0.0` | Bind address. |
| `DATA_DIR` | `/data` | SQLite database, encryption key and backup directory. |
| `APP_SECRET` | generated | Encrypts OAuth tokens and delivery credentials. Set a stable value in production so restores remain portable. |
| `PUBLIC_URL` | request host, `https://` | Canonical origin for passkeys, sign-in callbacks, the MCP server URL and dashboard links. Public hostnames get `https://` automatically; set this to pin one address or for an IP/LAN host behind an HTTPS proxy. |
| `TRUST_PROXY` | `false` | Trust proxy-supplied client/protocol headers. Enable only behind a proxy that overwrites them. |
| `CORS_ORIGIN` | disabled | Explicit comma-separated browser origins when the frontend is hosted separately. The bundled UI is same-origin. |
| `OUTBOUND_HOST_ALLOWLIST` | unset | Exact comma-separated hostnames allowed to bypass public-address checks for trusted internal services. |
| `ALLOW_INSECURE_OUTBOUND`, `ALLOW_PRIVATE_OUTBOUND` | `false` | Broad outbound-policy exceptions for controlled deployments; prefer the hostname allowlist. |
| `BACKUP_KEEP` | `7` | Number of nightly SQLite backups to keep. |
| `RATE_LIMIT_MAX` | `300` | General requests allowed per `RATE_LIMIT_WINDOW`. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Sign-in requests allowed per `AUTH_RATE_LIMIT_WINDOW`. |
| `AI_CITATION_DAILY_LIMIT` | `25` | Daily citation checks for non-owner members. Owners and super-admins are exempt. |
| `AI_DRAFT_DAILY_LIMIT` | `25` | Daily ranking-playbook AI drafts for non-owner members. Owners and super-admins are exempt. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | unset | Optional deployment-level Google connection credentials (Search Console, GA4, Google Ads). They can also be entered during setup. |
| `GOOGLE_ADS_API_VERSION` | `v26` | Google Ads REST API version. |
| `REVIEWS_SYNC_MINUTES` | `60` | How often each linked Business Profile location's reviews are synced (minimum 15). |
| `ADMIN_EMAIL` | unset | Only this email address may create the first admin account. Set it before exposing a fresh install to the internet. |
| `OAUTH_RATE_LIMIT_MAX` | `30` | MCP OAuth registration/token requests per IP per minute. |
| `MCP_OAUTH_REDIRECT_ALLOWLIST` | unset | Redirect hosts/schemes MCP clients may use (e.g. `chatgpt.com,claude.ai,*.claude.com,vscode.dev,cursor:,localhost,127.0.0.1`). |
| `SSO_GOOGLE_*`, `SSO_OIDC_*` | unset | Optional Google or generic OpenID Connect sign-in. |
| `SMTP_*` | unset | Optional email delivery and password-reset links. |
| `NOTIFY_BATCH_SECONDS` | `60` | How long approval notifications are gathered before one message is sent. `0` sends each straight away. |
| `WHATSAPP_GRAPH_VERSION` | `v23.0` | Meta Graph API version for WhatsApp notifications. |

The [deployment guide](docs/DEPLOYMENT.md) includes the complete SSO, SMTP, recovery, update and backup instructions.

## Security and data

- The application stores its SQLite database at `/data/indexer.db` and creates nightly backups under `/data/backups`.
- OAuth tokens, OAuth client secrets and delivery passwords are encrypted at rest. Provider API keys are write-only through the application API and remain inside the local database.
- Passwords use scrypt. Sign-in supports TOTP 2FA, passkeys and optional OpenID Connect.
- Human sessions are stored in the database and authentication routes have a stricter rate limit.
- Workspace access is checked by the API, not only hidden in the interface.
- Service tokens are hashed, scoped to one workspace and can be expired or revoked.
- MCP clients sign in with OAuth 2.1 (PKCE, access tokens checked on every request and revocable at once, rotating refresh tokens) or hashed personal tokens, and never get more than their user's role allows.
- Google Ads changes are validated by Google, checked against each client's monthly budget and guardrails, and recorded with the person or assistant that made them.
- AI replies to Google reviews, and AI profile edits, posts and photos, are checked against each location's rules; anything outside them waits for a person, and every change is recorded with who proposed and approved it.
- `ADMIN_EMAIL` stops anyone else from claiming a fresh public install by creating the first admin account.
- Administrative actions, impersonation and security changes are recorded in the audit history.
- User-configured HTTP, webhook, SSO and FTP destinations are checked against loopback, private and reserved networks before connection and again after redirects/DNS resolution.
- Cross-origin browser access is disabled unless an explicit `CORS_ORIGIN` allowlist is configured; forwarded client addresses are ignored unless `TRUST_PROXY` is enabled.

Use HTTPS in production, protect access to the data volume, keep `APP_SECRET` out of source control and back up both the database and the key needed to decrypt stored credentials.

## Automation API

Create a service token under **Governance & Usage → API & Webhooks**. The token is shown once and belongs to one workspace.

| Endpoint | Required scope | Purpose |
| --- | --- | --- |
| `GET /api/v1/workspace` | `workspace:read` | Workspace health, actions, forecasts and connector freshness, optionally filtered by `site_id` or `workspace_only=true`. |
| `GET /api/v1/metrics` | `metrics:read` | Read normalized observations with source, metric, site and date filters. |
| `POST /api/v1/events` | `events:write` | Add custom numeric observations with provenance. |
| `POST /api/v1/logs/ingest` | `logs:write` | Ingest up to 1,000 origin or CDN request events per call. |

Send the token as `Authorization: Bearer oc_…`. See the [automation API guide](docs/AUTOMATION_API.md) for request examples and webhook verification.

## MCP server (connect an AI assistant)

The app ships a built-in [Model Context Protocol](https://modelcontextprotocol.io) server at `https://<your-host>/mcp` (Streamable HTTP) so any MCP-capable assistant can read — and, with your permission, act on — your data: sites, Search Console performance, period comparisons, content groups, tracked keywords, URL inspection, the ranking playbook, alerts, indexing, hygiene, AI-agent readiness, AI citations, Google Ads and Google Business Profile.

**Connect with OAuth (recommended):** add the server URL to your AI app. It finds the sign-in automatically, opens this app, and you choose what it may do: read data, run SEO actions (`mcp:write`), manage Google Ads (`ads:write`) and/or manage Google Business Profile: reviews, posts, photos and profile edits (`reviews:write`). You connect once: the connection lasts 30 days from its last use (90 for the refresh token), so one that's used regularly never expires, and it survives server restarts and updates. If an app does ask to reconnect, it goes straight back with the access you gave it, with no consent screen. Disconnect an app any time under **Governance & Usage → API & Webhooks → Connected apps**.

| Client | Add the server |
| --- | --- |
| ChatGPT | Developer mode for apps/connectors → create an app with the URL and OAuth. |
| Claude (web, desktop, Cowork) | Settings → Connectors → Add custom connector → paste the URL. |
| Claude Code | `claude mcp add --transport http seo-indexer https://<your-host>/mcp`, then `/mcp`. |
| Codex CLI | `codex mcp add seo-indexer --url https://<your-host>/mcp`, then `codex mcp login seo-indexer`. |
| Cursor | `{"mcpServers": {"seo-indexer": {"url": "https://<your-host>/mcp"}}}` in `~/.cursor/mcp.json`. |
| Gemini CLI | `gemini mcp add --transport http seo-indexer https://<your-host>/mcp`, then `/mcp auth seo-indexer`. |
| VS Code | `{"servers": {"seo-indexer": {"type": "http", "url": "https://<your-host>/mcp"}}}` in `.vscode/mcp.json`. |
| Other MCP clients | Give it the URL; OAuth is discovered via dynamic client registration or Client ID Metadata Documents. |

Apps that ask for an OAuth client ID and secret can use a client you register on the same card (*Apps that need a client ID*). Clients that can only send a fixed header can use a personal token (tick *SEO actions*, *Google Ads changes* and/or *Business Profile*) sent as `Authorization: Bearer seomcp_…`; a `?token=` URL also works but may appear in reverse-proxy logs.

Tokens reach every workspace their owner can access and never exceed the owner's role. The Google Ads tools mirror Google's open-source [google-ads-mcp](https://github.com/googleads/google-ads-mcp) server (`search`, `get_resource_metadata`, `list_accessible_customers`) and add audits, pacing, research helpers and guarded change tools; see the [Google Ads guide](docs/GOOGLE_ADS.md#connect-an-ai-assistant). The `reviews_*` and `business_*` tools read and answer reviews, edit profiles and publish posts and photos within each location's rules; see the [Google Business Profile guide](docs/REVIEWS.md#working-with-an-ai-assistant). Hosted AI apps need the endpoint on public HTTPS, which the app advertises automatically on a public hostname; consider setting `MCP_OAUTH_REDIRECT_ALLOWLIST` too.

## Updating and backups

To update a Compose installation:

```bash
docker compose pull
docker compose up -d
```

The app creates an online SQLite backup at 02:30 each day and keeps seven by default. These files are useful, but they are still inside the same `/data` volume. Copy that volume, including its `.key` file when `APP_SECRET` is not supplied explicitly, to separate storage.

Database migrations run automatically when a new version starts. Read the [release notes](https://github.com/martadams89/seo-website-indexer/releases) before updating and keep a fresh backup available.

## Development

The backend and frontend run separately during development:

```bash
cd backend
npm install
npm run dev
```

```bash
cd frontend
npm install
npm run dev
```

The backend runs on `http://localhost:3000`. Vite runs on `http://localhost:5173` and proxies `/api` to the backend.

Before opening a pull request:

```bash
cd backend && npm test && npm run build
cd frontend && npm run test:theme && npm run test:typography && npm run test:ui && npm run test:integrations && npm run test:intelligence && npm run test:action-centre && npm run lint && npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for commit and pull-request guidance.

## Documentation

- [Deployment, authentication and recovery](docs/DEPLOYMENT.md)
- [Users, roles and workspaces](docs/USERS_AND_WORKSPACES.md)
- [Integration permissions and setup](docs/INTEGRATIONS.md)
- [Google, IndexNow, Bing and sitemap setup](docs/INDEXING.md)
- [Google Ads: setup, guardrails, MCP tools and AI routines](docs/GOOGLE_ADS.md)
- [Google Business Profile: setup, separate accounts and projects, reviews, profile, posts, photos and MCP tools](docs/REVIEWS.md)
- [Moving from OpenGSC and Porter Metrics](docs/MIGRATING.md)
- [Page-level Action Centre and Google verification](docs/ACTION_CENTRE.md)
- [Ranking playbook: opportunities ranked by clicks gained](docs/RANKING_PLAYBOOK.md)
- [Markets, entities and website discovery](docs/MARKETS_AND_ENTITIES.md)
- [Automation API and signed webhooks](docs/AUTOMATION_API.md)
- [Product roadmap](docs/PRODUCT_STRATEGY.md)
- [Commercialisation roadmap](docs/COMMERCIALIZATION.md)

## License

SEO Website Indexer is available under the [GPL-3.0 license](LICENSE).
