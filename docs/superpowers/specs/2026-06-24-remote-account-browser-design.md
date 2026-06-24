# Remote "Open Account's Browser" — interactive streamed session

**Date:** 2026-06-24
**Status:** Approved (design) — ready for implementation plan
**Author:** Agent (brainstormed with operator)

---

## Problem

When a user opens a lead's Facebook link, it opens in **their own browser** (their personal FB cookies) — not the shared business account. The team needs to **view and act on Facebook as a shared, integrated account (james, and future country accounts)** without each user logging in, without exposing the account's credentials to every machine, and without getting the account flagged.

You can't make a normal link open as james (a browser uses the clicker's own cookies), and injecting the account's cookies into each user's local browser would (a) leak the credentials onto every machine and (b) run the account from many different IPs/devices — the exact pattern FB bans. The safe answer is a **remote browser**: the account's browser runs **centrally on the worker** (correct IP/proxy/session) and is **streamed** to the user, who sees only pixels.

## Goal

A user clicks a button and gets a live, **already-logged-in** browser for a chosen social account, streamed into the app — to manually browse, comment, DM, or engage **as that account**. The account's session stays central; the user never holds its cookies; the account stays on one consistent IP. One user per account at a time.

## Key insight: this is a `browse` mode on the existing connect flow

The **connect flow** (spec `2026-06-04-connect-fb-flow-design.md`) already implements the hard parts: app writes a row → EC2 Windows worker (`social-connect-worker.ts`) claims it → `scripts/ec2-windows-spawn-noVNC.ps1` spawns Brave + a noVNC server + a `cloudflared` tunnel → the tunnel URL is streamed into the app → teardown. The DB is the message bus (same pattern as `scrape_jobs`).

This feature adds a **`mode`** to that machinery:

| | `mode='connect'` (exists) | `mode='browse'` (new) |
|---|---|---|
| Profile | fresh/empty → capture login | the account's **existing logged-in** profile (`C:\fb-profiles\<account_id>`) |
| Purpose | capture cookies once | interactive work as the account |
| Landing page | facebook.com login | deep-link target URL (a lead's post) or facebook.com |
| Ends on | cookies captured | user "End session" or idle TTL |
| Cookie capture | yes | no (already logged in; profile just stays warm) |

## Non-Goals (YAGNI)

- Multiple users co-driving one session.
- Session recording / playback.
- Mobile / touch.
- Auto-actions inside the remote browser (it's manual; automated actions stay in the server-side scrape/comment paths).

---

## Components & data flow

```
User clicks "Open browser"  ──▶  App API writes browse-session row (mode=browse, account_id, target_url, requested_by)
                                        │ DB is the bus
                                        ▼
EC2 Windows worker polls ──▶ claims (respecting the per-account lock) ──▶ spawn-noVNC.ps1:
   - launch Brave with C:\fb-profiles\<account_id>  (already logged in)  at target_url (or facebook.com)
   - start VNC + noVNC + cloudflared tunnel
   - write tunnel_url + status='active'
                                        ▼
App polls status ──▶ streams tunnel_url to the user (new tab; iframe likely blocked by FB CSP)
                                        ▼
User works as the account.  "End session" (or idle TTL) ──▶ worker kills Brave + tunnel + noVNC, releases lock.
```

### 1. Data model
Reuse the connect-request fields where possible; add the minimum new ones (new columns on `social_connect_requests` or `social_accounts`, decided in the plan):
- `mode` — `'connect' | 'browse'`.
- `target_url` — deep-link the browse session opens at (nullable → facebook.com).
- `requested_by` — the CRM user who holds the session (for the "in use by X" message + access gating).
- Reuse: `connect_session_id`, `connect_tunnel_url`, `connect_status` (`requested`/`provisioning`/`active`/`ended`/`expired`/`failed`), `connect_started_at`, `connect_expires_at`.

### 2. Per-account single-occupant lock
A `browse` request for an account that already has a session in `requested`/`provisioning`/`active` is rejected with `409 { error: "in use by <requested_by> until <expires>" }` (no second session for the same account). Different accounts run independently. The lock is the existence of a non-terminal session row for that `account_id`.

### 3. Triggers (both)
- **Lead detail → "Open in James's browser"** — visible for FB-presence leads; sends `mode=browse, account_id=<resolved by lead country>, target_url=<lead post_url>`. Reuses the Phase-2 `resolveLeadAccount` logic (the lead's own country-pinned account) so it opens the *right* account.
- **Social Accounts → "Open session"** — per account row; sends `mode=browse, account_id, target_url=null`.

### 4. EC2 worker (`social-connect-worker.ts` + `ec2-windows-spawn-noVNC.ps1`)
Extend the existing poller/script to handle `mode=browse`: launch Brave on the **existing** profile at `target_url`, skip the cookie-capture watcher, and instead watch for the `ended`/`expired` signal to tear down. Idle TTL auto-kills (default 20 min). On teardown, the profile persists (keeps the account warm for scraping).

### 5. Frontend (`SocialAccounts.tsx` + lead detail)
- A launch button (both places) → POST → poll status → when `connect_tunnel_url` set, **open in a new tab** (FB blocks iframing via CSP — open a window/tab; fall back to a "click to open" link).
- A small "session active — End session" indicator while held.
- Surface the `409 in use` message.

### 6. Security
- The user sees a **pixel stream only** (noVNC); the account's cookies never reach their machine.
- The tunnel URL is short-lived (session TTL) and tied to the holding session/user.
- Reuses the connect flow's existing trust model (cloudflared ephemeral tunnel).

---

## Error handling
- No worker available / spawn fails → `connect_status='failed'`, surface "couldn't start the remote browser — try again."
- Account session stale (Brave opens to a login page instead of logged-in) → detect (URL contains `/login`), mark `failed` with "account needs re-connect (run Connect first)."
- Idle TTL / user closes tab without "End session" → worker idle-kill releases the lock so the account isn't stuck locked.

## Testing
- **Unit:** the per-account lock (reject second active session); request lifecycle state transitions; `resolveLeadAccount` deep-link wiring (reuse existing).
- **Integration:** API creates a browse row; worker claim respects the lock.
- **Manual smoke (EC2):** open james's browser from a lead → lands on the post, logged in as james → comment manually → "End session" tears down + releases lock. (Mirrors the connect-flow smoke.)

## Rollout
- Single account (james) first → effectively one global lock. Validates the whole path.
- Scales to the fleet automatically (per-account lock → N accounts = N concurrent sessions).
- Depends on: james's session connected on the worker (the existing connect flow), and the worker reachable.

## Risks / notes
- **Single session per account** is a hard FB constraint (can't co-drive one login) — the lock enforces it; with one account, only one user at a time. The fleet relieves this.
- **noVNC latency** over cloudflared is fine for click/type, not video — acceptable for FB work.
- This is **manual** browsing; it does NOT replace the server-side scrape/comment automation (which scales without a human). It's for point-and-click work as the account.
