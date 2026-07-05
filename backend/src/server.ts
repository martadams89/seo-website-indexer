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
import QRCode from 'qrcode';

import {
  getAllSites,
  getSitesForWorkspace,
  getSiteById,
  upsertSite,
  deleteSite,
  setSiteLlmsContent,
  getAllSettings,
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
  getGoogleAccountById,
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
import { getOverview, getSiteDetail, getAlerts, ackAlert, alertInWorkspace, snapshotAllSites, recordAlert } from './analytics/stats.js';
import { auditSiteLlms } from './indexer/llms-audit.js';
import { snapshotSiteAgentReadiness, getAgentReadinessHistory } from './analytics/agent-readiness-store.js';
import { generateLlmsTxt, llmsGenerationProvider } from './ai/generate-llms.js';
import { probeModels, MODEL_PROVIDERS } from './ai/models.js';
import { getBingQuota, submitToBingInBatches, deriveBingSiteUrl } from './indexer/bing.js';
import { getGooglePerformance, getBingPerformance, getBingCrawlIssues, getGoogleDimension } from './indexer/performance.js';
import { snapshotSitePerformance, getWowDeltas, getQueryTrend, getTrackableQueries, listTrackedQueries, addTrackedQuery, removeTrackedQuery, getPortfolioMovers } from './analytics/perf-store.js';
import { checkSiteHygiene } from './indexer/hygiene.js';
import { listPrompts, addPrompt, deletePrompt, getResults, runPrompt, runAllPrompts, configuredProviders, PROVIDERS, getThread, replyInThread, type Provider } from './ai/citations.js';
import { fetchCrux, cruxConfigured } from './ai/crux.js';
import { logSystem } from './utils/logger.js';
import { provisionGeminiKey } from './ai/provision.js';
import {
  countUsers, getUserByEmail, createUser, verifyPassword, recordLogin,
  createSession, getSessionUser, destroySession, setUserPassword,
  generateTotpSecret, totpUri, verifyTotp, setTotpSecret, getTotpSecret, enableTotp, disableTotp,
  toPublic, pruneExpiredSessions, listUsers, getUserById,
  countSuperAdmins, setUserSuperAdmin, deleteUser,
  createPasswordReset, consumePasswordReset, type User,
} from './auth/users.js';
import { emailConfigured, sendEmail } from './utils/email.js';
import { sendTestNotification, configuredChannels, NOTIFY_KEYS } from './utils/notify.js';
import {
  createWorkspace, getWorkspace, renameWorkspace, deleteWorkspace, accessibleWorkspaces,
  canAccessWorkspace, canManageWorkspace, canAccessSite, bootstrapUserWorkspace,
  listWorkspaceMembers, addWorkspaceMember, removeWorkspaceMember, reassignOwnedWorkspaces,
  addBingAccount, listBingAccounts, removeBingAccount, bingAccountWorkspace, bingKeyForSite,
} from './auth/workspaces.js';
import {
  beginRegistration, finishRegistration, beginAuthentication, finishAuthentication,
  listPasskeys, deletePasskey,
} from './auth/passkeys.js';
import { ssoProviders, ssoAuthorizeUrl, ssoHandleCallback } from './auth/sso.js';
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
  '/api/auth/passkeys/login/start', '/api/auth/passkeys/login/finish', '/api/auth/sso/providers',
  '/api/auth/forgot-password', '/api/auth/reset-password',
]);
// Pre-auth path prefixes (dynamic segments) — e.g. the SSO provider redirect
// and callback which the identity provider hits with no session.
const AUTH_OPEN_PREFIXES = ['/api/auth/sso/'];
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
  const user = getSessionUser(sessionTokenFromReq(req));
  if (!user) {
    return reply.status(401).send({ error: 'Not authenticated', needsBootstrap: countUsers() === 0 });
  }
  // Resolve the active workspace from the X-Workspace-Id header (the UI's
  // workspace switcher sets it), validating access; fall back to the user's
  // first accessible workspace. This is the tenant scope for the request.
  const wsHeader = req.headers['x-workspace-id'];
  const accessible = accessibleWorkspaces(user);
  let activeWs: string | null = null;
  if (typeof wsHeader === 'string' && accessible.some(w => w.id === wsHeader)) activeWs = wsHeader;
  else if (accessible.length > 0) activeWs = accessible[0].id;
  (req as unknown as RequestCtx).ctx = { user, workspaceId: activeWs };
});

interface RequestCtx { ctx: { user: User; workspaceId: string | null } }

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
  if (siteId && !canAccessSite(ctx.user, siteId)) {
    return reply.status(404).send({ error: 'Site not found' });
  }
});

// Cookie helpers — HttpOnly session cookie, Secure behind https/proxy.
function setSessionCookie(req: { headers: Record<string, unknown> }, reply: { header: (k: string, v: string) => void }, token: string) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').includes('https');
  reply.header('Set-Cookie',
    `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${proto ? '; Secure' : ''}`);
}
function clearSessionCookie(reply: { header: (k: string, v: string) => void }) {
  reply.header('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}
// WebAuthn relying-party id (the registrable domain, no port) + origin, derived
// from the request so one build works on localhost and any deployed host.
function rpInfo(req: { headers: Record<string, unknown> }): { rpID: string; origin: string } {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').includes('https') ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers['host'] ?? 'localhost');
  const rpID = host.split(':')[0];
  return { rpID, origin: `${proto}://${host}` };
}
function currentUser(req: unknown): User { return (req as RequestCtx).ctx.user; }
function currentWorkspace(req: unknown): string | null { return (req as RequestCtx).ctx.workspaceId; }
// Guards — throw a 403-shaped error the handlers turn into a reply.
function requireWorkspace(req: unknown): string {
  const ws = currentWorkspace(req);
  if (!ws) throw Object.assign(new Error('No workspace selected. Create one first.'), { statusCode: 400 });
  return ws;
}
function assertSiteAccess(req: unknown, siteId: string): void {
  if (!canAccessSite(currentUser(req), siteId)) {
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

app.get('/api/status', async (req) => {
  const auth = await getAuthStatus();
  const cronSchedule = getSetting('cron_schedule') ?? '0 3 * * *';
  const lock = getRunLock();
  // Counts are tenant-scoped: a user sees their active workspace's totals, not
  // the whole install's.
  const ws = currentWorkspace(req);
  return {
    auth,
    scheduler: {
      running: isRunning(),
      currentRunId: getCurrentRunId(),
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
  const user = getSessionUser(token);
  if (!user) return reply.status(401).send({ error: 'Not authenticated', needsBootstrap: countUsers() === 0 });
  return toPublic(user);
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
  return { ok: true };
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
  }));
});

app.post('/api/workspaces', async (req, reply) => {
  const { name } = (req.body ?? {}) as { name?: string };
  if (!name?.trim()) return reply.status(400).send({ error: 'name is required.' });
  const ws = createWorkspace(name, currentUser(req).id);
  return { id: ws.id, name: ws.name, created_at: ws.created_at, is_owner: true };
});

app.patch('/api/workspaces/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!canManageWorkspace(currentUser(req), id)) return reply.status(404).send({ error: 'Workspace not found' });
  const { name } = (req.body ?? {}) as { name?: string };
  if (!name?.trim()) return reply.status(400).send({ error: 'name is required.' });
  renameWorkspace(id, name);
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
  const { email, role } = (req.body ?? {}) as { email?: string; role?: string };
  if (!email?.trim()) return reply.status(400).send({ error: 'email is required.' });
  const target = getUserByEmail(email.trim().toLowerCase());
  if (!target) return reply.status(404).send({ error: 'No user with that email. Create the user first.' });
  addWorkspaceMember(id, target.id, role === 'admin' ? 'admin' : 'member');
  return { ok: true };
});

app.delete('/api/workspaces/:id/members/:userId', async (req, reply) => {
  const { id, userId } = req.params as { id: string; userId: string };
  if (!canManageWorkspace(currentUser(req), id)) return reply.status(404).send({ error: 'Workspace not found' });
  const ws = getWorkspace(id);
  if (ws && ws.owner_user_id === userId) return reply.status(400).send({ error: 'The owner cannot be removed.' });
  removeWorkspaceMember(id, userId);
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
  const { email, password, name, role, superAdmin } = (req.body ?? {}) as
    { email?: string; password?: string; name?: string; role?: string; superAdmin?: boolean };
  if (!email?.trim() || !password) return reply.status(400).send({ error: 'email and password are required.' });
  if (getUserByEmail(email.trim().toLowerCase())) return reply.status(409).send({ error: 'A user with that email already exists.' });
  const user = createUser({ email: email.trim().toLowerCase(), password, name, role: role ?? 'user', superAdmin: !!superAdmin });
  // New users get their own default workspace so they can start immediately.
  bootstrapUserWorkspace(user, false);
  return toPublic(user);
});

app.patch('/api/users/:id', async (req, reply) => {
  if (!requireSuperAdmin(req, reply)) return;
  const { id } = req.params as { id: string };
  const target = getUserById(id);
  if (!target) return reply.status(404).send({ error: 'User not found' });
  const { password, superAdmin } = (req.body ?? {}) as { password?: string; superAdmin?: boolean };
  if (typeof password === 'string' && password) setUserPassword(id, password);
  if (typeof superAdmin === 'boolean') {
    // Never let the last super-admin drop their own privilege and lock everyone out.
    if (!superAdmin && target.is_super_admin && countSuperAdmins() <= 1) {
      return reply.status(400).send({ error: 'At least one super-admin must remain.' });
    }
    setUserSuperAdmin(id, superAdmin);
  }
  return { ok: true };
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
  deleteUser(id);
  return { ok: true, reassignedWorkspaces: moved };
});

// ── Google Search Console auth ────────────────────────────────────────────────

app.get('/api/auth/accounts', async (req) => {
  const ws = currentWorkspace(req);
  const accounts = ws ? getGoogleAccountsForWorkspace(ws) : [];
  return accounts.map(acc => ({
    id: acc.id,
    email: acc.email,
    client_id: acc.client_id,
    created_at: acc.created_at,
  }));
});

app.delete('/api/auth/accounts/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  // Only disconnect an account that lives in a workspace the caller can access.
  const acc = getGoogleAccountById(id);
  if (!acc) return reply.code(404).send({ error: 'Account not found' });
  const ws = acc.workspace_id ?? null;
  const allowed = ws ? canAccessWorkspace(currentUser(req), ws) : currentUser(req).is_super_admin;
  if (!allowed) return reply.code(404).send({ error: 'Account not found' });
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

  // The popup carries the active workspace in `state` (the tenant to attach this
  // Google account to). This route is open (Google redirects here with no
  // header), so resolve the caller from the session cookie and only honour a
  // `state` the user may actually access; otherwise fall back to their first
  // workspace. Prevents a crafted state from parking an account in a foreign tenant.
  const sessionUser = getSessionUser(sessionTokenFromReq(req));
  let workspaceId: string | null = null;
  if (sessionUser) {
    const accessible = accessibleWorkspaces(sessionUser);
    if (state && accessible.some(w => w.id === state)) workspaceId = state;
    else if (accessible.length > 0) workspaceId = accessible[0].id;
  }

  try {
    await exchangeCodeForTokens(code, redirectUri, workspaceId);
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
  const ws = currentWorkspace(req);
  try {
    if (accountId) {
      // Authorize: the account must belong to the active workspace.
      const acc = getGoogleAccountById(accountId);
      if (!acc || (acc.workspace_id ?? null) !== ws) {
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
  const workspaceId = requireWorkspace(req);
  // A site may only be linked to a Google account in its own workspace.
  if (googleAccountId) {
    const acc = getGoogleAccountById(googleAccountId);
    if (!acc || (acc.workspace_id ?? null) !== workspaceId) {
      return reply.status(400).send({ error: 'That Google account is not in this workspace.' });
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

  // Validate the FK target exists AND lives in this site's workspace, otherwise
  // the upsert would either throw or link across a tenant boundary.
  if (incomingAccountId) {
    const acc = getGoogleAccountById(incomingAccountId);
    if (!acc || (acc.workspace_id ?? null) !== (existing.workspace_id ?? null)) {
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

// Platform-level (instance) settings the frontend may read plainly. Notification
// channels are NOT here — they're per-workspace now (see /api/notifications/*).
const PUBLIC_SETTINGS = ['cron_schedule', 'google_project_id'];
// Write-only secrets: settable via PUT, never echoed back — GET returns
// `<key>_configured` booleans instead. These are the PLATFORM DEFAULTS; each
// workspace can override any of them (see /api/workspace/keys).
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
  if (!canManageWorkspace(currentUser(req), wsId)) return reply.status(403).send({ error: 'Only the workspace owner can change its keys.' });
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
  if (!canManageWorkspace(currentUser(req), wsId)) return reply.status(403).send({ error: 'Only the workspace owner can change notifications.' });
  const body = (req.body ?? {}) as Record<string, string>;
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

// ── Quota Usage ───────────────────────────────────────────────────────────────

app.get('/api/quota/today', async (req) => {
  const { day } = (req.query ?? {}) as { day?: string };
  const targetDay = day ?? new Date().toISOString().slice(0, 10);

  // Tenant scope: only count quota buckets that belong to this workspace, so the
  // bucket names (site ids, GSC property URLs, account ids) can't reveal other
  // tenants. Buckets are keyed `site:<id>`, `property:<gscUrl>`, `account:<id>`
  // or `project:<id>`. Google-indexing usage is summed from the `account:`
  // buckets (each success also writes a `project:` bucket; using accounts avoids
  // both the double-count and any cross-tenant project attribution).
  const ws = currentWorkspace(req);
  const wsSites = ws ? getSitesForWorkspace(ws) : [];
  const siteIds = new Set(wsSites.map(s => s.id));
  const gscUrls = new Set(wsSites.map(s => s.gsc_url));
  const accounts = ws ? getGoogleAccountsForWorkspace(ws) : [];
  const accountIds = new Set(accounts.map(a => a.id));
  const inWorkspace = (bucket: string): boolean => {
    if (bucket.startsWith('site:')) return siteIds.has(bucket.slice(5));
    if (bucket.startsWith('property:')) return gscUrls.has(bucket.slice('property:'.length));
    if (bucket.startsWith('account:')) return accountIds.has(bucket.slice('account:'.length));
    return false; // project: and anything else — excluded from the tenant view
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

app.get('/api/url-failures', async (req) => {
  // Only failures for sites in the active workspace.
  const ws = currentWorkspace(req);
  const siteIds = new Set(ws ? getSitesForWorkspace(ws).map(s => s.id) : []);
  return getAllUrlFailures().filter(f => siteIds.has(f.site_id));
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

app.get('/api/analytics/overview', async (req) => getOverview(currentWorkspace(req)));

app.get('/api/analytics/site/:id', async (req, reply) => {
  const detail = getSiteDetail((req.params as { id: string }).id);
  if (!detail) return reply.code(404).send({ error: 'Site not found' });
  return detail;
});

app.post('/api/analytics/snapshot', async () => ({ snapshots: snapshotAllSites().length }));

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
  const dimension = q.dimension === 'device' ? 'device' : 'country';
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
    } else if (isRunning()) {
      result.google = { error: 'A run is already in progress.' };
    } else {
      try {
        const runId = await runIndexing({ trigger: 'manual', siteIds: [site.id], skipIndexNow: true, skipBing: true });
        result.google = { runId };
      } catch (e) {
        result.google = { error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  if (targets.includes('bing')) {
    const apiKey = bingKeyForSite(site.id);
    if (!apiKey) {
      result.bing = { error: 'No Bing Webmaster API key configured.' };
    } else {
      try {
        const results = await submitToBingInBatches(apiKey, deriveBingSiteUrl(site.gsc_url, site.domain), list);
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
  // Drift only matters when the tool owns the files; hand-maintained (monitor-
  // only) sites are EXPECTED to be richer than the generated baseline.
  if (audit.drift && site.geo_manage) {
    recordAlert(site.id, 'llms_drift', `${site.domain}: live llms.txt differs from generated version`, 'info');
  }
  // Surface any saved custom (AI-generated / edited) llms.txt + whether an AI
  // provider is available to generate one.
  return { ...audit, custom: site.llms_txt_content ?? null, aiProvider: llmsGenerationProvider() };
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
  const apiKey = bingKeyForSite(site.id);
  if (!apiKey) return reply.code(400).send({ error: 'Bing API key not configured' });
  const quota = await getBingQuota(apiKey, deriveBingSiteUrl(site.gsc_url, site.domain));
  if (!quota) return reply.code(502).send({ error: 'Bing quota unavailable — check the API key and that the site is verified in Bing Webmaster Tools' });
  // Keep the response shape the dashboard expects.
  return { DailyQuota: quota.dailyQuota, MonthlyQuota: quota.monthlyQuota };
});

app.post('/api/bing/submit/:siteId', async (req, reply) => {
  const site = getSiteById((req.params as { siteId: string }).siteId);
  if (!site) return reply.code(404).send({ error: 'Site not found' });
  const apiKey = bingKeyForSite(site.id);
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

// ── Bing accounts (multiple per workspace) ───────────────────────────────────
// Each workspace can hold several Bing Webmaster API keys; a site either picks
// one (site.bing_account_id) or falls back to the workspace's first.

app.get('/api/bing/accounts', async (req) => {
  const ws = currentWorkspace(req);
  return ws ? listBingAccounts(ws) : [];
});

app.post('/api/bing/accounts', async (req, reply) => {
  const ws = requireWorkspace(req);
  const { name, apiKey } = (req.body ?? {}) as { name?: string; apiKey?: string };
  if (!apiKey?.trim()) return reply.code(400).send({ error: 'apiKey is required.' });
  const acc = addBingAccount(ws, name ?? 'Bing account', apiKey);
  return { id: acc.id, name: acc.name, created_at: acc.created_at };
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
  results: await runPrompt(Number((req.params as { promptId: string }).promptId), currentWorkspace(req)),
}));
app.post('/api/ai/run-all', async (req) => ({ ran: await runAllPrompts(currentWorkspace(req)) }));

// Probe each configured provider's live model list (version-ranked) + the
// workspace's current selection. Used by the model picker.
app.get('/api/ai/models', async (req) => ({ providers: await probeModels(currentWorkspace(req)) }));

// Save per-provider model choices for the active workspace (owner only).
// Body: { model_openai?: string, model_anthropic?: string, ... }; empty clears.
app.put('/api/ai/models', async (req, reply) => {
  const wsId = requireWorkspace(req);
  if (!canManageWorkspace(currentUser(req), wsId)) return reply.status(403).send({ error: 'Only the workspace owner can change model selection.' });
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
  return getThread(Number(id), provider);
});

// Follow-up question in an existing thread — same provider, full context.
app.post('/api/ai/prompts/:id/reply', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { provider, message } = (req.body ?? {}) as { provider?: string; message?: string };
  if (!provider || !message?.trim()) return reply.code(400).send({ error: 'provider and message required' });
  try {
    return await replyInThread(Number(id), provider as Provider, message.trim(), currentWorkspace(req));
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


await app.listen({ port: PORT, host: HOST });
console.log(`\n🚀 SEO Website Indexer running at http://localhost:${PORT}\n`);

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
