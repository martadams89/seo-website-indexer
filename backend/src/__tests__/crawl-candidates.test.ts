import { compareCrawlImports } from '../platform/crawl-comparison.js';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { getDb, getSiteById, upsertSite } from '../db/database.js';
import { createUser } from '../auth/users.js';
import { bootstrapUserWorkspace } from '../auth/workspaces.js';
import {
  parseCrawlCandidates,
  importCrawlCandidates,
  listCrawlCandidates,
  reviewCrawlCandidate,
  saveCandidateNotes,
  crawlImportHistory,
} from '../platform/crawl-candidates.js';
import { listBacklinks } from '../platform/backlinks.js';
vi.hoisted(() => {
  process.env.DATA_DIR = process.getBuiltinModule('node:fs').mkdtempSync('/tmp/crawl-candidates-');
  process.env.APP_SECRET = 'crawl-test-secret';
});
let ws: string;
let other: string;
const site = () => getSiteById('crawl-site')!;
const record = (extra = {}) =>
  JSON.stringify({
    source_url: 'https://publisher.example/story',
    target_url: 'https://example.com/',
    anchor: 'Historical anchor',
    crawl_date: '2020-01-01',
    ...extra,
  });
const wat = (links: unknown[], header = {}) =>
  JSON.stringify({
    Envelope: {
      'WARC-Header-Metadata': {
        'WARC-Type': 'response',
        'WARC-Target-URI': 'https://publisher.example/story',
        'WARC-Date': '2020-01-01T00:00:00Z',
        ...header,
      },
      'Payload-Metadata': { 'HTTP-Response-Metadata': { 'HTML-Metadata': { Links: links } } },
    },
  });
const add = () => {
  importCrawlCandidates(ws, site(), record(), 'Selected crawl', false);
  return listCrawlCandidates(ws, site().id)[0];
};
beforeAll(() => {
  ws = bootstrapUserWorkspace(createUser({ email: 'crawl@example.com', password: 'testing12345' }), false).id;
  other = bootstrapUserWorkspace(
    createUser({ email: 'other-crawl@example.com', password: 'testing12345' }),
    false,
  ).id;
  upsertSite({
    id: 'crawl-site',
    workspace_id: ws,
    domain: 'example.com',
    name: 'Crawl',
    sitemap_url: 'https://example.com/sitemap.xml',
    gsc_url: 'sc-domain:example.com',
    enabled: 0,
  });
});
beforeEach(() => {
  for (const table of ['crawl_candidates', 'crawl_imports', 'backlinks', 'work_items'])
    getDb().prepare(`DELETE FROM ${table}`).run();
});
it('extracts only external HTML anchor links to the site and its subdomains', () => {
  const parsed = parseCrawlCandidates(
    wat([
      { path: 'A@/href', url: 'https://example.com/', text: 'Guide' },
      { path: 'A@/href', url: 'https://docs.example.com/start' },
      { path: 'IMG@/src', url: 'https://example.com/logo.png' },
      { path: 'A@/href', url: 'https://example.com.attacker.example/' },
      { path: 'A@/href', url: '/internal' },
    ]),
    site(),
  );
  expect(parsed.candidates).toHaveLength(2);
  expect(parsed.skipped).toBe(3);
  expect(parsed.candidates[0]).toMatchObject({ anchor: 'Guide', crawl_date: '2020-01-01T00:00:00.000Z' });
});
it('skips internal sources and non-response WAT records', () => {
  expect(
    parseCrawlCandidates(record({ source_url: 'https://docs.example.com/' }), site()).candidates,
  ).toEqual([]);
  expect(parseCrawlCandidates(wat([], { 'WARC-Type': 'request' }), site()).skipped).toBe(1);
});
it('rejects private and credential-bearing sources and preserves physical error line numbers', () => {
  const result = parseCrawlCandidates(
    '\n' +
      record({ source_url: 'http://127.0.0.1/private' }) +
      '\n\n' +
      record({ source_url: 'https://user:secret@publisher.example/' }) +
      '\n{',
    site(),
  );
  expect(result.candidates).toHaveLength(0);
  expect(result.rejected.map((r) => r.line)).toEqual([2, 4, 5]);
  expect(JSON.stringify(result.rejected)).not.toContain('secret');
});
it('accepts unknown dates but rejects impossible and future dates', () => {
  expect(parseCrawlCandidates(record({ crawl_date: null }), site()).candidates[0].crawl_date).toBeNull();
  for (const crawl_date of ['2020-02-31', '2999-01-01', 'yesterday'])
    expect(parseCrawlCandidates(record({ crawl_date }), site()).rejected).toHaveLength(1);
});
it('enforces UTF-8 and record budgets', () => {
  expect(() => parseCrawlCandidates('é'.repeat(250001), site())).toThrow('500 KB');
  expect(() => parseCrawlCandidates(Array(501).fill('{}').join('\n'), site())).toThrow('500 JSON');
});
it('rejects excessive matching links without a partial import', () => {
  expect(() =>
    importCrawlCandidates(
      ws,
      site(),
      wat(Array.from({ length: 501 }, (_, i) => ({ path: 'A@/href', url: `https://example.com/${i}` }))),
      'oversized',
      false,
    ),
  ).toThrow('Candidate budget');
  expect(listCrawlCandidates(ws, site().id)).toEqual([]);
  expect(crawlImportHistory(ws, site().id)).toEqual([]);
});
it('enforces the examined-link budget even when no links match', () => {
  expect(() => parseCrawlCandidates(wat(Array(20001).fill({})), site())).toThrow('Link budget');
});
it('previews deduplication with complete rollback and no receipt', () => {
  expect(importCrawlCandidates(ws, site(), record() + '\n' + record(), 'Preview', true)).toMatchObject({
    added: 1,
    duplicates: 1,
    preview: true,
  });
  expect(listCrawlCandidates(ws, site().id)).toEqual([]);
  expect(crawlImportHistory(ws, site().id)).toEqual([]);
});
it('keeps original provenance on duplicate imports and retains only thirty receipts', () => {
  add();
  for (let i = 0; i < 32; i++)
    expect(importCrawlCandidates(ws, site(), record(), 'Later crawl', false).duplicates).toBe(1);
  expect(listCrawlCandidates(ws, site().id)[0].provenance).toBe('Selected crawl');
  expect(crawlImportHistory(ws, site().id)).toHaveLength(30);
});
it('isolates imports, reviews, notes and history by workspace', () => {
  const row = add();
  expect(() => importCrawlCandidates(other, site(), record(), 'Foreign', false)).toThrow('Site not found');
  expect(listCrawlCandidates(other, site().id)).toEqual([]);
  expect(crawlImportHistory(other, site().id)).toEqual([]);
  expect(() => reviewCrawlCandidate(other, site(), row.id, 'promote')).toThrow('Candidate not found');
  expect(() => saveCandidateNotes(other, row.id, 'foreign')).toThrow('Candidate not found');
});
it('requires restoration before promotion and never resets existing live evidence', () => {
  const row = add();
  reviewCrawlCandidate(ws, site(), row.id, 'dismissed');
  expect(() => reviewCrawlCandidate(ws, site(), row.id, 'promote')).toThrow('Restore');
  reviewCrawlCandidate(ws, site(), row.id, 'pending');
  reviewCrawlCandidate(ws, site(), row.id, 'promote');
  expect(listBacklinks(ws, site().id)[0].status).toBe('unverified');
  getDb().prepare("UPDATE backlinks SET status='present',checked_at='2020-01-01'").run();
  reviewCrawlCandidate(ws, site(), row.id, 'promote');
  expect(listBacklinks(ws, site().id)).toHaveLength(1);
  expect(listBacklinks(ws, site().id)[0]).toMatchObject({ status: 'present', checked_at: '2020-01-01' });
  expect(() => reviewCrawlCandidate(ws, site(), row.id, 'dismissed')).toThrow('backlink monitor');
});
it('validates notes and attaches them to a deduplicated investigation task', () => {
  const row = add();
  expect(() => saveCandidateNotes(ws, row.id, 'a'.repeat(4001))).toThrow('4,000');
  saveCandidateNotes(ws, row.id, 'Check editorial relevance');
  reviewCrawlCandidate(ws, site(), row.id, 'work');
  reviewCrawlCandidate(ws, site(), row.id, 'work');
  const tasks = getDb()
    .prepare("SELECT evidence FROM work_items WHERE source='crawl_candidate'")
    .all() as Array<{ evidence: string }>;
  expect(tasks).toHaveLength(1);
  expect(JSON.parse(tasks[0].evidence)).toMatchObject({
    notes: 'Check editorial relevance',
    crawl_date: '2020-01-01T00:00:00.000Z',
  });
});

it('compares releases while preserving duplicate observations and live monitor evidence', () => {
  const candidate = add();
  const before = crawlImportHistory(ws, site().id)[0].id;
  reviewCrawlCandidate(ws, site(), candidate.id, 'promote');
  getDb().prepare("UPDATE backlinks SET status='present'").run();
  importCrawlCandidates(
    ws,
    site(),
    [
      record({ anchor: 'Updated anchor', crawl_date: '2021-01-01' }),
      record({ source_url: 'https://second.example/story' }),
    ].join('\n'),
    'Second release',
    false,
  );
  const after = crawlImportHistory(ws, site().id)[0].id;
  const result = compareCrawlImports(ws, site().id, before, after);
  expect(result.counts).toEqual({
    newly_observed: 1,
    not_observed: 0,
    observed_both: 1,
    evidence_changed: 1,
  });
  expect(result.rows.find((r) => r.status === 'observed_both')).toMatchObject({
    before: [{ anchor: 'Historical anchor', crawl_date: '2020-01-01T00:00:00.000Z' }],
    after: [{ anchor: 'Updated anchor', crawl_date: '2021-01-01T00:00:00.000Z' }],
  });
  expect(listBacklinks(ws, site().id)[0].status).toBe('present');
  expect(listCrawlCandidates(ws, site().id).find((r) => r.id === candidate.id)?.anchor).toBe(
    'Historical anchor',
  );
});
it('reports sample absence without claiming a lost link, including empty and rejected extracts', () => {
  add();
  const before = crawlImportHistory(ws, site().id)[0].id;
  importCrawlCandidates(ws, site(), 'not JSON', 'Incomplete extract', false);
  const result = compareCrawlImports(ws, site().id, before, crawlImportHistory(ws, site().id)[0].id);
  expect(result.counts.not_observed).toBe(1);
  expect(result.after.rejected_records).toBe(1);
  expect(result.methodology).toContain('does not mean a live backlink was lost');
  expect(listCrawlCandidates(ws, site().id)[0].state).toBe('pending');
});
it('leaves comparison snapshots untouched on preview and prunes them with import receipts', () => {
  add();
  importCrawlCandidates(ws, site(), record(), 'Preview', true);
  expect(getDb().prepare('SELECT * FROM crawl_import_observations').all()).toHaveLength(1);
  for (let i = 0; i < 31; i++) importCrawlCandidates(ws, site(), record(), `Release ${i}`, false);
  expect(getDb().prepare('SELECT * FROM crawl_import_observations').all()).toHaveLength(30);
});
it('rejects foreign, same and legacy comparisons without manufacturing history', () => {
  add();
  const id = crawlImportHistory(ws, site().id)[0].id;
  expect(() => compareCrawlImports(other, site().id, id, 'other')).toThrow('Import not found');
  expect(() => compareCrawlImports(ws, 'foreign-site', id, 'other')).toThrow('Import not found');
  expect(() => compareCrawlImports(ws, site().id, id, id)).toThrow('different imports');
  getDb().prepare('DELETE FROM crawl_import_observations WHERE import_id=?').run(id);
  expect(crawlImportHistory(ws, site().id)[0].comparable).toBe(0);
  expect(() => compareCrawlImports(ws, site().id, id, 'other')).toThrow('older import');
});
it('compares evidence sets independently of record order while preserving each observation', () => {
  importCrawlCandidates(
    ws,
    site(),
    [record(), record({ anchor: 'Alternative', crawl_date: null })].join('\n'),
    'A',
    false,
  );
  const before = crawlImportHistory(ws, site().id)[0].id;
  importCrawlCandidates(
    ws,
    site(),
    [record({ anchor: 'Alternative', crawl_date: null }), record(), record()].join('\n'),
    'B',
    false,
  );
  const result = compareCrawlImports(ws, site().id, before, crawlImportHistory(ws, site().id)[0].id);
  expect(result.counts.evidence_changed).toBe(0);
  expect(result.rows[0].after).toHaveLength(3);
});

it('bounds expanded WAT snapshots before persisting any observations', () => {
  const text=wat(Array.from({length:500},(_,i)=>({path:'A@/href',url:`https://example.com/${i}`})),{'WARC-Target-URI':`https://publisher.example/${'a'.repeat(3000)}`});
  expect(()=>importCrawlCandidates(ws,site(),text,'Large snapshot',false)).toThrow('snapshot budget');
  expect(crawlImportHistory(ws,site().id)).toEqual([]);
  expect(listCrawlCandidates(ws,site().id)).toEqual([]);
});
