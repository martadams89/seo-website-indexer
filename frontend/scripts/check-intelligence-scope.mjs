import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const intelligence = source('src/pages/Intelligence.tsx');
const api = source('src/api.ts');
const css = source('src/index.css');

assert.match(intelligence, /Filter by website/, 'Unified Intelligence must expose a labelled website filter');
assert.match(intelligence, /Workspace-wide \/ unassigned/, 'The website filter must distinguish unassigned workspace evidence');
assert.match(intelligence, /metric\.site_id \?\? 'workspace'/, 'Metric identity must include site_id so tenant readings cannot collapse together');
assert.match(intelligence, /api\.getPlatformOverview\(scope\)/, 'Overview data must be fetched for the selected website scope');
assert.match(intelligence, /api\.getMetrics\(\{ \.\.\.scope/, 'Metric observations must be fetched for the selected website scope');
assert.match(intelligence, /siteScope.*Save view|config: \{ source, siteScope/s, 'Saved intelligence views must retain website scope');
assert.match(intelligence, /Its mini-chart never mixes observations from different sites/, 'The UI must explain site isolation to the user');
assert.match(api, /workspace_only\?: boolean/, 'The API client must support workspace-only evidence queries');
assert.match(css, /\.intelligence-scope-panel/, 'Website scope needs a first-class responsive visual treatment');

console.log('Unified Intelligence scope contract passed: site filtering, attribution, saved views, and responsive UI are present.');
