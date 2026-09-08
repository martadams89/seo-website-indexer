import { getDb } from '../db/database.js';
export function searchOpportunities(workspaceId: string, siteId?: string) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2);
  const currentFrom = new Date(end.getTime() - 28 * 86400000).toISOString().slice(0, 10);
  const previousFrom = new Date(end.getTime() - 56 * 86400000).toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  const rows = getDb()
    .prepare(
      `SELECT p.site_id,s.name site_name,p.query,
    SUM(CASE WHEN day>=? THEN clicks ELSE 0 END) clicks,
    SUM(CASE WHEN day>=? THEN impressions ELSE 0 END) impressions,
    SUM(CASE WHEN day<? THEN clicks ELSE 0 END) previous_clicks,
    SUM(CASE WHEN day<? THEN impressions ELSE 0 END) previous_impressions,
    SUM(CASE WHEN day>=? THEN position*impressions ELSE 0 END)/NULLIF(SUM(CASE WHEN day>=? THEN impressions ELSE 0 END),0) position,
    COUNT(DISTINCT CASE WHEN day>=? THEN day END) current_days,
    COUNT(DISTINCT CASE WHEN day<? THEN day END) previous_days
    FROM perf_query_daily p JOIN sites s ON s.id=p.site_id WHERE s.workspace_id=? AND p.engine='google' AND day>=? AND day<? ${siteId ? 'AND p.site_id=?' : ''}
    GROUP BY p.site_id,p.query HAVING impressions>=100 ORDER BY impressions DESC LIMIT 500`,
    )
    .all(...Array(8).fill(currentFrom), workspaceId, previousFrom, to, ...(siteId ? [siteId] : [])) as Array<{
    site_id: string;
    site_name: string;
    query: string;
    clicks: number;
    impressions: number;
    previous_clicks: number;
    previous_impressions: number;
    position: number;
    current_days: number;
    previous_days: number;
  }>;
  const opportunities = rows.flatMap((row) => {
    const decline =
      row.previous_clicks >= 10 &&
      row.clicks < row.previous_clicks * 0.7 &&
      row.current_days >= 14 &&
      row.previous_days >= 14;
    const striking = row.position >= 4 && row.position <= 20;
    if (!decline && !striking) return [];
    return [
      {
        ...row,
        kind: decline ? 'Declining clicks' : 'Within reach',
        ctr: row.impressions ? row.clicks / row.impressions : 0,
        reason: decline
          ? `${row.clicks} clicks versus ${row.previous_clicks} in the preceding period. Compare intent, seasonality and affected pages before changing content.`
          : `Average position ${row.position.toFixed(1)} with ${row.impressions} recorded impressions. Review the ranking page, its title and how well it answers this query.`,
        confidence:
          row.current_days >= 14 && row.previous_days >= 14
            ? 'Observed across both periods'
            : 'Limited history',
      },
    ];
  });
  return {
    from: currentFrom,
    previousFrom,
    to,
    opportunities,
    methodology:
      'Cached Google Search Console queries, two equal 28-day windows ending before the most recent two days. Position is impression-weighted. Query rows can be anonymised or omitted by Google; missing data is not zero search demand. Priorities use stated thresholds, not predicted traffic or keyword difficulty.',
  };
}
