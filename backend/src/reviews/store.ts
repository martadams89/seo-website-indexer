/**
 * reviews/store.ts — persistence for linked Business Profile locations, the
 * reviews synced from Google, and reply plans. Every reply made through the
 * app — by a person or an AI assistant over MCP — is recorded as a reply plan,
 * so the plan history is also the audit log.
 */
import { randomUUID } from 'crypto';
import { getDb } from '../db/database.js';
import { normalizeReviewBrief, normalizeRules, type ReplyFinding, type ReplyRules, type ReviewBrief } from './rules.js';

// ── Locations ────────────────────────────────────────────────────────────────

export interface ReviewLocation {
  id: string;
  workspace_id: string;
  google_account_id: string | null;
  account_name: string;
  location_name: string;
  title: string | null;
  address: string | null;
  website: string | null;
  place_id: string | null;
  maps_uri: string | null;
  new_review_uri: string | null;
  site_id: string | null;
  brief: ReviewBrief;
  rules: ReplyRules;
  enabled: boolean;
  average_rating: number | null;
  total_reviews: number | null;
  last_synced_at: string | null;
  last_full_sync_at: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

type LocationRow = Omit<ReviewLocation, 'brief' | 'rules' | 'enabled'> & { brief: string; rules: string; enabled: number };

function parse<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

function toLocation(row: LocationRow): ReviewLocation {
  return { ...row, brief: normalizeReviewBrief(parse(row.brief, {})), rules: normalizeRules(parse(row.rules, {})), enabled: !!row.enabled };
}

export function getLocation(id: string): ReviewLocation | null {
  const row = getDb().prepare('SELECT * FROM gbp_locations WHERE id=?').get(id) as LocationRow | undefined;
  return row ? toLocation(row) : null;
}

export function listLocations(workspaceIds: string | string[]): ReviewLocation[] {
  const ids = Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds];
  if (!ids.length) return [];
  const rows = getDb().prepare(`SELECT * FROM gbp_locations WHERE workspace_id IN (${ids.map(() => '?').join(',')}) ORDER BY COALESCE(title, location_name)`).all(...ids) as LocationRow[];
  return rows.map(toLocation);
}

export function listAllEnabledLocations(): ReviewLocation[] {
  return (getDb().prepare('SELECT * FROM gbp_locations WHERE enabled=1 AND google_account_id IS NOT NULL').all() as LocationRow[]).map(toLocation);
}

export function insertLocation(input: {
  workspace_id: string; google_account_id: string; account_name: string; location_name: string; title: string | null;
  address: string | null; website: string | null; place_id: string | null; maps_uri: string | null; new_review_uri: string | null;
  site_id: string | null; created_by: string | null;
}): ReviewLocation {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO gbp_locations(id, workspace_id, google_account_id, account_name, location_name, title, address, website, place_id, maps_uri, new_review_uri, site_id, brief, rules, created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.workspace_id, input.google_account_id, input.account_name, input.location_name, input.title, input.address, input.website,
    input.place_id, input.maps_uri, input.new_review_uri, input.site_id,
    JSON.stringify(normalizeReviewBrief({ business_name: input.title ?? undefined })), JSON.stringify(normalizeRules({})), input.created_by,
  );
  return getLocation(id)!;
}

export function findLocation(workspaceId: string, locationName: string): ReviewLocation | null {
  const row = getDb().prepare('SELECT * FROM gbp_locations WHERE workspace_id=? AND location_name=?').get(workspaceId, locationName) as LocationRow | undefined;
  return row ? toLocation(row) : null;
}

export function updateLocation(id: string, patch: Partial<Pick<ReviewLocation, 'brief' | 'rules' | 'enabled' | 'site_id' | 'title' | 'average_rating' | 'total_reviews' | 'last_synced_at' | 'last_full_sync_at' | 'last_error' | 'google_account_id' | 'website' | 'address' | 'maps_uri' | 'new_review_uri' | 'place_id'>>): ReviewLocation | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key}=?`);
    values.push(key === 'brief' ? JSON.stringify(normalizeReviewBrief(value)) : key === 'rules' ? JSON.stringify(normalizeRules(value)) : key === 'enabled' ? (value ? 1 : 0) : value);
  }
  if (sets.length) getDb().prepare(`UPDATE gbp_locations SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`).run(...values, id);
  return getLocation(id);
}

export function deleteLocation(id: string): void {
  getDb().prepare('DELETE FROM gbp_locations WHERE id=?').run(id);
}

// ── Reviews ──────────────────────────────────────────────────────────────────

export interface StoredReview {
  id: string;
  location_id: string;
  workspace_id: string;
  review_name: string;
  reviewer_name: string | null;
  reviewer_photo: string | null;
  anonymous: boolean;
  rating: number;
  comment: string | null;
  create_time: string | null;
  update_time: string | null;
  reply_comment: string | null;
  reply_update_time: string | null;
  reply_state: string | null;
  reply_policy_violation: string | null;
  reply_url: string | null;
  media: Array<{ thumbnailUrl?: string; videoUrl?: string; thumbnailLabel?: string }>;
  first_seen_at: string;
}

type ReviewRow = Omit<StoredReview, 'anonymous' | 'media'> & { anonymous: number; media: string };

function toReview(row: ReviewRow): StoredReview {
  return { ...row, anonymous: !!row.anonymous, media: parse(row.media, []) };
}

export function getReview(id: string): StoredReview | null {
  const row = getDb().prepare('SELECT * FROM gbp_reviews WHERE id=?').get(id) as ReviewRow | undefined;
  return row ? toReview(row) : null;
}

export function findReviewByName(locationId: string, reviewName: string): StoredReview | null {
  const row = getDb().prepare('SELECT * FROM gbp_reviews WHERE location_id=? AND review_name=?').get(locationId, reviewName) as ReviewRow | undefined;
  return row ? toReview(row) : null;
}

export type ReviewUpsert = Omit<StoredReview, 'id' | 'first_seen_at'>;

/** Insert or refresh a review. Returns whether it was new to this location. */
export function upsertReview(input: ReviewUpsert): { review: StoredReview; created: boolean } {
  const existing = findReviewByName(input.location_id, input.review_name);
  const db = getDb();
  if (existing) {
    db.prepare(`UPDATE gbp_reviews SET reviewer_name=?, reviewer_photo=?, anonymous=?, rating=?, comment=?, create_time=?, update_time=?, reply_comment=?,
      reply_update_time=?, reply_state=?, reply_policy_violation=?, reply_url=?, media=? WHERE id=?`).run(
      input.reviewer_name, input.reviewer_photo, input.anonymous ? 1 : 0, input.rating, input.comment, input.create_time, input.update_time,
      input.reply_comment, input.reply_update_time, input.reply_state, input.reply_policy_violation, input.reply_url, JSON.stringify(input.media), existing.id);
    return { review: getReview(existing.id)!, created: false };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO gbp_reviews(id, location_id, workspace_id, review_name, reviewer_name, reviewer_photo, anonymous, rating, comment, create_time, update_time,
    reply_comment, reply_update_time, reply_state, reply_policy_violation, reply_url, media) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.location_id, input.workspace_id, input.review_name, input.reviewer_name, input.reviewer_photo, input.anonymous ? 1 : 0, input.rating,
    input.comment, input.create_time, input.update_time, input.reply_comment, input.reply_update_time, input.reply_state, input.reply_policy_violation,
    input.reply_url, JSON.stringify(input.media));
  return { review: getReview(id)!, created: true };
}

/** The newest update time among this location's stored reviews (null when none are stored yet). */
export function latestReviewUpdate(locationId: string): string | null {
  const row = getDb().prepare('SELECT COUNT(*) AS n, MAX(update_time) AS latest FROM gbp_reviews WHERE location_id=?').get(locationId) as { n: number; latest: string | null };
  return row.n ? row.latest ?? '' : null;
}

export function setReviewReply(id: string, reply: { comment: string | null; update_time: string | null; state: string | null }): void {
  getDb().prepare('UPDATE gbp_reviews SET reply_comment=?, reply_update_time=?, reply_state=?, reply_policy_violation=NULL WHERE id=?')
    .run(reply.comment, reply.update_time, reply.state, id);
}

export type ReviewFilter = 'all' | 'unreplied' | 'negative' | 'reply_rejected' | 'awaiting_approval';

export function listReviews(opts: {
  workspaceIds: string[]; locationId?: string; filter?: ReviewFilter; minRating?: number; maxRating?: number;
  sinceDays?: number; search?: string; limit?: number; offset?: number;
}): { reviews: StoredReview[]; total: number } {
  if (!opts.workspaceIds.length) return { reviews: [], total: 0 };
  const where = [`r.workspace_id IN (${opts.workspaceIds.map(() => '?').join(',')})`];
  const values: unknown[] = [...opts.workspaceIds];
  if (opts.locationId) { where.push('r.location_id=?'); values.push(opts.locationId); }
  // A reply Google rejected isn't shown to anyone, so the review still needs one.
  if (opts.filter === 'unreplied') where.push("(r.reply_comment IS NULL OR r.reply_comment='' OR r.reply_state='REJECTED')");
  if (opts.filter === 'negative') where.push('r.rating BETWEEN 1 AND 3');
  if (opts.filter === 'reply_rejected') where.push("r.reply_state='REJECTED'");
  if (opts.filter === 'awaiting_approval') where.push("EXISTS (SELECT 1 FROM gbp_replies p WHERE p.review_id=r.id AND p.status='needs_approval')");
  if (opts.minRating) { where.push('r.rating>=?'); values.push(opts.minRating); }
  if (opts.maxRating) { where.push('r.rating<=? AND r.rating>0'); values.push(opts.maxRating); }
  if (opts.sinceDays) { where.push("julianday(r.create_time) >= julianday('now', ?)"); values.push(`-${Math.floor(opts.sinceDays)} days`); }
  if (opts.search) { where.push('(r.comment LIKE ? OR r.reviewer_name LIKE ?)'); values.push(`%${opts.search}%`, `%${opts.search}%`); }
  const sql = `FROM gbp_reviews r WHERE ${where.join(' AND ')}`;
  const total = (getDb().prepare(`SELECT COUNT(*) AS n ${sql}`).get(...values) as { n: number }).n;
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const rows = getDb().prepare(`SELECT r.* ${sql} ORDER BY COALESCE(r.create_time, r.first_seen_at) DESC LIMIT ? OFFSET ?`).all(...values, limit, Math.max(0, opts.offset ?? 0)) as ReviewRow[];
  return { reviews: rows.map(toReview), total };
}

export interface LocationStats {
  total: number;
  average: number | null;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
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

export function locationStats(locationId: string): LocationStats {
  const db = getDb();
  const dist = db.prepare('SELECT rating, COUNT(*) AS n FROM gbp_reviews WHERE location_id=? AND rating BETWEEN 1 AND 5 GROUP BY rating').all(locationId) as Array<{ rating: 1 | 2 | 3 | 4 | 5; n: number }>;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;
  for (const d of dist) distribution[d.rating] = d.n;
  const one = <T>(sql: string, ...v: unknown[]) => db.prepare(sql).get(locationId, ...v) as T;
  const agg = one<{ n: number; avg: number | null }>('SELECT COUNT(*) AS n, AVG(NULLIF(rating,0)) AS avg FROM gbp_reviews WHERE location_id=?');
  const window = (from: string, to: string) => one<{ n: number; avg: number | null }>(
    "SELECT COUNT(*) AS n, AVG(NULLIF(rating,0)) AS avg FROM gbp_reviews WHERE location_id=? AND julianday(create_time) >= julianday('now', ?) AND julianday(create_time) < julianday('now', ?)", from, to);
  const last = window('-30 days', '+1 day');
  const prev = window('-60 days', '-30 days');
  const recent = db.prepare("SELECT create_time, reply_comment, reply_update_time FROM gbp_reviews WHERE location_id=? AND julianday(create_time) >= julianday('now','-90 days')").all(locationId) as Array<{ create_time: string; reply_comment: string | null; reply_update_time: string | null }>;
  const replied = recent.filter(r => r.reply_comment);
  const hours = replied
    .map(r => (Date.parse(r.reply_update_time ?? '') - Date.parse(r.create_time)) / 3_600_000)
    .filter(h => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const monthly = db.prepare(`SELECT substr(create_time,1,7) AS month, COUNT(*) AS reviews, AVG(NULLIF(rating,0)) AS average FROM gbp_reviews
    WHERE location_id=? AND julianday(create_time) >= julianday('now','-365 days') GROUP BY month ORDER BY month`).all(locationId) as Array<{ month: string; reviews: number; average: number | null }>;
  const round = (v: number | null) => v === null ? null : Math.round(v * 100) / 100;
  return {
    total: agg.n,
    average: round(agg.avg),
    distribution,
    unreplied: one<{ n: number }>("SELECT COUNT(*) AS n FROM gbp_reviews WHERE location_id=? AND (reply_comment IS NULL OR reply_comment='' OR reply_state='REJECTED')").n,
    unreplied_negative: one<{ n: number }>("SELECT COUNT(*) AS n FROM gbp_reviews WHERE location_id=? AND (reply_comment IS NULL OR reply_comment='' OR reply_state='REJECTED') AND rating BETWEEN 1 AND 3").n,
    reply_rejected: one<{ n: number }>("SELECT COUNT(*) AS n FROM gbp_reviews WHERE location_id=? AND reply_state='REJECTED'").n,
    awaiting_approval: one<{ n: number }>("SELECT COUNT(*) AS n FROM gbp_replies WHERE location_id=? AND status='needs_approval'").n,
    last_30_days: { reviews: last.n, average: round(last.avg) },
    previous_30_days: { reviews: prev.n, average: round(prev.avg) },
    response_rate_90d: recent.length ? Math.round((replied.length / recent.length) * 100) : null,
    median_response_hours_90d: hours.length ? Math.round(hours[Math.floor(hours.length / 2)] * 10) / 10 : null,
    monthly: monthly.map(m => ({ ...m, average: round(m.average) })),
  };
}

// ── Reply plans ──────────────────────────────────────────────────────────────

export type ReplyStatus = 'needs_approval' | 'blocked' | 'publishing' | 'published' | 'rejected' | 'failed' | 'superseded';

export interface ReplyPlan {
  id: string;
  workspace_id: string;
  location_id: string;
  review_id: string;
  action: 'reply' | 'delete';
  text: string | null;
  previous_reply: string | null;
  rationale: string | null;
  rating: number | null;
  source: 'dashboard' | 'mcp';
  created_by: string | null;
  status: ReplyStatus;
  findings: ReplyFinding[];
  decided_by: string | null;
  decided_at: string | null;
  published_at: string | null;
  error: string | null;
  created_at: string;
}

type ReplyRow = Omit<ReplyPlan, 'findings'> & { findings: string };
const toPlan = (row: ReplyRow): ReplyPlan => ({ ...row, findings: parse(row.findings, []) });

export function insertReplyPlan(input: Omit<ReplyPlan, 'id' | 'created_at' | 'decided_by' | 'decided_at' | 'published_at' | 'error'>): ReplyPlan {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO gbp_replies(id, workspace_id, location_id, review_id, action, text, previous_reply, rationale, rating, source, created_by, status, findings)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.workspace_id, input.location_id, input.review_id, input.action, input.text, input.previous_reply, input.rationale, input.rating,
    input.source, input.created_by, input.status, JSON.stringify(input.findings));
  return getReplyPlan(id)!;
}

export function getReplyPlan(id: string): ReplyPlan | null {
  const row = getDb().prepare('SELECT * FROM gbp_replies WHERE id=?').get(id) as ReplyRow | undefined;
  return row ? toPlan(row) : null;
}

export function listReplyPlans(opts: { workspaceIds: string[]; locationId?: string; reviewId?: string; status?: ReplyStatus; limit?: number }): ReplyPlan[] {
  if (!opts.workspaceIds.length) return [];
  const where = [`workspace_id IN (${opts.workspaceIds.map(() => '?').join(',')})`];
  const values: unknown[] = [...opts.workspaceIds];
  if (opts.locationId) { where.push('location_id=?'); values.push(opts.locationId); }
  if (opts.reviewId) { where.push('review_id=?'); values.push(opts.reviewId); }
  if (opts.status) { where.push('status=?'); values.push(opts.status); }
  const rows = getDb().prepare(`SELECT * FROM gbp_replies WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...values, Math.max(1, Math.min(500, opts.limit ?? 100))) as ReplyRow[];
  return rows.map(toPlan);
}

/** Move a plan between states, only from the expected ones. Returns false if it was no longer in them. */
export function transitionReplyPlan(id: string, from: ReplyStatus[], to: ReplyStatus, patch: { text?: string | null; decided_by?: string | null; error?: string | null; published?: boolean } = {}): boolean {
  const sets = ['status=?'];
  const values: unknown[] = [to];
  if (patch.text !== undefined) { sets.push('text=?'); values.push(patch.text); }
  if (patch.decided_by !== undefined) { sets.push("decided_by=?, decided_at=datetime('now')"); values.push(patch.decided_by); }
  if (patch.error !== undefined) { sets.push('error=?'); values.push(patch.error); }
  if (patch.published) sets.push("published_at=datetime('now')");
  const result = getDb().prepare(`UPDATE gbp_replies SET ${sets.join(', ')} WHERE id=? AND status IN (${from.map(() => '?').join(',')})`).run(...values, id, ...from);
  return result.changes > 0;
}

/** Older drafts for the same review stop waiting once a newer reply is published or proposed. */
export function supersedeOpenPlans(reviewId: string, exceptId: string): void {
  getDb().prepare("UPDATE gbp_replies SET status='superseded' WHERE review_id=? AND id<>? AND status='needs_approval'").run(reviewId, exceptId);
}
