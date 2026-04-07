# System Architecture

## Overview

A full-stack lead generation and CRM. Scrapes low-rated companies from Trustpilot, enriches contact data, manages a pipeline, and sends outreach campaigns.

## Stack

| Layer | Technology | Port |
|-------|-----------|------|
| Frontend | React 19 + Vite + Tailwind CSS | 5173 (dev) |
| API | Node.js + Express 5 + TypeScript | 3001 (dev) / 8080 (Cloud Run) |
| Database | Supabase (PostgreSQL via PostgREST) | hosted |
| Scrapers | Python 3.11 + Playwright (async) | subprocess |
| Email Send | Resend (mock-first) | — |
| Email Verify | ZeroBounce (mock-first) | — |
| AI Features | Google Gemini API | — |

## Request Flow

```
Browser → Vercel (React SPA)
  → VITE_API_BASE_URL (Cloud Run)
    → Express routes
      → Supabase (reads/writes)
      → child_process.spawn(python)
        → Playwright browser
        → PostgREST (writes leads)
```

## WAT Framework

**Workflows** (`workflows/`) → Markdown SOPs defining what to do  
**Agents** (Claude Code) → Reads workflows, orchestrates tools  
**Tools** (`tools/`) → Python scripts that execute deterministically

### Golden Rules

1. **Frontend is DUMB** — display + fire actions only; zero business logic
2. **API is the BRAIN** — all orchestration, filtering, enrichment logic
3. **Database is the MEMORY** — Supabase is single source of truth
4. **Tools are atomic** — each Python script does exactly one job
5. **Mock-first** — all external APIs start as mocks; switch via `EMAIL_MODE=live`

## Data Flow: Scrape → Lead → Campaign

```
1. POST /api/scrape  →  creates scrape_jobs row  →  spawns Python
2. scrape_category.py  →  paginates Trustpilot, filters by rating
3. scrape_profile.py   →  visits /review/<slug>, extracts contacts
4. scrape_website.py   →  visits company site, finds best email (optional)
5. upsert_leads.py     →  saves all to Supabase leads table
6. SSE stream          →  API emits PROGRESS events to frontend
7. User manages leads  →  Kanban drag-drop, notes, follow-ups
8. User creates campaign → template + country/category filter
9. POST /api/campaigns/:id/send → template-engine + email-sender
10. Analytics           →  track sent/opened/replied/bounced
```

## Deployment Architecture

```
┌─────────────────────────────────┐
│  Vercel (Frontend)              │  React static build
│  VITE_API_BASE_URL=<cloud_run>  │
└─────────────┬───────────────────┘
              │ HTTPS
              ▼
┌─────────────────────────────────┐
│  Google Cloud Run               │  Single container
│  - Node.js API (Express)        │  Node 20 + Python 3.11
│  - Python scrapers (subprocess) │  + Playwright Chromium
│  - Supabase JS client           │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│  Supabase                       │  PostgreSQL + PostgREST
│  6 tables, auto-timestamps      │  Cloud-hosted, free tier
└─────────────────────────────────┘
```

## Environment Variables

| Variable | Used By | Purpose |
|----------|---------|---------|
| `SUPABASE_URL` | API + Python | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | API + Python | Server-side DB access |
| `ZEROBOUNCE_API_KEY` | API | Email verification |
| `RESEND_API_KEY` | API | Email sending |
| `EMAIL_FROM` | API | Sender address |
| `EMAIL_MODE` | API | `mock` or `live` |
| `PLAYWRIGHT_HEADLESS` | Python | `true` in prod |
| `PYTHON_PATH` | API | Python binary path |
| `API_SECRET_KEY` | API | Auth middleware |
| `PORT` | API | HTTP port (8080 Cloud Run) |
| `VITE_API_BASE_URL` | Frontend build | API base URL |
| `VITE_GEMINI_API_KEY` | Frontend build | Gemini AI features |
