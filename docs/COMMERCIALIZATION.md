# Commercialisation and product roadmap

The strongest initial market is not a generic SaaS reseller. It is agencies,
SEO consultants and managed-hosting providers that already operate many client
sites and want a branded, self-hosted control plane. The multi-workspace model,
delegated credentials, per-tenant settings and audit trail now support that use
case without turning the open-source core into a billing system.

## Recommendation: do not embed Stripe billing yet

Adding subscriptions, invoices and tax handling before there is demonstrated
demand would create disproportionate complexity and support liability. A
self-hosted installation also cannot be trusted as the source of truth for its
own licence or bill: its operator controls the database and application code.

Keep commercial concerns behind interfaces and add them in this order:

1. **Entitlements and metering** — plan names, feature flags, seat/site limits,
   workspace usage totals and exportable cost reports. This is useful even with
   no payment provider and lets an agency bill clients manually.
2. **Cost controls** — per-workspace and per-user daily/monthly budgets for AI
   citation calls, URL inspections and direct submission APIs; warnings at
   thresholds; hard/soft limit policies; administrator overrides.
3. **Billback reports** — an append-only usage ledger with provider, operation,
   quantity, estimated cost, user and workspace. Export CSV/JSON and support a
   configurable markup. Do not calculate invoices directly from mutable quota
   counters.
4. **Optional billing adapter** — only after customers ask for it, integrate
   Stripe Checkout + Customer Portal and signed, idempotent webhooks. Keep it an
   optional module so the indexing product works without Stripe or internet
   access to a licensing service.
5. **Hosted control plane** — if licence enforcement matters, make a service you
   control the subscription source of truth. Offline self-hosted editions should
   use signed, expiring entitlement documents with a reasonable grace period.

Stripe secret keys should normally be injected through the container's secret
store or environment, not entered into a general settings form. If a UI-based
secret flow is later required, make values write-only, encrypt them with an
external installation key, never include them in backups by default, and record
all rotations in the security audit trail.

## Practical packaging

| Edition | Candidate offering |
| --- | --- |
| Community | Current open-source indexing, analytics and normal multi-user workspaces |
| Agency | White labelling, billback exports, client reports, higher tenant limits, support |
| Enterprise | Enforced SSO/MFA policy, SCIM, audit export/retention, PostgreSQL/HA, SLA |
| Managed | Hosted upgrades/backups/monitoring while the customer's credentials remain in their environment |

Avoid charging for raw Google or IndexNow quota as though it is owned inventory;
those limits belong to upstream accounts/properties and can change. Charge for
the product's own value (automation, reporting, support and managed operations),
and pass through metered LLM/provider costs transparently when the installation
uses platform-level keys.

## Highest-value follow-on work

The v1.27 platform delivers the first four commercial foundations: workspace
and user budgets, an immutable usage ledger, billback export, retention
controls, scoped service tokens, signed webhooks and enforced workspace MFA.
That is enough to validate Agency and Managed packaging without handling money.

The next scale-dependent investments are:

1. Signed audit exports and richer audit-log filtering.
2. Session/device management beyond the current session revocation controls.
3. SCIM/group-to-role mapping for enterprise identity providers.
4. PostgreSQL plus a real job queue before supporting multiple application
   replicas; SQLite remains the right default for a single-container install.
5. Restore drills and an admin-facing backup restore workflow.

This sequence validates willingness to pay with low operational risk. Stripe is
then an adapter on top of proven entitlements and metering, rather than the
architecture around which the product has to be rebuilt.
