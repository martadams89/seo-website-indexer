/**
 * mcp/business-tools.ts — Google Business Profile tools beyond reviews: the
 * profile (description, phone, website, hours), posts, photos, Google-suggested
 * edits and the completeness checklist.
 *
 * Read tools need mcp:read. Changes need reviews:write and never bypass the
 * location's profile rules: inside them a change publishes, anything else
 * waits for a person on the dashboard (or is blocked when the rules say off).
 */
import { z } from 'zod';
import { assertCanReply, resolveLocation } from '../reviews/access.js';
import { DAYS, type PostInput, type ProfileEdit, type SpecialHours } from '../reviews/profile-rules.js';
import { checkGoogleUpdates, existingMedia, getPhotos, getPosts, getProfile, profileOverview, submitChange, type ChangeInput, type PhotoView } from '../reviews/profile-service.js';
import { workspaceSlug } from '../auth/workspaces.js';
import { PHOTO_CATEGORIES } from '../reviews/client.js';
import { listChanges, type ChangeStatus, type ProfileChange, type ReviewLocation } from '../reviews/store.js';
import type { McpContext, ToolDef } from './tools.js';

const LOCATION = z.string().describe('The location: its id from reviews_list_locations (or its exact title).');
const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const TIME = z.string().regex(/^\d{1,2}:\d{2}$/).describe('24-hour time, e.g. "09:00"; "24:00" for midnight.');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date, e.g. "2026-12-24".');
const RATIONALE = z.string().max(2000).optional().describe('One line on why, shown to the person approving it.');
const PUBLISH = z.boolean().optional().describe('false = always wait for approval, even if the rules would allow publishing.');

function writable(ctx: McpContext, ref: unknown): ReviewLocation {
  const loc = resolveLocation(ctx.workspaceIds, ref);
  assertCanReply(ctx.user, loc.workspace_id);
  return loc;
}

function presentChange(ctx: McpContext, c: ProfileChange) {
  // Straight to this change, in its workspace, for the person who approves it.
  const link = ctx.origin ? `${ctx.origin}/w/${encodeURIComponent(workspaceSlug(c.workspace_id))}/approve/business/${c.id}` : null;
  const next: Record<ChangeStatus, string> = {
    published: 'Published to Google. Profile edits can take a few minutes to show (and Google sometimes reviews them first); posts and photos are checked by Google before they go live.',
    needs_approval: `Waiting for a person to approve it on the dashboard${link ? ` (${link})` : ''}. Don't resubmit it to get around a rule.`,
    blocked: 'Blocked by this location\'s settings. Report it; a person must change the profile rules or make the change on the dashboard.',
    publishing: 'Being published right now.',
    rejected: 'A person rejected this change.',
    failed: 'Google refused the change. Read the error; fix the input if it was a mistake, otherwise report it.',
  };
  return { change_id: c.id, kind: c.kind, status: c.status, summary: c.summary, findings: c.findings, error: c.error, result: c.result, next_step: next[c.status] };
}

const MEDIA_FORMAT = z.enum(['photo', 'video']).optional().describe('Worked out from the file extension when left out (.mp4, .mov… are videos).');
const MEDIA_ITEM = {
  url: z.string().url().describe('Direct https link to the file (not a web page that shows it). Google downloads it from here.'),
  category: z.enum(PHOTO_CATEGORIES).optional().describe('Default ADDITIONAL. Job photos: AT_WORK; staff: TEAMS. Videos can\'t be COVER, PROFILE or LOGO.'),
  description: z.string().max(500).optional(),
  format: MEDIA_FORMAT,
};

/** Add one photo or video, unless the same address was already added. */
async function addMedia(ctx: McpContext, loc: ReviewLocation, item: { url: string; category?: string; description?: string; format?: string }, args: Record<string, unknown>, photos?: PhotoView[]) {
  if (!args.allowDuplicates) {
    const existing = await existingMedia(loc, item.url, photos);
    if (existing) {
      return {
        url: item.url, status: 'skipped_duplicate', via: existing.via, added: existing.added,
        ...(existing.change_id ? { earlier_change_id: existing.change_id, earlier_status: existing.status } : {}),
        next_step: existing.via === 'app' ? `Already ${existing.status === 'needs_approval' ? 'waiting for approval' : 'added'} from this address. Nothing was sent.` : 'Google already has a photo from this address. Nothing was sent.',
      };
    }
  }
  const result = await submitChange({
    location: loc, user: ctx.user, source: 'mcp', rationale: args.rationale as string | undefined, publish: args.publish as boolean | undefined,
    change: { kind: 'photo', photo: { url: item.url, category: item.category as (typeof PHOTO_CATEGORIES)[number] | undefined, description: item.description, format: item.format as 'photo' | 'video' | undefined } },
  });
  return { url: item.url, ...presentChange(ctx, result) };
}

async function change(ctx: McpContext, ref: unknown, input: ChangeInput, args: Record<string, unknown>) {
  const loc = writable(ctx, ref);
  const result = await submitChange({ location: loc, change: input, user: ctx.user, source: 'mcp', rationale: args.rationale as string | undefined, publish: args.publish as boolean | undefined });
  return presentChange(ctx, result);
}

export const BUSINESS_TOOLS: ToolDef[] = [
  {
    name: 'business_get_profile',
    title: 'Get a Business Profile',
    description: 'The location\'s profile as the business set it (description, phone, website, categories, address, opening and special hours), a completeness checklist with the next step for each gap, fields Google shows differently, the AI profile rules, and changes waiting for approval.',
    scope: 'mcp:read',
    inputShape: { location: LOCATION, fresh: z.boolean().optional().describe('Skip the 10-minute cache.') },
    annotations: READ,
    handler: async (ctx, args) => {
      const loc = resolveLocation(ctx.workspaceIds, args.location);
      const overview = await profileOverview(loc, { fresh: !!args.fresh });
      return { location: { id: loc.id, title: loc.title }, ...overview, pending_changes: overview.pending_changes.map(c => presentChange(ctx, c)) };
    },
  },
  {
    name: 'business_check_google_updates',
    title: 'Check for Google-suggested edits',
    description: 'Ask Google now which profile fields it shows differently from what the business set (its own updates, or edits from the public that it accepted), and which of the business\'s own edits are still waiting to publish. The server also checks daily and alerts the workspace.',
    scope: 'mcp:read',
    inputShape: { location: LOCATION },
    annotations: READ,
    handler: async (ctx, args) => {
      const loc = resolveLocation(ctx.workspaceIds, args.location);
      return { location: loc.title, ...(await checkGoogleUpdates(loc)) };
    },
  },
  {
    name: 'business_update_profile',
    title: 'Edit a Business Profile',
    description: 'Change the description (up to 750 characters, no links), phone, website, the weekly opening hours, or special hours for holidays. Only pass what should change. regular_hours replaces the whole weekly schedule (days left out show as closed). Use special_hours_add and special_hours_remove to change single dates. The location\'s profile rules decide whether it publishes or waits for approval; phone and website changes always wait.',
    scope: 'reviews:write',
    inputShape: {
      location: LOCATION,
      description: z.string().max(750).optional(),
      primary_phone: z.string().max(40).optional().describe('International format, e.g. "+44 113 496 0000".'),
      website: z.string().url().optional(),
      regular_hours: z.array(z.object({ day: z.enum(DAYS), open: TIME, close: TIME })).max(21).optional()
        .describe('Every opening period of the week. "close" at or before "open" runs past midnight; 00:00–24:00 is open all day.'),
      special_hours_add: z.array(z.object({ date: DATE, closed: z.boolean(), open: TIME.optional(), close: TIME.optional() })).max(50).optional()
        .describe('Dates to add or replace, e.g. { date: "2026-12-25", closed: true }.'),
      special_hours_remove: z.array(DATE).max(50).optional().describe('Dates whose special hours should be removed.'),
      rationale: RATIONALE,
      publish: PUBLISH,
    },
    annotations: WRITE,
    handler: async (ctx, args) => {
      const loc = writable(ctx, args.location);
      const edit: ProfileEdit = {};
      if (args.description !== undefined) edit.description = String(args.description);
      if (args.primary_phone !== undefined) edit.primary_phone = String(args.primary_phone);
      if (args.website !== undefined) edit.website = String(args.website);
      if (args.regular_hours !== undefined) edit.regular_hours = args.regular_hours as ProfileEdit['regular_hours'];
      const add = (args.special_hours_add as SpecialHours[] | undefined) ?? [];
      const remove = (args.special_hours_remove as string[] | undefined) ?? [];
      if (add.length || remove.length) {
        const { profile } = await getProfile(loc, { fresh: true });
        const kept = profile.special_hours.filter(s => !remove.includes(s.date) && !add.some(a => a.date === s.date));
        edit.special_hours = [...kept, ...add].sort((a, b) => a.date.localeCompare(b.date));
      }
      return change(ctx, loc.id, { kind: 'profile', edit }, args);
    },
  },
  {
    name: 'business_list_posts',
    title: 'List Business Profile posts',
    description: 'The location\'s posts (updates, events and offers), newest first, with Google\'s state (LIVE, PROCESSING or REJECTED) and links.',
    scope: 'mcp:read',
    inputShape: { location: LOCATION, limit: z.number().int().min(1).max(100).optional() },
    annotations: READ,
    handler: async (ctx, args) => {
      const loc = resolveLocation(ctx.workspaceIds, args.location);
      const posts = await getPosts(loc);
      return { location: loc.title, total: posts.length, posts: posts.slice(0, (args.limit as number | undefined) ?? 20) };
    },
  },
  {
    name: 'business_create_post',
    title: 'Publish a Business Profile post',
    description: 'Post an update (STANDARD), EVENT or OFFER to the profile, optionally with a photo (public https URL) and a button. Text up to 1,500 characters and no phone numbers (Google rejects them; use the CALL button). Events and offers need a title and start/end dates. Offers always wait for approval; otherwise the location\'s profile rules decide.',
    scope: 'reviews:write',
    inputShape: {
      location: LOCATION,
      topic: z.enum(['STANDARD', 'EVENT', 'OFFER']).optional().describe('Default STANDARD (an update).'),
      summary: z.string().max(1500).optional().describe('The post text.'),
      cta_type: z.enum(['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL']).optional().describe('Button; CALL uses the profile\'s phone number.'),
      cta_url: z.string().url().optional().describe('Where the button goes (not for CALL).'),
      photo_url: z.string().url().optional().describe('A public https image URL; Google downloads it.'),
      event_title: z.string().max(58).optional(),
      start_date: DATE.optional(),
      start_time: TIME.optional(),
      end_date: DATE.optional(),
      end_time: TIME.optional(),
      coupon_code: z.string().max(58).optional(),
      redeem_url: z.string().url().optional(),
      terms: z.string().max(5000).optional(),
      language: z.string().max(10).optional().describe('Language code, default "en".'),
      rationale: RATIONALE,
      publish: PUBLISH,
    },
    annotations: WRITE,
    handler: async (ctx, args) => {
      const { location: ref, rationale: _r, publish: _p, ...post } = args;
      return change(ctx, ref, { kind: 'post', post: post as PostInput }, args);
    },
  },
  {
    name: 'business_delete_post',
    title: 'Ask to delete a post',
    description: 'Request deletion of a post (name from business_list_posts). Deleting always waits for a person to approve it.',
    scope: 'reviews:write',
    inputShape: { location: LOCATION, postName: z.string().describe('"accounts/…/locations/…/localPosts/…" from business_list_posts.'), rationale: z.string().min(5).max(2000) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: (ctx, args) => change(ctx, args.location, { kind: 'post_delete', post_name: String(args.postName) }, args),
  },
  {
    name: 'business_list_photos',
    title: 'List Business Profile photos',
    description: 'Photos and videos the business added, newest first, with format, category (COVER, LOGO, EXTERIOR, INTERIOR, PRODUCT, AT_WORK, TEAMS…), view counts, links and (when Google reports it) the address each was added from.',
    scope: 'mcp:read',
    inputShape: { location: LOCATION, limit: z.number().int().min(1).max(100).optional() },
    annotations: READ,
    handler: async (ctx, args) => {
      const loc = resolveLocation(ctx.workspaceIds, args.location);
      const { total, photos } = await getPhotos(loc);
      return { location: loc.title, total, photos: photos.slice(0, (args.limit as number | undefined) ?? 30) };
    },
  },
  {
    name: 'business_add_photo',
    title: 'Add a photo or video to a Business Profile',
    description: 'Add one photo or video from a direct https link (Google downloads it). Photos: JPG or PNG, 10 KB–5 MB, at least 250×250 px (720×720 or larger is best). Videos: up to 30 seconds, 75 MB, 720p or higher. The link is checked first, and an address already added is skipped. New cover, profile and logo photos always wait for approval; otherwise the location\'s profile rules decide. For several, use business_add_media.',
    scope: 'reviews:write',
    inputShape: {
      location: LOCATION,
      ...MEDIA_ITEM,
      rationale: RATIONALE,
      publish: PUBLISH,
      allowDuplicates: z.boolean().optional().describe('Add it even if the same address was added before.'),
    },
    annotations: WRITE,
    handler: async (ctx, args) => addMedia(ctx, writable(ctx, args.location), { url: String(args.url), category: args.category as string | undefined, description: args.description as string | undefined, format: args.format as string | undefined }, args),
  },
  {
    name: 'business_add_media',
    title: 'Add several photos and videos to a Business Profile',
    description: 'Add up to 25 photos and videos in one go, for example a day\'s job photos taken from a social media scheduler. Each item is checked (link, type, size) and goes through the location\'s profile rules on its own; addresses already added, or repeated in the list, are skipped. Returns a result per item and totals. Photos: JPG or PNG, 10 KB–5 MB. Videos: up to 30 seconds, 75 MB, 720p or higher.',
    scope: 'reviews:write',
    inputShape: {
      location: LOCATION,
      items: z.array(z.object(MEDIA_ITEM)).min(1).max(25),
      rationale: RATIONALE,
      publish: PUBLISH,
      allowDuplicates: z.boolean().optional().describe('Add items even if the same address was added before.'),
    },
    annotations: WRITE,
    handler: async (ctx, args) => {
      const loc = writable(ctx, args.location);
      const items = (args.items as Array<{ url: string; category?: string; description?: string; format?: string }>) ?? [];
      // One look at the gallery for the whole batch.
      const photos = args.allowDuplicates ? undefined : (await getPhotos(loc, { fresh: true }).catch(() => null))?.photos ?? [];
      const seen = new Set<string>();
      const results: Array<Record<string, unknown>> = [];
      for (const item of items) {
        if (seen.has(item.url)) { results.push({ url: item.url, status: 'skipped_duplicate', next_step: 'Listed twice in this request.' }); continue; }
        seen.add(item.url);
        try { results.push(await addMedia(ctx, loc, item, args, photos)); }
        catch (e) { results.push({ url: item.url, status: 'invalid', error: e instanceof Error ? e.message : String(e) }); }
      }
      const count = (status: string) => results.filter(r => r.status === status).length;
      return {
        location: loc.title,
        totals: { published: count('published'), waiting_for_approval: count('needs_approval'), blocked: count('blocked'), failed: count('failed'), invalid: count('invalid'), skipped_duplicate: count('skipped_duplicate') },
        items: results,
        next_step: count('needs_approval') ? 'Items waiting for approval are sent to the workspace\'s approvers as one notification; they can approve them all at once on the dashboard.' : undefined,
      };
    },
  },
  {
    name: 'business_delete_photo',
    title: 'Ask to delete a photo',
    description: 'Request deletion of a photo (name from business_list_photos). Deleting always waits for a person to approve it.',
    scope: 'reviews:write',
    inputShape: { location: LOCATION, photoName: z.string().describe('"accounts/…/locations/…/media/…" from business_list_photos.'), rationale: z.string().min(5).max(2000) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: (ctx, args) => change(ctx, args.location, { kind: 'photo_delete', media_name: String(args.photoName) }, args),
  },
  {
    name: 'business_list_changes',
    title: 'List Business Profile changes',
    description: 'Profile edits, posts and photos made or proposed through this app (by people and assistants), newest first. Use status "needs_approval" for what is waiting.',
    scope: 'mcp:read',
    inputShape: {
      location: LOCATION.optional(),
      status: z.enum(['needs_approval', 'blocked', 'published', 'rejected', 'failed']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: READ,
    handler: (ctx, args) => {
      const loc = args.location ? resolveLocation(ctx.workspaceIds, args.location) : null;
      return {
        changes: listChanges({ workspaceIds: loc ? [loc.workspace_id] : ctx.workspaceIds, locationId: loc?.id, status: args.status as ChangeStatus | undefined, limit: (args.limit as number | undefined) ?? 20 })
          .map(c => ({ ...presentChange(ctx, c), source: c.source, created_at: c.created_at })),
      };
    },
  },
];
