# Automation API and webhooks

The `/api/v1` endpoints are for server-to-server access to one workspace. They use scoped service tokens rather than a user's browser session.

## Create a token

Open **Governance & Usage → API & Webhooks**, create a service token and select only the scopes the integration needs.

The full token is displayed once. Store it in a secrets manager. The application stores only its hash, so a lost token must be replaced.

Send it in the authorization header:

```bash
curl https://indexer.example.com/api/v1/workspace \
  -H 'Authorization: Bearer oc_your_token'
```

Tokens belong to one workspace. Site IDs and incoming records are checked against that workspace. A token can have an expiry date and can be revoked immediately from the dashboard.

## Endpoints and scopes

| Endpoint | Scope | Purpose |
| --- | --- | --- |
| `GET /api/v1/workspace` | `workspace:read` | Read workspace health, action counts, forecasts and connector freshness. |
| `GET /api/v1/metrics` | `metrics:read` | Read normalized metric observations. |
| `POST /api/v1/events` | `events:write` | Add a custom numeric observation. |
| `POST /api/v1/logs/ingest` | `logs:write` | Add origin, CDN or crawler request events. Maximum 1,000 per request. |

Calling an endpoint without its required scope returns `401`.

## Reading metrics

Use `GET /api/v1/metrics` with optional source, metric and date filters. The response retains the observation time, source and any available dimensions so imported data can be distinguished from first-party connector data.

```bash
curl 'https://indexer.example.com/api/v1/metrics?source=ga4&metric=sessions' \
  -H 'Authorization: Bearer oc_your_token'
```

## Adding a custom observation

Custom events are useful for rank feeds, revenue figures, deployments or another numeric series that should appear beside the built-in sources.

```bash
curl https://indexer.example.com/api/v1/events \
  -X POST \
  -H 'Authorization: Bearer oc_your_token' \
  -H 'Content-Type: application/json' \
  -d '{
    "site_id": "site-id",
    "source": "rank_feed",
    "metric": "position",
    "value": 4,
    "unit": "rank",
    "dimension": "example query",
    "observed_at": "2026-08-17T09:00:00Z"
  }'
```

Use the exact field names accepted by the endpoint version running on your installation. Validation errors return a `4xx` response and do not add a partial observation.

## Ingesting request logs

`POST /api/v1/logs/ingest` accepts up to 1,000 request records at a time. Use it for web-server or CDN evidence such as crawler user agents, requested URLs, response codes and response times.

Break larger exports into batches and retry only failed batches. Ingestion is recorded in the workspace usage ledger and stops when a configured hard budget is reached.

## Outbound webhooks

Create outbound webhooks in **Governance & Usage → API & Webhooks**. A webhook may subscribe to named events or `*`.

Every request includes:

```text
X-Organic-Event: event.name
X-Organic-Signature: sha256=<hex digest>
```

The signature is an HMAC-SHA256 digest of the exact request body. To verify it:

1. Read the raw body without reformatting its JSON.
2. Calculate HMAC-SHA256 with the webhook secret.
3. Prefix the hex digest with `sha256=`.
4. Compare it with `X-Organic-Signature` using a constant-time comparison.
5. Reject stale or unexpected events according to your own receiver policy.

Failed deliveries are counted and the latest error is shown in the dashboard. Receivers should respond quickly with a `2xx` status and move slow work into their own queue.

## Usage and budgets

Event and log ingestion adds records to the append-only usage ledger. Workspace or per-user budgets can warn at a percentage and may be configured as a hard stop. Review these rules before connecting a high-volume log source.
