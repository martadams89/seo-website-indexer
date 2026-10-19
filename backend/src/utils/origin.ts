/**
 * The public origin of this install: the base for Google/Bing/SSO callbacks,
 * the MCP server URL and OAuth issuer, and links back to the dashboard.
 *
 * PUBLIC_URL always wins. Otherwise the host comes from the request and the
 * scheme is https unless the host is a local or LAN address. Behind a reverse
 * proxy that terminates TLS the app only sees plain http, and Google and
 * hosted AI apps reject http callbacks and servers, so a public hostname is
 * never given an http:// origin. Set PUBLIC_URL=http://… to serve plain http
 * on a public name.
 */
const PUBLIC_URL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL) : null;

type OriginRequest = { protocol?: string; headers: Record<string, unknown> };

/** Hosts reached on this machine or a private network, where plain http is normal. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost')
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') // IPv4 and IPv6 literals
    || !h.includes('.') // single-label names: Docker services, NAS hostnames
    || /\.(local|lan|internal|home\.arpa|test)$/.test(h);
}

/**
 * Whether the request evidently arrived over HTTPS, directly or through a
 * TLS-terminating proxy. Forwarded headers are only used to upgrade to https,
 * so a forged one can't downgrade anything.
 */
export function cameOverHttps(req: OriginRequest): boolean {
  if (req.protocol === 'https') return true;
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
  if (forwardedProto === 'https') return true;
  return /(?:^|[;,\s])proto=(?:"?)https\b/i.test(String(req.headers.forwarded ?? ''));
}

export function publicOrigin(req: OriginRequest): string {
  if (PUBLIC_URL) return PUBLIC_URL.origin;
  const host = String(req.headers.host ?? 'localhost');
  let hostname = host;
  try { hostname = new URL(`http://${host}`).hostname; } catch { /* keep the raw Host header */ }
  return `${cameOverHttps(req) || !isLocalHost(hostname) ? 'https' : 'http'}://${host}`;
}

/** Whether session cookies can carry the Secure flag: only on evidence of HTTPS, so a plain-http install can still sign in. */
export function secureCookies(req: OriginRequest): boolean {
  return PUBLIC_URL ? PUBLIC_URL.protocol === 'https:' : cameOverHttps(req);
}
