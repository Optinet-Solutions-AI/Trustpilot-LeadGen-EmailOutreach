# System Architecture

## Overview

A full-stack lead generation CRM that scrapes companies from **any platform** (review sites + social) and runs personalized cold outreach campaigns through multiple connected mailbox providers. Every scraping platform plugs in behind a single `BasePlatformScraper` contract, so adding new platforms never touches the orchestrator.

**Business purpose:** Sell reputation management & lead-gen services to small/mid businesses surfaced from review and social platforms. Brand: **OptiRate** / optiratesolutions.com.

---

## Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | React 19 + Vite + Tailwind CSS | Port 5173 dev / Vercel prod |
| API | Node.js + Express 5 + TypeScript | Port 3001 dev / Cloud Run prod (service: `trustpilot-crm` — legacy name) |
| Database | Supabase (PostgreSQL) | 8+ core tables incl. `lead_platform_presences` for multi-platform identity |
| Scraper plugins | Python 3 + Playwright + stealth + ScrapingBee + curl_cffi | Each platform is a subclass of `BasePlatformScraper` |
| Email Sending | Multi-provider (`EMAIL_PLATFORM=none`) | Gmail OAuth + SMTP (Bluehost/Titan, DreamHost, generic) + Gmail app-password, per-account caps in `email_accounts` table |
| Email Verify | ZeroBounce → MillionVerifier → Hunter | Multi-tier fallback chain |
| AI | Google Gemini API | Template generation |

---

## Scraper Plugin Architecture

```
                                 BasePlatformScraper (ABC)
                                 ────────────────────────
                                 + scrape_listing(filters)
                                 + enrich_profiles(stubs)
                                 + discover_taxonomy()    (optional)
                                          ▲
                                          │ subclasses
                ┌─────────────────────────┼─────────────────────────────┐
                │                         │                             │
        ┌───────┴────────┐  ┌─────────────┴─────────┐  ┌────────────────┴───────────┐
        │ TrustpilotScrap│  │ TripAdvisorScraper    │  │ YelpScraper                │
        │ (legacy 3-     │  │ ScrapingBee           │  │ Fusion API (listing,       │
        │  script chain) │  │ stealth_proxy only,   │  │  free) + ScrapingBee       │
        │                │  │ JSON-LD parsing,      │  │ stealth_proxy (profiles,   │
        │                │  │ city fan-out          │  │  75 credits/page)          │
        └────────────────┘  └───────────────────────┘  └────────────────────────────┘

                              ▲
                              │ subclasses (planned)
                              │
                        SocialPlatformScraper (ABC)
                        ──────────────────────────
                        + search_posts(query)
                        + search_groups(query)
                        + enrich_authors(stubs)
                              ▲
                              │
                 ┌────────────┴───────────────────┐
                 │                                │
         FacebookScraper (planned)       InstagramScraper (planned)
         logged-in undetected-chromium,  logged-in mobile-UA + residential
         per-account cookie jar,         proxy, checkpoint handling
         group/post keyword search       post + profile capture
```

**Plugin registry:** `tools/scraper/platforms/__init__.py` exposes `PLATFORMS` dict keyed by `name`. The TS-side mirror is `PLATFORM_MANIFESTS` in `server/src/routes/scrape.ts`, used by `/api/scrape/platforms` to power the dynamic filter form in the frontend.

**Unified entry point:** `tools/scraper/run.py --platform <name> --action list|enrich|discover-taxonomy` is the only spawn target for non-Trustpilot scrapes. The legacy 3-script Trustpilot chain (`scrape_category.py` → `scrape_profile.py`) remains for now and routes through `scrape-runner.ts`.

---

## Request Flow

```
Browser → Vercel (React SPA)
  → VITE_API_BASE_URL → Cloud Run gateway → Express service
    ├── Supabase (reads/writes)
    ├── child_process.spawn(python) → platform plugin → external platform
    │     - Trustpilot: Playwright stealth + delays
    │     - TripAdvisor: ScrapingBee stealth_proxy
    │     - Yelp: Fusion API (listing) + ScrapingBee stealth_proxy (profiles)
    │     - FB/IG (planned): logged-in undetected-chromium + residential proxy
    └── Email sender (per-account): Gmail OAuth | SMTP (Bluehost/Titan, DreamHost, generic) | Gmail app-password
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
4. **Platform plugin contract is the seam** — every scraping platform implements `BasePlatformScraper`; the orchestrator never grows special cases
5. **Adapter pattern for email** — swap providers per-account in `email_accounts`

---

## Data Flow: Scrape → Lead → Campaign → Send

```
1. POST /api/scrape  {platform, filters, max_results}
   → creates scrape_jobs row (with platform + filters jsonb)
   → spawns tools/scraper/run.py --platform X --action list
   → plugin.scrape_listing(filters) emits profile stubs
   → spawns --action enrich; plugin.enrich_profiles(stubs) → enriched leads
   → scrape_website.py runs as post-step (platform-agnostic email enrichment)
   → upsert_leads.py: Trustpilot leads update legacy columns; others write
     to lead_platform_presences(platform, profile_url)
   → SSE stream pushes PROGRESS events to browser

2. User creates campaign in wizard (5 steps)
   → name + filters + sending schedule
   → email template (subject + body, spintax supported)
   → follow-up steps
   → recipient selection (by country/category/platform or explicit IDs)
   → stored in campaigns + campaign_leads + campaign_steps

3. Test flight (mandatory before live send)
   → POST /campaigns/:id/test-flight  {testEmail}
   → renders template against 1 real lead
   → dispatches one send via the pinned sender account from email_accounts
   → result reported back to UI

4. Live send
   → POST /campaigns/:id/send → status = 'sending'
   → campaign-scheduler.ts polls every 60s
   → buildSenderPool() pulls active accounts (respecting daily/hourly caps + DNS status)
   → picks pinned senderAccountId (or rotates) and dispatches via Gmail OAuth / SMTP
   → campaign_leads.sender_email records which account sent

5. Reply sync (IMAP poller + Gmail history API)
   → /api/gmail/check-replies scans Sent/Inbox per account
   → matches against campaign_leads via Message-ID and sender_email
   → updates lead.outreach_status to 'replied'
```

---

## Email Sending — Multi-Provider via `email_accounts`

`EMAIL_PLATFORM=none`. Every send resolves to a row in `email_accounts` with one of three `auth_type` values:

| `auth_type` | Send path | Onboarding |
|---|---|---|
| `gmail_oauth` | Gmail API + stored refresh token | "Connect Gmail" flow |
| `smtp` | Nodemailer SMTP + IMAP for Sent/replies | One-click Bluehost (Titan), DreamHost, or generic SMTP form |
| `app_password` | Gmail SMTP via app password | Manual Gmail SMTP entry |

Each account enforces its own `daily_cap`/`hourly_cap` and DNS badges (MX/SPF/DMARC). Capped accounts are skipped, not blocked. The Instantly.ai adapter (`adapter-instantly.ts`) exists in code but is **not used in production**.

---

## Database Schema (8+ tables)

| Table | Purpose |
|-------|---------|
| `leads` | Lead identity. Legacy denormalized columns (`trustpilot_url`, `star_rating`, `screenshot_path`) for Trustpilot. |
| `lead_platform_presences` | **Canonical multi-platform key.** One row per (lead, platform). Holds `profile_url`, `rating`, `platform_email`, `screenshot_path`, `scraped_at`. |
| `campaigns` | Campaign config, template, status, sending_schedule. |
| `campaign_leads` | Per-lead send status (`pending`/`sent`/`opened`/`replied`/`bounced`) + `sender_email`. |
| `campaign_steps` | Follow-up email sequence steps. |
| `lead_notes` | Activity timeline (notes, status changes, email events). |
| `scrape_jobs` | Scrape job history; `platform` column + `filters` jsonb envelope. |
| `scrape_failures` | Per-URL failure rows produced by plugins on 4xx/5xx for operator retry. |
| `follow_ups` | Per-lead reminders with due dates. |
| `email_accounts` | Connected sender mailboxes. |
| `taxonomy_categories` / `platform_categories` | Per-platform category seed (legacy `trustpilot_categories` renamed in migration 032). |
| `tripadvisor_cities` | TripAdvisor city/country fan-out seed (migration 036). |
| `social_accounts` (**planned**) | One row per logged-in FB/IG account; encrypted cookies, status, daily_cap. |

---

## Deployment Architecture

```
GitHub (main branch)
  ├── Vercel — frontend auto-deploy on push
  └── Google Cloud Run — manual deploy via gcloud CLI
        Service: trustpilot-crm  (us-central1, project trustpilot-leadgen)
        URL: https://trustpilot-crm-281469818025.us-central1.run.app
```

See [deployment.md](deployment.md) for exact commands.

---

## Social Platforms (Future)

Planned next: Facebook Pages + Groups + Instagram. Design spec: [`docs/superpowers/specs/2026-05-18-social-platforms-design.md`](superpowers/specs/2026-05-18-social-platforms-design.md). Key differences from review platforms:

- **Login required** (cookie persistence per account → `social_accounts` table)
- **Per-account daily caps** to avoid bans
- **Group/post keyword search** instead of static category pages
- **Post authors are leads** (DM target), not just page owners
