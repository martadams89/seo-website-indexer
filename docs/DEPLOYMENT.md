# Deployment, authentication and recovery

This guide covers the settings needed around a production installation. For a local trial, the Docker command in the main [README](../README.md#quick-start) is enough.

## Docker Compose

Download the supplied Compose file and start the service:

```bash
curl -O https://raw.githubusercontent.com/martadams89/seo-website-indexer/main/docker-compose.yml
docker compose up -d
```

The application is available on port `3000` and stores all durable data in the `seo-indexer-data` volume mounted at `/data`.

Useful commands:

```bash
docker compose logs -f
docker compose restart
docker compose down
```

`docker compose down` leaves the named data volume in place. Do not add the `--volumes` option unless you intend to remove the application's database and backups.

## Production checklist

Before exposing the application to the internet:

1. Put it behind an HTTPS reverse proxy.
2. Set a stable, random `APP_SECRET` and keep a separate copy in your secrets manager. On a fresh install, also set `ADMIN_EMAIL` so only you can create the first admin account.
3. Keep `/data` on persistent storage and copy its backups to another machine or storage service.
4. Set `CORS_ORIGIN` if the dashboard is served from a different origin.
5. Serve the app over HTTPS. The site, MCP server URL, OAuth issuer and Google/Bing/SSO callbacks use `https://` for any public hostname automatically, even when your reverse proxy forwards plain http. Set `PUBLIC_URL` to pin the canonical origin (for example when the app is reached by several names), and enable `TRUST_PROXY` only if a trusted reverse proxy overwrites forwarded headers.
6. Make sure the reverse proxy forwards `/mcp`, `/oauth/*` and `/.well-known/oauth-*` to the container as well as the dashboard. MCP clients discover sign-in through these paths.
7. Configure SMTP if users need invitations and self-service password resets.
8. Decide whether local passwords, SSO or both should be available.
9. Sign in as the first super-admin, enable MFA and create named accounts for other people. For workspaces whose members can change Google Ads, turn on **Require MFA** under **Governance & usage → Workspace policy**.
10. Pin a versioned image tag if you require controlled upgrade windows.

A suitable secret can be generated with:

```bash
openssl rand -hex 32
```

Add it to the container environment as `APP_SECRET`. Do not commit the value to the repository.

## Container settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port inside the container. |
| `HOST` | `0.0.0.0` | Address the server binds to. |
| `DATA_DIR` | `/data` | Directory containing the database, generated encryption key and backups. |
| `APP_SECRET` | generated in `/data/.key` | Encrypts OAuth tokens and delivery credentials. Set it explicitly for portable restores. |
| `PUBLIC_URL` | request host, `https://` | Canonical origin for passkeys, SSO and Google/Bing sign-in callbacks, the MCP server URL and OAuth issuer, and links back to the dashboard. Without it the host comes from the request and the scheme is `https` for any public hostname; `localhost`, IP addresses and LAN names (`nas`, `*.local`, `*.lan`) stay `http` unless the proxy sends `X-Forwarded-Proto: https`. Set `PUBLIC_URL=http://…` only to serve plain http on a public name. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` values. Enable only behind a proxy that overwrites them. |
| `CORS_ORIGIN` | disabled | Comma-separated browser origins allowed to call the API when the frontend is separate. |
| `OUTBOUND_HOST_ALLOWLIST` | unset | Exact trusted hostnames that may resolve to private/reserved addresses. |
| `ALLOW_INSECURE_OUTBOUND` | `false` | Permit HTTP user-configured targets. Use only on a controlled network. |
| `ALLOW_PRIVATE_OUTBOUND` | `false` | Permit all private/reserved targets. Prefer the exact hostname allowlist. |
| `LOG_LEVEL` | application default | Pino log level, such as `info`, `warn` or `error`. |
| `BACKUP_KEEP` | `7` | Number of nightly SQLite backups to retain. |
| `RATE_LIMIT_MAX` | `300` | General requests allowed per IP during `RATE_LIMIT_WINDOW`. |
| `RATE_LIMIT_WINDOW` | `1 minute` | General rate-limit window. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Authentication requests allowed per IP during `AUTH_RATE_LIMIT_WINDOW`. |
| `AUTH_RATE_LIMIT_WINDOW` | `1 minute` | Authentication rate-limit window. |
| `AI_CITATION_DAILY_LIMIT` | `25` | Citation checks allowed each day for non-owner members. |
| `AI_DRAFT_DAILY_LIMIT` | `25` | Ranking-playbook AI drafts allowed each day for non-owner members. |
| `GSC_INSPECTION_DAILY_LIMIT` | `2000` | Daily Google URL Inspection allowance per Search Console property. |
| `REVIEWS_SYNC_MINUTES` | `60` | How often each linked Business Profile location's reviews are synced. Minimum 15. |
| `ADMIN_EMAIL` | unset | Only this email address (case-insensitive) may create the first admin account. Set it before a fresh install is reachable from the internet; without it, whoever signs up first becomes super-admin. |
| `GOOGLE_ADS_API_VERSION` | `v26` | Google Ads REST API version. Raise it when Google releases a new version and the release notes allow. |
| `OAUTH_RATE_LIMIT_MAX` | `30` | MCP OAuth registration, token and revocation requests allowed per IP per minute. |
| `MCP_OAUTH_REDIRECT_ALLOWLIST` | unset | Comma-separated redirect hosts/schemes MCP clients may use, e.g. `chatgpt.com,claude.ai,*.claude.com,vscode.dev,cursor:,localhost,127.0.0.1`. Unset allows any `https` redirect. |
| `GOOGLE_INDEXING_DAILY_LIMIT` | `200` | Daily Google Indexing API notifications per Cloud project, shared by sites that opt in. Set `0` to disable. Raise it only if Google has granted a higher quota. |

### Security notes for a public install

- The dashboard API requires a session cookie and an `X-Requested-With` header on every change; workspace roles and capabilities are enforced by the API.
- The MCP endpoint accepts only OAuth access tokens (one hour, refreshable for 30 days, revocable under **Connected apps**) or hashed personal tokens. Prefer OAuth or a header over a `?token=` URL, which can end up in proxy logs.
- OAuth uses PKCE (S256 only) and exact redirect-URI matching (loopback redirects may change port); client registration only accepts `https` redirects (or `http` on localhost and app-specific schemes) and is rate-limited. Set `MCP_OAUTH_REDIRECT_ALLOWLIST` to the AI apps you actually use so look-alike apps can't register — see below.

### Redirect allowlist examples

`MCP_OAUTH_REDIRECT_ALLOWLIST` takes hostnames, `*.` wildcards for subdomains, and app schemes ending in `:`. Common clients:

| Client | Entries |
| --- | --- |
| ChatGPT | `chatgpt.com,platform.openai.com` |
| Claude | `claude.ai,*.claude.com` |
| VS Code | `vscode.dev,insiders.vscode.dev,127.0.0.1` |
| Cursor | `cursor:` |
| Agent CLIs (Claude Code, Codex, Gemini CLI) and local tools | `localhost,127.0.0.1` |

For example: `MCP_OAUTH_REDIRECT_ALLOWLIST=chatgpt.com,platform.openai.com,claude.ai,*.claude.com,vscode.dev,insiders.vscode.dev,cursor:,localhost,127.0.0.1`. If an app fails to connect, its sign-in error shows the redirect URL it used; add that host. The allowlist also applies to clients registered on the dashboard and to client metadata documents.
- Google Ads changes are validated by Google before they are stored and are always subject to the client's monthly budget and guardrails. Every applied change is in the change log and the audit trail.

The liveness endpoint is `GET /api/livez`. The readiness endpoint is `GET /api/healthz` and also checks the database and scheduler.

User-configured site, webhook, connector, SSO and FTP targets are blocked when they resolve to loopback, link-local, private or reserved addresses. Redirect targets are checked again. For an intentional internal integration, add only its exact hostname to `OUTBOUND_HOST_ALLOWLIST`; the two broad `ALLOW_*` switches should be a last resort.

## Sign-in methods

Password sign-in is always available. Users can add TOTP 2FA or a passkey from **Settings → Account & Security**.

Passkeys require HTTPS on a production hostname. Browsers allow plain HTTP only on `localhost` for development.

### Google SSO

This controls sign-in to the dashboard. It is separate from linking a Google account for Search Console.

```bash
SSO_GOOGLE_CLIENT_ID=your-client-id
SSO_GOOGLE_CLIENT_SECRET=your-client-secret
```

Register this callback URI in the Google OAuth client:

```text
https://indexer.example.com/api/auth/sso/google/callback
```

### Generic OpenID Connect

```bash
SSO_OIDC_CLIENT_ID=your-client-id
SSO_OIDC_CLIENT_SECRET=your-client-secret
SSO_OIDC_AUTH_URL=https://identity.example.com/authorize
SSO_OIDC_TOKEN_URL=https://identity.example.com/token
SSO_OIDC_USERINFO_URL=https://identity.example.com/userinfo
SSO_OIDC_NAME=Company SSO
SSO_OIDC_SCOPE="openid email profile"
```

Register this callback URI with the identity provider:

```text
https://indexer.example.com/api/auth/sso/oidc/callback
```

By default, SSO accepts only email addresses that already have an account in the application. Set `SSO_AUTO_PROVISION=true` to create a standard user on first sign-in. On a completely empty installation, the first SSO user becomes the super-admin regardless of this setting.

## Email and password resets

SMTP enables invitations, notification email and the **Forgot password?** link. Reset links are single-use and expire after one hour.

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-user
SMTP_PASS=your-password
SMTP_FROM="SEO Indexer <no-reply@example.com>"
```

Use `SMTP_SECURE=true` for implicit TLS, normally on port `465`. `SMTP_USER` and `SMTP_PASS` are optional when the server does not require authentication.

Without SMTP, a super-admin can still generate a temporary password or a shareable reset link from **Settings → Users**.

## Command-line account recovery

Use the bundled admin command when nobody can sign in as a super-admin. Replace `<container>` and the email address with the real values.

```bash
docker exec <container> node dist/cli/admin.js list
docker exec <container> node dist/cli/admin.js reset-password you@example.com
docker exec <container> node dist/cli/admin.js reset-password you@example.com 'new-password'
docker exec <container> node dist/cli/admin.js disable-2fa you@example.com
docker exec <container> node dist/cli/admin.js make-admin you@example.com
docker exec <container> node dist/cli/admin.js disable-account you@example.com
docker exec <container> node dist/cli/admin.js enable-account you@example.com
```

Run `npm run admin -- <command>` from the `backend` directory when developing from source.

## Backups

At 02:30 each day, the application creates an online SQLite backup with `VACUUM INTO`:

```text
/data/backups/indexer-YYYY-MM-DD.db
```

It keeps the newest seven files unless `BACKUP_KEEP` is changed. A super-admin can also create and list backups from the dashboard API.

These backups share the same volume as the live database, so they do not protect against loss of that volume. Copy them to separate storage. If `APP_SECRET` is not set explicitly, also copy `/data/.key`; encrypted OAuth and delivery credentials cannot be recovered without it.

Before a manual restore:

1. Stop the container.
2. Preserve the current `/data` directory so the operation can be reversed.
3. Replace `/data/indexer.db` with the chosen backup.
4. Make sure the matching `APP_SECRET` or `/data/.key` is present.
5. Start the container and check `/api/healthz` before allowing users back in.

## Updating

For a Compose installation using `latest`:

```bash
docker compose pull
docker compose up -d
```

Database migrations run when the new container starts. Take an off-volume backup first and read the [release notes](https://github.com/martadams89/seo-website-indexer/releases).

For a controlled deployment, replace `latest` in `docker-compose.yml` with a release tag such as `X.Y.Z`. Keep the previous tag and backup available until the health check and main workflows have been verified.
