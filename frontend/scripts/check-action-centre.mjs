import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const actionCentre = source('../src/pages/ActionCenter.tsx');
const api = source('../src/api.ts');
const css = source('../src/index.css');
const routes = source('../../backend/src/platform/routes.ts');
const store = source('../../backend/src/platform/store.ts');

assert.match(actionCentre, /Filter by website/, 'Actions must be filterable by website');
assert.match(actionCentre, /item\.site_name.*item\.page_url/s, 'Every action row must render website and page context');
assert.match(actionCentre, /Copy brief/, 'Actions must provide an LLM-ready copy control');
assert.match(actionCentre, /Affected page.*detailPages\.length > 1/s, 'Multi-page findings must provide a page selector');
assert.match(actionCentre, /Record fix deployed/, 'The repair flow must distinguish deployment from resolution');
assert.match(actionCentre, /Re-submit &amp; check Google/, 'The supported Search Console verification action must remain visible');
assert.match(actionCentre, /Google does not expose a general “mark fixed” or reindex API/, 'The UI must not promise an unsupported Google reindex action');
assert.match(actionCentre, /Workspace members can use the account already linked to the website/, 'Shared website Google accounts must be explained');
assert.match(api, /remediateWorkItem/, 'The API client must expose the remediation workflow');
assert.match(api, /coverageState.*robotsTxtState.*googleCanonical/s, 'Google proof must retain actionable inspection evidence');
assert.match(store, /s\.name site_name,s\.domain site_domain/, 'Work items must be hydrated with tenant-scoped site context');
assert.match(store, /workItemPageUrls/, 'Legacy evidence URLs must be normalized into page context');
assert.match(routes, /pageBelongsToSite/, 'Google checks must reject URLs outside the action website');
assert.match(routes, /submitSitemapToGSC.*inspectGoogleUrl/s, 'Google verification must re-submit the sitemap and inspect the exact URL');
assert.match(routes, /assertWithinBudget.*getQuotaUsage/s, 'Manual Google checks must respect workspace budgets and property quota');
assert.match(css, /\.remediation-layout/, 'The page repair modal needs a first-class visual layout');
assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.remediation-identity/, 'The repair modal must adapt at mobile widths');
assert.doesNotMatch(css.match(/\/\* Page-level Action Centre remediation \*\/[\s\S]*?\/\* Accessibility contract/)?.[0] || '', /#[0-9a-f]{3,8}\b/i,
  'Action Centre colours must use theme tokens so dark and light modes stay compatible');

console.log('Action Centre contract passed: site/page context, copyable briefs, guarded Google verification and responsive themed UI are present.');

