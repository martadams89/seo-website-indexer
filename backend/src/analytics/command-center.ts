/**
 * Workspace command centre — one tenant-scoped read model for the home page.
 * It deliberately composes existing stores instead of creating a second copy
 * of analytics data, so every headline number drills into its source screen.
 */
import { getDb, getGoogleAccountsForWorkspace, getSitesForWorkspace } from '../db/database.js';
import { listBingAccounts } from '../auth/workspaces.js';
import { configuredChannels } from '../utils/notify.js';
import { getAiInsights } from '../ai/citations.js';
import { getAgentReadinessSummary } from './agent-readiness-store.js';
import { getPortfolioMovers } from './perf-store.js';
import { getAlerts, getOverview } from './stats.js';

export interface CommandAction {
  id: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  kind: 'indexing' | 'search' | 'ai' | 'integration' | 'experience';
  title: string;
  description: string;
  to: string;
  count?: number;
}

export interface CommandCenter {
  generatedAt: string;
  score: { overall: number; indexation: number | null; aiVisibility: number | null; agentReadiness: number | null; operations: number };
  metrics: {
    sites: number; urls: number; indexed: number; indexedRate: number | null;
    stale: number; failures: number; openAlerts: number;
    clicks7d: number; clicksChange: number | null;
    aiPrompts: number; aiChecks: number; aiVisibility: number | null; aiChange: number | null;
  };
  integrations: { google: number; bing: number; aiProviders: number; notifications: number };
  actions: CommandAction[];
  movers: ReturnType<typeof getPortfolioMovers>;
  ai: ReturnType<typeof getAiInsights>;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export function getCommandCenter(workspaceId: string | null): CommandCenter {
  const generatedAt = new Date().toISOString();
  const overview = getOverview(workspaceId);
  const movers = getPortfolioMovers(workspaceId);
  const ai = getAiInsights(workspaceId);
  if (!workspaceId) {
    return {
      generatedAt,
      score: { overall: 0, indexation: null, aiVisibility: null, agentReadiness: null, operations: 100 },
      metrics: { sites: 0, urls: 0, indexed: 0, indexedRate: null, stale: 0, failures: 0, openAlerts: 0, clicks7d: 0, clicksChange: null, aiPrompts: 0, aiChecks: 0, aiVisibility: null, aiChange: null },
      integrations: { google: 0, bing: 0, aiProviders: 0, notifications: 0 },
      actions: [], movers, ai,
    };
  }

  const sites = getSitesForWorkspace(workspaceId);
  const siteIds = sites.map(site => site.id);
  const readiness = getAgentReadinessSummary(siteIds).map(item => item.score).filter((score): score is number => score !== null);
  const agentReadiness = readiness.length ? Math.round(readiness.reduce((sum, score) => sum + score, 0) / readiness.length) : null;
  const indexedRate = overview.totals.urls_total ? Math.round(overview.totals.urls_indexed / overview.totals.urls_total * 100) : null;
  const alerts = getAlerts(workspaceId, 100) as Array<{ id: number; severity: string; kind: string; message: string; acked: number }>;
  const openAlerts = alerts.filter(alert => !alert.acked);
  const errorAlerts = openAlerts.filter(alert => alert.severity === 'error').length;
  const warnAlerts = openAlerts.filter(alert => alert.severity === 'warn').length;
  const operations = clamp(100 - errorAlerts * 14 - warnAlerts * 5 - Math.min(overview.totals.failures * 4, 28));

  const currentClicks = movers.reduce((sum, site) => sum + site.clicks.current, 0);
  const previousClicks = movers.reduce((sum, site) => sum + site.clicks.previous, 0);
  const clicksChange = previousClicks === 0 ? (currentClicks > 0 ? 100 : null) : Math.round((currentClicks - previousClicks) / previousClicks * 100);
  const aiVisibility = ai.overview.checks ? ai.overview.visibility : null;
  const scoreParts = [indexedRate, aiVisibility, agentReadiness, operations].filter((value): value is number => value !== null);
  const overall = scoreParts.length ? clamp(scoreParts.reduce((sum, value) => sum + value, 0) / scoreParts.length) : operations;

  const google = getGoogleAccountsForWorkspace(workspaceId).length;
  const bing = listBingAccounts(workspaceId).length;
  const notifications = configuredChannels(workspaceId).length;
  const integrations = { google, bing, aiProviders: ai.overview.configuredProviders, notifications };

  const actions: CommandAction[] = [];
  if (sites.length === 0) actions.push({ id: 'add-site', priority: 'high', kind: 'indexing', title: 'Add your first site', description: 'Connect a sitemap and Search Console property to start the operating loop.', to: '/sites' });
  if (sites.length > 0 && google === 0) actions.push({ id: 'connect-google', priority: 'critical', kind: 'integration', title: 'Connect Google Search Console', description: 'Submission and Google performance data are unavailable until an account is shared with this workspace.', to: '/settings?tab=accounts' });
  if (overview.totals.failures > 0) actions.push({ id: 'submission-failures', priority: 'critical', kind: 'indexing', title: 'Resolve submission failures', description: 'Check reachability, clear fixed records, and let the next run retry them.', to: '/?focus=failures', count: overview.totals.failures });
  if (errorAlerts > 0) actions.push({ id: 'critical-alerts', priority: 'critical', kind: 'search', title: 'Investigate critical regressions', description: 'Index coverage or another monitored signal has moved sharply.', to: '/analytics', count: errorAlerts });
  if (overview.totals.urls_stale > 0) actions.push({ id: 'stale-content', priority: 'high', kind: 'indexing', title: 'Refresh changed pages', description: 'These pages changed after Google last inspected them and are ready for resubmission.', to: '/analytics', count: overview.totals.urls_stale });
  if (ai.overview.configuredProviders === 0) actions.push({ id: 'connect-ai', priority: 'medium', kind: 'integration', title: 'Connect an answer engine', description: 'Add an API key to measure brand visibility across AI search.', to: '/settings?tab=keys' });
  else if (ai.overview.prompts === 0) actions.push({ id: 'add-prompts', priority: 'medium', kind: 'ai', title: 'Build an AI visibility prompt set', description: 'Track the discovery, comparison, commercial and brand questions that lead buyers to you.', to: '/citations' });
  else if (ai.opportunities.length > 0) actions.push({ id: 'citation-gaps', priority: 'medium', kind: 'ai', title: 'Close AI citation gaps', description: 'Prioritize prompts where your sites are absent from the latest grounded answers.', to: '/citations', count: ai.opportunities.length });
  if (agentReadiness !== null && agentReadiness < 80) actions.push({ id: 'agent-readiness', priority: 'medium', kind: 'experience', title: 'Improve agent readiness', description: 'Strengthen machine-readable discovery, identity and content surfaces.', to: '/analytics', count: 100 - agentReadiness });
  if (notifications === 0) actions.push({ id: 'notifications', priority: 'low', kind: 'integration', title: 'Route operational notifications', description: 'Send run failures and citation changes to Slack, email or your preferred channel.', to: '/settings?tab=notifications' });

  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  const verifiedIndexNow = siteIds.length
    ? (getDb().prepare(`SELECT COUNT(*) AS count FROM indexnow_keys WHERE verified = 1 AND site_id IN (${siteIds.map(() => '?').join(',')})`).get(...siteIds) as { count: number }).count
    : 0;
  if (sites.length > 0 && verifiedIndexNow < sites.length) {
    actions.push({ id: 'indexnow-keys', priority: 'low', kind: 'integration', title: 'Verify IndexNow ownership', description: `${sites.length - verifiedIndexNow} site${sites.length - verifiedIndexNow === 1 ? '' : 's'} still need a reachable key file.`, to: '/sites', count: sites.length - verifiedIndexNow });
  }

  return {
    generatedAt,
    score: { overall, indexation: indexedRate, aiVisibility, agentReadiness, operations },
    metrics: {
      sites: sites.length, urls: overview.totals.urls_total, indexed: overview.totals.urls_indexed,
      indexedRate, stale: overview.totals.urls_stale, failures: overview.totals.failures,
      openAlerts: overview.totals.open_alerts, clicks7d: currentClicks, clicksChange,
      aiPrompts: ai.overview.prompts, aiChecks: ai.overview.checks, aiVisibility, aiChange: ai.overview.change,
    },
    integrations, actions: actions.slice(0, 8), movers: movers.slice(0, 6), ai,
  };
}
