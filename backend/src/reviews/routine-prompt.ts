/**
 * reviews/routine-prompt.ts — a copy-and-paste prompt for a scheduled task in
 * any MCP-capable AI assistant that answers Google reviews. The reply rules
 * are enforced by the server whatever the prompt says; the prompt shapes how
 * the assistant writes within them.
 */
import { cadenceCron, cadenceLabel, type RoutineCadence } from '../ads/routine-prompt.js';
import type { ReviewLocation } from './store.js';

export interface ReviewRoutineSettings {
  cadence: RoutineCadence;
  time: string;
  timezone: string;
  /** within_rules: publish what the rules allow and queue the rest. drafts_only: every reply waits for approval. */
  mode: 'within_rules' | 'drafts_only';
  /** Only answer reviews from the last N days. */
  lookback_days: number;
  extra_instructions?: string;
}

export const DEFAULT_REVIEW_ROUTINE: ReviewRoutineSettings = {
  cadence: 'daily', time: '09:00', timezone: 'Europe/London', mode: 'within_rules', lookback_days: 30,
};

export function normalizeReviewRoutine(raw: unknown): ReviewRoutineSettings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ReviewRoutineSettings, unknown>>;
  const cadence = ['daily', 'weekdays', 'twice_weekly', 'weekly'].includes(String(v.cadence)) ? v.cadence as RoutineCadence : DEFAULT_REVIEW_ROUTINE.cadence;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v.time)) ? String(v.time) : DEFAULT_REVIEW_ROUTINE.time;
  let timezone = typeof v.timezone === 'string' && v.timezone.trim() ? v.timezone.trim() : DEFAULT_REVIEW_ROUTINE.timezone;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { timezone = DEFAULT_REVIEW_ROUTINE.timezone; }
  const lookback = Number(v.lookback_days);
  return {
    cadence, time, timezone,
    mode: v.mode === 'drafts_only' ? 'drafts_only' : 'within_rules',
    lookback_days: [7, 14, 30, 90, 365].includes(lookback) ? lookback : DEFAULT_REVIEW_ROUTINE.lookback_days,
    extra_instructions: typeof v.extra_instructions === 'string' ? v.extra_instructions.trim().slice(0, 4000) || undefined : undefined,
  };
}

const MODE_TEXT: Record<string, string> = {
  read_only: 'read-only — don\'t reply; report what needs answering',
  review: 'every reply waits for my approval',
  guarded: 'replies to {min}+ star reviews publish straight away; the rest wait for my approval',
  autopilot: 'replies inside the rules publish straight away',
};

function locationBlock(l: ReviewLocation, index: number): string {
  const b = l.brief;
  const lines = [
    `${index + 1}. ${l.title ?? l.location_name} — location id \`${l.id}\`${l.address ? ` (${l.address})` : ''}`,
    `   - Reply rules (enforced by the server): ${MODE_TEXT[l.rules.mode].replace('{min}', String(l.rules.auto_min_rating))}; up to ${l.rules.max_length} characters${l.rules.allow_links ? '' : '; no links'}`,
  ];
  if (b.brand_voice) lines.push(`   - Voice: ${b.brand_voice}`);
  if (b.sign_off) lines.push(`   - Sign off as: ${b.sign_off}`);
  if (b.contact_for_issues) lines.push(`   - Point unhappy customers to: ${b.contact_for_issues}`);
  if (b.language) lines.push(`   - Language: ${b.language}`);
  if (b.never_do) lines.push(`   - Never: ${b.never_do}`);
  if (b.notes) lines.push(`   - Notes: ${b.notes}`);
  return lines.join('\n');
}

export function buildReviewRoutinePrompt(input: {
  settings: ReviewRoutineSettings; locations: ReviewLocation[]; connectorName: string; endpoint: string; dashboardUrl: string; workspaceName?: string | null;
}): { prompt: string; schedule: string; cron: string } {
  const s = input.settings;
  const schedule = cadenceLabel(s);
  const publish = s.mode === 'within_rules';
  const locations = input.locations.length
    ? input.locations.map(locationBlock).join('\n\n')
    : '(No locations selected — call reviews_list_locations and work through every enabled location.)';

  const prompt = `You are my Google reviews assistant${input.workspaceName ? ` for ${input.workspaceName}` : ''}. This task runs ${schedule}.

Use the "${input.connectorName}" MCP server (${input.endpoint}). Its review tools start with "reviews_". If the server isn't connected or its tools fail to authenticate, stop and tell me — do not try to work around it.

## Locations in scope
${locations}

## Each run, for every location above
1. Call reviews_sync for the location, then reviews_get_brief (voice, sign-off, contact details, rules) and reviews_list_replies with status "published" and limit 10, so your replies stay consistent with earlier ones.
2. Call reviews_list with filter "unreplied" and sinceDays ${s.lookback_days}, then again with filter "reply_rejected".
3. For each review, write one reply:
   - Thank them, and respond to what they actually said. Use their first name if they gave one. No generic copy-paste replies.
   - Negative or mixed reviews: acknowledge and apologise for their experience without admitting legal liability, don't argue or blame, and invite them to continue offline using the contact in the brief. Never share personal or booking details.
   - Never offer incentives, ask anyone to change or remove a review, or invent facts (prices, policies, staff names, promises) that aren't in the review or the brief.
   - Reply in the reviewer's language unless the brief says otherwise. Keep it short — within the location's character limit.
   - A reply Google rejected: read its policy violation, then write a new, compliant reply.
   - Don't reply to reviews that look fake, abusive, or mention legal action, safety or a named employee — list them for me instead.
4. Submit each reply with reviews_reply (reviewId, text, a one-line rationale${publish ? '' : ', publish: false'}). ${publish
    ? 'The server publishes it if the location\'s rules allow, otherwise it waits for my approval — don\'t resubmit a reply to get around a rule.'
    : 'Every reply waits for my approval on the dashboard.'}
5. Call reviews_summary for the location for the rating trend.

## Report back
Finish with a short report per location: new reviews and the rating trend, replies published, replies waiting for my approval (${input.dashboardUrl}), and any review that needs a human decision.${s.extra_instructions ? `\n\n## Extra instructions\n${s.extra_instructions}` : ''}`;

  return { prompt, schedule, cron: cadenceCron(s) };
}
