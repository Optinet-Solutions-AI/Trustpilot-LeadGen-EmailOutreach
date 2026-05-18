# Workflow: Scrape a Review Platform (Generic)

**Objective:** Scrape a target review platform (Trustpilot, Yelp, TripAdvisor, …) for businesses matching a rating / category / location filter, enrich them with contact info, and upsert to Supabase.

This is the generic SOP. Per-platform notes live in `scrape_trustpilot.md`, `scrape_tripadvisor.md`, and `scrape_yelp.md`.

---

## Inputs

| Input | Required | Notes |
|---|---|---|
| `platform` | yes | One of `trustpilot`, `tripadvisor`, `yelp`. Must be registered in `tools/scraper/platforms/__init__.py`. |
| `filters` | yes | Object — shape comes from the platform's `filter_schema`. Frontend renders this dynamically via `<DynamicFilterFields>`. |
| `max_results` | no | Soft cap; the plugin's `scrape_listing` stops paginating after this many stubs. |

Common filter keys (per-platform schema is authoritative):
- `country` (ISO 2-letter)
- `category` (platform-specific slug)
- `location` (TripAdvisor: city name → mapped to seed `geo_id`)
- `min_rating` / `max_rating` (float 1.0–5.0)
- `min_review_count` (Yelp only)

---

## Tools to call

```
                              POST /api/scrape
                                     ↓
                            scrape_jobs (Supabase)
                                     ↓
              scrape-runner.ts spawns tools/scraper/run.py
                                     ↓
                ┌────────────────────┴───────────────────┐
                │ --action list                          │
                │ → platforms/<name>.py.scrape_listing() │
                │ → emit PROGRESS:listing_page:n/total   │
                │ → write profile stubs to .tmp          │
                └────────────────────┬───────────────────┘
                                     ↓
                ┌────────────────────┴────────────────────┐
                │ --action enrich                         │
                │ → platforms/<name>.py.enrich_profiles() │
                │ → emit PROGRESS:profile_done:n/total    │
                │ → enriched rows → upsert_leads.py       │
                └─────────────────────────────────────────┘
                                     ↓
                       lead_platform_presences row
                       + leads row (insert or update)
                                     ↓
                    POST /api/verify (multi-tier)
                                     ↓
                  scrape_website.py for empty emails
```

---

## Expected output

For each enriched lead, the plugin produces a dict accepted by `_upsert_nontrustpilot_lead`:

```python
{
  'platform': 'yelp',                # or 'tripadvisor', etc.
  'profile_url': '<canonical URL>',
  'company_name': '...',
  'rating': 2.5,
  'website_url': '<URL or None>',
  'phone': '<phone or None>',
  'platform_email': '<email or None>',
  'website_email': '<from scrape_website.py>',
  'screenshot_path': '<Supabase Storage URL>',
  'country': '<from filters>',
  'category': '<from filters>',
}
```

Trustpilot still uses the legacy path that keys on `leads.trustpilot_url`.

---

## Error handling

All failures emitted as line-protocol `FAILED:<stage>|<key>|<reason>` are captured by `scrape-runner.ts` into `scrape_failures(scrape_job_id, platform, url, reason)`. The Inbox-style failure UI lets operators retry.

Common per-platform failure causes (see per-platform workflow files for fixes):
- 403 from anti-bot edge (Cloudflare / PerimeterX)
- Missing API key (Yelp Fusion, ScrapingBee)
- Parser drift (DOM selectors out of date)
- Listing page over hard quota (Yelp Fusion 240/query, ScrapingBee tier limits)

---

## When to use this vs a per-platform workflow

Use this generic SOP for: orchestration questions, how to add a new platform, schema integration, error-handling protocol.

Use the per-platform workflows for: URL patterns, parsing pitfalls, network strategy, env vars, cost model.
