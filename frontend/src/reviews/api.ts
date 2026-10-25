// reviews/api.ts — Google reviews contracts and calls for the dashboard.
import { apiFetch } from '../api/client';

export type ReplyMode = 'read_only' | 'review' | 'guarded' | 'autopilot';

export interface ReplyRules {
  mode: ReplyMode;
  auto_min_rating: number;
  max_length: number;
  allow_links: boolean;
  allow_contact_details: boolean;
  allow_replace_existing: boolean;
  banned_phrases: string[];
  alert_max_rating: number;
}

export interface ReviewBrief {
  business_name?: string;
  brand_voice?: string;
  sign_off?: string;
  contact_for_issues?: string;
  language?: string;
  never_do?: string;
  notes?: string;
}

export interface LocationStats {
  total: number;
  average: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  unreplied: number;
  unreplied_negative: number;
  reply_rejected: number;
  awaiting_approval: number;
  last_30_days: { reviews: number; average: number | null };
  previous_30_days: { reviews: number; average: number | null };
  response_rate_90d: number | null;
  median_response_hours_90d: number | null;
  monthly: Array<{ month: string; reviews: number; average: number | null }>;
}

export interface ReviewLocation {
  id: string;
  workspace_id: string;
  google_account_id: string | null;
  account_name: string;
  location_name: string;
  title: string | null;
  address: string | null;
  website: string | null;
  maps_uri: string | null;
  new_review_uri: string | null;
  site_id: string | null;
  brief: ReviewBrief;
  rules: ReplyRules;
  enabled: boolean;
  average_rating: number | null;
  total_reviews: number | null;
  last_synced_at: string | null;
  last_error: string | null;
  stats: LocationStats;
}

export interface ReplyFinding { severity: 'approval' | 'blocked'; code: string; message: string }

export interface ReplyPlan {
  id: string;
  location_id: string;
  review_id: string;
  action: 'reply' | 'delete';
  text: string | null;
  previous_reply: string | null;
  rationale: string | null;
  rating: number | null;
  source: 'dashboard' | 'mcp';
  status: 'needs_approval' | 'blocked' | 'publishing' | 'published' | 'rejected' | 'failed' | 'superseded';
  findings: ReplyFinding[];
  decided_at: string | null;
  published_at: string | null;
  error: string | null;
  created_at: string;
}

export interface Review {
  id: string;
  location_id: string;
  reviewer_name: string | null;
  reviewer_photo: string | null;
  anonymous: boolean;
  rating: number;
  comment: string | null;
  create_time: string | null;
  reply_comment: string | null;
  reply_update_time: string | null;
  reply_state: string | null;
  reply_policy_violation: string | null;
  reply_url: string | null;
  media: Array<{ thumbnailUrl?: string; videoUrl?: string }>;
  pending_reply: ReplyPlan | null;
}

export type ReviewFilter = 'all' | 'unreplied' | 'negative' | 'reply_rejected' | 'awaiting_approval';

export interface ConnectionStatus {
  id: string; email: string | null; project: string | null; has_business_scope: boolean; has_cloud_scope: boolean; needs_reauth: boolean;
  api: 'ok' | 'api_disabled' | 'not_approved' | 'no_scope' | 'needs_reauth' | 'error' | 'unchecked';
  accounts: number | null; message: string | null; hint: string | null;
}

export interface ReviewsSetup {
  builtin_oauth_client: boolean;
  project: string | null;
  links: { access_form: string; quotas: string; enable_apis: string; business_profile: string };
  connections: ConnectionStatus[];
  linked_locations: number;
  steps: { google_connected: boolean; business_scope: boolean; api_enabled: boolean; access_approved: boolean; locations_linked: boolean };
  ready: boolean;
}

export interface DiscoveryResult {
  connections: Array<{
    google_account_id: string; email: string | null; error: string | null; hint: string | null;
    accounts: Array<{
      account_name: string; account_title: string; error: string | null;
      locations: Array<{ location_name: string; title: string | null; address: string | null; website: string | null; verified: boolean | null; linked_location_id: string | null }>;
    }>;
  }>;
}

export interface Performance {
  period: { start: string; end: string; days: number };
  totals: Record<'search_impressions' | 'maps_impressions' | 'calls' | 'website_clicks' | 'direction_requests' | 'messages' | 'bookings', { current: number; previous: number; change_pct: number | null }>;
  daily: Array<{ date: string; impressions: number; calls: number; website_clicks: number; direction_requests: number }>;
  search_keywords: { months: string; keywords: Array<{ keyword: string; impressions: number; below_threshold: boolean }>; error: string | null };
}

export interface ReviewRoutineSettings {
  cadence: 'daily' | 'weekdays' | 'twice_weekly' | 'weekly';
  time: string;
  timezone: string;
  mode: 'within_rules' | 'drafts_only';
  lookback_days: number;
  extra_instructions?: string;
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const reviewsApi = {
  setup: (fresh = false) => apiFetch<ReviewsSetup>(`/api/reviews/setup${fresh ? '?fresh=1' : ''}`),
  enableApi: (googleAccountId: string) => apiFetch<{ ok: boolean; message: string }>('/api/reviews/setup/enable-api', { method: 'POST', ...json({ googleAccountId }) }),
  discover: () => apiFetch<DiscoveryResult>('/api/reviews/discover'),
  locations: () => apiFetch<ReviewLocation[]>('/api/reviews/locations'),
  link: (data: { googleAccountId: string; accountName: string; locationName: string }) => apiFetch<ReviewLocation>('/api/reviews/locations', { method: 'POST', ...json(data) }),
  update: (id: string, data: { brief?: ReviewBrief; rules?: Partial<ReplyRules>; enabled?: boolean }) => apiFetch<ReviewLocation>(`/api/reviews/locations/${id}`, { method: 'PATCH', ...json(data) }),
  unlink: (id: string) => apiFetch<{ ok: boolean }>(`/api/reviews/locations/${id}`, { method: 'DELETE' }),
  sync: (id: string) => apiFetch<{ fetched: number; created: number }>(`/api/reviews/locations/${id}/sync`, { method: 'POST' }),
  performance: (id: string, days = 28) => apiFetch<Performance>(`/api/reviews/locations/${id}/performance?days=${days}`),
  reviews: (q: { locationId?: string; filter?: ReviewFilter; search?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    return apiFetch<{ total: number; reviews: Review[] }>(`/api/reviews/reviews?${p}`);
  },
  reply: (reviewId: string, text: string) => apiFetch<ReplyPlan>(`/api/reviews/reviews/${reviewId}/reply`, { method: 'POST', ...json({ text }) }),
  deleteReply: (reviewId: string) => apiFetch<ReplyPlan>(`/api/reviews/reviews/${reviewId}/reply`, { method: 'DELETE' }),
  replies: (status?: ReplyPlan['status']) => apiFetch<Array<ReplyPlan & { review: Review | null; location_title: string | null }>>(`/api/reviews/replies${status ? `?status=${status}` : ''}`),
  approve: (id: string, text?: string) => apiFetch<ReplyPlan>(`/api/reviews/replies/${id}/approve`, { method: 'POST', ...json({ text }) }),
  reject: (id: string) => apiFetch<ReplyPlan>(`/api/reviews/replies/${id}/reject`, { method: 'POST', ...json({}) }),
  routine: () => apiFetch<{ settings: ReviewRoutineSettings; location_ids: string[]; connector_name: string; endpoint: string }>('/api/reviews/routine'),
  routinePrompt: (data: { settings: ReviewRoutineSettings; locationIds: string[]; connectorName: string }) =>
    apiFetch<{ prompt: string; schedule: string; cron: string }>('/api/reviews/routine/prompt', { method: 'POST', ...json(data) }),
};

export const MODE_LABEL: Record<ReplyMode, string> = {
  guarded: 'Auto-publish replies to good reviews',
  autopilot: 'Auto-publish replies inside the rules',
  review: 'Approve every reply',
  read_only: 'Read-only for AI assistants',
};
