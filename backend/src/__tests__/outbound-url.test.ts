import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPrivateAddress, readResponseText, safeFetch, validateOutboundUrl } from '../security/outbound-url.js';

afterEach(() => {
  delete process.env.ALLOW_INSECURE_OUTBOUND;
  delete process.env.ALLOW_PRIVATE_OUTBOUND;
  delete process.env.OUTBOUND_HOST_ALLOWLIST;
  vi.unstubAllGlobals();
});

describe('outbound URL policy', () => {
  it('recognises private and reserved address ranges', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.1.2', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fec0::1', '::7f00:1', '::ffff:7f00:1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('requires HTTPS and rejects embedded credentials', () => {
    expect(() => validateOutboundUrl('http://example.com/hook')).toThrow(/HTTPS/);
    expect(() => validateOutboundUrl('https://user:pass@example.com/hook')).toThrow(/credentials/);
    expect(validateOutboundUrl('https://example.com/hook').hostname).toBe('example.com');
  });

  it('blocks literal private and local targets', () => {
    expect(() => validateOutboundUrl('https://127.0.0.1/admin')).toThrow(/private/);
    expect(() => validateOutboundUrl('https://[::1]/admin')).toThrow(/private/);
    expect(() => validateOutboundUrl('https://metadata.internal/latest')).toThrow(/private/);
    expect(() => validateOutboundUrl('https://localhost:3000')).toThrow(/private/);
  });

  it('supports explicit administrator exceptions', () => {
    process.env.ALLOW_INSECURE_OUTBOUND = 'true';
    process.env.OUTBOUND_HOST_ALLOWLIST = 'localhost,*.corp.example';
    expect(validateOutboundUrl('http://localhost:3000').hostname).toBe('localhost');
    expect(validateOutboundUrl('http://metrics.corp.example').hostname).toBe('metrics.corp.example');
  });

  it('revalidates redirects and strips authorization across origins', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) });
      if (calls.length === 1) return new Response('', { status: 302, headers: { location: 'https://other.example/result' } });
      return new Response('ok', { status: 200 });
    }));
    const response = await safeFetch('https://example.com/start', { headers: { Authorization: 'Bearer secret' } });
    expect(await response.text()).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get('authorization')).toBe('Bearer secret');
    expect(calls[1].headers.has('authorization')).toBe(false);
  });

  it('blocks a redirect to a private target before requesting it', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://127.0.0.1/private' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(safeFetch('https://example.com/start')).rejects.toThrow(/private/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not forward a POST body across origins on a preserving redirect', async () => {
    const fetchMock = vi.fn(async () => new Response('', {
      status: 307,
      headers: { location: 'https://other.example/collect' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(safeFetch('https://example.com/token', {
      method: 'POST',
      body: 'client_secret=secret',
    })).rejects.toThrow(/request body across origins/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops reading an oversized response even when content-length is absent', async () => {
    const response = new Response('x'.repeat(32));
    await expect(readResponseText(response, 16, 'Test response')).rejects.toThrow(/larger than 16 bytes/);
  });
});
