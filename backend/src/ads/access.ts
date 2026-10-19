/**
 * ads/access.ts — who may see and change which Google Ads accounts.
 *
 * Reading follows workspace membership. Changing needs edit rights plus the
 * `manage_ads` capability in the workspace that owns the account, and honours
 * the workspace's MFA requirement — the same rules the dashboard API applies,
 * so an MCP token can never do more than its owner could in the UI.
 */
import { getWorkspaceSettings } from '../db/database.js';
import { canEditWorkspace, hasCapability } from '../auth/workspaces.js';
import { listPasskeys } from '../auth/passkeys.js';
import type { User } from '../auth/users.js';
import { AdsApiError, cleanCustomerId } from './client.js';
import { getAdsAccount, listAdsAccounts, type AdsAccount } from './store.js';

export function adsChangeDenial(user: User, workspaceId: string): string | null {
  if (!canEditWorkspace(user, workspaceId)) return 'You have read-only access to this workspace.';
  if (!hasCapability(user, workspaceId, 'manage_ads')) return 'You don\'t have the "manage ads" permission in this workspace — ask a workspace admin.';
  const policy = getWorkspaceSettings(workspaceId);
  if (policy.workspace_mfa_required === 'true' && !user.totp_enabled && listPasskeys(user.id).length === 0) {
    return 'This workspace requires MFA. Enroll an authenticator or passkey before making changes.';
  }
  return null;
}

export function assertCanChangeAds(user: User, workspaceId: string): void {
  const denial = adsChangeDenial(user, workspaceId);
  if (denial) throw new AdsApiError(denial, 'PERMISSION');
}

/**
 * Resolve an account reference — the app's account id or a Google Ads
 * customer ID (with or without dashes) — within the given workspaces.
 */
export function resolveAdsAccount(workspaceIds: string[], ref: unknown): AdsAccount {
  const value = String(ref ?? '').trim();
  if (!value) throw new AdsApiError('Pass an account (the id from ads_list_clients, or the Google Ads customer ID).', 'INVALID_REQUEST');
  const byId = getAdsAccount(value);
  if (byId && workspaceIds.includes(byId.workspace_id)) return byId;
  let customerId: string | null = null;
  try { customerId = cleanCustomerId(value); } catch { /* not a customer id */ }
  if (customerId) {
    const matches = listAdsAccounts(workspaceIds).filter(a => a.customer_id === customerId);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new AdsApiError(`Customer ${value} is linked in ${matches.length} workspaces; pass one of these account ids instead: ${matches.map(m => m.id).join(', ')}`, 'INVALID_REQUEST');
    }
  }
  throw new AdsApiError(`Ad account "${value}" is not linked to any workspace you can access. Link it on the Google Ads page (or with ads_link_account).`, 'NOT_FOUND');
}
