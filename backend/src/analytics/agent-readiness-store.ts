/**
 * Agent-readiness store: persists one score row per site/day (upsert) so the
 * metric is trackable over time, raises an alert on meaningful regressions, and
 * serves the latest score + history to the dashboard. Mirrors perf-store.ts.
 */
import { getDb, getAllSites, type Site } from '../db/database.js';
import { checkAgentReadiness, type AgentReadinessResult, type AgentCheck } from '../indexer/agent-readiness.js';
import { recordAlert } from './stats.js';
import { logSystem } from '../utils/logger.js';

const REGRESSION_DROP = 10; // score points; below this we alert

function today(): string { return new Date().toISOString().slice(0, 10); }

function previousScore(siteId: string): number | null {
  const row = getDb().prepare(
    "SELECT score FROM agent_readiness WHERE site_id = ? AND day < ? ORDER BY day DESC LIMIT 1"
  ).get(siteId, today()) as { score: number } | undefined;
  return row ? row.score : null;
}

/** Run the live check for one site, upsert today's row, alert on regressions. */
export async function snapshotSiteAgentReadiness(site: Site): Promise<AgentReadinessResult> {
  const result = await checkAgentReadiness(site);
  const prev = previousScore(site.id);
  getDb().prepare(`
    INSERT INTO agent_readiness(site_id, day, score, passed, total, checks)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(site_id, day) DO UPDATE SET
      score=excluded.score, passed=excluded.passed, total=excluded.total,
      checks=excluded.checks, created_at=datetime('now')
  `).run(site.id, today(), result.score, result.passed, result.total, JSON.stringify(result.checks));

  if (prev !== null && result.score <= prev - REGRESSION_DROP) {
    recordAlert(site.id, 'agent_readiness',
      `${site.domain}: agent-readiness dropped ${prev}% → ${result.score}%`, 'warn',
      result.checks.filter(c => !c.pass).map(c => c.label).join(', '));
  }
  return result;
}

/** Snapshot every site (called after each indexing run). Best-effort per site. */
export async function snapshotAllAgentReadiness(): Promise<number> {
  let n = 0;
  for (const site of getAllSites()) {
    try { await snapshotSiteAgentReadiness(site); n++; }
    catch (e) { logSystem('warn', `Agent-readiness snapshot failed for ${site.domain}: ${e instanceof Error ? e.message : e}`); }
  }
  return n;
}

export interface AgentReadinessHistoryPoint { day: string; score: number; passed: number; total: number }

export function getAgentReadinessHistory(siteId: string, days = 90): AgentReadinessHistoryPoint[] {
  return getDb().prepare(
    `SELECT day, score, passed, total FROM agent_readiness
     WHERE site_id = ? AND day >= date('now', ?) ORDER BY day ASC`
  ).all(siteId, `-${days} days`) as AgentReadinessHistoryPoint[];
}

export interface LatestAgentReadiness {
  day: string; score: number; passed: number; total: number; checks: AgentCheck[];
}

export function getLatestAgentReadiness(siteId: string): LatestAgentReadiness | null {
  const row = getDb().prepare(
    'SELECT day, score, passed, total, checks FROM agent_readiness WHERE site_id = ? ORDER BY day DESC LIMIT 1'
  ).get(siteId) as { day: string; score: number; passed: number; total: number; checks: string } | undefined;
  if (!row) return null;
  return { ...row, checks: safeParse(row.checks) };
}

function safeParse(s: string): AgentCheck[] {
  try { return JSON.parse(s) as AgentCheck[]; } catch { return []; }
}

/** Portfolio roll-up: latest score per site, for the analytics overview. */
export interface AgentReadinessSummary { siteId: string; score: number | null }

export function getAgentReadinessSummary(siteIds: string[]): AgentReadinessSummary[] {
  return siteIds.map(siteId => {
    const row = getDb().prepare(
      'SELECT score FROM agent_readiness WHERE site_id = ? ORDER BY day DESC LIMIT 1'
    ).get(siteId) as { score: number } | undefined;
    return { siteId, score: row ? row.score : null };
  });
}
