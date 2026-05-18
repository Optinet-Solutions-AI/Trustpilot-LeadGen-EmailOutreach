# Workflow: Scrape Yelp

**Objective:** Scrape Yelp listings for low-rated businesses, enrich with website/phone, upsert via the multi-platform path.

Yelp's anti-bot stack (PerimeterX) rejects direct Playwright. Listing AND profile both route through **ScrapingBee `stealth_proxy`** (75 credits/page each). The Yelp Fusion API is NOT used — its free tier proved too restrictive in practice and the operator preferred predictable ScrapingBee cost over Fusion quota anxiety.

---

## Inputs

| Filter | Required | Notes |
|---|---|---|
| `country` | yes | One of `US`, `CA`, `UK`, `IE`, `AU`, `NZ`. Drives city fan-out via `yelp_country_cities.json`. |
| `category` | yes | Slug from the curated category seed (`yelp_categories.json`) — e.g. `plumbers`, `restaurants`, `auto-repair`. The slug is passed verbatim as `find_desc=` on the search URL. |
| `max_rating` | no | Default 3.5 |
| `min_rating` | no | Default 1.0 |
| `min_review_count` | no | Default 5 — filters out businesses with too few reviews to act on |
| `max_pages` | no | Default 5 pages per city — overrides credit budget |

---

## Tools

| Step | Tool |
|---|---|
| Listing | `tools/scraper/platforms/yelp.py` → `scrape_listing()` walks `/search?find_desc=…&find_loc=…&start=N` via ScrapingBee |
| Profile enrichment | `tools/scraper/platforms/yelp.py` → `enrich_profiles()` fetches `/biz/<slug>` via ScrapingBee |
| Card parser | `_extract_search_cards()` honors `<li>` / `[role="listitem"]` card boundaries to avoid cross-card rating leakage |
| Profile parser | `_extract_profile_detail()` unwraps `/biz_redir?url=…` for the business website |
| City seed | `tools/scraper/data/yelp_country_cities.json` |
| Category seed | `tools/scraper/data/yelp_categories.json` |
| Upsert | `tools/db/upsert_leads.py` → `_upsert_nontrustpilot_lead` (writes `lead_platform_presences(platform='yelp')`) |

---

## Network strategy

**Single tier — `stealth_proxy=True` everywhere.** Yelp's edge rejects both direct Playwright (403) and ScrapingBee `premium_proxy` (500). The plugin hardcodes `premium_proxy=False, stealth_proxy=True` for every fetch and never escalates.

| Call | URL pattern | Credits |
|---|---|---|
| Listing page | `https://www.yelp.com/search?find_desc=<category>&find_loc=<city>&start=<offset>` | 75 |
| Profile page | `https://www.yelp.com/biz/<slug>` | 75 |
| Screenshot | bundled with profile fetch | free |

**Cost model:** a 6-city × 5-page fan-out = 30 listing fetches (~2,250 credits) + ~30-60 post-filter profile fetches (~2,250-4,500 credits) = **3,500-6,000 credits per scrape**. Bound listing spend by lowering `max_pages` or trimming the country's city seed.

---

## Parsing the `/search` page

| Field | Source |
|---|---|
| `name` | text of the `/biz/<slug>` anchor that isn't a "N reviews" link or a bare digit |
| `profile_url` | `https://www.yelp.com/biz/<slug>` (query params + fragment stripped) |
| `rating` | `aria-label="X.X star rating"` within the card boundary |
| `review_count` | first `\b(\d+)\s+reviews?\b` match in the card text |

Card boundary = nearest `<li>` (or `[role="listitem"]`) ancestor. **Critical** — without it, ancestor walks pick up an adjacent card's rating and assign it to a rating-less business.

## Parsing the `/biz/<slug>` page

| Field | Parsing notes |
|---|---|
| `website_url` | "Business website" link wraps `/biz_redir?url=<URL-encoded target>&...`. Unwrap + URL-decode the `url=` param. Many businesses don't link a website — emit `website_url=None`. |
| `phone` | `<a href="tel:...">` is profile-authoritative |
| `profile_claimed` | "Claim this business" CTA → False (highest-converting cold-outreach target); "Claimed" badge or "Verified License" → True |

---

## Expected output

Per lead:
```python
{
  'platform': 'yelp',
  'profile_url': 'https://www.yelp.com/biz/<slug>',
  'company_name': '...',
  'rating': 2.5,
  'review_count': 47,
  'website_url': '<unwrapped or None>',
  'phone': '<from profile or None>',
  'profile_claimed': False,
  'website_email': '<from scrape_website.py if website_url present>',
  'screenshot_path': '<Supabase Storage URL>',
  'country': 'US',
  'category': 'plumbers',
}
```

---

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `FAILED:listing|yelp|missing_key|SCRAPINGBEE_API_KEY` | Env var not set | `gcloud run services update trustpilot-crm --update-env-vars SCRAPINGBEE_API_KEY=...` or set in local `.env` |
| `FAILED:listing|<url>|empty_html` | ScrapingBee returned nothing (could be 403, 500, or timeout) | Confirm `stealth_proxy=True` (it is — never use `premium_proxy`); if persistent, ScrapingBee's stealth pool is degraded — escalate to support |
| Zero matched listings | Either every result was over the rating cap OR the parser drifted | Re-run with a wider `max_rating`; if still zero, check the live `/search` HTML against the parser selectors |
| `FAILED:profile|<url>|empty_html` | ScrapingBee returned nothing for the profile | Retry once; if persistent, the slug may be dead |

---

## Env vars

| Variable | Required | Notes |
|---|---|---|
| `SCRAPINGBEE_API_KEY` | Yes | Same key used for TripAdvisor; powers both listing and profile for Yelp |

`YELP_API_KEY` is **no longer used** — removed when listing pivoted from Fusion to `/search` via ScrapingBee.

---

## Adding markets and categories

- **New country:** add a `"XX": ["City, Region", ...]` entry to `tools/scraper/data/yelp_country_cities.json`. Format mirrors what Yelp's `find_loc=` param accepts. JSON edit only — no code change.
- **New category:** add `{"slug": "...", "display_name": "..."}` to `tools/scraper/data/yelp_categories.json`. Slugs are passed verbatim as `find_desc=` on the search URL; Yelp accepts category aliases AND human-readable keywords there. Run taxonomy refresh to land it in `platform_categories`.
