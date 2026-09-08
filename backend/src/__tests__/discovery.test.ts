import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parsePage, pageFindings, inventoryFindings } from '../platform/page-evidence.js';
import { analyzeListing, validateListing, saveAppListing, listAppListings, listingHistory } from '../platform/aso.js';
import { compareAudits, saveAudit, auditHistory, type AuditReport } from '../platform/discovery-store.js';
import { parseCsv, importBacklinks, listBacklinks } from '../platform/backlinks.js';
vi.hoisted(() => { process.env.DATA_DIR = process.getBuiltinModule('node:fs').mkdtempSync('/tmp/discovery-test-'); process.env.APP_SECRET = 'discovery-test-only'; });
let ws: string; let other: string; const siteId = 'discovery-site';
beforeAll(async () => {
  const { createUser } = await import('../auth/users.js'); const { bootstrapUserWorkspace } = await import('../auth/workspaces.js'); const { upsertSite } = await import('../db/database.js');
  ws = bootstrapUserWorkspace(createUser({ email: 'discovery@example.com', password: 'testing12345' }), false).id;
  other = bootstrapUserWorkspace(createUser({ email: 'other@example.com', password: 'testing12345' }), false).id;
  upsertSite({ id: siteId, name: 'Example', domain: 'example.com', sitemap_url: 'https://example.com/sitemap.xml', gsc_url: 'sc-domain:example.com', workspace_id: ws, enabled: 0 });
});
const page = (html: string, status = 200) => parsePage({ url: 'https://example.com/', status, html });
const draft = () => validateListing({ platform: 'apple', locale: 'en-GB', name: 'Useful App', subtitle: 'Useful evidence', description: 'Capture evidence.', keywords: 'evidence,report', promotional_text: '', target_terms: ['evidence', 'unmentioned'] });
describe('evidence instead of ranking promises', () => {
  it('parses unquoted attributes, entities, base URLs and rel tokens', () => {
    const p = page('<html lang=en><head><base href="https://example.com/docs/"><title>A &amp; B</title><meta name=description content="A > B"><link rel=canonical href=guide></head><body><h1>Useful guide</h1><img src=x alt=""><a href=guide rel="nofollow sponsored">Evidence &amp; tests</a></body></html>');
    expect(p.title).toBe('A & B'); expect(p.description).toBe('A > B'); expect(p.canonical).toBe('https://example.com/docs/guide'); expect(p.missingAlt).toBe(0); expect(p.links[0].rel).toEqual(['nofollow', 'sponsored']);
  });
  it('ignores script-generated fake tags and unsafe schemes', () => { const p = page('<script>"<h1>Fake</h1>"</script><a href="javascript:alert(1)">x</a><template><h1>Hidden</h1></template>'); expect(p.h1).toEqual([]); expect(p.links).toEqual([]); });
  it('does not create word-count or absent-schema ranking issues', () => expect(pageFindings(page('<title>Contact</title><h1>Contact us</h1>')).some(f => /thin|word|missing-schema|llms/.test(f.code))).toBe(false));
  it('detects header restrictions and malformed JSON-LD', () => { const p = parsePage({ url: 'https://example.com/', status: 200, html: '<script type="application/ld+json">{</script>', robots: 'noindex, nosnippet' }); expect(pageFindings(p).map(f => f.code)).toEqual(expect.arrayContaining(['noindex', 'snippet-restricted', 'invalid-jsonld'])); });
  it('does not flood error pages with metadata findings', () => expect(pageFindings(page('', 503)).map(f => f.code)).toEqual(['http-error']));
  it('finds duplicate metadata across the sample', () => { const a = page('<title>Duplicate</title>'); expect(inventoryFindings([a, { ...a, url: 'https://example.com/two' }]).filter(f => f.code === 'duplicate-title')).toHaveLength(2); });
  it('never calls a failed page repaired', () => {
    const old: AuditReport = { id: 'old', site_id: siteId, observed_at: new Date().toISOString(), attempted: 1, inventory: 1, pages: [page('')], failures: [], findings: pageFindings(page('')), methodology: 'test' };
    const next = { ...old, id: 'new', pages: [], failures: [{ url: 'https://example.com/', error: 'timeout' }], findings: [] };
    expect(compareAudits(next, old).resolved).toHaveLength(0); expect(compareAudits(next, old).unverified.length).toBe(old.findings.length);
  });
  it('retains tenant-scoped snapshots', () => { saveAudit({ site_id: siteId, observed_at: new Date().toISOString(), attempted: 1, inventory: 1, pages: [page('')], failures: [], findings: [], methodology: 'test' }, ws); expect(auditHistory(ws, siteId)).toHaveLength(1); expect(auditHistory(other, siteId)).toEqual([]); });
});
describe('ASO drafts', () => {
  it('checks platform-specific limits using Unicode code points', () => { const d = draft(); d.name = '😀'.repeat(30); expect(analyzeListing(d).fields[0].status).toBe('ok'); d.name += 'a'; expect(analyzeListing(d).fields[0].status).toBe('over'); d.platform = 'google'; d.subtitle = 's'.repeat(80); expect(analyzeListing(d).fields.find(f => f.field === 'subtitle')?.status).toBe('ok'); });
  it('records literal coverage without invented volume', () => { const result = analyzeListing(draft()); expect(result.terms[0].fields).toContain('description'); expect(result.terms[1].fields).toEqual([]); });
  it('validates malformed bodies', () => { expect(() => validateListing(null)).toThrow(); expect(() => validateListing({ ...draft(), locale: '../invalid' })).toThrow(); expect(() => validateListing({ ...draft(), target_terms: [42] })).toThrow(); });
  it('versions saves and rejects cross-tenant overwrite', () => { const one = saveAppListing(ws, draft(), siteId); saveAppListing(ws, { ...draft(), subtitle: 'Updated' }, siteId, one.id); expect(listingHistory(ws, one.id)).toHaveLength(2); expect(listAppListings(other)).toEqual([]); expect(listingHistory(other, one.id)).toEqual([]); expect(() => saveAppListing(other, draft(), null, one.id)).toThrow('Listing not found'); });
});
describe('backlink imports', () => {
  it('handles BOM, quoted commas, escaped quotes and CRLF', () => expect(parseCsv('\uFEFFsource_url,note\r\n"https://example.org/a,b","A ""quote""\nnext"')).toEqual([['source_url', 'note'], ['https://example.org/a,b', 'A "quote"\nnext']]));
  it('rejects unclosed quotes', () => expect(() => parseCsv('source_url\n"bad')).toThrow());
  it('deduplicates imports and rejects private, internal and foreign targets', async () => { const { getSiteById } = await import('../db/database.js'); const site = getSiteById(siteId)!; const csv = 'source_url,target_url\nhttps://publisher.example/story,https://example.com/\nhttps://publisher.example/story,https://example.com/\nhttp://127.0.0.1/secrets,https://example.com/\nhttps://example.com/inside,\nhttps://publisher.example/no,https://foreign.example/'; const result = importBacklinks(ws, site, csv, 'manual'); expect(result.added).toBe(1); expect(result.duplicates).toBe(1); expect(result.rejected).toHaveLength(3); expect(listBacklinks(other, siteId)).toEqual([]); });
});
