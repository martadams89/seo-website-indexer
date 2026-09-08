import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getSiteById, upsertSite } from '../db/database.js';
import { createUser } from '../auth/users.js';
import { bootstrapUserWorkspace } from '../auth/workspaces.js';
import { safeFetch } from '../security/outbound-url.js';
import { importBacklinks, listBacklinks, checkBacklinks, backlinkHistory } from '../platform/backlinks.js';
import { saveDocument, listDocuments, measureDocument } from '../platform/planning.js';
import { startAuditJob, getAuditJob, cancelAuditJob, recoverAuditJobs } from '../platform/audit-jobs.js';
import { auditView } from '../platform/discovery-store.js';

vi.hoisted(() => {
  process.env.DATA_DIR = process.getBuiltinModule('node:fs').mkdtempSync('/tmp/discovery-workflows-');
  process.env.APP_SECRET = 'workflow-test-only';
});
vi.mock('../security/outbound-url.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../security/outbound-url.js')>()),
  safeFetch: vi.fn(),
}));
let ws: string;
let other: string;
const siteId = 'workflow-site';
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });
beforeAll(() => {
  ws = bootstrapUserWorkspace(
    createUser({ email: 'workflow@example.com', password: 'testing12345' }),
    false,
  ).id;
  other = bootstrapUserWorkspace(
    createUser({ email: 'foreign@example.com', password: 'testing12345' }),
    false,
  ).id;
  for (const id of [siteId, 'job-site-2', 'job-site-3'])
    upsertSite({
      id,
      workspace_id: ws,
      domain: id === siteId ? 'example.com' : `${id}.example.com`,
      name: id,
      sitemap_url: 'https://example.com/sitemap.xml',
      gsc_url: 'sc-domain:example.com',
      enabled: 0,
    });
});
beforeEach(() => {
  vi.mocked(safeFetch).mockReset();
  getDb().prepare('DELETE FROM backlinks').run();
  getDb().prepare('DELETE FROM perf_daily').run();
});
const importLink = () => {
  importBacklinks(
    ws,
    getSiteById(siteId)!,
    'source_url,target_url\nhttps://publisher.example/story,https://example.com/',
    'Manual evidence',
  );
  return listBacklinks(ws, siteId)[0];
};

describe('backlink evidence lifecycle', () => {
  it('previews duplicates and rejected rows without persisting records', () => {
    const csv =
      'source_url\nhttps://publisher.example/story\nhttps://publisher.example/story\nhttps://127.0.0.1/private';
    const preview = importBacklinks(ws, getSiteById(siteId)!, csv, 'Preview', true);
    expect(preview).toMatchObject({ added: 1, duplicates: 1 });
    expect(preview.rejected).toHaveLength(1);
    expect(listBacklinks(ws, siteId)).toEqual([]);
  });
  it('tracks observed rel changes and creates work only after a confirmed disappearance', async () => {
    const row = importLink();
    vi.mocked(safeFetch).mockResolvedValueOnce(html('<a href="https://example.com/">Useful source</a>'));
    await checkBacklinks(ws, siteId);
    expect(listBacklinks(ws, siteId)[0].status).toBe('present');
    vi.mocked(safeFetch).mockResolvedValueOnce(
      html('<a rel="nofollow sponsored" href="https://example.com/">Useful source</a>'),
    );
    await checkBacklinks(ws, siteId, false, row.id);
    expect(listBacklinks(ws, siteId)[0].evidence.changes).toContain('rel');
    vi.mocked(safeFetch).mockResolvedValueOnce(html('<p>No link in this response.</p>'));
    await checkBacklinks(ws, siteId, false, row.id);
    expect(listBacklinks(ws, siteId)[0].status).toBe('missing');
    expect(
      getDb().prepare("SELECT id FROM work_items WHERE source='backlinks' AND source_ref=?").all(row.id),
    ).toHaveLength(1);
    expect(backlinkHistory(ws, row.id)).toHaveLength(3);
    expect(backlinkHistory(other, row.id)).toEqual([]);
  });
  it('keeps unavailable and truncated responses from becoming missing-link claims', async () => {
    importLink();
    vi.mocked(safeFetch).mockResolvedValueOnce(html('Service unavailable', 503));
    await checkBacklinks(ws, siteId);
    expect(listBacklinks(ws, siteId)[0].status).toBe('unreachable');
    vi.mocked(safeFetch).mockResolvedValueOnce(html('<a href="/other">x</a>'.repeat(5001)));
    await checkBacklinks(ws, siteId);
    expect(listBacklinks(ws, siteId)[0]).toMatchObject({
      status: 'unreachable',
      evidence: { error: expect.stringContaining('limit') },
    });
  });
  it('honours paused records and the seven-day due interval', async () => {
    const row = importLink();
    getDb().prepare('UPDATE backlinks SET enabled=0 WHERE id=?').run(row.id);
    expect(await checkBacklinks(ws, siteId)).toMatchObject({ checked: 0 });
    expect(safeFetch).not.toHaveBeenCalled();
    getDb()
      .prepare('UPDATE backlinks SET enabled=1,checked_at=? WHERE id=?')
      .run(new Date().toISOString(), row.id);
    expect(await checkBacklinks(ws, siteId, true)).toMatchObject({ checked: 0 });
    await expect(checkBacklinks(other, siteId)).rejects.toThrow('Site not found');
  });
});

describe('saved measurement plans', () => {
  const body = () => ({
    title: 'Improve the page introduction',
    hypothesis: 'Clearer navigation may help visitors.',
    start_date: '2020-01-08',
    window_days: '7',
    metric: 'ctr',
  });
  function daily(day: string, clicks: number, impressions: number, position: number) {
    getDb()
      .prepare(
        "INSERT INTO perf_daily(site_id,engine,day,clicks,impressions,ctr,position) VALUES(?,'google',?,?,?,?,?)",
      )
      .run(siteId, day, clicks, impressions, clicks / impressions, position);
  }
  it('rejects invalid calendar dates, field types and cross-workspace overwrites', () => {
    expect(() => saveDocument(ws, siteId, 'experiment', { ...body(), start_date: '2025-02-30' })).toThrow();
    expect(() => saveDocument(ws, siteId, 'brief', { title: 'Brief', content: {} })).toThrow();
    const doc = saveDocument(ws, siteId, 'experiment', body());
    expect(() => saveDocument(other, siteId, 'experiment', body(), doc.id)).toThrow('Document not found');
    expect(() => measureDocument(other, doc.id)).toThrow('Measurement plan not found');
    expect(listDocuments(other, siteId, 'experiment')).toEqual([]);
  });
  it('uses aggregate CTR and impression-weighted position across complete windows', () => {
    for (let d = 1; d <= 14; d++)
      daily(`2020-01-${String(d).padStart(2, '0')}`, d < 8 ? 10 : 30, d < 8 ? 100 : 200, d < 8 ? 10 : 5);
    const doc = saveDocument(ws, siteId, 'experiment', body());
    const result = measureDocument(ws, doc.id);
    expect(result.status).toBe('Comparable periods');
    expect(result.before.ctr).toBeCloseTo(0.1);
    expect(result.after.ctr).toBeCloseTo(0.15);
    expect(result.change_percent).toBeCloseTo(50);
    expect(result.after.position).toBe(5);
  });
  it('suppresses deltas for missing days and unfinished observation periods', () => {
    daily('2020-01-01', 10, 100, 5);
    daily('2020-01-08', 20, 100, 3);
    const incomplete = measureDocument(ws, saveDocument(ws, siteId, 'experiment', body()).id);
    expect(incomplete).toMatchObject({
      status: 'Incomplete daily coverage',
      delta: null,
      change_percent: null,
    });
    const future = measureDocument(
      ws,
      saveDocument(ws, siteId, 'experiment', { ...body(), start_date: '2099-01-01' }).id,
    );
    expect(future).toMatchObject({ status: 'Waiting for complete period', delta: null });
  });
  it('retains only thirty document revisions', () => {
    const doc = saveDocument(ws, siteId, 'brief', { title: 'Evidence brief' });
    for (let i = 0; i < 34; i++) saveDocument(ws, siteId, 'brief', { title: `Revision ${i}` }, doc.id);
    expect(
      getDb().prepare('SELECT id FROM discovery_document_revisions WHERE document_id=?').all(doc.id),
    ).toHaveLength(30);
  });
});

describe('audit jobs and snapshot access', () => {
  it('completes a job with stored evidence and scopes its data', async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      html('<html lang="en"><title>A useful page</title><h1>Evidence</h1></html>'),
    );
    const job = startAuditJob(ws, siteId, 10);
    expect(getAuditJob(other, job.id)).toBeNull();
    expect(cancelAuditJob(other, job.id)).toBeNull();
    await vi.waitFor(() => expect(getAuditJob(ws, job.id)?.state).toBe('succeeded'));
    const view = auditView(ws, siteId);
    expect(view.report?.pages).toHaveLength(1);
    expect(view.history[0]).not.toHaveProperty('pages');
    expect(() => auditView(other, siteId, view.report!.id)).toThrow('Audit snapshot not found');
  });
  it('reuses an active job, limits concurrency and cancels without saving partial reports', async () => {
    vi.mocked(safeFetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const stop = () => reject(new Error('Request cancelled'));
          if (init?.signal?.aborted) stop();
          else init?.signal?.addEventListener('abort', stop, { once: true });
        }),
    );
    const count = auditView(ws, siteId).history.length;
    const first = startAuditJob(ws, siteId, 25);
    expect(startAuditJob(ws, siteId).id).toBe(first.id);
    const second = startAuditJob(ws, 'job-site-2');
    expect(() => startAuditJob(ws, 'job-site-3')).toThrow('Two audits');
    expect(cancelAuditJob(ws, first.id)?.state).toBe('cancelled');
    expect(cancelAuditJob(ws, second.id)?.state).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(auditView(ws, siteId).history).toHaveLength(count);
    vi.mocked(safeFetch).mockResolvedValue(html('<title>Next run</title>'));
    const next = startAuditJob(ws, siteId);
    await vi.waitFor(() => expect(getAuditJob(ws, next.id)?.state).toBe('succeeded'));
  });
  it('marks interrupted jobs failed when the server restarts', () => {
    getDb()
      .prepare(
        "INSERT INTO discovery_jobs(id,workspace_id,site_id,state,created_at,updated_at) VALUES('interrupted',?,?,'running',?,?)",
      )
      .run(ws, siteId, new Date().toISOString(), new Date().toISOString());
    recoverAuditJobs();
    expect(getAuditJob(ws, 'interrupted')).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('restarted'),
    });
  });
});
