import { describe, it, expect } from 'vitest';
import {
  robotsAllowsAi, hasContentSignal, hasJsonLd, hasMetaDescription,
  hasWebMcp, hasAgentLink, isMarkdownResponse, isValidJwks, scoreChecks,
  type AgentCheck,
} from '../indexer/agent-readiness.js';

describe('robotsAllowsAi', () => {
  it('allows when no AI-bot Disallow', () => {
    expect(robotsAllowsAi('User-agent: *\nAllow: /')).toBe(true);
  });
  it('blocks when AI bot has Disallow: /', () => {
    expect(robotsAllowsAi('User-agent: GPTBot\nDisallow: /')).toBe(false);
  });
  it('blocks when global * is Disallow: /', () => {
    expect(robotsAllowsAi('User-agent: *\nDisallow: /')).toBe(false);
  });
  it('allows when only a subpath is blocked', () => {
    expect(robotsAllowsAi('User-agent: GPTBot\nDisallow: /private/')).toBe(true);
  });
  it('empty robots is not a pass', () => {
    expect(robotsAllowsAi('')).toBe(false);
  });
});

describe('content-signal + structured content detectors', () => {
  it('detects Content-Signal in robots body', () => {
    expect(hasContentSignal('Content-Signal: ai-train=no', null)).toBe(true);
  });
  it('detects Content-Signal in a header', () => {
    expect(hasContentSignal('', 'search=yes, ai-train=no')).toBe(false); // header must name content-signal
    expect(hasContentSignal('', 'content-signal: ai-train=no')).toBe(true);
  });
  it('detects JSON-LD', () => {
    expect(hasJsonLd('<script type="application/ld+json">{}</script>')).toBe(true);
    expect(hasJsonLd('<p>no schema</p>')).toBe(false);
  });
  it('detects meta/OG description', () => {
    expect(hasMetaDescription('<meta name="description" content="hello">')).toBe(true);
    expect(hasMetaDescription('<meta property="og:description" content="x">')).toBe(true);
    expect(hasMetaDescription('<title>x</title>')).toBe(false);
  });
  it('detects WebMCP wiring', () => {
    expect(hasWebMcp('navigator.modelContext.provideContext({})')).toBe(true);
    expect(hasWebMcp('<body></body>')).toBe(false);
  });
  it('detects agent Link relations', () => {
    expect(hasAgentLink('', '</llms.txt>; rel="llms"')).toBe(true);
    expect(hasAgentLink('<link rel="api-catalog" href="/.well-known/api-catalog">', null)).toBe(true);
    expect(hasAgentLink('<p>nothing</p>', null)).toBe(false);
  });
});

describe('markdown negotiation + JWKS', () => {
  it('passes on text/markdown content-type', () => {
    expect(isMarkdownResponse({ ct: 'text/markdown; charset=utf-8', text: '# Hi' })).toBe(true);
  });
  it('sniffs markdown body when content-type is generic', () => {
    expect(isMarkdownResponse({ ct: 'text/plain', text: '# Title\n\nSome [link](https://x)' })).toBe(true);
  });
  it('rejects HTML', () => {
    expect(isMarkdownResponse({ ct: 'text/html', text: '<html><body>x</body></html>' })).toBe(false);
  });
  it('validates a JWKS', () => {
    expect(isValidJwks('{"keys":[{"kty":"OKP","crv":"Ed25519"}]}')).toBe(true);
    expect(isValidJwks('{"keys":[]}')).toBe(false);
    expect(isValidJwks('not json')).toBe(false);
  });
});

describe('scoreChecks weighting', () => {
  const c = (id: string, pass: boolean, weight: number): AgentCheck =>
    ({ id, label: id, category: 'protocol', pass, weight, detail: '' });

  it('is a weighted percentage', () => {
    const r = scoreChecks([c('a', true, 3), c('b', false, 1)]);
    expect(r.score).toBe(75); // 3 of 4 weight
    expect(r.passed).toBe(1);
    expect(r.total).toBe(2);
  });
  it('all pass = 100', () => {
    expect(scoreChecks([c('a', true, 2), c('b', true, 1)]).score).toBe(100);
  });
  it('none pass = 0', () => {
    expect(scoreChecks([c('a', false, 2)]).score).toBe(0);
  });
});
