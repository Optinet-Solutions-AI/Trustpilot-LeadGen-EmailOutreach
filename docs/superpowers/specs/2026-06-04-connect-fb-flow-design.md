# Connect Facebook flow — cross-host browser hand-off

**Date:** 2026-06-04
**Scope:** tomorrow's session
**Outcome:** an operator clicks "Connect Facebook" in the dashboard, drives a remote Brave session running on the Windows EC2 worker through their own browser, logs in, and the cookies land encrypted in `social_accounts` — without anyone RDP'ing in.

---

## Context — why this is non-trivial

The `POST /api/social-accounts/:id/connect` endpoint already exists and streams login progress via SSE. Today it spawns a Python login flow **locally** on whichever box hosts the API (Cloud Run on Linux for the deployed site, or `localhost:3001` for the operator's laptop).

This breaks for Facebook because:
- Cloud Run is Linux → FB's bot-detection invalidates the session within minutes (proven on 2026-05-30 incident, see `memory/project_fb_login_state_2026-06-01.md`)
- The cookies need to be captured on the **same OS + Brave install + persistent profile directory** that will later scrape with them. That box is the Windows EC2 worker (`i-0a373a528fdf851ff`, region `ap-southeast-1`).
- The operator must SEE and DRIVE the browser (FB shows captcha / 2FA / device-trust steps) — RDP works but won't scale to other operators.

So the connect flow has to: spawn a real browser on the Windows EC2, expose its viewport to the operator's browser as a noVNC frame, capture cookies when login succeeds, and tear everything down.

## Architecture

```
┌──────────────────┐        ┌──────────────────┐        ┌────────────────────────────┐
│ Operator Browser │ ─────▶ │ Cloud Run API    │ ─────▶ │ Windows EC2 Worker         │
│ (dashboard)      │ HTTPS  │ (existing)       │ DB     │ (already polling jobs)     │
│                  │ ◀──── │                  │ poll   │                            │
│  ┌────────────┐  │  SSE  │ writes a row to  │        │ also polls for             │
│  │ noVNC      │  │       │ social_connect_  │        │ social_connect_requests    │
│  │ iframe ◀───┼──┼───────┼──── tunnel URL ──┼────────┼─── spawns Brave + noVNC    │
│  └────────────┘  │       │                  │        │     + cloudflared tunnel   │
└──────────────────┘        └──────────────────┘        └────────────────────────────┘
```

The Cloud Run API never talks directly to the Windows EC2 — the database is the message bus, same pattern as `scrape_jobs`.

## What gets built tomorrow

### Morning block (~3-4 hours)

1. **DB migration** (`044_social_connect_requests.sql`)
   - New table or columns on `social_accounts`:
     - `connect_session_id text` (unique per active connect attempt)
     - `connect_tunnel_url text` (public cloudflared URL the operator embeds)
     - `connect_started_at`, `connect_expires_at` (10-min TTL)
     - `connect_status` enum: `requested` / `provisioning` / `ready` / `captured` / `expired` / `failed`
   - Index on `(platform, connect_status)` so the EC2 worker can claim pending rows.

2. **Cloud Run API change** (`server/src/routes/social-accounts.ts`)
   - `POST /:id/connect` now writes a `connect_status='requested'` row instead of spawning Python.
   - `GET /:id/connect-status` (new) — returns the current connect_status + tunnel URL. The frontend polls this every 2s.
   - SSE endpoint stays but switches to streaming DB row changes instead of subprocess stdout.

3. **EC2 worker — new poll loop** (`server/src/worker/social-connect-worker.ts`)
   - Polls every 10s for `social_connect_requests` rows in `requested` status that match the worker's platform/instance.
   - On claim: marks `provisioning`, runs `scripts/ec2-windows-spawn-noVNC.ps1` which:
     - Creates the operator's profile dir `C:\fb-profiles\<account_id>\` if absent
     - Launches Brave pointing at facebook.com with that profile
     - Starts a noVNC server attached to the Windows session (TightVNC / TigerVNC on Windows)
     - Starts `cloudflared tunnel --url http://localhost:<port>` and captures the assigned `*.trycloudflare.com` URL
     - Updates the row: `connect_status='ready'`, `connect_tunnel_url=<URL>`
   - Watches the Brave profile's Cookies DB for the `c_user` cookie (FB session marker). On first sight: encrypts cookies via shared key, writes to `social_accounts.encrypted_cookies`, sets `connect_status='captured'` + `social_accounts.status='active'`, kills Brave + tunnel + noVNC.

4. **Frontend — modal flow** (`frontend/src/views/SocialAccounts.tsx`)
   - "Connect Facebook" button → POST /connect → opens a modal saying "Provisioning your remote browser…"
   - Polls `/connect-status` until `connect_tunnel_url` is set
   - Embeds the tunnel URL in an `<iframe>` (or opens in a new tab if iframe blocked by FB CSP — likely)
   - Polls again; when `connect_status='captured'`, closes the modal + reloads the accounts list

### Afternoon block (~1-2 hours) — lightweight test pass

Add the smallest possible regression net for the bug class we shipped tonight.

- `tests/scraper/test_facebook_helpers.py`:
  - `test_is_bad_catches_notification_badge` — `_is_bad("(2) Facebook")`, `_is_bad("(15) Facebook")`, `_is_bad("Facebook")` all True; `_is_bad("Brian Kelly")` False.
  - `test_post_url_regex_matches_share_links` — regex catches `/share/p/abc`, `/posts/pfbid123`, `/permalink.php?...`; rejects `/profile.php?id=N`.
  - `test_clean_fb_url_strips_tracking` — keeps `fbid=` + `story_fbid=`; drops `__cft__`, `__tn__`, `ref=`.
- `tests/leads/test_filter_ilike.py` (Python or TS — pick whichever has less setup):
  - Hits the test DB with a `category='dentis'` filter, asserts a lead with `category='dentist'` is returned.
- `package.json` scripts: add `npm run test:scraper` (pytest) and document it in `docs/architecture.md`.

Skip Playwright. Skip frontend snapshot tests. The Python helper tests catch ~80% of the regression class for ~10% of the setup cost.

## Cross-cutting concerns

- **Security**: cloudflared tunnels are public URLs. Anyone with the URL can drive the Brave session. Mitigations: (a) 10-min expiry on `connect_expires_at`; (b) the tunnel URL is only returned to the operator who initiated the request (auth check on `/connect-status`); (c) once cookies are captured, the tunnel + Brave die immediately; (d) the URL is single-use — re-connecting requires a new request.
- **One operator at a time per EC2**: the Windows worker can only host one connect session at a time (single Brave + single noVNC). If a second operator hits Connect FB while one is in progress, their request stays in `requested` status until the first one finishes. UI shows "waiting in queue, position N".
- **Cleanup on failure**: if `connect_expires_at` passes with no capture, the EC2 worker kills Brave + tunnel and marks `connect_status='expired'`. The operator can click Connect FB again to mint a new session.

## What we are NOT building tomorrow

- Per-operator account isolation beyond the existing `FB_PROFILE_DIR` env var (already works)
- Connect Instagram (same flow, but defer until FB is proven)
- Concurrent connect sessions (one at a time is fine for v1)
- Checkpoint recovery via the same flow (it'll reuse this infra later, but the UI hook is a separate session)
- Playwright / full-frontend test harness (afternoon test block is Python-only)

## Verification (end of tomorrow)

1. From a fresh browser (incognito, never RDP'd into EC2), click Connect Facebook on the dashboard.
2. A modal opens, then within ~20s shows the FB login page inside an iframe.
3. Enter credentials, complete 2FA / captcha if prompted.
4. Modal auto-closes within 5s of successful login. The Social Accounts list shows the new account with status `active`.
5. Trigger a scrape from the same operator's session and verify it succeeds using the freshly minted cookies.
6. `pytest tests/scraper/test_facebook_helpers.py` passes.

## Resolved design decisions (locked 2026-06-03 night)

1. **Remote-desktop tool: noVNC.** HTML5-native, zero operator install, runs as a Windows service on the EC2 alongside the existing scraper-worker. ~30 min setup, one-time.
2. **Tunnel: cloudflared quick tunnel.** Single binary on the EC2, auto-generates `*.trycloudflare.com` URL per session, no Cloudflare account / DNS / certs needed. URL is unguessable + 10-min TTL.
3. **Operator UX: new browser tab.** Dashboard opens noVNC URL in a fresh tab; modal shows "complete login in the new tab" with status indicator; tab closes itself when cookies are captured. Avoids iframe / `X-Frame-Options` edge cases. Acceptable context-switch since this is a once-per-account flow.

Estimated tomorrow:
- noVNC + cloudflared install on Windows EC2: ~30 min
- Code (DB poll loop + spawn-noVNC.ps1 + frontend modal + Cloud Run route): ~3 hours
- End-to-end test from fresh incognito browser: ~30 min
- **Total: ~4 hours**
