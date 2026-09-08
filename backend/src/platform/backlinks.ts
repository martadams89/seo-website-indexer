import { randomUUID } from 'node:crypto';
import { getDb, getSiteById, type Site } from '../db/database.js';
import { safeFetch, readResponseText, validateOutboundUrl } from '../security/outbound-url.js';
import { normalizeUrl, host, parsePage } from './page-evidence.js';
import { createWorkItem } from './store.js';
export interface Backlink {
  notes: string;
  enabled: number;
  id: string;
  site_id: string;
  source_url: string;
  target_url: string;
  provenance: string;
  status: 'unverified' | 'present' | 'missing' | 'unreachable';
  evidence: {
    status?: number;
    final_url?: string;
    anchors?: string[];
    rel?: string[];
    targets?: string[];
    links?: Array<{ url: string; anchor: string; rel: string[] }>;
    error?: string;
    changes?: string[];
    previous_status?: string;
  };
  first_seen: string;
  checked_at: string | null;
}
export function targetBelongsToSite(url: string, site: Site): boolean {
  const root = host(/^https?:/.test(site.domain) ? site.domain : `https://${site.domain}`);
  const candidate = host(url);
  return !!root && (candidate === root || candidate.endsWith(`.${root}`));
}
/** RFC4180-style reader; commas/newlines in quoted cells and UTF-8 BOM are supported. */
export function parseCsv(text: string): string[][] {
  const delimiter = text.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === delimiter && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (quoted) throw Object.assign(new Error('CSV contains an unclosed quoted field.'), { statusCode: 400 });
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, '');
  return rows;
}
export function importBacklinks(
  workspaceId: string,
  site: Site,
  csv: string,
  provenance: string,
  preview = false,
) {
  if (!csv || csv.length > 500000)
    throw Object.assign(new Error('Paste a CSV up to 500 KB.'), { statusCode: 400 });
  const rows = parseCsv(csv);
  const header = rows.shift()?.map((s) => s.toLowerCase().replace(/[\s-]+/g, '_')) ?? [];
  const sourceIndex = header.findIndex((s) =>
    [
      'source_url',
      'source',
      'linking_page',
      'referring_page_url',
      'linking_url',
      'referring_page',
      'source_page',
      'page_url',
    ].includes(s),
  );
  const targetIndex = header.findIndex((s) =>
    ['target_url', 'target', 'target_page', 'linked_page', 'destination_url', 'link_url'].includes(s),
  );
  if (sourceIndex < 0 || rows.length > 500)
    throw Object.assign(
      new Error('Use a source_url (or Linking page) header and at most 500 rows. target_url is optional.'),
      { statusCode: 400 },
    );
  let added = 0;
  let duplicates = 0;
  const rejected: Array<{ row: number; reason: string }> = [];
  const at = new Date().toISOString();
  const rollback = new Error('preview rollback');
  try {
    getDb().transaction(() => {
      rows.forEach((row, index) => {
        try {
          const source = normalizeUrl(row[sourceIndex] ?? '');
          const rawTarget = targetIndex < 0 ? '' : (row[targetIndex] ?? '');
          const target = rawTarget ? normalizeUrl(rawTarget) : '';
          if (!source || (rawTarget && !target)) throw new Error('Use absolute HTTP(S) URLs.');
          validateOutboundUrl(source, { label: 'Backlink source' });
          if (target && !targetBelongsToSite(target, site))
            throw new Error('Target must belong to the selected site.');
          if (targetBelongsToSite(source, site)) throw new Error('This is an internal link, not a backlink.');
          const count = getDb()
            .prepare(
              'INSERT OR IGNORE INTO backlinks(id,workspace_id,site_id,source_url,target_url,provenance,first_seen) VALUES(?,?,?,?,?,?,?)',
            )
            .run(randomUUID(), workspaceId, site.id, source, target, provenance.slice(0, 200), at).changes;
          if (count) added++;
          else duplicates++;
        } catch (error) {
          rejected.push({ row: index + 2, reason: error instanceof Error ? error.message : 'Invalid row' });
        }
      });
      if (preview) throw rollback;
    })();
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return { added, duplicates, rejected };
}
export function listBacklinks(workspaceId: string, siteId: string): Backlink[] {
  return (
    getDb()
      .prepare(
        'SELECT * FROM backlinks WHERE workspace_id=? AND site_id=? ORDER BY first_seen DESC,id LIMIT 5000',
      )
      .all(workspaceId, siteId) as Array<Omit<Backlink, 'evidence'> & { evidence: string }>
  ).map((row) => ({ ...row, evidence: JSON.parse(row.evidence) }));
}
const checking = new Set<string>();
export async function checkBacklinks(workspaceId: string, siteId: string, dueOnly = false, id?: string) {
  const site = getSiteById(siteId);
  if (!site || site.workspace_id !== workspaceId)
    throw Object.assign(new Error('Site not found'), { statusCode: 404 });
  if (checking.has(siteId)) return { checked: 0, busy: true };
  checking.add(siteId);
  try {
    const rows = getDb()
      .prepare(
        `SELECT * FROM backlinks WHERE workspace_id=? AND site_id=? AND enabled=1 ${id ? 'AND id=?' : ''} ${dueOnly ? "AND (checked_at IS NULL OR julianday(checked_at)<julianday('now','-7 days'))" : ''} ORDER BY checked_at ASC,id LIMIT 25`,
      )
      .all(workspaceId, siteId, ...(id ? [id] : [])) as Array<
      Omit<Backlink, 'evidence'> & { evidence: string }
    >;
    for (let i = 0; i < rows.length; i += 3)
      await Promise.all(
        rows.slice(i, i + 3).map(async (row) => {
          let status: Backlink['status'] = 'unreachable';
          let evidence: Backlink['evidence'] = {};
          try {
            const response = await safeFetch(
              row.source_url,
              {
                headers: { 'User-Agent': 'OrganicCommandBacklinks/1.0' },
                signal: AbortSignal.timeout(15000),
              },
              { label: 'Backlink source' },
            );
            evidence = { status: response.status, final_url: response.url || row.source_url };
            if (
              !response.ok ||
              !/(?:text\/html|application\/xhtml\+xml)/i.test(response.headers.get('content-type') ?? '')
            ) {
              await response.body?.cancel();
              evidence.error = 'Source unavailable or not HTML; link presence could not be verified.';
            } else {
              const page = parsePage({
                url: row.source_url,
                finalUrl: response.url || row.source_url,
                status: response.status,
                html: await readResponseText(response, 2000000, 'Backlink source'),
              });
              const matched = page.links
                .filter((link) =>
                  row.target_url ? link.url === row.target_url : targetBelongsToSite(link.url, site),
                )
                .slice(0, 100);
              evidence.links = matched.slice(0, 100);
              status = matched.length ? 'present' : page.linksTruncated ? 'unreachable' : 'missing';
              if (!matched.length && page.linksTruncated)
                evidence.error = 'Link extraction limit reached; absence could not be verified.';
              evidence.anchors = [...new Set(matched.map((l) => l.anchor))];
              evidence.rel = [...new Set(matched.flatMap((l) => l.rel))];
              evidence.targets = [...new Set(matched.map((l) => l.url))];
            }
          } catch (error) {
            evidence.error = error instanceof Error ? error.message : 'Request failed';
          }
          const previous = JSON.parse(row.evidence) as Backlink['evidence'];
          evidence.changes = ['anchors', 'rel', 'targets'].filter(
            (key) =>
              row.status === 'present' &&
              status === 'present' &&
              JSON.stringify(previous[key as keyof typeof previous]) !==
                JSON.stringify(evidence[key as keyof typeof evidence]),
          );
          evidence.previous_status = row.status;
          const at = new Date().toISOString();
          getDb().transaction(() => {
            getDb()
              .prepare('UPDATE backlinks SET status=?,evidence=?,checked_at=? WHERE workspace_id=? AND id=?')
              .run(status, JSON.stringify(evidence), at, workspaceId, row.id);
            getDb()
              .prepare('INSERT INTO backlink_checks(backlink_id,status,evidence,checked_at) VALUES(?,?,?,?)')
              .run(row.id, status, JSON.stringify(evidence), at);
            getDb()
              .prepare(
                'DELETE FROM backlink_checks WHERE backlink_id=? AND id NOT IN (SELECT id FROM backlink_checks WHERE backlink_id=? ORDER BY id DESC LIMIT 30)',
              )
              .run(row.id, row.id);
          })();
          if (row.status === 'present' && status === 'missing')
            createWorkItem({
              workspaceId,
              siteId,
              source: 'backlinks',
              sourceRef: row.id,
              title: 'Previously observed backlink is missing',
              description:
                'Review the source page and whether the link moved or now requires JavaScript. Do not assume a ranking loss.',
              severity: 'medium',
              deepLink: `/discovery?tab=backlinks&site=${encodeURIComponent(siteId)}`,
              evidence: { source_url: row.source_url, url: row.target_url || undefined, ...evidence },
            });
        }),
      );
    return { checked: rows.length, busy: false };
  } finally {
    checking.delete(siteId);
  }
}
export function backlinkHistory(workspaceId: string, id: string) {
  return (
    getDb()
      .prepare(
        'SELECT c.* FROM backlink_checks c JOIN backlinks b ON b.id=c.backlink_id WHERE b.workspace_id=? AND b.id=? ORDER BY c.id DESC LIMIT 30',
      )
      .all(workspaceId, id) as Array<{ id: number; status: string; evidence: string; checked_at: string }>
  ).map((row) => ({ ...row, evidence: JSON.parse(row.evidence) }));
}
