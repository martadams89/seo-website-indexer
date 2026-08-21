import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = path => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const guides = source('src/integrations/setupGuides.ts');
const page = source('src/pages/Integrations.tsx');
const css = source('src/index.css');
const backend = source('../backend/src/platform/connectors.ts');
const docs = source('../docs/INTEGRATIONS.md');

const providers = ['ga4', 'pagespeed', 'cloudflare', 'plausible', 'matomo', 'wordpress', 'shopify', 'webflow', 'log_ingest', 'rank_feed'];
for (const provider of providers) {
  assert.match(guides, new RegExp(`\\n  ${provider}: \\{`), `Missing structured setup guide for ${provider}`);
}

const permissionContracts = [
  { guide: 'https://www.googleapis.com/auth/analytics.readonly', docs: 'https://www.googleapis.com/auth/analytics.readonly' },
  { guide: 'Viewer or higher', docs: 'Viewer or higher' },
  { guide: 'Account Analytics: Read', docs: 'Account Analytics: Read' },
  { guide: 'read_content, write_content', docs: 'read_content' },
  { guide: 'sites:read + cms:read + cms:write', docs: 'sites:read' },
  { guide: "value: 'logs:write'", docs: 'logs:write' },
  { guide: "value: 'events:write'", docs: 'events:write' },
];
for (const contract of permissionContracts) {
  assert.ok(guides.includes(contract.guide), `Integration guides are missing the permission contract: ${contract.guide}`);
  assert.ok(docs.includes(contract.docs), `Documentation is missing the permission contract: ${contract.docs}`);
}

for (const section of ['Google Analytics 4: the short answer', 'Analytics and performance', 'Publishing', 'Search submissions', 'AI visibility providers', 'Notifications', 'Internal APIs and automation']) {
  assert.ok(docs.includes(`## ${section}`), `Integration reference is missing the ${section} section`);
}

assert.match(page, /INTEGRATION_SETUP_GUIDES/, 'The integration page must use the structured guide catalog');
assert.match(page, /Setup guide\s*<\//, 'Every connection modal must expose its setup guide');
assert.match(page, /Permission reference/, 'The integration page must link the complete reference');
assert.match(page, /integration-guide-modal/, 'Setup guidance must use the shared accessible modal');

assert.match(css, /\.integration-guide-layout/, 'Integration guide layout styles are missing');
assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.integration-guide-layout/, 'Integration guides need a mobile layout');
assert.match(css, /\.integration-permission-hero[^}]*var\(--bg-card\)/, 'Guide surfaces must use theme tokens for light and dark mode');

const pageSpeedBlock = backend.match(/async function syncPageSpeed[\s\S]*?async function cloudflareQuery/)?.[0] ?? '';
assert.ok(pageSpeedBlock, 'Could not find the PageSpeed connector');
assert.doesNotMatch(pageSpeedBlock, /crux_api_key/, 'PageSpeed must not reuse a key restricted to the separate CrUX API');

console.log(`Integration guide contract passed: ${providers.length} catalog providers plus platform, AI, notification and automation references.`);
