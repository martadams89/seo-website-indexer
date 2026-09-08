# Public-crawl backlink candidates

Open **Discovery → Link candidates**, select your site, and import an extract of external pages linking to it. Review candidates individually or select up to 50 pending candidates to monitor or dismiss together. A candidate is historical evidence: promotion creates an **unverified** backlink. Open the backlink monitor and run a check to observe whether the source still links to you.

The importer works locally without an SEO subscription. It does not query a reverse backlink index, download crawl archives, or claim complete coverage of the web. A missing candidate says nothing about whether a backlink exists. Host counts describe the imported source/target pairs, not authority or quality.

## Input formats

Use UTF-8 `.ndjson` or `.jsonl`: one JSON object per line. Paste records or load a file, supply a descriptive source/crawl-release label, and **Preview candidates** before importing. Preview calculates duplicates and errors using a transaction that is rolled back; it saves neither candidates nor an import receipt.

For a normalised extract, supply absolute HTTP(S) URLs:

```json
{"source_url":"https://publisher.example/article","target_url":"https://example.com/guide","anchor":"Read the guide","crawl_date":"2020-01-15T12:00:00Z"}
{"source_url":"https://another-publisher.example/resources","target_url":"https://example.com/","anchor":"Example","crawl_date":null}
```

`anchor` is optional historical text, retained up to 300 characters. `crawl_date` can be absent/null, a UTC calendar date, or a UTC timestamp ending in `Z`; invalid and future dates are rejected. Unknown dates remain unknown. Provenance is the label supplied by the importer, not independently certified evidence.

The importer also accepts individual Common Crawl WAT JSON payloads using:

- `Envelope.WARC-Header-Metadata`: `WARC-Type` (`response`), `WARC-Target-URI`, `WARC-Date`.
- `Envelope.Payload-Metadata.HTTP-Response-Metadata.HTML-Metadata.Links`: anchor entries with `path: "A@/href"`, `url`, and optional `text`.

Extract these JSON payload lines from selected WAT records before importing. A complete `.warc.wat.gz` archive, WARC headers, pretty-printed JSON and JSON arrays are not accepted. See [Common Crawl's data-format guide](https://commoncrawl.org/get-started) for the archive structure. The source URI must be an external page; targets must belong to the selected site's domain or its subdomains. Image/script references and links to other sites are skipped. Relative WAT destinations resolve against the source URI; records that rely on an HTML base URL should be normalised upstream with their resolved absolute destinations.

## Review workflow

- **Pending / dismissed:** dismiss irrelevant candidates and restore them when needed. This does not send messages or contact a publisher.
- **Add to backlink monitor:** retain the source/target pair and provenance. Existing monitor records, statuses and check history are preserved. Promoted sources are subsequently managed in the backlink monitor.
- **Review notes:** explicitly save up to 4,000 characters. Saved notes are immediately included in search and export. Unsaved notes warn before page/tool navigation.
- **Find candidates:** search source, target, anchor, provenance and saved notes; filter by review state, source host and crawl age (within 180 days, older, or unknown). Changing filters clears bulk selection. The inbox renders 50 candidates per page; export includes all matching candidates.
- **Export filtered candidates:** download the current matching evidence and notes as CSV, with spreadsheet-formula escaping.
- **Import history:** load the latest 30 receipts for the selected site, including counts and source labels. Duplicate source/target pairs keep their first imported evidence and original provenance.
- **Create investigation task:** send the candidate evidence and saved notes to Work. Repeating this action reuses an existing active task; a completed/dismissed task allows a new investigation.

HTTP source pages can be retained as historical candidates. Promotion follows the installation's existing outbound policy, which requires HTTPS by default. A policy rejection leaves the candidate pending; the importer never rewrites a historical HTTP URL to HTTPS or weakens outbound safeguards.

## Resource and access limits

Each import allows up to 500,000 UTF-8 bytes, 500 JSON records, 500 matching candidate pairs and 20,000 examined links. Exceeding a budget rejects the entire import. Individual malformed records report physical input line numbers; valid records can still be imported. Skipped counts combine non-response/internal records and irrelevant links.

Each site retains at most 5,000 candidate pairs across all review states. Dismissal preserves evidence and does not free that budget. The inbox is intended for selected extracts rather than bulk archive ingestion. All candidates, notes, receipts and mutations are workspace-scoped. Viewers can read and export; writes require the workspace's `manage_content` capability. Importing and previewing make no source-page network requests.
