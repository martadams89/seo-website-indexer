import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface OutboundUrlOptions {
  label?: string;
  allowHttp?: boolean;
  allowPrivate?: boolean;
  maxRedirects?: number;
}

const truthy = (value: string | undefined) => ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase());

function configuredAllowlist(): string[] {
  return (process.env.OUTBOUND_HOST_ALLOWLIST ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowlisted(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return configuredAllowlist().some(pattern => {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function inIpv4Range(address: string, network: string, prefix: number): boolean {
  const bits = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & bits) === (ipv4Number(network) & bits);
}

/**
 * Reject every non-public address family used for loopback, private networks,
 * link-local services, carrier NAT, documentation, benchmarking and multicast.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([network, prefix]) => inIpv4Range(address, network as string, prefix as number));
  }
  if (version === 6) {
    const value = address.toLowerCase();
    // IPv4-compatible and mapped forms can encode a private IPv4 address in
    // compressed hexadecimal (for example ::7f00:1 or ::ffff:7f00:1). The
    // whole ::/96 block is reserved, so reject it rather than trying to decode
    // every alternate representation.
    if (value.startsWith('::')) return true;
    return value.startsWith('fc') || value.startsWith('fd')
      || /^fe[89ab]/.test(value)
      || /^fe[c-f]/.test(value)
      || value.startsWith('ff')
      || value.startsWith('2001:db8:');
  }
  return false;
}

function privateTargetsAllowed(options: OutboundUrlOptions): boolean {
  return options.allowPrivate === true || truthy(process.env.ALLOW_PRIVATE_OUTBOUND);
}

function httpAllowed(options: OutboundUrlOptions): boolean {
  return options.allowHttp === true || truthy(process.env.ALLOW_INSECURE_OUTBOUND);
}

/** Synchronous validation used when accepting a configuration value. */
export function validateOutboundUrl(value: string | URL, options: OutboundUrlOptions = {}): URL {
  const label = options.label ?? 'Outbound URL';
  let target: URL;
  try {
    target = value instanceof URL ? new URL(value) : new URL(value);
  } catch {
    throw new Error(`${label} is not a valid absolute URL.`);
  }

  if (!['https:', 'http:'].includes(target.protocol)) throw new Error(`${label} must use HTTPS.`);
  if (target.protocol === 'http:' && !httpAllowed(options)) {
    throw new Error(`${label} must use HTTPS. Set ALLOW_INSECURE_OUTBOUND=true only for a trusted legacy target.`);
  }
  if (target.username || target.password) throw new Error(`${label} must not contain credentials in the URL.`);
  if (!target.hostname) throw new Error(`${label} must include a hostname.`);

  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const explicitPrivate = hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal')
    || (isIP(hostname) > 0 && isPrivateAddress(hostname));
  if (explicitPrivate && !privateTargetsAllowed(options) && !hostAllowlisted(hostname)) {
    throw new Error(`${label} cannot target a private, local or reserved address.`);
  }
  return target;
}

export async function assertSafeHostname(hostname: string, options: OutboundUrlOptions = {}): Promise<string> {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new Error(`${options.label ?? 'Outbound host'} is required.`);
  const explicitPrivate = host === 'localhost' || host.endsWith('.localhost')
    || host.endsWith('.local') || host.endsWith('.internal')
    || (isIP(host) > 0 && isPrivateAddress(host));
  if (explicitPrivate && !privateTargetsAllowed(options) && !hostAllowlisted(host)) {
    throw new Error(`${options.label ?? 'Outbound host'} cannot target a private, local or reserved address.`);
  }
  if (privateTargetsAllowed(options) || hostAllowlisted(host) || isIP(host) > 0 || process.env.NODE_ENV === 'test') return host;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`${options.label ?? 'Outbound host'} could not be resolved.`);
  }
  if (!addresses.length || addresses.some(result => isPrivateAddress(result.address))) {
    throw new Error(`${options.label ?? 'Outbound host'} resolves to a private or reserved address.`);
  }
  return host;
}

/** Resolve the hostname before the request so private DNS answers are blocked. */
export async function assertSafeOutboundUrl(value: string | URL, options: OutboundUrlOptions = {}): Promise<URL> {
  const target = validateOutboundUrl(value, options);
  await assertSafeHostname(target.hostname, options);
  return target;
}

/** Read a response without allowing an untrusted server to exhaust memory. */
export async function readResponseText(response: Response, maxBytes: number, label = 'Outbound response'): Promise<string> {
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${label} is larger than ${maxBytes} bytes.`);
  // A body can legitimately be absent (for example a 204), and lightweight
  // Response-compatible adapters used by connectors/tests may only implement
  // text(). Apply the same byte cap to that fallback instead of silently
  // treating the response as empty.
  if (!response.body) {
    const text = typeof response.text === 'function' ? await response.text() : '';
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`${label} is larger than ${maxBytes} bytes.`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} is larger than ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

export async function readResponseJson<T>(response: Response, maxBytes: number, label = 'Outbound response'): Promise<T> {
  const text = await readResponseText(response, maxBytes, label);
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`${label} did not contain valid JSON.`); }
}

function redirectMethod(status: number, method: string): string {
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) return 'GET';
  return method;
}

/**
 * Safe fetch for configurable destinations. Redirects are followed manually so
 * every hop is revalidated and credentials cannot leak to a different origin.
 */
export async function safeFetch(
  value: string | URL,
  init: RequestInit = {},
  options: OutboundUrlOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  let target = await assertSafeOutboundUrl(value, options);
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await fetch(target, { ...init, method, body, headers, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (maxRedirects === 0) return response;
    if (hop === maxRedirects) throw new Error(`Outbound request exceeded ${maxRedirects} redirects.`);
    const location = response.headers.get('location');
    if (!location) return response;

    const next = await assertSafeOutboundUrl(new URL(location, target), options);
    const nextMethod = redirectMethod(response.status, method);
    if (next.origin !== target.origin) {
      headers.delete('authorization');
      headers.delete('cookie');
      headers.delete('proxy-authorization');
      // A 307/308 preserves the request body. Never forward webhook payloads,
      // SSO client secrets or connector writes to a different origin merely
      // because the configured endpoint returned a redirect.
      if (body !== undefined && !['GET', 'HEAD'].includes(nextMethod)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Outbound request refused to forward a request body across origins.');
      }
    }
    if (nextMethod === 'GET' && method !== 'GET') {
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    await response.body?.cancel().catch(() => undefined);
    method = nextMethod;
    target = next;
  }
  throw new Error('Outbound redirect handling failed.');
}
