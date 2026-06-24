# Bulk Add Affiliates — Design

**Date:** 2026-06-15
**Status:** Approved (design)
**Area:** Affiliate Monitor (frontend `AffiliateMonitor.tsx` + `server/src/routes/affiliates.ts`)

## Problem

The Affiliate Monitor's "Add Affiliate" modal accepts one affiliate at a time via a
field-by-field form. Adding a batch (e.g. seven Trustpilot review URLs) means
opening the modal and re-typing name/website/geo/rating seven times. The operator
wants to paste a list of Trustpilot URLs and have the rows created — and populated —
in one action.

## Goal

Paste a list of Trustpilot review URLs → rows are created instantly from the URL,
then auto-enriched (real page name, star rating, review count) and link-validated
in one background pass. No per-row typing.

Out of scope (YAGNI): CSV/file upload, per-row inline editing inside the paste box,
editing of the enrichment results before save. Single-add stays exactly as-is.

## What a URL yields

For a line like `https://de.trustpilot.com/review/onlinecasinoohneoasis.me`:

| Field    | Source                              | Example value                      | Network? |
|----------|-------------------------------------|------------------------------------|----------|
| `tp_url` | sanitized full URL                  | `https://de.trustpilot.com/review/onlinecasinoohneoasis.me` | no |
| `website`| `/review/<domain>` path segment     | `onlinecasinoohneoasis.me`         | no |
| `geo`    | regional subdomain → ISO code       | `['DE']`                           | no |
| `name`   | title-cased domain slug (temporary) | `Onlinecasinoohneoasis`            | no |
| `rating` | JSON-LD `aggregateRating.ratingValue` | `4.3`                            | yes (enrich) |
| `reviews`| JSON-LD `aggregateRating.reviewCount` | `114`                            | yes (enrich) |
| `name` (final) | JSON-LD / `__NEXT_DATA__` business name | overwrites the slug       | yes (enrich) |

Geo subdomain map: `au.`→AU, `ca.`→CA, `de.`→DE, `dk.`→DK, `it.`→IT, plus the
existing regional set. Bare `trustpilot.com` and `www.trustpilot.com` → empty geo
(`[]`), editable later via the row edit. Unknown two-letter subdomains are upper-cased
through as-is so new markets still capture a geo without a code change.

## Architecture

Frontend stays dumb (display + fire actions). All URL parsing, dedupe, and
enrichment orchestration live in the API. Enrichment reuses the existing
Validate-Links job scaffolding rather than introducing a second job runner.

```
AffiliateMonitor (Bulk paste textarea)
        │  POST /api/affiliates/bulk { text }
        ▼
routes/affiliates.ts  → parse lines → dedupe vs DB → bulk insert
        │                                   │
        │                                   └─ returns { created, skipped, invalid, jobId }
        ▼
runLinkCheckJob(..., { enrich: true })  (existing SSE job, extended)
        │  one stealth Chromium for the batch, ScrapingBee fallback
        ▼
per URL: validate link  +  extract name/rating/reviews  → UPDATE affiliates row
        │  emits SSE progress
        ▼
useCheckLinksJob + JobProgress  (existing UI, unchanged)
```

## Components

### 1. Frontend — `AffiliateMonitor.tsx` (`AddAffiliateModal`)

- Add a segmented toggle at the top of the modal: **Single** | **Bulk paste**.
  Default to **Single** so existing muscle-memory is unchanged.
- **Single** mode: the current form, untouched.
- **Bulk paste** mode: a `<textarea>` (one URL per line) replacing the form fields.
  Below it, a live counter derived from the pasted text:
  `N URLs detected · M already tracked · K invalid`. The "already tracked" count is
  computed client-side against the `affiliates` already loaded in the view (best-effort
  preview only — the server is authoritative on insert).
- Submit button label reflects the count: **Add 5 Affiliates** (disabled when 0 valid).
- On submit: POST raw textarea text to `/api/affiliates/bulk`; on success, merge the
  returned `created` rows into local state, close the modal, and start the returned
  `jobId` through the existing `useCheckLinksJob` flow so the JobProgress panel and
  result banner show enrichment progress. Surface `skipped`/`invalid` counts in the
  result banner.

### 2. API — `POST /api/affiliates/bulk`

- Body: `{ text: string }` (newline-separated) — also accept `{ urls: string[] }`.
- For each non-blank line:
  - `sanitizeTrustpilotUrl()` (existing) → if null, push to `invalid`.
  - Require host matches `*.trustpilot.com` with a `/review/<domain>` path; otherwise
    `invalid`.
  - Derive `website`, `geo`, temporary `name` per the table above.
- Dedupe: within the paste (by normalized website) AND against existing rows
  (`SELECT website, tp_url FROM affiliates`); matches go to `skipped` (not inserted,
  not an error).
- Bulk `insert()` the survivors (`name`, `website`, `tp_url`, `geo`, `warning=false`).
- Launch `runLinkCheckJob(jobId, 'affiliates', insertedIds, registry, { enrich: true })`
  via the existing `linkCheckRegistry`; do not await it.
- Respond `201 { success: true, data: { created, skipped, invalid, jobId } }`.

### 3. Enrichment — extend the link-check path

- Add an `extractAffiliateMeta(body)` helper in `url-validator.ts` that parses the
  page body for `name`, `rating` (number), `reviews` (int) from JSON-LD
  `@type: LocalBusiness/Organization` `aggregateRating` and/or the `__NEXT_DATA__`
  blob. Returns `{ name?, rating?, reviews? }` — every field optional; absence leaves
  the parsed default in place.
- `validateTrustpilotUrlViaPlaywright` / `validateTrustpilotUrl` gain an optional
  `{ extractMeta?: boolean }` arg; when set, they return `meta` alongside
  `{ status, error }`. Both the Playwright body and the ScrapingBee-fallback body run
  through the same extractor (kept in `classifyResponse`'s sibling helper so the paths
  never drift).
- `runLinkCheckJob` gains an `opts.enrich` flag. When true and `source === 'affiliates'`,
  the per-URL `UPDATE` also writes any non-null `name`/`rating`/`reviews` from `meta`
  (alongside the existing `link_status`/`last_validated_at`). When false, behavior is
  byte-for-byte the current Validate Links.

## Data flow / failure handling

- Unparseable or non-Trustpilot line → returned in `invalid`, never inserted.
- Duplicate (in-paste or vs DB) → returned in `skipped`, never inserted.
- Insert succeeds, enrichment fails for a row → row keeps parsed `name`/empty
  rating/reviews and gets `link_status = UNKNOWN`, exactly like today's Validate Links.
- Enrichment finds a real name/rating/reviews → overwrites the temporary slug name and
  null metrics.
- Double-launch guard: the bulk endpoint creates its own `jobId`; the view's existing
  "a job is already running" guard (`linkJobId`) still applies to manual Validate Links.

## Testing

- **Parser unit tests** (server): subdomain→geo mapping incl. bare/`www`; `/review/`
  segment extraction with trailing slash, query string, missing scheme; non-Trustpilot
  and garbage lines → `invalid`; in-paste dedupe.
- **`extractAffiliateMeta` unit tests**: fixture HTML with JSON-LD `aggregateRating`
  → correct `rating`/`reviews`/`name`; page with no JSON-LD → all undefined (no throw).
- **Bulk endpoint test**: posts a mix of new + duplicate + invalid lines; asserts the
  `created`/`skipped`/`invalid` partition and that a `jobId` is returned.
- **Manual smoke**: paste the seven sample casino URLs locally; confirm rows appear
  immediately, JobProgress streams, and rating/reviews/name populate on completion.

## Affected files

- `frontend/src/views/AffiliateMonitor.tsx` — modal toggle + bulk textarea + submit.
- `frontend/src/hooks/useAffiliates.ts` — add `bulkAddAffiliates(text)`.
- `server/src/routes/affiliates.ts` — `POST /bulk`, parser, dedupe.
- `server/src/services/link-check-job.ts` — `opts.enrich`, write enriched fields.
- `server/src/services/url-validator.ts` — `extractAffiliateMeta`, `extractMeta` arg.

No schema migration required — `affiliates` already has `name`, `website`, `tp_url`,
`geo`, `rating`, `reviews`, `link_status`, `last_validated_at`.
