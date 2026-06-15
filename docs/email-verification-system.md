# Email Verification System

How leads get an `email_verified` / `verification_status` verdict before they're allowed into a campaign. This document covers **what we use**, **how the ladder decides**, and **how to set it up**.

> Sibling doc: [`email-sending-system.md`](./email-sending-system.md) (how mail goes out). This one is purely about *validating addresses before* they're sendable.

---

## TL;DR — What We're Using

A **7-stage layered validator** that runs free local checks first and only spends money on the hard cases. Source of truth: [`server/src/services/email-validator/index.ts`](../server/src/services/email-validator/index.ts).

| # | Stage | Cost | Module | Fires when |
|---|-------|------|--------|-----------|
| 1 | Syntax | free, instant | `syntax-check.ts` | always |
| 2 | DNS / MX | free, ~100ms | `dns-check.ts` | syntax OK |
| 3 | Catch-all probe (per-domain, cached 7d) | free, ~3s | `catch-all-probe.ts` | has MX, not a "giant" |
| 4 | SMTP RCPT-TO probe (per-address) | free, ~3s | `smtp-probe.ts` | not catch-all, not a "giant" |
| 5 | **ZeroBounce** (primary paid) | paid | `email-verifier.zerobounce.ts` | stack returned `unknown` |
| 6 | **MillionVerifier** (Tier 2) | paid | `email-verifier.millionverifier.ts` | ZB `unknown` **and** key set |
| 7 | **Hunter.io** (Tier 3, last resort) | paid | `email-verifier.hunter.ts` | ZB **and** MV `unknown`, key set |

**The "no guessing" rule:** a `valid` verdict requires positive proof (an SMTP `250` on a non-catch-all domain, or a cloud verifier explicitly returning valid). Catch-all domains are labelled `catch-all`, never `valid`. Anything inconclusive stays `unknown` — it is never silently upgraded.

**Final verdict is always one of four:** `valid` · `invalid` · `catch-all` · `unknown`.

---

## Why a Ladder (and why paid verifiers are last)

Stages short-circuit on a definitive answer, so most leads never reach a paid API:

- Bad syntax / no MX → `invalid` for free at stage 1–2.
- A domain that accepts every address → `catch-all` for free at stage 3 (and the answer is cached per-domain for 7 days, so the whole domain costs one probe).
- A clean cPanel/custom mailbox → `valid` or `invalid` for free at stage 4 via a raw SMTP `RCPT TO` (we run `HELO → MAIL FROM → RCPT TO → QUIT`, never `DATA`).

Only the leftover `unknown` cases — greylisted hosts, throttled MX, and the **giants** (Google Workspace / Outlook 365, which `250` every address so a probe verdict would be a guess) — fall through to ZeroBounce, then MillionVerifier, then Hunter.

> ⚠️ **Cloud Run blocks outbound port 25.** Stage 4's SMTP probe returns `error`/`unknown` in production, so in the deployed service **ZeroBounce is effectively the workhorse**. Stage 4 only pays off when verification runs from a host with port 25 open (e.g. a local box or the EC2 worker). This is by design — the orchestrator treats a blocked probe as `unknown` and falls through.

---

## Provider Verdict Mapping

Each provider returns its own taxonomy; we map conservatively onto our 4-value status. Never upgrade to `valid` without explicit proof.

### ZeroBounce (`mapStatus` in `email-verifier.zerobounce.ts`)
- `valid` → **valid** · `invalid` → **invalid** · `catch-all` → **catch-all**
- `spamtrap`, `abuse` → **invalid** (genuine landmines)
- `toxic` → **unknown** (reputation flag, not mailbox-existence proof)
- `do_not_mail` → **catch-all**, *except* sub-status `global_suppression` / `possible_trap` → **invalid**
- everything else → **unknown**

### MillionVerifier (`email-verifier.millionverifier.ts`)
- `ok` → **valid** · `invalid` → **invalid** · `catch_all` → **catch-all**
- `disposable` → **unknown** (domain flag, not a dead-mailbox proof — keep the lead selectable)
- `unknown` / `error` / blank → **unknown**
- Strongest on relay/forwarder domains (ImprovMX, ForwardEmail) where ZB data is sparse.

### Hunter.io (`email-verifier.hunter.ts`)
Hunter splits the answer across `status` and `result`:
- `status=invalid` **or** `result=undeliverable` → **invalid**
- `status=accept_all` → **catch-all**
- `status=valid` **and** `result=deliverable` → **valid**
- everything else (risky, webmail, disposable, unknown) → **unknown**
- **Skips free-webmail domains** (gmail/yahoo/outlook/…) entirely — the call adds nothing and burns a credit. Enforces a per-process hourly cap.

---

## Configuration (Environment Variables)

| Variable | Required? | Default | Purpose |
|----------|-----------|---------|---------|
| `ZEROBOUNCE_API_KEY` | **Yes** (for any paid fallback) | — | Stage 5 primary verifier. Free tier: **100 credits/mo**. https://zerobounce.net |
| `MILLIONVERIFIER_API_KEY` | Optional | unset → stage skipped | Stage 6 (Tier 2). Free tier: **1,000 credits**. https://app.millionverifier.com |
| `HUNTER_API_KEY` | Optional | unset → stage skipped | Stage 7 (Tier 3). Free tier: **50 calls/mo**. Also powers Tier-9 domain-search enrichment. https://hunter.io |
| `HUNTER_MAX_CALLS_PER_HOUR` | Optional | `20` | Per-process hourly cap on Hunter *verify* calls |
| `HUNTER_MAX_DOMAIN_SEARCHES_PER_HOUR` | Optional | `15` | Per-process hourly cap on Hunter *enrichment* domain searches |
| `SMTP_PROBE_HELO` | Optional | `optiratesolutions.com` | HELO domain for the stage-4 probe — must be a real domain we own |
| `SMTP_PROBE_FROM` | Optional | `verify@optiratesolutions.com` | MAIL FROM for the stage-4 probe — any deliverable address on the HELO domain |

All three verifier keys are **env-gated**: if a key is unset that stage silently no-ops, so the system ships safely and you can add keys later without a redeploy (Cloud Run picks them up on the next request).

---

## Setup Steps

1. **ZeroBounce (mandatory for the paid fallback).** Sign up, grab the API key, set `ZEROBOUNCE_API_KEY`. Without it, stages 5–7 never run and giants/greylisted hosts stay `unknown`.
2. **(Optional) MillionVerifier** — sign up for the free 1,000 credits, set `MILLIONVERIFIER_API_KEY`. Recommended if you scrape a lot of forwarder/relay domains.
3. **(Optional) Hunter** — set `HUNTER_API_KEY`. Tightly capped by default; raise `HUNTER_MAX_CALLS_PER_HOUR` only after upgrading the plan.
4. **SMTP probe identity** — point `SMTP_PROBE_HELO` / `SMTP_PROBE_FROM` at a domain you own with valid DNS. Only matters on hosts with port 25 open.
5. **Run migration 019** ([`supabase/migrations/019_layered_verification.sql`](../supabase/migrations/019_layered_verification.sql)) — creates the `domain_email_intel` cache table and the per-stage audit columns on `leads`.
6. **Deploy / set env on Cloud Run** (no rebuild needed for env-only changes):
   ```powershell
   powershell -ExecutionPolicy Bypass -Command "gcloud run services update trustpilot-crm --region us-central1 --project=trustpilot-leadgen --update-env-vars 'ZEROBOUNCE_API_KEY=xxx' --quiet"
   ```

---

## Database Footprint (migration 019)

**`domain_email_intel`** — one row per email domain, caches the expensive bits:
- `domain` (PK), `mx_top`, `provider_type` (`google_workspace` / `outlook365` / `cpanel_or_other`), `is_catch_all`, `checked_at`
- Catch-all result reused for 7 days, so every lead on the same domain costs one probe.

**`leads`** audit columns (read-only trail for the UI tooltip; authoritative verdict still lives on `verification_status` / `*_email_status`):
- `verify_syntax_ok`, `verify_mx_ok`, `verify_smtp_result`, `verify_zerobounce_result`, `verify_live_probe_result`, `verified_at`

---

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/verify` | POST | Start a batch verify job. Body: `{ leadIds?: string[], emailField?: 'trustpilot'\|'website'\|'affiliate'\|'all' }`. Omit `leadIds` to verify all `email_verified=false` leads. Already-valid leads are skipped. |
| `/api/verify/status?jobId=…` | GET | Polling fallback for job progress |
| `/api/verify/:jobId/stream` | GET (SSE) | Live per-stage progress stream |
| `/api/verify/domain-intel?domain=…` | GET | Read cached domain intel |
| `/api/verify/sync` | POST | Inline re-verify (wizard "click an invalid lead"). Capped at **5 leads/call**; re-verifies all sources, recomputes `primary_email`, writes a verification note. |

Batching: domains run in parallel, addresses within a domain run serially (to avoid hammering one MX). ZeroBounce uses its batch endpoint (100/request).

---

## Lead-Level Status Resolution

A lead has multiple email sources (`trustpilot_email`, `website_email`, `affiliate_email`, `discovered_email`). Each gets its own `*_email_status`. The lead-level `verification_status` and `primary_email` are then resolved by `resolvePrimaryEmail` / `statusForPrimaryEmail` ([`server/src/services/email/resolve-primary-email.ts`](../server/src/services/email/resolve-primary-email.ts)) — the lead-level status **mirrors the source the resolver actually picked** (not a blanket worst-of), so a `TP=invalid + website=valid` lead correctly shows `valid` for its chosen address.

---

## Local / One-Off Batch Helpers (Python)

Because Cloud Run blocks port 25, large historical backfills are run locally where the SMTP probe works, or directly against ZB/Hunter:

| Script | Purpose |
|--------|---------|
| [`tools/scraper/verify_pending_zb.py`](../tools/scraper/verify_pending_zb.py) | ZeroBounce-verify pending leads |
| [`tools/scraper/verify_pending_hunter.py`](../tools/scraper/verify_pending_hunter.py) | Hunter-verify pending leads (webmail pre-mapped to catch-all to save credits) |
| [`tools/scraper/verify_primary_email_batch.py`](../tools/scraper/verify_primary_email_batch.py) | Verify `leads.primary_email` directly against whichever source produced it |

These are operator helpers, not part of the live request path.
