# SEO Website Indexer

Self-hosted Docker container for Google Search Console + IndexNow SEO indexing automation.  
Works with **any number of sites** — add them all to the dashboard and it handles everything.

[![Docker](https://img.shields.io/badge/ghcr.io-martadams89%2Fseo--website--indexer-blue?logo=docker)](https://github.com/martadams89/seo-website-indexer/pkgs/container/seo-website-indexer)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## Features

- **Google Indexing API** — notify Google of URL changes (200 URLs/day per Google Cloud project)
- **Google Search Console** — automatic sitemap submission per site
- **IndexNow** — instantly alert Bing, Yandex, Yahoo, and other participating engines (all via one API call)
- **Multi-site round-robin** — interleaves URLs across all your sites `[A₀, B₀, C₀, A₁, B₁, C₁…]` so no single site monopolises the daily quota
- **lastmod change detection** — fetches your live sitemap and only queues URLs whose `<lastmod>` has changed since the last run
- **SQLite persistence** — URL state, submission history, and credentials survive container restarts
- **React dashboard** — onboarding wizard, per-site status, live log stream, cron scheduler
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

This application uses the secure **Google OAuth 2.0 Device Flow** (which operates exactly like the `gcloud CLI` or tools like `rclone` authenticate). 

Because Service Accounts are highly restricted and often fail verification on Google Search Console (especially for modern Domain properties), authenticating as your **regular Google user account** is the recommended and standard path. It grants the indexing container direct, seamless API access to all Search Console properties that your account already owns—with **zero configuration changes** inside Google Search Console!

### How to set up your Google Cloud API credentials:

1. **Create an OAuth Client:**
   - Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
   - Click **Create Credentials** → **OAuth client ID**.
   - Select **Desktop app** as the Application Type, name it (e.g. `SEO Indexer`), and click **Create**.
2. **Enable the Google APIs:**
   - Enable both of the following APIs in your Google Cloud Project:
     - [Google Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com)
     - [Web Search Indexing API](https://console.cloud.google.com/apis/library/indexing.googleapis.com)
3. **Configure the Container:**
   - Copy your new **Client ID** and **Client Secret**.
   - Paste them into the onboarding Setup wizard, OR bake them directly into your container via environment variables in your `docker-compose.yml`:
     ```yaml
     environment:
       - GOOGLE_OAUTH_CLIENT_ID=your-client-id
       - GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
     ```
4. **One-Click Authorization:**
   - The wizard will display a short verification code and link (e.g., `https://google.com/device`).
   - Open the link on any device, log in with your Google account, and enter the code.
   - The container securely saves the refresh token locally and automatically renews your access tokens in the background. Done!

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

### Checking verification status

After placing the key file, go to **Sites → your site → IndexNow Setup → Verify Key File**.  
The dashboard will fetch the URL and confirm the content matches. If it fails, it shows exactly what went wrong.

**Once verified, IndexNow submissions will succeed automatically on every subsequent run.** You don't need to re-verify unless you delete and regenerate the key.

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

## Configuration

| Variable       | Default     | Description                   |
|----------------|-------------|-------------------------------|
| `PORT`         | `3000`      | HTTP port                     |
| `HOST`         | `0.0.0.0`   | Bind address                  |
| `DATA_DIR`     | `/data`     | SQLite database directory     |

All other settings (cron schedule, etc.) are configured via the UI and stored in SQLite.

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
│   Setup Wizard | Dashboard | Sites | Logs   │
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

## License

MIT
