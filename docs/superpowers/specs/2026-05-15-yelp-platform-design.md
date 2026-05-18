# Yelp Platform Plugin — Design Spec

**Date:** 2026-05-15 (original) · **Amended:** 2026-05-18 (pivot to ScrapingBee, then REVERTED)
**Status:** SHIPPED — see implementation in `tools/scraper/platforms/yelp.py`
**Goal:** Add Yelp as a third scrape platform alongside Trustpilot and TripAdvisor, targeting low-rated businesses for reputation-management cold email outreach. Same end-to-end pipeline as the existing platforms (scrape → enrich → upsert → campaign).

---

> ## 🔁 2026-05-18 ADDENDUM SUPERSEDED — back to Fusion for listing
>
> An earlier addendum (~14:00 UTC) declared "Fusion dropped, ScrapingBee
> end-to-end". That pivot was based on the assumption that ScrapingBee
> `stealth_proxy` could reach `/search` as well as `/biz/<slug>` — an
> assumption that was never verified. A local smoke test at 15:20 UTC
> showed every `/search` request times out at 90 seconds (5 out of 5
> attempts against BR/plumbers failed identically). The pivot was wrong.
>
> **The implementation is back to the original hybrid design below.**
> Listing → Fusion (free). Profile enrichment → ScrapingBee stealth_proxy.
>
> Cost burned during the pivot ≈ 2,000 ScrapingBee credits across two
> cancelled EC2 jobs and one local smoke test. Lesson recorded at
> `feedback_smoke_test_before_ship.md`: never push a plugin change
> without a live smoke run first; fixture-only tests can't catch
> "can the proxy actually reach the URL" assumptions.
>
> ## Original 2026-05-18 ADDENDUM (now reverted, kept for context):
>
> The shipped implementation **does not use the Yelp Fusion API**. Listing
> now fetches `https://www.yelp.com/search?find_desc=…&find_loc=…&start=N`
> directly via ScrapingBee `stealth_proxy` (75 credits/page), same path
> as profile enrichment.
>
> **Why the pivot:**
> - Fusion's free tier (5,000/day) was unworkable in practice once the
>   operator looked at paid tier pricing.
> - "Since we're already paying for ScrapingBee, use it for everything"
>   eliminates the second API dependency and the YELP_API_KEY env var.
> - Yelp's `/search` URL exposes more useful filters than Fusion
>   (price tier, hours-open, distance) for future feature work.
>
> **What changed vs the original design below:**
> - `tools/scraper/shared/yelp_fusion.py` — DELETED.
> - `YELP_API_KEY` env var — REMOVED everywhere.
> - `scrape_listing` — fetches `/search` pages instead of calling Fusion.
> - `discover_taxonomy` — reads `tools/scraper/data/yelp_categories.json`
>   (curated SMB verticals seed) instead of `GET /v3/categories`.
> - **Card boundary parsing** added — `_extract_search_cards` honors
>   `<li>` / `[role="listitem"]` ancestors so an adjacent card's rating
>   never leaks onto a rating-less business.
>
> **Cost trade-off:** listing now costs ~2,250 cr per scrape (was free
> via Fusion). Total scrape ~3,500–6,000 cr vs ~2,250–4,500 cr before.
> Operator accepted the higher cost for predictable spend and one fewer
> moving part. Bound by lowering `filters.max_pages` (default 5) or
> trimming a country's city seed.
>
> **What still applies from the design below:** the empirical probe
> table (`stealth_proxy` is the only ScrapingBee tier that works on
> Yelp), the BasePlatformScraper plug-in shape, the `_upsert_nontrustpilot_lead`
> path, the city seed structure, the profile-page parsing rules
> (biz_redir unwrap, tel: phone, claim flag).
>
> The original Fusion-based design is preserved below as historical
> context for the empirical findings and the cost trade-offs that
> motivated revisiting it.

---

---

## Empirical findings that shaped this design

Three probes were run from a local Windows residential IP before writing this spec. They invalidate the obvious "mirror TripAdvisor" approach, so the findings drive several of the choices below.

| Endpoint | Method | Result |
|---|---|---|
| `yelp.com/` | Stealth Playwright | **403** (PerimeterX edge block) |
| `yelp.com/austin` (SEO city) | Stealth Playwright | 200 — works but no rating filter |
| `yelp.com/c/<city>/<cat>` | Stealth Playwright | 404 — URL doesn't exist |
| `yelp.com/search?find_desc=…` | Stealth Playwright | **403** |
| `yelp.com/biz/<slug>` | Stealth Playwright | **403** |
| `yelp.com/biz/<slug>` | ScrapingBee `premium_proxy` | ScrapingBee returns 500 (refused, not charged) |
| `yelp.com/biz/<slug>` | ScrapingBee `stealth_proxy` | **200, 1.8 MB HTML, all DOM markers present** |

**Implications:**
1. Direct Playwright is non-viable on the two endpoints we need (listing + profile).
2. Only ScrapingBee's `stealth_proxy` tier (75 credits/page) gets through Yelp profile pages.
3. The naive "fan-out scrape via ScrapingBee" plan costs ~$3-10/scrape, which the operator rejected as too expensive.
4. The cost problem is solved by sourcing the **listing data from Yelp's free Fusion API** and only paying ScrapingBee credits for profile-page enrichment on leads that already passed the rating filter.

---

## Architecture summary

A new `YelpScraper(BasePlatformScraper)` plugin at `tools/scraper/platforms/yelp.py`, registered in `platforms/__init__.py` and mirrored into `PLATFORM_MANIFESTS` in `server/src/routes/scrape.ts`. Leads route through the existing `_upsert_nontrustpilot_lead` path that already serves TripAdvisor — same `lead_platform_presences` (platform='yelp', profile_url) keying. **No DB migrations.** No frontend code changes (the existing `<DynamicFilterFields>` renders from the manifest).

```
                    Yelp Fusion API           ScrapingBee stealth_proxy
                    (5000/day, free)          (75 credits/page, paid)
                          │                            │
operator clicks ────►  scrape_listing  ────►   enrich_profiles  ────►  scrape_website.py
"Scrape Yelp:           name+rating+         website_url +              email discovery
country=US,             phone+address        screenshot                 (existing tool)
category=plumbers,      (filter here:                                          │
max_rating=3.5"         min/max rating,                                        ▼
                        review count)                              upsert_leads.py
                                                                   (existing path
                                                                    for non-tp platforms)
```

---

## Filter schema (drives the existing dynamic form)

```js
[
  { name: 'country',          type: 'select',  label: 'Country',           required: true,  options_source: 'taxonomy:countries' },
  { name: 'category',         type: 'select',  label: 'Category',          required: true,  options_source: 'taxonomy:categories' },
  { name: 'max_rating',       type: 'number',  label: 'Max rating',        required: false, default: 3.5, min: 1.0, max: 5.0, step: 0.5 },
  { name: 'min_rating',       type: 'number',  label: 'Min rating',        required: false, default: 1.0, min: 1.0, max: 5.0, step: 0.5 },
  { name: 'min_review_count', type: 'number',  label: 'Min review count',  required: false, default: 5,   min: 1,   max: 1000, step: 1 },
]
```

`requires_proxy: true` on the manifest — Yelp is unreachable from EC2 anyway, but this also drives the frontend's "this platform may need local mode" hint that's already wired up.

---

## Pipeline

### `scrape_listing(filters)` — Fusion API + city fan-out

1. Resolve `country` → seeded list of major cities for that country. New seed file `tools/scraper/data/yelp_country_cities.json` covering Yelp's strongest markets (US, CA, UK, IE, AU, NZ — Yelp has limited coverage outside English-speaking markets). Initial seed: ~6-10 cities per country.
2. Resolve `category` → Fusion category alias (e.g. `plumbers`, `restaurants`, `auto-repair`). Looked up from `taxonomy_categories` where `platform='yelp'`.
3. For each (city, category) pair, call `GET https://api.yelp.com/v3/businesses/search` with:
   - `location=<city>`
   - `categories=<slug>`
   - `limit=50` (Fusion max per call)
   - `offset` paginated up to Fusion's 240-result hard cap per query
4. For each returned business, apply in-process filters: `min_rating <= rating <= max_rating` AND `review_count >= min_review_count`.
5. Emit profile stubs:
   ```python
   {
     'name': business['name'],
     'profile_url': business['url'].split('?')[0],   # strip yelp's utm params
     'rating': business['rating'],
     'review_count': business['review_count'],
     'phone': business.get('phone'),                  # Fusion gives this for free
     'address': ', '.join(business['location']['display_address']),
     'fusion_id': business['id'],
   }
   ```
6. Emit `PROGRESS:listing_page:<n>/<total>` lines for the existing SSE bridge.

**Cost:** zero ScrapingBee credits at this stage. Fusion is free up to 5000 calls/day; a 6-city × 5-page fan-out = 30 Fusion calls.

### `enrich_profiles(stubs)` — ScrapingBee stealth on /biz/ pages

For each post-filter stub:
1. Fetch `https://www.yelp.com/biz/<slug>` via `fetch_via_scrapingbee(url, stealth_proxy=True, render_js=True)` (the existing helper).
2. Parse with BeautifulSoup:
   - **Website URL:** the "Business website" link on the page is a Yelp redirect: `https://www.yelp.com/biz_redir?url=<URL-encoded target>&...`. Unwrap the `url=` parameter, URL-decode, return the target. Many businesses have no website link — emit `website_url=None` and proceed.
   - **Phone:** prefer the value from the profile page over Fusion's (more authoritative); fall back to Fusion's phone if missing.
   - **Claimed flag:** detect "Claim this business" CTA — un-claimed listings often have stale info but are the highest-converting cold-outreach targets.
3. Take a screenshot via `fetch_screenshot_via_scrapingbee(url, stealth_proxy=True)` and upload to Supabase Storage (same flow as TripAdvisor).
4. If `website_url` is present, hand it to the existing `scrape_website.py` for `website_email` discovery.
5. Emit enriched dicts in `_upsert_nontrustpilot_lead` shape:
   ```python
   {
     'platform': 'yelp',
     'profile_url': stub['profile_url'],
     'company_name': stub['name'],
     'rating': stub['rating'],
     'website_url': unwrapped_url,
     'phone': profile_phone or stub.get('phone'),
     'website_email': '<from scrape_website.py>',
     'screenshot_path': '<storage URL>',
     'country': filters['country'],
     'category': filters['category'],
   }
   ```
6. Emit `PROGRESS:profile_done:<n>/<total>` for each enrichment.

**Cost:** 75 credits × N filtered leads. Screenshot is free (added to whatever proxy tier we paid for). Typical scrape post-filter: 30-60 leads → ~2,250-4,500 credits.

### `discover_taxonomy()` — Fusion `/categories` crawl

Call `GET https://api.yelp.com/v3/categories` → returns the full Yelp category tree with aliases, titles, parent_aliases, country-availability list. Filter to categories available in at least one of the seeded countries. Upsert to `taxonomy_categories` with `platform='yelp'`. One Fusion call, free.

The existing `taxonomy-discovery.ts` route at `server/src/routes/scrape.ts:99` currently 501s for non-Trustpilot platforms — we extend it to spawn `run.py --platform yelp --action discover-taxonomy`.

---

## Data flow into existing schema

For each enriched business, emit a dict shaped exactly like the TripAdvisor pipeline expects:

```python
{
  'platform': 'yelp',
  'profile_url': 'https://www.yelp.com/biz/<slug>',
  'company_name': '<name>',
  'rating': 2.5,
  'website_url': '<unwrapped URL or None>',
  'phone': '<phone>',
  'website_email': '<from scrape_website.py>',
  'screenshot_path': '<storage URL>',
  'country': '<from filters>',
  'category': '<from filters>',
}
```

`upsert_leads.py` routes this through `_upsert_nontrustpilot_lead` (already wired for TripAdvisor); `lead_platform_presences` gets the `(platform='yelp', profile_url)` row. **No schema migration needed.** The `leads` table gets the dedup'd business; the presence row carries platform-specific fields (rating, screenshot, scraped_at).

---

## Network strategy

**No Playwright path at all.** Direct Playwright is empirically dead (probe data above). The plugin uses HTTP-only via ScrapingBee — same pattern as TripAdvisor. This simplifies the implementation (no browser lifecycle, no popup dismissal, no stealth_async patching).

**Single tier: stealth_proxy.** Probe data shows `premium_proxy` doesn't work (ScrapingBee 500s the request before charging). The plugin hardcodes `stealth_proxy=True` for every fetch. No tier fallback.

**Failure mode when SCRAPINGBEE_API_KEY is unset:** `enrich_profiles` returns the input stubs unchanged (with phone + rating from Fusion but no website/screenshot/email). Operator sees `PROGRESS:profile_done:0` and can configure the key. Mirrors the TripAdvisor no-op behavior.

**Failure mode when YELP_API_KEY is unset:** `scrape_listing` returns empty and emits `FAILED:listing|<filter>|missing YELP_API_KEY`. Operator sees zero leads and fixes the env var.

---

## Error handling & progress

Same line-protocol used by Trustpilot and TripAdvisor — picked up unchanged by the existing `scrape-runner.ts` SSE bridge:

- `PROGRESS:listing_page:<n>/<total>` per Fusion call
- `PROGRESS:profile_done:<n>/<total>` per profile enrichment
- `FAILED:listing|<query>|<reason>` for Fusion 4xx/5xx
- `FAILED:profile|<url>|<reason>` for ScrapingBee 4xx/5xx or empty HTML

Failures route to `scrape_failures` via the existing pipeline — operator can resolve them in the Inbox-style retry view that already exists.

---

## Env vars

| Variable | Purpose | New? |
|---|---|---|
| `YELP_API_KEY` | Fusion API auth header. Operator registers at https://docs.developer.yelp.com/ for a free key (5000 req/day, no card required). | **New** |
| `SCRAPINGBEE_API_KEY` | Already used by TripAdvisor — reused here for profile pages. | Existing |

Both env vars must be added to `.env`, `.env.example`, and Cloud Run service env (`gcloud run services update trustpilot-crm ... --update-env-vars`). The Cloud Run gateway is irrelevant since Yelp scrapes run locally only.

---

## City seed list (initial)

New file `tools/scraper/data/yelp_country_cities.json`, format mirrors `tripadvisor_country_geo.json`. Initial seed below — 3-8 cities per country, sized to keep a single scrape under 30 Fusion calls (3 pages × seed count):

```json
{
  "US": ["New York, NY", "Los Angeles, CA", "Chicago, IL", "Houston, TX", "Phoenix, AZ", "Philadelphia, PA", "San Diego, CA", "Dallas, TX"],
  "CA": ["Toronto, ON", "Vancouver, BC", "Montreal, QC", "Calgary, AB", "Ottawa, ON"],
  "UK": ["London", "Manchester", "Birmingham", "Glasgow", "Edinburgh"],
  "IE": ["Dublin", "Cork", "Galway"],
  "AU": ["Sydney", "Melbourne", "Brisbane", "Perth"],
  "NZ": ["Auckland", "Wellington", "Christchurch"]
}
```

Yelp coverage outside these markets is thin — DE/FR/JP have listings but very few low-rated businesses to outreach. Excluded from v1. Adding a market later is a JSON edit, no code change.

---

## Testing

- **Unit (parser):** HTML fixtures from the probe data — captured profile page (1.8 MB) gets shipped to `tests/scraper/fixtures/yelp_profile_sample.html`, plus a recorded Fusion API response JSON. Parser tests run against fixtures, no network calls.
- **Live smoke:** one end-to-end run for `country=US, category=plumbers, max_rating=3.0, min_review_count=5` from the local machine before merging. Confirms Fusion-call → filter → ScrapingBee profile fetch → screenshot upload → presence-table write.
- **No CI live scrape.** Yelp blocks GitHub Actions IPs; the Fusion API path would work in CI but the profile-enrichment path won't. Smoke runs locally only.

---

## Out of scope for v1

- **Yelp Fusion's "transactions" endpoint** (delivery/pickup) — not relevant for cold-outreach reputation services.
- **Review-text scraping** — cold outreach uses rating + screenshot, not review content. Could add later if AI personalization wants individual review quotes.
- **Multi-language listings** — Yelp DE/FR markets aren't seeded; revisit if expansion happens.
- **Yelp Ads (Sponsored) filtering** — we keep sponsored results in the funnel; they still convert.
- **Real-time review-count updates** — re-running a scrape will refresh stats. No webhook integration with Yelp.
- **Operator-supplied location override** — the country fan-out is the only geo UX. A free-text "Location" field would be a fast follow-up if the seeded cities prove insufficient.

---

## Risks

1. **Fusion API daily quota** — 5000 calls/day is plenty for our usage (a 6-city fan-out = 30 calls per scrape, ~160 scrapes/day possible). No risk unless we ship to many users.
2. **PerimeterX detection upgrade** — if Yelp tightens further, even `stealth_proxy` could break. Mitigation: ScrapingBee maintains the stealth pool; if it breaks, we'd see widespread failures and ScrapingBee would respond. Fallback to Scrapfly is a possible future addition (env var already exists).
3. **Yelp ToS** — Fusion API is officially sanctioned; using it for business contact discovery is within their terms. The `/biz/<slug>` scrape via ScrapingBee is in a gray area but mirrors what we already do for Trustpilot. No different risk profile from existing platforms.
4. **Website-link absence** — many small businesses don't link a website on Yelp. The lead is still upserted with phone + rating, but the email pipeline won't activate. Acceptable — we surface phone in the CRM and the operator can phone-outreach those, or skip them.

---

## Implementation order (preview for the plan)

1. Add `YELP_API_KEY` to `.env.example` + config.
2. New `tools/scraper/shared/yelp_fusion.py` helper for Fusion API calls.
3. New `tools/scraper/data/yelp_country_cities.json` seed.
4. New `tools/scraper/platforms/yelp.py` plugin implementing `BasePlatformScraper`.
5. Register Yelp in `tools/scraper/platforms/__init__.py`.
6. Add Yelp manifest entry in `server/src/routes/scrape.ts` `PLATFORM_MANIFESTS`.
7. Extend `taxonomy-discovery.ts` to spawn the Yelp discovery path.
8. Fixture-based parser tests + one local smoke run.
9. Deploy backend (env var update + code).

Detailed step-by-step work goes in the implementation plan.
