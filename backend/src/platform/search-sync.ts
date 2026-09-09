import { getDb, type Site } from '../db/database.js';
import { getAccessTokenForAccount } from '../auth/google-oauth.js';
import { gscQuery } from '../indexer/performance.js';
import { searchOpportunities } from './search-opportunities.js';
interface Sync {
  identity: string;
  checked_at: string;
  success_at: string | null;
  error: string | null;
  truncated: number;
}
const running = new Map<string, Promise<void>>();
export async function loadSearchOpportunities(workspaceId: string, site: Site, force = false) {
  if (site.workspace_id !== workspaceId)
    throw Object.assign(new Error('Site not found'), { statusCode: 404 });
  const identity = JSON.stringify([site.google_account_id, site.gsc_url]);
  const read = () =>
    getDb().prepare('SELECT * FROM discovery_search_sync WHERE site_id=?').get(site.id) as Sync | undefined;
  let sync = read();
  // Query history belongs to the linked account/property; never mix a previous
  // property's observations into a newly selected property, even on sync failure.
  if (site.google_account_id && site.gsc_url && sync && sync.identity !== identity) {
    getDb().transaction(() => {
      getDb().prepare("DELETE FROM perf_query_daily WHERE site_id=? AND engine='google'").run(site.id);
      getDb().prepare('DELETE FROM discovery_search_sync WHERE site_id=?').run(site.id);
    })();
    sync = undefined;
  }
  if (
    site.google_account_id &&
    site.gsc_url &&
    (!sync ||
      sync.identity !== identity ||
      Date.now() - Date.parse(sync.checked_at) > (force || sync.error ? 30_000 : 6 * 3600_000))
  ) {
    let task = running.get(site.id);
    if (!task) {
      task = (async () => {
        const at = new Date().toISOString();
        const window = searchOpportunities(workspaceId, site.id);
        let truncated = false;
        try {
          const token = await getAccessTokenForAccount(site.google_account_id!);
          const endDate = new Date(Date.parse(window.to) - 86400000).toISOString().slice(0, 10);
          const rows: Array<{
            date: string;
            query: string;
            clicks: number;
            impressions: number;
            position: number;
          }> = [];
          for (let startRow = 0; startRow < 50_000; startRow += 25_000) {
            const page = await gscQuery(token, site.gsc_url, {
              startDate: window.previousFrom,
              endDate,
              dimensions: ['date', 'query'],
              rowLimit: 25_000,
              startRow,
              dataState: 'final',
            });
            rows.push(
              ...page.flatMap((r) =>
                r.keys?.length === 2 &&
                /^\d{4}-\d{2}-\d{2}$/.test(r.keys[0]) &&
                r.keys[0] >= window.previousFrom &&
                r.keys[0] < window.to &&
                [r.clicks, r.impressions, r.position].every(Number.isFinite)
                  ? [
                      {
                        date: r.keys[0],
                        query: r.keys[1],
                        clicks: r.clicks,
                        impressions: r.impressions,
                        position: r.position,
                      },
                    ]
                  : [],
              ),
            );
            if (page.length < 25_000) break;
            if (startRow === 25_000) truncated = true;
          }
          getDb().transaction(() => {
            // Only replace cache after a successful, complete provider response.
            if (!truncated)
              getDb()
                .prepare(
                  "DELETE FROM perf_query_daily WHERE site_id=? AND engine='google' AND day>=? AND day<?",
                )
                .run(site.id, window.previousFrom, window.to);
            const insert = getDb().prepare(
              "INSERT INTO perf_query_daily(site_id,engine,day,query,clicks,impressions,position) VALUES(?,'google',?,?,?,?,?) ON CONFLICT(site_id,engine,day,query) DO UPDATE SET clicks=excluded.clicks,impressions=excluded.impressions,position=excluded.position",
            );
            for (const row of rows)
              insert.run(site.id, row.date, row.query, row.clicks, row.impressions, row.position);
            getDb()
              .prepare('INSERT OR REPLACE INTO discovery_search_sync VALUES(?,?,?,?,?,?)')
              .run(site.id, identity, at, at, null, Number(truncated));
          })();
        } catch (error) {
          getDb()
            .prepare('INSERT OR REPLACE INTO discovery_search_sync VALUES(?,?,?,?,?,?)')
            .run(
              site.id,
              identity,
              at,
              sync?.identity === identity ? sync.success_at : null,
              error instanceof Error ? error.message : 'Google sync failed',
              0,
            );
        }
      })().finally(() => running.delete(site.id));
      running.set(site.id, task);
    }
    await task;
    sync = read();
  }
  const data = searchOpportunities(workspaceId, site.id);
  return {
    ...data,
    sync: {
      connected: !!site.google_account_id,
      property: site.gsc_url,
      last_success: sync?.success_at ?? null,
      error: !site.google_account_id
        ? 'Link a Google account and Search Console property to this website in Sites.'
        : !site.gsc_url
          ? 'Choose a Search Console property for this website in Sites.'
          : (sync?.error ?? null),
      truncated: !!sync?.truncated,
    },
    methodology:
      data.methodology +
      ' Query history syncs automatically on opening this view (six-hour cache, up to 50,000 daily query rows). All queries shows lower-volume observations too.',
  };
}
