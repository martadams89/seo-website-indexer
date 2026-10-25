/**
 * reviews/rules.ts — what an AI assistant may publish as a review reply
 * without a person approving it. Pure functions, so they're easy to test.
 *
 * People replying on the dashboard are the approvers, so these rules only
 * judge replies proposed over MCP.
 */
import { MAX_REPLY_BYTES } from './client.js';

export type ReplyMode = 'read_only' | 'review' | 'guarded' | 'autopilot';

export interface ReplyRules {
  /** read_only: assistants can't reply. review: every reply waits for a person. guarded: replies to well-rated reviews publish straight away. autopilot: every reply inside the other rules publishes. */
  mode: ReplyMode;
  /** guarded: replies to reviews rated at least this publish without approval. */
  auto_min_rating: number;
  /** Replies longer than this (characters) need approval. */
  max_length: number;
  /** Replies containing a link publish without approval. */
  allow_links: boolean;
  /** Replies containing a phone number or email address publish without approval. */
  allow_contact_details: boolean;
  /** Replacing a reply that is already published publishes without approval. */
  allow_replace_existing: boolean;
  /** Replies containing any of these phrases (case-insensitive) need approval. */
  banned_phrases: string[];
  /** Send an alert for new reviews rated at or below this (0 turns alerts off). */
  alert_max_rating: number;
}

export const DEFAULT_RULES: ReplyRules = {
  mode: 'guarded',
  auto_min_rating: 4,
  max_length: 1000,
  allow_links: false,
  allow_contact_details: true,
  allow_replace_existing: false,
  banned_phrases: [],
  alert_max_rating: 3,
};

export interface ReviewBrief {
  business_name?: string;
  brand_voice?: string;
  sign_off?: string;
  /** Where unhappy customers should be directed (email, phone, page). */
  contact_for_issues?: string;
  /** "match" (reply in the reviewer's language) or a language name. */
  language?: string;
  never_do?: string;
  notes?: string;
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function normalizeRules(raw: unknown): ReplyRules {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ReplyRules, unknown>>;
  const mode = ['read_only', 'review', 'guarded', 'autopilot'].includes(String(v.mode)) ? v.mode as ReplyMode : DEFAULT_RULES.mode;
  const bool = (key: 'allow_links' | 'allow_contact_details' | 'allow_replace_existing') => typeof v[key] === 'boolean' ? v[key] as boolean : DEFAULT_RULES[key];
  return {
    mode,
    auto_min_rating: clampInt(v.auto_min_rating, 1, 5, DEFAULT_RULES.auto_min_rating),
    max_length: clampInt(v.max_length, 50, 4000, DEFAULT_RULES.max_length),
    allow_links: bool('allow_links'),
    allow_contact_details: bool('allow_contact_details'),
    allow_replace_existing: bool('allow_replace_existing'),
    banned_phrases: Array.isArray(v.banned_phrases)
      ? [...new Set(v.banned_phrases.map(p => String(p).trim()).filter(Boolean).map(p => p.slice(0, 100)))].slice(0, 50)
      : DEFAULT_RULES.banned_phrases,
    alert_max_rating: clampInt(v.alert_max_rating, 0, 5, DEFAULT_RULES.alert_max_rating),
  };
}

export function normalizeReviewBrief(raw: unknown): ReviewBrief {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (key: keyof ReviewBrief, max = 2000) => typeof v[key] === 'string' && (v[key] as string).trim() ? (v[key] as string).trim().slice(0, max) : undefined;
  return {
    business_name: text('business_name', 200),
    brand_voice: text('brand_voice'),
    sign_off: text('sign_off', 200),
    contact_for_issues: text('contact_for_issues', 500),
    language: text('language', 60),
    never_do: text('never_do'),
    notes: text('notes', 4000),
  };
}

export interface ReplyFinding { severity: 'approval' | 'blocked'; code: string; message: string }
export type ReplyDecision = 'publish' | 'needs_approval' | 'blocked';

const URL_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|co\.uk|org|net|io|uk|de|fr|es|it|nl|au|ca)\b/i;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\s().-]?){9,}/;
const PLACEHOLDER_RE = /\[[A-Za-z][^\]]{0,40}\]|\{\{[^}]*\}\}|<[A-Z_ ]{3,}>|\bXXX\b|\bINSERT\b/;

/**
 * Judge one reply an AI assistant wants to publish. `rating` is the review's
 * star rating (0 when Google gave none); `action` 'delete' removes a reply.
 */
export function evaluateReply(input: {
  rules: ReplyRules; rating: number; text: string; existingReply: string | null; action?: 'reply' | 'delete';
}): { decision: ReplyDecision; findings: ReplyFinding[] } {
  const { rules } = input;
  const findings: ReplyFinding[] = [];
  const add = (severity: ReplyFinding['severity'], code: string, message: string) => findings.push({ severity, code, message });

  if (rules.mode === 'read_only') add('blocked', 'read_only', 'This location is read-only for AI assistants. A person can reply on the dashboard.');

  if (input.action === 'delete') {
    if (!input.existingReply) add('blocked', 'nothing_to_delete', 'This review has no reply to delete.');
    else add('approval', 'delete', 'Deleting a published reply always needs a person\'s approval.');
  } else {
    const text = input.text.trim();
    if (!text) add('blocked', 'empty', 'The reply is empty.');
    if (Buffer.byteLength(text, 'utf8') > MAX_REPLY_BYTES) add('blocked', 'too_long_for_google', `Google accepts replies of up to ${MAX_REPLY_BYTES} bytes.`);
    else if (text.length > rules.max_length) add('approval', 'long', `The reply is ${text.length} characters; this location's limit for replies without approval is ${rules.max_length}.`);
    if (PLACEHOLDER_RE.test(text)) add('approval', 'placeholder', 'The reply looks like it still contains a template placeholder.');
    if (!rules.allow_links && URL_RE.test(text)) add('approval', 'link', 'Replies with links need approval at this location.');
    if (!rules.allow_contact_details && (EMAIL_RE.test(text) || PHONE_RE.test(text))) add('approval', 'contact_details', 'Replies with a phone number or email address need approval at this location.');
    const lower = text.toLowerCase();
    const banned = rules.banned_phrases.filter(p => lower.includes(p.toLowerCase()));
    if (banned.length) add('approval', 'banned_phrase', `The reply uses phrases this location wants checked: ${banned.map(p => `"${p}"`).join(', ')}.`);
    if (input.existingReply && !rules.allow_replace_existing) add('approval', 'replaces_reply', 'This review already has a reply; replacing it needs approval.');
    if (rules.mode === 'review') add('approval', 'review_mode', 'Every reply at this location waits for a person to approve it.');
    if (rules.mode === 'guarded' && input.rating < rules.auto_min_rating) {
      add('approval', 'low_rating', input.rating
        ? `Replies to ${input.rating}-star reviews need approval (this location auto-publishes replies to ${rules.auto_min_rating}+ star reviews).`
        : 'The review has no star rating, so the reply needs approval.');
    }
  }

  const decision: ReplyDecision = findings.some(f => f.severity === 'blocked') ? 'blocked'
    : findings.some(f => f.severity === 'approval') ? 'needs_approval' : 'publish';
  return { decision, findings };
}
