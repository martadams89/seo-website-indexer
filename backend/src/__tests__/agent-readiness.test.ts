import { describe, it, expect } from 'vitest';
import {
  robotsAllowsAi, hasContentSignal, hasJsonLd, hasWebMcp, isMarkdownResponse,
  isValidJwks, summarize, mapScan, type AgentCheck,
} from '../indexer/agent-readiness.js';

describe('robotsAllowsAi', () => {
  it('allows when no AI-bot Disallow', () => expect(robotsAllowsAi('User-agent: *\nAllow: /')).toBe(true));
  it('blocks a specific AI bot with Disallow: /', () => expect(robotsAllowsAi('User-agent: GPTBot\nDisallow: /')).toBe(false));
  it('blocks global * Disallow: /', () => expect(robotsAllowsAi('User-agent: *\nDisallow: /')).toBe(false));
  it('allows when only a subpath blocked', () => expect(robotsAllowsAi('User-agent: GPTBot\nDisallow: /private/')).toBe(true));
  it('empty robots is not a pass', () => expect(robotsAllowsAi('')).toBe(false));
});

describe('detectors', () => {
  it('Content-Signal in robots or header', () => {
    expect(hasContentSignal('Content-Signal: ai-train=no', null)).toBe(true);
    expect(hasContentSignal('', 'content-signal: ai-train=no')).toBe(true);
    expect(hasContentSignal('', 'search=yes')).toBe(false);
  });
  it('JSON-LD', () => {
    expect(hasJsonLd('<script type="application/ld+json">{}</script>')).toBe(true);
    expect(hasJsonLd('<p>none</p>')).toBe(false);
  });
  it('WebMCP', () => {
    expect(hasWebMcp('navigator.modelContext.provideContext({})')).toBe(true);
    expect(hasWebMcp('<body></body>')).toBe(false);
  });
  it('markdown response', () => {
    expect(isMarkdownResponse({ ct: 'text/markdown; charset=utf-8', text: '# Hi' })).toBe(true);
    expect(isMarkdownResponse({ ct: 'text/plain', text: '# Title\n\n[x](https://y)' })).toBe(true);
    expect(isMarkdownResponse({ ct: 'text/html', text: '<html><body>x</body></html>' })).toBe(false);
  });
  it('JWKS', () => {
    expect(isValidJwks('{"keys":[{"kty":"OKP"}]}')).toBe(true);
    expect(isValidJwks('{"keys":[]}')).toBe(false);
    expect(isValidJwks('nope')).toBe(false);
  });
});

describe('summarize (pass ratio, neutral excluded)', () => {
  const c = (status: AgentCheck['status']): AgentCheck => ({ id: 'x', label: 'x', category: 'c', status, detail: '' });
  it('excludes neutral from the denominator', () => {
    const r = summarize([c('pass'), c('pass'), c('fail'), c('neutral')]);
    expect(r).toEqual({ score: 67, passed: 2, total: 3 });
  });
  it('all pass = 100', () => expect(summarize([c('pass'), c('pass')]).score).toBe(100));
  it('empty = 0', () => expect(summarize([]).score).toBe(0));
});

describe('mapScan (isitagentready payload → result)', () => {
  const payload = {
    level: 5, levelName: 'Agent-Native', scannedAt: '2026-07-05T00:00:00.000Z',
    checks: {
      discoverability: {
        robotsTxt: { status: 'pass', message: 'Present' },
        dnsAid: { status: 'fail', message: 'DNSSEC not validated' },
      },
      discovery: { authMd: { status: 'fail', message: 'missing heading' } },
      commerce: { x402: { status: 'neutral', message: 'n/a' } },
    },
  };
  it('flattens checks and carries level/levelName/source', () => {
    const r = mapScan(payload);
    expect(r.source).toBe('isitagentready.com');
    expect(r.level).toBe(5);
    expect(r.levelName).toBe('Agent-Native');
    expect(r.checks).toHaveLength(4);
    expect(r.scannedAt).toBe('2026-07-05T00:00:00.000Z');
  });
  it('scores pass ratio over non-neutral checks', () => {
    const r = mapScan(payload); // 1 pass / 3 scored (neutral excluded)
    expect(r).toMatchObject({ passed: 1, total: 3, score: 33 });
  });
  it('adds a fix hint on failing checks and a friendly label', () => {
    const dns = mapScan(payload).checks.find(c => c.id === 'dnsAid')!;
    expect(dns.status).toBe('fail');
    expect(dns.fix).toBe('DNSSEC not validated');
    expect(dns.label).toBe('DNS-AID record');
  });
  it('handles an empty payload', () => {
    const r = mapScan({});
    expect(r).toMatchObject({ level: null, levelName: null, passed: 0, total: 0, score: 0 });
  });
});
