# FB Account Onboarding Wizard — Design Spec

**Date:** 2026-08-14
**Status:** Draft for review
**Author:** brainstormed with the operator (internal-tool fleet track)

## Motivation

Today, adding a Facebook account to the fleet is a technical, hands-on job:
create an AdsPower profile in the desktop GUI, wire a country proxy, log into
Facebook, and hand-edit a `social_accounts` row. Only the operator can do it,
and only by RDP-ing into the EC2 box.

The goal: a **non-technical VA**, working entirely inside the Vercel web app,
can add a country-pinned Facebook account in a few clicks — pick a country, log
into Facebook in a streamed browser (clearing any captcha there), click Done —
and that country then becomes selectable for Facebook scraping. No RDP, no
AdsPower desktop, no SQL.

This unlocks the fleet's supply story: the **fresh, private-group** UK/other
leads that cookieless discovery can't reach live behind a joined account, and
this is how those accounts get created at VA scale.

## The key distinction (why accounts, if discovery is cookieless)

Two layers, and the wizard only creates the second:

| Layer | Needs account? | Role |
|---|---|---|
| **Discovery** (Apify, cookieless) | No | Finds *public* asks, any country — always available |
| **Engagement** (AdsPower fleet) | Yes | Join **private** groups, read private posts, comment/DM |

The onboarded accounts unlock engagement (and the private/fresh supply); they do
not power discovery. See the fleet architecture spec
(`2026-08-12-hosted-fb-lead-fleet-architecture.md`).

## Goals

1. A Vercel wizard: **pick country → log into FB in a streamed browser → Done**.
2. Profile creation on the EC2 AdsPower is **automatic** (proxy + country code
   set for the VA); the only human step is the FB login/captcha itself.
3. On success, the account is saved country-pinned and its country appears in
   the **Facebook scraping country dropdown**.
4. The dropdown reflects **active markets = countries with an onboarded account**
   (Option A, operator-approved).

## Non-goals

- External/multi-tenant customers (this is internal VAs on the shared fleet).
- Automating the Facebook login itself (FB blocks bot logins by design; the
  streamed manual login is the intended, unavoidable human step).
- Storing Facebook credentials anywhere (the VA types them into the streamed
  browser; we never receive or persist them).
- New proxy infrastructure (same Enigma sticky-session proxy; only the country
  code changes per profile).

## What already exists (reused, not rebuilt)

- **`social_accounts` connect state machine** (the `connect_status`
  migration): `requested → provisioning → ready → captured`. Cloud Run
  requests; the EC2 worker claims, writes `connect_tunnel_url`, sets `ready`;
  the frontend embeds the URL; capture flips `status='active'`.
- **CDP stream**: `browse-stream-bridge.ts` + cloudflared tunnel +
  `useBrowseSession.ts` + `ec2-windows-spawn-adspower-cdp.ps1`, orchestrated by
  `social-connect-worker.ts`. Streams an AdsPower profile into the web app.
- **Columns already present**: `country`, `proxy_location`, `adspower_profile_id`,
  `status`, `connect_status`, `connect_tunnel_url`, `connect_session_id`.
- **AdsPower client**: `tools/scraper/shared/adspower.py`
  (`start_profile`/`stop_profile`/`probe`).

## Net-new work (the ~20%)

1. **`adspower.create_profile(*, name, country, proxy)`** — wraps AdsPower
   `POST /api/v1/user/create` (fingerprint + Enigma proxy with the chosen
   country code + a fleet group). Returns the new `user_id` (profile id). This
   is the only new AdsPower API call; the rest of the client is unchanged.
2. **Onboarding job in the connect flow** — a variant of the existing connect
   path whose first step is "create a fresh profile" (instead of opening an
   existing account's profile). Reuses the `requested → provisioning → ready →
   captured` machine and the CDP spawner verbatim.
3. **`GET /api/social-accounts/countries`** — returns `DISTINCT country` from
   `social_accounts WHERE platform='facebook' AND status='active'`. The FB
   Scrape-page country field reads from this (Option A).
4. **Onboarding wizard UI** (Vercel) — 3 screens: (a) pick country, (b) streamed
   FB login (embeds `connect_tunnel_url`, "open in new tab" for captcha), (c)
   confirmation. Largely reuses the existing connect-account modal/hook.

## Flow (data + control)

```
VA (Vercel)                Cloud Run / API            EC2 worker + local AdsPower
-----------                ---------------            ---------------------------
1. "Add FB account"
   picks country=GB  ─────► create social_accounts row
                            {platform:'facebook', country:'GB',
                             status:'provisioning',
                             connect_status:'requested'}
                                                  ◄──── 2. worker claims 'requested'
                                                        create_profile(country=GB,
                                                          proxy=Enigma+GB) → profile_id
                                                        write adspower_profile_id
                                                        spawn CDP stream (existing)
                                                        write connect_tunnel_url,
                                                        connect_status='ready'
3. poll /connect-status ◄── returns tunnel URL
   embed streamed browser
4. VA logs into FB in the
   stream; captcha → "open
   in new tab", solves, exits
5. clicks "Done"      ─────► POST /connect-complete
                                                  ◄──── worker verifies session,
                                                        stop_profile, set
                                                        status='active',
                                                        connect_status='captured'
6. country 'GB' now appears in the FB scraping dropdown
   (GET /api/social-accounts/countries)
```

## The one manual step + captcha

The VA logs into Facebook **inside the streamed AdsPower browser** — typing the
FB email/password there, so credentials never touch our backend. Facebook
checkpoints/captchas render in the same stream; the "open the streamed desktop
in a new tab" affordance (already how the browse stream works) lets the VA
interact at full fidelity, solve it, and return. "Done" is only enabled once the
VA confirms they see the logged-in FB home.

## Error handling

- **Profile creation fails** (AdsPower API error) → job sets
  `connect_status='error'` with the reason; wizard shows "couldn't create the
  browser profile, retry"; no orphan row left `provisioning` (mark `disabled`).
- **Proxy for the country unavailable** → validated *before* creation; the
  country dropdown in the wizard only offers countries the Enigma plan covers.
- **VA abandons mid-login** → a TTL sweep (reuse the existing session-expiry
  sweep) stops the profile and marks the row `disabled` so it never counts as
  active (and never enters the scraping dropdown).
- **Login looks incomplete on "Done"** → the worker's verify step (is FB
  actually logged in?) gates the flip to `active`; if it can't confirm, it keeps
  the row out of `active` and tells the VA to finish logging in.
- **Duplicate country** → allowed; multiple accounts per country is normal
  (rotation). The dropdown de-dupes on country.

## Security

- No FB credential storage: login happens in the streamed browser only.
- The onboarding endpoint is authenticated the same as the rest of the API
  (`API_SECRET_KEY` / gateway); a VA cannot trigger profile creation anonymously.
- Do **not** reuse or expose existing warmed profiles (e.g. the local GB profile
  `k1flq0bx`) — the wizard only ever creates *new* profiles, and each profile is
  bound to exactly one host.

## Testing

- **Unit**: `adspower.create_profile` builds the correct `/api/v1/user/create`
  payload (proxy country code, group, fingerprint); errors surface as
  `AdsPowerError`. `GET /api/social-accounts/countries` returns only distinct
  active FB countries. TTL sweep disables an abandoned `provisioning` row.
- **Integration (mocked AdsPower)**: the connect state machine walks
  `requested → provisioning → ready → captured` for the create-profile variant.
- **Live smoke (owner, on the EC2 box)**: run the wizard end to end with a
  throwaway country/account; confirm profile is created with the right proxy,
  the stream opens, capture flips `status='active'`, and the country appears in
  the dropdown. (Manual — a real FB login can't be automated.)

## Out of scope / future

- Account health/rotation dashboard (separate feature).
- Auto-join of niche groups after onboarding (the fleet's engagement phase).
- Instagram onboarding (same shape later; FB first).
