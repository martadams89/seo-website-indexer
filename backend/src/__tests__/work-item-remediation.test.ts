import { describe, expect, it } from 'vitest';
import { pageBelongsToSite } from '../platform/routes.js';

describe('work-item remediation URL boundaries', () => {
  it('accepts pages covered by a domain property and rejects lookalike hosts', () => {
    const site = { domain: 'dampapp.pro', gsc_url: 'sc-domain:dampapp.pro' };
    expect(pageBelongsToSite('https://dampapp.pro/help', site)).toBe(true);
    expect(pageBelongsToSite('https://docs.dampapp.pro/guide', site)).toBe(true);
    expect(pageBelongsToSite('https://dampapp.pro.attacker.example/help', site)).toBe(false);
    expect(pageBelongsToSite('javascript:alert(1)', site)).toBe(false);
  });

  it('honours URL-prefix property paths', () => {
    const site = { domain: 'example.com/app', gsc_url: 'https://example.com/app/' };
    expect(pageBelongsToSite('https://example.com/app/pricing', site)).toBe(true);
    expect(pageBelongsToSite('https://example.com/application', site)).toBe(false);
    expect(pageBelongsToSite('https://www.example.com/app/pricing', site)).toBe(false);
  });
});
