import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';

// OAuth 2.1 for MCP connectors: discovery from the 401, dynamic client
// registration, PKCE (S256 only), single-use codes, refresh rotation and
// revocation. The consent decision is made through decideRequest, which the
// dashboard calls for a signed-in user.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-oauth-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'oauth-test-secret-1234567890';

let app: FastifyInstance;
let oauth: typeof import('../mcp/oauth.js');
let tokens: typeof import('../mcp/tokens.js');
let userId = '';
let user: import('../auth/users.js').User;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const ORIGIN = 'http://localhost:80';

const verifier = 'v'.repeat(20) + randomUUID().replaceAll('-', '');
const challenge = createHash('sha256').update(verifier).digest('base64url');

beforeAll(async () => {
  const users = await import('../auth/users.js');
  const ws = await import('../auth/workspaces.js');
  oauth = await import('../mcp/oauth.js');
  tokens = await import('../mcp/tokens.js');
  const { registerMcpProtocolRoute } = await import('../mcp/http.js');
  user = users.createUser({ email: `oauth-${randomUUID()}@x.com`, password: 'password123' });
  ws.bootstrapUserWorkspace(user, false);
  userId = user.id;
  app = Fastify();
  oauth.registerMcpOAuthRoutes(app);
  registerMcpProtocolRoute(app);
  await app.ready();
});

afterAll(async () => { await app?.close(); });

async function register(redirects = [REDIRECT]) {
  const res = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Claude', redirect_uris: redirects, token_endpoint_auth_method: 'none' } });
  return { status: res.statusCode, body: res.json() as Record<string, string> };
}

async function authorize(clientId: string, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'mcp:read ads:write', ...extra });
  return app.inject({ method: 'GET', url: `/oauth/authorize?${query}` });
}

async function codeFor(clientId: string, scopes = ['mcp:read', 'ads:write']) {
  const res = await authorize(clientId);
  const requestId = new URL(res.headers.location as string, ORIGIN).searchParams.get('request')!;
  const decision = oauth.decideRequest(requestId, user, true, scopes, ORIGIN)!;
  const url = new URL(decision.redirect);
  expect(url.searchParams.get('state')).toBe('xyz');
  return url.searchParams.get('code')!;
}

function tokenRequest(form: Record<string, string>) {
  return app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(form).toString() });
}

describe('MCP OAuth', () => {
  it('advertises itself from the MCP 401 and the well-known documents', async () => {
    const res = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata="http://localhost:80/.well-known/oauth-protected-resource/mcp"');
    const resource = (await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' })).json();
    expect(resource.resource).toBe('http://localhost:80/mcp');
    const server = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(server.code_challenge_methods_supported).toEqual(['S256']);
    expect(server.registration_endpoint).toBe('http://localhost:80/oauth/register');
  });

  it('only registers safe redirect URIs', async () => {
    expect((await register(['http://evil.example.com/cb'])).status).toBe(400);
    expect((await register(['javascript:alert(1)'])).status).toBe(400);
    expect((await register(['http://127.0.0.1:33418/callback'])).status).toBe(201);
    expect((await register(['vscode://anthropic.claude/callback'])).status).toBe(201);
  });

  it('requires S256 PKCE and an exact redirect URI', async () => {
    const { body } = await register();
    const plain = await authorize(body.client_id, { code_challenge_method: 'plain' });
    expect(plain.statusCode).toBe(302);
    expect(plain.headers.location).toContain('error=invalid_request');
    const wrongRedirect = await authorize(body.client_id, { redirect_uri: 'https://claude.ai/other' });
    expect(wrongRedirect.statusCode).toBe(400);
    const ok = await authorize(body.client_id);
    expect(ok.headers.location).toMatch(/^\/oauth\/consent\?request=/);
  });

  it('issues tokens for a correct verifier, once, and they authenticate MCP', async () => {
    const { body } = await register();
    const badCode = await codeFor(body.client_id);
    const bad = await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code: badCode, code_verifier: 'x'.repeat(50), redirect_uri: REDIRECT });
    expect(bad.json().error).toBe('invalid_grant');
    // The code was consumed by the failed attempt.
    expect((await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code: badCode, code_verifier: verifier })).json().error).toBe('invalid_grant');

    const code = await codeFor(body.client_id);
    const res = await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
    expect(res.statusCode).toBe(200);
    const issued = res.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string };
    expect(issued.expires_in).toBe(3600);
    expect(issued.scope).toBe('mcp:read ads:write');
    const auth = tokens.authenticateMcpToken(issued.access_token)!;
    expect(auth.userId).toBe(userId);
    expect(auth.scopes.sort()).toEqual(['ads:write', 'mcp:read']);
    // OAuth tokens don't clutter the personal token list.
    expect(tokens.listMcpTokens(userId)).toEqual([]);
    expect(oauth.listConnectedApps(userId).some(a => a.client_name === 'Claude')).toBe(true);
    // Reusing the code fails.
    expect((await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code, code_verifier: verifier })).json().error).toBe('invalid_grant');
  });

  it('rotates refresh tokens and revokes the whole grant', async () => {
    const { body } = await register();
    const first = (await tokenRequest({ grant_type: 'authorization_code', client_id: body.client_id, code: await codeFor(body.client_id, ['mcp:read']), code_verifier: verifier })).json() as { access_token: string; refresh_token: string };
    const second = (await tokenRequest({ grant_type: 'refresh_token', client_id: body.client_id, refresh_token: first.refresh_token })).json() as { access_token: string; refresh_token: string; scope: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.scope).toBe('mcp:read');
    expect((await tokenRequest({ grant_type: 'refresh_token', client_id: body.client_id, refresh_token: first.refresh_token })).json().error).toBe('invalid_grant');
    // Another client can't use this refresh token.
    const other = (await register()).body;
    expect((await tokenRequest({ grant_type: 'refresh_token', client_id: other.client_id, refresh_token: second.refresh_token })).json().error).toBe('invalid_grant');

    const revoke = await app.inject({ method: 'POST', url: '/oauth/revoke', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ token: second.refresh_token, client_id: body.client_id }).toString() });
    expect(revoke.statusCode).toBe(200);
    expect(tokens.authenticateMcpToken(second.access_token)).toBeNull();
    expect((await tokenRequest({ grant_type: 'refresh_token', client_id: body.client_id, refresh_token: second.refresh_token })).json().error).toBe('invalid_grant');
  });

  it('sends the person back with access_denied when they decline', async () => {
    const { body } = await register();
    const res = await authorize(body.client_id);
    const requestId = new URL(res.headers.location as string, ORIGIN).searchParams.get('request')!;
    const decision = oauth.decideRequest(requestId, user, false, [], ORIGIN)!;
    expect(decision.redirect).toContain('error=access_denied');
    expect(oauth.decideRequest(requestId, user, true, [], ORIGIN)).toBeNull();
  });

  it('requires the secret for confidential clients', async () => {
    const res = await app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Server app', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' } });
    const client = res.json() as { client_id: string; client_secret: string };
    expect(client.client_secret).toMatch(/^mcps_/);
    const code = await codeFor(client.client_id);
    expect((await tokenRequest({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier })).statusCode).toBe(401);
    const code2 = await codeFor(client.client_id);
    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const ok = await app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` }, payload: new URLSearchParams({ grant_type: 'authorization_code', code: code2, code_verifier: verifier }).toString() });
    expect(ok.statusCode).toBe(200);
  });
});

describe('MCP OAuth redirect allowlist', () => {
  it('narrows registration to the operator\'s allowlist when set', async () => {
    const { validRedirectUri } = await import('../mcp/oauth.js');
    process.env.MCP_OAUTH_REDIRECT_ALLOWLIST = 'claude.ai, *.claude.com, localhost, vscode:';
    try {
      expect(validRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
      expect(validRedirectUri('https://app.claude.com/callback')).toBe(true);
      expect(validRedirectUri('http://localhost:6274/callback')).toBe(true);
      expect(validRedirectUri('vscode://anthropic.claude/cb')).toBe(true);
      expect(validRedirectUri('https://evil.example.com/cb')).toBe(false);
      expect(validRedirectUri('https://claude.ai.evil.com/cb')).toBe(false);
      expect(validRedirectUri('cursor://cb')).toBe(false);
    } finally {
      delete process.env.MCP_OAUTH_REDIRECT_ALLOWLIST;
    }
    expect(validRedirectUri('https://evil.example.com/cb')).toBe(true);
  });
});
