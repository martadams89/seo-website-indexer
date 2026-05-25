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
} from './db/database.js';
import {
  getAuthStatus,
  startDeviceFlow,
  pollDeviceFlow,
  clearAuth,
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
} from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.join(__dirname, '../frontend/dist');
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

// ── Fastify Setup ─────────────────────────────────────────────────────────────

const app = Fastify({ logger: { level: 'warn' } });

await app.register(fastifyCors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

// ── Status ────────────────────────────────────────────────────────────────────

app.get('/api/status', async () => {
  const auth = await getAuthStatus();
  const cronSchedule = getSetting('cron_schedule') ?? '0 3 * * *';
  return {
    auth,
    scheduler: {
      running: isRunning(),
      currentRunId: getCurrentRunId(),
      cronSchedule,
    },
    sites: getAllSites().length,
  };
});

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/device-flow/start', async (req, reply) => {
  const { clientId, clientSecret } = (req.body ?? {}) as { clientId?: string; clientSecret?: string };
  try {
    const state = await startDeviceFlow(clientId, clientSecret);
    return state;
  } catch (e) {
    return reply.status(400).send({ error: String(e) });
  }
});

app.post('/api/auth/device-flow/poll', async (req, reply) => {
  const { deviceCode, interval, expiresIn } = req.body as {
    deviceCode?: string;
    interval?: number;
    expiresIn?: number;
  };
  if (!deviceCode) return reply.status(400).send({ error: 'deviceCode required' });
  try {
    await pollDeviceFlow(deviceCode, interval ?? 5, expiresIn ?? 1800);
    return { ok: true, message: 'Authenticated successfully via Device Flow.' };
  } catch (e) {
    return reply.status(400).send({ error: String(e) });
  }
});

app.post('/api/auth/clear', async () => {
  clearAuth();
  return { ok: true };
});

// List GSC properties (for onboarding site-picker)
app.get('/api/auth/gsc-sites', async (_req, reply) => {
  try {
    const sites = await listGSCSites();
    return sites;
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
  const { name, domain, sitemapUrl, gscUrl } = req.body as {
    name?: string;
    domain?: string;
    sitemapUrl?: string;
    gscUrl?: string;
  };
  if (!name || !domain || !sitemapUrl || !gscUrl) {
    return reply.status(400).send({ error: 'name, domain, sitemapUrl, and gscUrl are required.' });
  }
  const id = randomUUID();
  upsertSite({ id, name, domain, sitemap_url: sitemapUrl, gsc_url: gscUrl, enabled: 1 });
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
    gscUrl: string;
    enabled: number;
  }>;
  upsertSite({
    id,
    name: updates.name ?? existing.name,
    domain: updates.domain ?? existing.domain,
    sitemap_url: updates.sitemapUrl ?? existing.sitemap_url,
    gsc_url: updates.gscUrl ?? existing.gsc_url,
    enabled: updates.enabled ?? existing.enabled,
  });
  return { ok: true };
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
    skipSitemaps?: boolean;
  };
  try {
    const runId = await runIndexing({ trigger: 'manual', ...opts });
    return { ok: true, runId };
  } catch (e) {
    return reply.status(500).send({ error: String(e) });
  }
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

  const keepAlive = setInterval(() => {
    reply.raw.write(': keepalive\n\n');
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
const PUBLIC_SETTINGS = ['cron_schedule', 'google_project_id'];

app.get('/api/settings', async () => {
  const all = getAllSettings();
  return Object.fromEntries(
    Object.entries(all).filter(([k]) => PUBLIC_SETTINGS.includes(k))
  );
});

app.put('/api/settings', async (req) => {
  const body = req.body as Record<string, string>;
  for (const key of PUBLIC_SETTINGS) {
    if (body[key] !== undefined) {
      setSetting(key, String(body[key]));
    }
  }
  // If cron changed, restart scheduler
  if (body.cron_schedule !== undefined) {
    restartScheduler();
  }
  return { ok: true };
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
    decorateReply: false,
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

await app.listen({ port: PORT, host: HOST });
console.log(`\n🚀 SEO Website Indexer running at http://localhost:${PORT}\n`);

// Start scheduled indexing
startScheduler();
