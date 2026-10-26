/**
 * reviews/profile-service.ts — Business Profile beyond reviews: the profile
 * itself (description, phone, website, opening and special hours), posts and
 * photos, Google-suggested edits, and a completeness checklist.
 *
 * Every change goes through one path. A person on the dashboard publishes
 * straight away; an AI assistant's change is judged by the location's profile
 * rules and either publishes, waits for approval, or is blocked. All changes
 * are recorded in gbp_changes, which doubles as the audit log.
 */
import type { User } from '../auth/users.js';
import { notificationEventEnabled, sendWorkspaceNotification } from '../utils/notify.js';
import {
  createLocalPost, createMedia, deleteLocalPost, deleteMedia, getGoogleUpdated, getLocationDetails, listLocalPosts, listMedia, patchLocation,
  ReviewsApiError, type LocalPost, type LocationDetails, type MediaItem, type PhotoCategory,
} from './client.js';
import {
  buildLocalPost, buildProfilePatch, describePost, describeProfileEdit, evaluateDelete, evaluatePhoto, evaluatePost, evaluateProfileEdit,
  fieldsFromMask, profileChecklist, ProfileInputError, toProfileView, validatePhoto,
  type PhotoInput, type PostInput, type ProfileEdit, type ProfileView,
} from './profile-rules.js';
import type { ReplyFinding } from './rules.js';
import {
  getChange, getLocation, insertChange, listAllEnabledLocations, listChanges, locationStats, transitionChange, updateLocation,
  type ChangeKind, type GoogleUpdates, type ProfileChange, type ReviewLocation,
} from './store.js';

const CACHE_TTL_MS = 10 * 60_000;
const GOOGLE_UPDATES_EVERY_MS = 24 * 3_600_000;

const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, fresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function forget(locationId: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${locationId}:`)) cache.delete(key);
}

function connectionOf(location: ReviewLocation): string {
  if (!location.google_account_id) throw new ReviewsApiError('This location has no Google connection. Link it again, or move it to another connection, on the Locations tab.', 'NEEDS_REAUTH');
  return location.google_account_id;
}

const parentOf = (location: ReviewLocation) => `${location.account_name}/${location.location_name}`;

function inputError(e: unknown): never {
  if (e instanceof ProfileInputError) throw new ReviewsApiError(e.message, 'INVALID_REQUEST');
  throw e;
}

const errorText = (e: unknown) => {
  const err = e as ReviewsApiError;
  const message = err instanceof Error ? err.message : String(e);
  return err?.hint ? `${message} — ${err.hint}` : message;
};

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getProfile(location: ReviewLocation, opts: { fresh?: boolean } = {}): Promise<{ profile: ProfileView; details: LocationDetails }> {
  const details = await cached(`${location.id}:profile`, !!opts.fresh, () => getLocationDetails(connectionOf(location), location.location_name));
  return { profile: toProfileView(details), details };
}

export interface PostView {
  name: string; topic: string; summary: string | null; state: string | null; button: { type: string; url: string | null } | null;
  title: string | null; start: string | null; end: string | null; photo: string | null; url: string | null;
  coupon_code: string | null; created: string | null; updated: string | null;
}

const isoDate = (d?: { year?: number; month?: number; day?: number }) => d?.year ? `${d.year}-${String(d.month ?? 1).padStart(2, '0')}-${String(d.day ?? 1).padStart(2, '0')}` : null;

function toPostView(p: LocalPost): PostView {
  return {
    name: p.name ?? '', topic: p.topicType ?? 'STANDARD', summary: p.summary ?? null, state: p.state ?? null,
    button: p.callToAction?.actionType ? { type: p.callToAction.actionType, url: p.callToAction.url ?? null } : null,
    title: p.event?.title ?? null, start: isoDate(p.event?.schedule?.startDate), end: isoDate(p.event?.schedule?.endDate),
    photo: p.media?.[0]?.googleUrl ?? p.media?.[0]?.sourceUrl ?? null, url: p.searchUrl ?? null,
    coupon_code: p.offer?.couponCode ?? null, created: p.createTime ?? null, updated: p.updateTime ?? null,
  };
}

export async function getPosts(location: ReviewLocation, opts: { fresh?: boolean } = {}): Promise<PostView[]> {
  const posts = await cached(`${location.id}:posts`, !!opts.fresh, () => listLocalPosts(connectionOf(location), parentOf(location)));
  return posts.map(toPostView).sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
}

export interface PhotoView {
  name: string; category: string; url: string | null; thumbnail: string | null; description: string | null;
  created: string | null; views: number | null; width: number | null; height: number | null; format: string;
}

function toPhotoView(m: MediaItem): PhotoView {
  return {
    name: m.name ?? '', category: m.locationAssociation?.category ?? 'ADDITIONAL', url: m.googleUrl ?? null, thumbnail: m.thumbnailUrl ?? m.googleUrl ?? null,
    description: m.description ?? null, created: m.createTime ?? null, views: m.insights?.viewCount ? Number(m.insights.viewCount) : null,
    width: m.dimensions?.widthPixels ?? null, height: m.dimensions?.heightPixels ?? null, format: m.mediaFormat ?? 'PHOTO',
  };
}

export async function getPhotos(location: ReviewLocation, opts: { fresh?: boolean } = {}): Promise<{ total: number; photos: PhotoView[] }> {
  const media = await cached(`${location.id}:photos`, !!opts.fresh, () => listMedia(connectionOf(location), parentOf(location)));
  const photos = media.items.map(toPhotoView).sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  return { total: media.total ?? photos.length, photos };
}

/** The profile, its checklist, Google-suggested edits and what's waiting for approval. */
export async function profileOverview(location: ReviewLocation, opts: { fresh?: boolean } = {}) {
  const { profile } = await getProfile(location, opts);
  const [photos, posts] = await Promise.all([
    getPhotos(location, opts).then(v => ({ value: v, error: null as string | null })).catch(e => ({ value: null, error: errorText(e) })),
    getPosts(location, opts).then(v => ({ value: v, error: null as string | null })).catch(e => ({ value: null, error: errorText(e) })),
  ]);
  const checklist = profileChecklist({
    profile,
    photos: photos.value ? { total: photos.value.total, categories: [...new Set(photos.value.photos.map(p => p.category))] } : null,
    posts: posts.value ? { newest: posts.value[0]?.created ?? null } : null,
    stats: locationStats(location.id),
    google_updates: location.google_updates?.fields ?? [],
  });
  return {
    profile, checklist, rules: location.profile_rules,
    google_updates: location.google_updates, google_updates_checked_at: location.google_updates_checked_at,
    photos: photos.value ? { total: photos.value.total } : null, photos_error: photos.error,
    posts: posts.value ? { total: posts.value.length, newest: posts.value[0]?.created ?? null } : null, posts_error: posts.error,
    pending_changes: listChanges({ workspaceIds: [location.workspace_id], locationId: location.id, status: 'needs_approval', limit: 50 }),
  };
}

// ── Google-suggested edits ───────────────────────────────────────────────────

/**
 * What Google shows differently from what the business set (Google's own
 * updates, or edits suggested by the public that Google accepted). Stored on
 * the location; `notify` sends one alert per new set of differences.
 */
export async function checkGoogleUpdates(location: ReviewLocation, opts: { notify?: boolean } = {}): Promise<GoogleUpdates> {
  const account = connectionOf(location);
  const details = await getLocationDetails(account, location.location_name);
  cache.set(`${location.id}:profile`, { at: Date.now(), value: details });
  let updates: GoogleUpdates = { fields: [], pending: [], google: {}, mask: '' };
  if (details.metadata?.hasGoogleUpdated || details.metadata?.hasPendingEdits) {
    const g = await getGoogleUpdated(account, location.location_name);
    const view = toProfileView(g.location);
    const mask = g.diffMask.split(',').map(f => f.trim()).filter(Boolean);
    const has = (field: string) => mask.some(m => m === field || m.startsWith(`${field}.`));
    updates = {
      fields: fieldsFromMask(g.diffMask), pending: fieldsFromMask(g.pendingMask), mask: mask.sort().join(','),
      google: {
        ...(has('profile') ? { description: view.description } : {}),
        ...(has('phoneNumbers') ? { primary_phone: view.primary_phone } : {}),
        ...(has('websiteUri') ? { website: view.website } : {}),
        ...(has('regularHours') ? { regular_hours: view.regular_hours } : {}),
        ...(has('specialHours') ? { special_hours: view.special_hours } : {}),
      },
    };
  }
  const previous = location.google_updates?.mask ?? '';
  updateLocation(location.id, { google_updates: updates, google_updates_checked_at: new Date().toISOString() });
  if (opts.notify && updates.mask && updates.mask !== previous && location.profile_rules.alert_google_updates
    && notificationEventEnabled(location.workspace_id, 'profile_alerts')) {
    const origin = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : null;
    await sendWorkspaceNotification(location.workspace_id, `Google changed the Business Profile — ${location.title ?? location.location_name}`,
      `Google now shows a different ${updates.fields.join(', ')} from what you set. Accept Google's version or keep yours.${origin ? `\n\nReview: ${origin}/reviews?tab=profile&location=${location.id}` : ''}`,
      'profile_alerts').catch(() => false);
  }
  return updates;
}

/** From the platform loop: re-check each location about daily. */
export async function checkDueGoogleUpdates(limit = 10): Promise<number> {
  const cutoff = Date.now() - GOOGLE_UPDATES_EVERY_MS;
  const due = listAllEnabledLocations()
    .filter(l => !l.google_updates_checked_at || Date.parse(l.google_updates_checked_at) < cutoff)
    .slice(0, limit);
  let checked = 0;
  for (const location of due) {
    try { await checkGoogleUpdates(location, { notify: true }); checked++; }
    catch { updateLocation(location.id, { google_updates_checked_at: new Date().toISOString() }); }
  }
  return checked;
}

// ── Changes ──────────────────────────────────────────────────────────────────

export type ChangeInput =
  | { kind: 'profile'; edit: ProfileEdit }
  | { kind: 'post'; post: PostInput }
  | { kind: 'post_delete'; post_name: string }
  | { kind: 'photo'; photo: PhotoInput }
  | { kind: 'photo_delete'; media_name: string };

/** Validate the input, then work out the payload to store, a one-line summary and (for assistants) the findings. */
async function prepare(location: ReviewLocation, input: ChangeInput, source: 'dashboard' | 'mcp'): Promise<{ payload: Record<string, unknown>; summary: string; findings: ReplyFinding[] }> {
  const rules = location.profile_rules;
  const parent = parentOf(location);
  try {
    switch (input.kind) {
      case 'profile': {
        const { profile, details } = await getProfile(location, { fresh: true });
        buildProfilePatch(input.edit, details);
        return { payload: { edit: input.edit }, summary: describeProfileEdit(input.edit, profile), findings: source === 'mcp' ? evaluateProfileEdit(rules, input.edit, profile) : [] };
      }
      case 'post': {
        const post = buildLocalPost(input.post);
        return { payload: { post }, summary: describePost(post), findings: source === 'mcp' ? evaluatePost(rules, post) : [] };
      }
      case 'photo': {
        const photo = validatePhoto(input.photo);
        return { payload: { photo }, summary: `${photo.category.toLowerCase().replace(/_/g, ' ')} photo from ${photo.sourceUrl}`, findings: source === 'mcp' ? evaluatePhoto(rules, photo) : [] };
      }
      case 'post_delete': {
        if (!String(input.post_name).startsWith(`${parent}/localPosts/`)) throw new ProfileInputError('That post doesn\'t belong to this location. Use a post name from the posts list.');
        const existing = (await getPosts(location).catch(() => [])).find(p => p.name === input.post_name);
        return { payload: { post_name: input.post_name }, summary: `Delete post${existing ? `: ${describePost({ topicType: existing.topic as LocalPost['topicType'], summary: existing.summary ?? undefined, event: existing.title ? { title: existing.title } : undefined })}` : ` ${input.post_name}`}`, findings: source === 'mcp' ? evaluateDelete(rules, 'post_delete') : [] };
      }
      case 'photo_delete': {
        if (!String(input.media_name).startsWith(`${parent}/media/`)) throw new ProfileInputError('That photo doesn\'t belong to this location. Use a photo name from the photos list.');
        return { payload: { media_name: input.media_name }, summary: `Delete photo ${input.media_name.split('/').pop()}`, findings: source === 'mcp' ? evaluateDelete(rules, 'photo_delete') : [] };
      }
    }
  } catch (e) { inputError(e); }
}

async function apply(change: ProfileChange, location: ReviewLocation): Promise<Record<string, unknown>> {
  const account = connectionOf(location);
  const parent = parentOf(location);
  const p = change.payload as Record<string, unknown>;
  switch (change.kind) {
    case 'profile': {
      const details = await getLocationDetails(account, location.location_name);
      let patch: ReturnType<typeof buildProfilePatch>;
      try { patch = buildProfilePatch(p.edit as ProfileEdit, details); } catch (e) { inputError(e); }
      const updated = await patchLocation(account, location.location_name, patch.body, patch.mask);
      cache.set(`${location.id}:profile`, { at: Date.now(), value: { ...details, ...updated } });
      return { fields: patch.mask };
    }
    case 'post': {
      const created = await createLocalPost(account, parent, p.post as LocalPost);
      forget(location.id);
      return { name: created.name ?? null, state: created.state ?? null, url: created.searchUrl ?? null };
    }
    case 'post_delete':
      await deleteLocalPost(account, String(p.post_name));
      forget(location.id);
      return { deleted: p.post_name };
    case 'photo': {
      const photo = p.photo as { sourceUrl: string; category: PhotoCategory; description?: string };
      const created = await createMedia(account, parent, photo);
      forget(location.id);
      return { name: created.name ?? null, url: created.googleUrl ?? null };
    }
    case 'photo_delete':
      await deleteMedia(account, String(p.media_name));
      forget(location.id);
      return { deleted: p.media_name };
  }
}

async function publish(change: ProfileChange, location: ReviewLocation): Promise<ProfileChange> {
  try {
    const result = await apply(change, location);
    transitionChange(change.id, ['publishing'], 'published', { published: true, result, error: null });
    // A profile edit can settle (or create) a difference with Google's version.
    if (change.kind === 'profile') await checkGoogleUpdates(getLocation(location.id) ?? location).catch(() => null);
  } catch (e) {
    transitionChange(change.id, ['publishing'], 'failed', { error: errorText(e) });
  }
  return getChange(change.id)!;
}

/**
 * Make a change to a location's Business Profile. A person on the dashboard
 * publishes straight away; an assistant's change goes through the location's
 * profile rules. `publish: false` always leaves it waiting for approval.
 */
export async function submitChange(input: {
  location: ReviewLocation; change: ChangeInput; user: User; source: 'dashboard' | 'mcp'; rationale?: string | null; publish?: boolean;
}): Promise<ProfileChange> {
  const { payload, summary, findings: found } = await prepare(input.location, input.change, input.source);
  let findings = found;
  if (input.source === 'mcp' && input.publish === false && !findings.some(f => f.severity === 'blocked')) {
    findings = [...findings, { severity: 'approval', code: 'draft', message: 'Saved for approval, as requested.' }];
  }
  const decision = findings.some(f => f.severity === 'blocked') ? 'blocked' : findings.some(f => f.severity === 'approval') ? 'needs_approval' : 'publish';
  const change = insertChange({
    workspace_id: input.location.workspace_id, location_id: input.location.id, kind: input.change.kind as ChangeKind, payload, summary,
    rationale: input.rationale?.trim().slice(0, 2000) || null, source: input.source, created_by: input.user.id, findings,
    status: decision === 'publish' ? 'publishing' : decision,
  });
  if (decision !== 'publish') return change;
  return publish(change, input.location);
}

export async function approveChange(id: string, user: User): Promise<ProfileChange> {
  const change = getChange(id);
  if (!change) throw new ReviewsApiError('Change not found.', 'NOT_FOUND');
  const location = getLocation(change.location_id);
  if (!location) throw new ReviewsApiError('The location for this change no longer exists.', 'NOT_FOUND');
  if (!transitionChange(change.id, ['needs_approval'], 'publishing', { decided_by: user.id })) {
    throw new ReviewsApiError(`This change is ${change.status.replace('_', ' ')} and can no longer be approved.`, 'INVALID_REQUEST');
  }
  return publish(getChange(change.id)!, location);
}

export function rejectChange(id: string, user: User): ProfileChange {
  const change = getChange(id);
  if (!change) throw new ReviewsApiError('Change not found.', 'NOT_FOUND');
  if (!transitionChange(change.id, ['needs_approval'], 'rejected', { decided_by: user.id })) {
    throw new ReviewsApiError(`This change is ${change.status.replace('_', ' ')} and can no longer be rejected.`, 'INVALID_REQUEST');
  }
  return getChange(change.id)!;
}

/**
 * Settle a difference Google shows: take Google's version of the editable
 * fields, or write the business's own values back over it.
 */
export async function resolveGoogleUpdates(location: ReviewLocation, keep: 'google' | 'mine', user: User): Promise<ProfileChange> {
  const updates = location.google_updates;
  if (!updates || !Object.keys(updates.google).length) {
    throw new ReviewsApiError('There are no Google-suggested edits to the description, phone, website or hours to settle here. Use Business Profile Manager for other fields.', 'INVALID_REQUEST');
  }
  const { profile } = await getProfile(location, { fresh: true });
  const source = keep === 'google' ? updates.google : {
    ...('description' in updates.google ? { description: profile.description } : {}),
    ...('primary_phone' in updates.google ? { primary_phone: profile.primary_phone } : {}),
    ...('website' in updates.google ? { website: profile.website } : {}),
    ...('regular_hours' in updates.google ? { regular_hours: profile.regular_hours } : {}),
    ...('special_hours' in updates.google ? { special_hours: profile.special_hours } : {}),
  };
  const edit: ProfileEdit = {};
  if (source.description !== undefined) edit.description = String(source.description ?? '');
  if (source.primary_phone) edit.primary_phone = String(source.primary_phone);
  if (source.website) edit.website = String(source.website);
  if (source.regular_hours) edit.regular_hours = source.regular_hours as ProfileEdit['regular_hours'];
  if (source.special_hours) edit.special_hours = source.special_hours as ProfileEdit['special_hours'];
  return submitChange({ location, change: { kind: 'profile', edit }, user, source: 'dashboard', rationale: keep === 'google' ? 'Accepted Google\'s version.' : 'Kept the business\'s own version over Google\'s.' });
}
