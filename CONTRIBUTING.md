# Contributing

Thanks for helping make SEO Website Indexer better! It's a small, focused codebase — most contributions land quickly.

## Quick start

```bash
# Backend (Fastify + tsx watch)
cd backend && npm install && npm run dev     # http://localhost:3000

# Frontend (Vite HMR, proxies /api → :3000)
cd frontend && npm install && npm run dev    # http://localhost:5173
```

## Before you open a PR

```bash
cd backend  && npm test && npm run build     # unit tests + typecheck
cd frontend && npm run lint && npm run build # eslint + typecheck
```

CI runs exactly these, plus a Docker build.

## Commit messages — Conventional Commits (required)

Releases are fully automated by [release-please](https://github.com/googleapis/release-please): your commit messages *become* the changelog and decide the next version.

| Prefix | Effect | Example |
|--------|--------|---------|
| `fix:` | patch release | `fix: sitemap fetch hangs on dead hosts` |
| `feat:` | minor release | `feat: Brave Search citation provider` |
| `feat!:` / `BREAKING CHANGE:` | major release | `feat!: drop Node 18 support` |
| `docs:` `chore:` `perf:` `ci:` | changelog only | `docs: clarify OAuth scopes` |

Write the description as a user-facing sentence — it ships verbatim in the release notes.

## What makes a good PR here

- **Small and focused** — one feature or fix per PR.
- **Tested where it counts** — pure logic (parsers, linters, diffing) gets a unit test in `backend/src/__tests__/`; UI and API wiring are covered by typecheck + build.
- **No new runtime dependencies without a reason** — the single-container, no-external-services design is the product.
- **Provider integrations** (search engines, LLMs) must degrade gracefully when unconfigured and never log secrets.

## Reporting bugs / requesting features

Use the issue templates. For bugs, the **Live Logs** page output around the failure is usually the fastest path to a fix.
