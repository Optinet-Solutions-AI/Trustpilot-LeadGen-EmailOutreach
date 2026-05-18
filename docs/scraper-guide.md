# Scraper Guide

## Overview

The scraper is a registry of platform plugins. Every plugin subclasses `BasePlatformScraper` at `tools/scraper/platforms/base.py` and registers itself in `tools/scraper/platforms/__init__.py`. The unified CLI `tools/scraper/run.py --platform <name> --action list|enrich|discover-taxonomy` is the only spawn target for non-Trustpilot scrapes. Trustpilot still uses the legacy 3-script chain (`scrape_category.py` → `scrape_profile.py` → `scrape_website.py`).

Live platforms: **Trustpilot**, **TripAdvisor**, **Yelp**. Planned: **Facebook**, **Instagram**, **FB Groups**.

---

## Generic plugin contract

Every plugin must declare:

```python
class FooScraper(BasePlatformScraper):
    name = 'foo'
    base_url = 'https://www.foo.com'
    filter_schema = [...]            # FilterField[]; the frontend renders this dynamically
    requires_proxy = False           # hint to the UI to suggest local-only mode

    async def scrape_listing(self, filters, *, max_results=None, on_progress=None) -> list[dict]:
        ...   # paginate listing pages, apply filters, return profile stubs

    async def enrich_profiles(self, profile_stubs, *, screenshots_dir='', ...) -> list[dict]:
        ...   # visit each profile, return {company_name, website_url, platform_email, phone, screenshot_path, ...}

    async def discover_taxonomy(self) -> dict:   # optional
        return {'categories': [...], 'countries': [...]}
```

**Stub shape:** every stub from `scrape_listing` MUST include `{'name', 'profile_url', 'rating'}` — extra platform-specific fields (slug, fusion_id, location_id) pass through to `enrich_profiles` unchanged.

**Enriched shape:** what `enrich_profiles` returns is upserted via `tools/db/upsert_leads.py`. For non-Trustpilot platforms the dict must include `platform`, `profile_url`, `company_name`, optionally `rating`, `website_url`, `phone`, `website_email`, `screenshot_path`, `country`, `category`.

**Progress protocol:** plugins emit line-protocol on stdout that `server/src/services/scrape-runner.ts` parses into SSE events:
- `PROGRESS:listing_page:<n>/<total>`
- `PROGRESS:profile_done:<n>/<total>`
- `FAILED:listing|<query>|<reason>`
- `FAILED:profile|<url>|<reason>`

**Adding a new platform — 6-step recipe:**
1. Subclass `BasePlatformScraper` in `tools/scraper/platforms/<name>.py`.
2. Register `'<name>': <Name>Scraper` in `tools/scraper/platforms/__init__.py`.
3. Add a manifest entry in `PLATFORM_MANIFESTS` in `server/src/routes/scrape.ts`.
4. Extend the non-Trustpilot branch of `/api/scrape/taxonomy/refresh` to spawn `run.py --platform <name> --action discover-taxonomy`.
5. Add platform-specific env vars to `.env.example` + Cloud Run service env.
6. Add fixture-based parser tests in `tests/scraper/test_<name>_parser.py`. Never hit live URLs from CI.

---

## Common helpers

All under `tools/scraper/`:

| File | What it provides |
|---|---|
| `browser_utils.py` | `launch_browser()` (stealth + UA rotation), `safe_goto()` (exponential backoff on 429/403), `dismiss_popups()` |
| `tls_fetch.py` | `curl_cffi` Chrome/Safari TLS fingerprint fallback for Cloudflare-protected sites |
| `shared/scrapingbee.py` | `fetch_via_scrapingbee()` and `fetch_screenshot_via_scrapingbee()` with tier escalation (`premium_proxy` → `stealth_proxy`) |
| `shared/yelp_fusion.py` | Yelp Fusion API client (free, 5000/day) |
| `scrape_website.py` | Platform-agnostic website-email enrichment (post-step after every plugin) |

---

## Per-platform appendices

### Trustpilot (live — legacy 3-script chain)

**Pages JS-rendered;** Playwright + playwright-stealth required. Direct access works from residential IPs with 2-5s randomized delays.

| Script | Output | Notes |
|---|---|---|
| `scrape_category.py` | `[jobId]_raw.json` | Paginates `https://www.trustpilot.com/categories/{category}?country={cc}&page={n}`; filters by min/max star_rating |
| `scrape_profile.py` | `[jobId]_enriched.json` | Visits `/review/<slug>`; extracts website_url, trustpilot_email, phone |
| `scrape_website.py` | overwrites enriched JSON | Platform-agnostic step |
| `upsert_leads.py` | Supabase | Keys on `leads.trustpilot_url` (legacy upsert path) |

**Constraints:**
- 2-5s `human_delay()` between requests
- Max 50 pages per category (`--max-pages`)
- Some category slugs need verification: hitting `https://www.trustpilot.com/categories/{slug}` should not 404

**Category slug examples** (verified):
- Gambling: `gambling`, `casino`, `online_casino_or_bookmaker`, `online_sports_betting`, `bookmaker`
- Gaming: `gaming`, `gaming_service_provider`, `bingo_hall`
- Finance: `money_and_insurance`, `bank`, `investment_service`, `cryptocurrency_exchange`

---

### TripAdvisor (live — plugin)

**Plugin:** `tools/scraper/platforms/tripadvisor.py`. **No direct Playwright path** — Cloudflare 403s residential IPs. ScrapingBee `stealth_proxy` only.

| Concern | Detail |
|---|---|
| Listing fetch | `fetch_via_scrapingbee(url, render_js=True, stealth_proxy=True)` against city-fanned-out listing pages (Hotels, Restaurants, Attractions) |
| Profile parsing | Primary path: JSON-LD `schema.org/LocalBusiness`. Fallback: DOM selectors (marked `# TODO(tripadvisor)` — drift over time) |
| Seed | `tripadvisor_cities` table (migration 036) populated by `tools/scraper/seed_tripadvisor_cities.py` — hybrid 2-pass walk per country |
| Filter schema | `country`, `location` (mapped to seed cities), `listing_type` (`hotels`/`restaurants`/`attractions`), `max_rating`, `min_rating` |
| Required env | `SCRAPINGBEE_API_KEY` |

**Seed coverage:** hand-pick if a country's seed yields <10 cities; the seeder walks ~1-2 levels deep.

---

### Yelp (live — plugin)

**Plugin:** `tools/scraper/platforms/yelp.py`. **Direct Playwright is 403** (PerimeterX). ScrapingBee `stealth_proxy` end-to-end:

| Stage | Method | Cost |
|---|---|---|
| Listing | `https://www.yelp.com/search?find_desc=<cat>&find_loc=<city>&start=<offset>` via ScrapingBee `stealth_proxy` | 75 credits/page |
| Profile enrichment | `https://www.yelp.com/biz/<slug>` via ScrapingBee `stealth_proxy` (premium_proxy is rejected) | 75 credits/page |
| Taxonomy | Curated seed at `tools/scraper/data/yelp_categories.json` | Free (JSON load) |
| Screenshot | Bundled with the ScrapingBee profile fetch | Free with proxy fetch |

**Filter schema:** `country`, `category`, `max_rating`, `min_rating`, `min_review_count`, optional `max_pages`. Country fan-out from `tools/scraper/data/yelp_country_cities.json` (US, CA, UK, IE, AU, NZ).

**Listing card parsing:** card boundary is the nearest `<li>` or `[role="listitem"]` ancestor — critical to prevent cross-card rating leakage. Within the boundary: name from the `/biz/<slug>` anchor (excluding "N reviews" links), rating from `aria-label="X.X star rating"`, review count from regex `\b(\d+)\s+reviews?\b`.

**Profile parsing gotcha:** Yelp wraps the business website link in a redirect (`/biz_redir?url=...`). Unwrap and URL-decode the `url=` parameter.

**Required env:** `SCRAPINGBEE_API_KEY` only. Fusion API is NOT used — the free tier proved too restrictive in practice and the operator chose predictable ScrapingBee cost over Fusion quota anxiety. See the 2026-05-18 addendum in `docs/superpowers/specs/2026-05-15-yelp-platform-design.md`.

**Cost model:** 6-city × 5-page fan-out = 30 listing fetches (~2,250 cr) + ~30-60 post-filter profile fetches (~2,250-4,500 cr) ≈ **3,500-6,000 credits per scrape**. Bound listing spend by lowering `max_pages` or trimming the country's city seed.

---

### Facebook / Instagram / Groups (planned)

**Design spec:** [`docs/superpowers/specs/2026-05-18-social-platforms-design.md`](superpowers/specs/2026-05-18-social-platforms-design.md). Key contract additions:

- Subclass `SocialPlatformScraper(BasePlatformScraper)` at `tools/scraper/platforms/_social_base.py` (ABC; no platform implementation yet).
- New methods: `search_posts(query, filters)`, `search_groups(query, filters)`, `enrich_authors(post_stubs)`.
- **Login required:** per-account encrypted cookies in `social_accounts` table (planned migration 037).
- **Anti-bot stack:** undetected-chromium + residential proxy + per-account daily cap + captcha checkpoint handling.
- Lead model captures **post authors** (DM target) and **group admins**, not just page owners.

---

## Rate Limits, Costs, and Failure Modes

| Platform | Rate-limit signal | Mitigation |
|---|---|---|
| Trustpilot | 429 / 403 on rapid requests | 2-5s `human_delay()`; ramp down `MAX_CONCURRENT` |
| TripAdvisor | Cloudflare 403 from residential IPs | `SCRAPINGBEE_API_KEY` is mandatory; never try direct |
| Yelp | PerimeterX 403; ScrapingBee 500 on `premium_proxy` | Only `stealth_proxy`; Fusion handles listing free |
| Facebook (planned) | Account checkpoint | Mark `social_accounts.status='checkpoint'`; operator resolves via in-app recovery UI |

**Email verification chain** (post-scrape, platform-agnostic):
- Tier 1: ZeroBounce (100/mo free)
- Tier 2: MillionVerifier (1000/mo free, fires on ZB `unknown`)
- Tier 3: Hunter (50/mo free, last resort)

---

## Playwright setup

```bash
python -m pip install -r requirements.txt
python -m playwright install chromium
```

Headless in prod (`PLAYWRIGHT_HEADLESS=true`). For local debugging, set `PLAYWRIGHT_HEADLESS=false` and watch the browser.
