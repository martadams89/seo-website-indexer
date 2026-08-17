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
2. Set a stable, random `APP_SECRET` and keep a separate copy in your secrets manager.
3. Keep `/data` on persistent storage and copy its backups to another machine or storage service.
4. Set `CORS_ORIGIN` if the dashboard is served from a different origin.
5. Configure SMTP if users need invitations and self-service password resets.
6. Decide whether local passwords, SSO or both should be available.
7. Sign in as the first super-admin, enable MFA and create named accounts for other people.
8. Pin a versioned image tag if you require controlled upgrade windows.

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
| `CORS_ORIGIN` | request origin | Comma-separated browser origins allowed to call the API. |
| `LOG_LEVEL` | application default | Pino log level, such as `info`, `warn` or `error`. |
| `BACKUP_KEEP` | `7` | Number of nightly SQLite backups to retain. |
| `RATE_LIMIT_MAX` | `300` | General requests allowed per IP during `RATE_LIMIT_WINDOW`. |
| `RATE_LIMIT_WINDOW` | `1 minute` | General rate-limit window. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Authentication requests allowed per IP during `AUTH_RATE_LIMIT_WINDOW`. |
| `AUTH_RATE_LIMIT_WINDOW` | `1 minute` | Authentication rate-limit window. |
| `AI_CITATION_DAILY_LIMIT` | `25` | Citation checks allowed each day for non-owner members. |
| `GSC_INSPECTION_DAILY_LIMIT` | `2000` | Daily Google URL Inspection allowance per Search Console property. |

The liveness endpoint is `GET /api/livez`. The readiness endpoint is `GET /api/healthz` and also checks the database and scheduler.

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
