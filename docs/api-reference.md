# API Reference

Base URL (dev): `http://localhost:3001`  
Base URL (prod): `https://<cloud-run-url>.run.app`

All responses follow:
```json
{ "success": true, "data": { ... } }
{ "success": false, "error": "message" }
```

Auth: set `X-API-Key: <API_SECRET_KEY>` header (skipped if key is blank in dev).

---

## Scrape

### `POST /api/scrape`
Start a new scrape job (async — returns immediately, progress via SSE).

**Body:**
```json
{
  "country": "DE",
  "category": "casino",
  "minRating": 1,
  "maxRating": 3.5,
  "enrich": true,
  "verify": false
}
```

**Response:** `{ "success": true, "data": { "jobId": "uuid" } }`

---

### `GET /api/scrape`
List recent scrape jobs (last 20).

**Response:** `{ "success": true, "data": [ ScrapeJob, ... ] }`

---

### `GET /api/scrape/:id/status` — SSE
Server-Sent Events stream for live scrape progress.

**Events emitted:**
| Stage | Detail |
|-------|--------|
| `started` | — |
| `category_done` | count of companies found |
| `profile_done` | — |
| `enrich_start` | — |
| `enrich_done` | count enriched |
| `completed` | — |
| `failed` | error message |

---

## Leads

### `GET /api/leads`
Paginated, filterable lead list. Default sort: country → category → created_at DESC.

**Query params:**
| Param | Type | Description |
|-------|------|-------------|
| `page` | int | Page number (default: 1) |
| `limit` | int | Per page (default: 50) |
| `search` | string | Search company name |
| `status` | string | Filter by outreach_status |
| `country` | string | Filter by country code |
| `category` | string | Filter by category slug |

---

### `GET /api/leads/:id`
Single lead with all fields.

### `PATCH /api/leads/:id`
Update any lead field. Auto-logs `status_change` activity if `outreach_status` changes.

**Body:** any subset of lead fields.

### `DELETE /api/leads/:id`
Hard delete lead.

### `PATCH /api/leads/bulk`
Bulk update multiple leads.

**Body:** `{ "ids": ["uuid", ...], "updates": { "outreach_status": "contacted" } }`

---

## Notes (Activity Timeline)

### `GET /api/leads/:id/notes`
All activity events for a lead, newest first.

### `POST /api/leads/:id/notes`
Add a note or event.

**Body:**
```json
{
  "type": "note",
  "content": "Called, left voicemail",
  "metadata": {}
}
```

**Note types:** `note` | `status_change` | `email_sent` | `verification` | `follow_up`

---

## Follow-Ups

### `GET /api/leads/:id/follow-ups`
All follow-ups for a lead.

### `POST /api/leads/:id/follow-ups`
Schedule a follow-up.

**Body:** `{ "due_date": "2026-04-15T10:00:00Z", "note": "Check in" }`

### `GET /api/follow-ups`
All upcoming incomplete follow-ups (for dashboard widget).

### `PATCH /api/follow-ups/:id/complete`
Mark a follow-up as completed.

---

## Email Verification

### `POST /api/verify`
Batch-verify emails for a list of leads.

**Body:** `{ "leadIds": ["uuid", ...] }`

**Response:** `{ "success": true, "data": { "verified": 42, "invalid": 3 } }`

In `EMAIL_MODE=mock`: always returns `valid`.

---

## Campaigns

### `GET /api/campaigns`
List all campaigns.

### `POST /api/campaigns`
Create a campaign and optionally assign leads.

**Body:**
```json
{
  "name": "Germany Casino Outreach",
  "template_subject": "Your Trustpilot score needs attention",
  "template_body": "<p>Hi {{company_name}}, ...</p>",
  "filterCountry": "DE",
  "filterCategory": "casino"
}
```

If `filterCountry` or `filterCategory` are set, all leads matching that filter with a non-null `primary_email` are auto-added.  
If `leadIds: ["uuid", ...]` is provided instead, those specific leads are added.

### `PATCH /api/campaigns/:id`
Update campaign name, template, or status.

### `POST /api/campaigns/:id/leads`
Add leads to an existing campaign.

**Body:** `{ "leadIds": ["uuid", ...] }` OR `{ "filterCountry": "DE", "filterCategory": "casino" }`

### `POST /api/campaigns/:id/send`
Send campaign emails to all pending leads.

In `EMAIL_MODE=mock`: logs to console, updates DB, no real emails sent.

### `GET /api/campaigns/:id/stats`
Performance metrics: sent, opened, replied, bounced counts.

---

## Analytics

### `GET /api/analytics`
Dashboard aggregates.

**Response:**
```json
{
  "leadsByStatus": { "new": 150, "contacted": 42, ... },
  "leadsByCountry": { "DE": 39, "GB": 88, ... },
  "campaignStats": [ { "id": "...", "name": "...", "sent": 42, ... } ],
  "upcomingFollowUps": 7
}
```

---

## Template Tokens

The template engine replaces `{{token}}` before sending.

| Token | Source |
|-------|--------|
| `{{company_name}}` | `lead.company_name` |
| `{{website_url}}` | `lead.website_url` |
| `{{trustpilot_url}}` | `lead.trustpilot_url` |
| `{{primary_email}}` | `lead.primary_email` |
| `{{country}}` | `lead.country` |
| `{{category}}` | `lead.category` |
| `{{star_rating}}` | `lead.star_rating` |
| `{{review_count}}` | `lead.review_count` (if extracted) |
