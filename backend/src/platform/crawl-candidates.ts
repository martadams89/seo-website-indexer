import { createWorkItem } from './store.js';
import { randomUUID } from 'node:crypto';
import { getDb, type Site } from '../db/database.js';
import { normalizeUrl } from './page-evidence.js';
import { importBacklinks, targetBelongsToSite } from './backlinks.js';
import { validateOutboundUrl } from '../security/outbound-url.js';
const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');
export interface CrawlCandidate {
  id: string;
  source_url: string;
  target_url: string;
  anchor: string;
  crawl_date: string | null;
  provenance: string;
  imported_at: string;
  state: string;
  notes: string;
}
export function parseCrawlCandidates(text: string, site: Site) {
  if (!text.trim() || Buffer.byteLength(text) > 500000) throw bad('Use non-empty NDJSON up to 500 KB.');
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim());
  if (lines.length > 500) throw bad('Use at most 500 JSON records per import.');
  const candidates: Array<Omit<CrawlCandidate, 'id' | 'provenance' | 'imported_at' | 'state' | 'notes'>> = [];
  const rejected: Array<{ line: number; reason: string }> = [];
  let skipped = 0;
  let examined = 0;
  for (const { index, line } of lines) {
    try {
      const value = object(JSON.parse(line));
      const envelope = object(value.Envelope);
      const wat = Object.keys(envelope).length > 0;
      const header = object(envelope['WARC-Header-Metadata']);
      const metadata = object(
        object(object(envelope['Payload-Metadata'])['HTTP-Response-Metadata'])['HTML-Metadata'],
      );
      if (wat && header['WARC-Type'] !== 'response') {
        skipped++;
        continue;
      }
      const source = normalizeUrl(string(wat ? header['WARC-Target-URI'] : value.source_url));
      if (!source) throw bad('Source must be an absolute HTTP(S) page URL.');
      validateOutboundUrl(source, { allowHttp: true, label: 'Crawl source' });
      if (targetBelongsToSite(source, site)) {
        skipped++;
        continue;
      }
      const rawDate = wat ? header['WARC-Date'] : value.crawl_date;
      let date: string | null = null;
      if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
        if (
          typeof rawDate !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(rawDate) ||
          !Number.isFinite(Date.parse(rawDate)) ||
          new Date(rawDate).toISOString().slice(0, 10) !== rawDate.slice(0, 10) ||
          Date.parse(rawDate) > Date.now()
        )
          throw bad('Crawl date must be a valid past UTC date.');
        date = new Date(rawDate).toISOString();
      }
      const links = wat
        ? Array.isArray(metadata.Links)
          ? metadata.Links
          : []
        : [{ url: value.target_url, text: value.anchor, path: 'A@/href' }];
      examined += links.length;
      if (examined > 20000) throw bad('Link budget exceeded: use a smaller extract.');
      if (wat && !links.length) skipped++;
      for (const raw of links) {
        const link = object(raw);
        if (link.path !== 'A@/href') {
          skipped++;
          continue;
        }
        const target = normalizeUrl(string(link.url), wat ? source : undefined);
        if (!target || !targetBelongsToSite(target, site)) {
          skipped++;
          continue;
        }
        if (candidates.length >= 500) throw bad('Candidate budget exceeded: use a smaller extract.');
        candidates.push({
          source_url: source,
          target_url: target,
          anchor: string(link.text).slice(0, 300),
          crawl_date: date,
        });
      }
    } catch (error) {
      if (error instanceof Error && /budget exceeded/.test(error.message)) throw error;
      rejected.push({
        line: index + 1,
        reason:
          error instanceof SyntaxError
            ? 'Invalid JSON record'
            : error instanceof Error
              ? error.message
              : 'Invalid record',
      });
    }
  }
  return { candidates, rejected, skipped, records: lines.length };
}
export function listCrawlCandidates(workspaceId: string, siteId: string): CrawlCandidate[] {
  return getDb()
    .prepare(
      'SELECT id,source_url,target_url,anchor,crawl_date,provenance,imported_at,state,notes FROM crawl_candidates WHERE workspace_id=? AND site_id=? ORDER BY imported_at DESC,rowid DESC LIMIT 5000',
    )
    .all(workspaceId, siteId) as CrawlCandidate[];
}
export function importCrawlCandidates(
  workspaceId: string,
  site: Site,
  text: string,
  provenance: string,
  preview: boolean,
) {
  if (site.workspace_id !== workspaceId) throw bad('Site not found', 404);
  if (!provenance.trim() || provenance.length > 200)
    throw bad('Give the extract a source label up to 200 characters.');
  const parsed = parseCrawlCandidates(text, site);
  let added = 0;
  let duplicates = 0;
  const at = new Date().toISOString();
  const rollback = new Error('Preview rollback');
  try {
    getDb().transaction(() => {
      for (const row of parsed.candidates) {
        const changes = getDb()
          .prepare(
            'INSERT OR IGNORE INTO crawl_candidates(id,workspace_id,site_id,source_url,target_url,anchor,crawl_date,provenance,imported_at) VALUES(?,?,?,?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            workspaceId,
            site.id,
            row.source_url,
            row.target_url,
            row.anchor,
            row.crawl_date,
            provenance.trim(),
            at,
          ).changes;
        if (changes) added++;
        else duplicates++;
      }
      const count = getDb()
        .prepare('SELECT COUNT(*) n FROM crawl_candidates WHERE workspace_id=? AND site_id=?')
        .get(workspaceId, site.id) as { n: number };
      if (count.n > 5000) throw bad('This site has reached its 5,000 candidate budget.');
      if (preview) throw rollback;
      getDb()
        .prepare('INSERT INTO crawl_imports VALUES(?,?,?,?,?,?)')
        .run(
          randomUUID(),
          workspaceId,
          site.id,
          provenance.trim(),
          at,
          JSON.stringify({
            added,
            duplicates,
            rejected: parsed.rejected,
            skipped: parsed.skipped,
            records: parsed.records,
          }),
        );
      getDb()
        .prepare(
          'DELETE FROM crawl_imports WHERE workspace_id=? AND site_id=? AND id NOT IN (SELECT id FROM crawl_imports WHERE workspace_id=? AND site_id=? ORDER BY imported_at DESC,rowid DESC LIMIT 30)',
        )
        .run(workspaceId, site.id, workspaceId, site.id);
    })();
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return {
    added,
    duplicates,
    rejected: parsed.rejected,
    skipped: parsed.skipped,
    records: parsed.records,
    preview,
  };
}

export function reviewCrawlCandidate(workspaceId: string, site: Site, id: string, action: string) {
  const row = getDb()
    .prepare('SELECT * FROM crawl_candidates WHERE workspace_id=? AND site_id=? AND id=?')
    .get(workspaceId, site.id, id) as CrawlCandidate | undefined;
  if (!row || site.workspace_id !== workspaceId) throw bad('Candidate not found', 404);
  if (action === 'work') {
    createWorkItem({
      workspaceId,
      siteId: site.id,
      source: 'crawl_candidate',
      sourceRef: row.id,
      title: `Review backlink candidate: ${new URL(row.source_url).hostname}`,
      description:
        'Investigate this historical crawl observation before treating it as a live backlink. Review relevance and permission before any outreach.',
      severity: 'low',
      deepLink: `/discovery?tab=candidates&site=${encodeURIComponent(site.id)}`,
      evidence: {
        source_url: row.source_url,
        target_url: row.target_url,
        historical_anchor: row.anchor,
        crawl_date: row.crawl_date,
        provenance: row.provenance,
        notes: row.notes,
      },
    });
    return { ok: true };
  }
  if (action === 'promote') {
    if (row.state === 'dismissed') throw bad('Restore a dismissed candidate before monitoring it.');
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const result = importBacklinks(
      workspaceId,
      site,
      'source_url,target_url\n' + quote(row.source_url) + ',' + quote(row.target_url),
      `Crawl candidate: ${row.provenance}`,
    );
    if (result.rejected.length) throw bad(result.rejected[0].reason);
    getDb()
      .prepare("UPDATE crawl_candidates SET state='promoted' WHERE workspace_id=? AND id=?")
      .run(workspaceId, id);
    return { ok: true };
  }
  if (row.state === 'promoted') throw bad('Manage promoted sources in the backlink monitor.');
  if (!['pending', 'dismissed'].includes(action)) throw bad('Choose a supported candidate action.');
  getDb()
    .prepare('UPDATE crawl_candidates SET state=? WHERE workspace_id=? AND id=?')
    .run(action, workspaceId, id);
  return { ok: true };
}

export function saveCandidateNotes(workspaceId: string, id: string, notes: unknown) {
  if (typeof notes !== 'string' || notes.length > 4000) throw bad('Use notes up to 4,000 characters.');
  if (
    !getDb()
      .prepare('UPDATE crawl_candidates SET notes=? WHERE workspace_id=? AND id=?')
      .run(notes, workspaceId, id).changes
  )
    throw bad('Candidate not found', 404);
  return { ok: true };
}

export function crawlImportHistory(workspaceId: string, siteId: string) {
  return (
    getDb()
      .prepare(
        'SELECT id,provenance,imported_at,summary FROM crawl_imports WHERE workspace_id=? AND site_id=? ORDER BY imported_at DESC,rowid DESC LIMIT 30',
      )
      .all(workspaceId, siteId) as Array<{
      id: string;
      provenance: string;
      imported_at: string;
      summary: string;
    }>
  ).map((row) => ({ ...row, summary: JSON.parse(row.summary) }));
}
