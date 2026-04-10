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
  "templateSubject": "Your Trustpilot score needs attention",
  "templateBody": "<p>Hi {{company_name}}, ...</p>",
  "includeScreenshot": true,
  "filterCountry": "DE",
  "filterCategory": "casino",
  "followUpSteps": [
    { "delayDays": 3, "subject": "Following up...", "body": "<p>...</p>" }
  ],
  "sendingSchedule": {
    "timezone": "America/Detroit",
    "startHour": "09:00",
    "endHour": "17:00",
    "days": [1, 2, 3, 4, 5],
    "dailyLimit": 50
  }
}
```

If `filterCountry` or `filterCategory` are set, all matching leads with a `primary_email` are auto-added.  
If `leadIds: ["uuid", ...]` is provided instead, those specific leads are added.

### `PATCH /api/campaigns/:id`
Update campaign fields.

### `DELETE /api/campaigns/:id`
Delete campaign and all its campaign_leads.

### `POST /api/campaigns/:id/leads`
Add leads to an existing campaign.

**Body:** `{ "leadIds": ["uuid", ...] }` OR `{ "filterCountry": "DE", "filterCategory": "casino" }`

### `GET /api/campaigns/:id/leads`
List all campaign_leads with status and lead metadata.

### `GET /api/campaigns/:id/steps`
List follow-up steps for a campaign.

### `POST /api/campaigns/:id/send`
Send campaign. Branches based on `EMAIL_PLATFORM` env var:
- `EMAIL_PLATFORM=instantly` → pushes entire campaign to Instantly (creates campaign, adds leads, activates)
- `EMAIL_PLATFORM=none` → sends one-by-one via Gmail with rate limiting

**Body (Gmail mode only):** `{ "testMode": false, "testEmail": "...", "limit": 10 }`

### `POST /api/campaigns/:id/test-flight`
Send a test email using real lead data. **Mandatory before live send.**

- Platform mode: creates a temporary 1-lead Instantly campaign with all-day schedule, auto-deletes after 30 min
- Direct mode: sends via Gmail with TEST MODE banner

**Body:** `{ "testEmail": "you@example.com" }`

**Response:** `{ "sentTo": "...", "leadUsed": "...", "originalEmail": "...", "platform": "Instantly" }`

### `POST /api/campaigns/:id/cancel`
Cancel a running campaign.
- Platform mode: pauses the Instantly campaign
- Direct mode: stops before next email

### `POST /api/campaigns/:id/duplicate`
Duplicate a campaign (copies template + steps + schedule, resets status to draft).

### `POST /api/campaigns/:id/sync`
Trigger an on-demand stats sync from Instantly (updates sent/opened/replied/bounced).

### `GET /api/campaigns/:id/stats`
Performance metrics: sent, opened, replied, bounced counts.

### `GET /api/campaigns/platform-status`
Check if a third-party platform is configured and healthy.

**Response:** `{ "enabled": true, "platform": "Instantly", "ok": true, "accounts": [{ "email": "jordi@...", "status": "active" }] }`

### `GET /api/campaigns/preview-recipients`
Preview how many leads would be added with given filters.

**Query:** `?country=DE&category=casino`

---

## Webhooks

### `POST /api/webhooks/email-platform`
Receives real-time events from the email platform (Instantly webhooks).
- No auth middleware (webhook secret validated internally)
- Updates `campaign_leads` status + creates activity notes immediately

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
