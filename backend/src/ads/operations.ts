/**
 * ads/operations.ts — build Google Ads REST MutateOperations for the common
 * optimisation tasks, so an assistant (or the dashboard) doesn't have to
 * hand-write raw operations for everyday changes. Anything not covered here
 * can still be sent through the generic mutate path.
 */
import { AdsApiError, cleanCustomerId, unitsToMicros } from './client.js';

export type Operation = Record<string, unknown>;

// ── Resource names ───────────────────────────────────────────────────────────

const COLLECTIONS = {
  campaign: 'campaigns',
  campaign_budget: 'campaignBudgets',
  ad_group: 'adGroups',
  ad_group_ad: 'adGroupAds',
  ad_group_criterion: 'adGroupCriteria',
  campaign_criterion: 'campaignCriteria',
  shared_set: 'sharedSets',
  asset_group: 'assetGroups',
} as const;
export type EntityKind = keyof typeof COLLECTIONS;

/** Accept a numeric id, a composite id ("123~456") or a full resource name for the given customer. */
export function resourceName(customerId: string, kind: EntityKind, id: string | number): string {
  const cid = cleanCustomerId(customerId);
  const value = String(id).trim();
  const collection = COLLECTIONS[kind];
  if (value.startsWith('customers/')) {
    const match = new RegExp(`^customers/(\\d+)/${collection}/([0-9~-]+)$`).exec(value);
    if (!match) throw new AdsApiError(`"${value}" is not a ${kind.replaceAll('_', ' ')} resource name.`, 'INVALID_REQUEST');
    if (match[1] !== cid) throw new AdsApiError(`"${value}" belongs to a different ad account.`, 'INVALID_REQUEST');
    return value;
  }
  const composite = kind === 'ad_group_ad' || kind === 'ad_group_criterion' || kind === 'campaign_criterion';
  const pattern = composite ? /^\d+~\d+$/ : /^-?\d+$/;
  if (!pattern.test(value)) {
    throw new AdsApiError(composite
      ? `${kind.replaceAll('_', ' ')} ids look like "adGroupId~id" (or pass the full resource name).`
      : `"${value}" is not a valid ${kind.replaceAll('_', ' ')} id.`, 'INVALID_REQUEST');
  }
  return `customers/${cid}/${collection}/${value}`;
}

const OPERATION_BY_COLLECTION: Record<string, string> = {
  campaigns: 'campaignOperation',
  campaignBudgets: 'campaignBudgetOperation',
  adGroups: 'adGroupOperation',
  adGroupAds: 'adGroupAdOperation',
  adGroupCriteria: 'adGroupCriterionOperation',
  campaignCriteria: 'campaignCriterionOperation',
  sharedCriteria: 'sharedCriterionOperation',
  sharedSets: 'sharedSetOperation',
  assetGroups: 'assetGroupOperation',
  assets: 'assetOperation',
  campaignAssets: 'campaignAssetOperation',
  adGroupAssets: 'adGroupAssetOperation',
};

/** "customers/1/adGroupCriteria/2~3" → adGroupCriterionOperation. */
export function operationTypeFor(resource: string): string | null {
  const collection = /^customers\/\d+\/([A-Za-z]+)\//.exec(resource)?.[1];
  return collection ? OPERATION_BY_COLLECTION[collection] ?? null : null;
}

export function updateOperation(resource: string, fields: Record<string, unknown>, mask: string[]): Operation {
  const type = operationTypeFor(resource);
  if (!type) throw new AdsApiError(`Can't build an update for ${resource}.`, 'INVALID_REQUEST');
  return { [type]: { update: { resourceName: resource, ...fields }, updateMask: mask.join(',') } };
}

export function removeOperation(resource: string): Operation {
  const type = operationTypeFor(resource);
  if (!type) throw new AdsApiError(`Can't build a removal for ${resource}.`, 'INVALID_REQUEST');
  return { [type]: { remove: resource } };
}

// ── Status, budgets and bids ─────────────────────────────────────────────────

export type EntityStatus = 'ENABLED' | 'PAUSED' | 'REMOVED';

/** Pause/enable via an update; REMOVED becomes a remove operation (permanent). */
export function statusOperations(customerId: string, kind: EntityKind, ids: Array<string | number>, status: EntityStatus): Operation[] {
  if (!['campaign', 'ad_group', 'ad_group_ad', 'ad_group_criterion', 'campaign_criterion', 'asset_group'].includes(kind)) {
    throw new AdsApiError(`Status can't be changed on ${kind.replaceAll('_', ' ')}.`, 'INVALID_REQUEST');
  }
  if (kind === 'campaign_criterion' && status !== 'REMOVED') {
    throw new AdsApiError('Campaign criteria (e.g. negative keywords, locations) can only be removed, not paused.', 'INVALID_REQUEST');
  }
  return ids.map(id => {
    const name = resourceName(customerId, kind, id);
    return status === 'REMOVED' ? removeOperation(name) : updateOperation(name, { status }, ['status']);
  });
}

export function budgetAmountOperation(customerId: string, budgetId: string | number, dailyAmount: number): Operation {
  return updateOperation(resourceName(customerId, 'campaign_budget', budgetId), { amountMicros: unitsToMicros(dailyAmount) }, ['amountMicros']);
}

export function keywordBidOperation(customerId: string, criterionId: string, cpcBid: number): Operation {
  return updateOperation(resourceName(customerId, 'ad_group_criterion', criterionId), { cpcBidMicros: unitsToMicros(cpcBid) }, ['cpcBidMicros']);
}

export function adGroupBidOperation(customerId: string, adGroupId: string | number, cpcBid: number): Operation {
  return updateOperation(resourceName(customerId, 'ad_group', adGroupId), { cpcBidMicros: unitsToMicros(cpcBid) }, ['cpcBidMicros']);
}

// ── Keywords ─────────────────────────────────────────────────────────────────

export type MatchType = 'EXACT' | 'PHRASE' | 'BROAD';
export interface KeywordInput { text: string; matchType?: MatchType; cpcBid?: number | null }

function cleanKeyword(input: KeywordInput): { text: string; matchType: MatchType } {
  const text = String(input.text ?? '').trim().replace(/\s+/g, ' ');
  if (!text) throw new AdsApiError('Keyword text is empty.', 'INVALID_REQUEST');
  if (text.length > 80) throw new AdsApiError(`Keyword "${text.slice(0, 40)}…" is longer than 80 characters.`, 'INVALID_REQUEST');
  if (text.split(' ').length > 10) throw new AdsApiError(`Keyword "${text}" has more than 10 words.`, 'INVALID_REQUEST');
  const matchType = (String(input.matchType ?? 'PHRASE').toUpperCase()) as MatchType;
  if (!['EXACT', 'PHRASE', 'BROAD'].includes(matchType)) throw new AdsApiError(`Unknown match type ${matchType}.`, 'INVALID_REQUEST');
  return { text, matchType };
}

export function addKeywordOperations(customerId: string, adGroupId: string | number, keywords: KeywordInput[], opts: { negative?: boolean } = {}): Operation[] {
  if (!keywords.length) throw new AdsApiError('Provide at least one keyword.', 'INVALID_REQUEST');
  const adGroup = resourceName(customerId, 'ad_group', adGroupId);
  return keywords.map(k => {
    const keyword = cleanKeyword(k);
    const create: Record<string, unknown> = { adGroup, status: 'ENABLED', keyword };
    if (opts.negative) create.negative = true;
    else if (k.cpcBid !== undefined && k.cpcBid !== null) create.cpcBidMicros = unitsToMicros(k.cpcBid);
    return { adGroupCriterionOperation: { create } };
  });
}

export function campaignNegativeOperations(customerId: string, campaignId: string | number, keywords: KeywordInput[]): Operation[] {
  if (!keywords.length) throw new AdsApiError('Provide at least one negative keyword.', 'INVALID_REQUEST');
  const campaign = resourceName(customerId, 'campaign', campaignId);
  return keywords.map(k => ({ campaignCriterionOperation: { create: { campaign, negative: true, keyword: cleanKeyword(k) } } }));
}

export function sharedSetNegativeOperations(customerId: string, sharedSetId: string | number, keywords: KeywordInput[]): Operation[] {
  if (!keywords.length) throw new AdsApiError('Provide at least one negative keyword.', 'INVALID_REQUEST');
  const sharedSet = resourceName(customerId, 'shared_set', sharedSetId);
  return keywords.map(k => ({ sharedCriterionOperation: { create: { sharedSet, keyword: cleanKeyword(k) } } }));
}

// ── Responsive search ads ────────────────────────────────────────────────────

export interface RsaInput {
  finalUrl: string;
  headlines: Array<string | { text: string; pin?: 1 | 2 | 3 }>;
  descriptions: Array<string | { text: string; pin?: 1 | 2 }>;
  path1?: string;
  path2?: string;
  status?: 'ENABLED' | 'PAUSED';
}

export function responsiveSearchAdCreate(adGroup: string, input: RsaInput): Record<string, unknown> {
  let url: URL;
  try { url = new URL(input.finalUrl); } catch { throw new AdsApiError('finalUrl must be a full https:// URL.', 'INVALID_REQUEST'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new AdsApiError('finalUrl must be an http(s) URL.', 'INVALID_REQUEST');
  const headlines = input.headlines.map(h => typeof h === 'string' ? { text: h } : h).map(h => ({ ...h, text: String(h.text ?? '').trim() }));
  const descriptions = input.descriptions.map(d => typeof d === 'string' ? { text: d } : d).map(d => ({ ...d, text: String(d.text ?? '').trim() }));
  if (headlines.length < 3 || headlines.length > 15) throw new AdsApiError('Responsive search ads need 3–15 headlines.', 'INVALID_REQUEST');
  if (descriptions.length < 2 || descriptions.length > 4) throw new AdsApiError('Responsive search ads need 2–4 descriptions.', 'INVALID_REQUEST');
  for (const h of headlines) if (!h.text || h.text.length > 30) throw new AdsApiError(`Headline "${h.text}" must be 1–30 characters.`, 'INVALID_REQUEST');
  for (const d of descriptions) if (!d.text || d.text.length > 90) throw new AdsApiError(`Description "${d.text.slice(0, 40)}…" must be 1–90 characters.`, 'INVALID_REQUEST');
  for (const p of [input.path1, input.path2]) if (p && p.length > 15) throw new AdsApiError(`Display path "${p}" must be 15 characters or fewer.`, 'INVALID_REQUEST');
  const asset = (item: { text: string; pin?: number }, field: 'HEADLINE' | 'DESCRIPTION') => ({
    text: item.text,
    ...(item.pin ? { pinnedField: `${field}_${item.pin}` } : {}),
  });
  return {
    adGroup,
    status: input.status ?? 'PAUSED',
    ad: {
      finalUrls: [url.toString()],
      responsiveSearchAd: {
        headlines: headlines.map(h => asset(h, 'HEADLINE')),
        descriptions: descriptions.map(d => asset(d, 'DESCRIPTION')),
        ...(input.path1 ? { path1: input.path1 } : {}),
        ...(input.path2 ? { path2: input.path2 } : {}),
      },
    },
  };
}

export function responsiveSearchAdOperation(customerId: string, adGroupId: string | number, input: RsaInput): Operation {
  return { adGroupAdOperation: { create: responsiveSearchAdCreate(resourceName(customerId, 'ad_group', adGroupId), input) } };
}

// ── Bidding ──────────────────────────────────────────────────────────────────

export type BiddingStrategy = 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CONVERSION_VALUE' | 'TARGET_SPEND' | 'MANUAL_CPC';

export function biddingFields(strategy: BiddingStrategy, opts: { targetCpa?: number | null; targetRoas?: number | null; maxCpc?: number | null }): { fields: Record<string, unknown>; mask: string[] } {
  switch (strategy) {
    case 'MAXIMIZE_CONVERSIONS': {
      const inner: Record<string, unknown> = {};
      if (opts.targetCpa) inner.targetCpaMicros = unitsToMicros(opts.targetCpa);
      return { fields: { maximizeConversions: inner }, mask: [opts.targetCpa ? 'maximizeConversions.targetCpaMicros' : 'maximizeConversions'] };
    }
    case 'MAXIMIZE_CONVERSION_VALUE': {
      const inner: Record<string, unknown> = {};
      if (opts.targetRoas) inner.targetRoas = opts.targetRoas;
      return { fields: { maximizeConversionValue: inner }, mask: [opts.targetRoas ? 'maximizeConversionValue.targetRoas' : 'maximizeConversionValue'] };
    }
    case 'TARGET_SPEND': {
      const inner: Record<string, unknown> = {};
      if (opts.maxCpc) inner.cpcBidCeilingMicros = unitsToMicros(opts.maxCpc);
      return { fields: { targetSpend: inner }, mask: [opts.maxCpc ? 'targetSpend.cpcBidCeilingMicros' : 'targetSpend'] };
    }
    case 'MANUAL_CPC':
      return { fields: { manualCpc: { enhancedCpcEnabled: false } }, mask: ['manualCpc.enhancedCpcEnabled'] };
    default:
      throw new AdsApiError(`Unsupported bid strategy ${String(strategy)}.`, 'INVALID_REQUEST');
  }
}

export function campaignBiddingOperation(customerId: string, campaignId: string | number, strategy: BiddingStrategy, opts: { targetCpa?: number | null; targetRoas?: number | null; maxCpc?: number | null }): Operation {
  const { fields, mask } = biddingFields(strategy, opts);
  return updateOperation(resourceName(customerId, 'campaign', campaignId), fields, mask);
}

// ── New search campaign ──────────────────────────────────────────────────────

export interface SearchCampaignInput {
  name: string;
  dailyBudget: number;
  biddingStrategy: BiddingStrategy;
  targetCpa?: number | null;
  targetRoas?: number | null;
  maxCpc?: number | null;
  locationIds?: string[];
  languageIds?: string[];
  adGroupName?: string;
  defaultCpcBid?: number | null;
  keywords?: KeywordInput[];
  negativeKeywords?: KeywordInput[];
  ad?: RsaInput;
  startDate?: string | null;
}

/**
 * One atomic change that creates a budget, a PAUSED search campaign, its
 * location/language targeting, an ad group, keywords and (optionally) a
 * responsive search ad. Temporary negative ids link the new resources.
 */
export function searchCampaignOperations(customerId: string, input: SearchCampaignInput): Operation[] {
  const cid = cleanCustomerId(customerId);
  const name = String(input.name ?? '').trim();
  if (!name) throw new AdsApiError('Campaign name is required.', 'INVALID_REQUEST');
  const budget = `customers/${cid}/campaignBudgets/-1`;
  const campaign = `customers/${cid}/campaigns/-2`;
  const adGroup = `customers/${cid}/adGroups/-3`;
  const bidding = biddingFields(input.biddingStrategy, input);
  const ops: Operation[] = [
    { campaignBudgetOperation: { create: { resourceName: budget, name: `${name} budget`, amountMicros: unitsToMicros(input.dailyBudget), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
    {
      campaignOperation: {
        create: {
          resourceName: campaign,
          name,
          status: 'PAUSED',
          advertisingChannelType: 'SEARCH',
          campaignBudget: budget,
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
          geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
          containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          ...(input.startDate ? { startDate: input.startDate } : {}),
          ...bidding.fields,
        },
      },
    },
  ];
  for (const id of input.locationIds ?? []) {
    ops.push({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: `geoTargetConstants/${String(id).replace(/\D/g, '')}` } } } });
  }
  for (const id of input.languageIds ?? []) {
    ops.push({ campaignCriterionOperation: { create: { campaign, language: { languageConstant: `languageConstants/${String(id).replace(/\D/g, '')}` } } } });
  }
  for (const k of input.negativeKeywords ?? []) {
    ops.push({ campaignCriterionOperation: { create: { campaign, negative: true, keyword: cleanKeyword(k) } } });
  }
  ops.push({
    adGroupOperation: {
      create: {
        resourceName: adGroup,
        name: input.adGroupName?.trim() || `${name} – ad group 1`,
        campaign,
        status: 'ENABLED',
        type: 'SEARCH_STANDARD',
        ...(input.defaultCpcBid ? { cpcBidMicros: unitsToMicros(input.defaultCpcBid) } : {}),
      },
    },
  });
  for (const k of input.keywords ?? []) {
    const create: Record<string, unknown> = { adGroup, status: 'ENABLED', keyword: cleanKeyword(k) };
    if (k.cpcBid) create.cpcBidMicros = unitsToMicros(k.cpcBid);
    ops.push({ adGroupCriterionOperation: { create } });
  }
  if (input.ad) ops.push({ adGroupAdOperation: { create: responsiveSearchAdCreate(adGroup, { ...input.ad, status: 'ENABLED' }) } });
  return ops;
}
