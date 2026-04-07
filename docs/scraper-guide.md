# Scraper Guide

## Overview

Three Python scrapers run sequentially per job, each outputting JSON consumed by the next:

```
scrape_category.py → [jobId]_raw.json
scrape_profile.py  → [jobId]_enriched.json
scrape_website.py  → [jobId]_enriched.json (overwrites with enriched data)
upsert_leads.py    → Supabase leads table
```

All scrapers use Playwright (async, Chromium, headless in prod). `playwright-stealth` patches browser fingerprints. Delays of 2-5s between requests avoid Trustpilot rate limits.

---

## scrape_category.py

**What it does:** Paginates Trustpilot category pages, extracts company cards, filters by star rating.

**Usage:**
```bash
python tools/scraper/scrape_category.py \
  --country DE \
  --category casino \
  --min-rating 1.0 \
  --max-rating 3.5 \
  --output .tmp/jobId_raw.json
```

**Output format:**
```json
[
  {
    "name": "Casino XYZ",
    "slug": "casino-xyz",
    "rating": 2.3,
    "trustpilot_url": "https://www.trustpilot.com/review/casino-xyz.com"
  }
]
```

**Trustpilot category URL pattern:**
`https://www.trustpilot.com/categories/{category}?country={country}&page={n}`

---

## scrape_profile.py

**What it does:** Visits each `/review/<slug>` page, extracts company website URL, email, and phone.

**Usage:**
```bash
python tools/scraper/scrape_profile.py \
  --input .tmp/jobId_raw.json \
  --output .tmp/jobId_enriched.json \
  --screenshots-dir .tmp/screenshots
```

**Adds to each lead:**
```json
{
  "website_url": "https://casino-xyz.com",
  "trustpilot_email": "contact@casino-xyz.com",
  "phone": "+49 30 12345678",
  "country": "DE",
  "category": "casino"
}
```

---

## scrape_website.py

**What it does:** Visits each company's website to find the best contact email. Skips leads that already have any email (trustpilot_email, website_email, primary_email).

**Usage:**
```bash
python tools/scraper/scrape_website.py \
  --input .tmp/jobId_enriched.json \
  --output .tmp/jobId_enriched.json \
  --parallel 3
```

**Email ranking (best → worst for cold outreach):**

| Rank | Prefix examples | Label |
|------|----------------|-------|
| 0 (best) | contact@, sales@, hello@, partnerships@, marketing@ | TOP |
| 1 | info@, enquiries@, office@, admin@, support@ | ACCEPTABLE |
| 2 | anything else (personal/specific) | SPECIFIC (actually best) |

**Pages scanned per site:**
`/` → `/contact` → `/contact-us` → `/about` → `/about-us` → `/impressum` → `/kontakt` → `/contacto`

**Skip logic:** Leads with `primary_email`, `trustpilot_email`, or `website_email` already set are skipped entirely.

**Sets:**
```json
{
  "website_email": "sales@casino-xyz.com",
  "primary_email": "sales@casino-xyz.com"
}
```

---

## upsert_leads.py

**What it does:** Takes the final enriched JSON and upserts all leads to Supabase using `trustpilot_url` as the unique key.

**Usage:**
```bash
python tools/db/upsert_leads.py --input .tmp/jobId_enriched.json
```

Uses PostgREST's `Prefer: resolution=merge-duplicates` to update existing leads instead of failing on duplicates.

---

## Category Slugs (Verified)

These are real Trustpilot slugs usable in the category dropdown:

**Gambling / Casino:**
`gambling`, `casino`, `online_casino_or_bookmaker`, `online_sports_betting`, `betting_agency`, `bookmaker`, `gambling_service`, `gambling_house`, `off_track_betting_shop`, `lottery_vendor`, `online_lottery_ticket_vendor`, `lottery_retailer`, `lottery_shop`, `gambling_instructor`

**Gaming:**
`gaming`, `gaming_service_provider`, `bingo_hall`, `video_game_store`, `game_store`

**Finance:**
`money_and_insurance`, `bank`, `investment_service`, `cryptocurrency_exchange`, `loans`, `insurance_agency`

**To verify a slug is real:**
`https://www.trustpilot.com/categories/{slug}` — if it 404s, the slug is wrong.

---

## Rate Limits & Known Issues

- Trustpilot blocks aggressive scrapers — always use 2-5s randomized delays (`human_delay()`)
- Maximum 50 pages per category (configurable via `--max-pages`)
- Germany casino: ~39 results is correct due to GlüStV 2021 licensing law limiting legal operators
- Use `gambling` (parent) instead of `casino` (sub) for broader German results
- Playwright must install browser binaries: `python -m playwright install chromium`
