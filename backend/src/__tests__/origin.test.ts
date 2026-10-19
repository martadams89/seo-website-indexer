import { describe, it, expect } from 'vitest';
import { cameOverHttps, isLocalHost, publicOrigin, secureCookies } from '../utils/origin.js';

const req = (host: string, headers: Record<string, string> = {}, protocol = 'http') => ({ protocol, headers: { host, ...headers } });

describe('public origin', () => {
  it('uses https for a public hostname even when the proxy forwards plain http', () => {
    expect(publicOrigin(req('seo.example.com'))).toBe('https://seo.example.com');
    expect(publicOrigin(req('seo.example.com:8443'))).toBe('https://seo.example.com:8443');
  });

  it('keeps http for local and LAN addresses', () => {
    for (const host of ['localhost:3000', '127.0.0.1:3000', '192.168.1.20', '[::1]:3000', 'seo-indexer:3000', 'nas.local', 'box.lan', 'app.home.arpa']) {
      expect(publicOrigin(req(host))).toBe(`http://${host}`);
    }
  });

  it('upgrades a local address when the request evidently came over https', () => {
    expect(publicOrigin(req('192.168.1.20', { 'x-forwarded-proto': 'https' }))).toBe('https://192.168.1.20');
    expect(publicOrigin(req('192.168.1.20', { forwarded: 'for=10.0.0.1;proto=https' }))).toBe('https://192.168.1.20');
    expect(publicOrigin(req('localhost:3000', {}, 'https'))).toBe('https://localhost:3000');
  });

  it('never lets a forwarded header downgrade to http', () => {
    expect(publicOrigin(req('seo.example.com', { 'x-forwarded-proto': 'http' }))).toBe('https://seo.example.com');
  });

  it('only marks cookies Secure on evidence of https, so plain-http installs can still sign in', () => {
    expect(secureCookies(req('seo.example.com'))).toBe(false);
    expect(secureCookies(req('seo.example.com', { 'x-forwarded-proto': 'https, http' }))).toBe(true);
    expect(cameOverHttps(req('seo.example.com', { 'x-forwarded-proto': 'http' }))).toBe(false);
  });

  it('recognises local hostnames', () => {
    expect(isLocalHost('app.localhost')).toBe(true);
    expect(isLocalHost('example.com.')).toBe(false);
    expect(isLocalHost('indexer.example.co.uk')).toBe(false);
  });
});
