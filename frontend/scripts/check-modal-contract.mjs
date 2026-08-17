import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = (path) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const modal = source('src/components/Modal.tsx');
const css = source('src/index.css');
const modalSurfaces = [
  'src/components/SearchPerformance.tsx',
  'src/pages/ActionCenter.tsx',
  'src/pages/Citations.tsx',
  'src/pages/Governance.tsx',
  'src/pages/Integrations.tsx',
  'src/pages/Intelligence.tsx',
  'src/pages/Publishing.tsx',
  'src/pages/Reports.tsx',
  'src/pages/Sites.tsx',
];

assert.match(modal, /createPortal\(/, 'Dialogs must render in a portal outside page stacking contexts');
assert.match(modal, /aria-modal="true"/, 'Dialogs must expose the modal accessibility contract');
assert.match(modal, /aria-labelledby=/, 'Dialogs must have an accessible title');
assert.match(modal, /event\.key === 'Escape'/, 'Dialogs must support Escape dismissal');
assert.match(modal, /event\.key !== 'Tab'/, 'Dialogs must keep keyboard focus inside the active surface');
assert.match(modal, /document\.body\.style\.overflow = 'hidden'/, 'Dialogs must lock page scrolling while open');
assert.match(modal, /previousFocus\?\.focus\(\)/, 'Dialogs must return focus to their trigger when closed');
assert.match(modal, /event\.target === event\.currentTarget/, 'Only direct backdrop clicks may dismiss a dialog');

for (const path of modalSurfaces) {
  const contents = source(path);
  assert.match(contents, /import \{ Modal \}/, `${path} must use the shared Modal component`);
  assert.match(contents, /<Modal\b/, `${path} must render the shared Modal component`);
  assert.doesNotMatch(contents, /ops-modal|modal-backdrop|className="modal"/, `${path} still contains legacy modal markup`);
}

for (const size of ['sm', 'lg', 'xl']) {
  assert.match(css, new RegExp(`\\.app-modal-${size}\\b`), `Shared dialog CSS is missing the ${size} size preset`);
}
assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.app-modal-backdrop/, 'Dialogs need a compact mobile layout');
assert.match(css, /\.app-modal-body[^}]*overflow-y:\s*auto/, 'Only the dialog body should scroll');
assert.match(css, /\.app-modal-footer/, 'Dialogs need a stable action footer');

console.log(`Modal contract passed: ${modalSurfaces.length} feature surfaces use the accessible shared dialog system.`);
