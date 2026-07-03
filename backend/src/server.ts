/**
 * server.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Fastify REST API + SSE live log stream + static frontend serving.
 *
 * Routes:
 *  GET  /health                   — liveness probe
 *  GET  /api/status               — auth status + scheduler info
 *  POST /api/auth/service-account — configure service account JSON
 *  POST /api/auth/device-flow/start  — start OAuth Device Flow
 *  POST /api/auth/device-flow/poll   — poll for device flow completion
 *  POST /api/auth/clear           — clear all auth credentials
 *
 *  GET  /api/sites                — list all sites
 *  POST /api/sites                — add a site
 *  PUT  /api/sites/:id            — update a site
 *  DELETE /api/sites/:id          — delete a site
 *  GET  /api/sites/:id/probe      — probe sitemap + IndexNow key status
 *  POST /api/sites/:id/verify-indexnow — verify IndexNow key file
 *
 *  GET  /api/runs                 — recent run history
 *  POST /api/runs                 — trigger a manual run
 *  GET  /api/runs/:id/logs        — get logs for a specific run
 *  GET  /api/logs                 — recent logs (all runs)
 *  GET  /api/logs/stream          — SSE stream of live logs
 *
 *  GET  /api/settings             — get all settings
 *  PUT  /api/settings             — update settings (cron_schedule, etc.)
 *
 *  GET  /:key.txt                 — IndexNow key file (auto-served for all sites)
 *  GET  /*                        — serve frontend SPA
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyRateLimit from '@fastify/rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import {
  getAllSites,
  getSiteById,
  upsertSite,
  deleteSite,
  getAllSettings,
  getSetting,
  setSetting,
  getRecentLogs,
  getLogsForRun,
  getRecentRuns,
  getIndexNowKey,
  getAllGoogleAccounts,
  getUrlsBySite,
  getAllQuotaUsageForDay,
  getAllUrlFailures,
  getRunLock,
  getDb,
  pruneOldLogs,
} from './db/database.js';
import {
  getAuthStatus,
  clearAuth,
  saveCredentials,
  exchangeCodeForTokens,
  disconnectGoogleAccount,
} from './auth/google-oauth.js';
import { probeSitemap } from './indexer/sitemap.js';
import { listGSCSites } from './indexer/google.js';
import {
  getOrCreateIndexNowKey,
  verifyIndexNowKey,
} from './indexer/indexnow.js';
import {
  runIndexing,
  isRunning,
  getCurrentRunId,
  subscribeToLogs,
  startScheduler,
  restartScheduler,
  forceStopRun,
} from './scheduler.js';
import { deployGeoFiles } from './indexer/geo-deploy.js';
import { getOverview, getSiteDetail, getAlerts, ackAlert, snapshotAllSites, recordAlert } from './analytics/stats.js';
import { auditSiteLlms } from './indexer/llms-audit.js';
import { getBingQuota, submitToBingInBatches, deriveBingSiteUrl } from './indexer/bing.js';
import { checkSiteHygiene } from './indexer/hygiene.js';
import { listPrompts, addPrompt, deletePrompt, getResults, runPrompt, runAllPrompts, configuredProviders, PROVIDERS, getThread, replyInThread, type Provider } from './ai/citations.js';
import { fetchCrux, cruxConfigured } from './ai/crux.js';
import { logSystem } from './utils/logger.js';
import { provisionGeminiKey } from './ai/provision.js';
import { backupNow, listBackups, startBackupScheduler } from './utils/backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.join(__dirname, '../frontend/dist');
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

// ── Fastify Setup ─────────────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV !== 'production';
const app = Fastify({
  logger: isDev
    ? {
        level: process.env.LOG_LEVEL ?? 'info',
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,reqId' },
        },
      }
    : {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], remove: true },
      },
});

await app.register(fastifyCors, {
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
});

await app.register(fastifyRateLimit, {
  max: parseInt(process.env.RATE_LIMIT_MAX ?? '300', 10),
  timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
  // SSE stream is exempt — long-lived connection
  allowList: (req) => req.url.startsWith('/api/logs/stream') || req.url === '/health' || req.url === '/api/healthz' || req.url === '/api/livez',
});

// ── CSRF-lite: require X-Requested-With on state-changing requests ────────────
// Browsers cannot send custom headers cross-origin without a CORS preflight.
// Combined with Same-Origin defaults this defeats the classic CSRF attack
// vector. Webhook callbacks and the OAuth callback are exempt.
const CSRF_EXEMPT_PATHS = new Set<string>([
  '/api/auth/google/callback',
]);
app.addHook('preHandler', async (req, reply) => {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (CSRF_EXEMPT_PATHS.has(req.url.split('?')[0])) return;
  if (!req.url.startsWith('/api/')) return;
  // The IndexNow key file route is GET only — covered above. All other state-
  // changing API routes must come from our own JS client.
  const header = req.headers['x-requested-with'];
  if (header !== 'seo-indexer-ui') {
    return reply.status(403).send({
      error: 'CSRF protection: missing X-Requested-With header. State-changing requests must come from the dashboard UI.',
    });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

// Liveness: just confirms the process is up. Used by Docker HEALTHCHECK.
app.get('/api/livez', async () => ({ ok: true, ts: new Date().toISOString() }));

// Readiness: confirms the DB is reachable and the scheduler is responsive.
app.get('/api/healthz', async (_req, reply) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
    if (row?.ok !== 1) throw new Error('DB sanity check failed');
    const lock = getRunLock();
    return {
      ok: true,
      ts: new Date().toISOString(),
      scheduler: { running: isRunning(), currentRunId: getCurrentRunId() },
      lock: lock ? { runId: lock.runId, acquiredAt: lock.acquiredAt } : null,
      sites: getAllSites().length,
      accounts: getAllGoogleAccounts().length,
    };
  } catch (e) {
    reply.status(503).send({ ok: false, error: String(e) });
  }
});

// ── Status ────────────────────────────────────────────────────────────────────

app.get('/api/status', async () => {
  const auth = await getAuthStatus();
  const cronSchedule = getSetting('cron_schedule') ?? '0 3 * * *';
  const lock = getRunLock();
  return {
    auth,
    scheduler: {
      running: isRunning(),
      currentRunId: getCurrentRunId(),
      cronSchedule,
      lock: lock ? { runId: lock.runId, acquiredAt: lock.acquiredAt } : null,
    },
    sites: getAllSites().length,
    accounts: getAllGoogleAccounts().length,
    version: process.env.APP_VERSION ?? 'dev',
  };
});

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/api/auth/accounts', async () => {
  const accounts = getAllGoogleAccounts();
  return accounts.map(acc => ({
    id: acc.id,
    email: acc.email,
    client_id: acc.client_id,
    created_at: acc.created_at,
  }));
});

app.delete('/api/auth/accounts/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  disconnectGoogleAccount(id);
  return { ok: true };
});

app.post('/api/auth/clear', async () => {
  clearAuth();
  return { ok: true };
});

app.post('/api/auth/save-credentials', async (req, reply) => {
  const { clientId, clientSecret } = (req.body ?? {}) as { clientId?: string; clientSecret?: string };
  if (!clientId || !clientSecret) {
    return reply.status(400).send({ error: 'clientId and clientSecret are required.' });
  }
  try {
    saveCredentials(clientId, clientSecret);
    return { ok: true };
  } catch (e) {
    return reply.status(500).send({ error: String(e) });
  }
});

app.get('/api/auth/google/callback', async (req, reply) => {
  const { code, error } = req.query as { code?: string; error?: string };
  if (error) {
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>Authentication Failed</title>
        </head>
        <body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: #12131a; color: #ff5e5e; padding: 40px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 80vh;">
          <div style="font-size: 48px; margin-bottom: 20px;">❌</div>
          <h2 style="color: white; margin-bottom: 8px;">Authentication Failed</h2>
          <p style="color: #94a3b8; font-size: 14px; margin-bottom: 24px;">${error}</p>
          <button onclick="window.close()" style="background: #252836; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold;">Close Window</button>
        </body>
      </html>
    `);
  }
  
  if (!code) {
    return reply.status(400).send({ error: 'Authorization code is required' });
  }

  // Construct standard redirect URI based on the request host (handles reverse proxies perfectly!)
  const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/google/callback`;

  try {
    await exchangeCodeForTokens(code, redirectUri);
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>Authentication Successful</title>
        </head>
        <body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: #12131a; color: #00e676; padding: 40px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 80vh;">
          <div style="font-size: 48px; margin-bottom: 20px;">🎉</div>
          <h2 style="color: white; margin-bottom: 8px;">Authenticated Successfully!</h2>
          <p style="color: #94a3b8; font-size: 14px; margin-bottom: 24px;">Your Google account is now securely connected. You can return to the dashboard.</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS' }, '*');
            }
            setTimeout(() => window.close(), 1500);
          </script>
          <button onclick="window.close()" style="background: #00e676; color: #12131a; border: none; padding: 10px 24px; font-weight: bold; border-radius: 6px; cursor: pointer; transition: opacity 0.2s;">Done</button>
        </body>
      </html>
    `);
  } catch (e) {
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>Authentication Failed</title>
        </head>
        <body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; background: #12131a; color: #ff5e5e; padding: 40px; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 80vh;">
          <div style="font-size: 48px; margin-bottom: 20px;">❌</div>
          <h2 style="color: white; margin-bottom: 8px;">Token Exchange Failed</h2>
          <p style="color: #94a3b8; font-size: 14px; margin-bottom: 24px;">${String(e)}</p>
          <button onclick="window.close()" style="background: #252836; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold;">Close Window</button>
        </body>
      </html>
    `);
  }
});

// List GSC properties (for onboarding site-picker)
app.get('/api/auth/gsc-sites', async (req, reply) => {
  const { accountId } = req.query as { accountId?: string };
  try {
    if (accountId) {
      const sites = await listGSCSites(accountId);
      return sites.map(s => ({ ...s, googleAccountId: accountId }));
    }
    const accounts = getAllGoogleAccounts();
    const allSites: Array<{ siteUrl: string; permissionLevel: string; googleAccountId: string }> = [];
    const seen = new Set<string>();
    for (const acc of accounts) {
      try {
        const sites = await listGSCSites(acc.id);
        for (const s of sites) {
          if (!seen.has(s.siteUrl)) {
            seen.add(s.siteUrl);
            allSites.push({ ...s, googleAccountId: acc.id });
          }
        }
      } catch (e) {
        console.warn(`Failed to list GSC sites for account ${acc.email}:`, e);
      }
    }
    return allSites;
  } catch (e) {
    return reply.status(400).send({ error: String(e) });
  }
});

// ── Sites ─────────────────────────────────────────────────────────────────────

app.get('/api/sites', async () => {
  const sites = getAllSites();
  return sites.map(site => ({
    ...site,
    indexNowKey: getIndexNowKey(site.id)?.key_value ?? getOrCreateIndexNowKey(site.id),
    indexNowVerified: getIndexNowKey(site.id)?.verified === 1,
  }));
});

app.post('/api/sites', async (req, reply) => {
  const {
    name,
    domain,
    sitemapUrl,
    gscUrl,
    googleAccountId,
    deploy_webhook_url,
    ftp_host,
    ftp_port,
    ftp_user,
    ftp_pass,
    ftp_path,
  } = req.body as {
    name?: string;
    domain?: string;
    sitemapUrl?: string;
    gscUrl?: string;
    googleAccountId?: string;
    deploy_webhook_url?: string | null;
    ftp_host?: string | null;
    ftp_port?: number | null;
    ftp_user?: string | null;
    ftp_pass?: string | null;
    ftp_path?: string | null;
  };
  if (!name || !domain || !sitemapUrl || !gscUrl) {
    return reply.status(400).send({ error: 'name, domain, sitemapUrl, and gscUrl are required.' });
  }
  const id = randomUUID();
  upsertSite({
    id,
    name,
    domain,
    sitemap_url: sitemapUrl,
    gsc_url: gscUrl,
    enabled: 1,
    google_account_id: googleAccountId || null,
    deploy_webhook_url: deploy_webhook_url || null,
    ftp_host: ftp_host || null,
    ftp_port: ftp_port !== undefined && ftp_port !== null ? Number(ftp_port) : 21,
    ftp_user: ftp_user || null,
    ftp_pass: ftp_pass || null,
    ftp_path: ftp_path || null,
  });
  // Pre-create IndexNow key
  const key = getOrCreateIndexNowKey(id);
  return { ok: true, id, indexNowKey: key };
});

app.put('/api/sites/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const existing = getSiteById(id);
  if (!existing) return reply.status(404).send({ error: 'Site not found.' });
  const updates = req.body as Partial<{
    name: string;
    domain: string;
    sitemapUrl: string;
    sitemap_url: string;
    gscUrl: string;
    gsc_url: string;
    enabled: number;
    googleAccountId: string | null;
    google_account_id: string | null;
    deploy_webhook_url: string | null;
    ftp_host: string | null;
    ftp_port: number | null;
    ftp_user: string | null;
    ftp_pass: string | null;
    ftp_path: string | null;
    geo_manage: number | null;
  }>;

  // Accept both camelCase and snake_case for the google account id so the
  // frontend can't accidentally drop the value due to naming mismatch.
  const incomingAccountId =
    updates.googleAccountId !== undefined ? updates.googleAccountId :
    updates.google_account_id !== undefined ? updates.google_account_id :
    undefined;

  // Validate the FK target exists, otherwise the upsert would throw silently.
  if (incomingAccountId) {
    const accountOk = getAllGoogleAccounts().some(a => a.id === incomingAccountId);
    if (!accountOk) {
      return reply.status(400).send({
        error: `Google account "${incomingAccountId}" does not exist. Reconnect the account on the Accounts page.`,
      });
    }
  }

  try {
    upsertSite({
      id,
      name: updates.name ?? existing.name,
      domain: updates.domain ?? existing.domain,
      sitemap_url: updates.sitemap_url ?? updates.sitemapUrl ?? existing.sitemap_url,
      gsc_url: updates.gsc_url ?? updates.gscUrl ?? existing.gsc_url,
      enabled: updates.enabled ?? existing.enabled,
      google_account_id: incomingAccountId !== undefined ? incomingAccountId : existing.google_account_id,
      deploy_webhook_url: updates.deploy_webhook_url !== undefined ? updates.deploy_webhook_url : existing.deploy_webhook_url,
      ftp_host: updates.ftp_host !== undefined ? updates.ftp_host : existing.ftp_host,
      ftp_port: updates.ftp_port !== undefined && updates.ftp_port !== null ? Number(updates.ftp_port) : existing.ftp_port,
      ftp_user: updates.ftp_user !== undefined ? updates.ftp_user : existing.ftp_user,
      ftp_pass: updates.ftp_pass !== undefined ? updates.ftp_pass : existing.ftp_pass,
      ftp_path: updates.ftp_path !== undefined ? updates.ftp_path : existing.ftp_path,
      geo_manage: updates.geo_manage !== undefined ? Number(updates.geo_manage) : existing.geo_manage,
    });
  } catch (e) {
    console.error(`[PUT /api/sites/${id}] upsertSite failed:`, e);
    return reply.status(500).send({ error: `Failed to update site: ${String(e)}` });
  }

  // Return the updated site so the client can verify the persisted state.
  const updated = getSiteById(id);
  return { ok: true, site: updated };
});

app.delete('/api/sites/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!getSiteById(id)) return reply.status(404).send({ error: 'Site not found.' });
  deleteSite(id);
  return { ok: true };
});

app.get('/api/sites/:id/probe', async (req, reply) => {
  const { id } = req.params as { id: string };
  const site = getSiteById(id);
  if (!site) return reply.status(404).send({ error: 'Site not found.' });
  const probe = await probeSitemap(site.sitemap_url);
  const indexNowKey = getOrCreateIndexNowKey(id);
  const indexNowVerified = getIndexNowKey(id)?.verified === 1;
  return { sitemap: probe, indexNowKey, indexNowVerified };
});

app.get('/api/sites/:id/urls', async (req, reply) => {
  const { id } = req.params as { id: string };
  const site = getSiteById(id);
  if (!site) return reply.status(404).send({ error: 'Site not found.' });
  const urls = getUrlsBySite(id);
  return urls;
});

app.post('/api/sites/:id/verify-indexnow', async (req, reply) => {
  const { id } = req.params as { id: string };
  const site = getSiteById(id);
  if (!site) return reply.status(404).send({ error: 'Site not found.' });
  const result = await verifyIndexNowKey(id, site.domain);
  return result;
});

// ── Runs ──────────────────────────────────────────────────────────────────────

app.get('/api/runs', async () => getRecentRuns(50));

app.post('/api/runs', async (req, reply) => {
  if (isRunning()) {
    return reply.status(409).send({ error: 'A run is already in progress.', runId: getCurrentRunId() });
  }
  const opts = (req.body ?? {}) as {
    siteIds?: string[];
    skipGoogle?: boolean;
    skipIndexNow?: boolean;
    skipBing?: boolean;
    skipSitemaps?: boolean;
    gscLimit?: number;
    googleLimit?: number;
  };
  try {
    const runId = await runIndexing({ trigger: 'manual', ...opts });
    return { ok: true, runId };
  } catch (e) {
    return reply.status(500).send({ error: String(e) });
  }
});

app.post('/api/runs/stop', async (req, reply) => {
  if (!isRunning()) {
    return reply.status(400).send({ error: 'No run is currently in progress.' });
  }
  forceStopRun();
  return { ok: true, message: 'Stop request sent successfully.' };
});

app.get('/api/runs/:id/logs', async (req) => {
  const { id } = req.params as { id: string };
  return getLogsForRun(id);
});

// ── Logs ──────────────────────────────────────────────────────────────────────

app.get('/api/logs', async (req) => {
  const { limit } = req.query as { limit?: string };
  return getRecentLogs(parseInt(limit ?? '200', 10));
});

// SSE: live log stream
app.get('/api/logs/stream', async (req, reply) => {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders();

  const send = (data: unknown) => {
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({ type: 'connected', ts: new Date().toISOString() });

  const unsub = subscribeToLogs((entry) => {
    send({ type: 'log', ...entry });
  });

  // Real ping events (not SSE comments) so the client's liveness watchdog
  // sees activity even when no logs are flowing.
  const keepAlive = setInterval(() => {
    send({ type: 'ping', ts: new Date().toISOString() });
  }, 15_000);

  req.socket.on('close', () => {
    clearInterval(keepAlive);
    unsub();
  });

  // Never resolve — SSE stays open
  await new Promise<void>(() => {});
});

// ── Settings ──────────────────────────────────────────────────────────────────

// Keys that are safe to expose to the frontend (exclude sensitive auth tokens)
const PUBLIC_SETTINGS = ['cron_schedule', 'google_project_id', 'notify_webhook_url'];
// Write-only secrets: settable via PUT, never echoed back — GET returns
// `<key>_configured` booleans instead.
const SECRET_SETTINGS = [
  'bing_api_key', 'crux_api_key',
  'openai_api_key', 'anthropic_api_key', 'gemini_api_key', 'perplexity_api_key', 'xai_api_key',
  'brave_api_key',
];
// Placeholder the UI may echo back for an unchanged secret — never store it.
const SECRET_MASK = '••••••••';

app.get('/api/settings', async () => {
  const all = getAllSettings();
  const pub = Object.fromEntries(
    Object.entries(all).filter(([k]) => PUBLIC_SETTINGS.includes(k))
  ) as Record<string, unknown>;
  for (const key of SECRET_SETTINGS) {
    pub[`${key}_configured`] = !!all[key];
  }
  return pub;
});

app.put('/api/settings', async (req) => {
  const body = req.body as Record<string, string>;
  for (const key of [...PUBLIC_SETTINGS, ...SECRET_SETTINGS]) {
    if (body[key] !== undefined) {
      setSetting(key, String(body[key]));
    }
  }
  for (const key of SECRET_SETTINGS) {
    if (body[key] !== undefined) {
      const value = String(body[key]).trim();
      if (value === SECRET_MASK) continue; // unchanged placeholder — ignore
      setSetting(key, value);              // empty string clears the secret
    }
  }
  // If cron changed, restart scheduler
  if (body.cron_schedule !== undefined) {
    restartScheduler();
  }
  return { ok: true };
});

// ── Quota Usage ───────────────────────────────────────────────────────────────

app.get('/api/quota/today', async (req) => {
  const { day } = (req.query ?? {}) as { day?: string };
  const targetDay = day ?? new Date().toISOString().slice(0, 10);
  const rows = getAllQuotaUsageForDay(targetDay);

  // Aggregate by API with helpful per-bucket detail.
  const grouped: Record<string, { total: number; buckets: Array<{ bucket: string; count: number }> }> = {};
  for (const row of rows) {
    if (!grouped[row.api]) grouped[row.api] = { total: 0, buckets: [] };
    grouped[row.api].total += row.count;
    grouped[row.api].buckets.push({ bucket: row.bucket, count: row.count });
  }

  // Build summary limits using current configuration
  const accounts = getAllGoogleAccounts();
  const distinctProjects = new Set(accounts.map(a => a.client_id)).size || 1;
  const summary = {
    day: targetDay,
    google_indexing: {
      used: grouped['google_indexing']?.total ?? 0,
      limit: 200 * distinctProjects,
      perProjectLimit: 200,
      projects: grouped['google_indexing']?.buckets ?? [],
    },
    gsc_inspection: {
      used: grouped['gsc_inspection']?.total ?? 0,
      perPropertyLimit: 2000,
      properties: grouped['gsc_inspection']?.buckets ?? [],
    },
    indexnow: {
      used: grouped['indexnow']?.total ?? 0,
      perSiteLimit: 10_000,
      sites: grouped['indexnow']?.buckets ?? [],
    },
  };
  return summary;
});

app.get('/api/url-failures', async () => {
  return getAllUrlFailures();
});

// ── Backups ───────────────────────────────────────────────────────────────────

app.get('/api/backups', async () => listBackups());

app.post('/api/backups', async () => {
  const result = backupNow();
  return { ok: true, ...result };
});

// ── Lock control (admin) ──────────────────────────────────────────────────────

app.post('/api/scheduler/release-lock', async (_req, reply) => {
  // Only allow if no run is in process memory (safety).
  if (isRunning()) {
    return reply.status(409).send({ error: 'A run is currently active in-process. Stop it first.' });
  }
  const db = getDb();
  db.prepare(`DELETE FROM settings WHERE key = 'run_lock'`).run();
  return { ok: true };
});

// ── GEO File Deploy (robots.txt + llms.txt) ───────────────────────────────────

app.post('/api/sites/:id/deploy-geo', async (req, reply) => {
  const site = getSiteById((req.params as { id: string }).id);
  if (!site) return reply.status(404).send({ error: 'Site not found.' });
  if (!site.geo_manage) {
    return reply.status(409).send({
      error: 'This site is in monitor-only mode — its llms.txt/robots.txt are maintained outside this tool. Enable "managed" mode on the site first if you really want the tool to generate and deploy them.',
    });
  }
  if (!site.deploy_webhook_url && !site.ftp_host) {
    return reply.status(409).send({
      error: 'No deployment method configured. Edit the site (Sites page) and set either a deploy webhook URL or FTP/SFTP credentials.',
    });
  }
  try {
    const result = await deployGeoFiles(site);
    return result;
  } catch (e) {
    return reply.status(502).send({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── IndexNow Key File Route ───────────────────────────────────────────────────
// This is the critical route that makes IndexNow verification work.
// IndexNow calls GET https://{domain}/{key}.txt and expects to receive the
// key as plain text. This route serves any valid key stored in the DB.

app.get('/:keyFile', async (req, reply) => {
  const { keyFile } = req.params as { keyFile: string };

  if (!keyFile.endsWith('.txt')) {
    return reply.callNotFound();
  }

  const key = keyFile.replace('.txt', '');
  // Validate it looks like a hex key (8-128 chars)
  if (!/^[a-f0-9]{8,128}$/.test(key)) {
    return reply.callNotFound();
  }

  // Check if this key belongs to any site
  const sites = getAllSites();
  for (const site of sites) {
    const stored = getIndexNowKey(site.id);
    if (stored?.key_value === key) {
      reply.header('Content-Type', 'text/plain');
      return reply.send(key);
    }
  }

  return reply.callNotFound();
});

// ── Frontend SPA ──────────────────────────────────────────────────────────────

try {
  await app.register(fastifyStatic, {
    root: FRONTEND_DIST,
    prefix: '/',
  });

  // SPA fallback for client-side routing (must come AFTER static + API routes)
  app.setNotFoundHandler(async (_req, reply) => {
    return reply.sendFile('index.html', FRONTEND_DIST);
  });
} catch {
  // Frontend not built yet — that's fine in dev
  app.setNotFoundHandler(async (_req, reply) => {
    reply.status(404).send({ error: 'Frontend not built. Run `npm run build` in the frontend directory.' });
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

// ── Analytics ────────────────────────────────────────────────────────────────

app.get('/api/analytics/overview', async () => getOverview());

app.get('/api/analytics/site/:id', async (req, reply) => {
  const detail = getSiteDetail((req.params as { id: string }).id);
  if (!detail) return reply.code(404).send({ error: 'Site not found' });
  return detail;
});

app.post('/api/analytics/snapshot', async () => ({ snapshots: snapshotAllSites().length }));

app.get('/api/analytics/alerts', async () => getAlerts());
app.post('/api/analytics/alerts/:id/ack', async (req) => {
  ackAlert(Number((req.params as { id: string }).id));
  return { ok: true };
});

// ── llms.txt lifecycle ───────────────────────────────────────────────────────

app.get('/api/sites/:id/llms-audit', async (req, reply) => {
  const site = getSiteById((req.params as { id: string }).id);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const audit = await auditSiteLlms(site);
  // Drift only matters when the tool owns the files; hand-maintained (monitor-
  // only) sites are EXPECTED to be richer than the generated baseline.
  if (audit.drift && site.geo_manage) {
    recordAlert(site.id, 'llms_drift', `${site.domain}: live llms.txt differs from generated version`, 'info');
  }
  return audit;
});

// ── Bing Webmaster ───────────────────────────────────────────────────────────

app.get('/api/bing/quota/:siteId', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const apiKey = getSetting('bing_api_key');
  if (!apiKey) return reply.code(400).send({ error: 'Bing API key not configured' });
  const quota = await getBingQuota(apiKey, deriveBingSiteUrl(site.gsc_url, site.domain));
  if (!quota) return reply.code(502).send({ error: 'Bing quota unavailable — check the API key and that the site is verified in Bing Webmaster Tools' });
  // Keep the response shape the dashboard expects.
  return { DailyQuota: quota.dailyQuota, MonthlyQuota: quota.monthlyQuota };
});

app.post('/api/bing/submit/:siteId', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const apiKey = getSetting('bing_api_key');
  if (!apiKey) return reply.code(400).send({ error: 'Bing API key not configured' });
  const { urls } = (req.body ?? {}) as { urls?: string[] };
  const list = urls?.length ? urls : getUrlsBySite(site.id).slice(0, 100).map((u: { url: string }) => u.url);
  const siteUrl = deriveBingSiteUrl(site.gsc_url, site.domain);
  const results = await submitToBingInBatches(apiKey, siteUrl, list);
  const submitted = results.filter(r => r.success).reduce((s, r) => s + r.urlCount, 0);
  const failed = results.find(r => !r.success);
  if (failed) {
    logSystem('warn', `Bing: ${failed.message ?? `HTTP ${failed.statusCode}`} for ${site.domain}`);
    return reply.code(failed.quotaExceeded ? 429 : 502).send({ submitted, error: failed.message ?? 'Bing submission failed' });
  }
  logSystem('ok', `Bing: submitted ${submitted} URLs for ${site.domain}`);
  return { submitted };
});

// ── Site hygiene ─────────────────────────────────────────────────────────────

app.get('/api/sites/:id/hygiene', async (req, reply) => {
  const site = getSiteById((req.params as { id: string }).id);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const result = await checkSiteHygiene(site);
  for (const issue of result.issues.filter(i => i.kind === 'broken')) {
    recordAlert(site.id, 'hygiene', `${issue.url}: ${issue.detail}`, 'warn');
  }
  return result;
});

// ── Core Web Vitals (CrUX) ───────────────────────────────────────────────────

app.post('/api/crux/:siteId/refresh', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  if (!cruxConfigured()) return reply.code(400).send({ error: 'CrUX API key not configured' });
  const result = await fetchCrux(site);
  return result ?? { error: 'Origin not in the CrUX dataset (insufficient traffic)' };
});

// ── AI citation tracking ─────────────────────────────────────────────────────

app.get('/api/ai/providers', async () => ({
  all: PROVIDERS,
  configured: configuredProviders(),
}));

app.get('/api/ai/prompts', async () => listPrompts());
app.post('/api/ai/prompts', async (req, reply) => {
  const { prompt, site_id } = (req.body ?? {}) as { prompt?: string; site_id?: string };
  if (!prompt?.trim()) return reply.code(400).send({ error: 'prompt required' });
  return addPrompt(prompt.trim(), site_id ?? null);
});
app.delete('/api/ai/prompts/:id', async (req) => {
  deletePrompt(Number((req.params as { id: string }).id));
  return { ok: true };
});

app.get('/api/ai/results', async () => getResults());
app.post('/api/ai/run/:promptId', async (req) => ({
  results: await runPrompt(Number((req.params as { promptId: string }).promptId)),
}));
app.post('/api/ai/run-all', async () => ({ ran: await runAllPrompts() }));

// Conversation thread for one prompt × provider (root run + follow-ups).
app.get('/api/ai/prompts/:id/thread/:provider', async (req) => {
  const { id, provider } = req.params as { id: string; provider: string };
  return getThread(Number(id), provider);
});

// Follow-up question in an existing thread — same provider, full context.
app.post('/api/ai/prompts/:id/reply', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { provider, message } = (req.body ?? {}) as { provider?: string; message?: string };
  if (!provider || !message?.trim()) return reply.code(400).send({ error: 'provider and message required' });
  try {
    return await replyInThread(Number(id), provider as Provider, message.trim());
  } catch (e) {
    return reply.code(422).send({ error: e instanceof Error ? e.message : 'reply failed' });
  }
});

// One-click Gemini key using the linked Google account's OAuth.
app.post('/api/ai/provision/gemini', async (req, reply) => {
  const { account_id } = (req.body ?? {}) as { account_id?: string };
  const accounts = getAllGoogleAccounts();
  const account = account_id ? accounts.find(a => a.id === account_id) : accounts[0];
  if (!account) return reply.code(400).send({ error: 'No Google account linked yet (Accounts page).' });
  const result = await provisionGeminiKey(account.id);
  if (!result.ok) return reply.code(422).send(result);
  return result;
});


await app.listen({ port: PORT, host: HOST });
console.log(`\n🚀 SEO Website Indexer running at http://localhost:${PORT}\n`);

// Bound the SQLite log table on long-lived installs (30-day retention).
try {
  const pruned = pruneOldLogs();
  if (pruned > 0) console.log(`Pruned ${pruned} log entries older than 30 days`);
} catch { /* non-fatal */ }

// Start scheduled indexing
startScheduler();

// Start nightly DB backup
startBackupScheduler();
