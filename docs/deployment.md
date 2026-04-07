# Deployment Guide

## Architecture

- **Frontend** → Vercel (static React build)
- **API Gateway** → Google Cloud API Gateway (public HTTPS endpoint: `https://trustpilot-gateway-3lazv1k9.uc.gateway.dev`)
- **API + Scrapers** → Google Cloud Run (private, only accessible via API Gateway)
- **Database** → Supabase (already cloud-hosted)

> **Why API Gateway?** The `optinetsolutions.com` GCP org has an IAM policy (`iam.allowedPolicyMemberDomains`) that blocks granting `allUsers` direct invoker access to Cloud Run. API Gateway sits in front of Cloud Run: it accepts public HTTPS traffic, then authenticates to Cloud Run using a dedicated service account (`trustpilot-gateway-sa`). This satisfies the org policy while keeping the API publicly accessible.

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
  --image us-central1-docker.pkg.dev/trustpilot-leadgen/trustpilot/api:latest \
  --platform managed \
  --region us-central1 \
  --no-allow-unauthenticated \
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
PYTHON_PATH=/usr/bin/python3"
```

**Important Cloud Run settings:**
- `--no-allow-unauthenticated` — Cloud Run is private; traffic comes only from API Gateway
- Memory: minimum 2Gi (Playwright Chromium needs headroom)
- Timeout: 3600s (scrape jobs can take 10-30 min)
- Concurrency: 10 (low — each scrape spawns a browser)

### API Gateway (already deployed — no action needed)

The API Gateway is live at: `https://trustpilot-gateway-3lazv1k9.uc.gateway.dev`

- **Managed API:** `trustpilot-managed-api`
- **Config:** `trustpilot-config-v1`
- **Gateway:** `trustpilot-gateway` (us-central1)
- **Service Account:** `trustpilot-gateway-sa@trustpilot-leadgen.iam.gserviceaccount.com`

If you need to update the gateway spec (e.g. add new routes):

```bash
# Create new config version
gcloud api-gateway api-configs create trustpilot-config-v2 \
  --api=trustpilot-managed-api \
  --openapi-spec=path/to/api-gateway-spec.yaml \
  --backend-auth-service-account=trustpilot-gateway-sa@trustpilot-leadgen.iam.gserviceaccount.com \
  --project=trustpilot-leadgen

# Update gateway to new config
gcloud api-gateway gateways update trustpilot-gateway \
  --api=trustpilot-managed-api \
  --api-config=trustpilot-config-v2 \
  --location=us-central1 \
  --project=trustpilot-leadgen
```

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
| `NEXT_PUBLIC_API_BASE_URL` | `https://trustpilot-gateway-3lazv1k9.uc.gateway.dev` (API Gateway URL) |
| `NEXT_PUBLIC_API_SECRET_KEY` | Your `API_SECRET_KEY` value (same as set on Cloud Run) |
| `NEXT_PUBLIC_GEMINI_API_KEY` | Your Google Gemini API key |

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
cd server && npm run dev          # http://localhost:3001

# Terminal 3 — Test a scrape manually
.venv/Scripts/python.exe tools/scraper/scrape_category.py \
  --country DE --category casino --max-rating 3.5 \
  --output .tmp/test_raw.json
```

---

## 7. Re-deploy After Changes

```bash
# Rebuild and redeploy API
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/trustpilot-leadgen/trustpilot/api:latest \
  --region us-central1

gcloud run deploy trustpilot-api \
  --image us-central1-docker.pkg.dev/trustpilot-leadgen/trustpilot/api:latest \
  --region us-central1 \
  --no-allow-unauthenticated

# Frontend re-deploys automatically via Vercel GitHub integration on push

# API Gateway only needs updating if routes change — see section 2 above
```
