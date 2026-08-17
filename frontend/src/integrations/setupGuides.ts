import type { IntegrationProvider } from '../api';

export type IntegrationSetupGuide = {
  access: string;
  accessDetail: string;
  permissions: Array<{ label: string; value: string }>;
  requirements: string[];
  steps: Array<{ title: string; detail: string }>;
  values: Array<{ field: string; source: string }>;
  troubleshooting: string[];
  docs: Array<{ label: string; href: string }>;
};

export const INTEGRATION_SETUP_GUIDES: Record<IntegrationProvider, IntegrationSetupGuide> = {
  ga4: {
    access: 'Read-only Analytics access',
    accessDetail: 'The app reads reports. It cannot change the property, audiences, events or advertising settings.',
    permissions: [
      { label: 'OAuth scope', value: 'https://www.googleapis.com/auth/analytics.readonly' },
      { label: 'GA4 property role', value: 'Viewer or higher' },
      { label: 'Google Cloud API', value: 'Google Analytics Data API' },
    ],
    requirements: [
      'A Google account connected under Settings → Google Accounts and shared with this workspace.',
      'Viewer, Analyst, Editor or Administrator access to the exact GA4 property.',
      'No “No Revenue Metrics” data restriction if revenue should be imported.',
    ],
    steps: [
      { title: 'Enable the reporting API', detail: 'In the Google Cloud project that owns your OAuth client, enable Google Analytics Data API (analyticsdata.googleapis.com).' },
      { title: 'Check the OAuth client', detail: 'Use a Web application client and register https://YOUR-HOST/api/auth/google/callback exactly. The app requests analytics.readonly automatically.' },
      { title: 'Grant property access', detail: 'In GA4 open Admin → Property access management and add the same Google account as Viewer or higher.' },
      { title: 'Copy the correct property ID', detail: 'Open Admin → Property settings → Property details and copy the numeric Property ID. Do not use the G- measurement ID.' },
      { title: 'Connect and verify', detail: 'Choose the linked Google account, paste the property ID, save, then use Sync from Your connections.' },
    ],
    values: [
      { field: 'Google account', source: 'Settings → Google Accounts. Connect your own account or use one already shared with the workspace.' },
      { field: 'GA4 property ID', source: 'GA4 → Admin → Property settings → Property details. It is numeric, for example 123456789.' },
    ],
    troubleshooting: [
      '403 PERMISSION_DENIED usually means the Data API is disabled or the selected Google account cannot view that property.',
      'A G-XXXXXXXXXX value is a measurement ID, not a property ID.',
      'External OAuth apps left in Testing can issue refresh grants that expire after seven days. Use Production or an Internal app for a durable connection.',
    ],
    docs: [
      { label: 'Google Analytics Data API quickstart', href: 'https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart' },
      { label: 'Find a GA4 property ID', href: 'https://developers.google.com/analytics/devguides/reporting/data/v1/property-id' },
      { label: 'GA4 roles and data restrictions', href: 'https://support.google.com/analytics/answer/9679158?hl=en' },
    ],
  },
  pagespeed: {
    access: 'PageSpeed Insights API key',
    accessDetail: 'No OAuth scope is needed. A key is optional for a manual trial and recommended for reliable scheduled checks.',
    permissions: [
      { label: 'OAuth scope', value: 'None' },
      { label: 'Google Cloud API', value: 'PageSpeed Insights API' },
      { label: 'Recommended restriction', value: 'API + server IP' },
    ],
    requirements: [
      'A website selected for the connection.',
      'A publicly reachable audit URL.',
      'A Google Cloud API key for scheduled use; billing is not normally required for the default quota.',
    ],
    steps: [
      { title: 'Enable PageSpeed Insights API', detail: 'Open Google Cloud API Library in your chosen project and enable pagespeedonline.googleapis.com.' },
      { title: 'Create a key', detail: 'Open APIs & Services → Credentials → Create credentials → API key.' },
      { title: 'Restrict the key', detail: 'Limit API access to PageSpeed Insights API. If the server has a stable outbound IP, add that application restriction too.' },
      { title: 'Choose the target', detail: 'Select a website and optionally enter a specific page. Leaving Audit URL blank uses the site home page.' },
      { title: 'Connect and sync', detail: 'The app runs separate mobile and desktop Lighthouse checks and records performance, accessibility, best-practices and SEO evidence.' },
    ],
    values: [
      { field: 'Audit URL', source: 'The public page to test. Leave blank to use the selected website home page.' },
      { field: 'PageSpeed API key', source: 'Google Cloud → APIs & Services → Credentials. This is separate from the CrUX key under Settings → API Keys.' },
    ],
    troubleshooting: [
      'API_KEY_SERVICE_BLOCKED means the key is restricted to the wrong API.',
      '429 responses mean the project quota is exhausted; lower the cadence or request more quota.',
      'This connection records Lighthouse lab data. Configure Chrome UX Report separately for real-user Core Web Vitals history.',
    ],
    docs: [
      { label: 'PageSpeed Insights API guide', href: 'https://developers.google.com/speed/docs/insights/v5/get-started' },
      { label: 'Enable PageSpeed Insights API', href: 'https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com' },
    ],
  },
  cloudflare: {
    access: 'Account Analytics: Read',
    accessDetail: 'Use a custom token limited to the target zone. The app only queries GraphQL analytics.',
    permissions: [
      { label: 'Account permission', value: 'Account Analytics: Read' },
      { label: 'Zone resources', value: 'Include → Specific zone' },
      { label: 'Write access', value: 'None' },
    ],
    requirements: [
      'The zone must be active in the Cloudflare account that creates the token.',
      'Permission to create API tokens for that account.',
    ],
    steps: [
      { title: 'Create a custom token', detail: 'Cloudflare dashboard → My Profile → API Tokens → Create Token → Create Custom Token.' },
      { title: 'Add the minimum permission', detail: 'Under Permissions choose Account → Account Analytics → Read.' },
      { title: 'Limit its resources', detail: 'Under Zone Resources choose Include → Specific zone → the website being connected.' },
      { title: 'Copy the zone ID', detail: 'Open the zone Overview page and copy Zone ID from the API section.' },
      { title: 'Save and verify', detail: 'Paste the Zone ID and token, save the connection and run Sync.' },
    ],
    values: [
      { field: 'Zone ID', source: 'Cloudflare dashboard → target domain → Overview → API → Zone ID.' },
      { field: 'Analytics API token', source: 'My Profile → API Tokens. Copy it when created; Cloudflare will not show it again.' },
    ],
    troubleshooting: [
      'A valid token can still return no zone when Zone Resources excludes the supplied Zone ID.',
      'Do not use the Global API Key. A custom read-only token is sufficient.',
      'The older “Zone Analytics: Read” wording is not the current GraphQL token permission; use Account Analytics: Read.',
    ],
    docs: [
      { label: 'GraphQL API token authentication', href: 'https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/' },
      { label: 'Find account and zone IDs', href: 'https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/' },
    ],
  },
  plausible: {
    access: 'Stats API key',
    accessDetail: 'The key reads aggregate analytics for the supplied site ID. There is no OAuth scope.',
    permissions: [
      { label: 'Key type', value: 'Stats API' },
      { label: 'Site access', value: 'Selected Plausible site' },
      { label: 'Write access', value: 'None' },
    ],
    requirements: [
      'A Plausible account with access to the site.',
      'A plan that includes the Stats API.',
    ],
    steps: [
      { title: 'Create a Stats API key', detail: 'Plausible → Account settings → API Keys → New API Key → Stats API.' },
      { title: 'Copy the token', detail: 'Save it immediately; Plausible shows a new key only once.' },
      { title: 'Find the site ID', detail: 'Use the exact domain configured in Plausible, normally example.com.' },
      { title: 'Set the base URL', detail: 'Use https://plausible.io for hosted Plausible or the root URL of your self-hosted instance.' },
      { title: 'Save and sync', detail: 'The app imports aggregate outcomes and top landing-page activity for the last 30 days.' },
    ],
    values: [
      { field: 'Base URL', source: 'Hosted: https://plausible.io. Self-hosted: the root URL users sign in to.' },
      { field: 'Plausible site ID', source: 'The exact domain shown in the Plausible site switcher/settings.' },
      { field: 'Stats API token', source: 'Account settings → API Keys.' },
    ],
    troubleshooting: [
      '401 means the key is invalid or is not a Stats API key.',
      '404 commonly means the base URL is wrong or the key cannot access the supplied site ID.',
      'Plausible applies API rate limits; lengthen the refresh cadence if you connect many sites to one key.',
    ],
    docs: [{ label: 'Plausible Stats API', href: 'https://plausible.io/docs/stats-api' }],
  },
  matomo: {
    access: 'View permission + auth token',
    accessDetail: 'The app calls VisitsSummary.get through the Reporting API and does not need administration access.',
    permissions: [
      { label: 'Matomo site role', value: 'View' },
      { label: 'Token type', value: 'POST-only auth token' },
      { label: 'Write access', value: 'None' },
    ],
    requirements: [
      'A Matomo user with View permission for the selected site.',
      'HTTPS on the Matomo base URL.',
    ],
    steps: [
      { title: 'Create a dedicated user', detail: 'Give it View permission only for the site being connected.' },
      { title: 'Generate an auth token', detail: 'Matomo → Administration → Personal → Security → Auth tokens.' },
      { title: 'Prefer POST-only', detail: 'Create a token that may only be sent in POST bodies so it cannot leak through URLs or proxy logs.' },
      { title: 'Find the site ID', detail: 'Open Administration → Websites → Manage and copy the numeric IDSite value.' },
      { title: 'Connect and sync', detail: 'The app imports visits, users, actions, bounce rate, duration and conversions for a 30-day range.' },
    ],
    values: [
      { field: 'Matomo URL', source: 'The root of the Matomo installation, not index.php or an API URL.' },
      { field: 'Site ID', source: 'Administration → Websites → Manage → ID.' },
      { field: 'Auth token', source: 'Administration → Personal → Security → Auth tokens.' },
    ],
    troubleshooting: [
      'Treat token_auth like a password; rotate it if it appears in a URL or log.',
      'A user with no View access to IDSite will receive an authorization error even when the token is valid.',
      'Self-hosted security middleware must allow POST requests to /index.php.',
    ],
    docs: [{ label: 'Matomo Reporting API', href: 'https://developer.matomo.org/guides/reporting-api' }],
  },
  wordpress: {
    access: 'Application password for a least-privilege user',
    accessDetail: 'WordPress application passwords inherit the user’s capabilities; they do not have separate API scopes.',
    permissions: [
      { label: 'Practical default', value: 'Editor' },
      { label: 'Minimum capability', value: 'Edit and publish target post type' },
      { label: 'WordPress version', value: '5.6 or newer' },
    ],
    requirements: [
      'WordPress REST API available over HTTPS.',
      'A dedicated user that may read, edit and publish the content this workflow controls.',
    ],
    steps: [
      { title: 'Create a dedicated WordPress user', detail: 'Editor is the practical default for updating existing team content. Prefer a narrower custom role when your site supports one.' },
      { title: 'Create an application password', detail: 'Users → Profile (or Edit User) → Application Passwords → name it SEO Indexer → Add New.' },
      { title: 'Copy the generated password', detail: 'WordPress only shows it once. Spaces in the displayed password are accepted.' },
      { title: 'Check the REST API', detail: 'Confirm https://example.com/wp-json/wp/v2/ loads and is not blocked by a security plugin.' },
      { title: 'Connect', detail: 'Enter the site root URL, the dedicated username and application password.' },
    ],
    values: [
      { field: 'WordPress URL', source: 'The public site root, for example https://example.com.' },
      { field: 'Username', source: 'The login name of the dedicated WordPress user, not necessarily its email.' },
      { field: 'Application password', source: 'Users → Profile → Application Passwords.' },
    ],
    troubleshooting: [
      '401 or 403 often means a security plugin blocks Basic authentication or application passwords.',
      'An Author can publish their own posts but cannot normally update content owned by other users; use capabilities that match the intended workflow.',
      'Use HTTPS. WordPress application-password authentication is not intended for an unencrypted connection.',
    ],
    docs: [
      { label: 'REST API authentication', href: 'https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/' },
      { label: 'Application passwords API', href: 'https://developer.wordpress.org/rest-api/reference/application-passwords/' },
    ],
  },
  shopify: {
    access: 'read_content + write_content',
    accessDetail: 'These Admin API scopes let the governed publishing flow read, stage, publish and roll back blog articles.',
    permissions: [
      { label: 'Recommended scopes', value: 'read_content, write_content' },
      { label: 'Alternative scope family', value: 'read/write_online_store_pages' },
      { label: 'API', value: 'GraphQL Admin API' },
    ],
    requirements: [
      'A Shopify custom app installed on the target store.',
      'Permission in Shopify admin to develop apps and configure Admin API scopes.',
      'The app currently updates an existing Article GID; it does not create products or orders.',
    ],
    steps: [
      { title: 'Create or open a custom app', detail: 'Shopify admin → Settings → Apps and sales channels → Develop apps.' },
      { title: 'Configure Admin API scopes', detail: 'Grant read_content and write_content. Do not add customer, order or product scopes for this connection.' },
      { title: 'Install or reinstall the app', detail: 'Shopify only applies changed scopes after the app is installed or updated.' },
      { title: 'Copy the Admin API token', detail: 'Open API credentials and reveal the token. It is shown once.' },
      { title: 'Connect', detail: 'Use the permanent *.myshopify.com domain and a supported Admin API version.' },
    ],
    values: [
      { field: 'Shop domain', source: 'Shopify admin → Settings → Domains. Use store.myshopify.com, without https://.' },
      { field: 'Admin API access token', source: 'Custom app → API credentials → Admin API access token.' },
      { field: 'API version', source: 'Use a currently supported Shopify Admin API version, for example 2026-07.' },
    ],
    troubleshooting: [
      'ACCESS_DENIED means the installed token does not have the required content scopes; changing the app configuration alone is not enough—reinstall/update it.',
      'Use the myshopify.com domain even when the storefront has a custom domain.',
      'Governed actions need the full article GID, for example gid://shopify/Article/123.',
    ],
    docs: [
      { label: 'Shopify API authentication', href: 'https://shopify.dev/docs/api/usage/authentication' },
      { label: 'Article read scope', href: 'https://shopify.dev/docs/api/admin-graphql/latest/objects/Article' },
      { label: 'Article update scope', href: 'https://shopify.dev/docs/api/admin-graphql/latest/mutations/articleUpdate' },
    ],
  },
  webflow: {
    access: 'sites:read + cms:read + cms:write',
    accessDetail: 'The app lists sites and reads, stages, publishes and rolls back CMS items.',
    permissions: [
      { label: 'Site discovery', value: 'sites:read' },
      { label: 'CMS reads', value: 'cms:read' },
      { label: 'CMS changes', value: 'cms:write' },
    ],
    requirements: [
      'A Webflow site with CMS access.',
      'A Site Token for a controlled site, or an OAuth token with the same scopes for multi-site use.',
    ],
    steps: [
      { title: 'Create a token', detail: 'For one controlled site, open Site settings → Apps & Integrations → API access and create a Site Token.' },
      { title: 'Select scopes', detail: 'Grant sites:read, cms:read and cms:write only.' },
      { title: 'Copy the token', detail: 'Store it immediately and treat it as a password.' },
      { title: 'Find the collection ID', detail: 'Open the CMS collection in Webflow; copy its ID through the API or the collection settings/URL.' },
      { title: 'Connect and verify', detail: 'Save the token and optional default collection. Publishing still goes through this app’s approval workflow.' },
    ],
    values: [
      { field: 'Data API token', source: 'Webflow Site settings → Apps & Integrations → API access.' },
      { field: 'Default collection ID', source: 'The Webflow CMS collection that should receive approved content actions.' },
    ],
    troubleshooting: [
      'A token with cms:write but no sites:read fails the initial connection test.',
      'A collection from another site is not accessible to a site-scoped token.',
      'CMS publishing availability also depends on the Webflow site plan and collection permissions.',
    ],
    docs: [
      { label: 'Webflow API scopes', href: 'https://developers.webflow.com/data/reference/scopes' },
      { label: 'Webflow authentication', href: 'https://developers.webflow.com/data/reference/authentication' },
      { label: 'CMS API prerequisites', href: 'https://developers.webflow.com/data/v1.0.0/docs/cms-tutorial' },
    ],
  },
  log_ingest: {
    access: 'logs:write',
    accessDetail: 'Use an app-generated service token scoped to one workspace. No third-party credential is required.',
    permissions: [
      { label: 'Service-token scope', value: 'logs:write' },
      { label: 'Tenant scope', value: 'Current workspace only' },
      { label: 'Maximum batch', value: '1,000 events' },
    ],
    requirements: ['A service token created under Governance & Usage → API & Webhooks.', 'A log shipper that can send JSON over HTTPS.'],
    steps: [
      { title: 'Create the connection', detail: 'Save this source to register it in the integration catalog.' },
      { title: 'Create a service token', detail: 'Governance & Usage → API & Webhooks → Create token → select logs:write only.' },
      { title: 'Copy it once', detail: 'The bearer token is displayed only at creation time; store it in your shipper’s secret manager.' },
      { title: 'Send batches', detail: 'POST up to 1,000 request events to /api/v1/logs/ingest with Authorization: Bearer oc_…' },
      { title: 'Monitor ingestion', detail: 'Use the connection and workspace evidence views to confirm fresh log observations.' },
    ],
    values: [{ field: 'Endpoint and token', source: 'Governance & Usage → API & Webhooks. See the Automation API reference for the JSON schema.' }],
    troubleshooting: ['401 means the token is missing, expired or revoked.', '403 means the token does not include logs:write or belongs to another workspace.', '413/400 errors usually mean the batch is too large or does not match the event schema.'],
    docs: [{ label: 'Automation API reference', href: 'https://github.com/martadams89/seo-website-indexer/blob/main/docs/AUTOMATION_API.md#ingesting-request-logs' }],
  },
  rank_feed: {
    access: 'events:write',
    accessDetail: 'Normalize rank observations from any provider through the workspace events API.',
    permissions: [
      { label: 'Service-token scope', value: 'events:write' },
      { label: 'Event source', value: 'rank_feed' },
      { label: 'Tenant scope', value: 'Current workspace only' },
    ],
    requirements: ['A service token created under Governance & Usage → API & Webhooks.', 'An exporter from Semrush, Ahrefs, DataForSEO or a custom rank tracker.'],
    steps: [
      { title: 'Create the connection', detail: 'Save this source so rank evidence is visible in the catalog.' },
      { title: 'Create a service token', detail: 'Governance & Usage → API & Webhooks → Create token → select events:write only.' },
      { title: 'Map the provider data', detail: 'Send numeric position/visibility observations with source set to rank_feed, plus site, date and keyword dimensions.' },
      { title: 'POST the event', detail: 'Send JSON to /api/v1/events with Authorization: Bearer oc_…' },
      { title: 'Check provenance', detail: 'Verify the imported observation retains its date, keyword/market dimension and upstream provider metadata.' },
    ],
    values: [{ field: 'Endpoint and token', source: 'Governance & Usage → API & Webhooks. The upstream provider’s own API key stays in your exporter.' }],
    troubleshooting: ['403 means events:write is absent or the token belongs to a different workspace.', 'Use numbers for metric values; keep keyword, market, device and provider in dimensions/metadata.', 'Do not reuse a logs:write token—each automation should have only the scope it needs.'],
    docs: [{ label: 'Automation API reference', href: 'https://github.com/martadams89/seo-website-indexer/blob/main/docs/AUTOMATION_API.md#adding-a-custom-observation' }],
  },
};
