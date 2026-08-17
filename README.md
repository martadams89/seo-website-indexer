<div align="center">

# SEO Website Indexer

**A self-hosted dashboard for indexing, search performance, AI visibility and website operations across multiple clients or teams.**

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
| Indexing | Submit changed sitemaps to Google Search Console and changed URLs to IndexNow or Bing Webmaster. Inspect and clear failed submissions from the dashboard. |
| Search performance | Track coverage, clicks, impressions, queries, pages, countries, devices, crawl freshness and Core Web Vitals. |
| AI visibility | Test a reusable set of questions across supported AI and search providers, record citations, compare competitors and review gains or losses. |
| Site checks | Audit broken links, redirect chains, structured data, `robots.txt`, AI crawler access and `llms.txt`. |
| Markets and entities | Discover brand, organisation or local-business facts from a site's public structured data, review them in normal fields and monitor listing consistency by market. |
| Data and integrations | Bring together GA4, PageSpeed, Cloudflare, Plausible, Matomo, server logs and external rank data. Every observation keeps its source and timestamp. |
| Work and publishing | Turn findings into assigned actions and use approval-based publishing flows for WordPress, Shopify and Webflow. |
| Reports | Build scheduled reports, send digests and provide a read-only client portal. |
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
2. Add a site and its sitemap URL under **Sites & Submissions**.
3. Connect a Google account if you want Search Console data and submissions.
4. Put the site's IndexNow key file in place if you want URL submissions.
5. Add any analytics, AI, publishing or notification services you need.
6. Run an audit first, review the result, then enable scheduled submissions.

The [indexing guide](docs/INDEXING.md) covers Google OAuth, IndexNow verification, Bing, sitemap `lastmod`, `llms.txt` routing and failed-submission recovery.

For brand and local knowledge, **Markets & Entities** can read public JSON-LD and page metadata from a configured site, turn the result into editable fields and keep the approved record as a workspace source of truth. See the [markets and entities guide](docs/MARKETS_AND_ENTITIES.md) for setup, examples and score semantics.

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
| Analytics and performance | Google Analytics 4, PageSpeed and CrUX, Cloudflare, Plausible, Matomo |
| AI visibility | OpenAI, Anthropic, Gemini, Perplexity, xAI, Brave Search |
| Publishing | WordPress, Shopify, Webflow |
| Notifications | Slack, Discord, ntfy, Telegram, email, generic webhooks |
| Other data | Server-log ingestion and external rank feeds through the API |

Workspace-specific API keys override any platform default set by a super-admin. This allows one installation to use shared keys, client-owned keys or a mixture of both.

See the [integration permission and setup guide](docs/INTEGRATIONS.md) for the exact OAuth scopes, provider roles, token permissions, callback URLs, value locations and troubleshooting steps for every service in this table. The same minimum-access guide is available from each connection modal in the dashboard.

## How indexing works

Each scheduled run reads a site's configured sitemap and any additional `Sitemap:` entries in `robots.txt`. It compares the current URLs and `lastmod` values with the previous run, then submits only new or changed content where the receiving service supports it.

| Content | Google Search Console | Bing Webmaster | IndexNow |
| --- | :---: | :---: | :---: |
| HTML pages | Yes | Yes | Yes |
| `llms.txt`, `llms-full.txt` and other non-HTML files | No | No | Yes |

Google's URL-level Indexing API is not used for ordinary pages because Google limits it to specific content types. This project uses sitemaps for normal pages and the URL Inspection API to record coverage information.

If a submission keeps failing, open the **Submission failures** panel on the Command Centre. You can check whether the URL is currently reachable without spending submission quota, clear one repaired record or clear all backoff records, then let the next run retry them.

## Configuration

Most settings live in the dashboard. These environment variables control the container and authentication around it:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port inside the container. |
| `HOST` | `0.0.0.0` | Bind address. |
| `DATA_DIR` | `/data` | SQLite database, encryption key and backup directory. |
| `APP_SECRET` | generated | Encrypts OAuth tokens and delivery credentials. Set a stable value in production so restores remain portable. |
| `CORS_ORIGIN` | request origin | Comma-separated allowed browser origins when the frontend is hosted separately. |
| `BACKUP_KEEP` | `7` | Number of nightly SQLite backups to keep. |
| `RATE_LIMIT_MAX` | `300` | General requests allowed per `RATE_LIMIT_WINDOW`. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Sign-in requests allowed per `AUTH_RATE_LIMIT_WINDOW`. |
| `AI_CITATION_DAILY_LIMIT` | `25` | Daily citation checks for non-owner members. Owners and super-admins are exempt. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | unset | Optional deployment-level Google connection credentials. They can also be entered during setup. |
| `SSO_GOOGLE_*`, `SSO_OIDC_*` | unset | Optional Google or generic OpenID Connect sign-in. |
| `SMTP_*` | unset | Optional email delivery and password-reset links. |

The [deployment guide](docs/DEPLOYMENT.md) includes the complete SSO, SMTP, recovery, update and backup instructions.

## Security and data

- The application stores its SQLite database at `/data/indexer.db` and creates nightly backups under `/data/backups`.
- OAuth tokens, OAuth client secrets and delivery passwords are encrypted at rest. Provider API keys are write-only through the application API and remain inside the local database.
- Passwords use scrypt. Sign-in supports TOTP 2FA, passkeys and optional OpenID Connect.
- Human sessions are stored in the database and authentication routes have a stricter rate limit.
- Workspace access is checked by the API, not only hidden in the interface.
- Service tokens are hashed, scoped to one workspace and can be expired or revoked.
- Administrative actions, impersonation and security changes are recorded in the audit history.

Use HTTPS in production, protect access to the data volume, keep `APP_SECRET` out of source control and back up both the database and the key needed to decrypt stored credentials.

## Automation API

Create a service token under **Governance & Usage → API & Webhooks**. The token is shown once and belongs to one workspace.

| Endpoint | Required scope | Purpose |
| --- | --- | --- |
| `GET /api/v1/workspace` | `workspace:read` | Workspace health, actions, forecasts and connector freshness. |
| `GET /api/v1/metrics` | `metrics:read` | Read normalized observations with source, metric and date filters. |
| `POST /api/v1/events` | `events:write` | Add custom numeric observations with provenance. |
| `POST /api/v1/logs/ingest` | `logs:write` | Ingest up to 1,000 origin or CDN request events per call. |

Send the token as `Authorization: Bearer oc_…`. See the [automation API guide](docs/AUTOMATION_API.md) for request examples and webhook verification.

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
cd frontend && npm run test:theme && npm run test:ui && npm run test:integrations && npm run lint && npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for commit and pull-request guidance.

## Documentation

- [Deployment, authentication and recovery](docs/DEPLOYMENT.md)
- [Users, roles and workspaces](docs/USERS_AND_WORKSPACES.md)
- [Integration permissions and setup](docs/INTEGRATIONS.md)
- [Google, IndexNow, Bing and sitemap setup](docs/INDEXING.md)
- [Markets, entities and website discovery](docs/MARKETS_AND_ENTITIES.md)
- [Automation API and signed webhooks](docs/AUTOMATION_API.md)
- [Product roadmap](docs/PRODUCT_STRATEGY.md)
- [Commercialisation roadmap](docs/COMMERCIALIZATION.md)

## License

SEO Website Indexer is available under the [GPL-3.0 license](LICENSE).
