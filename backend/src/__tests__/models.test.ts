import { describe, it, expect } from 'vitest';
import { pickLatest } from '../ai/models.js';

// "Highest number wins" within a provider's preferred tier (mini / sonnet /
// flash / sonar). Pure function — no DB or network.
describe('pickLatest model version ranking', () => {
  it('openai: newest mini wins (gpt-5.1 > gpt-5 > 4o)', () => {
    expect(pickLatest('openai', ['gpt-4o-mini', 'gpt-5-mini', 'gpt-5.1-mini', 'gpt-4o', 'gpt-4-turbo']))
      .toBe('gpt-5.1-mini');
  });

  it('anthropic: newest sonnet wins over opus/older sonnet', () => {
    expect(pickLatest('anthropic', ['claude-3-5-sonnet', 'claude-sonnet-4', 'claude-sonnet-5', 'claude-opus-4-1']))
      .toBe('claude-sonnet-5');
  });

  it('gemini: newest flash wins (2.5 > 2.0 > 1.5)', () => {
    expect(pickLatest('gemini', ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-pro']))
      .toBe('gemini-2.5-flash');
  });

  it('falls back to any model when the tier keyword is absent', () => {
    // No "mini" models → picks the highest-versioned of what exists.
    expect(pickLatest('openai', ['gpt-4o', 'gpt-5', 'gpt-4-turbo'])).toBe('gpt-5');
  });

  it('returns the safe default for an empty list', () => {
    expect(pickLatest('anthropic', [])).toBe('claude-sonnet-5');
    expect(pickLatest('xai', [])).toBe('grok-3-mini');
  });
});
