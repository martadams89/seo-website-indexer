/**
 * mcp/http.ts — the public MCP protocol endpoint (Streamable HTTP transport).
 *
 * `POST /mcp` speaks the Model Context Protocol. It authenticates with a per-user
 * bearer token (Authorization: Bearer seomcp_…), builds a fresh, statelessly-
 * scoped MCP server for that token's user, and hands the request to the official
 * SDK transport. Stateless (a new server+transport per request) keeps every call
 * re-authenticated and avoids cross-request session state.
 *
 * This route lives OUTSIDE the /api/* middleware (no session, no CSRF header, no
 * workspace gate) on purpose — it does its own bearer authentication.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticateMcpToken } from './tokens.js';
import { buildContext, buildMcpServer } from './tools.js';

function bearer(req: FastifyRequest): string | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const raw = header.slice('Bearer '.length).trim();
  return raw || null;
}

function unauthorized(reply: FastifyReply, message: string) {
  return reply
    .code(401)
    .header('WWW-Authenticate', 'Bearer realm="mcp", error="invalid_token"')
    .send({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
}

export function registerMcpProtocolRoute(app: FastifyInstance): void {
  app.post('/mcp', async (req, reply) => {
    const raw = bearer(req);
    if (!raw) return unauthorized(reply, 'Missing bearer token. Create one under Settings → API & MCP access.');
    const auth = authenticateMcpToken(raw);
    if (!auth) return unauthorized(reply, 'Invalid, expired or revoked MCP token.');
    const ctx = buildContext(auth);
    if (!ctx) return unauthorized(reply, 'The user for this token no longer exists or is disabled.');

    // Stateless: a fresh server + transport per request. Hand Fastify's raw
    // req/res to the SDK and stop Fastify from also replying.
    const server = buildMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
      }
    }
  });

  // The Streamable HTTP spec also defines GET (server→client SSE stream) and
  // DELETE (session teardown). This server is stateless and tools-only, so it
  // advertises neither — reply 405 with the allowed method.
  for (const method of ['get', 'delete'] as const) {
    app[method]('/mcp', async (_req, reply) =>
      reply.code(405).header('Allow', 'POST').send({
        jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This MCP server is stateless; use POST.' }, id: null,
      }));
  }
}
