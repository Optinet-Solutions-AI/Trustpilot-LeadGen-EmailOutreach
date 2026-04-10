# CLAUDE.md — Trustpilot Lead Gen & CRM Email Outreach

## Project Overview

A full-stack lead generation and CRM system that scrapes low-rated companies from Trustpilot, enriches their contact data, verifies emails, manages leads through a pipeline, and runs personalized outreach campaigns. Built on the WAT framework (Workflows → Agents → Tools).

- **Frontend:** React + Vite + Tailwind CSS (port 5173)
- **Backend / API:** Node.js (Express) with TypeScript (port 3001)
- **Database:** Supabase (PostgreSQL)
- **Scraper Tools:** Python + Playwright (headless Chromium) + playwright-stealth
- **Email Send:** Gmail API via OAuth2 (`EMAIL_MODE=gmail`) with async rate-limited sending
- **Email Verify:** ZeroBounce (mock mode available)
- **Deployed:** Frontend on Vercel (auto-deploy), Backend on Google Cloud Run

---

## How the App Works

```
1. User opens CRM dashboard → navigates to Scrape page
   ↓
2. Selects Country, Category, Star Rating range → clicks "Start Scrape"
   ↓
3. Frontend calls POST /api/scrape → API creates job, spawns Python scrapers
   ↓
4. scrape_category.py paginates Trustpilot, filters by rating
   ↓
5. scrape_profile.py visits each /review/<slug> → extracts Name, URL, Email, Phone
   ↓
6. [Optional] scrape_website.py visits company sites → finds primary email
   ↓
7. upsert_leads.py saves all leads to Supabase
   ↓
8. User manages leads in Table or Kanban pipeline view
   ↓
9. User creates campaign with email template → adds leads → sends
   ↓
10. CRM tracks: status changes, notes, follow-ups, campaign analytics
```

---

## Architecture

```
┌──────────────────────────────┐
│   Frontend (Dumb Layer)      │  React + Vite + Tailwind
│   Dashboard, Leads, Kanban,  │  6 pages, custom hooks
│   Campaigns, Analytics       │
└─────────────┬────────────────┘
              │ REST API + SSE
              ▼
┌──────────────────────────────┐
│   API Layer (Brain)          │  Express + TypeScript
│   Routes, DB CRUD, Mock      │──────► Supabase (6 tables)
│   Services, Job Orchestration│◄──────
└─────────────┬────────────────┘
              │ child_process.spawn()
      ┌───────┴────────┐
      ▼                ▼
┌───────────┐    ┌─────────────┐
│ Python    │    │ Mock Email  │
│ Scrapers  │    │  Services   │
│ Playwright│    │ (verify +   │
│ + Stealth │    │  send)      │
└───────────┘    └─────────────┘
```

### Golden Rules
1. **Frontend is DUMB** — display data and fire actions only; zero business logic
2. **API is the BRAIN** — all scraping orchestration, filtering, and enrichment logic
3. **Database is the MEMORY** — Supabase is the single source of truth (6 tables)
4. **Tools are atomic** — each Python script does one job; API orchestrates them
5. **No hardcoded data** — country lists, categories, and templates are loaded dynamically
6. **Mock-first** — email services start as mocks (`EMAIL_MODE=mock`); real APIs added later

---

## Directory Structure

```
trustpilot-leadgen/
│
├── CLAUDE.md                          ← This file
├── .env                               ← All secrets (never commit)
├── .env.example                       ← Template for .env
├── .gitignore
├── .claudeignore
│
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql     ← 6 tables: leads, campaigns, campaign_leads,
│                                         lead_notes, scrape_jobs, follow_ups
│
├── tools/                             ← Python scripts (WAT execution layer)
│   ├── scraper/
│   │   ├── browser_utils.py           ← Playwright + stealth, popup dismiss, delays
│   │   ├── scrape_category.py         ← Paginates Trustpilot category, filters by rating
│   │   ├── scrape_profile.py          ← Visits /review/<slug>, extracts contacts
│   │   └── scrape_website.py          ← Visits company website, finds email
│   ├── email/
│   │   ├── verify_email.py            ← [Phase 5] ZeroBounce integration
│   │   └── send_campaign.py           ← [Phase 5] Resend integration
│   └── db/
│       ├── supabase_client.py         ← Shared PostgREST client
│       └── upsert_leads.py            ← Saves/updates leads in Supabase
│
├── server/                            ← Express + TypeScript backend
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts                  ← Entry point (port 3001)
│       ├── config.ts                  ← Env loading
│       ├── lib/
│       │   └── supabase.ts            ← Supabase JS client singleton
│       ├── middleware/
│       │   ├── auth.ts                ← API key validation
│       │   └── errorHandler.ts
│       ├── db/                        ← Supabase CRUD operations
│       │   ├── leads.ts
│       │   ├── campaigns.ts
│       │   ├── notes.ts
│       │   ├── scrape-jobs.ts
│       │   └── follow-ups.ts
│       ├── routes/
│       │   ├── scrape.ts              ← POST /api/scrape + SSE status
│       │   ├── leads.ts               ← CRUD + bulk ops
│       │   ├── campaigns.ts           ← CRUD + send
│       │   ├── verify.ts              ← POST /api/verify
│       │   ├── notes.ts               ← Activity timeline
│       │   ├── follow-ups.ts          ← Reminders
│       │   └── analytics.ts           ← Dashboard aggregates
│       └── services/
│           ├── scrape-runner.ts        ← Spawns Python scrapers, SSE progress
│           ├── template-engine.ts      ← {{token}} replacement
│           ├── email-verifier.mock.ts  ← Mock: always returns valid
│           └── email-sender.mock.ts    ← Mock: logs + updates DB
│
├── frontend/                          ← React + Vite + Tailwind
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts                 ← Proxy /api to localhost:3001
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                    ← Router: 6 pages
│       ├── api/
│       │   └── client.ts             ← Axios with auth header
│       ├── types/
│       │   ├── lead.ts               ← Lead, LeadNote, FollowUp
│       │   ├── campaign.ts           ← Campaign, CampaignLead
│       │   ├── scrape.ts             ← ScrapeParams, ScrapeJob
│       │   └── api.ts                ← ApiResponse<T>
│       ├── hooks/
│       │   ├── useLeads.ts           ← CRUD + filtering + pagination
│       │   ├── useScrape.ts          ← SSE progress subscription
│       │   ├── useCampaigns.ts       ← Campaign CRUD + send
│       │   ├── useNotes.ts           ← Activity log per lead
│       │   ├── useFollowUps.ts       ← Reminders CRUD
│       │   └── useAnalytics.ts       ← Dashboard aggregates
│       ├── components/
│       │   ├── Layout.tsx + Sidebar.tsx
│       │   ├── ScrapeForm.tsx         ← Country, category, rating inputs
│       │   ├── ScrapeProgress.tsx     ← SSE live progress
│       │   ├── LeadsTable.tsx         ← Sortable, filterable, bulk actions
│       │   ├── LeadPipeline.tsx       ← Kanban drag-and-drop
│       │   ├── CampaignBuilder.tsx    ← Template editor + preview
│       │   ├── ActivityTimeline.tsx   ← Per-lead event log
│       │   ├── NoteEditor.tsx         ← Add notes
│       │   ├── FollowUpScheduler.tsx  ← Schedule reminders
│       │   ├── StatusBadge.tsx        ← Colored status chips
│       │   └── StatsRow.tsx           ← Dashboard stat cards
│       ├── pages/
│       │   ├── Dashboard.tsx          ← Overview + follow-ups + campaign stats
│       │   ├── Scrape.tsx             ← Scrape form + progress + job history
│       │   ├── Leads.tsx              ← Table/Kanban toggle + filters
│       │   ├── LeadDetail.tsx         ← Single lead + timeline + follow-ups
│       │   ├── Campaigns.tsx          ← Builder + campaign list
│       │   └── Analytics.tsx          ← Charts (recharts)
│       └── styles/
│           └── index.css              ← Tailwind import
│
├── workflows/                         ← WAT Markdown SOPs
│   └── scrape_trustpilot.md
│
├── docs/
├── skills/
├── scripts/
└── .tmp/                              ← Intermediate scrape data (gitignored)
```

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase server-side key (never expose to client) |
| `ZEROBOUNCE_API_KEY` | Email verification API key (blank = mock mode) |
| `EMAIL_FROM` | Sender Gmail address (e.g. axeldray5@gmail.com) |
| `EMAIL_FROM_NAME` | Sender display name (e.g. OptiRate) |
| `EMAIL_MODE` | `mock` or `gmail` (default: mock) |
| `GOOGLE_CLIENT_ID` | Gmail OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Gmail OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Gmail OAuth2 refresh token (get via `node scripts/gmail-auth-setup.js`) |
| `EMAIL_TEST_MODE` | `true` = redirect all sends to TEST_EMAIL_ADDRESS |
| `TEST_EMAIL_ADDRESS` | Safe email for test sends |
| `EMAIL_DAILY_CAP` | Max emails per day (default: 50) |
| `EMAIL_HOURLY_CAP` | Max emails per hour (default: 20) |
| `EMAIL_MIN_DELAY` | Min ms between sends (default: 30000) |
| `EMAIL_MAX_DELAY` | Max ms between sends (default: 90000) |
| `PLAYWRIGHT_HEADLESS` | `true` in production, `false` for debugging |
| `PYTHON_PATH` | Path to Python executable (default: `.venv/Scripts/python.exe`) |
| `NEXT_PUBLIC_API_BASE_URL` | Frontend → API base URL (NEXT_PUBLIC_ prefix for Next.js) |
| `NEXT_PUBLIC_GEMINI_API_KEY` | Gemini API key for AI email template generation |
| `API_SECRET_KEY` | Internal API auth (blank = no auth in dev) |
| `PORT` | API port (default: 3001) |

---

## Database Schema (Supabase — 6 Tables)

### `leads`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `company_name` | text | |
| `trustpilot_url` | text UNIQUE | |
| `website_url` | text | |
| `trustpilot_email` | text | Email from Trustpilot |
| `website_email` | text | Email from company website |
| `primary_email` | text | Resolved: website > trustpilot |
| `phone` | text | |
| `country` | text | |
| `category` | text | |
| `star_rating` | real | |
| `email_verified` | boolean | |
| `verification_status` | text | `valid`/`invalid`/`catch-all`/`unknown` |
| `outreach_status` | text | `new`/`contacted`/`replied`/`converted`/`lost` |
| `lead_source` | text | Default: `trustpilot_scrape` |
| `scraped_at` | timestamptz | |
| `contacted_at` | timestamptz | |
| `created_at` | timestamptz | Auto |
| `updated_at` | timestamptz | Auto-trigger |

### `campaigns`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `name` | text | |
| `template_subject` | text | |
| `template_body` | text | Supports `{{company_name}}`, `{{website_url}}`, etc. |
| `status` | text | `draft`/`sent`/`completed` |
| `total_sent/opened/replied/bounced` | int | Aggregate counts |
| `sent_at` | timestamptz | |
| `created_at` | timestamptz | |

### `campaign_leads`
| Column | Type | Notes |
|--------|------|-------|
| `campaign_id` + `lead_id` | uuid UNIQUE pair | |
| `email_used` | text | |
| `status` | text | `pending`/`sent`/`opened`/`replied`/`bounced` |
| Timestamps per event | | |

### `lead_notes`
| Column | Type | Notes |
|--------|------|-------|
| `lead_id` | uuid FK | |
| `type` | text | `note`/`status_change`/`email_sent`/`verification`/etc. |
| `content` | text | |
| `metadata` | jsonb | Flexible (old_status, campaign_id, etc.) |

### `scrape_jobs`
| Column | Type | Notes |
|--------|------|-------|
| Params: country, category, rating range | | |
| `status` | text | `pending`/`running`/`completed`/`failed` |
| Progress: total_found/scraped/enriched/verified | int | |

### `follow_ups`
| Column | Type | Notes |
|--------|------|-------|
| `lead_id` | uuid FK | |
| `due_date` | timestamptz | |
| `note` | text | |
| `completed` | boolean | |

---

## CRM Features

### Lead Pipeline (Kanban)
- 5 columns: New → Contacted → Replied → Converted → Lost
- Drag-and-drop to change status (auto-logs activity)
- Toggle between Table and Pipeline views

### Activity Timeline
- Per-lead chronological log of all events
- Auto-created on: status changes, email sends, verifications
- Manual notes via NoteEditor

### Follow-Up Reminders
- Schedule per-lead with date + note
- Dashboard widget shows upcoming/overdue
- Mark as complete

### Campaign Analytics
- Per-campaign: sent/opened/replied/bounced
- Dashboard: leads by status (pie), by country (bar)
- Campaign comparison charts (recharts)

---

## Email Modes

| Mode | Behavior |
|------|----------|
| `EMAIL_MODE=mock` | Sending logs to console only — never hits Gmail API |
| `EMAIL_MODE=gmail` | Real Gmail API sends via OAuth2 refresh token |
| `EMAIL_TEST_MODE=true` | Redirects ALL sends to `TEST_EMAIL_ADDRESS` (safe test) |

**Gmail account:** axeldray5@gmail.com. New account — keep sends ≤10/day until warmed up.
**Personal email filter:** Built-in — auto-skips @gmail.com, @yahoo.com, @hotmail.com, @outlook.com, @live.com, @icloud.com, @aol.com, @protonmail.com for B2B sends.
**Deduplication:** Built-in — won't resend to an email already sent in any prior campaign.

---

## Email Deliverability Checklist

Before sending any live campaign, ensure the following:

### Automatic (built into the sending engine)
- **Multipart MIME** — every email includes both HTML and plain-text parts (`multipart/alternative`). Plain text is auto-generated from HTML.
- **List-Unsubscribe header** — `mailto:` link injected automatically (Gmail/Yahoo requirement since Feb 2024). Also includes `List-Unsubscribe-Post` for one-click compliance.
- **Domain-aligned Message-ID** — uses sender's domain for DKIM/SPF authentication alignment.
- **Human-like pacing** — default 4-9 minute randomized delays between sends (configurable via `EMAIL_MIN_DELAY` / `EMAIL_MAX_DELAY`).

### Manual (user responsibility)
- **Spintax in templates** — use `{option1|option2|option3}` syntax in both subject and body. Each email gets a unique random combination, avoiding bulk-mail fingerprinting. Example: `{Hi|Hello|Hey} {{company_name}}, {I noticed|we noticed} your {rating|score|Trustpilot profile}...`
- **Warmup schedule** — Week 1: 5-10/day. Week 2: 10-20/day. Week 3: 20-30/day. Week 4+: up to 50/day. Never jump to high volume on a new account.
- **SPF/DKIM/DMARC** — if using a custom domain, configure all three DNS records. Gmail handles this automatically for @gmail.com addresses.
- **Test flight first** — always send a test flight (`POST /api/campaigns/:id/test-flight`) before any live campaign. Check rendering in Gmail, Outlook, and Apple Mail. View "Show original" to verify headers.
- **Unsubscribe handling** — the `List-Unsubscribe` mailto link goes to the sender inbox. Manually check for unsubscribe replies and remove those leads from future campaigns.

---

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/scrape` | POST | Start scrape job (async, fire-and-forget) |
| `/api/scrape` | GET | List recent jobs |
| `/api/scrape/:id/status` | GET (SSE) | Live progress stream |
| `/api/leads` | GET | Paginated + filterable |
| `/api/leads/:id` | GET/PATCH/DELETE | Single lead CRUD |
| `/api/leads/bulk` | PATCH | Bulk update |
| `/api/leads/:id/notes` | GET/POST | Activity timeline |
| `/api/leads/:id/follow-ups` | GET/POST | Reminders |
| `/api/follow-ups` | GET | Upcoming (dashboard) |
| `/api/follow-ups/:id/complete` | PATCH | Mark done |
| `/api/verify` | POST | Batch email verification |
| `/api/campaigns` | GET/POST | Campaign list + create |
| `/api/campaigns/:id` | PATCH/DELETE | Update or delete campaign |
| `/api/campaigns/:id/send` | POST | Start async send (body: testMode, testEmail, limit) |
| `/api/campaigns/:id/cancel` | POST | Cancel a running send (stops before next email) |
| `/api/campaigns/:id/send/status` | GET (SSE) | Live send progress stream |
| `/api/campaigns/:id/stats` | GET | Performance metrics |
| `/api/campaigns/:id/leads` | GET/POST | List or add leads |
| `/api/campaigns/rate-limit` | GET | Email rate limit status |
| `/api/gmail/check-replies` | POST | Manually trigger reply scan |
| `/api/analytics` | GET | Dashboard aggregates |

All routes return: `{ success: true, data: {...} }` or `{ success: false, error: "message" }`

---

## What Should NOT Change

- [ ] Supabase schema (unless explicitly requested)
- [ ] `.env` variable names
- [ ] API route shapes — frontend depends on exact response structure
- [ ] Lead `outreach_status` enum: `new`/`contacted`/`replied`/`converted`/`lost`
- [ ] `campaign_leads.status` enum: `pending`/`sent`/`opened`/`replied`/`bounced`

---

## Known Constraints

- Trustpilot blocks aggressive scrapers — use 2-5s randomized delays between requests
- Playwright required (not `requests`) — Trustpilot pages are JS-rendered
- ZeroBounce free tier: 100 credits/month — deduplicate before batching
- Resend free tier: 3,000 emails/month
- Supabase free: 500MB, 50k rows — sufficient for MVP

---

## Coding Standards

### Do
- One script = one responsibility
- All async scraping operations have retry logic (max 3 attempts)
- Log every scrape run with timestamp, params, and result count
- Frontend hooks handle `loading`, `error`, and `data` states
- Auto-log activity on status changes and email events

### Don't
- Don't call Trustpilot from the frontend — always go through the API
- Don't store emails in localStorage or any client-side state
- Don't skip email verification before sending campaigns (in live mode)
- Don't commit `.env`, `credentials.json`, or `token.json`
- Don't hardcode country or category lists — load from config

---

## Quick Reference

| Task | Command |
|------|---------|
| Start frontend | `cd frontend && npm run dev` (port 5173) |
| Start API | `cd server && npm run dev` (port 3001) |
| Start both | Run both commands above in separate terminals |
| Run scraper | `.venv/Scripts/python.exe tools/scraper/scrape_category.py --country US --category casino --max-rating 3.5` |
| Type-check API | `cd server && npx tsc --noEmit` |
| Type-check frontend | `cd frontend && npx tsc --noEmit` |
| Setup Supabase | Run `supabase/migrations/001_initial_schema.sql` in Supabase SQL editor |

---

## Summary

**What this project is:** Automated lead generation and CRM targeting low-rated Trustpilot companies, with enrichment, email verification, pipeline management, and outreach campaigns.
**Main rule:** Frontend is dumb — all scraping, enrichment, verification, and sending logic lives in the API and Python tools layer.
**Never break:** Supabase schema, API response shapes, lead/campaign status enums, `.env` variable names.
**Always do:** Use mock mode first, verify emails before live campaigns, 2-5s delays between scrape requests.
