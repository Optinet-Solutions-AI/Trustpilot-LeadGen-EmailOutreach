# Deployment Guide

## Architecture

- **Frontend** → Vercel (static React build)
- **API + Scrapers** → Google Cloud Run (Docker container: Node 20 + Python 3.11 + Playwright)
- **Database** → Supabase (already cloud-hosted)

---

## 1. Prerequisites

- Google Cloud project: `trustpilot-leadgen`
- Vercel account connected to GitHub
- Supabase project with schema applied (`supabase/migrations/001_initial_schema.sql`)
- GitHub repo with code pushed

---

## 2. Deploy API to Google Cloud Run

### Build and push the Docker image

```bash
# Authenticate
gcloud auth login
gcloud config set project trustpilot-leadgen

# Build and submit to Cloud Build (builds in cloud, no local Docker needed)
gcloud builds submit \
  --tag gcr.io/trustpilot-leadgen/trustpilot-api \
  --timeout=20m
```

### Deploy to Cloud Run

```bash
gcloud run deploy trustpilot-api \
  --image gcr.io/trustpilot-leadgen/trustpilot-api \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 2 \
  --timeout 3600 \
  --concurrency 10 \
  --set-env-vars "\
SUPABASE_URL=https://your-project.supabase.co,\
SUPABASE_SERVICE_ROLE_KEY=your-key,\
API_SECRET_KEY=your-secret,\
EMAIL_MODE=mock,\
PLAYWRIGHT_HEADLESS=true,\
PYTHON_PATH=/usr/bin/python3,\
PORT=8080"
```

**Important Cloud Run settings:**
- Memory: minimum 2Gi (Playwright Chromium needs headroom)
- Timeout: 3600s (scrape jobs can take 10-30 min)
- Concurrency: 10 (low — each scrape spawns a browser)

### Get the Cloud Run URL

```bash
gcloud run services describe trustpilot-api \
  --region us-central1 \
  --format 'value(status.url)'
```

Save this URL — you need it for Vercel.

---

## 3. Deploy Frontend to Vercel

### Setup

1. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub
2. Select your repo
3. **Framework Preset:** Vite
4. **Root Directory:** `frontend`
5. **Build Command:** `npm run build`
6. **Output Directory:** `dist`

### Environment Variables (Vercel Dashboard)

| Variable | Value |
|----------|-------|
| `VITE_API_BASE_URL` | `https://trustpilot-api-xxx-uc.a.run.app` (your Cloud Run URL) |
| `VITE_GEMINI_API_KEY` | Your Google Gemini API key |

---

## 4. Supabase Setup

Run this once in Supabase SQL Editor:

```sql
-- Run the full migration file:
-- supabase/migrations/001_initial_schema.sql
```

Enable Row Level Security if needed (currently using service role key which bypasses RLS).

---

## 5. Switching to Live Email Mode

Once ready to send real emails:

1. Get a Resend API key at resend.com
2. Get a ZeroBounce key at zerobounce.net
3. Update Cloud Run env vars:

```bash
gcloud run services update trustpilot-api \
  --region us-central1 \
  --update-env-vars "\
EMAIL_MODE=live,\
RESEND_API_KEY=re_your-key,\
ZEROBOUNCE_API_KEY=your-key,\
EMAIL_FROM=outreach@yourdomain.com"
```

---

## 6. Local Development

```bash
# Terminal 1 — Frontend
cd frontend && npm run dev     # http://localhost:5173

# Terminal 2 — API
cd api && npm run dev          # http://localhost:3001

# Terminal 3 — Test a scrape manually
.venv/Scripts/python.exe tools/scraper/scrape_category.py \
  --country DE --category casino --max-rating 3.5 \
  --output .tmp/test_raw.json
```

---

## 7. Re-deploy After Changes

```bash
# Rebuild and redeploy API
gcloud builds submit --tag gcr.io/trustpilot-leadgen/trustpilot-api
gcloud run deploy trustpilot-api \
  --image gcr.io/trustpilot-leadgen/trustpilot-api \
  --region us-central1

# Frontend re-deploys automatically via Vercel GitHub integration on push
```
