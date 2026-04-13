# CLAUDE.md — Trustpilot Lead Gen & CRM Email Outreach

---

## Project Overview

A full-stack lead generation and CRM system that scrapes low-rated companies from Trustpilot, enriches their contact data, verifies emails, manages leads through a pipeline, and runs personalized cold outreach campaigns via Instantly.ai. Built on the WAT framework (Workflows → Agents → Tools).

**Business purpose:** Sell reputation management services to companies with poor Trustpilot ratings. Brand: **OptiRate** / optiratesolutions.com. Sending account: jordi@optiratesolutions.com.

- **Frontend:** React + Vite + Tailwind CSS (port 5173) — deployed on Vercel
- **Backend / API:** Node.js (Express) with TypeScript (port 3001) — deployed on Google Cloud Run (`trustpilot-crm`)
- **Database:** Supabase (PostgreSQL, 8 tables)
- **Email Platform:** Instantly.ai v2 API (`EMAIL_PLATFORM=instantly`) — handles warmup, rotation, pacing
- **Email Fallback:** Gmail API via OAuth2 (`EMAIL_MODE=gmail`) — test flights when platform unavailable
- **Scraper Tools:** Python + Playwright (headless Chromium) + playwright-stealth
- **Email Verify:** ZeroBounce (mock mode available)
- **AI:** Google Gemini API (template generation)

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
9. User creates campaign (5-step wizard: setup → template → follow-ups → recipients → review)
   ↓
10. MANDATORY: Test flight → sends 1 email via Instantly to verify format/content
    ↓
11. Live send → pushes entire campaign to Instantly → Instantly handles sending from jordi@
    ↓
12. Stats sync every 2min: opens, replies, bounces → CRM dashboard updates automatically
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
│   Routes, DB CRUD,           │──────► Supabase (8 tables)
│   Services, Orchestration    │◄──────
└──────┬───────────────┬───────┘
       │               │
       ▼               ▼
┌───────────┐    ┌─────────────────────────┐
│ Python    │    │ Email Platform Layer     │
│ Scrapers  │    │ adapter-instantly.ts     │
│ Playwright│    │ → Instantly.ai v2 API    │
│ + Stealth │    │   (create, add, activate)│
└───────────┘    └─────────────────────────┘
                          ↑ sync every 2 min
                 ┌─────────────────────────┐
                 │ platform-sync.ts        │
                 │ updates campaign_leads  │
                 └─────────────────────────┘
```

### Golden Rules
1. **Frontend is DUMB** — display data and fire actions only; zero business logic
2. **API is the BRAIN** — all scraping orchestration, filtering, and enrichment logic
3. **Database is the MEMORY** — Supabase is the single source of truth
4. **Tools are atomic** — each Python script does one job; API orchestrates them
5. **Adapter pattern for email** — swap providers by changing `EMAIL_PLATFORM` env var
6. **Test flight first** — NEVER send a live campaign without a successful test flight

---

## Directory Structure

```
trustpilot-leadgen/
│
├── CLAUDE.md                          ← This file (source of truth)
├── .env                               ← All secrets (never commit)
├── .env.example                       ← Template for .env
│
├── supabase/
│   └── migrations/
│       ├── 001_initial_schema.sql     ← 6 core tables
│       ├── 006_email_platform.sql     ← platform_campaign_id, email_platform on campaigns
│       ├── 007_campaign_steps.sql     ← follow-up steps table
│       └── 008_sending_schedule.sql   ← sending_schedule jsonb on campaigns
│
├── tools/                             ← Python scripts (WAT execution layer)
│   ├── scraper/
│   │   ├── browser_utils.py
│   │   ├── scrape_category.py
│   │   ├── scrape_profile.py
│   │   └── scrape_website.py
│   └── db/
│       ├── supabase_client.py
│       └── upsert_leads.py
│
├── server/                            ← Express + TypeScript backend
│   └── src/
│       ├── server.ts                  ← Entry point (port 3001), starts sync interval
│       ├── config.ts                  ← Env loading (emailPlatform, instantly.*, etc.)
│       ├── db/
│       │   ├── campaigns.ts           ← includes sending_schedule, platform_campaign_id
│       │   ├── campaign-steps.ts      ← follow-up steps CRUD
│       │   ├── leads.ts
│       │   ├── notes.ts
│       │   ├── scrape-jobs.ts
│       │   └── follow-ups.ts
│       ├── routes/
│       │   ├── campaigns.ts           ← send, test-flight, sync, platform-status, duplicate
│       │   ├── webhooks.ts            ← POST /api/webhooks/email-platform
│       │   ├── scrape.ts
│       │   ├── leads.ts
│       │   ├── verify.ts
│       │   ├── notes.ts
│       │   ├── follow-ups.ts
│       │   └── analytics.ts
│       └── services/
│           ├── email-platform/
│           │   ├── types.ts           ← EmailPlatformAdapter interface
│           │   ├── index.ts           ← factory: getEmailPlatform()
│           │   ├── adapter-instantly.ts ← Instantly v2 implementation
│           │   ├── adapter-mock.ts    ← console-log mock
│           │   └── webhook-parser.ts  ← normalizes webhook payloads
│           ├── platform-campaign-sender.ts ← pushCampaignToPlatform()
│           ├── platform-sync.ts       ← background polling job (every 2min)
│           ├── campaign-sender.ts     ← Gmail one-by-one (legacy/fallback)
│           ├── email-sender.ts        ← Gmail/mock facade
│           ├── template-engine.ts     ← {{token}} + {spintax|} rendering
│           ├── test-mode.ts           ← TEST MODE banner interceptor
│           └── rate-limiter.ts        ← hourly/daily caps for Gmail
│
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── campaign-wizard/
│       │   │   ├── CampaignWizard.tsx ← 5-step wizard orchestrator
│       │   │   ├── StepSetup.tsx      ← name, filters, sending schedule
│       │   │   ├── StepTemplate.tsx   ← subject, body, spintax, screenshot
│       │   │   ├── StepFollowUps.tsx  ← follow-up steps
│       │   │   ├── StepRecipients.tsx ← lead selection
│       │   │   └── StepReview.tsx     ← summary before create
│       │   ├── TestFlightModal.tsx    ← pre-flight gate (mandatory)
│       │   └── [other components]
│       ├── hooks/
│       │   ├── useCampaigns.ts        ← all campaign API calls incl. testFlightSend, syncStats
│       │   └── [other hooks]
│       └── views/
│           └── Campaigns.tsx          ← main campaigns page
│
├── docs/
│   ├── architecture.md
│   ├── api-reference.md
│   ├── deployment.md                  ← current deploy commands
│   ├── database.md
│   ├── scraper-guide.md
│   └── frontend-components.md
│
└── workflows/
    └── scrape_trustpilot.md
```

---

## Environment Variables

| Variable | Purpose | Current Value |
|----------|---------|---------------|
| `SUPABASE_URL` | Supabase project URL | set |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase server-side key | set |
| `EMAIL_PLATFORM` | `instantly` / `none` / `mock` | `instantly` |
| `INSTANTLY_API_KEY` | Instantly.ai API key | set |
| `INSTANTLY_SENDING_ACCOUNTS` | Comma-separated sending emails | `jordi@optiratesolutions.com` |
| `INSTANTLY_SYNC_INTERVAL` | Stats poll interval ms | `120000` |
| `INSTANTLY_WEBHOOK_SECRET` | Webhook signature secret | not set (optional) |
| `EMAIL_MODE` | `gmail` or `mock` (fallback) | `gmail` |
| `GOOGLE_CLIENT_ID` | Gmail OAuth2 client ID | set |
| `GOOGLE_CLIENT_SECRET` | Gmail OAuth2 client secret | set |
| `GOOGLE_REFRESH_TOKEN` | Gmail OAuth2 refresh token | set |
| `EMAIL_FROM` | Gmail sender address | `axeldray5@gmail.com` |
| `EMAIL_FROM_NAME` | Display name | `OptiRate` |
| `EMAIL_TEST_MODE` | `true` = redirect Gmail to TEST_EMAIL | `true` |
| `TEST_EMAIL_ADDRESS` | Gmail test redirect target | set |
| `EMAIL_DAILY_CAP` | Gmail daily limit | `50` |
| `EMAIL_HOURLY_CAP` | Gmail hourly limit | `20` |
| `EMAIL_MIN_DELAY` | Gmail min ms between sends | `30000` |
| `EMAIL_MAX_DELAY` | Gmail max ms between sends | `90000` |
| `PLAYWRIGHT_HEADLESS` | Headless browser in prod | `true` |
| `PYTHON_PATH` | Python executable | `/usr/bin/python3` |
| `API_SECRET_KEY` | Internal API auth | set |
| `PORT` | API port | `3001` |

---

## Database Schema (Supabase — 8 Tables)

### `leads`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `company_name` | text | |
| `trustpilot_url` | text UNIQUE | |
| `website_url` | text | |
| `trustpilot_email` | text | |
| `website_email` | text | |
| `primary_email` | text | Resolved: website > trustpilot |
| `phone` | text | |
| `country` | text | |
| `category` | text | |
| `star_rating` | real | |
| `screenshot_path` | text | Public Supabase Storage URL |
| `email_verified` | boolean | |
| `verification_status` | text | `valid`/`invalid`/`catch-all`/`unknown` |
| `outreach_status` | text | `new`/`contacted`/`replied`/`converted`/`lost` |

### `campaigns`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `name` | text | |
| `template_subject` | text | Supports `{{token}}` and `{spintax\|variants}` |
| `template_body` | text | HTML, supports tokens + spintax |
| `include_screenshot` | boolean | Embeds screenshot from lead.screenshot_path |
| `status` | text | `draft`/`sending`/`sent`/`completed`/`failed` |
| `platform_campaign_id` | text | Instantly campaign ID (set after send) |
| `email_platform` | text | e.g. `instantly` (set after send) |
| `sending_schedule` | jsonb | `{timezone, startHour, endHour, days[], dailyLimit}` |
| `total_sent/opened/replied/bounced` | int | Synced from platform |

### `campaign_leads`
| Column | Type | Notes |
|--------|------|-------|
| `campaign_id` + `lead_id` | uuid pair UNIQUE | |
| `email_used` | text | |
| `status` | text | `pending`/`sent`/`opened`/`replied`/`bounced` |

### `campaign_steps`
| Column | Type | Notes |
|--------|------|-------|
| `campaign_id` | uuid FK | |
| `step_number` | int | 2, 3, ... (step 1 is the main campaign template) |
| `delay_days` | int | Days after previous step |
| `template_subject` | text | |
| `template_body` | text | |

### `lead_notes` / `scrape_jobs` / `follow_ups`
Same as before — see `supabase/migrations/001_initial_schema.sql`.

---

## Email Platform — Instantly.ai

### Send flow
1. Spintax + tokens rendered locally per lead (Instantly doesn't support spintax)
2. Campaign created on Instantly with `{{custom_subject}}` / `{{custom_body}}` template
3. Leads added in bulk with pre-rendered content as custom variables
4. Campaign activated → Instantly handles sending, pacing, rotation
5. Stats polled every 2min → updates campaign_leads in Supabase

### Test flight
Creates a temporary 1-lead Instantly campaign with all-day schedule (00:00–23:59, all days) so it sends immediately regardless of the configured sending window. Auto-deleted after 30 minutes.

### Instantly API v2 — Critical Gotchas

| Issue | Details |
|-------|---------|
| `campaign_schedule` REQUIRED | Always include it, even with no custom schedule |
| Timezone whitelist | NOT all IANA zones accepted. Use `mapTimezone()` helper. Invalid: `America/New_York`, `UTC`, `Europe/London`, `Asia/Manila`. Valid: `America/Detroit`, `Europe/Belfast`, `Europe/Belgrade`, `Asia/Hong_Kong` |
| `delay` on every step | Each step needs `delay` (int, days). First step: `delay: 0`. Was incorrectly `wait_days`. |
| No Content-Type on empty body | `/campaigns/:id/activate` and `/pause` are bodyless POSTs. Don't send `Content-Type: application/json` with no body — 400 error. |
| `email_list` must be connected | Specifies which accounts to use. If those accounts have DNS errors or are disconnected, campaign activates but never sends. Pass `[]` to use all connected accounts. |

### DNS Requirements (BLOCKING until done)
`jordi@optiratesolutions.com` currently has **DNS Error** in Instantly (DKIM + DMARC not found). Add in Dreamhost DNS for `optiratesolutions.com`:

| Type | Name | Value |
|------|------|-------|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:jordi@optiratesolutions.com` |
| TXT | `selector._domainkey` | Copy from Instantly → Email Accounts → click the account |
| TXT | `@` | `v=spf1 include:spf.instantlyapp.com ~all` |

---

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/scrape` | POST | Start scrape job |
| `/api/scrape` | GET | List jobs |
| `/api/scrape/:id/status` | GET SSE | Live progress |
| `/api/leads` | GET | Paginated + filterable |
| `/api/leads/:id` | GET/PATCH/DELETE | Single lead |
| `/api/leads/bulk` | PATCH | Bulk update |
| `/api/leads/:id/notes` | GET/POST | Activity timeline |
| `/api/leads/:id/follow-ups` | GET/POST | Reminders |
| `/api/follow-ups` | GET | Upcoming (dashboard) |
| `/api/follow-ups/:id/complete` | PATCH | Mark done |
| `/api/verify` | POST | Batch email verification |
| `/api/campaigns` | GET/POST | List + create |
| `/api/campaigns/:id` | PATCH/DELETE | Update or delete |
| `/api/campaigns/:id/send` | POST | Push to Instantly or send via Gmail |
| `/api/campaigns/:id/test-flight` | POST | Mandatory pre-send test (body: `{testEmail}`) |
| `/api/campaigns/:id/cancel` | POST | Pause/cancel campaign |
| `/api/campaigns/:id/duplicate` | POST | Clone campaign |
| `/api/campaigns/:id/sync` | POST | On-demand stats sync from platform |
| `/api/campaigns/:id/stats` | GET | Sent/opened/replied/bounced |
| `/api/campaigns/:id/leads` | GET/POST | List or add leads |
| `/api/campaigns/:id/steps` | GET | Follow-up steps |
| `/api/campaigns/platform-status` | GET | Platform health + connected accounts |
| `/api/campaigns/preview-recipients` | GET | Count leads matching filters |
| `/api/campaigns/rate-limit` | GET | Gmail rate limit status |
| `/api/gmail/check-replies` | POST | Manually scan for replies |
| `/api/webhooks/email-platform` | POST | Incoming platform webhooks |
| `/api/analytics` | GET | Dashboard aggregates |

All routes return: `{ success: true, data: {...} }` or `{ success: false, error: "message" }`

---

## Deployment

### Backend (Cloud Run)
```bash
powershell -ExecutionPolicy Bypass -Command "cd 'c:/Users/User/Desktop/TRUSPILOT LEAD GEN AND EMAIL OUTREACH'; gcloud run deploy trustpilot-crm --source . --region us-central1 --quiet"
```

### Env var update only (no rebuild)
```bash
powershell -ExecutionPolicy Bypass -Command "gcloud run services update trustpilot-crm --region us-central1 --update-env-vars 'KEY=VALUE' --quiet"
```

### Frontend
Auto-deploys on `git push origin main`. No manual action needed.

### Full workflow
```bash
git add <files> && git commit -m "..." && git push origin main
# then run Cloud Run deploy command above
```

See `docs/deployment.md` for complete reference.

---

## What Should NOT Change

- Supabase schema (unless explicitly requested and migration written)
- `.env` variable names
- API route shapes — frontend depends on exact response structure
- Lead `outreach_status` enum: `new`/`contacted`/`replied`/`converted`/`lost`
- `campaign_leads.status` enum: `pending`/`sent`/`opened`/`replied`/`bounced`
- `EmailPlatformAdapter` interface in `types.ts` — all adapters must implement it exactly

---

## Known Constraints

- Trustpilot blocks aggressive scrapers — use 2-5s randomized delays
- Playwright required — Trustpilot pages are JS-rendered
- ZeroBounce free tier: 100 credits/month
- Instantly.ai: only specific IANA timezones accepted (use `mapTimezone()` helper)
- jordi@optiratesolutions.com has DNS Error in Instantly — no emails send until DKIM/DMARC added
- Warmup: start at 20 emails/day, increase gradually over 4 weeks

---

## Coding Standards

### Do
- One script = one responsibility
- All async operations have retry logic (max 3 attempts)
- Log every API call with timestamp and result
- Frontend hooks handle `loading`, `error`, and `data` states
- Auto-log activity on status changes and email events
- Type-check before deploying: `npx tsc --noEmit` in both `/server` and `/frontend`

### Don't
- Don't call Trustpilot from the frontend — always go through the API
- Don't store emails or API keys in client-side state
- Don't skip the test flight before a live campaign
- Don't commit `.env`, `credentials.json`, or `token.json`
- Don't hardcode timezone strings — use the TIMEZONES list in StepSetup.tsx (only Instantly-valid values)
- Don't send `Content-Type: application/json` on bodyless requests to Instantly

---

## Quick Reference

| Task | Command |
|------|---------|
| Start frontend | `cd frontend && npm run dev` (port 5173) |
| Start API | `cd server && npm run dev` (port 3001) |
| Type-check API | `cd server && npx tsc --noEmit` |
| Type-check frontend | `cd frontend && npx tsc --noEmit` |
| Deploy backend | `powershell -ExecutionPolicy Bypass -Command "cd 'c:/Users/User/Desktop/TRUSPILOT LEAD GEN AND EMAIL OUTREACH'; gcloud run deploy trustpilot-crm --source . --region us-central1 --quiet"` |
| Run scraper manually | `.venv/Scripts/python.exe tools/scraper/scrape_category.py --country DE --category casino --max-rating 3.5` |
| Run migration 008 | `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sending_schedule jsonb;` (Supabase SQL editor) |
