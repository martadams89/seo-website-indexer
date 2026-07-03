<div align="center">

# 🔍 SEO Website Indexer

**Self-hosted SEO & GEO automation for all your sites — indexing, analytics and AI-citation tracking in one container.**

Submit every changed URL to Google & Bing the moment your sitemap moves, watch your index coverage as living dashboards, and measure whether ChatGPT, Claude, Gemini, Perplexity and Grok actually cite you.

[![CI](https://github.com/martadams89/seo-website-indexer/actions/workflows/ci.yml/badge.svg)](https://github.com/martadams89/seo-website-indexer/actions/workflows/ci.yml)
[![Docker](https://github.com/martadams89/seo-website-indexer/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/martadams89/seo-website-indexer/actions/workflows/docker-publish.yml)
[![Release](https://img.shields.io/github/v/release/martadams89/seo-website-indexer?logo=github&color=blueviolet)](https://github.com/martadams89/seo-website-indexer/releases)
[![ghcr.io](https://img.shields.io/badge/ghcr.io-seo--website--indexer-blue?logo=docker)](https://github.com/martadams89/seo-website-indexer/pkgs/container/seo-website-indexer)
[![Renovate](https://img.shields.io/badge/maintained%20by-renovate-1f8ceb?logo=renovate)](https://docs.renovatebot.com)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

`docker run` → open the dashboard → link Google → done. No external database, no cloud dependencies, your keys never leave your box.

</div>

---

## Why this exists

Search engines only recrawl what they're told about, and AI answer engines only cite what they can retrieve. Doing that properly across multiple sites means juggling the Indexing API, Search Console, IndexNow, Bing Webmaster, quota limits, `lastmod` diffing, `robots.txt`/`llms.txt` upkeep — and you still can't see whether any of it *works*. This container does all of it on a schedule and shows you the results as per-site dashboards: coverage funnels, freshness gaps, Core Web Vitals, and a prompt-by-prompt matrix of which AI engines cite your domains.

## Features

- **Google Indexing API** — notify Google of URL changes (200 URLs/day per Google Cloud project)
- **Google Search Console** — automatic sitemap submission per site
- **IndexNow** — instantly alert Bing, Yandex, Yahoo, and other participating engines (all via one API call)
- **Bing Webmaster URL Submission** — direct, quota-aware submission of changed pages into your verified Bing Webmaster property (complements IndexNow; opt-in with a Bing API key)
- **robots.txt sitemap auto-discovery** — automatically finds every `Sitemap:` declared in `robots.txt` (not just the one you configured), so secondary sitemaps like `llms-sitemap.xml` are covered with zero extra setup
- **GEO-aware routing** — non-HTML URLs (e.g. `llms.txt`, `llms-full.txt`) are pushed to **IndexNow only** (so Bing/AI answer engines re-crawl them) and deliberately kept out of the Google Indexing API + Search Console, where they'd just be noise
- **Google URL Inspection API** — daily automated verification of indexing status, mobile usability, and actual search crawl time logs for sitemapped pages
- **AI & Crawler GEO Audits** — automated rules auditing for key AI bots (`GPTBot`, `Gemini` via `Google-Extended`, `ClaudeBot`, `PerplexityBot`) in `robots.txt` + `llms.txt` existence validation
- **Semantic JSON-LD Structured Schema Auditing** — extracts and catalogs page schemas (`SoftwareApplication`, `LocalBusiness`, etc.) during sitemap crawls
- **Zero-Touch Key Deployments** — built-in pure-JS FTP/SFTP passive client + dynamic POST webhook callbacks to push IndexNow keys automatically
- **Delta sitemap submission** — submits sitemaps to GSC only when changes (new/modified URLs) are detected to conserve Google quotas
- **Multi-site round-robin** — interleaves URLs across all your sites `[A₀, B₀, C₀, A₁, B₁, C₁…]` so no single site monopolises the daily quota
- **lastmod change detection** — fetches your live sitemap and only queues URLs whose `<lastmod>` has changed since the last run
- **SQLite persistence** — URL state, submission history, and credentials survive container restarts
- **React dashboard** — onboarding wizard, per-site status, live log stream, cron scheduler, dynamic URL indexing table
- **Analytics engine** — daily per-site rollups with a portfolio dashboard: coverage funnel (sitemap → submitted → indexed), 60-day trends, GSC indexing-state breakdown, and day-over-day regression **alerts** (index drops, structured-data loss)
- **Freshness radar** — every page whose sitemap `lastmod` moved *after* Google's last crawl, surfaced as a resubmission worklist
- **AI citation tracking (GEO)** — run tracked prompts against **ChatGPT, Claude, Gemini, Perplexity, Grok and Brave Search** and record whether the answers cite your domains; per-prompt × provider matrix with answer excerpts. Providers are optional — add whichever keys you have
- **One-click Gemini key** — provisions a service-restricted Gemini API key on *your* Google Cloud project using the already-linked account; no console visit, no copy-paste, free tier
- **Bing Webmaster API** — URL batch submission + quota on Bing's own (separate) submission allowance, alongside IndexNow
- **llms.txt lifecycle** — live-fetch, structural lint, drift detection against the generated file, and one-click deploy (webhook/FTP)
- **Core Web Vitals** — origin-level p75 LCP/INP/CLS via the free CrUX API, snapshotted daily
- **Site hygiene checks** — sampled broken-link and redirect-chain probes across your sitemap URLs
- **Notifications** — run summaries and alerts to Slack, Discord, ntfy or any generic webhook
- **Single container** — no external database, no Redis, no separate workers

---

## Quick Start

```bash
docker run -d \
  --name seo-indexer \
  -p 3000:3000 \
  -v seo-indexer-data:/data \
  ghcr.io/martadams89/seo-website-indexer:latest
```

Or with Docker Compose:

```bash
curl -O https://raw.githubusercontent.com/martadams89/seo-website-indexer/main/docker-compose.yml
docker compose up -d
```

Then open **http://localhost:3000** and follow the three-step setup wizard.

---

## Authentication

This application uses the secure **Google OAuth 2.0 Web Application Flow** (which is completely unrestricted by Google and operates using standard browser authorization redirects).

> **Scopes requested**: Search Console (`webmasters`), Indexing API (`indexing`), your email address, and **Google Cloud (`cloud-platform`)**. The Cloud scope exists for exactly one optional feature — the *one-click Gemini API key* button in Settings, which creates a key on **your own** project, restricted to the Generative Language API only. Accounts linked before this scope was added keep working for indexing; they just need a one-time re-link before using that button.

Because Service Accounts are highly restricted and often fail verification on Google Search Console (especially for modern Domain properties), authenticating as your **regular Google user account** is the recommended and standard path. It grants the indexing container direct, seamless API access to all Search Console properties that your account already owns—with **zero configuration changes** inside Google Search Console!

### How to set up your Google Cloud API credentials (Foolproof Step-by-Step):

If you don't have a pre-configured container, follow this simple guide to set up your credentials in less than 2 minutes.

#### 1️⃣ Step 1: Create a Google Cloud Project
- Open the [Google Cloud Project Creation Console](https://console.cloud.google.com/projectcreate).
- Give your project a name (e.g., `SEO Website Indexer`) and click **Create**.
- Make sure your new project is selected in the top project dropdown bar of the Cloud Console.

#### 2️⃣ Step 2: Enable required Search APIs
You must enable the two Google APIs that this tool communicates with:
- 👉 Go to the [Google Search Console API Page](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com) and click **Enable**.
- 👉 Go to the [Web Search Indexing API Page](https://console.cloud.google.com/apis/library/indexing.googleapis.com) and click **Enable**.

#### 3️⃣ Step 3: Configure the OAuth Consent Screen
Google requires you to describe how your app authorizes users:
- Open the [OAuth Consent Screen Configuration Page](https://console.cloud.google.com/apis/credentials/consent).
- Select **External** as the user type and click **Create**.
- Enter your **App Name** (e.g., `SEO Indexer`) and your **User Support Email** (your Google email).
- Scroll to the bottom and click **Save and Continue** until you reach the **Test Users** screen.
- ⚠️ **CRITICAL STEP (Must Do):** Click **+ Add Users** and enter your Google account email address. Google restricts unverified "Testing" apps to explicitly authorized email addresses only. If you skip this, Google will block your login with an error!
- Click **Save and Continue** to finish.

#### 4️⃣ Step 4: Create your Web OAuth Client ID
- Open the [Credentials Management Page](https://console.cloud.google.com/apis/credentials).
- Click **+ Create Credentials** at the top, and select **OAuth client ID**.
- Under **Application type**, select **Web application** (do *not* choose "Desktop app" or "TV app").
- Give it a name (e.g. `SEO Indexer Client`).
- Scroll down to **Authorized redirect URIs** and click **+ Add URI**.
- Paste your exact container redirect callback URI:
  - Default local: `http://localhost:3000/api/auth/google/callback`
  - (If you are running the dashboard on custom ports or reverse proxies, use your custom domain equivalent, which is dynamically calculated and displayed on your Setup wizard screen!).
- Click **Create**.

#### 5️⃣ Step 5: Configure the Container & Connect
- Copy your new **Client ID** and **Client Secret**.
- Paste them directly into the onboarding Setup wizard, OR save them directly in your environment variables inside `docker-compose.yml`:
  ```yaml
  environment:
    - GOOGLE_OAUTH_CLIENT_ID=your-client-id
    - GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
  ```
- Click **Start Google Sign-In**. A secure Google authentication popup will open.
- Log in with your Google account.
- Once authorized, the popup will communicate success back to your browser tab, automatically self-close, and your container is fully configured and connected!

---

## IndexNow — Setting Up the Key File

> **If you're seeing `403 UserForbiddedToAccessSite`** — this section is exactly why.

IndexNow works like a challenge/response: before Bing will accept your submission, it fetches a small text file from your website to confirm you own it.

```
GET https://yourdomain.com/{your-key}.txt
Expected response body: your-key     (plain text, nothing else)
```

Your unique key per site is shown in the dashboard under **Sites → IndexNow Setup**.

There are two ways to get that file in place:

---

### Method 1 — Proxy the key file through this container (zero-deploy)

If you already run a reverse proxy (nginx, Caddy, Traefik, Cloudflare Tunnel) in front of this container and your website, you can forward `.txt` key-file requests to the container. **The container serves the correct file automatically for every registered site** — no manual file creation needed.

**nginx:**
```nginx
# Add inside your server {} block for the site
location ~* ^/[a-f0-9]{8,128}\.txt$ {
    proxy_pass http://seo-indexer:3000;
    proxy_set_header Host $host;
}
```

**Caddy:**
```caddyfile
yourdomain.com {
    @indexnow path_regexp ^/[a-f0-9]{8,128}\.txt$
    reverse_proxy @indexnow seo-indexer:3000

    # ... rest of your config
}
```

**Traefik (labels on the seo-indexer service):**
```yaml
labels:
  - "traefik.http.routers.indexnow-key.rule=Host(`yourdomain.com`) && PathRegexp(`^/[a-f0-9]{8,128}\\.txt$`)"
  - "traefik.http.routers.indexnow-key.service=seo-indexer"
```

After adding the proxy rule, click **Verify Key File** in the dashboard to confirm it works.

---

### Method 2 — Place a static file on your website

Find your key in the dashboard (**Sites → IndexNow Setup → copy key**), then follow the instructions for your platform:

#### Next.js (App Router)
Create `public/{YOUR_KEY}.txt` containing just the key:
```bash
echo -n "YOUR_KEY_HERE" > public/YOUR_KEY_HERE.txt
```
Deploy normally. The file is served at `https://yourdomain.com/YOUR_KEY_HERE.txt`.

#### Next.js (Pages Router)
Same as App Router — the `public/` directory is served as static files at the root path.

#### Astro
```bash
echo -n "YOUR_KEY_HERE" > public/YOUR_KEY_HERE.txt
```
Astro copies everything in `public/` to the build output root. Deploy as normal.

#### Nuxt
```bash
echo -n "YOUR_KEY_HERE" > public/YOUR_KEY_HERE.txt
```
Nuxt's `public/` directory maps to `/` in production.

#### SvelteKit
```bash
echo -n "YOUR_KEY_HERE" > static/YOUR_KEY_HERE.txt
```
SvelteKit serves the `static/` directory at the root.

#### Gatsby
```bash
echo -n "YOUR_KEY_HERE" > static/YOUR_KEY_HERE.txt
```

#### Hugo
```bash
echo -n "YOUR_KEY_HERE" > static/YOUR_KEY_HERE.txt
```

#### Create React App / Vite (plain SPA)
```bash
echo -n "YOUR_KEY_HERE" > public/YOUR_KEY_HERE.txt
```

#### Jekyll
```bash
echo -n "YOUR_KEY_HERE" > YOUR_KEY_HERE.txt
# Add to front matter or just leave it as-is — Jekyll copies unknown files
```

#### WordPress
Upload the file via FTP/SFTP to your WordPress root directory (same folder as `wp-config.php`):
```
/var/www/html/YOUR_KEY_HERE.txt
```
Or use a file manager plugin. The file should be accessible at `https://yourdomain.com/YOUR_KEY_HERE.txt`.

#### Webflow
Webflow → **Project Settings → SEO → Meta Tags**. Webflow doesn't support arbitrary file uploads directly.  
Use **Method 1 (proxy)** instead, or add a custom redirect rule if your plan supports it.

#### Shopify
In Shopify Admin → **Online Store → Themes → Actions → Edit code**, create a new file in the root of your theme. Note: Shopify serves theme files under `/` only for a limited set of file types. **Method 1 (proxy via a CDN/edge worker) is recommended for Shopify**.

#### Squarespace / Wix / Framer / other hosted builders
These platforms do not support arbitrary file placement.  
Use **Method 1** (proxy through nginx/Caddy/Cloudflare Worker) or host the key file on a subdomain that redirects:

```
# Cloudflare Worker — place on your domain
addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (/^\/[a-f0-9]{8,128}\.txt$/.test(url.pathname)) {
    event.respondWith(fetch('https://your-seo-indexer.example.com' + url.pathname))
  }
})
```

#### Plain HTML / static hosting (Netlify, Vercel, Cloudflare Pages, GitHub Pages)

Create the file in your `public/` or output directory:
```bash
echo -n "YOUR_KEY_HERE" > public/YOUR_KEY_HERE.txt
```

**Netlify** — add a redirect to serve from a different origin if needed:
```toml
# netlify.toml
[[redirects]]
  from = "/:key.txt"
  to = "https://your-seo-indexer.example.com/:key.txt"
  status = 200
  force = true
```

**Vercel** — `vercel.json` rewrite:
```json
{
  "rewrites": [
    {
      "source": "/:key(\[a-f0-9\]{8,128}).txt",
      "destination": "https://your-seo-indexer.example.com/:key.txt"
    }
  ]
}
```

**Cloudflare Pages** — `_redirects` file:
```
/:key.txt  https://your-seo-indexer.example.com/:key.txt  200
```

---

### Method 3 — Zero-Touch Auto-Deployment (FTP or Webhooks)

This is the easiest option! Click **Edit Site** on any site in your dashboard, expand the **⚙️ Auto-Deploy Verification Key** settings details block, and choose one of these automated deployment methods:

#### 1. FTP Key Upload
Enter your FTP credentials (Host, Username, Password, Port, and Path to public root). On every site verification or IndexNow run, the indexer will connect via a secure standard FTP connection and upload the `{key}.txt` file directly into your website's root directory automatically!

#### 2. Deployment Webhooks
If your website uses a static site builder (Next.js/Astro/WP), a Headless CMS (Strapi/Sanity), or is hosted on modern hosts (Vercel/Netlify/GitHub Pages), enter your custom deploy trigger webhook URL. We will trigger an HTTP POST request to that URL containing the key details in the body:
```json
{
  "key": "29e9ff3cfd814c8fb239c4a861ad9f81",
  "filename": "29e9ff3cfd814c8fb239c4a861ad9f81.txt",
  "content": "29e9ff3cfd814c8fb239c4a861ad9f81"
}
```
You can capture this request inside your webhook handlers to trigger an automated rebuild or save the key dynamically!

---

### Enterprise SEO & GEO Audits

The indexer also includes advanced enterprise-grade automation features to audit and validate your site's SEO/GEO friendliness:

#### 📈 Google URL Inspection Audit logs
When configured with GSC, the scheduler automatically inspects the 5 oldest URLs per site daily. It fetches:
- **Indexing Verdict**: e.g., `Indexed`, `Crawled - currently not indexed`, or `Discovered - currently not indexed`.
- **Crawl Timestamps**: The exact date and time the Googlebot crawler last crawled your page.
- **Rich Results & Usability**: Full verification of mobile-friendliness.
These audits are tracked dynamically inside the **Sitemap Crawl & Indexing Audit logs** table under each site's expanded card in the dashboard.

#### 🤖 AI Crawler Robots.txt Audits
Generates daily audits testing if standard AI parsers (`GPTBot`, `Gemini` via `Google-Extended`, `ClaudeBot`, `PerplexityBot`) are allowed to scrape your domain or if they are blocked. Status badges are shown directly on each site card.

#### 📄 /llms.txt AI Specifications Audit
Validates whether your website serves an `/llms.txt` file at the root to declare custom prompts and semantic datasets for Large Language Models.

#### 🏷️ Semantic JSON-LD Structured Schema Auditing
Automatically scans and identifies Inline JSON-LD schemas (such as `SoftwareApplication`, `LocalBusiness`, `Organization`, `FAQPage`, etc.) on all sitemap crawl runs. These extracted schemas are cataloged next to each sitemap URL in your logs.

---

### Checking verification status

After placing the key file, go to **Sites → your site → IndexNow Setup → Verify Key File**.  
The dashboard will fetch the URL and confirm the content matches. If it fails, it shows exactly what went wrong.

**Once verified, IndexNow submissions will succeed automatically on every subsequent run.** You don't need to re-verify unless you delete and regenerate the key.

---

## Bing Webmaster URL Submission

IndexNow already notifies Bing (it's Bing's own protocol), so for most people **IndexNow is enough**. Enable this *additional* direct channel if you want submissions to land straight in your verified Bing Webmaster property and want the tool to report your remaining Bing quota.

**One-time setup:**

1. Verify each site in [Bing Webmaster Tools](https://www.bing.com/webmasters) — the fastest way is **Import from Google Search Console**.
2. In Bing Webmaster, open **Settings → API access → API Key** and generate a key. One key covers every site verified under that Bing account.
3. In this tool, go to **Settings → Bing API key**, paste it, and save. (Stored encrypted-at-rest in SQLite; the API never returns it in plaintext.)

That's it. On each run, the scheduler submits **new and changed HTML pages** to Bing via `SubmitUrlBatch`, batched at 500/call, and respects your live daily quota (`GetUrlSubmissionQuota`). `llms.txt` and other non-HTML URLs are **not** sent here — they go via IndexNow.

> Set it via the API instead of the UI:
> ```bash
> curl -X PUT http://localhost:3000/api/settings \
>   -H 'Content-Type: application/json' \
>   -d '{"bing_api_key":"YOUR_BING_KEY"}'
> ```

To skip Bing for a single manual run, POST `/api/runs` with `{"skipBing": true}`.

---

## How `llms-sitemap.xml` is handled (GEO)

You don't have to configure anything. On every run the indexer reads each site's `robots.txt`, collects **all** declared `Sitemap:` URLs, and merges them with the sitemap you configured. So if your `robots.txt` has:

```
Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/llms-sitemap.xml
```

…both are crawled. URLs are then routed by type:

| URL type | Google Indexing API | GSC sitemap | Bing Webmaster | IndexNow |
|----------|:---:|:---:|:---:|:---:|
| HTML pages | ✅ | ✅ | ✅ | ✅ |
| `llms.txt`, `llms-full.txt`, other non-HTML | ❌ | ❌ | ❌ | ✅ |

Non-HTML files are intentionally kept out of Google/Bing search submission (they aren't indexable pages and would just create "Excluded" noise), but **are** pushed to IndexNow so Bing and AI answer engines re-crawl your latest AI index. Their change-state is tracked the same way as pages, so they're only re-submitted when their `<lastmod>` changes.

---

## Sitemap `<lastmod>` — Why it matters

The scheduler compares each URL's `<lastmod>` against the last known value. **Only changed or new URLs are submitted**, so you don't waste quota re-submitting pages that haven't changed.

Without `<lastmod>`, all URLs are rotated (the tool still works, but it's less efficient).

### Adding `<lastmod>` by framework

**Next.js (App Router):**
```ts
// app/sitemap.ts
export default function sitemap(): MetadataRoute.Sitemap {
  return pages.map(page => ({
    url: `https://yourdomain.com/${page.slug}`,
    lastModified: page.updatedAt,  // Date object or ISO string
  }));
}
```

**Astro (`@astrojs/sitemap`):**
```js
// astro.config.mjs
import sitemap from '@astrojs/sitemap';
export default defineConfig({
  site: 'https://yourdomain.com',
  integrations: [sitemap()],
  // astro-sitemap uses page.lastModified if available, or build time
});
```

**WordPress — Yoast SEO or Rank Math:**
Both automatically add `<lastmod>` using the post's modified date. No configuration needed.

**Hugo:**
```toml
# config.toml
[sitemap]
  changefreq = "weekly"
  filename   = "sitemap.xml"
  priority   = 0.5
# Hugo includes <lastmod> from .Lastmod (git commit date or front matter)
```

**Jekyll (`jekyll-sitemap` gem):**
```yaml
# _config.yml — the plugin includes lastmod from page.last_modified_at or date
plugins:
  - jekyll-sitemap
```

---

## Adding Multiple Sites

There is no limit to the number of sites you can add. Each site gets:
- Its own IndexNow key (stored in SQLite)
- Its own URL state and lastmod tracking
- A share of the daily Google Indexing API quota (distributed round-robin)

To add a site: **Dashboard → Sites → Add Site**, enter the domain, sitemap URL, and Google Search Console property URL.

The Google Indexing API is limited to **200 URLs/day across all sites in your Google Cloud project**. With 5 sites, each gets ~40 URLs/day. The scheduler prioritises new and recently-changed pages within that budget.

---

## API Keys — Analytics, CWV & AI Citation Tracking

Everything below is **optional** — the core indexing loop needs none of it. Keys are **write-only**: the API stores them server-side and never echoes them back; the UI shows a "configured" badge instead.

| Key | Where to get it | Cost | Unlocks |
|-----|-----------------|------|---------|
| Gemini | **One-click button in Settings** (or [AI Studio](https://aistudio.google.com/apikey)) | **Free tier** | Grounded-AI citation checks |
| Brave Search | [brave.com/search/api](https://brave.com/search/api/) | **Free** (~2k queries/mo, no card) | Retrieval-layer presence — Brave grounds Claude's web search |
| Bing Webmaster | Bing Webmaster Tools → Settings → API access | Free | URL submission + quota via Bing's own allowance |
| CrUX | [Google Cloud credentials](https://console.cloud.google.com/apis/credentials) | Free | Core Web Vitals (p75 LCP/INP/CLS) |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | Paid (pennies/sweep) | ChatGPT citation checks (web search) |
| Anthropic | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Paid | Claude citation checks (web search) |
| Perplexity | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) | Paid | Perplexity (sonar) citation checks |
| xAI | [console.x.ai](https://console.x.ai/) | Paid | Grok citation checks (live search) |

**Zero-cost recommended setup**: link your Google account → Settings → *⚡ Generate with linked Google account* (Gemini) → paste a free Brave key. That gives you one real grounded-LLM answer engine *and* retrieval-layer tracking without spending anything.

**Why no headless-browser scraping of the chat UIs?** It violates those services' terms, requires maintaining logged-in sessions against active bot defences (risking the accounts), and logged-out answers are personalised/experiment-bucketed anyway — the API + retrieval-layer approach gives a cleaner signal with none of the exposure.

**AI citation sweeps are manual by design** (the *Run all* button) so provider costs never accrue unattended. Wire `runAllPrompts()` into the scheduler if you want them recurring.

---

## Configuration

| Variable       | Default     | Description                   |
|----------------|-------------|-------------------------------|
| `PORT`         | `3000`      | HTTP port                     |
| `HOST`         | `0.0.0.0`   | Bind address                  |
| `DATA_DIR`     | `/data`     | SQLite database directory     |

All other settings (cron schedule, etc.) are configured via the UI and stored in SQLite.

---

## Releases & Self-Maintenance

This repo looks after itself:

- **Automated releases** — [release-please](https://github.com/googleapis/release-please) turns [Conventional Commits](CONTRIBUTING.md#commit-messages--conventional-commits-required) into a rolling release PR with a generated changelog. Merging it tags `vX.Y.Z`, publishes a GitHub Release with notes, and the Docker workflow ships `latest`, `X.Y.Z` and `X.Y` image tags automatically. The running version is visible at `/api/status`.
- **Automated dependency updates** — [Renovate](https://docs.renovatebot.com) opens grouped weekly PRs; patch/minor updates, action pins and lockfile maintenance **auto-merge once CI is green** (unit tests + typecheck + lint + build + Docker build). Majors — and `better-sqlite3` majors especially, which track the Node ABI — wait for a human.
- **Self-hosted Renovate** — runs as a [workflow](.github/workflows/renovate.yml) (Mondays + manual dispatch), no third-party app. One-time setup on a fork: add a fine-grained PAT as the `RENOVATE_TOKEN` secret (Contents, Pull requests, Workflows — read/write), allow auto-merge in repo settings, and require the status checks **`backend`**, **`frontend`** and **`build-and-push`** on `main` so auto-merge is gated on green CI. Renovate updates its own action pin, so the bot maintains itself too.

---

## Development

```bash
# Backend (tsx watch — auto-restarts on change)
cd backend
npm install
npm run dev       # http://localhost:3000

# Frontend (Vite HMR)
cd frontend
npm install
npm run dev       # http://localhost:5173 (proxies /api/* to :3000)
```

---

## Architecture

```
┌─────────────────────────────────────────────┐
│              React + Vite SPA               │
│ Setup | Dashboard | Analytics | Citations | │
│        Sites | Accounts | Logs | Settings   │
└──────────────────┬──────────────────────────┘
                   │ HTTP REST + SSE
┌──────────────────▼──────────────────────────┐
│              Fastify (Node.js)              │
│                                             │
│  /api/*        REST endpoints               │
│  /api/logs/stream  SSE live log feed        │
│  /{key}.txt    IndexNow key file (auto)     │
│  /*            Serve built frontend SPA     │
│                                             │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │ google- │  │scheduler │  │ indexnow  │  │
│  │ oauth   │  │(cron +   │  │(key mgmt +│  │
│  │ .ts     │  │ round-   │  │ submit)   │  │
│  │         │  │ robin)   │  │           │  │
│  └─────────┘  └──────────┘  └───────────┘  │
│  ┌─────────────────────────────────────┐    │
│  │          SQLite (WAL mode)          │    │
│  │  sites | url_state | runs | logs    │    │
│  │  settings | indexnow_keys           │    │
│  └─────────────────────────────────────┘    │
└────┬──────────────────┬──────────────────────┘
     │                  │
     ▼                  ▼
Google APIs         IndexNow API
(Indexing API +    (api.indexnow.org →
 Search Console)    Bing, Yandex, Yahoo…)
```

---

## Contributing

Contributions are very welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)** for the two-minute setup, and note that commit messages follow Conventional Commits because they *become* the release notes. Bugs and ideas → [issues](https://github.com/martadams89/seo-website-indexer/issues) (templates provided).

---

## License

This project is licensed under the [GPL-3.0 License](LICENSE).
