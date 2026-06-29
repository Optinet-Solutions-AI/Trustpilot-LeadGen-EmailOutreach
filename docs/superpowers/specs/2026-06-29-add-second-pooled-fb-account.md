# Walkthrough — Add a second pooled FB account (the multi-user concurrency unlock)

> Why: today the pool has **one** account (james, GB). The single-occupant browse lock means **one user at a time per account**. `resolvePoolAccountForCountry` already spreads users across a country's accounts — it just needs more accounts to spread to. Adding a 2nd GB account = two people can work GB leads at once.

---

## ⚠️ Read first — ban risk on the current setup
The EC2 worker runs on a **Singapore datacenter IP** with no residential proxy or per-account fingerprint isolation yet (that's **Phase 1**, not built). A second FB account logged in on the **same IP + machine fingerprint** as james is a textbook correlation signal — Facebook may checkpoint it (and possibly james) quickly. The "100% automated" tooling you sent works precisely because each account gets its **own residential IP + isolated browser fingerprint** (antidetect browser).

So treat this in two modes:
- **Mode A — prove the mechanic (OK now):** add one extra account just to confirm two users route to two different accounts and don't collide. Expect it may checkpoint; use it only for the routing test, not sustained outreach.
- **Mode B — real multi-user (do Phase 1 first):** residential proxy + fingerprint isolation per account, then add accounts. Don't run several accounts on the shared datacenter IP for production.

---

## Prerequisites
- A **real, aged** Facebook account (not freshly created — new accounts checkpoint instantly). Have its login + password.
- The EC2 worker running with `BROWSE_STREAM=cdp` (for the connect/login stream) and reachable.
- `CRM_ACCOUNT_ENCRYPTION_KEY` set (already is) — for storing the account's credentials encrypted.

---

## Steps (via the Social Accounts page — the supported path)

1. **Create the account row.** Social Accounts → Add account:
   - `platform` = `facebook`
   - `handle` = the account's login email / identifier
   - `country` = **`GB`** (must match the leads you want concurrency for — the pool resolver keys on this)
   - `comment_daily_cap` = **1–3** (start low — warmup), `daily_cap`/`hourly_cap` conservative
   - (API equivalent: `POST /api/social-accounts` with `{platform,handle,country,daily_cap,hourly_cap,comment_daily_cap}`)

2. **Store credentials (optional but convenient).** PATCH the account with `fb_username` / `fb_password` — they're AES-encrypted server-side (`encrypted_fb_username/password`); the UI only ever shows `has_credentials: true`. Enables autofill during connect.

3. **Connect it (the critical step).** Click **Connect** on the new account → `POST /api/social-accounts/:id/connect` → the worker opens a noVNC/streamed browser on EC2 → **log the account in by hand** (solve any captcha). On success the worker captures cookies and flips `status = active`. This binds the session to the EC2 profile (`<FB_PROFILES_ROOT>/<accountId>`).
   - Poll `GET /api/social-accounts/:id/connect-status` until `captured`/`active`.

4. **Verify it's in the pool.** Confirm in the list: `status = active`, `country = GB`, `connect_status` not `expired`. Now the GB pool has **2** active accounts.

---

## Test that two users actually get different accounts
The clean proof of the pool-spread:

1. Open **two** browser sessions (or two people) on the live app.
2. Each opens a **different GB lead** with an FB post → clicks **"Open as James (hosted)"**.
3. Expected: **each resolves to a different account** (the pool resolver prefers the lower `comment_used_today` and skips the one already busy in a browse session). Neither gets a 409 "in use."
4. Confirm in Cloud Run logs — two `[leads/browse] … account=<A>` and `… account=<B>` lines with **different** account ids.

If both land on the same account / one gets 409, check both accounts are `active` + same `country`, and neither is stuck `connect_status` busy.

> Note on the *same* lead: if two users open the **same** lead that has a bound capturing account, both resolve to that one account (one-lead-one-account) and the second gets "in use" — that's intended. Concurrency is across *different* leads/accounts.

---

## After the test
- For sustained multi-user, schedule **Phase 1** (residential proxy via plain `--proxy-server` + per-account fingerprint isolation) before adding more accounts — otherwise the datacenter-IP correlation will checkpoint them.
- Per-user attribution ("in use by <name>") stays cosmetic until the app gets **real per-user login** (today: single shared API key). Decide that separately before opening the URL to less-trusted users.
