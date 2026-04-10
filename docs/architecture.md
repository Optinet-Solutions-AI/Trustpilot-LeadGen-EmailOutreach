# System Architecture

## Overview

A full-stack lead generation CRM targeting low-rated Trustpilot companies. Scrapes contacts, enriches data, manages a pipeline, and runs personalized cold outreach campaigns through Instantly.ai.

**Business purpose:** Sell reputation management services (brand: OptiRate / optiratesolutions.com) to companies with poor Trustpilot ratings.

---

## Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React 19 + Vite + Tailwind CSS | Port 5173 dev / Vercel prod |
| API | Node.js + Express 5 + TypeScript | Port 3001 dev / Cloud Run prod |
| Database | Supabase (PostgreSQL) | 8 tables |
| Scrapers | Python 3 + Playwright + stealth | Spawned as child_process |
| Email Platform | Instantly.ai v2 API | Handles warmup, rotation, pacing |
| Email Fallback | Gmail API via OAuth2 | Test flights + legacy sends |
| Email Verify | ZeroBounce | Mock available |
| AI | Google Gemini API | Template generation |

---

## Request Flow

```
Browser → Vercel (React SPA)
  → VITE_API_BASE_URL → Cloud Run (Express)
    ├── Supabase (reads/writes)
    ├── child_process.spawn(python) → Playwright → Trustpilot
    └── Instantly.ai API → sends from jordi@optiratesolutions.com
```

---

## WAT Framework

**Workflows** (`workflows/`) → Markdown SOPs defining what to do  
**Agents** (Claude Code) → Reads workflows, orchestrates tools  
**Tools** (`tools/`) → Python scripts that execute deterministically

### Golden Rules

1. **Frontend is DUMB** — display + fire actions only; zero business logic
2. **API is the BRAIN** — all orchestration, filtering, enrichment logic
3. **Database is the MEMORY** — Supabase is single source of truth
4. **Tools are atomic** — each Python script does exactly one job
5. **Mock-first** — external APIs start as mocks; switch via env var

---

## Data Flow: Scrape → Lead → Campaign → Send

```
1. POST /api/scrape
   → creates scrape_jobs row
   → spawns: scrape_category.py → scrape_profile.py → scrape_website.py
   → upsert_leads.py saves to Supabase
   → SSE stream pushes PROGRESS events to browser

2. User creates campaign in wizard (5 steps)
   → name + filters + sending schedule
   → email template (subject + body, spintax supported)
   → follow-up steps
   → recipient selection (by country/category or explicit IDs)
   → stored in campaigns + campaign_leads + campaign_steps

3. Test flight (mandatory before live send)
   → POST /campaigns/:id/test-flight
   → renders template with real lead data
   → creates temp Instantly campaign (all-day schedule, any account)
   → activates → email sent from jordi@optiratesolutions.com
   → temp campaign auto-deleted after 30 min

4. Live send
   → POST /campaigns/:id/send
   → pushCampaignToPlatform()
   → renders spintax per lead locally
   → creates Instantly campaign with template vars {{custom_subject}} / {{custom_body}}
   → addLeads() uploads all leads in batches of 1000
   → activateCampaign() → Instantly handles pacing, rotation, warmup

5. Stats sync (every 2 min)
   → platform-sync.ts polls Instantly analytics
   → updates campaigns totals + campaign_leads status
   → creates activity notes for opens/replies/bounces
```

---

## Email Platform Adapter Pattern

```
EMAIL_PLATFORM=none       → Gmail one-by-one (legacy, campaign-sender.ts)
EMAIL_PLATFORM=mock       → Console-log mock (adapter-mock.ts)
EMAIL_PLATFORM=instantly  → Instantly.ai v2 (adapter-instantly.ts)
```

All adapters implement `EmailPlatformAdapter` (`email-platform/types.ts`). Swap providers by changing one env var. The adapter layer is in `server/src/services/email-platform/`.

---

## Database Schema (8 Tables)

| Table | Purpose |
|-------|---------|
| `leads` | Scraped companies with contact info, outreach status |
| `campaigns` | Campaign config, template, status, platform_campaign_id, sending_schedule |
| `campaign_leads` | Per-lead send status: pending/sent/opened/replied/bounced |
| `campaign_steps` | Follow-up email sequence steps |
| `lead_notes` | Activity timeline (notes, status changes, email events) |
| `scrape_jobs` | Scrape job history + progress |
| `follow_ups` | Per-lead reminders with due dates |
| *(schema)* | Supabase internal |

---

## Deployment Architecture

```
GitHub (main branch)
  ├── Vercel — frontend auto-deploy on push
  └── Google Cloud Run — manual deploy via gcloud CLI
        Service: trustpilot-crm (us-central1)
        URL: https://trustpilot-crm-281469818025.us-central1.run.app
```

See [deployment.md](deployment.md) for exact commands.
