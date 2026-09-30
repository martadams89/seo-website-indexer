import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// End-to-end protocol check: boot the real /mcp route, then drive it with the
// official MCP client over Streamable HTTP — initialize, tools/list, tools/call.
// This is what a real Claude connector does, so it validates the SDK↔Fastify
// wiring (bearer auth, hijack, stateless transport) that unit tests can't.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-mcp-proto-'));
process.env.DATA_DIR = TMP;
process.env.APP_SECRET = 'mcp-proto-secret-1234567890';

let app: FastifyInstance;
let baseUrl: string;
let goodToken: string;

beforeAll(async () => {
  const db = await import('../db/database.js');
  const users = await import('../auth/users.js');
  const ws = await import('../auth/workspaces.js');
  const { createMcpToken } = await import('../mcp/tokens.js');
  const { registerMcpProtocolRoute } = await import('../mcp/http.js');

  const user = users.createUser({ email: `proto-${randomUUID()}@x.com`, password: 'password123' });
  const workspace = ws.bootstrapUserWorkspace(user, false);
  db.upsertSite({
    id: `s-${randomUUID().slice(0, 8)}`, name: 'Proto', domain: 'proto.example.com',
    sitemap_url: 'https://proto.example.com/sitemap.xml', gsc_url: 'https://proto.example.com/',
    enabled: 1, workspace_id: workspace.id,
  });
  goodToken = createMcpToken({ userId: user.id, name: 'proto', scopes: ['mcp:read'] }).token;

  app = Fastify();
  registerMcpProtocolRoute(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => { await app?.close(); });

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

describe('MCP Streamable HTTP protocol', () => {
  it('completes initialize + tools/list + tools/call over the real transport', async () => {
    const client = await connect(goodToken);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map(t => t.name);
      expect(names).toContain('list_sites');
      expect(names).toContain('list_workspaces');
      // read-only token: write tools are not advertised
      expect(names).not.toContain('trigger_indexing_run');

      const res = await client.callTool({ name: 'list_sites', arguments: {} });
      const content = res.content as Array<{ type: string; text?: string }>;
      const text = content.find(c => c.type === 'text')?.text ?? '';
      expect(text).toContain('proto.example.com');
    } finally {
      await client.close();
    }
  });

  it('rejects a missing or invalid bearer token', async () => {
    await expect(connect('seomcp_definitely-not-valid')).rejects.toThrow();
  });
});
