# Google, IndexNow, Bing and sitemap setup

This guide explains how a site moves from a sitemap to monitored search-engine submissions. Start with one site and an audit run before enabling a schedule across a large workspace.

## Add a site

Open **Sites & Submissions → Add Site** and enter:

- a name and domain;
- the main sitemap URL;
- the matching Google Search Console property when Google is connected; and
- the Google or Bing account that should be used, if the workspace has more than one.

The scheduler also reads `robots.txt` and follows every valid `Sitemap:` declaration it finds. This allows a site to have separate page, image, news or `llms-sitemap.xml` files without adding each one by hand.

## Sitemap `lastmod`

The application remembers the URLs and `lastmod` values from the previous crawl. New or changed URLs are submitted; unchanged URLs do not repeatedly consume provider quota.

A sitemap entry should use a real content modification time:

```xml
<url>
  <loc>https://example.com/guides/example</loc>
  <lastmod>2026-08-17T08:30:00Z</lastmod>
</url>
```

Do not set every page to the current time on every build. That makes every URL appear changed and removes the benefit of delta submission.

Common sitemap tools already derive this value from the post's modified date. In a custom application, use the source record's update time rather than the deployment time.

## Connect Google Search Console

Connecting Google for Search Console is separate from signing in to the dashboard with Google SSO.

The connection uses the OAuth 2.0 web application flow and requests offline access. Access tokens are refreshed automatically while the Google grant remains valid. The standard connection requests Search Console, read-only Google Analytics and email scopes. The broader `cloud-platform` scope is requested only when the optional Google API auto-configuration flow is selected.

### Use a Google OAuth client configured by the operator

If the deployment already has Google OAuth credentials in its environment, select **Settings → Google Accounts → Connect Google** and complete the consent window.

### Use your own Google OAuth client

Self-hosters can supply their own credentials:

1. Create or select a [Google Cloud project](https://console.cloud.google.com/projectcreate).
2. Enable the [Google Search Console API](https://console.cloud.google.com/apis/library/searchconsole.googleapis.com).
3. Configure the project's OAuth consent screen.
4. Create an OAuth client with application type **Web application**.
5. Add the exact callback shown by the setup screen. It normally has this form:

   ```text
   https://indexer.example.com/api/auth/google/callback
   ```

6. Set the credentials on the container or enter them in the setup flow:

   ```bash
   GOOGLE_OAUTH_CLIENT_ID=your-client-id
   GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
   ```

7. Return to **Settings → Google Accounts** and complete the connection.

For an external OAuth app, add the required accounts as test users while setting it up. Google's testing status may issue refresh grants that expire after seven days. Move a long-running external app to production, or use an internal or trusted Google Workspace app where appropriate, then reconnect the account to obtain a new grant.

The Google user must have access to the Search Console properties being added. A regular user OAuth connection is normally simpler than trying to use a service account with domain properties.

### Sharing a Google connection

The person who completes OAuth owns the credential. They can share it with other workspaces they can access. Other members of those workspaces may use the shared account for sites and integrations without knowing its tokens.

Removing the account from one workspace only removes that share. Deleting the credential from every workspace is limited to its owner or a super-admin. See [users and workspaces](USERS_AND_WORKSPACES.md#google-accounts).

### Refresh problems

The Google Accounts screen shows when a credential needs authorization and records the last refresh error. Common causes are:

- the OAuth app is still in external testing mode;
- the user revoked the grant;
- a Google Workspace session or app policy requires reauthentication;
- the client secret was replaced; or
- the callback hostname changed.

Use **Reconnect** on the existing account so sites keep their account assignment.

## Set up IndexNow

IndexNow verifies site control by requesting a text file from the site:

```text
GET https://example.com/YOUR_KEY.txt
```

The response body must be the key as plain text. Find the per-site key under **Sites & Submissions → site → IndexNow**.

Choose one of these methods.

### Proxy the key request to the container

The container can serve registered key files itself. Forward matching paths from the website to the indexer and preserve the original `Host` header.

Example nginx location:

```nginx
location ~* ^/[a-f0-9]{8,128}\.txt$ {
    proxy_pass http://seo-indexer:3000;
    proxy_set_header Host $host;
}
```

Example Caddy route:

```caddyfile
example.com {
    @indexnow path_regexp ^/[a-f0-9]{8,128}\.txt$
    reverse_proxy @indexnow seo-indexer:3000
}
```

This is useful when the website and indexer share a reverse proxy or when the publishing platform cannot place arbitrary files at the domain root.

### Add a static file to the website

Create a file named `YOUR_KEY.txt` containing only `YOUR_KEY`, then deploy it at the root of the site.

| Platform | Typical source location |
| --- | --- |
| Next.js, Nuxt, Astro, Vite | `public/YOUR_KEY.txt` |
| SvelteKit, Gatsby, Hugo | `static/YOUR_KEY.txt` |
| Jekyll | `YOUR_KEY.txt` in the project root |
| WordPress or plain hosting | Web root beside the site's normal entry files |

Hosted builders that do not support root files usually need a proxy, rewrite or edge function instead.

### Deploy through FTP/SFTP or a webhook

Open the site's configuration and set **Auto-Deploy Verification Key** to an FTP/SFTP destination or a deployment webhook.

The webhook receives a JSON body like this:

```json
{
  "key": "29e9ff3cfd814c8fb239c4a861ad9f81",
  "filename": "29e9ff3cfd814c8fb239c4a861ad9f81.txt",
  "content": "29e9ff3cfd814c8fb239c4a861ad9f81"
}
```

Use it to write the file or trigger a build in the site's own delivery system.

### Verify the file

Select **Verify Key File** in the site's IndexNow tab. The dashboard fetches the public URL and checks both the response and content. A `403 UserForbiddedToAccessSite` response from IndexNow usually means the key file is missing, unreachable or does not contain the expected value.

## Bing Webmaster

IndexNow already notifies Bing. The direct Bing Webmaster connection is optional and provides another quota-controlled submission route into verified Bing properties.

The application supports either delegated OAuth or an API key.

### OAuth

1. In Bing Webmaster Tools, create an OAuth client under API access.
2. Register this callback, using the real application hostname:

   ```text
   https://indexer.example.com/api/auth/bing/callback
   ```

3. Save the client ID and secret under **Settings → API Keys** for the workspace or as a platform default.
4. Under **Settings → API Keys → Bing Webmaster accounts**, select **Connect with OAuth**.

### API key

1. Verify the site in [Bing Webmaster Tools](https://www.bing.com/webmasters/).
2. Create an API key under **Settings → API access** in Bing.
3. Add it under **Settings → API Keys → Bing Webmaster accounts**.
4. Select the account in the site's configuration when the workspace has more than one.

Direct Bing submissions are sent in batches and stop when the live daily quota is exhausted. Non-HTML files are not sent through this API.

## `llms.txt` and non-HTML files

The application separates search-indexable pages from files intended for other consumers:

| Content | Search Console sitemap submission | Bing Webmaster URL submission | IndexNow |
| --- | :---: | :---: | :---: |
| HTML pages | Yes | Yes | Yes |
| `llms.txt`, `llms-full.txt`, other non-HTML files | No | No | Yes |

This avoids adding non-HTML noise to Google or Bing index coverage while still notifying IndexNow consumers when a file changes.

Under a site's **Delivery & GEO** tab, the application can inspect, edit and deploy `llms.txt`. If an AI provider key is configured, it can draft the file from the site's known pages. Review generated content before saving or publishing it. Managed delivery can also maintain an `llms-sitemap.xml` through the site's configured webhook or FTP/SFTP route.

## Failed submissions

Failures remain visible so a temporary problem is not silently forgotten. Open the **Submission failures** panel on the Command Centre.

For each record you can:

1. Select **Check** to make a HEAD or small GET request to the live URL. This does not consume search-engine submission quota.
2. Fix the site's response, verification file, account or provider configuration.
3. Clear that failure record so the next run may try again.

Use **Clear all** only after understanding whether the failures have a common cause. Clearing removes the saved backoff state; it does not submit the URLs immediately or repair the underlying issue.

Failures are limited to sites in the active workspace. Clearing them is recorded in the audit history.

## What the scheduled audit records

Depending on the connected services, scheduled runs can record:

- sitemap discovery and changes;
- Search Console submission and URL Inspection state;
- Google crawl time and mobile usability details;
- IndexNow and Bing submission outcomes and quota state;
- broken links and redirect chains from sampled URLs;
- JSON-LD schema types found on pages;
- `robots.txt`, named AI crawler access and `llms.txt` availability; and
- Core Web Vitals from CrUX where the origin has enough public field data.

Use **Live Activity** for the detailed run log and the site's analytics view for history and coverage trends.
