import type { FastifySchema } from 'fastify';

const shortString = { type: 'string', minLength: 1, maxLength: 300 } as const;
const nullableShortString = { anyOf: [{ type: 'string', maxLength: 300 }, { type: 'null' }] } as const;
const nullableUrlString = { anyOf: [{ type: 'string', maxLength: 2_048 }, { type: 'null' }] } as const;
const nullableId = { anyOf: [{ type: 'string', minLength: 1, maxLength: 100 }, { type: 'null' }] } as const;

const siteProperties = {
  name: shortString,
  domain: { type: 'string', minLength: 1, maxLength: 2_048 },
  sitemapUrl: { type: 'string', minLength: 1, maxLength: 2_048 },
  sitemap_url: { type: 'string', minLength: 1, maxLength: 2_048 },
  gscUrl: { type: 'string', minLength: 1, maxLength: 2_048 },
  gsc_url: { type: 'string', minLength: 1, maxLength: 2_048 },
  enabled: { type: 'integer', minimum: 0, maximum: 1 },
  googleAccountId: nullableId,
  google_account_id: nullableId,
  bingAccountId: nullableId,
  bing_account_id: nullableId,
  deploy_webhook_url: nullableUrlString,
  ftp_host: nullableShortString,
  ftp_port: { anyOf: [{ type: 'integer', minimum: 1, maximum: 65_535 }, { type: 'null' }] },
  ftp_user: nullableShortString,
  ftp_pass: { anyOf: [{ type: 'string', maxLength: 4_096 }, { type: 'null' }] },
  ftp_path: nullableShortString,
  geo_manage: { anyOf: [{ type: 'integer', minimum: 0, maximum: 1 }, { type: 'null' }] },
} as const;

export const createSiteSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['name', 'domain', 'sitemapUrl', 'gscUrl'],
    additionalProperties: false,
    properties: siteProperties,
  },
};

export const updateSiteSchema: FastifySchema = {
  body: {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    properties: siteProperties,
  },
};

export const runAllPromptsSchema: FastifySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      site_id: nullableId,
      scoped: { type: 'boolean' },
    },
  },
};

export const createWebhookSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['name', 'url'],
    additionalProperties: false,
    properties: {
      name: shortString,
      url: { type: 'string', minLength: 1, maxLength: 2_048 },
      events: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 120 } },
    },
  },
};

export const createServiceTokenSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['name', 'scopes'],
    additionalProperties: false,
    properties: {
      name: shortString,
      scopes: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 100 } },
      expires_at: { type: 'string', maxLength: 100 },
    },
  },
};

export const upsertBudgetSchema: FastifySchema = {
  body: {
    type: 'object',
    required: ['limit_value'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', maxLength: 100 },
      user_id: { type: 'string', maxLength: 100 },
      provider: { type: 'string', maxLength: 100 },
      period: { enum: ['daily', 'monthly'] },
      limit_value: { type: 'number', minimum: 0 },
      limit_unit: { enum: ['cost', 'quantity'] },
      warning_pct: { type: 'number', minimum: 0, maximum: 100 },
      hard_limit: { type: 'boolean' },
    },
  },
};
