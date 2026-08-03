# CLAUDE.md — Multi-Platform Lead Gen & CRM Email Outreach

> Repo dir is `TRUSPILOT LEAD GEN AND EMAIL OUTREACH` and the Cloud Run service is `trustpilot-crm` — both names are **legacy** and intentionally unchanged. The system itself is platform-agnostic.

---

## ⚠️ STANDING DIRECTIVE — Keep the PMS board in sync (do this without being asked)

This project's work is tracked on an external PMS board ("TrustPilot Dashboard" at https://pms-nu-eight.vercel.app, project id `cmnx071c7000004jvmffvk53p`). **Proactively update it as part of finishing work** — the operator should never have to remind you:

- **When a meaningful task/milestone is completed** → log it to **Done**, assigned to the operator (John Campilanan, `cmnx0tu7x000004jlz2vcf34u`), with a one-line description and **`dueDate` set to today** (**date-only `YYYY-MM-DD`, e.g. `2026-07-14`** — the full-timestamp form `…T12:00:00.000Z` is now rejected with `400 Invalid ISO date`; the board shows no date badge without it — back-fill via `PATCH /api/tasks/{id}` `{dueDate}`). Also note `priority` must be UPPERCASE (`LOW`/`MEDIUM`/`HIGH`/`URGENT`).
  - **CRITICAL — how to actually make it count as "completed today":** the **Daily Report's "Tasks Completed" bucket counts tasks MOVED into Done that day (a move event), NOT tasks created directly in Done.** A card created with `POST … columnId=Done` shows on the board but stays OUT of the daily report (Tasks Completed renders `—`). So **create the card in To Do/In Progress, then `PATCH /api/tasks/{taskId}/move` it to Done** ({columnId: Done, position: 0}). If you already created it in Done, move it OUT (to In Progress `cmnx071cz000304jvambw65wh`) and back to Done `cmnx071cz000604jv36sqn7u8` once to generate the completion event. Verify with `GET /api/users/{userId}/daily-report?date=YYYY-MM-DD` → `data.completed`.
- **When you start OR identify substantial new/remaining work** → add it to **To Do** / **In Progress** (don't leave follow-on work only in your chat reply — if there's a pending task, it belongs on the board), or move an existing task with `PATCH /api/tasks/{id}/move`.
- Mention what you logged in your reply so the operator can see it landed.

**How to call the API (full details + IDs in the `project-pms-integration` memory; OpenAPI spec in `api-1.json`):**
- **Auth (PREFERRED): non-expiring API token.** Send `Authorization: Bearer $PMS_API_TOKEN` (value `pms_…` lives in `.env`). Verified 2026-06-30: works for GET/POST/PATCH/DELETE and **does not need the `Origin` CSRF header** — it never expires, so use it for all calls. (Bearer tokens previously 401'd; the deployment now wires them up.)
- **Auth (fallback): session cookie.** `Cookie: __Secure-authjs.session-token=$PMS_SESSION_COOKIE` (the `__Secure-` prefix is required) still works but **expires** — only use it if the bearer token ever 401s.
- **CSRF:** only relevant on the cookie path — every write (POST/PATCH/DELETE) made with the cookie needs an `Origin: https://pms-nu-eight.vercel.app` header or it 403s with `Cross-origin request blocked`. Bearer-token writes do NOT need it. GETs never do.
- **Verify every write:** this PMS sometimes returns `201` on a write that doesn't actually persist — always re-`GET /api/tasks/{id}` after creating to confirm.
- **Create:** `POST /api/projects/{pid}/tasks` (req `title`,`columnId`; opt `description`,`priority` UPPERCASE,`dueDate` date-only `YYYY-MM-DD`,`assigneeIds[]`). Set `dueDate` so the board shows the date badge. (Tip: a minimal `{title,columnId}` create always works; back-fill the rest via PATCH if a field 400s.) **Update:** `PATCH /api/tasks/{taskId}` (accepts `dueDate` to back-fill). Columns: Backlog/To Do `cmnx071cz000204jvtz9crqn3`/In Progress `cmnx071cz000304jvambw65wh`/Review-QA/Blocked/Done `cmnx071cz000604jv36sqn7u8` (full list in memory).
- The bearer token is the durable path and should not expire. If it ever 401s, fall back to the session cookie; if the cookie also 401s, ask the operator to re-grab `authjs.session-token` from the browser.

---

## Project Overview

A full-stack lead generation and CRM system that scrapes companies from **any platform** — review sites (Trustpilot, Yelp, TripAdvisor — live) and social platforms (Facebook Pages/Groups, Instagram — planned, with post/group keyword search and post-author capture). Each platform is a plugin behind a single `BasePlatformScraper` contract; scraped leads are enriched, verified, managed through a pipeline, and contacted via personalized cold outreach campaigns over multiple connected mailbox providers. Built on the WAT framework (Workflows → Agents → Tools).

**Business purpose:** Sell reputation management & lead-gen services to small/mid businesses surfaced from review and social platforms. Brand: **OptiRate** / optiratesolutions.com.

- **Frontend:** React + Vite + Tailwind CSS (port 5173) — deployed on Vercel
- **Backend / API:** Node.js (Express) with TypeScript (port 3001) — deployed on Google Cloud Run (`trustpilot-crm` — legacy service name)
- **Database:** Supabase (PostgreSQL, 8+ tables including `lead_platform_presences` for multi-platform lead identity)
- **Email Sending:** Multi-provider via `email_accounts` table — Gmail OAuth, SMTP (Bluehost/Titan, DreamHost, generic), and Gmail app-password. `EMAIL_PLATFORM=none` (no Instantly). Each account carries its own `daily_cap`/`hourly_cap` and DNS status (MX/SPF/DMARC).
- **Scraper Tools:** Python plugin registry (`tools/scraper/platforms/`) — Playwright + stealth (Trustpilot), ScrapingBee `stealth_proxy` (TripAdvisor, Yelp profiles), Yelp Fusion API (Yelp listings). Social platforms (planned) will use logged-in undetected-chromium + residential proxy + per-account session store.
- **Email Verify:** ZeroBounce primary → MillionVerifier (Tier 2, on `unknown`) → Hunter (Tier 3, last resort)
- **AI:** Google Gemini API (template generation)

---

## How the App Works

```
1. User opens CRM dashboard → navigates to Scrape page → picks a platform
   ↓
2. The page renders the platform's filter_schema dynamically (Trustpilot needs
   country+category+rating; TripAdvisor needs location+listing_type+rating;
   Yelp needs country+category+rating+min_review_count; etc.) → user fills it
   in and clicks "Start Scrape"
   ↓
3. Frontend calls POST /api/scrape {platform, filters, max_results} → API
   creates a scrape_jobs row, spawns the unified tools/scraper/run.py with
   --platform <name> --action list|enrich
   ↓
4. The platform plugin's scrape_listing(filters) paginates listing pages
   and applies the rating/review filters → returns profile stubs
   ↓
5. The plugin's enrich_profiles(stubs) visits each profile, pulls
   {company_name, website_url, platform_email, phone, screenshot} →
   takes screenshots → uploads to Supabase Storage
   ↓
6. [Optional] scrape_website.py visits company sites → finds website_email
   ↓
7. upsert_leads.py writes the lead + lead_platform_presences(platform, profile_url) row
   ↓
8. User manages leads in Table or Kanban pipeline view
   ↓
9. User creates campaign (5-step wizard: setup → template → follow-ups → recipients → review)
   ↓
10. MANDATORY: Test flight → sends 1 email via the pinned sender account to verify format/content
    ↓
11. Live send → campaign-scheduler.ts polls every 60s → sends via each lead's assigned account (Gmail OAuth OR SMTP — Bluehost/Titan, DreamHost, etc.)
    ↓
12. Stats tracked in campaign_leads table (with `sender_email` for authoritative counts); replies synced via IMAP poller
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
┌──────────────────────────┐  ┌──────────────────────────────┐
│ Platform Plugins (Py)    │  │ Email Layer (multi-provider) │
│ Trustpilot / TripAdvisor │  │ campaign-scheduler.ts        │
│ Yelp / [FB/IG planned]   │  │ → Gmail OAuth / SMTP /       │
│ subclass                 │  │   app-password per account   │
│ BasePlatformScraper      │  │   (email_accounts table)     │
└──────────────────────────┘  └──────────────────────────────┘
```

### Golden Rules
1. **Frontend is DUMB** — display data and fire actions only; zero business logic
2. **API is the BRAIN** — all scraping orchestration, filtering, and enrichment logic
3. **Database is the MEMORY** — Supabase is the single source of truth
4. **Platform plugin contract is the seam** — every scraping platform subclasses `BasePlatformScraper` at `tools/scraper/platforms/base.py` and registers itself in `platforms/__init__.py`. Adding a platform never edits the orchestrator.
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
│   │   ├── browser_utils.py           ← stealth Playwright launch, safe_goto, popup dismissal
│   │   ├── tls_fetch.py               ← curl_cffi TLS fingerprint fallback
│   │   ├── scrape_category.py         ← legacy Trustpilot category scraper
│   │   ├── scrape_profile.py          ← legacy Trustpilot profile scraper
│   │   ├── scrape_website.py          ← platform-agnostic website email enrichment
│   │   ├── run.py                     ← unified plugin entry point: --platform X --action list|enrich|discover-taxonomy
│   │   ├── seed_tripadvisor_cities.py ← hybrid 2-pass city seeder
│   │   ├── platforms/                 ← plugin registry
│   │   │   ├── base.py                ← BasePlatformScraper ABC
│   │   │   ├── __init__.py            ← PLATFORMS dict + get_platform()
│   │   │   ├── trustpilot.py
│   │   │   ├── tripadvisor.py
│   │   │   ├── yelp.py
│   │   │   └── _social_base.py        ← SocialPlatformScraper ABC (planned platforms)
│   │   ├── shared/                    ← shared helpers (scrapingbee, yelp_fusion, etc.)
│   │   └── data/                      ← seed JSON (tripadvisor_country_geo, yelp_country_cities)
│   └── db/
│       ├── supabase_client.py
│       └── upsert_leads.py            ← splits Trustpilot legacy path vs _upsert_nontrustpilot_lead
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
    ├── scrape_review_platform.md      ← generic SOP for any review-platform plugin
    ├── scrape_trustpilot.md           ← Trustpilot-specific notes
    ├── scrape_tripadvisor.md          ← TripAdvisor-specific notes
    └── scrape_yelp.md                 ← Yelp-specific notes
```

---

## Environment Variables

| Variable | Purpose | Current Value |
|----------|---------|---------------|
| `SUPABASE_URL` | Supabase project URL | set |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase server-side key | set |
| `EMAIL_PLATFORM` | `instantly` / `none` / `mock` | `none` |
| `EMAIL_MODE` | legacy fallback only; real sends resolve per-account from `email_accounts` | — |
| `GOOGLE_CLIENT_ID` | OAuth2 client ID used for connecting Gmail accounts (NOT a sender) | set |
| `GOOGLE_CLIENT_SECRET` | OAuth2 client secret used for connecting Gmail accounts | set |
| `EMAIL_FROM_NAME` | Display-name fallback when an account has no `from_name` | `OptiRate` |
| `EMAIL_TEST_MODE` | `true` = redirect outgoing mail to `TEST_EMAIL_ADDRESS` | `true` |
| `TEST_EMAIL_ADDRESS` | Test-mode redirect target | set |
| `EMAIL_MIN_DELAY` | Global min ms between sends (per-account cap takes precedence) | `30000` |
| `EMAIL_MAX_DELAY` | Global max ms between sends (per-account cap takes precedence) | `90000` |
| `PLAYWRIGHT_HEADLESS` | Headless browser in prod | `true` |
| `PYTHON_PATH` | Python executable | `/usr/bin/python3` |
| `SCRAPINGBEE_API_KEY` | Required for TripAdvisor (full pipeline) and Yelp profile enrichment on `/biz/<slug>` via `stealth_proxy` — 75 credits/page. Yelp `/search` is NOT reachable via ScrapingBee (timed out 100% in smoke tests). Sign up at https://scrapingbee.com | set |
| `YELP_API_KEY` | Was Yelp Fusion listing. Fusion is now PAID and this key's trial has EXPIRED (`400 TRIAL_EXPIRED`). Listing now defaults to the free browser path; only needed if `YELP_LISTING_SOURCE=fusion`. | set (trial expired) |
| `YELP_LISTING_SOURCE` | `browser` (free headed-browser `/search`, owner-local-only — default) or `fusion` (paid Yelp API). | `browser` |
| `MILLIONVERIFIER_API_KEY` | Optional Stage-6 verifier (fires only on ZB-unknown). Free tier: 1,000 credits at https://app.millionverifier.com | unset |
| `HUNTER_API_KEY` | Powers Tier 9 enrichment (domain search for fully-blocked operators) + Stage 7 verifier (last-resort, fires only when ZB AND MV both unknown). Free tier: 50 calls/mo at https://hunter.io. Free-mailbox domains skipped automatically; per-process hourly cap defaults to 15 enrich + 20 verify (overridable via `HUNTER_MAX_DOMAIN_SEARCHES_PER_HOUR` / `HUNTER_MAX_CALLS_PER_HOUR`) | unset |
| `SCRAPFLY_API_KEY` | Optional Tier 5b enrichment (different IP pool from ScrapingBee, ASP=true bypasses CF/PerimeterX/DataDome). Free tier: 1,000 credits/mo at https://scrapfly.io | unset |
| `APIFY_API_TOKEN` | Cookieless Apify actor runs for FB post/group discovery — no account, no daily cap, runs on Cloud Run/Linux. Free plan caps 20 results/run + 1 run/24h; paid (~$39/mo) needed for real volume. Sign up at https://apify.com | unset |
| `APIFY_FB_SEARCH_ACTOR` | Keyword post/group search actor. Required input key is `query` (NOT `search_query`, verified live 2026-07-31). $2.59/1,000 results | `scrapeforge/facebook-search-posts` (build 1.0.19) |
| `APIFY_FB_GROUP_POSTS_ACTOR` | Public-group post actor (`groupId`, `maxPages`). $5.00/1,000 results | `data-slayer/facebook-group-posts` (build 1.0.5) |
| `FB_DISCOVERY` | `apify` (cookieless, no browser, runs on Cloud Run/Linux — default) or `browser` (legacy logged-in crawl, required only for PRIVATE groups an account has joined) | `apify` |
| `FB_ENRICH` | `stub` (build leads from the Apify search result, no browser — default) or `browser` (visit each author profile for bio/website/email, burns account quota) | `stub` |
| `ADSPOWER_API_BASE` | Local API base URL for the AdsPower engagement browser (isolated per-account fingerprints — NOT a proxy). Requires the desktop client running on this host + a paid plan. AdsPower's own docs say `local.adspower.net`; verified live 2026-07-31 the real host was `local.adspower.com` — their docs are wrong (also wrong on the local config file path: real is `%APPDATA%\adspower_global\cwd_global\source\local_api`, not `%LOCALAPPDATA%`) | `http://local.adspower.com:50325` |
| `ADSPOWER_API_KEY` | Only needed when AdsPower's "Security Verification" is enabled in the client; sent as `Authorization: Bearer <key>`. Generating a key requires a paid plan | unset |
| `API_SECRET_KEY` | Internal API auth | set |
| `PORT` | API port | `3001` |

---

## Database Schema (Supabase)

The schema is in a transitional state: a legacy `leads` table (Trustpilot-shaped, denormalized) coexists with a multi-platform `lead_platform_presences` table introduced by migration 032. Trustpilot still keys on `leads.trustpilot_url`; every other platform keys on `lead_platform_presences(platform, profile_url)`. Phase 2+ work will cut Trustpilot over and drop the legacy column.

### `leads` (lead identity)
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `company_name` | text | |
| `trustpilot_url` | text UNIQUE NULLABLE | **Legacy** — only Trustpilot leads still write this; Yelp/TripAdvisor use `lead_platform_presences` |
| `website_url` | text | |
| `trustpilot_email` | text | Legacy — Trustpilot only |
| `website_email` | text | Email scraped from company website (platform-agnostic) |
| `primary_email` | text | Resolved: platform > website (skip a source whose `*_email_status` is `invalid`) |
| `phone` | text | |
| `country` | text | |
| `category` | text | |
| `star_rating` | real | Denormalized for Trustpilot — platform-specific ratings live on `lead_platform_presences.rating` |
| `screenshot_path` | text | Denormalized — canonical screenshots live on `lead_platform_presences.screenshot_path` |
| `email_verified` | boolean | |
| `verification_status` | text | `valid`/`invalid`/`catch-all`/`unknown` |
| `outreach_status` | text | `new`/`contacted`/`replied`/`converted`/`lost` |

### `lead_platform_presences` (multi-platform identity — migration 032)
| Column | Type | Notes |
|--------|------|-------|
| `lead_id` | uuid FK → leads | |
| `platform` | text | `trustpilot` / `tripadvisor` / `yelp` / future `facebook` / `instagram` |
| `profile_url` | text | Canonical platform profile URL |
| `rating` | real | Per-platform rating |
| `platform_email` | text | Email scraped from the platform profile |
| `screenshot_path` | text | Public Supabase Storage URL |
| `scraped_at` | timestamp | |
| **Unique:** | `(platform, profile_url)` | |

### `campaigns`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `name` | text | |
| `template_subject` | text | Supports `{{token}}` and `{spintax\|variants}` |
| `template_body` | text | HTML, supports tokens + spintax |
| `include_screenshot` | boolean | Embeds screenshot from lead.screenshot_path |
| `status` | text | `draft`/`sending`/`sent`/`completed`/`failed` |
| `platform_campaign_id` | text | Platform campaign ID (unused in Gmail mode) |
| `email_platform` | text | Email platform used (unused in Gmail mode) |
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

## Email Sending — Multi-Provider via `email_accounts`

`EMAIL_PLATFORM=none`. There is **no single sender env var** — every send resolves to a row in the `email_accounts` table. Supported `auth_type` values:

| `auth_type` | How it sends | Onboarding path |
|---|---|---|
| `gmail_oauth` | Gmail API with stored refresh token | "Connect Gmail" flow |
| `smtp` | Nodemailer SMTP + IMAP for Sent/replies | One-click Bluehost (Titan), DreamHost, or generic SMTP form |
| `app_password` | Gmail SMTP via app password | Manual Gmail SMTP entry |

Campaign sends flow: `campaign-scheduler.ts` (polls every 60s) → `buildSenderPool()` pulls active accounts → picks the pinned `senderAccountId` (or rotates) → dispatches via the right sender module (`email-sender.gmail.ts` or `email-sender.smtp.ts`). Each account enforces its own `daily_cap`, `hourly_cap`, and DNS status (MX/SPF/DMARC) — capped accounts are skipped, not blocked. `campaign_leads.sender_email` records which account actually sent.

The Instantly.ai adapter (`adapter-instantly.ts`) exists in code but is **not used in production**.

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
| `/api/campaigns/:id/send` | POST | Launch campaign send via Gmail |
| `/api/campaigns/:id/test-flight` | POST | Mandatory pre-send test (body: `{testEmail}`) |
| `/api/campaigns/:id/cancel` | POST | Pause/cancel campaign |
| `/api/campaigns/:id/duplicate` | POST | Clone campaign |
| `/api/campaigns/:id/sync` | POST | On-demand stats sync from platform |
| `/api/campaigns/:id/stats` | GET | Sent/opened/replied/bounced |
| `/api/campaigns/:id/leads` | GET/POST | List or add leads |
| `/api/campaigns/:id/steps` | GET | Follow-up steps |
| `/api/campaigns/platform-status` | GET | Platform health + connected accounts |
| `/api/campaigns/preview-recipients` | GET | Count leads matching filters |
| `/api/campaigns/rate-limit` | GET | Per-account rate limit status |
| `/api/gmail/check-replies` | POST | Manually scan for replies (Gmail + IMAP for SMTP accounts) |
| `/api/email-accounts` | GET/POST | List + create connected mailbox accounts |
| `/api/email-accounts/bluehost` | POST | One-click Bluehost (Titan) SMTP/IMAP onboarding |
| `/api/webhooks/email-platform` | POST | Incoming platform webhooks |
| `/api/analytics` | GET | Dashboard aggregates |

All routes return: `{ success: true, data: {...} }` or `{ success: false, error: "message" }`

---

## Deployment

**Policy:** Never run git push or deploy commands automatically. Always output the commands below for the user to copy-paste and run themselves.

### Step 1 — Push frontend (triggers Vercel auto-deploy)
```bash
git add <files> && git commit -m "..." && git push origin main
```

### Step 2 — Deploy backend (Cloud Run)
```powershell
powershell -ExecutionPolicy Bypass -Command "cd 'c:/Users/User/Desktop/TRUSPILOT LEAD GEN AND EMAIL OUTREACH'; gcloud run deploy trustpilot-crm --source . --region us-central1 --project=trustpilot-leadgen --quiet"
```

**`--project=trustpilot-leadgen` is mandatory.** The gateway routes to the `trustpilot-crm` service in the `trustpilot-leadgen` project (project number `281469818025`). There is also a `trustpilot-crm` service in `pearl-view-491114` — deploying there succeeds silently but the gateway never sees the new code. Always pass the flag.

### Env var update only (no rebuild)
```powershell
powershell -ExecutionPolicy Bypass -Command "gcloud run services update trustpilot-crm --region us-central1 --project=trustpilot-leadgen --update-env-vars 'KEY=VALUE' --quiet"
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
- `BasePlatformScraper` contract in `tools/scraper/platforms/base.py` — all platform plugins must implement it exactly. Social platforms add the `SocialPlatformScraper` subclass at `_social_base.py`.
- `lead_platform_presences(platform, profile_url)` unique key — canonical multi-platform lead identity

---

## Known Constraints

### Trustpilot
- Aggressive scrapers get rate-limited — use 2-5s randomized delays
- Pages are JS-rendered — Playwright required (plus playwright-stealth)
- Legacy 3-script chain (`scrape_category.py` → `scrape_profile.py` → `discover_taxonomy.py`); not yet migrated to the plugin pattern

### TripAdvisor
- Direct Playwright is 403'd by Cloudflare — `SCRAPINGBEE_API_KEY` is mandatory, `stealth_proxy` tier only
- Parsing leans on JSON-LD `schema.org/LocalBusiness`; DOM-fallback selectors drift over time
- City fan-out via `tripadvisor_cities` table; a country is only scrapable once seeded. `tripadvisor_country_geo.json` holds the root geo per country (65 countries as of 2026-06-18); a country missing from it errors in the seeder.
- **Seeding (`seed_tripadvisor_cities.py`):** two fetchers via `--fetcher`. `scrapingbee` (paid, server-safe) or **`browser` (FREE)** — a reused **headed** undetected-chromedriver session that clears Cloudflare from the **owner's residential IP** ($0 credits). Headless and curl_cffi are both walled; only headed works. Use slow jittered pacing (`--min-pace`/`--max-pace`, default 5-12s) — TripAdvisor rate-flags the IP at a fast tick (the run aborts cleanly on the "Access is temporarily restricted" wall).
- **Containment is mandatory:** the seeder verifies each candidate via its JSON-LD breadcrumb (`_in_country`) before keeping it. Without it the old seeder harvested continent up-links + "travelers also viewed" cross-promo (Paris on a Malta page) and the `geo_id`-keyed upsert re-tagged shared city rows to the wrong country. **The pre-migration 41-country seed is still polluted this way** — re-seed with the current code (free `browser` fetcher) to clean a country. City-territories (Hong Kong) and pages whose child module doesn't render fall back to seeding the country geo itself.
- **After seeding, refresh the taxonomy** (`python -m tools.scraper.run --platform tripadvisor --action discover-taxonomy`, free/DB-only) — it mirrors seeded `tripadvisor_cities` country codes into `platform_countries`, which is what the Scrape-page Country dropdown reads. Seeded-but-not-refreshed countries won't be selectable. (The refresh paginates the city read — it previously hit PostgREST's 1000-row cap and silently dropped the last-seeded countries.)

### Yelp
- Direct Playwright is 403 (PerimeterX edge). ScrapingBee `stealth_proxy` ONLY reaches `/biz/<slug>` profile pages; `/search` times out 100% (smoke-tested 2026-05-18).
- **Listing**: Yelp Fusion moved to a PAID plan and the trial has expired (returns `400 TRIAL_EXPIRED`), so listing now defaults to a FREE headed-browser `/search` scraper (`YELP_LISTING_SOURCE=browser`, the default). It is **owner-local-only** (headed Chrome + residential IP; cannot run on Cloud Run/EC2). Set `YELP_LISTING_SOURCE=fusion` to use the API again if a paid plan is restored. PerimeterX is aggressive — conservative jittered pacing + hard-block abort (`"Access to this page has been denied"` only; the `perimeterx`/`captcha` SDK strings appear on every successful page, so they are NOT treated as blocks).
- **Profile enrichment** still uses ScrapingBee `stealth_proxy` on `/biz/<slug>` (75 credits/page) — unchanged.
- Country fan-out via `yelp_country_cities.json` (24 markets as of 2026-06-18).

### Social platforms (planned — Facebook, Instagram, FB Groups)
- **Discovery is cookieless via Apify** (`FB_DISCOVERY=apify`, the default) — no account,
  no daily cap, and it runs on Cloud Run and Linux workers because it opens no browser.
  Public groups and open keyword search only; PRIVATE groups still need
  `FB_DISCOVERY=browser` with an account that has joined them.
- **Author enrichment defaults to `FB_ENRICH=stub`** — leads are built from the search
  result, no profile visits. Set `FB_ENRICH=browser` only when a campaign needs
  bio/website/email, and expect it to consume account quota.
- **Open-feed keyword search is ad-heavy.** The Gemini consumer classifier is the gate;
  measure qualified yield before scaling Apify spend.
- **Both community group actors are non-functional (live-tested 2026-08-03).**
  `scrapeforge/facebook-search-posts` `search_type=groups` returns 0 items even for a
  deliberately broad one-word query; `data-slayer/facebook-group-posts` returns 0 items
  even for its own documented default input. `search_type=posts` (open-feed) works fine —
  20 real posts in the same test. **Apify discovery is therefore open-feed in practice**,
  regardless of `groups_only`: the code still attempts group discovery first (actor IDs
  stay env-swappable via `APIFY_FB_SEARCH_ACTOR`/`APIFY_FB_GROUP_POSTS_ACTOR` for if a
  working group actor turns up), but an empty result now emits `apify_groups_unavailable`
  (actor id + reason) and falls back to the open-feed search automatically instead of
  silently returning 0 leads. Private/group-scoped work still needs `FB_DISCOVERY=browser`.
  Query phrasing dominates yield: geo-stuffed phrasings like "looking for a plumber in
  Manchester" returned 0 usable results out of 20 (all adverts), while intent phrasings
  like "need a plumber recommendation" returned real consumer asks — the biggest lever on
  cost per lead.
- Engagement (opening a lead's post, commenting, DMs) still requires a logged-in
  account and stays on the browser path.
- Login required — each connected account stored in `social_accounts` (planned) with encrypted cookies + status (`active` / `checkpoint` / `banned`)
- Per-account daily caps + residential proxies + undetected-chromium to avoid bans
- Captcha checkpoints are routine; the in-app social-account recovery UI (planned) is how operators resolve them
- Lead model includes post authors (DM target) and group admins, not just page owners
- **Instagram (in build):** runs on the Windows EC2 worker ONLY — set `PLATFORM_FILTER=facebook,instagram` there and add `instagram` to the Linux worker's `PLATFORM_EXCLUDE` (IG/Brave is checkpointed on Linux just like FB). Smoke-tested locally first on the owner's residential IP. Uses the shared `tools/scraper/shared/uc_driver.py` opener with `IG_PROFILE_DIR` + mobile UA + `og:description` caption capture + the shared Gemini consumer-intent classifier.

### Email
- ZeroBounce free tier: 100 credits/month; MillionVerifier free: 1000/mo; Hunter free: 50 calls/mo
- Connected mailbox accounts (Gmail OAuth, Bluehost/Titan SMTP, DreamHost, app-password) are all managed in-app via the `email_accounts` table. Personal-provider addresses (Gmail/Yahoo/Outlook/etc.) should be used only as custom-domain aliases — sending bulk cold mail directly from free Gmail inboxes is a spam trap.
- Warmup: start at 10–20 emails/day per account, ramp up over 2–4 weeks. Each account has its own `daily_cap`/`hourly_cap` — respect them per-account, not globally.
- Deliverability requires MX + SPF + DMARC configured on the sending domain. The Email Accounts page shows per-account DNS badges; fix red badges before sending volume.

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
- Don't call any scraping platform (Trustpilot, Yelp, TripAdvisor, …) from the frontend — always go through the API
- Don't bypass the `BasePlatformScraper` contract — every new platform is a subclass + registry entry, not a one-off script
- Don't store emails or API keys in client-side state
- Don't skip the test flight before a live campaign
- Don't commit `.env`, `credentials.json`, or `token.json`
- Don't hardcode timezone strings — use the TIMEZONES list in StepSetup.tsx

---

## Commit Messages

After completing any code change, always output a ready-to-copy commit message following the **Conventional Commits** standard used by Optinet Solutions:

### Format
```
<type>(<scope>): <short summary>

[optional body — one or two sentences explaining WHY, not what]
```

### Types
| Type | When to use |
|------|-------------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `style` | Formatting, whitespace, no logic change |
| `perf` | Performance improvement |
| `docs` | Documentation only |
| `chore` | Build config, deps, tooling, non-production changes |
| `test` | Adding or updating tests |

### Scope examples (this project)
`frontend`, `backend`, `scraper`, `campaigns`, `email`, `leads`, `db`, `auth`, `analytics`, `config`

### Rules
- Summary line: **imperative mood**, lowercase after the colon, no period, max 72 chars
  - ✅ `feat(campaigns): add heavily nested spintax to AI prompt`
  - ❌ `Updated the prompt to use spintax`
- Body: explain the *why* if the change is non-obvious; skip it for trivial changes
- Never reference internal file paths in the summary — describe the behavior change
- Breaking changes: append `!` after the type/scope and add a `BREAKING CHANGE:` footer

### Output format
After every set of changes, output this block at the end of your response (copy-paste ready):

```
---
**Suggested commit:**
\`\`\`
<type>(<scope>): <summary>

<optional body>
\`\`\`
```

---

## End-of-Task Report

When the operator asks for an end-of-task / end-of-day / EOD report (any phrasing), produce **exactly** the block below — plain English, no jargon, no file paths, no SHAs.

**Format**: emit the report inside a single fenced code block (triple backticks) so the operator can copy the whole thing in one click. The two sections — "task for today" and "in progress / pending" — must be visibly separated by a blank line so they're easy to scan.

```
task for today:
- <plain-english outcome, past tense, no tech terms>
- <plain-english outcome>
- ...
- Result: <one-line summary of the net win>
- Still to do next time: <next session's headline item>

in progress / pending:
- <thing the operator still needs to act on themselves>
- <thing the operator still needs to act on themselves>
```

Style rules — match the user's preferred voice:
- Past-tense action verbs: "Built", "Made", "Set up", "Got", "Wired up", "Fixed"
- Outcomes only, not the steps. "Made the scraper grab real post URLs" not "Added _click_share_and_capture function with clipboard CDP grant"
- Number facts when you have them (countries scraped, leads found, time saved) — they make the report feel real
- One sentence per bullet. No bold, no headers inside bullets, no nested lists
- 5-10 bullets max for "task for today". 1-5 for "in progress / pending"
- "task for today" = what got finished (whether you or the operator did it — both count, just stated as outcomes)
- "in progress / pending" = open work the operator still needs to drive: things they personally owe (DNS to paste, decision to make) OR ongoing multi-session work that didn't finish today
- "Result:" + "Still to do next time:" are conventional final lines of "task for today" — include them if there's a clear win and a clear next step
- No closing prose after the block. The fenced block IS the response.

---

## Quick Reference

| Task | Command |
|------|---------|
| Start frontend | `cd frontend && npm run dev` (port 5173) |
| Start API | `cd server && npm run dev` (port 3001) |
| Type-check API | `cd server && npx tsc --noEmit` |
| Type-check frontend | `cd frontend && npx tsc --noEmit` |
| Deploy backend | `powershell -ExecutionPolicy Bypass -Command "cd 'c:/Users/User/Desktop/TRUSPILOT LEAD GEN AND EMAIL OUTREACH'; gcloud run deploy trustpilot-crm --source . --region us-central1 --project=trustpilot-leadgen --quiet"` |
| Run Trustpilot scraper (legacy) | `.venv/Scripts/python.exe tools/scraper/scrape_category.py --country DE --category casino --max-rating 3.5` |
| Run plugin scraper (TripAdvisor/Yelp) | `.venv/Scripts/python.exe tools/scraper/run.py --platform yelp --action list --filters '{"country":"US","category":"plumbers","max_rating":3.5}'` |
| Seed TripAdvisor cities | `.venv/Scripts/python.exe tools/scraper/seed_tripadvisor_cities.py --country US` |
| Run migration 008 | `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sending_schedule jsonb;` (Supabase SQL editor) |

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **TRUSPILOT LEAD GEN AND EMAIL OUTREACH** (1062 symbols, 2238 relationships, 81 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/TRUSPILOT LEAD GEN AND EMAIL OUTREACH/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/TRUSPILOT LEAD GEN AND EMAIL OUTREACH/context` | Codebase overview, check index freshness |
| `gitnexus://repo/TRUSPILOT LEAD GEN AND EMAIL OUTREACH/clusters` | All functional areas |
| `gitnexus://repo/TRUSPILOT LEAD GEN AND EMAIL OUTREACH/processes` | All execution flows |
| `gitnexus://repo/TRUSPILOT LEAD GEN AND EMAIL OUTREACH/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
