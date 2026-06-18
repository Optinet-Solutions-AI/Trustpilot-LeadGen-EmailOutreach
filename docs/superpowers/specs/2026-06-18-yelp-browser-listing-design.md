# Yelp Browser-Based Listing + Country Expansion — Design

**Date:** 2026-06-18
**Status:** Approved (pending spec review)
**Platform:** Yelp (`tools/scraper/platforms/yelp.py`)

## Problem

Yelp's Fusion API moved from "free 5,000 calls/day" to a paid model, and the
project's key now returns `400 TRIAL_EXPIRED` on every call. This kills Yelp
**listing** entirely — for all 13 currently-seeded countries, not just new
ones. ScrapingBee cannot reach Yelp `/search` (PerimeterX, documented 100%
timeout), so there is currently no working Yelp listing path.

Separately discovered (2026-06-18): a **headed undetected-chromedriver session
from the owner's residential IP loads Yelp `/search` pages fine** — verified
35 real businesses on a San Francisco query, and a multi-country probe showed
full results for 11 additional countries. This is the same technique that beat
Cloudflare on TripAdvisor.

## Goals

1. Restore Yelp listing with a **free headed-browser scraper** that loads
   `yelp.com/search` directly, replacing the dead Fusion listing call.
2. Expand Yelp from 13 → ~24 countries (only the 11 with **verified** coverage).
3. Keep the change minimal and the existing fan-out / filter / enrichment flow
   intact.

## Non-Goals

- Replacing ScrapingBee `/biz` profile enrichment (it works; keep it).
- Removing the Fusion code path (keep it as a toggle for a future paid plan).
- Running Yelp listing on Cloud Run / EC2 (browser path is residential-only).
- Bulk-cleaning or re-seeding the existing 13 countries' city lists.

## Verified Coverage (probe, 2026-06-18)

**Add (full first-page results):** AT, NL, CH, SE, DK, PL, PT, SG, TR, CZ, NO
**Skip (0 results):** AE (Dubai), GR (Athens)

Only each country's **primary** city was probed. Secondary cities are
best-effort; thinly-covered ones simply yield few/no leads (harmless).

## Architecture

The existing `scrape_listing` already: loads cities for the country from
`yelp_country_cities.json` → fans out per city → paged search → in-process
filter (rating range + `min_review_count`) → builds result dicts →
`enrich_profiles` (ScrapingBee `/biz`). **Keep all of it.** Swap only the
per-city search call.

### Listing source toggle
- New env var `YELP_LISTING_SOURCE` ∈ {`browser`, `fusion`}, default `browser`.
- `scrape_listing` dispatches: `browser` → new `_search_city_browser(...)`;
  `fusion` → existing `search_businesses_paged(...)`. Both return the **same
  list-of-business-dicts shape**, so downstream filter/enrich code is unchanged.
- Fusion code stays; `yelp_fusion_enabled()` no longer gates the whole method —
  it only gates the `fusion` branch.

### Browser search path
- Reuse `tools/scraper/shared/local_browser.py` `LocalBrowserFetcher`, opened
  once per scrape (one session across all cities — clearance persists).
- URL: `https://www.yelp.com/search?find_desc=<category>&find_loc=<city>&start=<offset>`,
  paginated by `start += 10` (`_RESULTS_PER_PAGE = 10`), capped by the existing
  page/result limits.
- Fetcher tuning for Yelp (params, not new code):
  - **Readiness marker:** Yelp-appropriate (e.g. presence of multiple `/biz/`
    links / a results container token) instead of TripAdvisor's `BreadcrumbList`.
  - **Block detection:** hard-block phrase **`"Access to this page has been
    denied"` ONLY**. Do NOT treat `perimeterx`/`captcha`/`px-captcha` as blocks —
    Yelp embeds that SDK on every successful page (confirmed false-positive).

### Search-card parser — `_parse_yelp_search_cards(html) -> list[dict]`
Per result card, extract:
- `name` (required; skip card if missing)
- `profile_url` from the `/biz/<slug>` anchor (+ `slug`)
- `rating` (from the star-rating element / aria-label)
- `review_count`
- `phone`, `address`/neighborhood if present
Filter noise anchors ("Order", "Menu", single-char slugs). Return the shape the
Fusion path produced (so `fusion_id` becomes optional / `None`; keyed instead by
`profile_url` slug). Fixture-based unit test against saved real search HTML.

## Pacing, Blocking, and the Residential-Only Constraint

- **Pacing:** conservative slow jittered (reuse `min_pace`/`max_pace`),
  defaults tuned more cautiously than TripAdvisor since PerimeterX is more
  aggressive. Jittered inter-city gap.
- **Block handling:** on the hard-block phrase, raise `BrowserBlocked` → the
  scrape aborts cleanly and reports cities completed (resumable). Never hammer a
  blocked IP.
- **Residential-only:** the browser path requires a real display + residential
  IP, so it **cannot run on Cloud Run / EC2**. With Fusion dead, Yelp scraping is
  **owner-local-only** (run via `localhost` / local CLI), consistent with the
  existing "owner scrapes run locally" rule. Documented in CLAUDE.md.
- **Volume note:** aggressive city counts raise scrape-time volume, ScrapingBee
  enrichment credits, and PerimeterX exposure. The city JSON is only fan-out
  data; actual volume is user-controlled per scrape. Per-city result caps + the
  existing rating/review filters bound enrichment spend.

## Country/City Expansion

Add the 11 verified countries to `yelp_country_cities.json` at ~8–10 major
cities each (SG = 1, city-state). Then run
`python -m tools.scraper.run --platform yelp --action discover-taxonomy` to
mirror them into `platform_countries` (the dropdown source). Existing 13 left
as-is.

## Testing

1. **Unit:** `tests/scraper/test_yelp_search_parser.py` — fixture-based, asserts
   card extraction (name/slug/rating/review_count) on saved real search HTML;
   asserts noise links are dropped.
2. **Live smoke:** scrape 1–2 new countries (1 city, 1 page) via the browser
   path; confirm real businesses returned, filter applies, no hard-block. Then a
   single `/biz` enrichment via ScrapingBee to confirm the unchanged enrich path
   still joins correctly.

## Files Touched

- `tools/scraper/platforms/yelp.py` — listing-source dispatch, `_search_city_browser`, `_parse_yelp_search_cards`
- `tools/scraper/shared/local_browser.py` — Yelp-tunable readiness/block markers (params)
- `tools/scraper/data/yelp_country_cities.json` — +11 countries
- `tests/scraper/test_yelp_search_parser.py` — new
- `CLAUDE.md` — Yelp section: Fusion paid/expired, browser listing path, owner-local-only
- `.env.example` — document `YELP_LISTING_SOURCE`

## Risks

- **PerimeterX flags the IP under volume** → conservative pacing + hard-block
  abort + resume; recommend per-country runs, not one giant blast.
- **Yelp DOM drift** breaks the card parser → fixture test + the parser is
  isolated and easy to re-point; selectors documented.
- **Secondary cities sparse** → harmless empty results.
- **Fusion never restored** → Yelp stays owner-local-only; acceptable
  (TripAdvisor covers the server/scheduled path).
