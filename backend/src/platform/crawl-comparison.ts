import { getDb } from '../db/database.js';
const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
interface Observation {
  source_url: string;
  target_url: string;
  anchor: string;
  crawl_date: string | null;
}
interface Snapshot {
  id: string;
  provenance: string;
  imported_at: string;
  summary: string;
  observations: string | null;
}
/** Compare imported samples. Absence is never evidence that a live link was lost. */
export function compareCrawlImports(workspaceId: string, siteId: string, beforeId: string, afterId: string) {
  if (beforeId === afterId) throw bad('Choose two different imports.');
  const read = (id: string) => {
    const row = getDb()
      .prepare(
        `SELECT i.id,i.provenance,i.imported_at,i.summary,o.observations
      FROM crawl_imports i LEFT JOIN crawl_import_observations o ON o.import_id=i.id
      WHERE i.workspace_id=? AND i.site_id=? AND i.id=?`,
      )
      .get(workspaceId, siteId, id) as Snapshot | undefined;
    if (!row) throw bad('Import not found', 404);
    if (row.observations === null)
      throw bad(
        'This older import has no comparison snapshot. Import the original extract again to compare it.',
        409,
      );
    const observations = JSON.parse(row.observations) as Observation[];
    const summary = JSON.parse(row.summary) as { rejected: unknown[]; skipped: number; records: number };
    return {
      id: row.id,
      provenance: row.provenance,
      imported_at: row.imported_at,
      observations,
      rejected_records: summary.rejected.length,
      skipped: summary.skipped,
      records: summary.records,
    };
  };
  const before = read(beforeId),
    after = read(afterId);
  const group = (observations: Observation[]) => {
    const pairs = new Map<string, Observation[]>();
    for (const row of observations) {
      const key = JSON.stringify([row.source_url, row.target_url]);
      pairs.set(key, [...(pairs.get(key) ?? []), row]);
    }
    return pairs;
  };
  const left = group(before.observations),
    right = group(after.observations);
  const evidence = (rows: Observation[]) =>
    JSON.stringify([...new Set(rows.map((r) => JSON.stringify([r.anchor, r.crawl_date])))].sort());
  const rows = [...new Set([...left.keys(), ...right.keys()])].sort().map((key) => {
    const previous = left.get(key) ?? [],
      current = right.get(key) ?? [];
    const pair = current[0] ?? previous[0];
    return {
      source_url: pair.source_url,
      target_url: pair.target_url,
      status: !previous.length ? 'newly_observed' : !current.length ? 'not_observed' : 'observed_both',
      evidence_changed: !!previous.length && !!current.length && evidence(previous) !== evidence(current),
      before: previous.map(({ anchor, crawl_date }) => ({ anchor, crawl_date })),
      after: current.map(({ anchor, crawl_date }) => ({ anchor, crawl_date })),
    };
  });
  const metadata = ({ observations, ...rest }: typeof before) => ({
    ...rest,
    observations: observations.length,
  });
  return {
    before: metadata(before),
    after: metadata(after),
    rows,
    counts: {
      newly_observed: rows.filter((r) => r.status === 'newly_observed').length,
      not_observed: rows.filter((r) => r.status === 'not_observed').length,
      observed_both: rows.filter((r) => r.status === 'observed_both').length,
      evidence_changed: rows.filter((r) => r.evidence_changed).length,
    },
    methodology:
      'Comparison covers only these imported extracts. Not observed in the comparison extract does not mean a live backlink was lost. Source coverage, crawl dates and rejected records can differ. Run live verification separately.',
  };
}
