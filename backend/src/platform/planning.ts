import { randomUUID } from 'node:crypto';
import { addAnnotation } from './store.js';
import { getDb } from '../db/database.js';
export interface DiscoveryDocument {
  id: string;
  site_id: string;
  kind: string;
  body: Record<string, string>;
  created_at: string;
  updated_at: string;
}
export function listDocuments(workspaceId: string, siteId: string, kind: string): DiscoveryDocument[] {
  return (
    getDb()
      .prepare(
        'SELECT * FROM discovery_documents WHERE workspace_id=? AND site_id=? AND kind=? ORDER BY updated_at DESC LIMIT 500',
      )
      .all(workspaceId, siteId, kind) as Array<Omit<DiscoveryDocument, 'body'> & { body: string }>
  ).map((row) => ({ ...row, body: JSON.parse(row.body) }));
}
export function saveDocument(
  workspaceId: string,
  siteId: string,
  kind: string,
  value: unknown,
  id?: string,
): DiscoveryDocument {
  if (!['brief', 'experiment'].includes(kind) || !value || typeof value !== 'object' || Array.isArray(value))
    throw Object.assign(new Error('Invalid document.'), { statusCode: 400 });
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length > 30 ||
    Object.entries(body).some(([k, v]) => k.length > 50 || typeof v !== 'string' || v.length > 12000) ||
    typeof body.title !== 'string' ||
    !body.title.trim() ||
    body.title.length > 200 ||
    JSON.stringify(body).length > 50000
  )
    throw Object.assign(
      new Error('Use a title up to 200 characters and text fields up to 12,000 characters.'),
      { statusCode: 400 },
    );
  if (
    id &&
    !getDb()
      .prepare('SELECT id FROM discovery_documents WHERE workspace_id=? AND site_id=? AND kind=? AND id=?')
      .get(workspaceId, siteId, kind, id)
  )
    throw Object.assign(new Error('Document not found'), { statusCode: 404 });
  if (
    typeof body.evidence === 'string' &&
    body.evidence
      .split(/\n/)
      .filter(Boolean)
      .some((line) => /^(?:javascript|data|file):/i.test(line.trim()))
  )
    throw Object.assign(new Error('Use HTTP(S) evidence links or plain source notes.'), { statusCode: 400 });
  if (
    kind === 'experiment' &&
    (!['clicks', 'impressions', 'ctr', 'position'].includes(String(body.metric)) ||
      !['7', '14', '28'].includes(String(body.window_days)) ||
      typeof body.start_date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.start_date) ||
      !Number.isFinite(Date.parse(body.start_date)) ||
      new Date(body.start_date).toISOString().slice(0, 10) !== body.start_date)
  )
    throw Object.assign(new Error('Choose a valid date, metric and 7, 14 or 28 day window.'), {
      statusCode: 400,
    });
  const key = id ?? randomUUID();
  const at = new Date().toISOString();
  getDb().transaction(() => {
    getDb()
      .prepare(
        'INSERT INTO discovery_documents(id,workspace_id,site_id,kind,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at',
      )
      .run(key, workspaceId, siteId, kind, JSON.stringify(body), at, at);
    getDb()
      .prepare('INSERT INTO discovery_document_revisions(document_id,body,observed_at) VALUES(?,?,?)')
      .run(key, JSON.stringify(body), at);
    getDb()
      .prepare(
        'DELETE FROM discovery_document_revisions WHERE document_id=? AND id NOT IN (SELECT id FROM discovery_document_revisions WHERE document_id=? ORDER BY id DESC LIMIT 30)',
      )
      .run(key, key);
  })();
  if (!id && kind === 'experiment')
    addAnnotation({
      workspaceId,
      siteId,
      kind: 'measurement_plan',
      title: String(body.title),
      note: String(body.hypothesis || ''),
      eventAt: `${body.start_date}T12:00:00.000Z`,
      metadata: { document_id: key, metric: body.metric, window_days: body.window_days },
    });
  return listDocuments(workspaceId, siteId, kind).find((d) => d.id === key)!;
}

export function measureDocument(workspaceId: string, id: string) {
  const raw = getDb()
    .prepare("SELECT * FROM discovery_documents WHERE workspace_id=? AND id=? AND kind='experiment'")
    .get(workspaceId, id) as { site_id: string; body: string } | undefined;
  if (!raw) throw Object.assign(new Error('Measurement plan not found'), { statusCode: 404 });
  const body = JSON.parse(raw.body) as Record<string, string>;
  const days = Number(body.window_days);
  const start = Date.parse(body.start_date);
  const beforeFrom = new Date(start - days * 86400000).toISOString().slice(0, 10);
  const afterTo = new Date(start + days * 86400000).toISOString().slice(0, 10);
  const aggregate = (from: string, to: string) => {
    const rows = getDb()
      .prepare(
        "SELECT day,clicks,impressions,position FROM perf_daily WHERE site_id=? AND engine='google' AND day>=? AND day<? ORDER BY day",
      )
      .all(raw.site_id, from, to) as Array<{
      day: string;
      clicks: number;
      impressions: number;
      position: number;
    }>;
    const clicks = rows.reduce((a, r) => a + r.clicks, 0);
    const impressions = rows.reduce((a, r) => a + r.impressions, 0);
    return {
      from,
      to,
      observed_days: rows.length,
      clicks,
      impressions,
      ctr: impressions ? clicks / impressions : null,
      position: impressions ? rows.reduce((a, r) => a + r.position * r.impressions, 0) / impressions : null,
    };
  };
  const before = aggregate(beforeFrom, body.start_date);
  const after = aggregate(body.start_date, afterTo);
  const metric = body.metric as 'clicks' | 'impressions' | 'ctr' | 'position';
  const cutoff = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const status =
    afterTo > cutoff
      ? 'Waiting for complete period'
      : before.observed_days < days || after.observed_days < days
        ? 'Incomplete daily coverage'
        : 'Comparable periods';
  const a = status === 'Comparable periods' ? before[metric] : null;
  const b = status === 'Comparable periods' ? after[metric] : null;
  return {
    metric,
    days,
    before,
    after,
    status,
    delta: a === null || b === null ? null : b - a,
    change_percent: a === null || b === null || a === 0 ? null : ((b - a) / a) * 100,
    methodology:
      'Cached Google Search Console site totals. CTR uses total clicks divided by impressions; position is impression-weighted. Differences do not establish causation.',
  };
}
