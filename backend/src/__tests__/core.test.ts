import { describe, it, expect } from 'vitest';
import { filterChangedEntries, type SitemapEntry } from '../indexer/sitemap.js';
import { lintLlmsTxt } from '../indexer/llms-audit.js';

// These gate Renovate auto-merges: they cover the pure decision logic that a
// bad dependency bump would break loudly (parsing, diffing, linting).

describe('filterChangedEntries', () => {
  const e = (url: string, lastmod?: string): SitemapEntry => ({ url, lastmod: lastmod ?? null } as SitemapEntry);

  it('classifies new, changed and unchanged URLs', () => {
    const known = new Map<string, string | null>([
      ['https://a.com/1', '2026-01-01'],
      ['https://a.com/2', '2026-01-01'],
    ]);
    const { changed, unchanged, newUrls } = filterChangedEntries(
      [e('https://a.com/1', '2026-01-01'), e('https://a.com/2', '2026-06-30'), e('https://a.com/3', '2026-07-01')],
      known
    );
    expect(unchanged.map(x => x.url)).toEqual(['https://a.com/1']);
    expect(changed.map(x => x.url)).toEqual(['https://a.com/2']);
    expect(newUrls.map(x => x.url)).toEqual(['https://a.com/3']);
  });

  it('treats known URLs without lastmod as changed (rotation handles them)', () => {
    const known = new Map<string, string | null>([['https://a.com/1', '2026-01-01']]);
    const { changed } = filterChangedEntries([e('https://a.com/1')], known);
    expect(changed).toHaveLength(1);
  });

  it('handles empty inputs', () => {
    const r = filterChangedEntries([], new Map());
    expect(r.changed).toEqual([]);
    expect(r.unchanged).toEqual([]);
    expect(r.newUrls).toEqual([]);
  });
});

describe('lintLlmsTxt', () => {
  it('flags an empty file', () => {
    const r = lintLlmsTxt('');
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/empty/i);
  });

  it('requires a top-level title heading', () => {
    const r = lintLlmsTxt('Some text\n[link](https://a.com)\n');
    expect(r.issues.join(' ')).toMatch(/# Title/);
  });

  it('flags a file with no links', () => {
    const r = lintLlmsTxt('# My Site\nJust prose, no pointers.\n');
    expect(r.issues.join(' ')).toMatch(/no markdown links/i);
  });

  it('flags unresolvable link targets and placeholder text', () => {
    const r = lintLlmsTxt('# My Site\n[bad](ftp:whatever)\nTODO: write this\n');
    expect(r.issues.some(i => /unresolvable/i.test(i))).toBe(true);
    expect(r.issues.some(i => /placeholder/i.test(i))).toBe(true);
  });

  it('passes a well-formed file and reports stats', () => {
    const text = '# My Site\n\n## Docs\n- [Guide](https://a.com/guide)\n- [Pricing](/pricing)\n';
    const r = lintLlmsTxt(text);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.stats.links).toBe(2);
    expect(r.stats.sections).toBe(2);
  });

  it('flags very large files', () => {
    const r = lintLlmsTxt('# T\n[a](https://a.com)\n' + 'x'.repeat(120_000));
    expect(r.issues.some(i => /large/i.test(i))).toBe(true);
  });
});
