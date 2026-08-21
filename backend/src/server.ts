/**
 * server.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Fastify REST API + SSE live log stream + static frontend serving.
 *
 * Routes:
 *  GET  /health                   — liveness probe
 *  GET  /api/status               — auth status + scheduler info
 *  POST /api/auth/service-account — configure service account JSON
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
import QRCode from 'qrcode';

import {
  getAllSites,
  getSitesForWorkspace,
  getSiteById,
  upsertSite,
  deleteSite,
  setSiteLlmsContent,
  getAllSettings,
  effectiveSetting,
  getSetting,
  setSetting,
  getWorkspaceSettings,
  setWorkspaceSetting,
  getRecentLogs,
  getLogsForRun,
  getRecentRuns,
  getIndexNowKey,
  getAllGoogleAccounts,
  getGoogleAccountsForWorkspace,
  getGoogleAccountsForOwner,
  getGoogleAccountById,
  isGoogleAccountAvailableToWorkspace,
  shareGoogleAccountWithWorkspace,
  unshareGoogleAccountFromWorkspace,
  googleAccountWorkspaceIds,
  getUrlsBySite,
  getAllQuotaUsageForDay,
  getAllUrlFailures,
  clearUrlFailuresForSites,
  getRunLock,
  getDb,
  pruneOldLogs,
  incrementQuota,
  getQuotaUsage,
} from './db/database.js';
import {
  getAuthStatus,
  clearAuthForWorkspace,
  saveCredentials,
  exchangeCodeForTokens,
  disconnectGoogleAccount,
  createGoogleOAuthAuthorization,
  consumeGoogleOAuthState,
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
import { buildLlmsTxt, buildRobotsTxt, deployGeoFiles } from './indexer/geo-deploy.js';
import { getOverview, getSiteDetail, getAlerts, ackAlert, alertInWorkspace, snapshotAllSites, recordAlert } from './analytics/stats.js';
import { getCommandCenter } from './analytics/command-center.js';
import { auditSiteLlms } from './indexer/llms-audit.js';
import { snapshotSiteAgentReadiness, getAgentReadinessHistory } from './analytics/agent-readiness-store.js';
import { generateLlmsTxt, llmsGenerationProvider } from './ai/generate-llms.js';
import { probeModels, MODEL_PROVIDERS } from './ai/models.js';
import { getBingQuota, submitToBingInBatches, deriveBingSiteUrl } from './indexer/bing.js';
import { getGooglePerformance, getBingPerformance, getBingCrawlIssues, getGoogleDimension } from './indexer/performance.js';
import { snapshotSitePerformance, getWowDeltas, getQueryTrend, getTrackableQueries, listTrackedQueries, addTrackedQuery, removeTrackedQuery, getPortfolioMovers } from './analytics/perf-store.js';
import { checkSiteHygiene } from './indexer/hygiene.js';
import { listPrompts, addPrompt, updatePrompt, deletePrompt, getResults, runPrompt, runAllPrompts, configuredProviders, PROVIDERS, PROMPT_CATEGORIES, getAiInsights, getCitationIdentitySummary, getThread, replyInThread, getLegacyPromptPlan, upgradeLegacyPrompts, type Provider, type PromptCategory, type PromptRow, type LegacyPromptUpgrade } from './ai/citations.js';
import { fetchCrux, cruxConfigured } from './ai/crux.js';
import { logSystem } from './utils/logger.js';
import { provisionGeminiKey } from './ai/provision.js';
import {
  countUsers, getUserByEmail, createUser, verifyPassword, recordLogin,
  createSession, getSessionUser, getSessionContext, destroySession, setUserPassword,
  setTemporaryPassword, generateTemporaryPassword, updateUserProfile,
  generateTotpSecret, totpUri, verifyTotp, setTotpSecret, getTotpSecret, enableTotp, disableTotp,
  toPublic, pruneExpiredSessions, listUsers, getUserById,
  countSuperAdmins, setUserSuperAdmin, deleteUser, setUserDisabled,
  createPasswordReset, consumePasswordReset, recordAuditEvent, listAuditEvents, type User,
} from './auth/users.js';
import { emailConfigured, sendEmail } from './utils/email.js';
import { sendTestNotification, configuredChannels, listNotificationDeliveries, NOTIFY_KEYS } from './utils/notify.js';
import {
  createWorkspace, getWorkspace, renameWorkspace, deleteWorkspace, accessibleWorkspaces,
  canAccessWorkspace, canManageWorkspace, canAccessSiteInWorkspace, bootstrapUserWorkspace,
  listWorkspaceMembers, addWorkspaceMember, removeWorkspaceMember, reassignOwnedWorkspaces,
  addBingAccount, addBingOAuthAccount, bingCredentialForSite, listBingAccounts, removeBingAccount, bingAccountWorkspace,
  createBingOAuthState, consumeBingOAuthState,
  workspaceRole, canUseAiCitations, updateWorkspaceMember, hasCapability, type Capability,
  listAllWorkspacesSummary, reassignWorkspaceOwner,
  listUserWorkspaceAccess,
  createWorkspaceInvite, listWorkspaceInvites, revokeWorkspaceInvite, getInviteByToken, markInviteAccepted,
} from './auth/workspaces.js';
import {
  beginRegistration, finishRegistration, beginAuthentication, finishAuthentication,
  listPasskeys, deletePasskey,
} from './auth/passkeys.js';
import { ssoProviders, ssoAuthorizeUrl, ssoHandleCallback } from './auth/sso.js';
import { backupNow, listBackups, startBackupScheduler } from './utils/backup.js';
import { registerPlatformRoutes } from './platform/routes.js';
import { addAnnotation } from './platform/store.js';
import { safeFetch, validateOutboundUrl } from './security/outbound-url.js';
import { listSiteFileSnapshots, recordSiteFileSnapshot } from './db/site-files.js';
import { createSiteSchema, runAllPromptsSchema, updateSiteSchema } from './http/schemas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.join(__dirname, '../frontend/dist');
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const TRUST_PROXY = ['1', 'true', 'yes', 'on'].includes((process.env.TRUST_PROXY ?? '').toLowerCase());
const PUBLIC_URL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL) : null;

// ── Fastify Setup ─────────────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV !== 'production';
const app = Fastify({
  trustProxy: TRUST_PROXY,
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

// Fastify 5 rejects an empty body sent with `Content-Type: application/json`
// (FST_ERR_CTP_EMPTY_JSON_BODY -> 400); Fastify 4 tolerated it. Clients (and our
// UI's fetch wrapper) send that header even on bodyless requests like DELETE, so
// restore the old behaviour: treat an empty JSON body as `undefined`.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const text = body as string;
  if (text == null || text.trim() === '') {
    done(null, undefined);
    return;
  }
  try {
    done(null, JSON.parse(text));
  } catch (err) {
    (err as Error & { statusCode?: number }).statusCode = 400;
    done(err as Error, undefined);
  }
});

await app.register(fastifyCors, {
  // Same-origin is the secure default. Split-host deployments must opt in to
  // an explicit list instead of reflecting arbitrary requesting origins.
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map(value => value.trim()).filter(Boolean) : false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
});

await app.register(fastifyRateLimit, {
  max: parseInt(process.env.RATE_LIMIT_MAX ?? '300', 10),
  timeWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
  // SSE stream is exempt — long-lived connection
  allowList: (req) => req.url.startsWith('/api/logs/stream') || req.url === '/health' || req.url === '/api/healthz' || req.url === '/api/livez',
});

// Tighter per-route budget for credential-checking endpoints (brute-force
// defence): a handful of attempts per minute per IP, far below the global cap.
// Applied via each route's `config.rateLimit`.
const AUTH_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: parseInt(process.env.AUTH_RATE_LIMIT_MAX ?? '10', 10),
      timeWindow: process.env.AUTH_RATE_LIMIT_WINDOW ?? '1 minute',
    },
  },
};

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
  // Public automation endpoints authenticate with a scoped bearer token and
  // are intentionally callable by CI, n8n/Zapier and log shippers.
  if (req.url.startsWith('/api/v1/')) return;
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

// ── Authentication gate ───────────────────────────────────────────────────────
// Every /api route requires a valid session, except the auth handshake, health
// probes, the OAuth callback (Google redirects there with no session) and the
// IndexNow key file (served for search engines, non-/api). Until the first
// admin exists the app is "un-bootstrapped": only the auth/health routes work,
// so the UI can drive first-run signup.
const AUTH_OPEN_PATHS = new Set<string>([
  '/api/auth/login', '/api/auth/signup', '/api/auth/bootstrap-status', '/api/auth/logout',
  '/api/auth/google/callback', '/health', '/api/livez', '/api/healthz',
  '/api/auth/bing/callback',
  '/api/auth/passkeys/login/start', '/api/auth/passkeys/login/finish', '/api/auth/sso/providers',
  '/api/auth/forgot-password', '/api/auth/reset-password',
]);
// Pre-auth path prefixes (dynamic segments) — e.g. the SSO provider redirect
// and callback which the identity provider hits with no session, and the
// workspace-invite accept flow (the invitee has no account/session yet).
const AUTH_OPEN_PREFIXES = ['/api/auth/sso/', '/api/invites/', '/api/v1/'];
function sessionTokenFromReq(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers['cookie'];
  if (typeof raw !== 'string') return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'sid') return decodeURIComponent(v.join('='));
  }
  return undefined;
}
app.addHook('preHandler', async (req, reply) => {
  const pathOnly = req.url.split('?')[0];
  if (!pathOnly.startsWith('/api/')) return;            // static assets + key files
  if (AUTH_OPEN_PATHS.has(pathOnly)) return;
  if (AUTH_OPEN_PREFIXES.some(p => pathOnly.startsWith(p))) return;
  const session = getSessionContext(sessionTokenFromReq(req));
  const user = session?.user;
  if (!user) {
    return reply.status(401).send({ error: 'Not authenticated', needsBootstrap: countUsers() === 0 });
  }
  // A super-admin-disabled account loses access everywhere, immediately —
  // even mid-session (setUserDisabled also clears sessions, this just covers
  // any request racing that cleanup).
  if (user.disabled) {
    return reply.status(403).send({ error: 'This account has been disabled.' });
  }
  if (user.must_change_password && !session?.impersonator
    && !['/api/auth/me', '/api/auth/set-required-password', '/api/auth/logout'].includes(pathOnly)) {
    return reply.status(428).send({ error: 'Replace the temporary password before continuing.', passwordChangeRequired: true });
  }
  // Resolve the active workspace from the X-Workspace-Id header (the UI's
  // workspace switcher sets it), validating access; fall back to the user's
  // first accessible workspace. This is the tenant scope for the request.
  const wsHeader = req.headers['x-workspace-id'];
  const accessible = accessibleWorkspaces(user);
  let activeWs: string | null = null;
  if (typeof wsHeader === 'string' && accessible.some(w => w.id === wsHeader)) activeWs = wsHeader;
  else if (accessible.length > 0) activeWs = accessible[0].id;
  (req as unknown as RequestCtx).ctx = { user, impersonator: session?.impersonator ?? null, workspaceId: activeWs };
});

interface RequestCtx { ctx: { user: User; impersonator: User | null; workspaceId: string | null } }

// Centralised tenant authorization: extract a site id from the known
// site-scoped URL shapes and 404 if the caller can't access that site's
// workspace. Covers /api/sites/:id(/*), /api/analytics/site/:id,
// /api/performance/:siteId/*, /api/crux/:siteId/*, /api/bing/*/:siteId,
// /api/submit/:siteId. (The literal-first-segment routes like
// /api/performance/tracked-queries/:id are not site ids and are skipped.)
function siteIdFromPath(path: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/api\/sites\/([^/]+)/))) return decodeURIComponent(m[1]);
  if ((m = path.match(/^\/api\/analytics\/site\/([^/]+)/))) return decodeURIComponent(m[1]);
  if ((m = path.match(/^\/api\/crux\/([^/]+)\//))) return decodeURIComponent(m[1]);
  if ((m = path.match(/^\/api\/bing\/(?:quota|submit)\/([^/]+)/))) return decodeURIComponent(m[1]);
  if ((m = path.match(/^\/api\/submit\/([^/]+)/))) return decodeURIComponent(m[1]);
  if ((m = path.match(/^\/api\/performance\/([^/]+)/))) {
    if (m[1] === 'tracked-queries') return null; // that segment is a row id, not a site
    return decodeURIComponent(m[1]);
  }
  return null;
}
app.addHook('preHandler', async (req, reply) => {
  const pathOnly = req.url.split('?')[0];
  if (!pathOnly.startsWith('/api/') || AUTH_OPEN_PATHS.has(pathOnly)) return;
  const ctx = (req as unknown as Partial<RequestCtx>).ctx;
  if (!ctx) return; // unauthenticated request already rejected by the gate above
  const siteId = siteIdFromPath(pathOnly);
  // Scoped to the ACTIVE workspace, not just "any workspace this user can
  // access" — otherwise a multi-workspace user (or a super-admin) who
  // switches the active workspace while a stale site id is still in the UI
  // (e.g. an open Analytics page) keeps seeing the previous tenant's data.
  if (siteId && !canAccessSiteInWorkspace(ctx.user, siteId, ctx.workspaceId)) {
    return reply.status(404).send({ error: 'Site not found' });
  }
});

// Self-account actions are always allowed regardless of workspace role — a
// viewer/editor must still be able to change their own password, 2FA or
// passkeys. Everything else under /api/auth/* (Google account connect/
// disconnect, credentials, etc.) is workspace integration management.
const SELF_ACCOUNT_EXEMPT_EXACT = new Set<string>([
  '/api/auth/logout', '/api/auth/change-password',
  '/api/auth/set-required-password', '/api/auth/impersonation/stop',
  '/api/auth/totp/setup', '/api/auth/totp/enable', '/api/auth/totp/disable',
]);
const SELF_ACCOUNT_EXEMPT_PREFIXES = ['/api/auth/passkeys/'];
const WORKSPACE_GATE_EXEMPT_EXACT = new Set<string>(['/api/workspaces']);

// Maps a mutating request's path to the workspace capability it requires (for
// 'editor' members only — owners/admins/super-admins always pass, viewers
// never do). Any unmapped mutation is denied for editors, so newly added API
// routes fail closed until their required capability is declared here.
function capabilityForPath(path: string): Capability | null {
  if (path.startsWith('/api/sites') || path.startsWith('/api/submit/') || path.startsWith('/api/runs')
    || path.startsWith('/api/performance/') || path.startsWith('/api/crux/')
    || path.startsWith('/api/bing/quota/') || path.startsWith('/api/bing/submit/')
    || path.startsWith('/api/url-failures') || path.startsWith('/api/alerts')
    || path.startsWith('/api/analytics/')) {
    return 'manage_sites';
  }
  if (path.startsWith('/api/auth/accounts') || path.startsWith('/api/auth/clear') || path.startsWith('/api/auth/save-credentials')
    || path.startsWith('/api/auth/google/start') || path.startsWith('/api/auth/bing/start')
    || path.startsWith('/api/bing/accounts') || path === '/api/workspace/keys'
    || path === '/api/ai/models' || path.startsWith('/api/ai/provision/')) {
    return 'manage_integrations';
  }
  if (path.startsWith('/api/notifications')) return 'manage_notifications';
  if (path.startsWith('/api/platform/integrations') || path.startsWith('/api/platform/automation')) return 'manage_integrations';
  if (path.startsWith('/api/platform/work-items') || path.startsWith('/api/platform/content') || path.startsWith('/api/platform/annotations') || path.startsWith('/api/platform/entities')) return 'manage_content';
  if (path.startsWith('/api/platform/reports') || path.startsWith('/api/platform/views')
    || path.startsWith('/api/platform/digest')) return 'manage_reports';
  if (path.startsWith('/api/platform/budgets') || path.startsWith('/api/platform/webhooks') || path.startsWith('/api/platform/tokens') || path.startsWith('/api/platform/governance')) return 'manage_governance';
  return null;
}

// A workspace 'viewer' has read-only access; an 'editor' is further gated by
// their individual capabilities (manage_sites/manage_integrations/
// manage_notifications). Owners, workspace admins and super-admins always pass.
app.addHook('preHandler', async (req, reply) => {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const pathOnly = req.url.split('?')[0];
  if (!pathOnly.startsWith('/api/')) return;
  const ctx = (req as unknown as Partial<RequestCtx>).ctx;
  if (!ctx || !ctx.workspaceId) return;
  if (WORKSPACE_GATE_EXEMPT_EXACT.has(pathOnly)) return;
  if (SELF_ACCOUNT_EXEMPT_EXACT.has(pathOnly) || SELF_ACCOUNT_EXEMPT_PREFIXES.some(p => pathOnly.startsWith(p))) return;
  const policy = getWorkspaceSettings(ctx.workspaceId);
  if (policy.workspace_mfa_required === 'true' && !ctx.user.totp_enabled && listPasskeys(ctx.user.id).length === 0) {
    return reply.status(428).send({
      error: 'This workspace requires MFA. Enroll an authenticator or passkey in Settings before making changes.',
      mfaEnrollmentRequired: true,
    });
  }
  if (ctx.user.is_super_admin) return;
  const role = workspaceRole(ctx.user, ctx.workspaceId);
  if (role === 'viewer' || role === null) {
    return reply.status(403).send({ error: 'Read-only access — ask a workspace admin for edit permissions.' });
  }
  const isAiOperation = pathOnly.startsWith('/api/ai/prompts') || pathOnly.startsWith('/api/ai/run') || pathOnly === '/api/ai/config' || pathOnly === '/api/ai/migration';
  if (isAiOperation && !canUseAiCitations(ctx.user, ctx.workspaceId)) {
    return reply.status(403).send({ error: 'AI Citations access is disabled for your account in this workspace. Ask a workspace admin.' });
  }
  if (role === 'owner' || role === 'admin') return;
  // role === 'editor': gate by their individual capabilities, if this path needs one.
  const cap = capabilityForPath(pathOnly);
  if (cap && !hasCapability(ctx.user, ctx.workspaceId, cap)) {
    return reply.status(403).send({ error: `You don't have "${cap.replace('_', ' ')}" permission in this workspace — ask a workspace admin.` });
  }
  if (!cap && !isAiOperation) {
    return reply.status(403).send({ error: 'This operation is not available to workspace editors.' });
  }
});

// Cookie helpers — HttpOnly session cookie, Secure behind https/proxy.
function requestOrigin(req: { protocol?: string; headers: Record<string, unknown> }): string {
  if (PUBLIC_URL) return PUBLIC_URL.origin;
  const protocol = req.protocol === 'https' ? 'https' : 'http';
  const host = String(req.headers.host ?? 'localhost');
  return `${protocol}://${host}`;
}
function setSessionCookie(req: { protocol?: string; headers: Record<string, unknown> }, reply: { header: (k: string, v: string) => void }, token: string) {
  const secure = requestOrigin(req).startsWith('https://');
  reply.header('Set-Cookie',
    `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
}
function clearSessionCookie(reply: { header: (k: string, v: string) => void }) {
  reply.header('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}
// WebAuthn relying-party id (the registrable domain, no port) + origin, derived
// from the request so one build works on localhost and any deployed host.
function rpInfo(req: { protocol?: string; headers: Record<string, unknown> }): { rpID: string; origin: string } {
  const origin = requestOrigin(req);
  return { rpID: new URL(origin).hostname, origin };
}
function currentUser(req: unknown): User { return (req as RequestCtx).ctx.user; }
function currentWorkspace(req: unknown): string | null { return (req as RequestCtx).ctx.workspaceId; }
// Mutations execute with the target user's workspace permissions while
// impersonating, but the security trail must identify the real administrator.
function auditActor(req: unknown): User {
  const ctx = (req as RequestCtx).ctx;
  return ctx.impersonator ?? ctx.user;
}
function requestIp(req: { ip?: string; headers: Record<string, unknown> }): string | null {
  // Fastify only incorporates forwarded addresses when TRUST_PROXY is enabled.
  return req.ip ?? null;
}
function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
// Guards — throw a 403-shaped error the handlers turn into a reply.
function requireWorkspace(req: unknown): string {
  const ws = currentWorkspace(req);
  if (!ws) throw Object.assign(new Error('No workspace selected. Create one first.'), { statusCode: 400 });
  return ws;
}
function assertSiteAccess(req: unknown, siteId: string): void {
  if (!canAccessSiteInWorkspace(currentUser(req), siteId, currentWorkspace(req))) {
    throw Object.assign(new Error('Site not found'), { statusCode: 404 });
  }
}

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
    return {
      ok: true,
      ts: new Date().toISOString(),
      // Global liveness: is ANY workspace running? (locks are per-workspace now.)
      scheduler: { running: isRunning(), currentRunId: getCurrentRunId() },
      sites: getAllSites().length,
      accounts: getAllGoogleAccounts().length,
    };
  } catch (e) {
    reply.status(503).send({ ok: false, error: String(e) });
  }
});

// ── Status ────────────────────────────────────────────────────────────────────

app.get('/api/status', async (req) => {
  // Everything is tenant-scoped: a user sees THEIR active workspace's run state,
  // auth status and totals, not the whole install's. A run (or Google account)
  // in another workspace is invisible.
  const ws = currentWorkspace(req);
  const auth = await getAuthStatus(ws);
  const cronSchedule = getSetting('cron_schedule') ?? '0 3 * * *';
  const lock = ws ? getRunLock(ws) : null;
  return {
    auth,
    scheduler: {
      running: isRunning(ws),
      currentRunId: getCurrentRunId(ws),
      cronSchedule,
      lock: lock ? { runId: lock.runId, acquiredAt: lock.acquiredAt } : null,
    },
    sites: ws ? getSitesForWorkspace(ws).length : 0,
    accounts: ws ? getGoogleAccountsForWorkspace(ws).length : 0,
    version: process.env.APP_VERSION ?? 'dev',
  };
});

// ── App authentication (users, sessions, 2FA) ─────────────────────────────────

app.get('/api/auth/bootstrap-status', async () => ({ needsBootstrap: countUsers() === 0, emailEnabled: emailConfigured() }));

app.get('/api/auth/me', async (req, reply) => {
  const token = sessionTokenFromReq(req);
  const session = getSessionContext(token);
  if (!session) return reply.status(401).send({ error: 'Not authenticated', needsBootstrap: countUsers() === 0 });
  return {
    ...toPublic(session.user),
    // An administrator should not be trapped in the target user's forced
    // password-change screen while diagnosing their account.
    must_change_password: session.impersonator ? false : !!session.user.must_change_password,
    impersonation: session.impersonator ? { actor: toPublic(session.impersonator) } : null,
  };
});

// First-run only: create the super-admin. Refuses once any user exists.
app.post('/api/auth/signup', AUTH_RATE_LIMIT, async (req, reply) => {
  if (countUsers() > 0) return reply.status(403).send({ error: 'Signup is closed — an admin already exists. Ask an admin to add you.' });
  const { email, password, name } = (req.body ?? {}) as { email?: string; password?: string; name?: string };
  if (!email?.includes('@') || !password || password.length < 8) {
    return reply.status(400).send({ error: 'A valid email and a password of at least 8 characters are required.' });
  }
  const user = createUser({ email, password, name, role: 'admin', superAdmin: true });
  bootstrapUserWorkspace(user, true); // first user: also claims any pre-existing single-tenant data
  recordLogin(user.id);
  setSessionCookie(req, reply, createSession(user.id, String(req.headers['user-agent'] ?? '')));
  logSystem('ok', `First admin account created: ${user.email}`);
  return toPublic(user);
});

app.post('/api/auth/login', AUTH_RATE_LIMIT, async (req, reply) => {
  const { email, password, totp } = (req.body ?? {}) as { email?: string; password?: string; totp?: string };
  const user = email ? getUserByEmail(email) : undefined;
  // Uniform failure to avoid leaking which emails exist.
  if (!user || !password || !verifyPassword(user, password)) {
    return reply.status(401).send({ error: 'Incorrect email or password.' });
  }
  if (user.disabled) {
    return reply.status(403).send({ error: 'This account has been disabled. Contact your workspace admin.' });
  }
  if (user.totp_enabled) {
    if (!totp) return reply.status(401).send({ error: 'Two-factor code required.', totpRequired: true });
    const secret = getTotpSecret(user);
    if (!secret || !verifyTotp(secret, totp)) {
      return reply.status(401).send({ error: 'Incorrect two-factor code.', totpRequired: true });
    }
  }
  recordLogin(user.id);
  setSessionCookie(req, reply, createSession(user.id, String(req.headers['user-agent'] ?? '')));
  return toPublic(user);
});

app.post('/api/auth/logout', async (req, reply) => {
  const token = sessionTokenFromReq(req);
  if (token) destroySession(token);
  clearSessionCookie(reply);
  return { ok: true };
});

app.post('/api/auth/change-password', async (req, reply) => {
  const user = currentUser(req);
  const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !verifyPassword(user, currentPassword)) {
    return reply.status(400).send({ error: 'Current password is incorrect.' });
  }
  if (!newPassword || newPassword.length < 8) return reply.status(400).send({ error: 'New password must be at least 8 characters.' });
  setUserPassword(user.id, newPassword);
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: user.id, action: 'user.password.changed', ipAddress: requestIp(req) });
  return { ok: true };
});

// A temporary password minted by a super-admin must be replaced immediately
// after login. The authenticated session is proof of possession of that
// temporary secret, so asking for it again adds no protection.
app.post('/api/auth/set-required-password', async (req, reply) => {
  const user = currentUser(req);
  if (!user.must_change_password) return reply.status(400).send({ error: 'No password change is required.' });
  const { newPassword } = (req.body ?? {}) as { newPassword?: string };
  if (!newPassword || newPassword.length < 8) return reply.status(400).send({ error: 'New password must be at least 8 characters.' });
  setUserPassword(user.id, newPassword);
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: user.id, action: 'user.temporary_password.replaced', ipAddress: requestIp(req) });
  return { ok: true };
});

app.post('/api/auth/impersonation/stop', async (req, reply) => {
  const token = sessionTokenFromReq(req);
  const session = getSessionContext(token);
  const actor = session?.impersonator;
  if (!session || !actor?.is_super_admin || actor.disabled) {
    return reply.status(400).send({ error: 'This is not an active impersonation session.' });
  }
  if (token) destroySession(token);
  const next = createSession(actor.id, String(req.headers['user-agent'] ?? ''));
  setSessionCookie(req, reply, next);
  recordAuditEvent({ actorUserId: actor.id, targetUserId: session.user.id, action: 'user.impersonation.stopped', ipAddress: requestIp(req) });
  return toPublic(actor);
});

// ── Forgot / reset password (email link) ─────────────────────────────────────
// Both OPEN + rate-limited. forgot-password always returns a generic success so
// it never reveals which emails have accounts.
app.post('/api/auth/forgot-password', AUTH_RATE_LIMIT, async (req) => {
  const { email } = (req.body ?? {}) as { email?: string };
  const generic = { ok: true, message: 'If that email has an account and email is configured, a reset link is on its way.' };
  if (!email || !emailConfigured()) return generic;
  const user = getUserByEmail(email.trim().toLowerCase());
  if (!user) return generic;
  const token = createPasswordReset(user.id);
  const { origin } = rpInfo(req);
  const link = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await sendEmail({
      to: user.email,
      subject: 'Reset your SEO Website Indexer password',
      text: `Someone requested a password reset for your account.\n\nReset it here (valid for 1 hour):\n${link}\n\nIf this wasn't you, you can ignore this email — your password is unchanged.`,
      html: `<p>Someone requested a password reset for your account.</p>`
        + `<p><a href="${link}">Reset your password</a> (valid for 1 hour).</p>`
        + `<p style="color:#888;font-size:13px">If this wasn't you, ignore this email — your password is unchanged.</p>`,
    });
  } catch (e) {
    logSystem('warn', `Password-reset email failed for ${user.email}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return generic;
});

app.post('/api/auth/reset-password', AUTH_RATE_LIMIT, async (req, reply) => {
  const { token, password } = (req.body ?? {}) as { token?: string; password?: string };
  if (!token) return reply.status(400).send({ error: 'Missing reset token.' });
  if (!password || password.length < 8) return reply.status(400).send({ error: 'New password must be at least 8 characters.' });
  const userId = consumePasswordReset(token, password);
  if (!userId) return reply.status(400).send({ error: 'This reset link is invalid or has expired. Request a new one.' });
  return { ok: true };
});

// TOTP enrolment: setup → returns secret + otpauth URI (stored, not yet enabled);
// enable → verifies a code and turns it on; disable → requires the password.
app.post('/api/auth/totp/setup', async (req) => {
  const user = currentUser(req);
  const secret = generateTotpSecret();
  setTotpSecret(user.id, secret);
  const uri = totpUri(secret, user.email);
  // A scannable QR (PNG data URL) of the otpauth URI, so the user can point
  // their authenticator app at it instead of typing the secret.
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return { secret, uri, qr };
});
app.post('/api/auth/totp/enable', async (req, reply) => {
  const user = currentUser(req);
  const { totp } = (req.body ?? {}) as { totp?: string };
  const secret = getTotpSecret(user);
  if (!secret) return reply.status(400).send({ error: 'Run TOTP setup first.' });
  if (!totp || !verifyTotp(secret, totp)) return reply.status(400).send({ error: 'That code is not valid — check your authenticator and try again.' });
  enableTotp(user.id);
  return { ok: true };
});
app.post('/api/auth/totp/disable', async (req, reply) => {
  const user = currentUser(req);
  const { password } = (req.body ?? {}) as { password?: string };
  if (!password || !verifyPassword(user, password)) return reply.status(400).send({ error: 'Password is incorrect.' });
  disableTotp(user.id);
  return { ok: true };
});

// ── Passkeys (WebAuthn) ──────────────────────────────────────────────────────

app.get('/api/auth/passkeys', async (req) => listPasskeys(currentUser(req).id));

app.delete('/api/auth/passkeys/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!deletePasskey(currentUser(req).id, id)) return reply.status(404).send({ error: 'Passkey not found' });
  return { ok: true };
});

app.post('/api/auth/passkeys/register/start', async (req) => {
  const { rpID } = rpInfo(req);
  return beginRegistration(currentUser(req), rpID);
});

app.post('/api/auth/passkeys/register/finish', async (req, reply) => {
  const { rpID, origin } = rpInfo(req);
  const { name, challengeId, credential } = (req.body ?? {}) as { name?: string; challengeId?: string; credential?: unknown };
  // Backwards-compat: the browser may bundle challengeId into the credential wrapper.
  const chId = challengeId ?? (credential as { challengeId?: string })?.challengeId;
  if (!chId || !credential) return reply.status(400).send({ error: 'Missing registration data.' });
  try {
    const ok = await finishRegistration(currentUser(req), chId, name, credential as never, rpID, origin);
    if (!ok) return reply.status(400).send({ error: 'Passkey could not be verified.' });
    return { ok: true };
  } catch (e) {
    return reply.status(400).send({ error: e instanceof Error ? e.message : 'Registration failed.' });
  }
});

// Login start/finish are OPEN (pre-authentication) — rate-limited to blunt
// credential stuffing / assertion-guessing.
app.post('/api/auth/passkeys/login/start', AUTH_RATE_LIMIT, async (req) => {
  const { rpID } = rpInfo(req);
  const { email } = (req.body ?? {}) as { email?: string };
  return beginAuthentication(rpID, email?.trim().toLowerCase() || undefined);
});

app.post('/api/auth/passkeys/login/finish', AUTH_RATE_LIMIT, async (req, reply) => {
  const { rpID, origin } = rpInfo(req);
  const { challengeId, credential } = (req.body ?? {}) as { challengeId?: string; credential?: unknown };
  if (!challengeId || !credential) return reply.status(400).send({ error: 'Missing login data.' });
  try {
    const user = await finishAuthentication(challengeId, credential as never, rpID, origin);
    if (!user) return reply.status(401).send({ error: 'Passkey not recognised.' });
    if (user.disabled) return reply.status(403).send({ error: 'This account has been disabled.' });
    recordLogin(user.id);
    setSessionCookie(req, reply, createSession(user.id, String(req.headers['user-agent'] ?? '')));
    return toPublic(user);
  } catch (e) {
    return reply.status(401).send({ error: e instanceof Error ? e.message : 'Login failed.' });
  }
});

// ── SSO / OIDC (optional, env-configured) ────────────────────────────────────

app.get('/api/auth/sso/providers', async () => ssoProviders());

// Redirects the browser to the identity provider.
app.get('/api/auth/sso/:provider/start', async (req, reply) => {
  const { provider } = req.params as { provider: string };
  const { origin } = rpInfo(req);
  const url = ssoAuthorizeUrl(provider, `${origin}/api/auth/sso/${provider}/callback`);
  if (!url) return reply.status(404).send({ error: 'Unknown or unconfigured SSO provider.' });
  return reply.redirect(url);
});

app.get('/api/auth/sso/:provider/callback', async (req, reply) => {
  const { provider } = req.params as { provider: string };
  const { code, state } = req.query as { code?: string; state?: string };
  const { origin } = rpInfo(req);
  if (!code) return reply.status(400).send({ error: 'Missing authorization code.' });
  try {
    const user = await ssoHandleCallback(provider, code, state, `${origin}/api/auth/sso/${provider}/callback`);
    if (!user) return reply.redirect('/?sso_error=1');
    recordLogin(user.id);
    setSessionCookie(req, reply, createSession(user.id, String(req.headers['user-agent'] ?? '')));
    return reply.redirect('/');
  } catch {
    return reply.redirect('/?sso_error=1');
  }
});

// ── Workspaces (the tenant / "client base") ──────────────────────────────────

// List workspaces the caller can access, flagging the active one and ownership.
app.get('/api/workspaces', async (req) => {
  const user = currentUser(req);
  const active = currentWorkspace(req);
  return accessibleWorkspaces(user).map(w => ({
    id: w.id,
    name: w.name,
    created_at: w.created_at,
    is_owner: w.owner_user_id === user.id,
    is_active: w.id === active,
    role: w.owner_user_id === user.id ? 'owner' : (user.is_super_admin ? 'admin' : workspaceRole(user, w.id)),
    can_manage: canManageWorkspace(user, w.id),
    permissions: {
      manage_sites: hasCapability(user, w.id, 'manage_sites'),
      manage_integrations: hasCapability(user, w.id, 'manage_integrations'),
      manage_notifications: hasCapability(user, w.id, 'manage_notifications'),
      manage_content: hasCapability(user, w.id, 'manage_content'),
      manage_reports: hasCapability(user, w.id, 'manage_reports'),
      manage_governance: hasCapability(user, w.id, 'manage_governance'),
    },
  }));
});

app.post('/api/workspaces', async (req, reply) => {
  const { name } = (req.body ?? {}) as { name?: string };
  if (!name?.trim()) return reply.status(400).send({ error: 'name is required.' });
  const ws = createWorkspace(name, currentUser(req).id);
  recordAuditEvent({ actorUserId: auditActor(req).id, workspaceId: ws.id, action: 'workspace.created', ipAddress: requestIp(req) });
  return { id: ws.id, name: ws.name, created_at: ws.created_at, is_owner: true };
});

app.patch('/api/workspaces/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!canManageWorkspace(currentUser(req), id)) return reply.status(404).send({ error: 'Workspace not found' });
  const { name } = (req.body ?? {}) as { name?: string };
  if (!name?.trim()) return reply.status(400).send({ error: 'name is required.' });
  renameWorkspace(id, name);
  recordAuditEvent({ actorUserId: auditActor(req).id, workspaceId: id, action: 'workspace.renamed', detail: { name: name.trim() }, ipAddress: requestIp(req) });
  return { ok: true };
});

app.delete('/api/workspaces/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const user = currentUser(req);
  if (!canManageWorkspace(user, id)) return reply.status(404).send({ error: 'Workspace not found' });
  // Refuse to delete someone's last workspace — they'd be left with nowhere to work.
  if (accessibleWorkspaces(user).length <= 1) {
    return reply.status(400).send({ error: 'You cannot delete your only workspace.' });
  }
  recordAuditEvent({ actorUserId: auditActor(req).id, workspaceId: id, action: 'workspace.deleted', ipAddress: requestIp(req) });
  deleteWorkspace(id);
  return { ok: true };
});

// Members of a workspace (owner + explicit members).
app.get('/api/workspaces/:id/members', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!canAccessWorkspace(currentUser(req), id)) return reply.status(404).send({ error: 'Workspace not found' });
  return listWorkspaceMembers(id);
});

app.post('/api/workspaces/:id/members', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!canManageWorkspace(currentUser(req), id)) return reply.status(404).send({ error: 'Workspace not found' });
  const { email, role, ai_citations } = (req.body ?? {}) as { email?: string; role?: string; ai_citations?: boolean };
  if (!email?.trim()) return reply.status(400).send({ error: 'email is required.' });
  const target = getUserByEmail(email.trim().toLowerCase());
  if (!target) return reply.status(404).send({ error: 'No user with that email. Invite them instead.' });
  const normRole: 'admin' | 'editor' | 'viewer' = role === 'admin' || role === 'viewer' ? role : 'editor';
  addWorkspaceMember(id, target.id, normRole, ai_citations !== false);
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: target.id, workspaceId: id,
    action: 'workspace.member.added', detail: { role: normRole }, ipAddress: requestIp(req) });
  return { ok: true };
});

app.delete('/api/workspaces/:id/members/:userId', async (req, reply) => {
  const { id, userId } = req.params as { id: string; userId: string };
  if (!canManageWorkspace(currentUser(req), id)) return reply.status(404).send({ error: 'Workspace not found' });
  const ws = getWorkspace(id);
  if (ws && ws.owner_user_id === userId) return reply.status(400).send({ error: 'The owner cannot be removed.' });
  removeWorkspaceMember(id, userId);
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: userId, workspaceId: id,
    action: 'workspace.member.removed', ipAddress: requestIp(req) });
  return { ok: true };
});

// ── User management (super-admin) ────────────────────────────────────────────

function requireSuperAdmin(req: unknown, reply: { status: (c: number) => { send: (b: unknown) => unknown } }): boolean {
  if (!currentUser(req).is_super_admin) { reply.status(403).send({ error: 'Super-admin only.' }); return false; }
  return true;
}

app.get('/api/users', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  return listUsers();
});

app.post('/api/users', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  const { email, password, name, role, superAdmin, workspaceId, workspaceRole: wRole, aiCitations } = (req.body ?? {}) as
    { email?: string; password?: string; name?: string; role?: string; superAdmin?: boolean; workspaceId?: string; workspaceRole?: string; aiCitations?: boolean };
  if (!email?.trim() || !password) return reply.status(400).send({ error: 'email and password are required.' });
  if (getUserByEmail(email.trim().toLowerCase())) return reply.status(409).send({ error: 'A user with that email already exists.' });
  if (workspaceId && !getWorkspace(workspaceId)) return reply.status(400).send({ error: 'That workspace does not exist.' });
  if (password.length < 8) return reply.status(400).send({ error: 'Password must be at least 8 characters.' });
  const user = createUser({ email: email.trim().toLowerCase(), password, name, role: role ?? 'user', superAdmin: !!superAdmin, mustChangePassword: true });
  if (workspaceId) {
    // Add them to the ONE workspace the admin picked — no separate workspace.
    const normRole: 'admin' | 'editor' | 'viewer' = wRole === 'admin' || wRole === 'viewer' ? wRole : 'editor';
    addWorkspaceMember(workspaceId, user.id, normRole, aiCitations !== false);
  } else {
    // No target workspace chosen — give them their own default one so they
    // can start immediately (the original single-tenant "new client" flow).
    bootstrapUserWorkspace(user, false);
  }
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: user.id, workspaceId: workspaceId ?? null,
    action: 'user.created', detail: { superAdmin: !!superAdmin }, ipAddress: requestIp(req) });
  return toPublic(user);
});

app.get('/api/admin/users/:id', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  const target = getUserById(id);
  if (!target) return reply.status(404).send({ error: 'User not found' });
  return {
    user: toPublic(target),
    workspaces: listUserWorkspaceAccess(id),
    google_accounts: getGoogleAccountsForOwner(id).map(a => ({
      id: a.id, email: a.email, needs_reauth: !!a.needs_reauth,
      workspace_ids: googleAccountWorkspaceIds(a.id), created_at: a.created_at,
    })),
    audit: listAuditEvents(30, id),
  };
});

app.patch('/api/users/:id', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  const target = getUserById(id);
  if (!target) return reply.status(404).send({ error: 'User not found' });
  const { password, superAdmin, disabled, email, name, role } = (req.body ?? {}) as
    { password?: string; superAdmin?: boolean; disabled?: boolean; email?: string; name?: string | null; role?: string };
  if (typeof password === 'string' && password && password.length < 8) return reply.status(400).send({ error: 'Password must be at least 8 characters.' });
  if (email !== undefined) {
    if (!email.includes('@')) return reply.status(400).send({ error: 'A valid email is required.' });
    const conflict = getUserByEmail(email);
    if (conflict && conflict.id !== id) return reply.status(409).send({ error: 'A user with that email already exists.' });
  }
  if (role !== undefined && !['user', 'admin'].includes(role)) return reply.status(400).send({ error: 'Invalid platform role.' });
  if (typeof superAdmin === 'boolean' && !superAdmin && target.is_super_admin && countSuperAdmins() <= 1) {
    return reply.status(400).send({ error: 'At least one super-admin must remain.' });
  }
  if (typeof disabled === 'boolean' && disabled) {
    if (id === currentUser(req).id) return reply.status(400).send({ error: 'You cannot disable yourself.' });
    if (target.is_super_admin && superAdmin !== false && countSuperAdmins() <= 1) {
      return reply.status(400).send({ error: 'At least one super-admin must remain.' });
    }
  }

  if (typeof password === 'string' && password) setTemporaryPassword(id, password);
  updateUserProfile(id, { email, name, role });
  if (typeof superAdmin === 'boolean') {
    setUserSuperAdmin(id, superAdmin);
  }
  if (typeof disabled === 'boolean') {
    setUserDisabled(id, disabled);
  }
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: id, action: 'user.updated',
    detail: { email: email !== undefined, name: name !== undefined, role, superAdmin, disabled, password: !!password }, ipAddress: requestIp(req) });
  return { ok: true };
});

app.post('/api/admin/users/:id/generate-password', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  const target = getUserById(id);
  if (!target) return reply.status(404).send({ error: 'User not found' });
  const temporaryPassword = generateTemporaryPassword();
  setTemporaryPassword(id, temporaryPassword);
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: id, action: 'user.temporary_password.generated', ipAddress: requestIp(req) });
  return { ok: true, temporaryPassword, mustChangePassword: true };
});

app.post('/api/admin/users/:id/send-password-reset', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  const target = getUserById(id);
  if (!target) return reply.status(404).send({ error: 'User not found' });
  const token = createPasswordReset(id);
  const { origin } = rpInfo(req);
  const link = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
  let emailed = false;
  if (emailConfigured()) {
    try {
      await sendEmail({
        to: target.email,
        subject: 'Reset your SEO Website Indexer password',
        text: `An administrator sent you a password-reset link.\n\nSet a new password here (valid for 1 hour):\n${link}`,
        html: `<p>An administrator sent you a password-reset link.</p><p><a href="${link}">Set a new password</a> (valid for 1 hour).</p>`,
      });
      emailed = true;
    } catch (e) {
      logSystem('warn', `Admin password-reset email failed for ${target.email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: id, action: 'user.password_reset.sent',
    detail: { emailed }, ipAddress: requestIp(req) });
  return { ok: true, emailed, resetPath: emailed ? undefined : `/reset-password?token=${encodeURIComponent(token)}` };
});

app.post('/api/admin/users/:id/clear-2fa', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  if (!getUserById(id)) return reply.status(404).send({ error: 'User not found' });
  disableTotp(id);
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: id, action: 'user.2fa.cleared', ipAddress: requestIp(req) });
  return { ok: true };
});

app.post('/api/admin/users/:id/impersonate', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  if ((req as unknown as RequestCtx).ctx.impersonator) {
    return reply.status(400).send({ error: 'Stop the current impersonation before starting another.' });
  }
  const actor = currentUser(req);
  const { id } = req.params as { id: string };
  if (id === actor.id) return reply.status(400).send({ error: 'You are already signed in as this user.' });
  const target = getUserById(id);
  if (!target) return reply.status(404).send({ error: 'User not found' });
  if (target.disabled) return reply.status(400).send({ error: 'Enable the user before impersonating them.' });
  const currentToken = sessionTokenFromReq(req);
  if (currentToken) destroySession(currentToken);
  setSessionCookie(req, reply, createSession(target.id, String(req.headers['user-agent'] ?? ''), actor.id));
  recordAuditEvent({ actorUserId: actor.id, targetUserId: id, action: 'user.impersonation.started', ipAddress: requestIp(req) });
  return { ...toPublic(target), impersonation: { actor: toPublic(actor) } };
});

app.get('/api/admin/audit-events', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  const limit = Math.min(Math.max(Number((req.query as { limit?: string }).limit ?? 100), 1), 500);
  return listAuditEvents(limit);
});

app.delete('/api/users/:id', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  if (id === currentUser(req).id) return reply.status(400).send({ error: 'You cannot delete yourself.' });
  const target = getUserById(id);
  if (!target) return reply.status(404).send({ error: 'User not found' });
  if (target.is_super_admin && countSuperAdmins() <= 1) {
    return reply.status(400).send({ error: 'At least one super-admin must remain.' });
  }
  // Hand the departing user's owned workspaces (and their sites/accounts) to the
  // acting admin so deletion never silently orphans a client's data. Their
  // sessions + memberships cascade away via the schema's ON DELETE CASCADE.
  const moved = reassignOwnedWorkspaces(id, currentUser(req).id);
  // Preserve workspace integrations when an account is removed: credential
  // ownership transfers to the acting super-admin, while explicit workspace
  // delegation remains unchanged.
  getDb().prepare('UPDATE google_accounts SET owner_user_id = ? WHERE owner_user_id = ?').run(currentUser(req).id, id);
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: id, action: 'user.deleted',
    detail: { reassignedWorkspaces: moved }, ipAddress: requestIp(req) });
  deleteUser(id);
  return { ok: true, reassignedWorkspaces: moved };
});

// ── Super-admin: manage every workspace in the install ───────────────────────

app.get('/api/admin/workspaces', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  return listAllWorkspacesSummary();
});

app.patch('/api/admin/workspaces/:id/owner', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  if (!getWorkspace(id)) return reply.status(404).send({ error: 'Workspace not found' });
  const { ownerUserId } = (req.body ?? {}) as { ownerUserId?: string };
  if (!ownerUserId || !getUserById(ownerUserId)) return reply.status(400).send({ error: 'A valid ownerUserId is required.' });
  reassignWorkspaceOwner(id, ownerUserId);
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: ownerUserId, workspaceId: id,
    action: 'workspace.owner.reassigned', ipAddress: requestIp(req) });
  return { ok: true };
});

// ── Workspace member administration ─────────────────────────────────────────
// Workspace owners/admins manage tenant membership and permissions. Password
// and 2FA recovery affect a global identity, so those remain super-admin-only.

app.post('/api/workspaces/:id/members/:userId/reset-password', async (req, reply) => {
  const { id, userId } = req.params as { id: string; userId: string };
  if (!requireSuperAdmin(req, reply)) return;
  if (!getWorkspace(id)) return reply.status(404).send({ error: 'Workspace not found' });
  const target = getUserById(userId);
  if (!target || !listWorkspaceMembers(id).some(m => m.user_id === userId)) {
    return reply.status(404).send({ error: 'That user is not a member of this workspace.' });
  }
  const token = createPasswordReset(target.id);
  if (!emailConfigured()) {
    // No SMTP configured — hand the admin the link to share manually instead
    // of silently doing nothing.
    recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: userId, workspaceId: id,
      action: 'user.password_reset.sent', detail: { emailed: false }, ipAddress: requestIp(req) });
    return { ok: true, emailed: false, resetPath: `/reset-password?token=${encodeURIComponent(token)}` };
  }
  const { origin } = rpInfo(req);
  const link = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await sendEmail({
      to: target.email,
      subject: 'Your SEO Website Indexer password was reset',
      text: `An administrator reset your password.\n\nSet a new one here (valid for 1 hour):\n${link}`,
      html: `<p>An administrator reset your password.</p><p><a href="${link}">Set a new password</a> (valid for 1 hour).</p>`,
    });
  } catch (e) {
    logSystem('warn', `Admin-initiated password-reset email failed for ${target.email}: ${e instanceof Error ? e.message : String(e)}`);
    recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: userId, workspaceId: id,
      action: 'user.password_reset.sent', detail: { emailed: false }, ipAddress: requestIp(req) });
    return { ok: true, emailed: false, resetPath: `/reset-password?token=${encodeURIComponent(token)}` };
  }
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: userId, workspaceId: id,
    action: 'user.password_reset.sent', detail: { emailed: true }, ipAddress: requestIp(req) });
  return { ok: true, emailed: true };
});

app.post('/api/workspaces/:id/members/:userId/clear-2fa', async (req, reply) => {
  const { id, userId } = req.params as { id: string; userId: string };
  if (!requireSuperAdmin(req, reply)) return;
  if (!getWorkspace(id)) return reply.status(404).send({ error: 'Workspace not found' });
  const target = getUserById(userId);
  if (!target || !listWorkspaceMembers(id).some(m => m.user_id === userId)) {
    return reply.status(404).send({ error: 'That user is not a member of this workspace.' });
  }
  disableTotp(userId);
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: userId, workspaceId: id,
    action: 'user.2fa.cleared', ipAddress: requestIp(req) });
  return { ok: true };
});

app.patch('/api/workspaces/:id/members/:userId', async (req, reply) => {
  const { id, userId } = req.params as { id: string; userId: string };
  const actor = currentUser(req);
  if (!canManageWorkspace(actor, id)) return reply.status(404).send({ error: 'Workspace not found' });
  const ws = getWorkspace(id);
  if (ws && ws.owner_user_id === userId) return reply.status(400).send({ error: "The owner's membership cannot be changed here." });
  const { role, ai_citations, disabled, permissions } = (req.body ?? {}) as
    { role?: string; ai_citations?: boolean; disabled?: boolean; permissions?: Partial<Record<Capability, boolean>> };
  if (role && !['admin', 'editor', 'viewer'].includes(role)) return reply.status(400).send({ error: 'Invalid role.' });
  if (disabled && userId === actor.id) return reply.status(400).send({ error: 'You cannot disable your own access.' });
  const ok = updateWorkspaceMember(id, userId, {
    role: role as 'admin' | 'editor' | 'viewer' | undefined,
    ai_citations: typeof ai_citations === 'boolean' ? ai_citations : undefined,
    disabled: typeof disabled === 'boolean' ? disabled : undefined,
    permissions,
  });
  if (!ok) return reply.status(404).send({ error: 'That user is not a member of this workspace.' });
  recordAuditEvent({ actorUserId: auditActor(req).id, targetUserId: userId, workspaceId: id,
    action: 'workspace.member.updated', detail: { role, ai_citations, disabled, permissions }, ipAddress: requestIp(req) });
  return { ok: true };
});

// ── Workspace invites (email a join link) ────────────────────────────────────

app.get('/api/workspaces/:id/invites', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!canManageWorkspace(currentUser(req), id)) return reply.status(404).send({ error: 'Workspace not found' });
  return listWorkspaceInvites(id).map(i => ({
    id: i.id, email: i.email, role: i.role, ai_citations: !!i.ai_citations,
    expires_at: i.expires_at, created_at: i.created_at,
  }));
});

app.post('/api/workspaces/:id/invites', async (req, reply) => {
  const { id } = req.params as { id: string };
  const actor = currentUser(req);
  if (!canManageWorkspace(actor, id)) return reply.status(404).send({ error: 'Workspace not found' });
  const ws = getWorkspace(id);
  const { email, role, ai_citations } = (req.body ?? {}) as { email?: string; role?: string; ai_citations?: boolean };
  if (!email?.trim() || !email.includes('@')) return reply.status(400).send({ error: 'A valid email is required.' });
  const normRole: 'admin' | 'editor' | 'viewer' = role === 'admin' || role === 'viewer' ? role : 'editor';
  const existing = getUserByEmail(email.trim());
  if (existing && listWorkspaceMembers(id).some(m => m.user_id === existing.id)) {
    return reply.status(409).send({ error: 'That person is already a member of this workspace.' });
  }
  const token = createWorkspaceInvite(id, email.trim(), normRole, ai_citations !== false, actor.id);
  const { origin } = rpInfo(req);
  const link = `${origin}/accept-invite?token=${encodeURIComponent(token)}`;
  let emailed = false;
  if (emailConfigured()) {
    try {
      await sendEmail({
        to: email.trim(),
        subject: `You've been invited to ${ws?.name ?? 'a workspace'} on SEO Website Indexer`,
        text: `${actor.name || actor.email} invited you to join "${ws?.name}" as a${normRole === 'admin' ? 'n' : ''} ${normRole}.\n\nAccept the invite here (valid for 7 days):\n${link}`,
        html: `<p>${actor.name || actor.email} invited you to join <strong>${ws?.name}</strong> as a${normRole === 'admin' ? 'n' : ''} ${normRole}.</p><p><a href="${link}">Accept the invite</a> (valid for 7 days).</p>`,
      });
      emailed = true;
    } catch (e) {
      logSystem('warn', `Workspace invite email failed for ${email.trim()}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: true, emailed, inviteLink: emailed ? undefined : link };
});

app.delete('/api/workspaces/:id/invites/:inviteId', async (req, reply) => {
  const { id, inviteId } = req.params as { id: string; inviteId: string };
  if (!canManageWorkspace(currentUser(req), id)) return reply.status(404).send({ error: 'Workspace not found' });
  revokeWorkspaceInvite(id, inviteId);
  return { ok: true };
});

// Public: look up an invite by its raw token (accept-invite page), and accept
// it — creating the account if the invitee doesn't have one yet, or just
// attaching the membership if they're already logged in as that email.
app.get('/api/invites/:token', async (req, reply) => {
  const { token } = req.params as { token: string };
  const invite = getInviteByToken(token);
  if (!invite) return reply.status(404).send({ error: 'This invite link is invalid or has expired.' });
  return {
    email: invite.email,
    workspaceName: invite.workspace_name,
    role: invite.role,
    hasAccount: !!getUserByEmail(invite.email),
  };
});

app.post('/api/invites/:token/accept', async (req, reply) => {
  const { token } = req.params as { token: string };
  const invite = getInviteByToken(token);
  if (!invite) return reply.status(404).send({ error: 'This invite link is invalid or has expired.' });
  const { password, name } = (req.body ?? {}) as { password?: string; name?: string };

  let user = getUserByEmail(invite.email);
  if (user) {
    // Already logged in elsewhere as someone else, or the account is disabled.
    if (user.disabled) return reply.status(403).send({ error: 'This account has been disabled.' });
  } else {
    if (!password || password.length < 8) return reply.status(400).send({ error: 'A password of at least 8 characters is required.' });
    user = createUser({ email: invite.email, password, name });
    // Deliberately no bootstrapUserWorkspace here: an invited member joins the
    // INVITING workspace directly rather than getting their own empty one, so
    // they never see the (Google-auth) setup wizard for a workspace that
    // already has sites/content configured.
  }
  addWorkspaceMember(invite.workspace_id, user.id, invite.role as 'admin' | 'editor' | 'viewer', !!invite.ai_citations);
  markInviteAccepted(invite.id);
  recordLogin(user.id);
  setSessionCookie(req, reply, createSession(user.id, String(req.headers['user-agent'] ?? '')));
  return toPublic(user);
});

// ── Google Search Console auth ────────────────────────────────────────────────

app.get('/api/auth/accounts', async (req) => {
  const ws = currentWorkspace(req);
  const user = currentUser(req);
  const accounts = ws ? getGoogleAccountsForWorkspace(ws) : [];
  return accounts.map(acc => ({
    id: acc.id,
    email: acc.email,
    client_id: acc.client_id,
    created_at: acc.created_at,
    needs_reauth: acc.needs_reauth ? 1 : 0,
    refresh_token_expiry: acc.refresh_token_expiry ?? null,
    last_refreshed_at: acc.last_refreshed_at ?? null,
    last_refresh_error: acc.last_refresh_error ?? null,
    granted_scopes: acc.granted_scopes ?? null,
    owner_email: acc.owner_email ?? null,
    is_mine: acc.owner_user_id === user.id,
    can_disconnect: acc.owner_user_id === user.id || !!user.is_super_admin,
    can_unshare: !!ws && (acc.owner_user_id === user.id || canManageWorkspace(user, ws)),
  }));
});

// Personal credential pool, including accounts not yet delegated to the active
// workspace. This is how a multi-workspace member reuses one Google login
// without reconnecting or exposing it to unrelated tenants.
app.get('/api/auth/accounts/mine', async (req) => {
  const ws = currentWorkspace(req);
  return getGoogleAccountsForOwner(currentUser(req).id).map(acc => ({
    id: acc.id,
    email: acc.email,
    created_at: acc.created_at,
    needs_reauth: acc.needs_reauth ? 1 : 0,
    available_in_workspace: !!ws && isGoogleAccountAvailableToWorkspace(acc.id, ws),
  }));
});

app.post('/api/auth/accounts/:id/share', async (req, reply) => {
  const { id } = req.params as { id: string };
  const account = getGoogleAccountById(id);
  const user = currentUser(req);
  const ws = currentWorkspace(req);
  if (!account || (!user.is_super_admin && account.owner_user_id !== user.id)) {
    return reply.status(404).send({ error: 'Account not found' });
  }
  if (!ws || !canAccessWorkspace(user, ws)) return reply.status(404).send({ error: 'Workspace not found' });
  shareGoogleAccountWithWorkspace(id, ws, user.id);
  recordAuditEvent({ actorUserId: auditActor(req).id, workspaceId: ws, action: 'google_account.shared', detail: { accountId: id }, ipAddress: requestIp(req) });
  return { ok: true };
});

app.delete('/api/auth/accounts/:id/workspace', async (req, reply) => {
  const { id } = req.params as { id: string };
  const account = getGoogleAccountById(id);
  const user = currentUser(req);
  const ws = currentWorkspace(req);
  if (!account || !ws || !isGoogleAccountAvailableToWorkspace(id, ws)) {
    return reply.status(404).send({ error: 'Account not found' });
  }
  if (!user.is_super_admin && account.owner_user_id !== user.id && !canManageWorkspace(user, ws)) {
    return reply.status(403).send({ error: 'Only the credential owner or a workspace admin can remove this connection.' });
  }
  unshareGoogleAccountFromWorkspace(id, ws);
  recordAuditEvent({ actorUserId: auditActor(req).id, workspaceId: ws, action: 'google_account.unshared', detail: { accountId: id }, ipAddress: requestIp(req) });
  return { ok: true };
});

app.delete('/api/auth/accounts/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  // Accounts are owner-level: only the owner (or a super-admin) may disconnect,
  // which removes it from every workspace that owner uses it in.
  const acc = getGoogleAccountById(id);
  if (!acc) return reply.code(404).send({ error: 'Account not found' });
  const u = currentUser(req);
  const allowed = acc.owner_user_id ? (acc.owner_user_id === u.id || u.is_super_admin) : u.is_super_admin;
  if (!allowed) return reply.code(404).send({ error: 'Account not found' });
  disconnectGoogleAccount(id);
  recordAuditEvent({ actorUserId: auditActor(req).id, action: 'google_account.disconnected', detail: { accountId: id }, ipAddress: requestIp(req) });
  return { ok: true };
});

// Re-authorise an EXISTING account without disconnecting it or re-typing the
// client id/secret. We prime the pending OAuth exchange with the account's
// already-stored credentials; the popup then runs the normal consent flow and
// the callback re-mints tokens onto the same row (matched by Google email),
// clearing any needs_reauth flag. Returns the client id so the frontend can
// build the consent URL for self-hosted (non-builtin) OAuth clients.
app.post('/api/auth/accounts/:id/reconnect', async (req, reply) => {
  const { id } = req.params as { id: string };
  const acc = getGoogleAccountById(id);
  if (!acc) return reply.code(404).send({ error: 'Account not found' });
  const u = currentUser(req);
  const allowed = acc.owner_user_id ? (acc.owner_user_id === u.id || u.is_super_admin) : u.is_super_admin;
  if (!allowed) return reply.code(404).send({ error: 'Account not found' });
  saveCredentials(acc.client_id, acc.client_secret);
  return { ok: true, clientId: acc.client_id };
});

app.post('/api/auth/clear', async (req, reply) => {
  // Tenant-scoped: only disconnect the CURRENT workspace's Google accounts.
  // (Previously this called the global clearAuth(), so one user clearing their
  // credentials wiped every workspace's Google auth — a cross-tenant data loss.)
  const ws = currentWorkspace(req);
  if (!ws) return reply.code(400).send({ error: 'No active workspace' });
  clearAuthForWorkspace(ws);
  recordAuditEvent({ actorUserId: auditActor(req).id, workspaceId: ws, action: 'google_account.workspace_cleared', ipAddress: requestIp(req) });
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

app.post('/api/auth/google/start', async (req, reply) => {
  const user = currentUser(req);
  const workspaceId = currentWorkspace(req);
  if (!workspaceId) return reply.status(400).send({ error: 'No active workspace.' });
  const { clientId, clientSecret, autoSetup, accountId } = (req.body ?? {}) as {
    clientId?: string; clientSecret?: string; autoSetup?: boolean; accountId?: string;
  };
  let reconnect: ReturnType<typeof getGoogleAccountById> = null;
  if (accountId) {
    reconnect = getGoogleAccountById(accountId);
    if (!reconnect || (!user.is_super_admin && reconnect.owner_user_id !== user.id)) {
      return reply.status(404).send({ error: 'Account not found' });
    }
  }
  const { origin } = rpInfo(req);
  try {
    const authorizationUrl = createGoogleOAuthAuthorization({
      userId: user.id,
      workspaceId,
      redirectUri: `${origin}/api/auth/google/callback`,
      autoSetup: !!autoSetup,
      clientId: reconnect?.client_id ?? clientId,
      clientSecret: reconnect?.client_secret ?? clientSecret,
      loginHint: reconnect?.email ?? null,
    });
    return { authorizationUrl };
  } catch (e) {
    return reply.status(400).send({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/auth/google/callback', async (req, reply) => {
  const { code, error, state } = req.query as { code?: string; error?: string; state?: string };
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
          <p style="color: #94a3b8; font-size: 14px; margin-bottom: 24px;">${escapeHtml(error)}</p>
          <button onclick="window.close()" style="background: #252836; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold;">Close Window</button>
        </body>
      </html>
    `);
  }
  
  if (!code) {
    return reply.status(400).send({ error: 'Authorization code is required' });
  }

  // State is an opaque, single-use nonce backed by an encrypted DB row. It
  // binds the exchange to one user, workspace, redirect URI and client secret;
  // two people can connect concurrently without sharing process-global state.
  const pending = state ? consumeGoogleOAuthState(state) : null;
  if (!pending) return reply.status(400).send({ error: 'This Google authorization request is invalid or has expired. Start again from Settings.' });
  const pendingUser = getUserById(pending.userId);
  if (!pendingUser || pendingUser.disabled || !canAccessWorkspace(pendingUser, pending.workspaceId)) {
    return reply.status(403).send({ error: 'The user or workspace for this authorization is no longer available.' });
  }

  try {
    await exchangeCodeForTokens(code, pending.redirectUri, pending.workspaceId, pending.userId,
      { clientId: pending.clientId, clientSecret: pending.clientSecret });
    const openerOrigin = new URL(pending.redirectUri).origin;
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
              window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS' }, ${JSON.stringify(openerOrigin)});
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
          <p style="color: #94a3b8; font-size: 14px; margin-bottom: 24px;">${escapeHtml(e)}</p>
          <button onclick="window.close()" style="background: #252836; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold;">Close Window</button>
        </body>
      </html>
    `);
  }
});

// List GSC properties (for onboarding site-picker)
app.get('/api/auth/gsc-sites', async (req, reply) => {
  const { accountId } = req.query as { accountId?: string };
  const ws = currentWorkspace(req);
  try {
    if (accountId) {
      // Authorize: the account must be explicitly delegated to the active
      // workspace, even when this user owns it elsewhere.
      if (!ws || !isGoogleAccountAvailableToWorkspace(accountId, ws)) {
        return reply.status(404).send({ error: 'Account not found' });
      }
      const sites = await listGSCSites(accountId);
      return sites.map(s => ({ ...s, googleAccountId: accountId }));
    }
    const accounts = ws ? getGoogleAccountsForWorkspace(ws) : [];
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

app.get('/api/sites', async (req) => {
  const ws = currentWorkspace(req);
  const sites = ws ? getSitesForWorkspace(ws) : [];
  return sites.map(site => ({
    ...site,
    indexNowKey: getIndexNowKey(site.id)?.key_value ?? getOrCreateIndexNowKey(site.id),
    indexNowVerified: getIndexNowKey(site.id)?.verified === 1,
  }));
});

function validateSiteTargets(domain: string, sitemapUrl: string, deployWebhook?: string | null): string | null {
  try {
    validateOutboundUrl(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`, { label: 'Site URL' });
    validateOutboundUrl(sitemapUrl, { label: 'Sitemap URL' });
    if (deployWebhook?.trim()) validateOutboundUrl(deployWebhook, { label: 'Deployment webhook URL' });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

app.post('/api/sites', { schema: createSiteSchema }, async (req, reply) => {
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
  const urlError = validateSiteTargets(domain, sitemapUrl, deploy_webhook_url);
  if (urlError) return reply.status(400).send({ error: urlError });
  const workspaceId = requireWorkspace(req);
  // A site may only be linked to a Google account explicitly delegated to its
  // workspace.
  if (googleAccountId) {
    if (!isGoogleAccountAvailableToWorkspace(googleAccountId, workspaceId)) {
      return reply.status(400).send({ error: 'That Google account is not available in this workspace.' });
    }
  }
  const id = randomUUID();
  upsertSite({
    id,
    name,
    domain,
    sitemap_url: sitemapUrl,
    gsc_url: gscUrl,
    enabled: 1,
    workspace_id: workspaceId,
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

app.put('/api/sites/:id', { schema: updateSiteSchema }, async (req, reply) => {
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
    bingAccountId: string | null;
    bing_account_id: string | null;
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

  // Validate the FK target exists AND is explicitly delegated to this site's
  // workspace, otherwise the upsert would either throw or cross a tenant
  // boundary.
  if (incomingAccountId) {
    if (!existing.workspace_id || !isGoogleAccountAvailableToWorkspace(incomingAccountId, existing.workspace_id)) {
      return reply.status(400).send({
        error: `Google account "${incomingAccountId}" is not available in this workspace.`,
      });
    }
  }

  // Bing account link — must belong to the same workspace (or be cleared).
  const incomingBingId =
    updates.bingAccountId !== undefined ? updates.bingAccountId :
    updates.bing_account_id !== undefined ? updates.bing_account_id :
    undefined;
  if (incomingBingId) {
    if (bingAccountWorkspace(incomingBingId) !== (existing.workspace_id ?? null)) {
      return reply.status(400).send({ error: 'That Bing account is not in this workspace.' });
    }
  }

  const nextDomain = updates.domain ?? existing.domain;
  const nextSitemap = updates.sitemap_url ?? updates.sitemapUrl ?? existing.sitemap_url;
  const nextWebhook = updates.deploy_webhook_url !== undefined ? updates.deploy_webhook_url : existing.deploy_webhook_url;
  const urlError = validateSiteTargets(nextDomain, nextSitemap, nextWebhook);
  if (urlError) return reply.status(400).send({ error: urlError });

  try {
    upsertSite({
      id,
      name: updates.name ?? existing.name,
      domain: updates.domain ?? existing.domain,
      sitemap_url: updates.sitemap_url ?? updates.sitemapUrl ?? existing.sitemap_url,
      gsc_url: updates.gsc_url ?? updates.gscUrl ?? existing.gsc_url,
      enabled: updates.enabled ?? existing.enabled,
      google_account_id: incomingAccountId !== undefined ? incomingAccountId : existing.google_account_id,
      bing_account_id: incomingBingId !== undefined ? incomingBingId : existing.bing_account_id,
      deploy_webhook_url: updates.deploy_webhook_url !== undefined ? updates.deploy_webhook_url : existing.deploy_webhook_url,
      ftp_host: updates.ftp_host !== undefined ? updates.ftp_host : existing.ftp_host,
      ftp_port: updates.ftp_port !== undefined && updates.ftp_port !== null ? Number(updates.ftp_port) : existing.ftp_port,
      ftp_user: updates.ftp_user !== undefined ? updates.ftp_user : existing.ftp_user,
      ftp_pass: updates.ftp_pass !== undefined ? updates.ftp_pass : existing.ftp_pass,
      ftp_path: updates.ftp_path !== undefined ? updates.ftp_path : existing.ftp_path,
      geo_manage: updates.geo_manage !== undefined ? Number(updates.geo_manage) : existing.geo_manage,
      // workspace_id intentionally omitted — upsertSite COALESCEs it, so an edit
      // never moves a site between tenants.
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

app.get('/api/runs', async (req) => getRecentRuns(50, currentWorkspace(req)));

app.post('/api/runs', async (req, reply) => {
  const ws = currentWorkspace(req);
  if (!ws) return reply.status(400).send({ error: 'No active workspace.' });
  // Only THIS workspace's run state matters — another tenant running never blocks you.
  if (isRunning(ws)) {
    return reply.status(409).send({ error: 'A run is already in progress for this workspace.', runId: getCurrentRunId(ws) });
  }
  const opts = (req.body ?? {}) as {
    siteIds?: string[];
    skipGoogle?: boolean;
    skipIndexNow?: boolean;
    skipBing?: boolean;
    skipSitemaps?: boolean;
    gscLimit?: number;
  };
  try {
    const runId = await runIndexing({ trigger: 'manual', workspaceId: ws, ...opts });
    return { ok: true, runId };
  } catch (e) {
    return reply.status(500).send({ error: String(e) });
  }
});

app.post('/api/runs/stop', async (req, reply) => {
  const ws = currentWorkspace(req);
  if (!ws || !isRunning(ws)) {
    return reply.status(400).send({ error: 'No run is currently in progress for this workspace.' });
  }
  forceStopRun(ws);
  return { ok: true, message: 'Stop request sent successfully.' };
});

app.get('/api/runs/:id/logs', async (req) => {
  const { id } = req.params as { id: string };
  return getLogsForRun(id, currentWorkspace(req));
});

// ── Logs ──────────────────────────────────────────────────────────────────────

app.get('/api/logs', async (req) => {
  const { limit } = req.query as { limit?: string };
  return getRecentLogs(parseInt(limit ?? '200', 10), currentWorkspace(req));
});

// SSE: live log stream — scoped to one workspace. EventSource can't set the
// X-Workspace-Id header, so the workspace arrives as a ?workspace= query param
// (validated against what the caller can access).
app.get('/api/logs/stream', async (req, reply) => {
  const user = currentUser(req);
  const accessible = accessibleWorkspaces(user);
  const wsParam = (req.query as { workspace?: string }).workspace;
  const streamWs = (wsParam && accessible.some(w => w.id === wsParam)) ? wsParam : (accessible[0]?.id ?? null);

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
    if (entry.workspace_id !== streamWs) return; // only this workspace's logs
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

// Platform-level (instance) settings the frontend may read plainly. Notification
// channels are NOT here — they're per-workspace now (see /api/notifications/*).
const PUBLIC_SETTINGS = ['cron_schedule', 'google_project_id'];
// Write-only secrets: settable via PUT, never echoed back — GET returns
// `<key>_configured` booleans instead. These are the PLATFORM DEFAULTS; each
// workspace can override any of them (see /api/workspace/keys).
const SECRET_SETTINGS = [
  'bing_api_key', 'bing_oauth_client_id', 'bing_oauth_client_secret', 'crux_api_key',
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

// Platform defaults are instance-wide → super-admin only.
app.put('/api/settings', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  const body = req.body as Record<string, string>;
  for (const key of PUBLIC_SETTINGS) {
    if (body[key] !== undefined) setSetting(key, String(body[key]));
  }
  for (const key of SECRET_SETTINGS) {
    if (body[key] !== undefined) {
      const value = String(body[key]).trim();
      if (value === SECRET_MASK) continue; // unchanged placeholder — ignore
      setSetting(key, value);              // empty string clears the secret
    }
  }
  if (body.cron_schedule !== undefined) restartScheduler();
  return { ok: true };
});

// ── Per-workspace API-key overrides (layered over the platform defaults) ──────
// Each workspace can supply its own AI/CrUX/Bing keys; absent → inherit the
// platform default. Workspace owners manage their own; a super-admin any.
const WORKSPACE_KEYS = SECRET_SETTINGS; // same catalogue, resolved per-workspace

app.get('/api/workspace/keys', async (req) => {
  const wsId = currentWorkspace(req);
  const overrides = wsId ? getWorkspaceSettings(wsId) : {};
  const platform = getAllSettings();
  // Never echo secrets — report, per key, whether the workspace overrides it and
  // whether a platform default exists to fall back on.
  return {
    keys: Object.fromEntries(WORKSPACE_KEYS.map(k => [k, {
      override: !!overrides[k],
      platform: !!platform[k],
    }])),
  };
});

app.put('/api/workspace/keys', async (req, reply) => {
  const wsId = requireWorkspace(req);
  if (!hasCapability(currentUser(req), wsId, 'manage_integrations')) return reply.status(403).send({ error: 'You do not have permission to manage workspace integrations.' });
  const body = (req.body ?? {}) as Record<string, string>;
  for (const key of WORKSPACE_KEYS) {
    if (body[key] === undefined) continue;
    const value = String(body[key]).trim();
    if (value === SECRET_MASK) continue;          // unchanged placeholder
    setWorkspaceSetting(wsId, key, value);        // empty string clears the override → inherit platform
  }
  return { ok: true };
});

// ── Notifications (per-workspace) ────────────────────────────────────────────
// Which channels the active workspace has configured (for the Settings UI).
app.get('/api/notifications/status', async (req) => {
  const wsId = currentWorkspace(req);
  return { configured: wsId ? configuredChannels(wsId) : [] };
});

// The active workspace's channel config values (URLs/topics are shown so the
// owner can edit them; there are no separate platform notification defaults).
app.get('/api/notifications/config', async (req) => {
  const wsId = currentWorkspace(req);
  const vals = wsId ? getWorkspaceSettings(wsId) : {};
  return Object.fromEntries(NOTIFY_KEYS.map(k => [k, vals[k] ?? '']));
});

app.put('/api/notifications/config', async (req, reply) => {
  const wsId = requireWorkspace(req);
  if (!hasCapability(currentUser(req), wsId, 'manage_notifications')) return reply.status(403).send({ error: 'You do not have permission to manage workspace notifications.' });
  const body = (req.body ?? {}) as Record<string, string>;
  for (const key of ['notify_slack_webhook', 'notify_discord_webhook', 'notify_ntfy_server', 'notify_webhook_url']) {
    const value = body[key]?.trim();
    if (!value) continue;
    try { validateOutboundUrl(value, { label: key.replaceAll('_', ' ') }); }
    catch (error) { return reply.status(400).send({ error: error instanceof Error ? error.message : 'Notification URL is invalid.' }); }
  }
  if (body.notify_ntfy_topic?.trim() && /^https?:\/\//i.test(body.notify_ntfy_topic)) {
    try { validateOutboundUrl(body.notify_ntfy_topic, { label: 'ntfy topic URL' }); }
    catch (error) { return reply.status(400).send({ error: error instanceof Error ? error.message : 'ntfy topic URL is invalid.' }); }
  }
  for (const key of NOTIFY_KEYS) {
    if (body[key] !== undefined) setWorkspaceSetting(wsId, key, String(body[key]));
  }
  return { ok: true };
});

// Fire a test at the active workspace's channels; report per-channel results.
app.post('/api/notifications/test', async (req) => {
  const wsId = currentWorkspace(req);
  const results = wsId ? await sendTestNotification(wsId) : [];
  return { results };
});

app.get('/api/notifications/deliveries', async (req) => {
  const wsId = currentWorkspace(req);
  return wsId ? listNotificationDeliveries(wsId) : [];
});

// ── Quota Usage ───────────────────────────────────────────────────────────────

app.get('/api/quota/today', async (req) => {
  const { day } = (req.query ?? {}) as { day?: string };
  const targetDay = day ?? new Date().toISOString().slice(0, 10);

  // Tenant scope: only count site and Search Console property buckets that
  // belong to this workspace, so identifiers cannot leak between tenants.
  const ws = currentWorkspace(req);
  const wsSites = ws ? getSitesForWorkspace(ws) : [];
  const siteIds = new Set(wsSites.map(s => s.id));
  const gscUrls = new Set(wsSites.map(s => s.gsc_url));
  const inWorkspace = (bucket: string): boolean => {
    if (bucket.startsWith('site:')) return siteIds.has(bucket.slice(5));
    if (bucket.startsWith('property:')) return gscUrls.has(bucket.slice('property:'.length));
    return false;
  };
  const rows = getAllQuotaUsageForDay(targetDay).filter(r => inWorkspace(r.bucket));

  // Aggregate by API with helpful per-bucket detail.
  const grouped: Record<string, { total: number; buckets: Array<{ bucket: string; count: number }> }> = {};
  for (const row of rows) {
    if (!grouped[row.api]) grouped[row.api] = { total: 0, buckets: [] };
    grouped[row.api].total += row.count;
    grouped[row.api].buckets.push({ bucket: row.bucket, count: row.count });
  }

  // Build summary limits using current configuration
  const summary = {
    day: targetDay,
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

app.get('/api/url-failures', async (req) => {
  // Only failures for sites in the active workspace.
  const ws = currentWorkspace(req);
  const siteIds = new Set(ws ? getSitesForWorkspace(ws).map(s => s.id) : []);
  return getAllUrlFailures().filter(f => siteIds.has(f.site_id));
});

// Re-check whether a failed URL is currently reachable. This does not spend a
// search-engine submission quota; it gives the operator evidence before they
// clear the backoff record and allow the next run to retry it.
app.post('/api/url-failures/check', async (req, reply) => {
  const ws = currentWorkspace(req);
  const { siteId, url, api } = (req.body ?? {}) as { siteId?: string; url?: string; api?: string };
  if (!ws || !siteId || !url || !api) return reply.status(400).send({ error: 'siteId, url and api are required.' });
  const siteIds = new Set(getSitesForWorkspace(ws).map(s => s.id));
  const failure = getAllUrlFailures().find(f => f.site_id === siteId && f.url === url && f.api === api && siteIds.has(f.site_id));
  if (!failure) return reply.status(404).send({ error: 'Failure record not found.' });
  try {
    let res = await safeFetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'OrganicCommand/1.0 failure-check' } }, { label: 'Failure-check URL' });
    if (res.status === 405) {
      res = await safeFetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'OrganicCommand/1.0 failure-check', Range: 'bytes=0-1023' } }, { label: 'Failure-check URL' });
      await res.body?.cancel().catch(() => undefined);
    }
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      finalUrl: res.url,
      redirected: res.redirected,
      contentType: res.headers.get('content-type'),
      checkedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { ok: false, status: null, error: e instanceof Error ? e.message : String(e), checkedAt: new Date().toISOString() };
  }
});

app.delete('/api/url-failures', async (req, reply) => {
  const ws = currentWorkspace(req);
  if (!ws) return reply.status(400).send({ error: 'No active workspace.' });
  const { siteId, url, api } = (req.body ?? {}) as { siteId?: string; url?: string; api?: string };
  const siteIds = getSitesForWorkspace(ws).map(s => s.id);
  if (siteId && !siteIds.includes(siteId)) return reply.status(404).send({ error: 'Site not found.' });
  const cleared = clearUrlFailuresForSites(siteIds, { siteId, url, api });
  recordAuditEvent({ actorUserId: auditActor(req).id, workspaceId: ws, action: 'url_failures.cleared',
    detail: { siteId: siteId ?? null, url: url ?? null, api: api ?? null, cleared }, ipAddress: requestIp(req) });
  return { ok: true, cleared };
});

// ── Backups ───────────────────────────────────────────────────────────────────

app.get('/api/backups', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  return listBackups();
});

app.post('/api/backups', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  const result = backupNow();
  return { ok: true, ...result };
});

// ── Lock control (admin) ──────────────────────────────────────────────────────

app.post('/api/scheduler/release-lock', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  // Only allow if no run is in process memory anywhere (safety).
  if (isRunning()) {
    return reply.status(409).send({ error: 'A run is currently active in-process. Stop it first.' });
  }
  const db = getDb();
  // Locks are per-workspace now (run_lock:<workspaceId>) — clear any stuck ones.
  db.prepare(`DELETE FROM settings WHERE key = 'run_lock' OR key LIKE 'run_lock:%'`).run();
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
    const workspaceId = requireWorkspace(req);
    if (result.robots.ok) {
      recordSiteFileSnapshot({ workspaceId, siteId: site.id, fileKind: 'robots.txt', source: 'deployment', content: buildRobotsTxt(site), matchesGenerated: true });
    }
    if (result.llms.ok) {
      recordSiteFileSnapshot({ workspaceId, siteId: site.id, fileKind: 'llms.txt', source: 'deployment', content: site.llms_txt_content?.trim() || buildLlmsTxt(site), matchesGenerated: true });
    }
    addAnnotation({
      workspaceId,
      siteId: site.id,
      userId: currentUser(req).id,
      kind: 'deployment',
      title: `Discovery files deployed for ${site.name}`,
      note: [result.robots, result.llms, result.llmsSitemap].map(file => `${file.target}: ${file.ok ? 'ok' : file.message}`).join(' · '),
      metadata: { robots: result.robots, llms: result.llms, llmsSitemap: result.llmsSitemap },
    });
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

app.get('/api/command-center', async (req) => getCommandCenter(currentWorkspace(req)));

app.get('/api/analytics/overview', async (req) => getOverview(currentWorkspace(req)));

app.get('/api/analytics/site/:id', async (req, reply) => {
  const detail = getSiteDetail((req.params as { id: string }).id);
  if (!detail) return reply.code(404).send({ error: 'Site not found' });
  return detail;
});

app.post('/api/analytics/snapshot', async (req) => ({ snapshots: snapshotAllSites(currentWorkspace(req)).length }));

app.get('/api/analytics/alerts', async (req) => getAlerts(currentWorkspace(req)));

// Portfolio-wide Google search movers (WoW) for the Analytics landing page.
app.get('/api/analytics/movers', async (req) => getPortfolioMovers(currentWorkspace(req)));
app.post('/api/analytics/alerts/:id/ack', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!alertInWorkspace(id, currentWorkspace(req))) return reply.code(404).send({ error: 'Alert not found' });
  ackAlert(id);
  return { ok: true };
});

// ── Unified search performance (GSC + Bing) ──────────────────────────────────

app.get('/api/performance/:siteId', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const days = Math.min(Math.max(Number((req.query as { days?: string }).days) || 28, 1), 365);
  const [google, bing] = await Promise.all([
    getGooglePerformance(site, days),
    getBingPerformance(site, days),
  ]);
  return { days, google, bing };
});

app.get('/api/sites/:id/crawl-issues', async (req, reply) => {
  const site = getSiteById((req.params as { id: string }).id);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  return getBingCrawlIssues(site);
});

// GSC country/device breakdown for a site + range.
app.get('/api/performance/:siteId/dimension', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const q = req.query as { days?: string; dimension?: string };
  const days = Math.min(Math.max(Number(q.days) || 28, 1), 365);
  const dimension = q.dimension === 'device' ? 'device' : q.dimension === 'searchAppearance' ? 'searchAppearance' : 'country';
  return getGoogleDimension(site, days, dimension);
});

// Week-over-week deltas (last 7d vs prior 7d) from cached rollups.
app.get('/api/performance/:siteId/deltas', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const engine = (req.query as { engine?: string }).engine === 'bing' ? 'bing' : 'google';
  return { engine, deltas: getWowDeltas(site.id, engine) };
});

// On-demand refresh of a site's cached rollups (otherwise refreshed post-run).
app.post('/api/performance/:siteId/snapshot', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  await snapshotSitePerformance(site);
  return { ok: true };
});

// Query-position-over-time + trackable/tracked query management.
app.get('/api/performance/:siteId/query-trend', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const query = (req.query as { query?: string }).query;
  if (!query) return reply.code(400).send({ error: 'query required' });
  return { query, points: getQueryTrend(site.id, query) };
});

app.get('/api/performance/:siteId/trackable-queries', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  return getTrackableQueries(site.id);
});

app.get('/api/performance/:siteId/tracked-queries', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  return listTrackedQueries(site.id);
});

app.post('/api/performance/:siteId/tracked-queries', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const query = (req.body as { query?: string })?.query;
  if (!query?.trim()) return reply.code(400).send({ error: 'query required' });
  addTrackedQuery(site.id, query);
  return { ok: true };
});

app.delete('/api/performance/tracked-queries/:id', async (req) => {
  removeTrackedQuery(Number((req.params as { id: string }).id));
  return { ok: true };
});

// Combined submit — push a site's URLs to Google, Bing, or both in one call.
app.post('/api/submit/:siteId', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const { engines, urls } = (req.body ?? {}) as { engines?: Array<'google' | 'bing'>; urls?: string[] };
  const targets = engines?.length ? engines : ['google', 'bing'];
  const list = urls?.length ? urls : getUrlsBySite(site.id).slice(0, 100).map((u: { url: string }) => u.url);
  const result: { google?: { runId?: string; error?: string }; bing?: { submitted?: number; error?: string } } = {};

  if (targets.includes('google')) {
    if (!site.google_account_id) {
      result.google = { error: 'No Google account linked to this site.' };
    } else if (isRunning(site.workspace_id)) {
      result.google = { error: 'A run is already in progress for this workspace.' };
    } else {
      try {
        const runId = await runIndexing({ trigger: 'manual', workspaceId: site.workspace_id ?? undefined, siteIds: [site.id], skipIndexNow: true, skipBing: true });
        result.google = { runId };
      } catch (e) {
        result.google = { error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  if (targets.includes('bing')) {
    const bingCredential = await bingCredentialForSite(site.id);
    if (!bingCredential) {
      result.bing = { error: 'No Bing Webmaster OAuth account or API key configured.' };
    } else {
      try {
        const results = await submitToBingInBatches(bingCredential, deriveBingSiteUrl(site.gsc_url, site.domain), list);
        result.bing = { submitted: results.filter(r => r.success).reduce((s, r) => s + r.urlCount, 0) };
      } catch (e) {
        result.bing = { error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  logSystem('ok', `Combined submit for ${site.domain}: ${JSON.stringify(result)}`);
  return result;
});

// ── llms.txt lifecycle ───────────────────────────────────────────────────────

app.get('/api/sites/:id/llms-audit', async (req, reply) => {
  const site = getSiteById((req.params as { id: string }).id);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const audit = await auditSiteLlms(site);
  const workspaceId = requireWorkspace(req);
  const normalise = (value: string) => value.replace(/\s+/g, ' ').trim();
  recordSiteFileSnapshot({
    workspaceId,
    siteId: site.id,
    fileKind: 'llms.txt',
    source: 'live',
    status: audit.live.status,
    content: audit.live.text,
    matchesGenerated: !audit.drift,
  });
  recordSiteFileSnapshot({
    workspaceId,
    siteId: site.id,
    fileKind: 'robots.txt',
    source: 'live',
    status: audit.robotsLive.status,
    content: audit.robotsLive.text,
    matchesGenerated: audit.robotsLive.status === 200
      && normalise(audit.robotsLive.text) === normalise(audit.robotsGenerated),
  });
  // Drift only matters when the tool owns the files; hand-maintained (monitor-
  // only) sites are EXPECTED to be richer than the generated baseline.
  if (audit.drift && site.geo_manage) {
    recordAlert(site.id, 'llms_drift', `${site.domain}: live llms.txt differs from generated version`, 'info');
  }
  // Surface any saved custom (AI-generated / edited) llms.txt + whether an AI
  // provider is available to generate one.
  return { ...audit, custom: site.llms_txt_content ?? null, aiProvider: llmsGenerationProvider() };
});

app.get('/api/sites/:id/file-history', async (req, reply) => {
  const site = getSiteById((req.params as { id: string }).id);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const workspaceId = requireWorkspace(req);
  return listSiteFileSnapshots(workspaceId, site.id, Number((req.query as { limit?: string }).limit ?? 50));
});

// Agent-readiness (isitagentready-style): run the live battery of checks, store
// today's score, and return the breakdown + score history for the trend line.
app.get('/api/sites/:id/agent-readiness', async (req, reply) => {
  const site = getSiteById((req.params as { id: string }).id);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  assertSiteAccess(req, site.id);
  const current = await snapshotSiteAgentReadiness(site);
  return { current, history: getAgentReadinessHistory(site.id) };
});

// Generate a comprehensive llms.txt with a configured AI provider (does not
// save — the client reviews/edits, then PUTs it below).
app.post('/api/sites/:id/llms/generate', async (req, reply) => {
  const site = getSiteById((req.params as { id: string }).id);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  try {
    return await generateLlmsTxt(site);
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode ?? 502;
    return reply.code(status).send({ error: e instanceof Error ? e.message : 'Generation failed.' });
  }
});

// Save (or clear, with empty body) the custom llms.txt used for deploys.
app.put('/api/sites/:id/llms', async (req, reply) => {
  const site = getSiteById((req.params as { id: string }).id);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const { content } = (req.body ?? {}) as { content?: string };
  setSiteLlmsContent(site.id, content ?? null);
  return { ok: true };
});

// ── Bing Webmaster ───────────────────────────────────────────────────────────

app.get('/api/bing/quota/:siteId', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const bingCredential = await bingCredentialForSite(site.id);
  if (!bingCredential) return reply.code(400).send({ error: 'Bing OAuth account or API key not configured' });
  const quota = await getBingQuota(bingCredential, deriveBingSiteUrl(site.gsc_url, site.domain));
  if (!quota) return reply.code(502).send({ error: 'Bing quota unavailable — check the delegated account/key and verified property' });
  // Keep the response shape the dashboard expects.
  return { DailyQuota: quota.dailyQuota, MonthlyQuota: quota.monthlyQuota };
});

app.post('/api/bing/submit/:siteId', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const bingCredential = await bingCredentialForSite(site.id);
  if (!bingCredential) return reply.code(400).send({ error: 'Bing OAuth account or API key not configured' });
  const { urls } = (req.body ?? {}) as { urls?: string[] };
  const list = urls?.length ? urls : getUrlsBySite(site.id).slice(0, 100).map((u: { url: string }) => u.url);
  const siteUrl = deriveBingSiteUrl(site.gsc_url, site.domain);
  const results = await submitToBingInBatches(bingCredential, siteUrl, list);
  const submitted = results.filter(r => r.success).reduce((s, r) => s + r.urlCount, 0);
  const failed = results.find(r => !r.success);
  if (failed) {
    logSystem('warn', `Bing: ${failed.message ?? `HTTP ${failed.statusCode}`} for ${site.domain}`);
    return reply.code(failed.quotaExceeded ? 429 : 502).send({ submitted, error: failed.message ?? 'Bing submission failed' });
  }
  logSystem('ok', `Bing: submitted ${submitted} URLs for ${site.domain}`);
  return { submitted };
});

// ── Bing accounts (multiple per workspace) ───────────────────────────────────
// Each workspace can hold several Bing Webmaster API keys; a site either picks
// one (site.bing_account_id) or falls back to the workspace's first.

app.post('/api/auth/bing/start', async (req, reply) => {
  const workspaceId = requireWorkspace(req); const current = currentUser(req);
  const clientId = effectiveSetting(workspaceId, 'bing_oauth_client_id');
  const clientSecret = effectiveSetting(workspaceId, 'bing_oauth_client_secret');
  if (!clientId || !clientSecret) return reply.code(400).send({ error: 'Configure the Bing OAuth client ID and secret for this workspace first.' });
  const name = String(((req.body ?? {}) as { name?: string }).name ?? 'Bing OAuth'); const { origin } = rpInfo(req);
  const redirectUri = `${origin}/api/auth/bing/callback`; const state = createBingOAuthState({ workspaceId, userId: current.id, name, redirectUri });
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'webmaster.manage', state });
  return { authorizationUrl: `https://www.bing.com/webmasters/oauth/authorize?${params}` };
});

app.get('/api/auth/bing/callback', async (req, reply) => {
  const { code, error, state } = req.query as { code?: string; error?: string; state?: string };
  if (error) return reply.type('text/html').send(`<html><body style="font:16px system-ui;background:#10121a;color:#ff7272;display:grid;place-items:center;height:90vh"><div><h2>Bing connection cancelled</h2><p>${escapeHtml(error)}</p><button onclick="window.close()">Close</button></div></body></html>`);
  const pending = state ? consumeBingOAuthState(state) : null;
  if (!code || !pending) return reply.code(400).send({ error: 'This Bing authorization request is invalid or expired.' });
  const pendingUser = getUserById(pending.user_id);
  if (!pendingUser || pendingUser.disabled || !canAccessWorkspace(pendingUser, pending.workspace_id)) return reply.code(403).send({ error: 'The user or workspace is no longer available.' });
  const clientId = effectiveSetting(pending.workspace_id, 'bing_oauth_client_id'); const clientSecret = effectiveSetting(pending.workspace_id, 'bing_oauth_client_secret');
  if (!clientId || !clientSecret) return reply.code(400).send({ error: 'Bing OAuth credentials are no longer configured.' });
  try {
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: pending.redirect_uri });
    const response = await fetch('https://www.bing.com/webmasters/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000) });
    const tokens = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!response.ok || !tokens.access_token) throw new Error(tokens.error || `HTTP ${response.status}`);
    const account = addBingOAuthAccount(pending.workspace_id, pending.name, { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in });
    recordAuditEvent({ actorUserId: pending.user_id, workspaceId: pending.workspace_id, action: 'bing_oauth.connected', detail: { accountId: account.id } });
    const openerOrigin = new URL(pending.redirect_uri).origin;
    return reply.type('text/html').send(`<html><body style="font:16px system-ui;background:#10121a;color:#74e6b2;display:grid;place-items:center;height:90vh"><div><h2>Bing connected</h2><p>You can return to Organic Command.</p></div><script>if(window.opener)window.opener.postMessage({type:'BING_AUTH_SUCCESS'},${JSON.stringify(openerOrigin)});setTimeout(()=>window.close(),1200)</script></body></html>`);
  } catch (failure) {
    return reply.type('text/html').send(`<html><body style="font:16px system-ui;background:#10121a;color:#ff7272;display:grid;place-items:center;height:90vh"><div><h2>Bing connection failed</h2><p>${escapeHtml(failure instanceof Error ? failure.message : failure)}</p><button onclick="window.close()">Close</button></div></body></html>`);
  }
});

app.get('/api/bing/accounts', async (req) => {
  const ws = currentWorkspace(req);
  return ws ? listBingAccounts(ws) : [];
});

app.post('/api/bing/accounts', async (req, reply) => {
  const ws = requireWorkspace(req);
  const { name, apiKey } = (req.body ?? {}) as { name?: string; apiKey?: string };
  if (!apiKey?.trim()) return reply.code(400).send({ error: 'apiKey is required.' });
  const acc = addBingAccount(ws, name ?? 'Bing account', apiKey);
  return { id: acc.id, name: acc.name, auth_type: acc.auth_type, expires_at: acc.expires_at, created_at: acc.created_at };
});

app.delete('/api/bing/accounts/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  // Only remove a Bing account inside a workspace the caller can access.
  const ws = bingAccountWorkspace(id);
  if (!ws || !canAccessWorkspace(currentUser(req), ws)) {
    return reply.code(404).send({ error: 'Bing account not found' });
  }
  removeBingAccount(id);
  return { ok: true };
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
  if (!cruxConfigured(site.workspace_id ?? null)) return reply.code(400).send({ error: 'CrUX API key not configured' });
  const result = await fetchCrux(site);
  return result ?? { error: 'Origin not in the CrUX dataset (insufficient traffic)' };
});

// ── AI citation tracking ─────────────────────────────────────────────────────

// Running a citation check calls out to paid LLM APIs — gate it behind the
// per-member ai_citations permission and a daily per-user cap so one
// click-happy member can't burn through a workspace's whole API budget.
// Super-admins and workspace owners are never capped.
const AI_CITATION_DAILY_LIMIT = parseInt(process.env.AI_CITATION_DAILY_LIMIT ?? '25', 10);
function assertAiCitationAllowed(req: unknown, cost = 1): void {
  const user = currentUser(req);
  if (user.is_super_admin) return;
  const wsId = requireWorkspace(req);
  if (!canUseAiCitations(user, wsId)) {
    throw Object.assign(new Error('AI Citations access is disabled for your account in this workspace. Ask a workspace admin.'), { statusCode: 403 });
  }
  if (workspaceRole(user, wsId) === 'owner') return; // owners are unrestricted in their own workspace
  const used = getQuotaUsage('ai_citations_run', `user:${user.id}`);
  if (used + cost > AI_CITATION_DAILY_LIMIT) {
    throw Object.assign(new Error(`Daily AI Citation check limit reached (${AI_CITATION_DAILY_LIMIT}/day). Ask a super-admin if you need more.`), { statusCode: 429 });
  }
  incrementQuota('ai_citations_run', `user:${user.id}`, cost);
}

app.get('/api/ai/providers', async (req) => ({
  all: PROVIDERS,
  configured: configuredProviders(currentWorkspace(req)),
}));

app.get('/api/ai/prompts', async (req) => listPrompts(currentWorkspace(req)));
app.get('/api/ai/migration', async (req) => getLegacyPromptPlan(requireWorkspace(req)));
app.post('/api/ai/migration', async (req, reply) => {
  const ws = requireWorkspace(req);
  const body = (req.body ?? {}) as LegacyPromptUpgrade;
  if (body.site_id && !canAccessSiteInWorkspace(currentUser(req), body.site_id, ws)) return reply.code(404).send({ error: 'Site not found' });
  if (body.cadence && !['manual','daily','weekly','monthly'].includes(body.cadence)) return reply.code(400).send({ error: 'Invalid cadence' });
  return upgradeLegacyPrompts(ws, body, currentUser(req).id);
});
app.post('/api/ai/prompts', async (req, reply) => {
  const wsId = currentWorkspace(req);
  const { prompt, site_id, category, group_name, locale, device, persona, cadence } = (req.body ?? {}) as {
    prompt?: string; site_id?: string; category?: PromptCategory; group_name?: string; locale?: string;
    device?: string; persona?: string; cadence?: PromptRow['cadence'];
  };
  if (!prompt?.trim()) return reply.code(400).send({ error: 'prompt required' });
  if (site_id && !canAccessSiteInWorkspace(currentUser(req), site_id, wsId)) return reply.code(404).send({ error: 'Site not found' });
  if (category && !PROMPT_CATEGORIES.includes(category)) return reply.code(400).send({ error: 'Invalid prompt category' });
  return addPrompt(prompt.trim(), site_id ?? null, wsId, category ?? 'discovery', { group_name, locale, device, persona, cadence });
});
app.patch('/api/ai/prompts/:id', async (req, reply) => {
  const ws = requireWorkspace(req); const id = Number((req.params as { id: string }).id);
  const body = (req.body ?? {}) as Partial<Pick<PromptRow, 'prompt' | 'site_id' | 'category' | 'group_name' | 'locale' | 'device' | 'persona' | 'cadence' | 'enabled'>>;
  if (body.site_id) assertSiteAccess(req, body.site_id);
  if (body.category && !PROMPT_CATEGORIES.includes(body.category)) return reply.code(400).send({ error: 'Invalid prompt category' });
  return updatePrompt(id, ws, body, currentUser(req).id) ?? reply.code(404).send({ error: 'Prompt not found' });
});
app.delete('/api/ai/prompts/:id', async (req) => {
  deletePrompt(Number((req.params as { id: string }).id), currentWorkspace(req));
  return { ok: true };
});

app.get('/api/ai/results', async (req) => getResults(200, currentWorkspace(req)));
app.get('/api/ai/insights', async (req, reply) => {
  const workspaceId = requireWorkspace(req);
  const query = (req.query ?? {}) as { scoped?: string; site_id?: string; days?: string };
  const siteScope = query.scoped === 'true' ? (query.site_id || null) : undefined;
  if (typeof siteScope === 'string' && !getSitesForWorkspace(workspaceId).some(site => site.id === siteScope)) {
    return reply.code(404).send({ error: 'Website not found' });
  }
  const requestedDays = Number(query.days);
  const days = requestedDays === 7 || requestedDays === 30 || requestedDays === 90 ? requestedDays : undefined;
  return getAiInsights(workspaceId, siteScope, days);
});
app.get('/api/ai/config', async (req) => {
  const wsId = currentWorkspace(req);
  const settings = wsId ? getWorkspaceSettings(wsId) : {};
  return { competitorDomains: settings.ai_competitor_domains ?? '', brandAliases: settings.ai_brand_aliases ?? '',
    identity: wsId ? getCitationIdentitySummary(wsId) : { aliases: [], ownedDomains: [], profiles: [] } };
});
app.put('/api/ai/config', async (req) => {
  const wsId = requireWorkspace(req);
  const body = (req.body ?? {}) as { competitorDomains?: string; brandAliases?: string };
  if (body.competitorDomains !== undefined) {
    const clean = String(body.competitorDomains).split(/[\s,]+/).map(domain => domain.trim()).filter(Boolean).slice(0, 100).join(', ');
    setWorkspaceSetting(wsId, 'ai_competitor_domains', clean);
  }
  if (body.brandAliases !== undefined) {
    const cleanAliases = String(body.brandAliases).split(/[\n,]+/).map(alias => alias.trim()).filter(Boolean).slice(0, 100).join('\n');
    setWorkspaceSetting(wsId, 'ai_brand_aliases', cleanAliases);
  }
  return { ok: true };
});
app.post('/api/ai/run/:promptId', async (req, reply) => {
  const promptId = Number((req.params as { promptId: string }).promptId);
  const wsId = currentWorkspace(req);
  if (!listPrompts(wsId).some(prompt => prompt.id === promptId)) return reply.code(404).send({ error: 'Prompt not found' });
  assertAiCitationAllowed(req);
  try {
    return { results: await runPrompt(promptId, wsId) };
  } catch (error) {
    if (error instanceof Error && error.message === 'Prompt not found') return reply.code(404).send({ error: 'Prompt not found' });
    throw error;
  }
});
app.post('/api/ai/run-all', { schema: runAllPromptsSchema }, async (req, reply) => {
  const wsId = currentWorkspace(req);
  const body = (req.body ?? {}) as { site_id?: string | null; scoped?: boolean };
  const siteScope = body.scoped ? (body.site_id ?? null) : undefined;
  if (typeof siteScope === 'string' && !getSitesForWorkspace(wsId ?? '').some(site => site.id === siteScope)) {
    return reply.code(404).send({ error: 'Website not found' });
  }
  const promptCount = listPrompts(wsId).filter(prompt => siteScope === undefined ? true : prompt.site_id === siteScope).length;
  assertAiCitationAllowed(req, Math.max(1, promptCount));
  return { ran: await runAllPrompts(wsId, siteScope) };
});

// Probe each configured provider's live model list (version-ranked) + the
// workspace's current selection. Used by the model picker.
app.get('/api/ai/models', async (req) => ({ providers: await probeModels(currentWorkspace(req)) }));

// Save per-provider model choices for the active workspace (owner only).
// Body: { model_openai?: string, model_anthropic?: string, ... }; empty clears.
app.put('/api/ai/models', async (req, reply) => {
  const wsId = requireWorkspace(req);
  if (!hasCapability(currentUser(req), wsId, 'manage_integrations')) return reply.status(403).send({ error: 'You do not have permission to manage AI integrations.' });
  const body = (req.body ?? {}) as Record<string, string>;
  for (const p of MODEL_PROVIDERS) {
    const k = `model_${p}`;
    if (body[k] !== undefined) setWorkspaceSetting(wsId, k, String(body[k]));
  }
  return { ok: true };
});

// Conversation thread for one prompt × provider (root run + follow-ups).
app.get('/api/ai/prompts/:id/thread/:provider', async (req) => {
  const { id, provider } = req.params as { id: string; provider: string };
  return getThread(Number(id), provider, currentWorkspace(req));
});

// Follow-up question in an existing thread — same provider, full context.
app.post('/api/ai/prompts/:id/reply', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { provider, message } = (req.body ?? {}) as { provider?: string; message?: string };
  if (!provider || !message?.trim()) return reply.code(400).send({ error: 'provider and message required' });
  if (!PROVIDERS.includes(provider as Provider)) return reply.code(400).send({ error: 'Unknown provider' });
  const wsId = currentWorkspace(req);
  if (!listPrompts(wsId).some(prompt => prompt.id === Number(id))) return reply.code(404).send({ error: 'Prompt not found' });
  assertAiCitationAllowed(req);
  try {
    return await replyInThread(Number(id), provider as Provider, message.trim(), wsId);
  } catch (e) {
    return reply.code(422).send({ error: e instanceof Error ? e.message : 'reply failed' });
  }
});

// One-click Gemini key using the linked Google account's OAuth.
app.post('/api/ai/provision/gemini', async (req, reply) => {
  const { account_id } = (req.body ?? {}) as { account_id?: string };
  // Scope to the workspace's own Google accounts — never fall back to another
  // tenant's account.
  const ws = currentWorkspace(req);
  const accounts = ws ? getGoogleAccountsForWorkspace(ws) : [];
  const account = account_id ? accounts.find(a => a.id === account_id) : accounts[0];
  if (!account) return reply.code(400).send({ error: 'No Google account linked yet (Accounts page).' });
  const result = await provisionGeminiKey(account.id, account.client_id, ws);
  if (!result.ok) return reply.code(422).send(result);
  return result;
});

registerPlatformRoutes(app);

await app.listen({ port: PORT, host: HOST });
console.log(`\n🚀 Organic Command running at http://${HOST}:${PORT}\n`);

// Bound the SQLite log table on long-lived installs (30-day retention).
try {
  const pruned = pruneOldLogs();
  if (pruned > 0) console.log(`Pruned ${pruned} log entries older than 30 days`);
} catch { /* non-fatal */ }

// Clear expired login sessions at startup.
try { pruneExpiredSessions(); } catch { /* non-fatal */ }

// Start scheduled indexing
startScheduler();

// Start nightly DB backup
startBackupScheduler();
