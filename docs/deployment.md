# Deployment Guide

## Architecture

- **Frontend** → Vercel (React/Vite SPA, auto-deploy on push to `main`)
- **API + Scrapers** → Google Cloud Run (`trustpilot-crm`, us-central1)
- **Database** → Supabase (cloud-hosted PostgreSQL)
- **Email Platform** → Instantly.ai (third-party, configured via env vars)

**Service URL:** `https://trustpilot-crm-281469818025.us-central1.run.app`  
**Frontend URL:** `https://trustpilot-lead-gen-email-outreach.vercel.app`

---

## 1. Deploy API to Google Cloud Run

**Source-based deploy — no local Docker needed:**

```bash
powershell -ExecutionPolicy Bypass -Command "cd 'c:/Users/User/Desktop/TRUSPILOT LEAD GEN AND EMAIL OUTREACH'; gcloud run deploy trustpilot-crm --source . --region us-central1 --quiet"
```

This builds in Cloud Build using the repo's `Dockerfile` and deploys atomically.

**Update env vars only (no code rebuild):**

```bash
powershell -ExecutionPolicy Bypass -Command "gcloud run services update trustpilot-crm --region us-central1 --update-env-vars 'KEY=VALUE' --quiet"
```

> ⚠️ Never use `--env-vars-file` — it replaces ALL env vars and wipes credentials.

---

## 2. Deploy Frontend to Vercel

**Automatic** — every `git push origin main` triggers a Vercel build and deploy. No manual action needed.

Env vars must be set in the **Vercel Dashboard** (they're baked into the build):

| Variable | Value |
|----------|-------|
| `VITE_API_BASE_URL` | `https://trustpilot-crm-281469818025.us-central1.run.app` |
| `VITE_API_SECRET_KEY` | Value of `API_SECRET_KEY` on Cloud Run |
| `VITE_GEMINI_API_KEY` | Google Gemini API key |

---

## 3. Standard Workflow

```bash
# 1. Make code changes
git add <files>
git commit -m "your message"
git push origin main          # Vercel auto-deploys frontend

# 2. Deploy backend
powershell -ExecutionPolicy Bypass -Command "cd 'c:/Users/User/Desktop/TRUSPILOT LEAD GEN AND EMAIL OUTREACH'; gcloud run deploy trustpilot-crm --source . --region us-central1 --quiet"
```

Deployment takes ~3-5 minutes. Watch for the final line:
```
Service [trustpilot-crm] revision [trustpilot-crm-XXXXX] has been deployed and is serving 100 percent of traffic.
```

---

## 4. Cloud Run Environment Variables

Current env vars set on `trustpilot-crm`:

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase server-side key |
| `EMAIL_MODE` | `gmail` or `mock` (fallback for test flights) |
| `EMAIL_PLATFORM` | `instantly`, `none`, or `mock` |
| `INSTANTLY_API_KEY` | Instantly.ai API key |
| `INSTANTLY_SENDING_ACCOUNTS` | Comma-separated sending emails (e.g. `jordi@optiratesolutions.com`) |
| `INSTANTLY_SYNC_INTERVAL` | Stats poll interval ms (default: 120000) |
| `GOOGLE_CLIENT_ID` | Gmail OAuth2 client ID |
| `GOOGLE_CLIENT_SECRET` | Gmail OAuth2 client secret |
| `GOOGLE_REFRESH_TOKEN` | Gmail OAuth2 refresh token |
| `EMAIL_FROM` | Sender address for Gmail fallback |
| `EMAIL_FROM_NAME` | Display name (e.g. `OptiRate`) |
| `EMAIL_TEST_MODE` | `true` = redirect all Gmail sends to `TEST_EMAIL_ADDRESS` |
| `TEST_EMAIL_ADDRESS` | Safe address for Gmail test redirects |
| `EMAIL_DAILY_CAP` | Max emails/day via Gmail (default: 50) |
| `EMAIL_HOURLY_CAP` | Max emails/hour via Gmail (default: 20) |
| `PLAYWRIGHT_HEADLESS` | `true` in production |
| `PYTHON_PATH` | `/usr/bin/python3` |

---

## 5. Supabase Migrations

Run these in order in the **Supabase SQL Editor**:

```
supabase/migrations/001_initial_schema.sql    ← core 6 tables
supabase/migrations/002_*.sql                 ← indexes + triggers
supabase/migrations/003_gmail_tracking.sql    ← gmail_message_id, gmail_thread_id
supabase/migrations/004_screenshot.sql        ← screenshot_path on leads
supabase/migrations/005_spintax.sql           ← template engine updates
supabase/migrations/006_email_platform.sql    ← platform_campaign_id, email_platform on campaigns
supabase/migrations/007_campaign_steps.sql    ← follow-up steps table
supabase/migrations/008_sending_schedule.sql  ← sending_schedule jsonb on campaigns
```

> **Migration 008** may still need to be run:
> ```sql
> ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sending_schedule jsonb;
> ```

---

## 6. Instantly.ai DNS Setup (Required Before Sending)

Before `jordi@optiratesolutions.com` can send through Instantly, add these records in **Dreamhost DNS** for `optiratesolutions.com`:

| Type | Name | Value |
|------|------|-------|
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:jordi@optiratesolutions.com` |
| TXT | `selector._domainkey` | Copy from Instantly → Email Accounts → click the account |
| TXT | `@` | `v=spf1 include:spf.instantlyapp.com ~all` |

DNS propagation: 15–60 minutes. Instantly will show green status once all 3 are detected.

---

## 7. Local Development

```bash
# Terminal 1 — Frontend
cd frontend && npm run dev     # http://localhost:5173

# Terminal 2 — API
cd server && npm run dev       # http://localhost:3001

# Type-check (run before deploying)
cd server && npx tsc --noEmit
cd frontend && npx tsc --noEmit
```
