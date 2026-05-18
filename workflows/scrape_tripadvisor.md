# Workflow: Scrape TripAdvisor

**Objective:** Scrape TripAdvisor listings (Hotels, Restaurants, Attractions) for low-rated businesses, enrich with website/phone, upsert via the multi-platform path.

---

## Inputs

| Filter | Required | Notes |
|---|---|---|
| `country` | yes | ISO 2-letter; used to look up cities from `tripadvisor_cities` table |
| `location` | yes | City name from the seed (e.g. `New York`, `London`). One location per scrape. |
| `listing_type` | yes | `hotels` / `restaurants` / `attractions` |
| `max_rating` | no | Default 3.5 |
| `min_rating` | no | Default 1.0 |

The frontend resolves `country` → list of seeded cities for the dropdown; operator picks one.

---

## Tools

| Step | Tool |
|---|---|
| Listing | `tools/scraper/platforms/tripadvisor.py` → `scrape_listing()` |
| Enrichment | `tools/scraper/platforms/tripadvisor.py` → `enrich_profiles()` |
| Seed cities | `tools/scraper/seed_tripadvisor_cities.py` (hybrid 2-pass walk per country) |
| Upsert | `tools/db/upsert_leads.py` → `_upsert_nontrustpilot_lead` (writes `lead_platform_presences(platform='tripadvisor')`) |

---

## Network strategy

**Direct Playwright is dead** — Cloudflare 403s residential IPs. **Always** use ScrapingBee with `stealth_proxy=True`:

```python
from shared.scrapingbee import fetch_via_scrapingbee
html = fetch_via_scrapingbee(url, render_js=True, stealth_proxy=True)
```

`SCRAPINGBEE_API_KEY` is mandatory.

---

## Parsing

**Primary path: JSON-LD** (`<script type="application/ld+json">` containing `@type: LocalBusiness` / `@type: Hotel` / etc.). Schema.org is stable across redesigns.

**Fallback path: DOM selectors.** Marked `# TODO(tripadvisor):` in `tripadvisor.py`. These drift over time. If a smoke run produces parser failures, the fix is usually to update the fallback selectors or hand off entirely to JSON-LD.

---

## City seed coverage

`tools/scraper/seed_tripadvisor_cities.py` walks each country's geo tree in two passes:
1. Country root → top-level regions
2. Region pages → top-N cities each

Coverage is intentionally shallow (~1-2 levels deep) to keep seed cost down. If a country shows <10 cities in `tripadvisor_cities`, either:
- Re-run the seeder with a deeper pass count, or
- Hand-add cities directly to the table (small one-off SQL insert).

The seeder is idempotent — re-running won't duplicate rows.

---

## Expected output

Per lead:
```python
{
  'platform': 'tripadvisor',
  'profile_url': 'https://www.tripadvisor.com/Hotel_Review-g60763-d23-Reviews-...',
  'company_name': '...',
  'rating': 2.5,
  'review_count': 1234,
  'website_url': '<from JSON-LD .url>',
  'phone': '<from JSON-LD .telephone>',
  'screenshot_path': '<Supabase Storage URL>',
  'country': 'US',
  'category': 'hotels',
}
```

---

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `FAILED:listing|<url>|scrapingbee_403` | Cloudflare upgraded edge rules | Switch tier (already stealth_proxy); contact ScrapingBee support |
| `FAILED:profile|<url>|parser_no_jsonld` | TripAdvisor changed page template | Patch the fallback DOM selectors in `tripadvisor.py` |
| Zero listings for a country | Seed too thin | Hand-add cities to `tripadvisor_cities` |
| `FAILED:listing|<url>|scrapingbee_500` | Tier rejected | Confirm `stealth_proxy=True`; never use `premium_proxy` |

---

## Env vars

| Variable | Required |
|---|---|
| `SCRAPINGBEE_API_KEY` | Yes |

No TripAdvisor-specific key. The Fusion API does not exist for TripAdvisor.
