# Discovery upgrade validation

The baseline upgrade and all 112 sequential cycles are recorded in [IMPROVEMENT_CYCLES.md](IMPROVEMENT_CYCLES.md). The final integration pass checked the following.

| Check | Result |
| --- | --- |
| Backend suite | 189 tests passed across 27 files |
| Frontend suite | 28 tests passed across 7 files |
| Backend TypeScript build | Passed |
| Frontend TypeScript and Vite production build | Passed |
| ESLint | Passed with no errors; the repository's existing warning policy remains in place |
| Theme, typography, shared-dialog contracts | Passed |
| Integration-guide, Intelligence-scope and Action Centre contracts | Passed |
| Cycle ledger | Exactly 001–112, in order, with no gaps or duplicate numbers |
| Git whitespace checks | Passed |

Candidate tests additionally cover WAT extraction, physical error line numbers, unsafe sources, dates, UTF-8 and link budgets, preview rollback, receipt retention, tenant isolation, review transitions, evidence-preserving promotion and investigation-task deduplication. Component checks cover read-only access, preview, immediate note export, selection reset and bounded pagination.

The new tests cover HTML parsing, sampled links and findings, comparable audit evidence, Unicode app metadata, listing and document revisions, CSV parsing and preview rollback, backlink status changes, paused monitoring, measurement arithmetic and incomplete windows. Job tests cover concurrency, duplicate starts, cancellation, restart recovery and scoped snapshot access. HTTP tests exercise the real authorization middleware for workspace boundaries and viewer write restrictions. Component tests exercise draft guards, successful saves, failed-history retry and job resumption.

## Browser checks

Browser QA used a separate local fixture database with an artificial account, a deliberately long site name and a long backlink URL. No production workspace was used.

- The original eight Discovery tools were checked at a 320px content viewport; document width equalled viewport width. Cards and long source URLs stayed within the page.
- The app-store editor was also checked at 390px and a draft was saved through the interface.
- Overview, Sites, Work, Insights and Reports were checked at 320px. Wide tables and tab strips use local scrolling rather than widening the whole page.
- The mobile navigation drawer focused its internal close control, exposed a dialog role, closed on Escape and made closed navigation inert.
- A content brief and outline were saved through the interface. A measurement plan was saved and reopened.
- A backlink import preview reported one candidate while the tracked count stayed zero. Importing added one unverified source; pausing it changed the available action to Resume monitoring.
- The desktop backlink screen was visually inspected for hierarchy, wrapping and containment.

These checks do not constitute exhaustive device, browser or accessibility certification. Live search-provider credentials were not required; measurement and network state transitions were verified with controlled fixtures. The core outbound-request security tests remain in the backend suite.

Docker is unavailable in this execution environment. The repository's existing Docker smoke workflow remains the container-build gate when the branch reaches GitHub. No Docker build, GitHub CI run, deployment or release is claimed by this local validation record.

## Cycle 112 validation

Comparison tests cover retained duplicate observations, changed anchors/dates, reordered evidence, unknown dates, empty/rejected extracts, unchanged live monitor status, preview rollback, receipt/snapshot pruning, legacy snapshots, tenant boundaries and expanded-snapshot budgets. Component checks cover selected imports, CSV evidence, filtering, stale-result clearing, legacy availability, refresh and load failures. The API's real authorization test includes foreign-site comparison access. No new browser/device coverage is claimed for the comparison panel.

## Next improvement idea

Cycle 113: save named comparison presets with source and coverage assumptions for recurring extract reviews.
