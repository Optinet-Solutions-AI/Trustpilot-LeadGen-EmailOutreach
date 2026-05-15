# TripAdvisor Country/Category Fan-Out — Design

**Date:** 2026-05-15
**Status:** Draft — pending user review
**Author:** Claude (collaborative w/ John)

---

## Problem

TripAdvisor scraping today demands two internal identifiers from the user:
`geo_id` (e.g. `60745`) and `location_slug` (e.g. `Boston_Massachusetts`).
Both are TripAdvisor URL plumbing — no normal user knows them, so the form
shipped on the Scrape page is effectively unusable.

Trustpilot, by contrast, asks only for **Country + Category + rating range**
and figures out the rest server-side. The goal: TripAdvisor should feel
identical.

## Constraint TripAdvisor imposes

TripAdvisor URLs are **geo-bound, not country-bound**. There is no
`Hotels-USA.html`. To enumerate "all US hotels rated 1★–3★", the system
must iterate every US city TripAdvisor lists and scrape each city's
listing pages.

That fan-out is the core implementation challenge.

## Locked-in decisions (from brainstorm)

- **Country coverage:** all countries (full ~80, matching Trustpilot taxonomy).
- **Categories:** the 3 TA top-level types — Hotels, Restaurants, Attractions.
  No subcategories in v1.
- **City coverage:** every city TripAdvisor lists per country (no top-N cap).
  The user accepted the resulting per-scrape ScrapingBee cost.
- **City source:** Hardcoded Supabase table `tripadvisor_cities`, seeded by a
  one-time discovery scrape. Editable in the SQL editor; no per-scrape lookup
  to TA.
- **Frontend:** Identical pattern to Trustpilot's branch — `CountryPicker` +
  Category dropdown + rating slider. No `geo_id` / `slug` fields visible.

---

## Architecture

```
Scrape form
  ├── CountryPicker (reused)              country: "US"
  ├── Category dropdown                   category: "hotels" | "restaurants" | "attractions"
  └── Rating slider                       1.0 .. 3.5
         │
         ▼  POST /api/scrape  { platform: "tripadvisor", country, category, min_rating, max_rating, … }
         │
   ┌─────┴────────────────────────┐
   │ scrape-runner.ts             │
   │  • look up tripadvisor_cities│   ← Supabase query
   │    WHERE country_code = $1   │
   │      AND active = true       │
   │    ORDER BY rank             │
   │  • for each city:            │
   │     spawn run.py --platform  │
   │       tripadvisor --action   │
   │       list with city's       │
   │       geo_id + slug          │
   │  • merge + dedup by          │
   │    profile_url               │
   └─────┬────────────────────────┘
         │
         ▼  same enrich + upsert + verify pipeline as today
```

---

## Components

### 1. Schema — `tripadvisor_cities` (new table)

```sql
create table tripadvisor_cities (
  geo_id        text primary key,           -- "60745"
  country_code  text not null,              -- "US" (matches leads.country)
  name          text not null,              -- "Boston"
  slug          text not null,              -- "Boston_Massachusetts"
  rank          int  not null default 0,    -- order within country
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on tripadvisor_cities (country_code, active, rank);
```

Migration: `supabase/migrations/036_tripadvisor_cities.sql`.

### 2. Country geo-ID map (static)

A checked-in JSON in `tools/scraper/data/tripadvisor_country_geo.json`:
```json
{ "US": "191", "GB": "186216", "FR": "187070", "DE": "187275", ... }
```
~80 rows. Used by the seed scraper to know which TA country page to walk.
Source: one-time manual compilation from TripAdvisor's country browse URLs.
Stable values — TripAdvisor has not renumbered country geo IDs since at
least 2018.

### 3. Seed scraper — `tools/scraper/seed_tripadvisor_cities.py`

New offline tool, **not** wired into the per-scrape pipeline. Run manually
once per country (or in a loop across all countries) when seeding or
refreshing the city list.

Strategy:
1. For each country in the geo-ID map, fetch
   `https://www.tripadvisor.com/Tourism-g{geo}-{slug}-Vacations.html`
   via ScrapingBee.
2. Parse the page's "Popular destinations" panel **and** any deeper
   "All destinations in {country}" alphabetical list to extract every
   linked city's `g{id}` + slug + display name.
3. For very large countries (US, GB, France, Italy), TA also exposes
   per-state/per-region alphabetical browse pages — the scraper walks one
   level deeper there to collect every city, not just the popular ones.
   (The exact deeper-page URL pattern is confirmed during seed
   implementation by inspecting one country's hierarchy. If the
   hierarchy turns out to be too brittle, the seeder falls back to
   "Popular destinations + alphabetical-A-to-Z list" only, and the spec
   ships covering whatever cities TA exposes through those two surfaces.)
4. UPSERT into `tripadvisor_cities`, preserving any rows already marked
   `active=false` (manual overrides win).

Cost: ~1–3 SB credits per country page × ~80 countries + an additional
~3–10 region-page credits for the big countries. Estimated total one-time
seed cost: ~300–500 SB credits. The seed step is not on the user's
hot path; they run it once and forget.

CLI:
```
python -m tools.scraper.seed_tripadvisor_cities --country US
python -m tools.scraper.seed_tripadvisor_cities --all
```

### 4. API contract change

`TripAdvisorScrapeParams` (in `frontend/src/types/scrape.ts`) drops
`location_id`, `location_slug`, and `listing_type`. Picks up `country` and
renames `listing_type` to `category` for visual parity with Trustpilot.

```ts
type TripAdvisorScrapeParams = {
  platform: 'tripadvisor';
  country: string;                                          // "US"
  category: 'hotels' | 'restaurants' | 'attractions';
  min_rating: number;
  max_rating: number;
  enrich: boolean;
  verify: boolean;
  forceRescrape?: boolean;
};
```

`POST /api/scrape` accepts the new shape and persists `country` +
`category` into `scrape_jobs.filters` (jsonb).

### 5. Backend fan-out — `scrape-runner.ts`

`runScrapeJobViaRunPy` is extended (for TA only) to:

1. Read `country` + `category` from the job's filters.
2. Query `tripadvisor_cities` for active rows in that country, ordered by
   `rank`.
3. Loop city-by-city (concurrency `=2`, matching the existing
   `parallel_tabs` budget). For each city, the orchestrator translates
   the API-level `category` (`hotels`/`restaurants`/`attractions`) into
   the per-city `listing_type` filter that `run.py` already expects —
   no change required to the TA plugin or `run.py` itself.
   - Spawn `python -m tools.scraper.run --platform tripadvisor
     --action list --filters '{"location_id":…,"location_slug":…,
     "listing_type":…,"min_rating":…,"max_rating":…}'`
   - Append results to an in-memory accumulator, dedup by `profile_url`.
   - Emit a `PROGRESS:city_done:{geo_id}|{name}|{count}` event for the UI.
4. Once all cities finish, write the merged list to the job's
   `*_raw.json` and continue with the existing enrich → upsert → verify
   pipeline unchanged.

Pause/cancel support: each city spawn is a normal child process — the
existing PID tracking and `cancelScrapeJob` path kills the in-flight city
worker; the loop checks the job's status row between cities and aborts
early if it's been cancelled.

### 6. Frontend — `ScrapeForm.tsx`

The TripAdvisor branch becomes:

```
Platform: [ TripAdvisor v ]   ⚠ Run from local mode (unchanged)

Country     [ CountryPicker ]              (reused)
Category    [ Hotels v ]                   (Combobox; 3 fixed options)

Bubble rating  1★ — 3★
[ 1 ] to [ 3 ]                              (RangeInput, unchanged)

⚠ Estimated ~{N} cities × ~3 pages = ~{N*45} SB credits
  Profile enrichment will add ~{leads*5} more credits.

[ Start scrape ]
```

City count + credit estimate come from a new endpoint
`GET /api/tripadvisor/cities?country=US` which returns the count (cheap
SELECT). The form fetches the count whenever country changes and renders
a small advisory line above the Start button. Non-blocking — the user can
still click Start.

### 7. Cost transparency / confirmation gate

If estimated credits exceed a configurable threshold (default 5,000),
clicking Start shows a confirmation dialog:

> This scrape will fan out across {N} cities and may consume up to
> ~{credits} ScrapingBee credits before profile enrichment.
> Continue?

Threshold lives in `frontend/src/config/cost-gate.ts`. Anything below
the threshold submits silently.

### 8. Progress UI — `ActiveScrapeCard.tsx`

Add a "Cities" counter alongside the existing "Companies found" /
"Profiles processed" stats. Driven by the new
`PROGRESS:city_done:{geo_id}|{name}|{count}` events. Format:
`12 / 50 cities` while running; collapses to a single "Cities" line on
completion.

The existing `Find companies → Remove duplicates → Scrape profiles →
Save profiles → Enrich websites → Finalize` stage chip rail gains a new
chip between **Find companies** and **Remove duplicates**: **Scan cities**.

---

## Data flow — concrete example

User picks `Country=US`, `Category=Hotels`, `min=1`, `max=3`.

1. Frontend GETs `/api/tripadvisor/cities?country=US` → `{count: 487}`.
2. Frontend shows "≈487 cities × ~3 pages = ~22,000 SB credits" advisory.
3. User confirms the gate dialog, clicks Start.
4. POST `/api/scrape` with the new TA shape → `scrape_jobs` row created.
5. `scrape-runner.ts` queries `tripadvisor_cities WHERE country_code='US'`
   → 487 rows.
6. Loop, 2 cities at a time. For each, spawn `run.py --action list`.
7. Each city emits its own `category_progress` events (per-page) plus a
   final `city_done`. ActiveScrapeCard renders both.
8. After all 487 cities → merged dedup list → enrich → upsert → verify.

---

## Failure modes

| Failure | Behavior |
|---|---|
| `tripadvisor_cities` is empty for the chosen country | API returns `400 { error: "No seeded cities for country US — run seed_tripadvisor_cities.py first" }`. The form surfaces it as a red banner. |
| One city returns 0 cards (ScrapingBee challenge, empty page) | Logged to `scrape_failures` with `geo_id`. Loop continues to the next city — one bad city doesn't kill the scrape. |
| ScrapingBee key missing | Existing behavior — every city's run.py prints `FAILED:listing|missing_key` and returns []. Job completes with `total_found=0`. Job-level failure message is added so the user sees why. |
| Cancel mid-scrape | The currently-running city's child process is killed; the outer loop sees `status='cancelled'` between iterations and exits early without starting new cities. |
| Country geo ID not in `tripadvisor_country_geo.json` (seed-time only) | `seed_tripadvisor_cities.py --all` logs `WARN: skipping country XX, no geo ID` and continues. |

---

## Known coverage limitation (v1)

The seed scraper walks each country's Tourism page plus one level of
recursion into the linked "Popular destinations". This catches the most
common cities (~80 for the US — NYC, LA, Chicago, Vegas, SF, Boston, etc.
and their satellites) but **misses small-market cities** that don't
appear on TA's Popular panel.

For the US specifically: TA's geographic hierarchy is `Country → State →
City`, but the country Tourism page links directly to popular cities and
skips the State level. To reach every city in every state would require
either (a) a hardcoded geo-ID map of US states, French régions, etc.
(~200 entries across the major-market countries) feeding a state-aware
recursion, or (b) an entirely different scrape architecture (e.g.
per-state Hotels pagination).

**v1 ships with the Popular-destination set.** The operator can extend
coverage manually by inserting rows into `tripadvisor_cities` via the
Supabase SQL editor — the scrape-runner reads every active row, so newly
added cities take effect on the next scrape with no code change.

Phase 2 work item: implement state-aware seeding for the top ~10 markets.

---

## What is **not** in scope (v1)

- **Subcategories** (Italian Restaurants, Casinos, Spas, etc.) — TA exposes
  these as separate filtered URLs; supporting them would multiply the
  per-scrape cost. Defer until users explicitly need finer-grained targeting.
- **Per-city concurrency tuning UI** — concurrency stays hardcoded at 2.
  Adjustable later if ScrapingBee rate limits force it.
- **Auto-refresh of `tripadvisor_cities`** — operator re-runs the seed
  scraper manually when they want fresher data. No background job.
- **Region-level filtering** (e.g. "California only") — country is the
  finest geographic granularity in v1. The data model supports it (cities
  have a `country_code`), but no UI surface for region-scope until needed.

---

## File touchpoints

| Path | Change |
|---|---|
| `supabase/migrations/036_tripadvisor_cities.sql` | NEW — table + index |
| `tools/scraper/data/tripadvisor_country_geo.json` | NEW — static map |
| `tools/scraper/seed_tripadvisor_cities.py` | NEW — one-time seeder |
| `tools/scraper/platforms/tripadvisor.py` | No change (filter shape stays per-city). |
| `tools/scraper/run.py` | No change. |
| `server/src/services/scrape-runner.ts` | Add city-fan-out loop for TA. |
| `server/src/routes/scrape.ts` | Accept new TA params; reject if no seeded cities. |
| `server/src/routes/tripadvisor.ts` | NEW — `GET /api/tripadvisor/cities?country=US`. |
| `server/src/db/tripadvisor-cities.ts` | NEW — DB helper. |
| `frontend/src/types/scrape.ts` | Update `TripAdvisorScrapeParams`. |
| `frontend/src/components/ScrapeForm.tsx` | Collapse TA branch: country + category + rating. |
| `frontend/src/components/ActiveScrapeCard.tsx` | "Cities" counter + new stage chip. |
| `frontend/src/api/client.ts` (or wherever) | Helper for the `/api/tripadvisor/cities` GET. |
| `frontend/src/config/cost-gate.ts` | NEW — credit threshold config. |

---

## Open questions (none blocking)

- Should the **Recent Jobs** table on the Scrape page show a TA job's
  filters as `US — hotels` (matches Trustpilot's `US — casino` style) or
  `US — hotels (487 cities)`? Going with the former for v1 to keep the
  row width consistent; the city count is a runtime detail.
