import { describe, it, expect } from 'vitest';
import { DEFAULT_RULES, evaluateReply, normalizeRules } from '../reviews/rules.js';
import { parseBusinessError } from '../reviews/client.js';
import { buildReviewRoutinePrompt, normalizeReviewRoutine } from '../reviews/routine-prompt.js';
import type { ReviewLocation } from '../reviews/store.js';

const judge = (text: string, rating: number, rules = DEFAULT_RULES, existingReply: string | null = null) => evaluateReply({ rules, rating, text, existingReply });

describe('review reply rules', () => {
  it('publishes a short, clean reply to a positive review in guarded mode', () => {
    expect(judge('Thank you, Sam — glad the new boiler is keeping you warm!', 5).decision).toBe('publish');
  });

  it('needs approval below the auto-publish rating and in review mode', () => {
    expect(judge('Sorry to hear this.', 3).findings.map(f => f.code)).toContain('low_rating');
    expect(judge('Thanks!', 5, normalizeRules({ mode: 'review' })).decision).toBe('needs_approval');
    expect(judge('Sorry to hear this.', 1, normalizeRules({ mode: 'autopilot' })).decision).toBe('publish');
  });

  it('flags links, contact details, banned phrases, placeholders and length', () => {
    const rules = normalizeRules({ allow_contact_details: false, banned_phrases: ['discount'], max_length: 60 });
    const codes = judge('Thanks [NAME]! Email hello@acme.example or see www.acme.example for a discount on your next visit.', 5, rules).findings.map(f => f.code);
    expect(codes).toEqual(expect.arrayContaining(['placeholder', 'link', 'contact_details', 'banned_phrase', 'long']));
  });

  it('blocks empty replies, oversized replies and read-only locations', () => {
    expect(judge('   ', 5).decision).toBe('blocked');
    expect(judge('x'.repeat(5000), 5).decision).toBe('blocked');
    expect(judge('Thanks!', 5, normalizeRules({ mode: 'read_only' })).decision).toBe('blocked');
  });

  it('asks before replacing a published reply or deleting one', () => {
    expect(judge('Thanks again!', 5, DEFAULT_RULES, 'Thanks!').findings.map(f => f.code)).toContain('replaces_reply');
    expect(evaluateReply({ rules: DEFAULT_RULES, rating: 5, text: '', existingReply: 'Thanks!', action: 'delete' }).decision).toBe('needs_approval');
    expect(evaluateReply({ rules: DEFAULT_RULES, rating: 5, text: '', existingReply: null, action: 'delete' }).decision).toBe('blocked');
  });

  it('deletes a reply without approval when the location allows it, but never in review mode', () => {
    const del = (rules: Record<string, unknown>) => evaluateReply({ rules: normalizeRules(rules), rating: 5, text: '', existingReply: 'Thanks!', action: 'delete' }).decision;
    expect(del({ allow_delete: true })).toBe('publish');
    expect(del({ allow_delete: true, mode: 'review' })).toBe('needs_approval');
    expect(del({ allow_delete: true, mode: 'read_only' })).toBe('blocked');
    expect(DEFAULT_RULES.allow_delete).toBe(false);
  });

  it('normalises stored rules safely', () => {
    expect(normalizeRules({ mode: 'yolo', auto_min_rating: 9, max_length: 5, banned_phrases: [' a ', 'a', ''] })).toMatchObject({ mode: 'guarded', auto_min_rating: 5, max_length: 50, banned_phrases: ['a'] });
  });
});

describe('Business Profile errors', () => {
  it('recognises an unapproved project and a disabled API', () => {
    const quota = parseBusinessError(429, { error: { status: 'RESOURCE_EXHAUSTED', details: [{ reason: 'RATE_LIMIT_EXCEEDED', metadata: { quota_limit_value: '0' } }] } }, '42');
    expect(quota.kind).toBe('NOT_APPROVED');
    expect(quota.hint).toMatch(/project number 42/);
    expect(parseBusinessError(429, { error: { status: 'RESOURCE_EXHAUSTED', details: [{ metadata: { quota_limit_value: '300' } }] } }, '42').kind).toBe('QUOTA');
    expect(parseBusinessError(403, { error: { message: 'My Business Account Management API has not been used in project 42 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } }, '42').kind).toBe('API_DISABLED');
    expect(parseBusinessError(403, { error: { message: 'The caller does not have permission' } }, '42').kind).toBe('PERMISSION');
    expect(parseBusinessError(401, { error: { status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } }, '42').kind).toBe('NEEDS_REAUTH');
    expect(parseBusinessError(403, { error: { message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, '42').kind).toBe('NO_SCOPE');
  });
});

describe('review routine prompt', () => {
  it('describes each location\'s rules and honours drafts-only mode', () => {
    const location = {
      id: 'loc-1', title: 'Acme Plumbing Leeds', location_name: 'locations/1', address: 'Leeds',
      rules: normalizeRules({ mode: 'guarded', auto_min_rating: 4 }), brief: { sign_off: 'Dave, Acme', contact_for_issues: 'hello@acme.example' },
    } as unknown as ReviewLocation;
    const { prompt, cron } = buildReviewRoutinePrompt({
      settings: normalizeReviewRoutine({ cadence: 'weekdays', time: '08:30', mode: 'drafts_only' }), locations: [location],
      connectorName: 'SEO Indexer', endpoint: 'https://seo.example.com/mcp', dashboardUrl: 'https://seo.example.com/reviews?tab=approvals',
    });
    expect(prompt).toContain('location id `loc-1`');
    expect(prompt).toContain('4+ star reviews publish straight away');
    expect(prompt).toContain('Sign off as: Dave, Acme');
    expect(prompt).toContain('publish: false');
    expect(cron).toBe('30 8 * * 1-5');
  });
});
