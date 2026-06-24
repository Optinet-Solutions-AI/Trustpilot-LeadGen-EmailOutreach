# Bulk Add Affiliates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator paste a list of Trustpilot review URLs in the Affiliate Monitor and have rows created instantly from each URL, then auto-enriched (real name, rating, review count) and link-validated in one background pass.

**Architecture:** Frontend stays dumb — the bulk modal POSTs raw pasted text to a new `POST /api/affiliates/bulk`. The API parses each line into `{website, geo, tp_url, name}`, dedupes against existing rows, bulk-inserts, then launches the existing Validate-Links job with a new `enrich` flag. The enrich pass reuses the stealth-Chromium link checker and additionally scrapes `name`/`rating`/`reviews` from each page's JSON-LD.

**Tech Stack:** TypeScript (Express + Node), Supabase JS, Playwright (existing stealth pool), Vitest (server unit tests), React + Vite + Tailwind (frontend).

---

## File Structure

**New (pure, dependency-free — unit tested):**
- `server/src/services/affiliate-url-parser.ts` — parse a pasted line → `ParsedAffiliate`; partition a paste into insert/skip/invalid. No project imports.
- `server/src/services/affiliate-meta-extractor.ts` — parse page HTML → `{name?, rating?, reviews?}` from JSON-LD. No project imports.
- `server/src/services/affiliate-url-parser.test.ts`
- `server/src/services/affiliate-meta-extractor.test.ts`

**Modified:**
- `server/src/services/url-validator.ts` — thread an `extractMeta` option through the Playwright path; return optional `meta`.
- `server/src/services/link-check-job.ts` — add `opts.enrich`; write enriched fields on the per-URL update.
- `server/src/routes/affiliates.ts` — `POST /bulk`.
- `frontend/src/hooks/useAffiliates.ts` — `bulkAddAffiliates(text)`.
- `frontend/src/views/AffiliateMonitor.tsx` — Single/Bulk toggle + paste textarea + wiring.

**Why pure modules:** the parser and extractor hold all the real logic and must be cheaply testable. Keeping them free of Playwright/Supabase imports means their Vitest specs load instantly and need no env. The IO wiring (validator/job/route/modal) is verified by `tsc --noEmit` + a manual smoke run, consistent with this repo's existing test posture (no integration harness).

---

## Task 1: URL parser (pure)

**Files:**
- Create: `server/src/services/affiliate-url-parser.ts`
- Test: `server/src/services/affiliate-url-parser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/affiliate-url-parser.test.ts` (note: import is **extensionless** so Vitest resolves the `.ts` directly):

```ts
import { describe, it, expect } from 'vitest';
import { parseTrustpilotAffiliateUrl, partitionBulkUrls } from './affiliate-url-parser';

describe('parseTrustpilotAffiliateUrl', () => {
  it('derives website, geo, tp_url, and a temp name from a regional URL', () => {
    const r = parseTrustpilotAffiliateUrl('https://de.trustpilot.com/review/onlinecasinoohneoasis.me');
    expect(r).toEqual({
      name: 'Onlinecasinoohneoasis',
      website: 'onlinecasinoohneoasis.me',
      tp_url: 'https://de.trustpilot.com/review/onlinecasinoohneoasis.me',
      geo: ['DE'],
      warning: false,
    });
  });

  it('handles a missing scheme and a trailing slash + query', () => {
    const r = parseTrustpilotAffiliateUrl('au.trustpilot.com/review/payid-casino.net/?foo=1');
    expect(r?.website).toBe('payid-casino.net');
    expect(r?.geo).toEqual(['AU']);
    expect(r?.tp_url).toBe('https://au.trustpilot.com/review/payid-casino.net');
    expect(r?.name).toBe('Payid casino');
  });

  it('gives bare and www hosts an empty geo', () => {
    expect(parseTrustpilotAffiliateUrl('https://trustpilot.com/review/foo.com')?.geo).toEqual([]);
    expect(parseTrustpilotAffiliateUrl('https://www.trustpilot.com/review/foo.com')?.geo).toEqual([]);
  });

  it('rejects non-trustpilot and non-review URLs', () => {
    expect(parseTrustpilotAffiliateUrl('https://example.com/review/foo.com')).toBeNull();
    expect(parseTrustpilotAffiliateUrl('https://de.trustpilot.com/categories/casino')).toBeNull();
    expect(parseTrustpilotAffiliateUrl('not a url')).toBeNull();
    expect(parseTrustpilotAffiliateUrl('   ')).toBeNull();
  });
});

describe('partitionBulkUrls', () => {
  it('splits into toInsert / skipped(dup) / invalid and dedupes within the paste', () => {
    const text = [
      'https://de.trustpilot.com/review/new-one.com',
      'https://de.trustpilot.com/review/already.com',      // exists in DB
      'https://au.trustpilot.com/review/new-one.com',      // dup of line 1 by website
      'garbage line',
      '',
    ].join('\n');
    const existing = [{ website: 'already.com', tp_url: null }];
    const out = partitionBulkUrls(text, existing);
    expect(out.toInsert.map((r) => r.website)).toEqual(['new-one.com']);
    expect(out.skipped).toEqual(['already.com', 'new-one.com']);
    expect(out.invalid).toEqual(['garbage line']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/affiliate-url-parser.test.ts`
Expected: FAIL — `Failed to resolve import "./affiliate-url-parser"` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `server/src/services/affiliate-url-parser.ts`:

```ts
// Pure parser for the bulk-add-affiliates feature. Turns pasted Trustpilot
// review URLs into affiliate rows. Dependency-free on purpose: the canonical
// tp_url is re-sanitized idempotently by url-validator at validation time, so
// this module owns only the cheap parse + dedupe and stays trivially testable.

export interface ParsedAffiliate {
  name: string;
  website: string;
  tp_url: string;
  geo: string[];
  warning: false;
}

interface ExistingAffiliate {
  website: string | null;
  tp_url: string | null;
}

export interface BulkPartition {
  toInsert: ParsedAffiliate[];
  skipped: string[]; // websites already tracked (in DB or earlier in the paste)
  invalid: string[]; // lines that are not parseable Trustpilot review URLs
}

const REVIEW_PATH = /\/review\/([^/?#]+)/i;
const HOST_IS_TRUSTPILOT = /(^|\.)trustpilot\.com$/;
const REGIONAL_SUBDOMAIN = /^([a-z]{2})\.trustpilot\.com$/;

function normalizeWebsite(raw: string): string {
  return raw.toLowerCase().replace(/^www\./, '');
}

export function parseTrustpilotAffiliateUrl(line: string): ParsedAffiliate | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let candidate = trimmed.replace(/^["'<]+|["'>]+$/g, '');
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate.replace(/^\/+/, '');

  let u: URL;
  try { u = new URL(candidate); } catch { return null; }

  const host = u.host.toLowerCase();
  if (!HOST_IS_TRUSTPILOT.test(host)) return null;

  const m = u.pathname.match(REVIEW_PATH);
  if (!m) return null;

  const slug = m[1].toLowerCase();
  const website = normalizeWebsite(slug);
  if (!website) return null;

  const tp_url = `https://${host}/review/${slug}`;

  const sub = host.match(REGIONAL_SUBDOMAIN);
  const geo = sub ? [sub[1].toUpperCase()] : [];

  const label = website.split('.')[0].replace(/[-_]+/g, ' ').trim();
  const name = label ? label.charAt(0).toUpperCase() + label.slice(1) : website;

  return { name, website, tp_url, geo, warning: false };
}

export function partitionBulkUrls(text: string, existing: ExistingAffiliate[]): BulkPartition {
  const existingSites = new Set(
    existing.map((e) => normalizeWebsite(e.website ?? '')).filter(Boolean),
  );
  const seen = new Set<string>();
  const toInsert: ParsedAffiliate[] = [];
  const skipped: string[] = [];
  const invalid: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseTrustpilotAffiliateUrl(line);
    if (!parsed) { invalid.push(line.trim()); continue; }
    if (existingSites.has(parsed.website) || seen.has(parsed.website)) {
      skipped.push(parsed.website);
      continue;
    }
    seen.add(parsed.website);
    toInsert.push(parsed);
  }

  return { toInsert, skipped, invalid };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/affiliate-url-parser.test.ts`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/affiliate-url-parser.ts server/src/services/affiliate-url-parser.test.ts
git commit -m "feat(leads): add Trustpilot URL parser for bulk affiliate add"
```

---

## Task 2: JSON-LD meta extractor (pure)

**Files:**
- Create: `server/src/services/affiliate-meta-extractor.ts`
- Test: `server/src/services/affiliate-meta-extractor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/affiliate-meta-extractor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractAffiliateMeta } from './affiliate-meta-extractor';

const PAGE = `
<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebPage","name":"ignore me"},
  {"@type":["Organization","LocalBusiness"],"name":"Casino Ohne OASIS",
   "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.3","reviewCount":"114","bestRating":5}}
]}
</script>
</head><body>live profile</body></html>`;

describe('extractAffiliateMeta', () => {
  it('pulls name, rating (number), reviews (int) from aggregateRating JSON-LD', () => {
    expect(extractAffiliateMeta(PAGE)).toEqual({ name: 'Casino Ohne OASIS', rating: 4.3, reviews: 114 });
  });

  it('returns {} when there is no JSON-LD or no aggregateRating', () => {
    expect(extractAffiliateMeta('<html><body>nothing here</body></html>')).toEqual({});
    expect(extractAffiliateMeta('<script type="application/ld+json">{"@type":"WebPage"}</script>')).toEqual({});
  });

  it('does not throw on malformed JSON-LD', () => {
    expect(extractAffiliateMeta('<script type="application/ld+json">{ not json }</script>')).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/affiliate-meta-extractor.test.ts`
Expected: FAIL — `Failed to resolve import "./affiliate-meta-extractor"`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/services/affiliate-meta-extractor.ts`:

```ts
// Pulls business name + aggregate rating from a Trustpilot profile page's
// JSON-LD. Trustpilot embeds an Organization/LocalBusiness node carrying
// `name` and an `aggregateRating` (`ratingValue` + `reviewCount`). Shapes vary
// (bare object, @graph array, top-level array), so walk recursively for the
// first node that actually has an aggregateRating. Dependency-free.

export interface AffiliateMeta {
  name?: string;
  rating?: number;
  reviews?: number;
}

const LD_BLOCK = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

export function extractAffiliateMeta(html: string): AffiliateMeta {
  if (!html) return {};
  for (const m of html.matchAll(LD_BLOCK)) {
    let parsed: unknown;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    const found = walkForRating(parsed);
    if (found) return found;
  }
  return {};
}

function walkForRating(node: unknown): AffiliateMeta | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = walkForRating(item);
      if (r) return r;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;

  const obj = node as Record<string, unknown>;
  const agg = obj.aggregateRating;
  if (agg && typeof agg === 'object') {
    const a = agg as Record<string, unknown>;
    const meta: AffiliateMeta = {};
    if (typeof obj.name === 'string' && obj.name.trim()) meta.name = obj.name.trim();
    const rating = toNum(a.ratingValue);
    if (rating != null) meta.rating = rating;
    const reviews = toInt(a.reviewCount);
    if (reviews != null) meta.reviews = reviews;
    if (meta.name || meta.rating != null || meta.reviews != null) return meta;
  }

  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = walkForRating(v);
      if (r) return r;
    }
  }
  return null;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toInt(v: unknown): number | null {
  const n = toNum(v);
  return n == null ? null : Math.round(n);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/affiliate-meta-extractor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/affiliate-meta-extractor.ts server/src/services/affiliate-meta-extractor.test.ts
git commit -m "feat(leads): extract name/rating/reviews from Trustpilot JSON-LD"
```

---

## Task 3: Thread meta extraction through the Playwright validator

**Files:**
- Modify: `server/src/services/url-validator.ts`

No unit test (Playwright IO). Verified by `tsc --noEmit` in Task 8 and the manual smoke run.

- [ ] **Step 1: Add the extractor import**

In `server/src/services/url-validator.ts`, directly below the existing import on line 8 (`import { handleCloudflareChallenge } from './scrapers/popup-handler.js';`), add:

```ts
import { extractAffiliateMeta, type AffiliateMeta } from './affiliate-meta-extractor.js';
```

- [ ] **Step 2: Export a shared result type**

Directly below `export type LinkStatus = ...` (line 10), add:

```ts
export interface UrlCheckResult {
  status: LinkStatus;
  error: string | null;
  meta?: AffiliateMeta;
}
```

- [ ] **Step 3: Update `validateTrustpilotUrlViaPlaywright` to accept the option and extract on the SB fallback**

Replace the function signature line (currently line 148-151):

```ts
export async function validateTrustpilotUrlViaPlaywright(
  context: BrowserContext,
  url: string,
): Promise<{ status: LinkStatus; error: string | null }> {
  const cleaned = sanitizeTrustpilotUrl(url);
  if (!cleaned) return { status: 'UNKNOWN', error: 'unsalvageable_url' };

  const playwrightResult = await runPlaywrightCheck(context, cleaned);
```

with:

```ts
export async function validateTrustpilotUrlViaPlaywright(
  context: BrowserContext,
  url: string,
  opts: { extractMeta?: boolean } = {},
): Promise<UrlCheckResult> {
  const cleaned = sanitizeTrustpilotUrl(url);
  if (!cleaned) return { status: 'UNKNOWN', error: 'unsalvageable_url' };

  const playwrightResult = await runPlaywrightCheck(context, cleaned, opts.extractMeta ?? false);
```

Then, inside the same function, in the ScrapingBee-fallback branch, find this block (currently lines 182-190):

```ts
    if (sb && sb.transportError === null && sb.apiStatus >= 200 && sb.apiStatus < 600) {
      const sbResult = classifyResponse(sb.upstreamStatus ?? sb.apiStatus, sb.body);
      return {
        status: sbResult.status,
        error: sbResult.error
          ? `${sbResult.error} (via scrapingbee_stealth after playwright ${playwrightResult.error ?? 'unknown'})`
          : null,
      };
    }
```

and replace it with:

```ts
    if (sb && sb.transportError === null && sb.apiStatus >= 200 && sb.apiStatus < 600) {
      const sbResult = classifyResponse(sb.upstreamStatus ?? sb.apiStatus, sb.body);
      return {
        status: sbResult.status,
        error: sbResult.error
          ? `${sbResult.error} (via scrapingbee_stealth after playwright ${playwrightResult.error ?? 'unknown'})`
          : null,
        ...(opts.extractMeta && sb.body ? { meta: extractAffiliateMeta(sb.body) } : {}),
      };
    }
```

- [ ] **Step 4: Update `runPlaywrightCheck` to capture the raw body and attach meta**

Replace the function signature (currently lines 212-215):

```ts
async function runPlaywrightCheck(
  context: BrowserContext,
  url: string,
): Promise<{ status: LinkStatus; error: string | null }> {
```

with:

```ts
async function runPlaywrightCheck(
  context: BrowserContext,
  url: string,
  extractMeta: boolean,
): Promise<UrlCheckResult> {
```

Then replace the body-capture + classify block (currently lines 271-279):

```ts
    let body: string;
    try {
      body = (await page.content()).toLowerCase();
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'UNKNOWN', error: `playwright_content_failed: ${name} ${msg.slice(0, 80)}` };
    }
    return classifyResponse(httpStatus || 200, body, { blockedHttp });
```

with (capture the original-case body for JSON-LD, lowercase only for classification):

```ts
    let rawBody: string;
    try {
      rawBody = await page.content();
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'UNKNOWN', error: `playwright_content_failed: ${name} ${msg.slice(0, 80)}` };
    }
    const result: UrlCheckResult = classifyResponse(httpStatus || 200, rawBody.toLowerCase(), { blockedHttp });
    if (extractMeta) result.meta = extractAffiliateMeta(rawBody);
    return result;
```

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors. (`validateTrustpilotUrl` is unchanged — its `{status, error}` return is still structurally assignable to `UrlCheckResult` for callers.)

- [ ] **Step 6: Commit**

```bash
git add server/src/services/url-validator.ts
git commit -m "feat(leads): optionally scrape affiliate meta during link validation"
```

---

## Task 4: Add `enrich` flag to the link-check job

**Files:**
- Modify: `server/src/services/link-check-job.ts`

- [ ] **Step 1: Import the result type**

Replace the import on line 8:

```ts
import { validateTrustpilotUrl, validateTrustpilotUrlViaPlaywright } from './url-validator.js';
```

with:

```ts
import { validateTrustpilotUrl, validateTrustpilotUrlViaPlaywright, type UrlCheckResult } from './url-validator.js';
```

- [ ] **Step 2: Add the `opts` parameter to `runLinkCheckJob`**

Replace the function signature (currently lines 58-63):

```ts
export async function runLinkCheckJob(
  jobId: string,
  source: LinkCheckSource,
  ids: string[],
  registry: LinkCheckRegistry,
): Promise<void> {
```

with:

```ts
export async function runLinkCheckJob(
  jobId: string,
  source: LinkCheckSource,
  ids: string[],
  registry: LinkCheckRegistry,
  opts: { enrich?: boolean } = {},
): Promise<void> {
```

- [ ] **Step 3: Pass `extractMeta` to the validator and write enriched fields**

Replace the per-URL validate + DB-update block (currently lines 129-159) — from `const result = context` down to the closing of the DB-update try/catch:

```ts
          const result = context
            ? await validateTrustpilotUrlViaPlaywright(context, target.url)
            : await validateTrustpilotUrl(target.url);
          status = result.status;
          error = result.error;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[link-check-job] worker ${workerIdx} threw on ${target.url}:`, msg);
          status = 'UNKNOWN';
          error = `worker_exception: ${msg.slice(0, 200)}`;
        }

        if (status === 'VALID') job.valid++;
        else if (status === 'FLAGGED_DEAD') job.flagged_dead++;
        else if (status === 'FLAGGED_REMOVED') job.flagged_removed++;
        else job.unknown++;
        job.checked++;

        try {
          await supabase
            .from(source)
            .update({
              link_status: status,
              last_validated_at: now,
              link_validation_error: error,
            })
            .eq('id', target.id);
        } catch (e) {
          // DB write failure shouldn't kill the worker either.
          console.error(`[link-check-job] DB update failed for ${target.id}:`, e);
        }
```

with:

```ts
          const result: UrlCheckResult = context
            ? await validateTrustpilotUrlViaPlaywright(context, target.url, { extractMeta: opts.enrich })
            : await validateTrustpilotUrl(target.url);
          status = result.status;
          error = result.error;
          meta = result.meta;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[link-check-job] worker ${workerIdx} threw on ${target.url}:`, msg);
          status = 'UNKNOWN';
          error = `worker_exception: ${msg.slice(0, 200)}`;
        }

        if (status === 'VALID') job.valid++;
        else if (status === 'FLAGGED_DEAD') job.flagged_dead++;
        else if (status === 'FLAGGED_REMOVED') job.flagged_removed++;
        else job.unknown++;
        job.checked++;

        const update: Record<string, unknown> = {
          link_status: status,
          last_validated_at: now,
          link_validation_error: error,
        };
        // Enrich mode (affiliates bulk-add): backfill scraped fields, but only
        // when present — never clobber an existing value with undefined.
        if (opts.enrich && meta) {
          if (meta.name) update.name = meta.name;
          if (meta.rating != null) update.rating = meta.rating;
          if (meta.reviews != null) update.reviews = meta.reviews;
        }

        try {
          await supabase.from(source).update(update).eq('id', target.id);
        } catch (e) {
          // DB write failure shouldn't kill the worker either.
          console.error(`[link-check-job] DB update failed for ${target.id}:`, e);
        }
```

- [ ] **Step 4: Declare the `meta` variable in the worker loop**

Still inside the worker `while` loop, find the two declarations (currently lines 123-124):

```ts
        let status: 'VALID' | 'FLAGGED_DEAD' | 'FLAGGED_REMOVED' | 'UNKNOWN' = 'UNKNOWN';
        let error: string | null = null;
```

and add a third line below them:

```ts
        let status: 'VALID' | 'FLAGGED_DEAD' | 'FLAGGED_REMOVED' | 'UNKNOWN' = 'UNKNOWN';
        let error: string | null = null;
        let meta: UrlCheckResult['meta'] = undefined;
```

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/link-check-job.ts
git commit -m "feat(leads): write scraped name/rating/reviews when link job runs in enrich mode"
```

---

## Task 5: `POST /api/affiliates/bulk` endpoint

**Files:**
- Modify: `server/src/routes/affiliates.ts`

- [ ] **Step 1: Import the parser**

In `server/src/routes/affiliates.ts`, below the existing import on line 4 (`import { createRegistry, newJob, runLinkCheckJob } from '../services/link-check-job.js';`), add:

```ts
import { partitionBulkUrls } from '../services/affiliate-url-parser.js';
```

- [ ] **Step 2: Add the route**

Insert this handler immediately after the existing `POST /` handler closes (after line 59, the `});` that ends `router.post('/', ...)`):

```ts
// POST /api/affiliates/bulk — paste-add: parse Trustpilot URLs, dedupe vs
// existing rows, bulk-insert, then auto-launch an enrichment link-check job
// that backfills name/rating/reviews and the link_status for the new rows.
router.post('/bulk', async (req: Request, res: Response) => {
  try {
    const { text, urls } = req.body || {};
    const raw =
      typeof text === 'string' ? text
      : Array.isArray(urls) ? urls.join('\n')
      : '';
    if (!raw.trim()) {
      res.status(400).json({ success: false, error: 'text (or urls[]) is required' });
      return;
    }

    const supabase = getSupabase();
    const { data: existingRows, error: exErr } = await supabase
      .from('affiliates')
      .select('website, tp_url');
    if (exErr) throw exErr;

    const { toInsert, skipped, invalid } = partitionBulkUrls(raw, existingRows ?? []);

    if (toInsert.length === 0) {
      res.status(200).json({ success: true, data: { created: [], skipped, invalid, jobId: null } });
      return;
    }

    const { data: created, error: insErr } = await supabase
      .from('affiliates')
      .insert(toInsert)
      .select();
    if (insErr) throw insErr;

    // Fire-and-forget enrichment: validate links + scrape name/rating/reviews.
    const jobId = randomUUID();
    linkCheckRegistry.jobs.set(jobId, newJob());
    const insertedIds = (created ?? []).map((r) => r.id);
    runLinkCheckJob(jobId, 'affiliates', insertedIds, linkCheckRegistry, { enrich: true })
      .catch((e) => console.error(`[affiliates/bulk] enrich job ${jobId} crashed`, e));

    res.status(201).json({ success: true, data: { created, skipped, invalid, jobId } });
  } catch (err) {
    if (res.headersSent) return;
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});
```

- [ ] **Step 3: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/affiliates.ts
git commit -m "feat(leads): add POST /api/affiliates/bulk for paste-add + auto-enrich"
```

---

## Task 6: Frontend hook — `bulkAddAffiliates`

**Files:**
- Modify: `frontend/src/hooks/useAffiliates.ts`

- [ ] **Step 1: Add the bulk-add result type and the hook method**

In `frontend/src/hooks/useAffiliates.ts`, add this type above the `useAffiliates` function (below the imports):

```ts
export interface BulkAddResult {
  created: Affiliate[];
  skipped: string[];
  invalid: string[];
  jobId: string | null;
}
```

Then, immediately after the existing `addAffiliate` `useCallback` (ends at line 28), add:

```ts
  const bulkAddAffiliates = useCallback(async (text: string): Promise<BulkAddResult> => {
    const res = await api.post<{ success: boolean; data: BulkAddResult }>('/affiliates/bulk', { text });
    const data = res.data.data;
    if (data.created.length) setAffiliates((prev) => [...prev, ...data.created]);
    return data;
  }, []);
```

- [ ] **Step 2: Export it from the hook**

Replace the return statement (line 42):

```ts
  return { affiliates, loading, error, fetchAffiliates, addAffiliate, bulkDelete, updateAffiliate };
```

with:

```ts
  return { affiliates, loading, error, fetchAffiliates, addAffiliate, bulkAddAffiliates, bulkDelete, updateAffiliate };
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useAffiliates.ts
git commit -m "feat(leads): useAffiliates.bulkAddAffiliates calls the bulk endpoint"
```

---

## Task 7: Frontend modal — Single/Bulk toggle + paste box

**Files:**
- Modify: `frontend/src/views/AffiliateMonitor.tsx`

- [ ] **Step 1: Extend the modal props**

In `frontend/src/views/AffiliateMonitor.tsx`, replace the `AddModalProps` interface (lines 29-32):

```ts
interface AddModalProps {
  onClose: () => void;
  onSave: (payload: Omit<Affiliate, 'id' | 'created_at'>) => Promise<unknown>;
}
```

with:

```ts
interface AddModalProps {
  onClose: () => void;
  onSave: (payload: Omit<Affiliate, 'id' | 'created_at'>) => Promise<unknown>;
  onBulkSave: (text: string) => Promise<{ created: unknown[]; skipped: string[]; invalid: string[]; jobId: string | null }>;
  existingWebsites: Set<string>;
  onBulkDone: (result: { created: number; skipped: number; invalid: number; jobId: string | null }) => void;
}
```

- [ ] **Step 2: Add bulk-mode state + a live preview to the modal component**

Replace the opening of `AddAffiliateModal` (lines 34-37):

```ts
function AddAffiliateModal({ onClose, onSave }: AddModalProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
```

with:

```ts
const TP_REVIEW_LINE = /(^|\.)trustpilot\.com\/review\/([^/?#\s]+)/i;

function previewBulk(text: string, existing: Set<string>) {
  let detected = 0, tracked = 0, invalid = 0;
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(TP_REVIEW_LINE);
    if (!m) { invalid++; continue; }
    const site = m[2].toLowerCase().replace(/^www\./, '');
    if (existing.has(site) || seen.has(site)) { tracked++; continue; }
    seen.add(site);
    detected++;
  }
  return { detected, tracked, invalid };
}

function AddAffiliateModal({ onClose, onSave, onBulkSave, existingWebsites, onBulkDone }: AddModalProps) {
  const [mode, setMode] = useState<'single' | 'bulk'>('single');
  const [bulkText, setBulkText] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const preview = previewBulk(bulkText, existingWebsites);

  const handleBulkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setSaving(true);
    try {
      const result = await onBulkSave(bulkText);
      onBulkDone({
        created: result.created.length,
        skipped: result.skipped.length,
        invalid: result.invalid.length,
        jobId: result.jobId,
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Bulk add failed');
    } finally {
      setSaving(false);
    }
  };
```

- [ ] **Step 3: Add the Single/Bulk toggle and the bulk textarea to the modal JSX**

Replace the header + form opening (lines 78-87) — from the `<div className="flex items-center justify-between mb-6">` block through the `<form onSubmit={handleSubmit} className="space-y-4">` line:

```tsx
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
            Add <span className="text-[#b0004a]">Affiliate</span>
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <span className="material-symbols-outlined text-[22px]">close</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
```

with:

```tsx
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-extrabold text-on-surface" style={{ fontFamily: 'Manrope, sans-serif' }}>
            Add <span className="text-[#b0004a]">Affiliate</span>
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors">
            <span className="material-symbols-outlined text-[22px]">close</span>
          </button>
        </div>

        {/* Single / Bulk toggle */}
        <div className="flex items-center gap-1 mb-5 bg-slate-100 rounded-lg p-1">
          {(['single', 'bulk'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setErr(null); }}
              className={`flex-1 px-3 py-1.5 rounded-md text-sm font-bold transition-colors ${
                mode === m ? 'bg-white text-[#b0004a] shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {m === 'single' ? 'Single' : 'Bulk paste'}
            </button>
          ))}
        </div>

        {mode === 'bulk' ? (
          <form onSubmit={handleBulkSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 mb-1">Trustpilot URLs (one per line)</label>
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                rows={9}
                placeholder={'https://de.trustpilot.com/review/example.com\nhttps://au.trustpilot.com/review/another.net'}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-[#b0004a] transition-colors resize-none"
              />
              <p className="text-xs text-slate-400 mt-1.5">
                <span className="font-bold text-slate-600">{preview.detected}</span> to add
                {preview.tracked > 0 && <> · <span className="font-bold text-amber-600">{preview.tracked}</span> already tracked</>}
                {preview.invalid > 0 && <> · <span className="font-bold text-red-500">{preview.invalid}</span> invalid</>}
                <br />
                <span className="text-slate-400">Name, rating &amp; reviews are filled in automatically after adding.</span>
              </p>
            </div>

            {err && <p className="text-xs text-red-500">{err}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-bold text-slate-500 hover:bg-slate-100 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || preview.detected === 0}
                className="px-5 py-2 rounded-lg text-sm font-bold bg-[#b0004a] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {saving ? 'Adding…' : `Add ${preview.detected} Affiliate${preview.detected === 1 ? '' : 's'}`}
              </button>
            </div>
          </form>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
```

- [ ] **Step 4: Close the conditional after the single-form**

The single-mode `<form>` currently ends at line 200 (`</form>`). Replace that closing tag:

```tsx
        </form>
      </div>
    </div>
  );
}
```

with (add the `)}` that closes the `mode === 'bulk' ? (...) : (` ternary):

```tsx
        </form>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire the modal in the main view**

In the `AffiliateMonitor` component, replace the destructure on line 209:

```ts
  const { affiliates, loading, error, fetchAffiliates, addAffiliate, bulkDelete, updateAffiliate } = useAffiliates();
```

with:

```ts
  const { affiliates, loading, error, fetchAffiliates, addAffiliate, bulkAddAffiliates, bulkDelete, updateAffiliate } = useAffiliates();
```

Add a bulk-summary banner state next to the other `useState` hooks (after line 217, `const [deleting, setDeleting] = useState(false);`):

```ts
  const [bulkSummary, setBulkSummary] = useState<{ created: number; skipped: number; invalid: number } | null>(null);
```

Add a memoized set of existing websites (after the `stats` useMemo, around line 258):

```ts
  const existingWebsites = useMemo(
    () => new Set(affiliates.map((a) => (a.website ?? '').toLowerCase().replace(/^www\./, '')).filter(Boolean)),
    [affiliates],
  );
```

- [ ] **Step 6: Handle bulk completion (reuse the existing enrich-job streaming)**

Replace the modal render block (lines 514-519):

```tsx
      {showAddModal && (
        <AddAffiliateModal
          onClose={() => setShowAddModal(false)}
          onSave={addAffiliate}
        />
      )}
```

with:

```tsx
      {showAddModal && (
        <AddAffiliateModal
          onClose={() => setShowAddModal(false)}
          onSave={addAffiliate}
          onBulkSave={bulkAddAffiliates}
          existingWebsites={existingWebsites}
          onBulkDone={({ created, skipped, invalid, jobId }) => {
            setBulkSummary({ created, skipped, invalid });
            // Stream the enrichment job through the existing link-job machinery
            // so name/rating/reviews + link badges populate live, then refetch.
            if (jobId) {
              localStorage.setItem('active_affiliate_link_job', jobId);
              setLinkJobId(jobId);
              setLinkStartedAt(new Date().toISOString());
            }
          }}
        />
      )}
```

- [ ] **Step 7: Render the bulk-summary banner**

Directly above the `{/* Link-check result banner */}` comment (line 448), add:

```tsx
      {/* Bulk-add summary banner */}
      {bulkSummary && (
        <div className="flex items-center gap-3 rounded-xl px-5 py-3 text-sm border bg-[#8ff9a8]/20 border-[#006630]/20 text-[#006630]">
          <span className="material-symbols-outlined text-[18px] text-[#006630]">playlist_add_check</span>
          <span className="font-semibold">Bulk add complete!</span>
          <span className="font-normal">
            Added <strong>{bulkSummary.created}</strong>
            {bulkSummary.skipped > 0 && <>, skipped <strong>{bulkSummary.skipped}</strong> already tracked</>}
            {bulkSummary.invalid > 0 && <>, <strong>{bulkSummary.invalid}</strong> invalid</>}
            . Enriching name, rating &amp; reviews now…
          </span>
          <button onClick={() => setBulkSummary(null)} className="ml-auto text-[#006630]/60 hover:text-[#006630] transition-colors">
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
      )}
```

- [ ] **Step 8: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/views/AffiliateMonitor.tsx
git commit -m "feat(leads): bulk-paste mode in Add Affiliate modal with live preview"
```

---

## Task 8: Full verification + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full server test suite**

Run: `cd server && npm test`
Expected: PASS — both `affiliate-url-parser.test.ts` and `affiliate-meta-extractor.test.ts` green, no other tests broken.

- [ ] **Step 2: Type-check both packages**

Run: `cd server && npx tsc --noEmit` then `cd ../frontend && npx tsc --noEmit`
Expected: no errors in either.

- [ ] **Step 3: Manual smoke (local — owner scrapes run locally)**

Start the API (`cd server && npm run dev`) and frontend (`cd frontend && npm run dev`). In the Affiliate Monitor, click **Add Affiliate → Bulk paste**, paste:

```
https://de.trustpilot.com/review/onlinecasinoohneoasis.me
https://de.trustpilot.com/review/onlinecasinospaysafecard.com
https://de.trustpilot.com/review/ohneoasis.de
https://de.trustpilot.com/review/wettanbieterohneoasis.me
https://de.trustpilot.com/review/muchbettercasino.net
https://de.trustpilot.com/review/bitcoincasinozone.com
https://de.trustpilot.com/review/casinoschnellauszahlung.com
```

Verify, in order:
- Preview reads `7 to add` (0 already tracked, 0 invalid).
- After **Add 7 Affiliates**: modal closes, green "Bulk add complete!" banner shows `Added 7`, and 7 rows appear immediately with `DE` geo + website set.
- The JobProgress panel streams the enrichment job; on completion the table refetches and rows show real names + star ratings + review counts (where Trustpilot exposes them), and link badges reflect VALID/REMOVED/etc.
- Re-paste the same 7 URLs → preview reads `0 to add · 7 already tracked`; submit is disabled.

- [ ] **Step 4: Final verification commit (if any doc/cleanup changes)**

```bash
git add -A
git commit -m "test(leads): verify bulk-add affiliates end-to-end" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- UI toggle + textarea + live counter → Task 7 (Steps 2-3, 7).
- Server-side parse (website/geo/tp_url/temp name) → Task 1.
- Dedupe vs DB + invalid partition → Task 1 (`partitionBulkUrls`) + Task 5 (existing-rows fetch).
- `POST /api/affiliates/bulk` returning `{created, skipped, invalid, jobId}` → Task 5.
- Enrichment reusing the link-check job (name/rating/reviews + link_status) → Tasks 2-4.
- Failure handling (invalid never inserted, enrich failure leaves UNKNOWN, never clobber with undefined) → Task 1 (invalid), Task 4 (Step 3 guards).
- No schema migration → confirmed; `affiliates` already has all target columns.
- Testing: parser + extractor unit tests (Tasks 1-2); endpoint logic covered by the pure `partitionBulkUrls` test; manual smoke (Task 8).

**Placeholder scan:** none — every code step shows complete code; every run step shows the command + expected result.

**Type consistency:** `UrlCheckResult` defined in Task 3 Step 2, imported in Task 4 Step 1, used in Task 4 Steps 3-4. `AffiliateMeta` defined in Task 2, imported into url-validator in Task 3 Step 1. `partitionBulkUrls`/`parseTrustpilotAffiliateUrl` names consistent across Tasks 1 and 5. `bulkAddAffiliates` consistent across Tasks 6 and 7. `BulkAddResult.created` is `Affiliate[]` in the hook (Task 6); the modal prop types `created` as `unknown[]` and only reads `.length`, so no coupling break.

**Note on the spec's "Affected files":** the spec placed `extractAffiliateMeta` inside `url-validator.ts` and the parser inside `routes/affiliates.ts`. This plan instead gives each pure function its own module (`affiliate-meta-extractor.ts`, `affiliate-url-parser.ts`) for isolated unit testing — same behavior, cleaner boundaries. No scope change.
