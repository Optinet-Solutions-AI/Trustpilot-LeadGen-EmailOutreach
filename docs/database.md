# Database Schema

Supabase (PostgreSQL). Run all migrations in `supabase/migrations/` in numeric order to set up.

The schema is in a **transitional state**: a legacy `leads` table (Trustpilot-shaped) coexists with a multi-platform `lead_platform_presences` table introduced by migration 032. Trustpilot still keys on `leads.trustpilot_url`; every other platform keys on `lead_platform_presences(platform, profile_url)`. Phase 2+ work will cut Trustpilot over and drop the legacy column.

---

## Table: `leads`

Lead identity. One row per business.

```sql
id                  uuid PRIMARY KEY DEFAULT gen_random_uuid()
company_name        text NOT NULL
trustpilot_url      text UNIQUE                -- LEGACY — only Trustpilot writes this (migration 033 made it nullable)
website_url         text
trustpilot_email    text                       -- LEGACY — Trustpilot only; non-Trustpilot platforms write to lead_platform_presences.platform_email
website_email       text                       -- email found on company website (platform-agnostic, from scrape_website.py)
primary_email       text                       -- resolved: website_email > platform_email
phone               text
country             text                       -- ISO 2-letter: "DE", "GB", "US"
category            text                       -- platform-specific slug (Trustpilot: "casino"; Yelp: "plumbers"; etc.)
star_rating         real                       -- DENORMALIZED for Trustpilot; canonical per-platform rating in lead_platform_presences.rating
screenshot_path     text                       -- DENORMALIZED; canonical screenshot in lead_platform_presences.screenshot_path
email_verified      boolean DEFAULT false
verification_status text                       -- valid | invalid | catch-all | unknown
outreach_status     text DEFAULT 'new'         -- new | contacted | replied | converted | lost
lead_source         text DEFAULT 'trustpilot_scrape'
scraped_at          timestamptz
contacted_at        timestamptz
created_at          timestamptz DEFAULT now()
updated_at          timestamptz                -- auto-updated by trigger
```

**Important:** `primary_email` is the field used for campaign sending.

**Outreach status enum (never change):**
`new` → `contacted` → `replied` → `converted` | `lost`

---

## Table: `lead_platform_presences` (migration 032)

**The canonical multi-platform identity table.** One row per `(lead_id, platform)` pair. Powers Yelp, TripAdvisor, and all future platforms. Trustpilot leads also get a row here on new scrapes (the legacy `leads.trustpilot_url` column is kept in lockstep until the Phase 2+ cutover).

```sql
id                  uuid PRIMARY KEY DEFAULT gen_random_uuid()
lead_id             uuid FK → leads.id
platform            text NOT NULL              -- 'trustpilot' | 'tripadvisor' | 'yelp' | future: 'facebook' | 'instagram'
profile_url         text NOT NULL              -- canonical platform profile URL
rating              real                       -- per-platform rating
review_count        int                        -- per-platform review count (Yelp uses this)
platform_email      text                       -- email scraped from the platform profile
screenshot_path     text                       -- public Supabase Storage URL
profile_claimed     boolean                    -- platform-specific (Yelp has this)
scraped_at          timestamptz DEFAULT now()
UNIQUE (platform, profile_url)
```

The `_upsert_nontrustpilot_lead` path in `tools/db/upsert_leads.py` writes here.

---

## Table: `campaigns`

One row per email campaign.

```sql
id                  uuid PRIMARY KEY
name                text NOT NULL
template_subject    text NOT NULL
template_body       text NOT NULL          -- HTML with {{tokens}}
status              text DEFAULT 'draft'   -- draft | sent | completed
total_sent          int DEFAULT 0
total_opened        int DEFAULT 0
total_replied       int DEFAULT 0
total_bounced       int DEFAULT 0
sent_at             timestamptz
created_at          timestamptz DEFAULT now()
```

---

## Table: `campaign_leads`

Junction table. One row per lead assigned to a campaign.

```sql
campaign_id         uuid FK → campaigns.id
lead_id             uuid FK → leads.id
PRIMARY KEY (campaign_id, lead_id)         -- prevents duplicates

email_used          text                   -- snapshot of email at send time
status              text DEFAULT 'pending' -- pending | sent | opened | replied | bounced
sent_at             timestamptz
opened_at           timestamptz
replied_at          timestamptz
bounced_at          timestamptz
```

**Campaign lead status enum (never change):**
`pending` → `sent` → `opened` → `replied` | `bounced`

---

## Table: `lead_notes`

Activity timeline. Auto-created on status changes, email sends, etc.

```sql
id                  uuid PRIMARY KEY
lead_id             uuid FK → leads.id
type                text                   -- note | status_change | email_sent | verification | follow_up
content             text
metadata            jsonb                  -- flexible: { old_status, new_status, campaign_id, ... }
created_at          timestamptz DEFAULT now()
```

---

## Table: `scrape_jobs`

Tracks every scrape run. Multi-platform: `platform` + `filters` (jsonb) is the canonical envelope; legacy `country` / `category` / `min_rating` / `max_rating` columns remain for Trustpilot backward compat.

```sql
id                  uuid PRIMARY KEY
platform            text DEFAULT 'trustpilot'  -- which plugin to run
filters             jsonb                      -- generic envelope; plugin unpacks
country             text                       -- LEGACY (Trustpilot)
category            text                       -- LEGACY (Trustpilot)
min_rating          real                       -- LEGACY (Trustpilot)
max_rating          real                       -- LEGACY (Trustpilot)
status              text DEFAULT 'pending'     -- pending | running | completed | failed
total_found         int DEFAULT 0
total_scraped       int DEFAULT 0
total_enriched      int DEFAULT 0
total_verified      int DEFAULT 0
worker_id           text                       -- which EC2 worker claimed the job (null for local runs)
error               text
started_at          timestamptz
completed_at        timestamptz
created_at          timestamptz DEFAULT now()
```

---

## Table: `scrape_failures`

Per-URL failure rows emitted by plugins on 4xx/5xx. Operator can retry from the Inbox-style failure UI.

```sql
id                  uuid PRIMARY KEY
scrape_job_id       uuid FK → scrape_jobs.id
platform            text
url                 text
reason              text                       -- e.g. "scrapingbee_500", "perimeterx_403", "parser_no_jsonld"
resolved            boolean DEFAULT false
created_at          timestamptz DEFAULT now()
```

---

## Table: `tripadvisor_cities` (migration 036)

City fan-out seed used by `tools/scraper/seed_tripadvisor_cities.py` + the TripAdvisor plugin.

```sql
id                  serial PRIMARY KEY
country             text NOT NULL
city                text NOT NULL
geo_id              text                       -- TripAdvisor location id (g-prefix)
last_walked_at      timestamptz
UNIQUE (country, city)
```

---

## Table: `social_accounts` (PLANNED — migration 037, drafted not applied)

One row per logged-in FB/IG account used for social scraping.

```sql
id                  uuid PRIMARY KEY
platform            text NOT NULL              -- 'facebook' | 'instagram'
handle              text NOT NULL              -- account username/email
encrypted_cookies   text                       -- pgp_sym_encrypt'd cookie jar
status              text DEFAULT 'active'      -- active | checkpoint | banned | disabled
daily_cap           int DEFAULT 50
hourly_cap          int DEFAULT 10
last_login_at       timestamptz
last_used_at        timestamptz
notes               text
created_at          timestamptz DEFAULT now()
```

---

## Table: `follow_ups`

Per-lead reminders.

```sql
id                  uuid PRIMARY KEY
lead_id             uuid FK → leads.id
due_date            timestamptz NOT NULL
note                text
completed           boolean DEFAULT false
completed_at        timestamptz
created_at          timestamptz DEFAULT now()
```

---

## Key Queries

**Leads with email, filtered:**
```sql
SELECT * FROM leads
WHERE primary_email IS NOT NULL
  AND country = 'DE'
  AND category = 'casino'
ORDER BY country ASC, category ASC, created_at DESC;
```

**Multi-platform: leads that exist on a specific platform:**
```sql
SELECT l.*, p.rating, p.scraped_at
FROM leads l
JOIN lead_platform_presences p ON p.lead_id = l.id
WHERE p.platform = 'yelp'
  AND p.rating <= 3.0
  AND l.primary_email IS NOT NULL;
```

**Leads seen on multiple platforms (cross-platform consolidation):**
```sql
SELECT l.company_name,
       array_agg(p.platform ORDER BY p.platform) AS platforms,
       avg(p.rating)::numeric(3,2) AS avg_rating
FROM leads l
JOIN lead_platform_presences p ON p.lead_id = l.id
GROUP BY l.id, l.company_name
HAVING count(distinct p.platform) > 1;
```

**Upcoming follow-ups:**
```sql
SELECT f.*, l.company_name FROM follow_ups f
JOIN leads l ON l.id = f.lead_id
WHERE f.completed = false AND f.due_date >= now()
ORDER BY f.due_date ASC;
```

**Campaign performance:**
```sql
SELECT c.name, cl.status, count(*) FROM campaign_leads cl
JOIN campaigns c ON c.id = cl.campaign_id
GROUP BY c.name, cl.status;
```
