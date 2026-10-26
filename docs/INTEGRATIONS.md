# Integration permissions and setup

This is the permission reference for every external service the application currently uses. It explains the minimum access to grant, where each credential comes from and which screen in the application receives it.

Use a separate credential for this application wherever the provider supports one. Give it only the access listed here, restrict it to the relevant website or project and rotate it when the person or system that created it changes.

## Google Analytics 4: the short answer

GA4 needs all three of these:

1. **Google Analytics Data API** enabled in the Google Cloud project that owns the OAuth client.
2. OAuth scope:

   ```text
   https://www.googleapis.com/auth/analytics.readonly
   ```

   The application requests this automatically when a Google account is connected.

3. The connected Google account must have **Viewer or higher** access to the exact GA4 property. If revenue should be imported, the account must not have the **No Revenue Metrics** data restriction.

Enter the numeric **Property ID** from **GA4 → Admin → Property settings → Property details**. Do not enter the web-stream measurement ID that starts with `G-`.

The application calls `properties/{propertyId}:runReport` and reads landing-page sessions, users, engaged sessions, key events and revenue. It cannot change GA4 configuration.

Official references: [Data API quickstart](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart), [property ID](https://developers.google.com/analytics/devguides/reporting/data/v1/property-id), [GA4 roles and data restrictions](https://support.google.com/analytics/answer/9679158?hl=en).

## Permission matrix

| Service | Minimum external permission | Where it is configured |
| --- | --- | --- |
| Google Search Console | OAuth `webmasters`; Owner or Full user on the property | Settings → Google Accounts, then Sites |
| Google Analytics 4 | OAuth `analytics.readonly`; GA4 Viewer or higher | Integrations |
| Google Business Profile | OAuth `business.manage` (opt-in, or the only scope on a Business-Profile-only connection); the Google user must own or manage the profiles; the OAuth client's Cloud project needs Google's Business Profile API approval | Business Profile → Setup |
| Google Ads | OAuth `adwords` (opt-in); the Google user needs access to the ad accounts (directly or through a manager account); the OAuth client's Cloud project needs Explorer or Basic API access | Google Ads → Setup |
| PageSpeed Insights | PageSpeed Insights API key; no OAuth | Integrations |
| Chrome UX Report | Chrome UX Report API key; no OAuth | Settings → API Keys |
| Cloudflare | `Account Analytics: Read`, limited to the selected zone | Integrations |
| Plausible | Stats API key with access to the selected site | Integrations |
| Matomo | View access to the site and a POST-only auth token | Integrations |
| WordPress | Application password for a user able to edit and publish the target post type | Integrations |
| Shopify | `read_content` and `write_content` | Integrations |
| Webflow | `sites:read`, `cms:read`, `cms:write` | Integrations |
| Bing Webmaster | Verified site plus an API key or delegated OAuth | Settings → API Keys, then Sites |
| IndexNow | Public ownership key file at the site root | Sites → site → IndexNow |
| OpenAI | Project key allowed to list models and create Responses | Settings → API Keys |
| Anthropic | API key allowed to list models and create Messages with web search | Settings → API Keys |
| Gemini | Gemini API key allowed to list models and generate content with Google Search grounding | Settings → API Keys |
| Perplexity | API key with Sonar access | Settings → API Keys |
| xAI | API key with model-list and chat-completions access | Settings → API Keys |
| Brave Search | Search API subscription token | Settings → API Keys |
| Slack | Incoming Webhook for one channel | Settings → Notifications |
| Discord | Channel webhook | Settings → Notifications |
| ntfy | Topic; access token only for a protected topic | Settings → Notifications |
| Telegram | Bot token plus the destination chat ID | Settings → Notifications |
| Email | SMTP account allowed to send as `SMTP_FROM` | Container environment + Settings → Notifications |
| WhatsApp | Meta app with WhatsApp, a System User token with `whatsapp_business_messaging`, the phone number ID and an approved message template | Settings → Notifications |
| Server log ingest | Workspace service token with `logs:write` | Governance & Usage → API & Webhooks |
| External rank feed | Workspace service token with `events:write` | Governance & Usage → API & Webhooks |
| Outbound automation webhook | No provider permission; receiving HTTPS endpoint must accept signed POST requests | Governance & Usage → API & Webhooks |

## How credentials are scoped

- Integration records and their secrets belong to the active workspace.
- Workspace API keys override any platform default entered by a super-admin.
- Google connections belong to the user who authorises them and may be shared with selected workspaces. Members can use a shared connection without seeing its OAuth tokens.
- Provider secrets are encrypted at rest and write-only through the application API.
- Internal service tokens are hashed, limited to one workspace and should contain only the scopes needed by that automation.
- Publishing connections do not bypass the application approval queue.

## Google connection

One connected Google account can be used by Search Console and GA4. This is separate from using Google to sign in to the dashboard.

### APIs and scopes

Enable these APIs in the Google Cloud project that owns the OAuth client:

- **Google Search Console API**: `searchconsole.googleapis.com`
- **Web Search Indexing API**: `indexing.googleapis.com` (only used by sites that opt in to Indexing API recrawl requests)
- **Google Analytics Data API**: `analyticsdata.googleapis.com`
- **Google Ads API**: `googleads.googleapis.com` (only when Google Ads is used)
- **Business Profile APIs**: `mybusinessaccountmanagement.googleapis.com`, `mybusinessbusinessinformation.googleapis.com`, `mybusiness.googleapis.com` and `businessprofileperformance.googleapis.com` (only when Google reviews are used)

The standard account connection requests:

```text
https://www.googleapis.com/auth/webmasters
https://www.googleapis.com/auth/indexing
https://www.googleapis.com/auth/analytics.readonly
https://www.googleapis.com/auth/userinfo.email
```

Google Ads is opt-in. Ticking **Also allow Google Ads management** (or **Add Google Ads access** on an existing connection) adds:

```text
https://www.googleapis.com/auth/adwords
```

Google Business Profile is opt-in too: **Add Business Profile access** (Business Profile → Setup) adds `https://www.googleapis.com/auth/business.manage`. Google has no read-only variant, so replies, posts, photos and profile edits are governed by the MCP `reviews:write` scope, the **Manage Google Business Profile** capability and each location's rules. Google must also approve the Cloud project once before the APIs answer. When that approval sits on another project, connect through that project's OAuth client with **Only ask Google for Business Profile access**: the connection then requests just `business.manage` and `userinfo.email`, and the same Google user can stay connected through the main project for Search Console. Google Ads has the same option (**Only ask Google for Google Ads access**: `adwords` and `userinfo.email`) for a project that holds the Ads API access level or quota you need. See the [Google Business Profile guide](REVIEWS.md#a-separate-google-account-or-cloud-project).

Google publishes no read-only Ads scope, so what may change is decided by the app: the MCP `ads:write` scope, the member's **Manage Google Ads** capability and each client's monthly budget and guardrails. Re-consent asks again for every scope the connection already uses (Ads and Business Profile are carried forward), so existing access and linked sites are kept. Google Ads API access is granted to the Cloud project that owns the OAuth client (Explorer or Basic; developer tokens are no longer used). See the [Google Ads guide](GOOGLE_ADS.md).

`webmasters` is deliberately not read-only: the application reads Search Console data, submits sitemaps and performs supported inspection/submission actions. `indexing` is used only for sites that opt in to Indexing API recrawl requests. The Google identity must be a verified **owner** of the Search Console property for those calls. Accounts connected before this scope was added keep working for everything else; reconnect them to use the Indexing API. The optional Google API auto-configuration flow also asks for `cloud-platform`; normal day-to-day Search Console and GA4 use does not need that broader scope.

Every Google sign-in asks Google for its account chooser (`prompt=select_account consent`) and sends no `login_hint`, so with several Google accounts signed in you choose each time. A reconnect checks that the chosen account is the one being reconnected and changes nothing if it isn't.

**Settings → Google Accounts** checks each connection against what uses it. Missing scopes get an **Update permissions** button (one consent click that keeps the current grant). APIs Google reports as disabled get a **Switch them on for me** button: a separate one-off sign-in asks for `cloud-platform` with an online-only token, enables the APIs through Service Usage and stores nothing, so the saved connection never carries the Cloud scope. The Google user needs `serviceusage.services.enable` on the project (Service Usage Admin, Editor or Owner).

### Create the OAuth client

1. Create or select a [Google Cloud project](https://console.cloud.google.com/projectcreate).
2. Enable the two APIs above.
3. Configure the OAuth consent screen.
4. Create an OAuth client with application type **Web application**.
5. Add the exact callback shown by the application, normally:

   ```text
   https://YOUR-HOST/api/auth/google/callback
   ```

6. Enter the client ID and secret once (**Another project** when connecting) or set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` on the container. Later sign-ins, including other Google users, pick the project from a list and reuse its client; the secret stays on the server.
7. Open **Settings → Google Accounts → Connect Google** and complete consent.

An External OAuth app left in **Testing** can receive refresh grants that expire after seven days when these scopes are requested. Use **Production** for a public long-running app or **Internal** for an appropriate Google Workspace deployment, then reconnect. See [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2).

### Search Console access

Add the connected Google account as an **Owner** or **Full user** on each Search Console property the application manages. Restricted access is suitable for viewing some data but not the application’s complete workflow. The site’s configured Search Console property must match the exact URL-prefix or domain property visible to that account.

See [Search Console API authorisation](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing) and the more detailed [indexing setup guide](INDEXING.md).

### GA4 connection

1. In GA4 open **Admin → Property access management**.
2. Add the same Google identity as **Viewer** or higher.
3. Remove the **No Revenue Metrics** restriction if this workspace should import revenue.
4. Copy the numeric property ID from **Admin → Property settings → Property details**.
5. Open **Integrations → Google Analytics 4**, choose the Google account, paste the property ID, save and run **Sync**.

Common failures:

- `403 PERMISSION_DENIED`: the Data API is disabled, the OAuth grant is stale or the selected account cannot view that property.
- `404` or invalid property: a `G-` measurement ID was entered instead of the numeric property ID.
- Reconnect required after seven days: the OAuth app is still in External Testing.
- Sessions import but revenue is absent: check the property’s revenue data restriction and whether GA4 has revenue in the selected period.

## Analytics and performance

### PageSpeed Insights

The connector runs mobile and desktop Lighthouse checks. It reads performance, accessibility, best-practices and SEO scores plus lab LCP, INP, CLS, TBT, Speed Index and TTFB values.

1. Enable [PageSpeed Insights API](https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com).
2. Create an API key under **Google Cloud → APIs & Services → Credentials**.
3. Restrict the key to **PageSpeed Insights API**. If the server has a stable outbound IP, restrict it to that IP too.
4. In **Integrations → PageSpeed + CrUX**, select a site and paste this key. The key is optional for a quick manual trial but recommended for scheduled use.

Do not reuse a key restricted to Chrome UX Report API. PageSpeed Insights and CrUX are separate services. See the [PageSpeed API guide](https://developers.google.com/speed/docs/insights/v5/get-started).

### Chrome UX Report

CrUX supplies real-user p75 LCP, INP and CLS history when Google has enough Chrome telemetry for an origin.

1. Enable [Chrome UX Report API](https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com).
2. Create a separate API key.
3. Restrict it to **Chrome UX Report API**.
4. Paste it into **Settings → API Keys → CrUX API key**.

“Origin not in the dataset” normally means the site has insufficient eligible Chrome traffic, not that the key is broken. See the [CrUX API guide](https://developer.chrome.com/docs/crux/api/).

### Cloudflare

The connector queries `httpRequestsAdaptiveGroups` through Cloudflare’s GraphQL Analytics API. It does not edit DNS, cache rules, Workers or zone settings.

1. Open **Cloudflare → My Profile → API Tokens → Create Token → Create Custom Token**.
2. Add **Account → Account Analytics → Read**.
3. Under **Zone Resources**, choose **Include → Specific zone** and select the site.
4. Open the zone Overview page and copy **Zone ID** from the API section.
5. Paste the Zone ID and token into **Integrations → Cloudflare**.

Do not use the Global API Key. The older “Zone Analytics: Read” label is not the current permission for this GraphQL flow. See [Cloudflare GraphQL token authentication](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/) and [finding zone IDs](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).

### Plausible

1. Open **Plausible → Account settings → API Keys → New API Key**.
2. Choose a **Stats API** key and copy it immediately.
3. Use `https://plausible.io` as the base URL for hosted Plausible, or the root of the self-hosted installation.
4. Enter the exact site ID shown by Plausible, normally the site domain.

Stats API availability depends on the Plausible plan. The connector reads aggregate visitors, visits, views, bounce rate, duration and landing pages; it does not write analytics configuration. See [Plausible Stats API](https://plausible.io/docs/stats-api).

### Matomo

1. Create a dedicated Matomo user with **View** permission on the selected website.
2. Open **Administration → Personal → Security → Auth tokens**.
3. Generate a **POST-only** token and copy it.
4. Find the numeric site ID under **Administration → Websites → Manage**.
5. Enter the Matomo root URL, site ID and token in **Integrations → Matomo**.

The connector calls `VisitsSummary.get`. Administration or Write access is unnecessary. Treat `token_auth` like a password and never put it in a URL. See the [Matomo Reporting API guide](https://developer.matomo.org/guides/reporting-api).

## Publishing

### WordPress

WordPress application passwords have no independent scope list; they inherit the capabilities of the user that created them.

1. Create a dedicated WordPress user. **Editor** is the practical default when the application must update existing posts owned by different authors. A custom least-privilege role is better when available.
2. Open **Users → Profile** or **Edit User → Application Passwords**.
3. Create an application password named `SEO Indexer` and copy it.
4. Enter the public site root, username and generated password in **Integrations → WordPress**.

The user must be able to read, edit, create drafts and publish the target post types. An Author normally cannot edit posts owned by other users. WordPress 5.6 or newer and HTTPS are required. See [REST API authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/) and [application passwords](https://developer.wordpress.org/rest-api/reference/application-passwords/).

### Shopify

The current governed workflow reads and updates existing blog articles. It needs these custom-app Admin API scopes:

```text
read_content
write_content
```

Shopify also accepts the equivalent online-store-page scope family for Article operations, but the content pair above is the clearest minimum for this connector.

1. Open **Shopify admin → Settings → Apps and sales channels → Develop apps**.
2. Create or open a custom app and configure `read_content` and `write_content`.
3. Install or update the app so the new scopes are granted.
4. Copy the Admin API access token.
5. Use the permanent `store.myshopify.com` domain in the connection, not the storefront’s custom domain.

The workflow expects an existing Article GID such as `gid://shopify/Article/123`. It does not need products, customers or orders. See [Shopify authentication](https://shopify.dev/docs/api/usage/authentication), [Article read access](https://shopify.dev/docs/api/admin-graphql/latest/objects/Article) and [`articleUpdate` access](https://shopify.dev/docs/api/admin-graphql/latest/mutations/articleUpdate).

### Webflow

Grant these Data API scopes:

```text
sites:read
cms:read
cms:write
```

For one site you control, create a Site Token under **Site settings → Apps & Integrations → API access**. For a public multi-site integration, use OAuth with the same scopes. The collection ID must belong to a site available to that token.

`sites:read` is required by the connection test; the two CMS scopes support reading, staging, publishing and rollback. See [Webflow scopes](https://developers.webflow.com/data/reference/scopes), [authentication](https://developers.webflow.com/data/reference/authentication) and the [CMS API prerequisites](https://developers.webflow.com/data/v1.0.0/docs/cms-tutorial).

## Search submissions

### Bing Webmaster

The site must first be verified in Bing Webmaster Tools. The application supports either:

- a Bing Webmaster API key created under **Settings → API access**; or
- delegated OAuth using a client registered with this callback:

  ```text
  https://YOUR-HOST/api/auth/bing/callback
  ```

Store the OAuth client ID/secret or API key under **Settings → API Keys**, add the Bing account, then assign it to the site. The credential can read search performance and crawl issues, inspect live quotas and submit changed HTML URLs. See [Bing Webmaster API access](https://learn.microsoft.com/en-us/bingwebmaster/getting-access).

### IndexNow

IndexNow uses proof of site control rather than an account permission. The per-site key must be publicly available as plain text at:

```text
https://example.com/YOUR_KEY.txt
```

The file body must contain only `YOUR_KEY`. Generate and verify it under **Sites → site → IndexNow**. The application can serve the path behind a reverse proxy or deploy it through the site’s configured FTP/SFTP or webhook route. See [IndexNow key hosting](https://www.indexnow.org/documentation) and [the project indexing guide](INDEXING.md#set-up-indexnow).

## AI visibility providers

AI-provider keys are stored under **Settings → API Keys**. Create one project/key per environment when possible, set provider-side spend limits and do not use organisation-admin keys.

| Provider | Calls made by the application | Minimum key setup |
| --- | --- | --- |
| OpenAI | `GET /v1/models`, `POST /v1/responses` with web search; chat completions for generated `llms.txt` content | Project API key allowed to read models and create Responses/chat completions with the selected model |
| Anthropic | `GET /v1/models`, `POST /v1/messages` with web search | Standard API key with model and Messages access |
| Gemini | List models and `generateContent` with Google Search grounding | Gemini API key restricted to Generative Language API |
| Perplexity | `POST /chat/completions` using Sonar | API key with credits and access to the selected Sonar model |
| xAI | `GET /v1/models`, `POST /v1/chat/completions` with live search | Project/team API key with model and chat-completions access |
| Brave Search | `GET /res/v1/web/search` | Search API subscription token; no write access |

For OpenAI, use a normal project key—not an Admin API key. The application needs model listing because the UI discovers available models, and Responses creation because citation checks use the web-search tool. See the official OpenAI [API quickstart](https://developers.openai.com/api/docs/quickstart) and [Models API](https://developers.openai.com/api/reference/resources/models).

Provider setup links: [Anthropic API keys](https://console.anthropic.com/settings/keys), [Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key), [Perplexity quickstart](https://docs.perplexity.ai/getting-started/quickstart), [xAI documentation](https://docs.x.ai/docs/overview), [Brave Search API](https://brave.com/search/api/).

## Notifications

Notification credentials belong to the active workspace under **Settings → Notifications**. The page has three parts:

- **Events.** Switch each event on or off for the workspace. *Needs a decision* covers review replies, Business Profile changes and Google Ads changes an AI assistant proposed but may not publish on its own, plus Ads changes Google refused. *Alerts* covers new low-rated reviews, edits Google made to a profile, Google connection problems and AI citation movement. *Runs and reports* covers runs and the weekly ranking playbook.
- **Channels.** Slack, Discord, ntfy, Telegram, WhatsApp, a generic webhook and email. Email has default recipients and any number of named lists, and each list picks its own events.
- **Where each event goes.** A grid of events against the configured channels. A channel gets every event that's switched on unless you untick it there, so you can, for example, send approvals to WhatsApp and leave run summaries to email.

### Links in messages

Messages about something waiting for a decision link straight to it: `https://YOUR-HOST/w/<workspace>/approve/<kind>/<id>`. The page shows the proposed reply or change with **Approve** and **Reject** (a reply can be edited first). Each channel shows links its own way: buttons in email, tappable actions in ntfy, links in Slack, Discord and Telegram, and plain URLs in WhatsApp.

Opening a link needs someone signed in with access to that workspace. Nothing can be approved from the message itself, so an email security scanner that follows links, or a forwarded message, can't approve anything. Proposals that arrive close together are gathered for `NOTIFY_BATCH_SECONDS` (60 by default) and sent as one message that lists them and links to the full approvals list.

Links use `PUBLIC_URL` when it's set; otherwise the address the dashboard was last opened on.

### Slack

Create a Slack app, enable **Incoming Webhooks**, add a webhook to the one channel that should receive this workspace’s messages and paste the generated URL. The webhook is already limited to that channel; the application does not need a bot token or workspace-wide OAuth scopes. See [Slack Incoming Webhooks](https://api.slack.com/messaging/webhooks).

### Discord

Open **Channel → Edit Channel → Integrations → Webhooks → New Webhook**, select the channel and copy the URL. Anyone with that URL can post to the channel, so treat it as a secret. See [Discord webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks).

### ntfy

For `ntfy.sh`, choose a hard-to-guess topic and subscribe to it. For a private or protected topic, provide the self-hosted server URL and an access token allowed to publish to that topic. See [ntfy publishing](https://docs.ntfy.sh/publish/).

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Message the bot once or add it to the target group.
3. Call `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the chat ID. Group IDs are normally negative.
4. Enter the token and chat ID together.

The bot only needs to send messages to that chat. See the [Telegram bot tutorial](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).

### Email

Email uses the installation’s SMTP account rather than a workspace API key. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, optional `SMTP_USER`/`SMTP_PASS` and `SMTP_FROM` on the container, then add recipient addresses under Notifications. Each recipient gets their own copy, so people on a list don't see each other's addresses. Add named lists to send different events to different people, for example Google Ads approvals to the paid-search team and review approvals to the account manager. The SMTP identity must be allowed to send as `SMTP_FROM`; configure SPF, DKIM and DMARC at the mail provider for deliverability. See [deployment and SMTP setup](DEPLOYMENT.md#email-and-password-resets).

### WhatsApp

Messages go through Meta's WhatsApp Business Cloud API from a business phone number you control.

1. Create an app of type **Business** in [Meta for Developers](https://developers.facebook.com/apps) and add the **WhatsApp** product.
2. Under **WhatsApp → API Setup**, add your business phone number (or use the test number while trying it out) and copy its **Phone number ID**. This is a long numeric ID, not the phone number.
3. In Business Settings → [System users](https://business.facebook.com/settings/system-users), add a system user, assign it the app with the `whatsapp_business_messaging` permission and generate a token that doesn't expire. A temporary token from the API Setup page stops working after 24 hours.
4. In WhatsApp Manager → [Message templates](https://business.facebook.com/wa/manage/message-templates/), create a **Utility** template whose body has one variable, for example `SEO alert: {{1}}`, and wait for Meta to approve it. The app puts the whole notification, including its links, into `{{1}}`.
5. Enter the token, phone number ID, recipients (full international numbers separated by commas), template name and its language code (for example `en` or `en_GB`).

Without a template, WhatsApp only delivers free-form messages to people who have messaged your business number in the last 24 hours, and the test send reports that. Meta charges per template message beyond its free allowance. `WHATSAPP_GRAPH_VERSION` (default `v23.0`) sets the Graph API version.

### Generic webhook

Provide an HTTPS endpoint that accepts a JSON `POST` body: `{"title": "…", "body": "…", "links": [{"label": "…", "url": "…"}], "event": "review_approvals"}`. `event` is the event name, or `test` for a test send. This also suits Zapier, Make and n8n. If the endpoint requires its own authentication, put an unguessable credential in the webhook URL only when the receiver supports that safely; otherwise use the signed outbound webhooks under Governance.

## Internal APIs and automation

Create tokens under **Governance & Usage → API & Webhooks**. Each token is shown once and belongs to the active workspace.

| Use | Scope | Endpoint |
| --- | --- | --- |
| Read workspace health | `workspace:read` | `GET /api/v1/workspace` |
| Read normalized metrics | `metrics:read` | `GET /api/v1/metrics` |
| External rank/custom observations | `events:write` | `POST /api/v1/events` |
| Server/CDN request logs | `logs:write` | `POST /api/v1/logs/ingest` |

Do not give a log shipper `events:write` or a rank exporter `logs:write` unless it genuinely uses both endpoints. Send tokens as `Authorization: Bearer oc_…`. See the [Automation API](AUTOMATION_API.md) for payloads and signed outbound-webhook verification.

AI assistants (any MCP client) use the MCP server at `/mcp` instead. Connect them with OAuth (add the URL to the client and approve the permissions), a client registered on the dashboard, or a personal token. MCP scopes are separate from service-token scopes:

| MCP scope | Allows |
| --- | --- |
| `mcp:read` | Read sites, Search Console, the ranking playbook, alerts, indexing, AI citations, Google Ads and Google reviews data in every workspace the user can access. |
| `mcp:write` | SEO actions: submit URLs, trigger runs, refresh snapshots, record Request indexing results, mark playbook opportunities done or dismissed. |
| `ads:write` | Propose and apply Google Ads changes, always within each client's guardrails. |
| `reviews:write` | Manage Google Business Profile: reply to reviews, publish posts and photos and edit profiles within each location's rules; anything outside them waits for approval. |

A token never exceeds its owner's role: viewers stay read-only and editors need the matching capability. See the [Google Ads guide](GOOGLE_ADS.md#connect-an-ai-assistant).

## Troubleshooting order

When a connection test fails, check these in order:

1. **Identity:** Is this the exact account, token or app installation that owns the property?
2. **Resource:** Is the numeric ID/domain/collection from the same account and environment?
3. **Permission:** Does the granted role or scope match the table above?
4. **API enabled:** Google APIs in particular must be enabled in the project that issued the credential.
5. **Restriction:** Is the key restricted to the correct API, zone, site or server IP?
6. **Lifecycle:** Was the app reinstalled after a scope change, the OAuth grant revoked or the token expired?
7. **Network:** Can the container reach the provider over HTTPS, and does the provider allow the server’s outbound IP?
8. **Fresh test:** Save the connection, run **Sync**, then read the complete error in **Your connections** before rotating anything.

Rotate only after identifying the cause. Replacing a valid credential often hides the original configuration problem and makes audit trails harder to follow.
