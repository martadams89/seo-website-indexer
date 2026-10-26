/**
 * reviews/profile-rules.ts — what an AI assistant may change on a Business
 * Profile without a person approving it, plus the conversions between the
 * app's simple shapes (HH:MM hours, YYYY-MM-DD dates) and Google's.
 *
 * Pure functions, so they're easy to test. As with review replies, people on
 * the dashboard are the approvers: only "blocked" findings stop them.
 */
import {
  MAX_DESCRIPTION_CHARS, MAX_POST_CHARS, PHOTO_CATEGORIES,
  type CallToAction, type GoogleDate, type LocalPost, type LocationDetails, type PhotoCategory, type SpecialHourPeriod, type TimeOfDay, type TimePeriod,
} from './client.js';
import type { ReplyFinding } from './rules.js';
import type { LocationStats } from './store.js';

// ── Rules ────────────────────────────────────────────────────────────────────

/** off: assistants can't do it. approval: it waits for a person. auto: inside the other checks it publishes. */
export type AiMode = 'off' | 'approval' | 'auto';

export interface ProfileRules {
  /** Description and opening hours (phone and website changes always need approval). */
  profile: AiMode;
  posts: AiMode;
  photos: AiMode;
  /** Alert when Google or the public change, or suggest changes to, the profile. */
  alert_google_updates: boolean;
}

export const DEFAULT_PROFILE_RULES: ProfileRules = { profile: 'approval', posts: 'approval', photos: 'approval', alert_google_updates: true };

const MODES: AiMode[] = ['off', 'approval', 'auto'];

export function normalizeProfileRules(raw: unknown): ProfileRules {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = (key: 'profile' | 'posts' | 'photos') => MODES.includes(v[key] as AiMode) ? v[key] as AiMode : DEFAULT_PROFILE_RULES[key];
  return {
    profile: mode('profile'),
    posts: mode('posts'),
    photos: mode('photos'),
    alert_google_updates: typeof v.alert_google_updates === 'boolean' ? v.alert_google_updates : DEFAULT_PROFILE_RULES.alert_google_updates,
  };
}

// ── Hours ────────────────────────────────────────────────────────────────────

export const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;
export type Day = (typeof DAYS)[number];

/** One opening period; "close" at or before "open" runs past midnight. 00:00–24:00 is open all day. */
export interface HoursPeriod { day: Day; open: string; close: string }
export interface SpecialHours { date: string; closed: boolean; open?: string; close?: string }

const pad = (n: number) => String(n).padStart(2, '0');
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class ProfileInputError extends Error {}

function parseTime(value: string, label: string): TimeOfDay {
  const m = TIME_RE.exec(String(value ?? '').trim());
  const hours = m ? Number(m[1]) : NaN;
  const minutes = m ? Number(m[2]) : NaN;
  if (!m || hours > 24 || minutes > 59 || (hours === 24 && minutes !== 0)) throw new ProfileInputError(`${label} must be a time like 09:00 (24:00 for midnight).`);
  return { hours, minutes };
}

function parseDate(value: string, label: string): GoogleDate {
  const m = DATE_RE.exec(String(value ?? '').trim());
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCMonth() !== Number(m[2]) - 1) throw new ProfileInputError(`${label} must be a date like 2026-12-24.`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

const minutesOf = (t: TimeOfDay) => (t.hours ?? 0) * 60 + (t.minutes ?? 0);
const timeText = (t: TimeOfDay | undefined) => `${pad(t?.hours ?? 0)}:${pad(t?.minutes ?? 0)}`;
const dateText = (d: GoogleDate | undefined) => d?.year ? `${d.year}-${pad(d.month ?? 1)}-${pad(d.day ?? 1)}` : '';
const nextDay = (day: Day): Day => DAYS[(DAYS.indexOf(day) + 1) % 7];
const addDay = (d: GoogleDate): GoogleDate => {
  const t = new Date(Date.UTC(d.year!, d.month! - 1, d.day! + 1));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
};

export function toGoogleRegularHours(periods: HoursPeriod[]): { periods: TimePeriod[] } {
  if (!Array.isArray(periods)) throw new ProfileInputError('Opening hours must be a list of { day, open, close }.');
  if (periods.length > 21) throw new ProfileInputError('Google accepts at most three opening periods a day.');
  return {
    periods: periods.map((p, i) => {
      const day = String(p.day ?? '').toUpperCase() as Day;
      if (!DAYS.includes(day)) throw new ProfileInputError(`Opening period ${i + 1} needs a day (MONDAY … SUNDAY).`);
      const open = parseTime(p.open, `${day} opening time`);
      const close = parseTime(p.close, `${day} closing time`);
      const overnight = close.hours !== 24 && minutesOf(close) <= minutesOf(open);
      return { openDay: day, openTime: open, closeDay: overnight ? nextDay(day) : day, closeTime: close };
    }),
  };
}

export function fromGoogleRegularHours(hours: LocationDetails['regularHours']): HoursPeriod[] {
  return (hours?.periods ?? [])
    .filter(p => DAYS.includes(p.openDay as Day))
    .map(p => ({ day: p.openDay as Day, open: timeText(p.openTime), close: timeText(p.closeTime) }))
    .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.open.localeCompare(b.open));
}

export function toGoogleSpecialHours(list: SpecialHours[]): { specialHourPeriods: SpecialHourPeriod[] } {
  if (!Array.isArray(list)) throw new ProfileInputError('Special hours must be a list of { date, closed, open, close }.');
  if (list.length > 100) throw new ProfileInputError('Keep special hours to 100 dates or fewer.');
  return {
    specialHourPeriods: list.map(entry => {
      const startDate = parseDate(entry.date, 'Special hours date');
      if (entry.closed) return { startDate, closed: true };
      const openTime = parseTime(entry.open ?? '', `${entry.date} opening time`);
      const closeTime = parseTime(entry.close ?? '', `${entry.date} closing time`);
      const overnight = closeTime.hours !== 24 && minutesOf(closeTime) <= minutesOf(openTime);
      return { startDate, endDate: overnight ? addDay(startDate) : startDate, openTime, closeTime };
    }),
  };
}

export function fromGoogleSpecialHours(hours: LocationDetails['specialHours']): SpecialHours[] {
  return (hours?.specialHourPeriods ?? [])
    .filter(p => p.startDate?.year)
    .map(p => p.closed
      ? { date: dateText(p.startDate), closed: true }
      : { date: dateText(p.startDate), closed: false, open: timeText(p.openTime), close: timeText(p.closeTime) })
    .sort((a, b) => a.date.localeCompare(b.date));
}

const DAY_SHORT: Record<Day, string> = { MONDAY: 'Mon', TUESDAY: 'Tue', WEDNESDAY: 'Wed', THURSDAY: 'Thu', FRIDAY: 'Fri', SATURDAY: 'Sat', SUNDAY: 'Sun' };

/** "Mon 09:00–17:00, Sat 10:00–14:00" — for change summaries and approvals. */
export function describeHours(periods: HoursPeriod[]): string {
  if (!periods.length) return 'closed every day';
  return periods.map(p => `${DAY_SHORT[p.day]} ${p.open === '00:00' && p.close === '24:00' ? 'open 24 hours' : `${p.open}–${p.close}`}`).join(', ');
}

// ── Profile view ─────────────────────────────────────────────────────────────

export interface ProfileView {
  title: string | null;
  description: string;
  primary_phone: string | null;
  additional_phones: string[];
  website: string | null;
  primary_category: string | null;
  additional_categories: string[];
  address: string | null;
  service_area: string[];
  open_status: string | null;
  regular_hours: HoursPeriod[];
  special_hours: SpecialHours[];
  verified: boolean | null;
  has_google_updated: boolean;
  has_pending_edits: boolean;
  maps_uri: string | null;
  new_review_uri: string | null;
}

export function toProfileView(d: LocationDetails): ProfileView {
  const a = d.storefrontAddress;
  return {
    title: d.title ?? null,
    description: d.profile?.description ?? '',
    primary_phone: d.phoneNumbers?.primaryPhone ?? null,
    additional_phones: d.phoneNumbers?.additionalPhones ?? [],
    website: d.websiteUri ?? null,
    primary_category: d.categories?.primaryCategory?.displayName ?? null,
    additional_categories: (d.categories?.additionalCategories ?? []).map(c => c.displayName ?? c.name ?? '').filter(Boolean),
    address: a ? [...(a.addressLines ?? []), a.locality, a.administrativeArea, a.postalCode].filter(Boolean).join(', ') || null : null,
    service_area: (d.serviceArea?.places?.placeInfos ?? []).map(p => p.placeName ?? '').filter(Boolean),
    open_status: d.openInfo?.status ?? null,
    regular_hours: fromGoogleRegularHours(d.regularHours),
    special_hours: fromGoogleSpecialHours(d.specialHours),
    verified: d.metadata?.hasVoiceOfMerchant ?? null,
    has_google_updated: !!d.metadata?.hasGoogleUpdated,
    has_pending_edits: !!d.metadata?.hasPendingEdits,
    maps_uri: d.metadata?.mapsUri ?? null,
    new_review_uri: d.metadata?.newReviewUri ?? null,
  };
}

// ── Profile edits ────────────────────────────────────────────────────────────

export interface ProfileEdit {
  description?: string;
  primary_phone?: string;
  website?: string;
  regular_hours?: HoursPeriod[];
  special_hours?: SpecialHours[];
}

const URL_IN_TEXT_RE = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\./i;
const PHONE_IN_TEXT_RE = /(?:\+?\d[\s().-]?){9,}/;
const PLACEHOLDER_RE = /\[[A-Za-z][^\]]{0,40}\]|\{\{[^}]*\}\}|<[A-Z_ ]{3,}>|\bXXX\b|\bINSERT\b/;

function isHttpUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}

/**
 * Turn an edit into Google's PATCH body and update mask. Throws
 * ProfileInputError for values Google would refuse outright.
 */
export function buildProfilePatch(edit: ProfileEdit, current: LocationDetails): { body: Partial<LocationDetails>; mask: string[] } {
  const body: Partial<LocationDetails> = {};
  const mask: string[] = [];
  if (edit.description !== undefined) {
    const description = String(edit.description).trim();
    if (description.length > MAX_DESCRIPTION_CHARS) throw new ProfileInputError(`Google allows a description of up to ${MAX_DESCRIPTION_CHARS} characters (this one is ${description.length}).`);
    body.profile = { description };
    mask.push('profile');
  }
  if (edit.primary_phone !== undefined) {
    const phone = String(edit.primary_phone).trim();
    if ((phone.match(/\d/g) ?? []).length < 7) throw new ProfileInputError('The phone number needs at least seven digits, ideally in international format (+44 …).');
    body.phoneNumbers = { primaryPhone: phone, additionalPhones: current.phoneNumbers?.additionalPhones ?? [] };
    mask.push('phoneNumbers');
  }
  if (edit.website !== undefined) {
    const website = String(edit.website).trim();
    if (!isHttpUrl(website)) throw new ProfileInputError('The website must be a full address starting with https://.');
    body.websiteUri = website;
    mask.push('websiteUri');
  }
  if (edit.regular_hours !== undefined) { body.regularHours = toGoogleRegularHours(edit.regular_hours); mask.push('regularHours'); }
  if (edit.special_hours !== undefined) { body.specialHours = toGoogleSpecialHours(edit.special_hours); mask.push('specialHours'); }
  if (!mask.length) throw new ProfileInputError('Nothing to change: pass a description, phone, website, opening hours or special hours.');
  return { body, mask };
}

export function describeProfileEdit(edit: ProfileEdit, current: ProfileView): string {
  const parts: string[] = [];
  if (edit.description !== undefined) parts.push(`Description (${String(edit.description).trim().length} characters)`);
  if (edit.primary_phone !== undefined) parts.push(`Phone ${current.primary_phone ?? '(none)'} → ${String(edit.primary_phone).trim()}`);
  if (edit.website !== undefined) parts.push(`Website ${current.website ?? '(none)'} → ${String(edit.website).trim()}`);
  if (edit.regular_hours !== undefined) parts.push(`Opening hours: ${describeHours(edit.regular_hours)}`);
  if (edit.special_hours !== undefined) {
    const added = edit.special_hours.filter(s => !current.special_hours.some(c => c.date === s.date && c.closed === s.closed && c.open === s.open && c.close === s.close));
    const removed = current.special_hours.filter(c => !edit.special_hours!.some(s => s.date === c.date));
    parts.push(`Special hours: ${[...added.map(s => `${s.date} ${s.closed ? 'closed' : `${s.open}–${s.close}`}`), ...removed.map(r => `remove ${r.date}`)].join(', ') || 'unchanged'}`);
  }
  return parts.join('; ');
}

/** What an assistant's profile edit needs before it can publish. */
export function evaluateProfileEdit(rules: ProfileRules, edit: ProfileEdit, current: ProfileView): ReplyFinding[] {
  const findings: ReplyFinding[] = [];
  const add = (severity: ReplyFinding['severity'], code: string, message: string) => findings.push({ severity, code, message });
  if (rules.profile === 'off') add('blocked', 'profile_off', 'This location doesn\'t let AI assistants edit its profile. A person can edit it on the dashboard.');
  if (rules.profile === 'approval') add('approval', 'profile_approval', 'Profile edits at this location wait for a person to approve them.');
  if (edit.primary_phone !== undefined) add('approval', 'phone', 'Changing the phone number always needs a person\'s approval.');
  if (edit.website !== undefined) add('approval', 'website', 'Changing the website always needs a person\'s approval.');
  if (edit.description !== undefined) {
    const text = String(edit.description);
    if (URL_IN_TEXT_RE.test(text)) add('approval', 'description_link', 'Google\'s guidelines don\'t allow links in the business description, so it may refuse this edit.');
    if (PLACEHOLDER_RE.test(text)) add('approval', 'placeholder', 'The description looks like it still contains a template placeholder.');
    if (!text.trim() && current.description) add('approval', 'description_cleared', 'This removes the business description.');
  }
  if (edit.regular_hours !== undefined) {
    const before = new Set(current.regular_hours.map(p => p.day));
    const after = new Set(edit.regular_hours.map(p => String(p.day).toUpperCase()));
    const closing = [...before].filter(d => !after.has(d));
    if (closing.length) add('approval', 'closes_days', `These days would show as closed: ${closing.map(d => DAY_SHORT[d]).join(', ')}.`);
  }
  if (edit.special_hours !== undefined) {
    const removed = current.special_hours.filter(c => !edit.special_hours!.some(s => s.date === c.date));
    if (removed.length) add('approval', 'removes_special_hours', `This removes special hours for ${removed.map(r => r.date).join(', ')}.`);
  }
  return findings;
}

// ── Posts ────────────────────────────────────────────────────────────────────

export interface PostInput {
  topic?: 'STANDARD' | 'EVENT' | 'OFFER';
  summary?: string;
  cta_type?: CallToAction;
  cta_url?: string;
  photo_url?: string;
  event_title?: string;
  start_date?: string;
  start_time?: string;
  end_date?: string;
  end_time?: string;
  coupon_code?: string;
  redeem_url?: string;
  terms?: string;
  language?: string;
}

const CTAS: CallToAction[] = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'];

/** Build Google's LocalPost. Throws ProfileInputError for posts Google would refuse. */
export function buildLocalPost(input: PostInput): LocalPost {
  const topic = input.topic ?? 'STANDARD';
  if (!['STANDARD', 'EVENT', 'OFFER'].includes(topic)) throw new ProfileInputError('Post type must be STANDARD (update), EVENT or OFFER.');
  const summary = String(input.summary ?? '').trim();
  if (topic === 'STANDARD' && !summary) throw new ProfileInputError('Write the post text.');
  if (summary.length > MAX_POST_CHARS) throw new ProfileInputError(`Google allows posts of up to ${MAX_POST_CHARS} characters (this one is ${summary.length}).`);
  if (PHONE_IN_TEXT_RE.test(summary)) throw new ProfileInputError('Google rejects posts that contain a phone number. Remove it and use the "Call now" button instead.');
  const post: LocalPost = { languageCode: (input.language ?? 'en').trim() || 'en', topicType: topic, ...(summary ? { summary } : {}) };
  if (input.cta_type) {
    if (!CTAS.includes(input.cta_type)) throw new ProfileInputError(`The button must be one of ${CTAS.join(', ')}.`);
    if (input.cta_type === 'CALL') post.callToAction = { actionType: 'CALL' };
    else {
      if (!input.cta_url || !isHttpUrl(input.cta_url)) throw new ProfileInputError('The button needs a link starting with https://.');
      post.callToAction = { actionType: input.cta_type, url: input.cta_url.trim() };
    }
  }
  if (input.photo_url) {
    if (!isHttpUrl(input.photo_url)) throw new ProfileInputError('The photo must be a public image address starting with https://.');
    post.media = [{ mediaFormat: 'PHOTO', sourceUrl: input.photo_url.trim() }];
  }
  if (topic === 'EVENT' || topic === 'OFFER') {
    const title = String(input.event_title ?? '').trim();
    if (!title) throw new ProfileInputError(`${topic === 'EVENT' ? 'Events' : 'Offers'} need a title.`);
    if (title.length > 58) throw new ProfileInputError('Google allows event and offer titles of up to 58 characters.');
    const startDate = parseDate(input.start_date ?? '', 'Start date');
    const endDate = parseDate(input.end_date ?? '', 'End date');
    if (dateText(endDate) < dateText(startDate)) throw new ProfileInputError('The end date is before the start date.');
    post.event = {
      title,
      schedule: {
        startDate, endDate,
        ...(input.start_time ? { startTime: parseTime(input.start_time, 'Start time') } : {}),
        ...(input.end_time ? { endTime: parseTime(input.end_time, 'End time') } : {}),
      },
    };
  }
  if (topic === 'OFFER') {
    if (input.redeem_url && !isHttpUrl(input.redeem_url)) throw new ProfileInputError('The redeem link must start with https://.');
    post.offer = {
      ...(input.coupon_code ? { couponCode: String(input.coupon_code).trim().slice(0, 58) } : {}),
      ...(input.redeem_url ? { redeemOnlineUrl: input.redeem_url.trim() } : {}),
      ...(input.terms ? { termsConditions: String(input.terms).trim().slice(0, 5000) } : {}),
    };
  }
  return post;
}

export function describePost(post: LocalPost): string {
  const kind = post.topicType === 'EVENT' ? 'Event' : post.topicType === 'OFFER' ? 'Offer' : 'Update';
  const title = post.event?.title ? ` "${post.event.title}"` : '';
  const text = post.summary ? `: ${post.summary.length > 120 ? `${post.summary.slice(0, 119)}…` : post.summary}` : '';
  return `${kind}${title}${text}`;
}

export function evaluatePost(rules: ProfileRules, post: LocalPost): ReplyFinding[] {
  const findings: ReplyFinding[] = [];
  if (rules.posts === 'off') findings.push({ severity: 'blocked', code: 'posts_off', message: 'This location doesn\'t let AI assistants publish posts. A person can post on the dashboard.' });
  if (rules.posts === 'approval') findings.push({ severity: 'approval', code: 'posts_approval', message: 'Posts at this location wait for a person to approve them.' });
  if (PLACEHOLDER_RE.test(`${post.summary ?? ''} ${post.event?.title ?? ''}`)) findings.push({ severity: 'approval', code: 'placeholder', message: 'The post looks like it still contains a template placeholder.' });
  if (post.topicType === 'OFFER') findings.push({ severity: 'approval', code: 'offer', message: 'Offers commit the business to a deal, so they always need a person\'s approval.' });
  return findings;
}

// ── Photos ───────────────────────────────────────────────────────────────────

export interface PhotoInput { url: string; category?: PhotoCategory; description?: string }

export function validatePhoto(input: PhotoInput): { sourceUrl: string; category: PhotoCategory; description?: string } {
  const sourceUrl = String(input.url ?? '').trim();
  if (!isHttpUrl(sourceUrl)) throw new ProfileInputError('The photo must be a public image address starting with https:// (Google downloads it from there).');
  const category = (String(input.category ?? 'ADDITIONAL').toUpperCase()) as PhotoCategory;
  if (!PHOTO_CATEGORIES.includes(category)) throw new ProfileInputError(`The photo category must be one of ${PHOTO_CATEGORIES.join(', ')}.`);
  const description = input.description ? String(input.description).trim().slice(0, 500) : undefined;
  return { sourceUrl, category, ...(description ? { description } : {}) };
}

export function evaluatePhoto(rules: ProfileRules, photo: { category: PhotoCategory }): ReplyFinding[] {
  const findings: ReplyFinding[] = [];
  if (rules.photos === 'off') findings.push({ severity: 'blocked', code: 'photos_off', message: 'This location doesn\'t let AI assistants add photos. A person can add them on the dashboard.' });
  if (rules.photos === 'approval') findings.push({ severity: 'approval', code: 'photos_approval', message: 'Photos at this location wait for a person to approve them.' });
  if (['COVER', 'PROFILE', 'LOGO'].includes(photo.category)) findings.push({ severity: 'approval', code: 'identity_photo', message: `A new ${photo.category.toLowerCase()} photo changes how the business looks in Search and Maps, so it needs approval.` });
  return findings;
}

/** Deleting a post or photo always waits for a person, unless the location blocks it outright. */
export function evaluateDelete(rules: ProfileRules, kind: 'post_delete' | 'photo_delete'): ReplyFinding[] {
  const mode = kind === 'post_delete' ? rules.posts : rules.photos;
  if (mode === 'off') return [{ severity: 'blocked', code: `${kind}_off`, message: `This location doesn't let AI assistants manage its ${kind === 'post_delete' ? 'posts' : 'photos'}.` }];
  return [{ severity: 'approval', code: 'delete', message: 'Deleting always needs a person\'s approval.' }];
}

// ── Checklist ────────────────────────────────────────────────────────────────

export interface ChecklistItem { id: string; label: string; status: 'done' | 'warn' | 'todo'; detail: string }

export interface ChecklistInput {
  profile: ProfileView;
  photos: { total: number; categories: string[] } | null;
  posts: { newest: string | null } | null;
  stats: LocationStats;
  google_updates: string[];
  now?: Date;
}

/** How complete and well-kept the profile is, with the next step for anything missing. */
export function profileChecklist(input: ChecklistInput): { score: number; items: ChecklistItem[] } {
  const now = input.now ?? new Date();
  const items: ChecklistItem[] = [];
  const item = (id: string, label: string, status: ChecklistItem['status'], detail: string) => items.push({ id, label, status, detail });
  const p = input.profile;
  const days = (iso: string | null) => iso ? (now.getTime() - Date.parse(iso)) / 86_400_000 : Infinity;

  item('verified', 'Verified profile', p.verified === false ? 'todo' : 'done',
    p.verified === false ? 'Verify the profile in Business Profile Manager. Unverified profiles can\'t reply to reviews or post.' : 'Google shows this business as verified.');
  const len = p.description.trim().length;
  item('description', 'Business description', len >= 250 ? 'done' : len ? 'warn' : 'todo',
    len >= 250 ? `${len} of ${MAX_DESCRIPTION_CHARS} characters.` : len ? `Only ${len} characters. Use more of the ${MAX_DESCRIPTION_CHARS} to cover services, areas and what makes the business different.` : 'Add a description of up to 750 characters.');
  item('category', 'Categories', !p.primary_category ? 'todo' : p.additional_categories.length ? 'done' : 'warn',
    !p.primary_category ? 'Set a primary category in Business Profile Manager.' : p.additional_categories.length
      ? `${p.primary_category}, plus ${p.additional_categories.length} more.` : `${p.primary_category}. Add secondary categories for other services you offer.`);
  item('phone', 'Phone number', p.primary_phone ? 'done' : 'todo', p.primary_phone ?? 'Add a phone number so people can call from Search and Maps.');
  item('website', 'Website', p.website ? 'done' : 'todo', p.website ?? 'Add the website address.');
  item('hours', 'Opening hours', p.regular_hours.length ? 'done' : 'todo', p.regular_hours.length ? describeHours(p.regular_hours) : 'Add opening hours; profiles without them are shown less.');
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + 60 * 86_400_000).toISOString().slice(0, 10);
  const upcoming = p.special_hours.filter(s => s.date >= today && s.date <= horizon);
  item('special_hours', 'Holiday hours', upcoming.length ? 'done' : 'warn',
    upcoming.length ? `Set for ${upcoming.map(s => s.date).join(', ')}.` : 'No special hours in the next 60 days. Add them for upcoming public holidays so Google doesn\'t mark the hours "might differ".');
  if (input.photos) {
    const n = input.photos.total;
    item('photos', 'Photos', n >= 10 ? 'done' : n ? 'warn' : 'todo', n >= 10 ? `${n} photos.` : n ? `${n} photo${n === 1 ? '' : 's'}. Aim for at least 10, and add new ones every month.` : 'Add photos of the premises, team and work.');
    const missing = ['LOGO', 'COVER'].filter(c => !input.photos!.categories.includes(c));
    item('brand_photos', 'Logo and cover photo', missing.length ? 'warn' : 'done', missing.length ? `Add a ${missing.map(m => m.toLowerCase()).join(' and ')} photo.` : 'Both set.');
  }
  if (input.posts) {
    const age = days(input.posts.newest);
    item('posts', 'Recent posts', age <= 7 ? 'done' : age <= 30 ? 'warn' : 'todo',
      age === Infinity ? 'No posts yet. Post an update, offer or event every week.' : age <= 7 ? 'Posted in the last week.' : `Last post ${Math.round(age)} days ago. Post at least weekly.`);
  }
  const s = input.stats;
  item('replies', 'Replies to reviews', s.unreplied_negative ? 'todo' : s.response_rate_90d === null || s.response_rate_90d >= 90 ? 'done' : 'warn',
    s.unreplied_negative ? `${s.unreplied_negative} review${s.unreplied_negative === 1 ? '' : 's'} rated 1–3 stars without a reply.`
      : s.response_rate_90d === null ? 'No reviews in the last 90 days.' : `${s.response_rate_90d}% of the last 90 days' reviews answered${s.response_rate_90d < 90 ? '; aim for 90% or more' : ''}.`);
  item('fresh_reviews', 'New reviews', s.last_30_days.reviews ? 'done' : 'warn',
    s.last_30_days.reviews ? `${s.last_30_days.reviews} in the last 30 days.` : 'None in the last 30 days. Send happy customers the review link.');
  item('google_updates', 'Google-suggested edits', input.google_updates.length ? 'todo' : 'done',
    input.google_updates.length ? `Google shows different ${input.google_updates.join(', ')} from what you set. Review them on the Profile tab.` : 'Google shows the profile as you set it.');

  const score = Math.round((items.reduce((sum, i) => sum + (i.status === 'done' ? 1 : i.status === 'warn' ? 0.5 : 0), 0) / items.length) * 100);
  return { score, items };
}

/** Google field-mask names, in plain words. */
export const FIELD_LABEL: Record<string, string> = {
  title: 'business name', phoneNumbers: 'phone number', 'phoneNumbers.primaryPhone': 'phone number', 'phoneNumbers.additionalPhones': 'additional phone numbers',
  categories: 'categories', 'categories.primaryCategory': 'primary category', 'categories.additionalCategories': 'additional categories',
  storefrontAddress: 'address', websiteUri: 'website', regularHours: 'opening hours', specialHours: 'special hours', profile: 'description',
  'profile.description': 'description', openInfo: 'open status', serviceArea: 'service area', latlng: 'map pin', moreHours: 'more hours',
};

export function fieldsFromMask(mask: string): string[] {
  return [...new Set(mask.split(',').map(f => f.trim()).filter(Boolean).map(f => FIELD_LABEL[f] ?? FIELD_LABEL[f.split('.')[0]] ?? f))];
}
