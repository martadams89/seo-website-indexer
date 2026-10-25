/**
 * reviews/access.ts — who may answer which Google reviews.
 *
 * Reading follows workspace membership. Replying needs edit rights plus the
 * `manage_reviews` capability in the workspace that owns the location, and
 * honours the workspace's MFA requirement — the same rules as the dashboard,
 * so an MCP token can never do more than its owner could in the UI.
 */
import { getWorkspaceSettings } from '../db/database.js';
import { canEditWorkspace, hasCapability } from '../auth/workspaces.js';
import { listPasskeys } from '../auth/passkeys.js';
import type { User } from '../auth/users.js';
import { ReviewsApiError } from './client.js';
import { getLocation, getReview, listLocations, type ReviewLocation, type StoredReview } from './store.js';

export function reviewsChangeDenial(user: User, workspaceId: string): string | null {
  if (!canEditWorkspace(user, workspaceId)) return 'You have read-only access to this workspace.';
  if (!hasCapability(user, workspaceId, 'manage_reviews')) return 'You don\'t have the "manage reviews" permission in this workspace — ask a workspace admin.';
  const policy = getWorkspaceSettings(workspaceId);
  if (policy.workspace_mfa_required === 'true' && !user.totp_enabled && listPasskeys(user.id).length === 0) {
    return 'This workspace requires MFA. Enroll an authenticator or passkey before making changes.';
  }
  return null;
}

export function assertCanReply(user: User, workspaceId: string): void {
  const denial = reviewsChangeDenial(user, workspaceId);
  if (denial) throw new ReviewsApiError(denial, 'PERMISSION');
}

/** Resolve a location by the app's id, Google's "locations/123" name, or an exact title, within the given workspaces. */
export function resolveLocation(workspaceIds: string[], ref: unknown): ReviewLocation {
  const value = String(ref ?? '').trim();
  if (!value) throw new ReviewsApiError('Pass a location (its id from reviews_list_locations).', 'INVALID_REQUEST');
  const byId = getLocation(value);
  if (byId && workspaceIds.includes(byId.workspace_id)) return byId;
  const all = listLocations(workspaceIds);
  const matches = all.filter(l => l.location_name === value || l.location_name === `locations/${value}` || (l.title ?? '').toLowerCase() === value.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new ReviewsApiError(`"${value}" matches ${matches.length} linked locations; pass one of these ids: ${matches.map(m => `${m.id} (${m.title ?? m.location_name})`).join(', ')}`, 'INVALID_REQUEST');
  throw new ReviewsApiError(`Location "${value}" is not linked to any workspace you can access. Link it on the Reviews page (or with reviews_link_location).`, 'NOT_FOUND');
}

/** Resolve a review by the app's id within the given workspaces. */
export function resolveReview(workspaceIds: string[], ref: unknown): { review: StoredReview; location: ReviewLocation } {
  const review = getReview(String(ref ?? '').trim());
  if (!review || !workspaceIds.includes(review.workspace_id)) throw new ReviewsApiError(`Review "${String(ref)}" was not found. Use the id from reviews_list.`, 'NOT_FOUND');
  return { review, location: getLocation(review.location_id)! };
}
