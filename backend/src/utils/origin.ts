/**
 * The public origin of this install. PUBLIC_URL wins (recommended behind a
 * proxy); otherwise it is derived from the request, which only reflects HTTPS
 * correctly when TRUST_PROXY lets Fastify read X-Forwarded-Proto.
 */
const PUBLIC_URL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL) : null;

export function publicOrigin(req: { protocol?: string; headers: Record<string, unknown> }): string {
  if (PUBLIC_URL) return PUBLIC_URL.origin;
  const protocol = req.protocol === 'https' ? 'https' : 'http';
  const host = String(req.headers.host ?? 'localhost');
  return `${protocol}://${host}`;
}
