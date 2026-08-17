import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['src/index.css', ...globSync('src/**/*.tsx', { cwd: root })];
const violations = [];

for (const path of files) {
  const contents = readFileSync(`${root}${path}`, 'utf8');
  const patterns = path.endsWith('.css')
    ? [/\bfont-size\s*:\s*([0-9]+(?:\.[0-9]+)?)px/g, /\bfont\s*:\s*[^;{}]*?\b([0-9]+(?:\.[0-9]+)?)px\b/g]
    : [/\bfontSize\s*(?::|=)\s*(?:\{\s*)?([0-9]+(?:\.[0-9]+)?)/g];
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      const size = Number(match[1]);
      if (size >= 12) continue;
      const line = contents.slice(0, match.index).split('\n').length;
      violations.push(`${path}:${line} uses ${size}px`);
    }
  }
}

assert.deepEqual(violations, [], `Text smaller than the 12px readability floor:\n${violations.join('\n')}`);
console.log(`Typography contract passed: ${files.length} style surfaces keep user-facing text at 12px or larger.`);
