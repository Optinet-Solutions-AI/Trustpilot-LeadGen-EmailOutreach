# CLAUDE.md — Trustpilot Lead Gen & CRM Email Outreach

## Project Overview

A full-stack lead generation and CRM system that scrapes low-rated companies from Trustpilot, enriches their contact data, verifies emails, manages leads through a pipeline, and runs personalized outreach campaigns. Built on the WAT framework (Workflows → Agents → Tools).

- **Frontend:** React + Vite + Tailwind CSS (port 5173)
- **Backend / API:** Node.js (Express) with TypeScript (port 3001)
- **Database:** Supabase (PostgreSQL)
- **Scraper Tools:** Python + Playwright (headless Chromium) + playwright-stealth
- **Email Send:** Resend (mock mode available)
- **Email Verify:** ZeroBounce (mock mode available)

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
| `RESEND_API_KEY` | Email sending service key (blank = mock mode) |
| `EMAIL_FROM` | Sender email address for campaigns |
| `EMAIL_MODE` | `mock` (default) or `live` |
| `PLAYWRIGHT_HEADLESS` | `true` in production, `false` for debugging |
| `PYTHON_PATH` | Path to Python executable (default: `.venv/Scripts/python.exe`) |
| `VITE_API_BASE_URL` | Frontend → API base URL |
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

## Mock Mode

Email services start as mocks to allow full-flow development without API keys:
- `EMAIL_MODE=mock` (default) — verification always returns `valid`, sending logs to console
- `EMAIL_MODE=live` — uses real ZeroBounce/Resend APIs
- Toggle in `.env`, no code changes needed

---

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/scrape` | POST | Start scrape job (async) |
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
| `/api/campaigns/:id` | PATCH | Update |
| `/api/campaigns/:id/send` | POST | Send emails |
| `/api/campaigns/:id/stats` | GET | Performance metrics |
| `/api/campaigns/:id/leads` | POST | Add leads |
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
