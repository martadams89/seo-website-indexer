/**
 * reviews/connect-routes.ts — client connect links for Google Business Profile.
 *
 *   /api/reviews/connect-invites…  the agency creates, lists and revokes links (signed in)
 *   /api/connect/:token…           the client's page (no account): sign in, pick profiles
 *
 * See connect-invites.ts for how the link, the Google sign-in and the
 * browser binding fit together.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getWorkspace, canAccessWorkspace, hasCapability } from '../auth/workspaces.js';
import { getUserById, recordAuditEvent, type User } from '../auth/users.js';
import { createGoogleOAuthAuthorization, exchangeCodeForTokens, type PendingGoogleOAuth } from '../auth/google-oauth.js';
import { googleResultPage } from '../auth/google-result-page.js';
import { emailConfigured, sendEmail } from '../utils/email.js';
import { workspaceLink } from '../utils/links.js';
import { sendWorkspaceNotification } from '../utils/notify.js';
import { logSystem } from '../utils/logger.js';
import { ReviewsApiError } from './client.js';
import { discoverLocations, linkLocation } from './service.js';
import {
  bindInviteBrowser, canPick, canStart, createConnectInvite, findConnectInvite, getConnectInvite, inviteProject, inviteStatus, inviteToken,
  listConnectInvites, markInviteConnected, projectCredentials, recordSharedLocations, revokeConnectInvite, sharedLocations, type ConnectInvite,
} from './connect-invites.js';

const COOKIE = 'sei_connect';

interface Deps {
  /** Origin Google redirects back to (must be a redirect URI on the OAuth client). */
  redirectOrigin: (req: FastifyRequest) => string;
  /** Origin for links people open (PUBLIC_URL or the request's). */
  publicOrigin: (req: FastifyRequest) => string;
  secureCookies: (req: FastifyRequest) => boolean;
}

interface RequestContext { ctx?: { user: User; impersonator: User | null; workspaceId: string | null } }
const context = (req: FastifyRequest) => (req as unknown as RequestContext).ctx;

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode: status });
}

function handle<T>(fn: (req: FastifyRequest, reply: FastifyReply) => Promise<T> | T) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof ReviewsApiError) return reply.status(e.kind === 'QUOTA' ? 429 : 409).send({ error: e.message, kind: e.kind, hint: e.hint ?? null });
      const status = (e as { statusCode?: number }).statusCode;
      if (status) return reply.status(status).send({ error: (e as Error).message });
      throw e;
    }
  };
}

/** This browser's secret for one link, from the cookie set when it started the sign-in. */
function browserNonce(req: FastifyRequest, inviteId: string): string | null {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== COOKIE) continue;
    const [id, nonce] = decodeURIComponent(v.join('=')).split('.');
    if (id === inviteId && nonce) return nonce;
  }
  return null;
}

const inviterLabel = (invite: ConnectInvite) => { const u = invite.created_by ? getUserById(invite.created_by) : undefined; return u?.name || u?.email || null; };

function agencyView(invite: ConnectInvite, origin: string) {
  const status = inviteStatus(invite);
  const token = status === 'open' ? inviteToken(invite) : null;
  return {
    id: invite.id, status, client_name: invite.client_name, client_email: invite.client_email, project: inviteProject(invite),
    google_email: invite.google_email, shared_locations: sharedLocations(invite), expires_at: invite.expires_at, connected_at: invite.connected_at,
    created_at: invite.created_at, created_by: inviterLabel(invite), url: token ? `${origin}/connect/${token}` : null,
  };
}

/** The link, checked to still lead somewhere: the person who made it can still use the workspace. */
function liveInvite(token: string): { invite: ConnectInvite; inviter: User } {
  const invite = findConnectInvite(token);
  if (!invite) fail(404, 'This link isn\'t valid. Ask for a new one.');
  const inviter = invite.created_by ? getUserById(invite.created_by) : undefined;
  if (!inviter || inviter.disabled || !canAccessWorkspace(inviter, invite.workspace_id)) fail(410, 'This link no longer works. Ask for a new one.');
  return { invite, inviter };
}

async function locationsFor(invite: ConnectInvite) {
  const found = (await discoverLocations(invite.workspace_id, invite.google_account_id!)).connections[0];
  if (!found) fail(409, 'This Google account is no longer connected. Ask for a new link.');
  return {
    error: found.error, hint: found.hint,
    locations: found.accounts.flatMap(a => a.locations.map(l => ({
      account_name: a.account_name, account_title: a.account_title, location_name: l.location_name,
      title: l.title, address: l.address, shared: !!l.linked_location_id,
    }))),
    account_errors: found.accounts.filter(a => a.error).map(a => ({ account_title: a.account_title, error: a.error })),
  };
}

function notifyAgency(invite: ConnectInvite, title: string, body: string): void {
  const url = workspaceLink(invite.workspace_id, '/reviews?tab=locations');
  void sendWorkspaceNotification(invite.workspace_id, title, body, 'google_connection', { links: url ? [{ label: 'Open Business Profile', url }] : [] })
    .catch(() => false);
}

/** Google's callback for a sign-in started from a connect link. */
export async function completeConnectInvite(pending: PendingGoogleOAuth, code: string): Promise<string> {
  const back = pending.payload?.returnTo ?? null;
  const invite = pending.payload?.inviteId ? getConnectInvite(pending.payload.inviteId) : null;
  // A link revoked while the client was on Google's screen connects nothing.
  if (!invite || inviteStatus(invite) === 'revoked') {
    return googleResultPage({ ok: false, title: 'This link no longer works', message: 'Nothing was connected. Ask for a new link.', post: null, openerOrigin: null, returnTo: back, backLabel: 'Back' });
  }
  try {
    const connected = await exchangeCodeForTokens(code, pending.redirectUri, invite.workspace_id, pending.userId,
      { clientId: pending.clientId, clientSecret: pending.clientSecret });
    markInviteConnected(invite.id, connected.accountId, connected.email);
    recordAuditEvent({ actorUserId: invite.created_by, workspaceId: invite.workspace_id, action: 'google_reviews.client_connected', detail: { inviteId: invite.id, email: connected.email, client: invite.client_name } });
    notifyAgency(invite, `${connected.email} connected their Google Business Profile`,
      `${invite.client_name ? `${invite.client_name} used your connect link. ` : ''}They're choosing which profiles to share; each one is linked as soon as they do.`);
    return googleResultPage({
      ok: true, title: `Connected ${connected.email}`, message: 'Next, choose which of your Business Profiles to share.',
      post: null, openerOrigin: null, returnTo: back, backLabel: 'Continue',
    });
  } catch (e) {
    return googleResultPage({ ok: false, title: 'Your Google account wasn\'t connected', message: e instanceof Error ? e.message : String(e), post: null, openerOrigin: null, returnTo: back, backLabel: 'Back' });
  }
}

export function registerConnectRoutes(app: FastifyInstance, deps: Deps): void {
  // ── The agency's side ───────────────────────────────────────────────────────
  const agency = (req: FastifyRequest) => {
    const ctx = context(req);
    if (!ctx?.workspaceId) fail(400, 'No workspace selected.');
    return { user: ctx.user, actor: ctx.impersonator ?? ctx.user, workspaceId: ctx.workspaceId };
  };

  app.get('/api/reviews/connect-invites', handle(async (req) => {
    const { workspaceId } = agency(req);
    return listConnectInvites(workspaceId).map(i => agencyView(i, deps.publicOrigin(req)));
  }));

  app.post('/api/reviews/connect-invites', handle(async (req) => {
    const { user, actor, workspaceId } = agency(req);
    // A link adds a Google connection to the workspace, like connecting one yourself.
    if (!hasCapability(user, workspaceId, 'manage_integrations')) fail(403, 'Sending a connect link adds a Google connection, which needs the "Manage integrations and API keys" permission.');
    const body = (req.body ?? {}) as { projectFrom?: string; clientName?: string; clientEmail?: string; days?: number };
    const { invite, token } = createConnectInvite({
      workspaceId, userId: user.id, projectSource: String(body.projectFrom ?? ''), clientName: body.clientName, clientEmail: body.clientEmail, days: body.days,
    });
    const url = `${deps.publicOrigin(req)}/connect/${token}`;
    recordAuditEvent({ actorUserId: actor.id, workspaceId, action: 'google_reviews.connect_link_created', detail: { inviteId: invite.id, client: invite.client_name, email: invite.client_email } });
    let emailed = false;
    if (invite.client_email && emailConfigured()) {
      const from = user.name || user.email;
      const ws = getWorkspace(workspaceId)?.name;
      emailed = await sendEmail({
        to: invite.client_email,
        subject: `${from} asks to manage your Google Business Profile`,
        text: `${from}${ws ? ` (${ws})` : ''} would like to help manage your Google Business Profile: reviews, profile details, posts and photos.\n\nConnect your Google account here (the link works for ${Math.round((new Date(invite.expires_at).getTime() - Date.now()) / 86_400_000)} days):\n${url}\n\nYou choose which profiles to share, and can remove access at any time from your Google account.`,
        html: `<p>${escape(from)}${ws ? ` (${escape(ws)})` : ''} would like to help manage your Google Business Profile: reviews, profile details, posts and photos.</p><p><a href="${escape(url)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600">Connect your Business Profile</a></p><p>You choose which profiles to share, and can remove access at any time from your Google account.</p>`,
      }).catch(e => { logSystem('warn', `Connect link email to ${invite.client_email} failed: ${e instanceof Error ? e.message : String(e)}`); return false; });
    }
    return { ...agencyView(invite, deps.publicOrigin(req)), url, emailed };
  }));

  app.delete('/api/reviews/connect-invites/:id', handle(async (req) => {
    const { actor, workspaceId } = agency(req);
    const { id } = req.params as { id: string };
    if (!revokeConnectInvite(workspaceId, id)) fail(404, 'Link not found.');
    recordAuditEvent({ actorUserId: actor.id, workspaceId, action: 'google_reviews.connect_link_revoked', detail: { inviteId: id } });
    return { ok: true };
  }));

  // ── The client's side (no account; the link is the credential) ──────────────
  app.get('/api/connect/:token', handle(async (req) => {
    const { token } = req.params as { token: string };
    const { invite, inviter } = liveInvite(token);
    const nonce = browserNonce(req, invite.id);
    const pick = canPick(invite, nonce);
    return {
      status: inviteStatus(invite), workspace: getWorkspace(invite.workspace_id)?.name ?? null, from: inviter.name || inviter.email,
      client_name: invite.client_name, expires_at: invite.expires_at,
      can_start: canStart(invite, nonce), can_pick: pick,
      connected_email: pick ? invite.google_email : null, shared: pick ? sharedLocations(invite) : [],
    };
  }));

  app.post('/api/connect/:token/start', handle(async (req, reply) => {
    const { token } = req.params as { token: string };
    const { invite, inviter } = liveInvite(token);
    if (!canStart(invite, browserNonce(req, invite.id))) fail(409, inviteStatus(invite) === 'expired' ? 'This link has expired. Ask for a new one.' : 'This link has already been used.');
    const creds = projectCredentials(invite.project_source, invite.workspace_id, invite.created_by);
    if (!creds) fail(410, 'The Google project behind this link is no longer available. Ask for a new link.');
    const nonce = bindInviteBrowser(invite.id);
    reply.header('Set-Cookie', `${COOKIE}=${encodeURIComponent(`${invite.id}.${nonce}`)}; HttpOnly; Path=/api/connect; SameSite=Lax; Max-Age=${7 * 86400}${deps.secureCookies(req) ? '; Secure' : ''}`);
    const authorizationUrl = createGoogleOAuthAuthorization({
      userId: inviter.id, workspaceId: invite.workspace_id, redirectUri: `${deps.redirectOrigin(req)}/api/auth/google/callback`,
      clientId: creds.clientId, clientSecret: creds.clientSecret,
      // Business Profile and the email address only: nothing else is asked of the client.
      only: ['business'], business: true,
      returnTo: `/connect/${token}`, inviteId: invite.id,
    });
    return { authorizationUrl };
  }));

  app.get('/api/connect/:token/locations', handle(async (req) => {
    const { token } = req.params as { token: string };
    const { invite } = liveInvite(token);
    if (!canPick(invite, browserNonce(req, invite.id))) fail(403, 'Open this link in the browser you signed in to Google with.');
    return { email: invite.google_email, ...(await locationsFor(invite)) };
  }));

  app.post('/api/connect/:token/locations', handle(async (req) => {
    const { token } = req.params as { token: string };
    const { invite } = liveInvite(token);
    if (!canPick(invite, browserNonce(req, invite.id))) fail(403, 'Open this link in the browser you signed in to Google with.');
    const wanted = (((req.body ?? {}) as { locations?: Array<{ accountName?: string; locationName?: string }> }).locations ?? []).slice(0, 50);
    if (!wanted.length) fail(400, 'Choose at least one profile to share.');
    // Only profiles this Google account can see, as listed to the client.
    const available = (await locationsFor(invite)).locations;
    const shared: string[] = [];
    const errors: Array<{ location: string; error: string }> = [];
    for (const w of wanted) {
      const match = available.find(l => l.account_name === w.accountName && l.location_name === w.locationName);
      if (!match) { errors.push({ location: String(w.locationName ?? ''), error: 'Not one of this Google account\'s profiles.' }); continue; }
      try {
        const linked = await linkLocation({ workspaceId: invite.workspace_id, googleAccountId: invite.google_account_id!, accountName: match.account_name, locationName: match.location_name, userId: invite.created_by });
        shared.push(linked.title ?? match.title ?? match.location_name);
      } catch (e) {
        errors.push({ location: match.title ?? match.location_name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (shared.length) {
      recordSharedLocations(invite.id, shared);
      recordAuditEvent({ actorUserId: invite.created_by, workspaceId: invite.workspace_id, action: 'google_reviews.client_shared_locations', detail: { inviteId: invite.id, email: invite.google_email, locations: shared } });
      notifyAgency(invite, `${invite.google_email ?? 'A client'} shared ${shared.length} Business Profile${shared.length === 1 ? '' : 's'}`, shared.map(s => `• ${s}`).join('\n'));
    }
    return { shared, errors };
  }));
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
