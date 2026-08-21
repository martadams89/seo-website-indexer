# Organic Command frontend

React and TypeScript interface for SEO Website Indexer. The app is organised around five primary destinations: Overview, Sites, Work, Insights and Reports. Less common publishing, integration, entity and governance tools are progressively disclosed by the selected workspace view.

## Local development

Run the backend on port 3000, then start Vite:

```bash
npm ci
npm run dev
```

Vite proxies `/api` to `http://localhost:3000`. The active tenant is sent as `X-Workspace-Id` by `src/api/client.ts`.

## Structure

| Path | Responsibility |
| --- | --- |
| `src/pages` | Route-level screens and the unified site workspace. |
| `src/insights` | Persistent website/date scope shared across insight tabs. |
| `src/components` | Reusable charts, dialogs and operational controls. |
| `src/api/client.ts` | HTTP transport, session and workspace headers. |
| `src/api.ts` | Domain contracts and endpoint operations. |
| `src/styles/streamlined.css` | New shell and workspace surfaces; legacy styles remain in `index.css` while they are migrated. |

## Quality checks

```bash
npm test
npm run lint
npm run build
npm run test:theme
npm run test:typography
npm run test:ui
npm run test:integrations
npm run test:intelligence
npm run test:action-centre
```

Use semantic HTML and labelled controls, keep visible filters in the shared Insights context, and add new product surfaces to the streamlined style layer rather than extending the legacy monolithic stylesheet.
