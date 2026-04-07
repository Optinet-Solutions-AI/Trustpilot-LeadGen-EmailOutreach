# Database Schema

Supabase (PostgreSQL). Run `supabase/migrations/001_initial_schema.sql` in the Supabase SQL editor to set up.

---

## Table: `leads`

Primary table. One row per company scraped from Trustpilot.

```sql
id                  uuid PRIMARY KEY DEFAULT gen_random_uuid()
company_name        text NOT NULL
trustpilot_url      text UNIQUE NOT NULL   -- /review/<slug>
website_url         text
trustpilot_email    text                   -- email from Trustpilot profile
website_email       text                   -- email found on company website
primary_email       text                   -- resolved: website_email > trustpilot_email
phone               text
country             text                   -- ISO 2-letter: "DE", "GB", "US"
category            text                   -- Trustpilot slug: "casino", "gambling"
star_rating         real                   -- 1.0 – 5.0
email_verified      boolean DEFAULT false
verification_status text                   -- valid | invalid | catch-all | unknown
outreach_status     text DEFAULT 'new'     -- new | contacted | replied | converted | lost
lead_source         text DEFAULT 'trustpilot_scrape'
scraped_at          timestamptz
contacted_at        timestamptz
created_at          timestamptz DEFAULT now()
updated_at          timestamptz            -- auto-updated by trigger
```

**Important:** `primary_email` is the field used for campaign sending. Always populated as `website_email ?? trustpilot_email`.

**Outreach status enum (never change):**
`new` → `contacted` → `replied` → `converted` | `lost`

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

Tracks every scrape run.

```sql
id                  uuid PRIMARY KEY
country             text
category            text
min_rating          real
max_rating          real
status              text DEFAULT 'pending' -- pending | running | completed | failed
total_found         int DEFAULT 0
total_scraped       int DEFAULT 0
total_enriched      int DEFAULT 0
total_verified      int DEFAULT 0
error               text
started_at          timestamptz
completed_at        timestamptz
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
