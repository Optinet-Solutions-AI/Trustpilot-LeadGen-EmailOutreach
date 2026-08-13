# Next-Session Brief — updated 2026-08-13 (Hosted FB Fleet + Cloud Discovery)

**Pick this up cold. Steps 1 and 2 (below) are the whole job now — money-first, not infra-first.**

## TL;DR (what changed since 08-12)
- ✅ **Step 1 (cloud cookieless discovery) is DONE + verified** — `BROWSERLESS_FB_OK=1` is live on `ec2-sg-1`; a real FB consumer lead landed with `worker_id=ec2-sg-1`.
- ✅ **AdsPower-on-EC2 PROVEN LIVE** — opened a throwaway profile on the Windows box, got a real CDP address. The fleet's hardest technical risk is retired.
- ✅ **Both Phase-2 must-fixes are landed** (`start_profile` retry `1b6a51f`, worker `.on('error')` `11300cb`). Phase 2 code is merge-ready.
- ▶ **Now: prove the money (Step 1 below) and provision the fleet host to merge Phase 2 (Step 2).**

---

## Where we are (state as of 2026-08-13)

- **Phase 1 (fleet foundation): SHIPPED to `main`** (merge `0eac740`). On-box verify still pending (needs a real, persistent fleet host — the AdsPower proof was a manual throwaway-profile open, not the full `ec2-windows-adspower-fleet-setup.ps1` rig run).
- **Phase 2 (point the CDP stream at AdsPower): BUILT, reviewed, must-fixes landed, NOT merged.** Branch `feat/fb-apify-adspower` @ `11300cb`. **Merge is now gated on on-box verify only.**
- **Cloud cookieless discovery: LIVE.** `ec2-sg-1` (`i-0188e136ef92d0c07`, `ap-southeast-1`) claims browserless consumer FB jobs (migration 061 + `BROWSERLESS_FB_OK=1`).
- **DB migrations applied:** 059, 060, 061.
- **AdsPower key caveat:** the account/key on the EC2 box is the operator's *same* account as local — never open the same profile on two hosts at once, and do NOT open the warmed GB profile `k1flq0bx` on EC2.
- **Lead-supply reality (measured live):** open-feed = fresh but ad-heavy (London 0/30, Manchester 1/10); small "gem" public groups (e.g. `leicesterbusiness`, "Find a Plumber East Midlands") = genuine consumer asks but STALE (Mar–Jul); big active groups = fresh but all ads. **This is the constraint the broker validation must design around.**

---

## STEP 1 — Broker-model validation (prove the money) — DO THIS FIRST

Everything downstream is only worth building if a tradesperson pays for a lead.

- Pull a fresh cheap Apify batch of live consumer asks (`plumber`/`electrician` + a UK city, ~$0.10/run) — or reuse the 7 East Midlands asks already captured.
- Operator pitches 1–3 of those asks to a plumber/tradesperson and **proves at least one pays** (or firmly commits).
- Open question the validation answers: are stale-but-genuine group asks sellable, or does the buyer need *fresh* asks (which forces the in-group engagement path)?

---

## STEP 2 — Fleet host + merge Phase 2 (unblocks unattended engagement)

The code is ready; this is the on-box acceptance that lets Phase 2 merge.

1. Provision a persistent Windows EC2 + AdsPower (or reuse `fb-scraper-win` `i-0a373a528fdf851ff`, currently the manual test box). Run `scripts/ec2-windows-adspower-fleet-setup.ps1`.
2. **Verify Phase 1 on-box:** AdsPower auto-starts on logon + the watchdog task recovers a killed AdsPower + `python -m tools.scraper.fleet_session --profile <throwaway>` returns a CDP address.
3. **Verify Phase 2 on-box:** `npm run build` in `server/`, run `scripts/ec2-windows-spawn-adspower-cdp.ps1 -AccountId <test>`, open the emitted tunnel URL, confirm the VA can click/type in the streamed AdsPower browser and that closing it stops the profile (no leak).
4. **Merge `feat/fb-apify-adspower` → main.**
5. Then **Phase 3** (convert `/join` + engagement from in-process spawn → enqueue) for multi-account/unattended operation.

---

## Parked / pending — operator-side, don't lose these

- ✅ ~~Phase 2 `.on('error')` must-fix~~ — **DONE** (`11300cb`).
- ✅ ~~`start_profile` empty-first-CDP-address retry~~ — **DONE** (`1b6a51f`).
- **Apify:** decide the ~$39/mo paid plan (free tier caps 20 results + 1 run/24h) and get a **durable AdsPower key** (the trial key expires ~daily; a paid plan is needed for a non-expiring key + the Local API).
- **Titan SMTP block** — chase Bluehost/Titan support to lift the outbound-SMTP suspension (email outreach is throttled until then).
- **Yelp** — decide budget for a captcha-solver to make Yelp discovery fully hands-off.

---

## Key gotchas (so a fresh session doesn't re-derive them)

- **AdsPower's first `browser/start` can return code 0 with an EMPTY `ws.selenium`** — the debug port comes up on a subsequent call. `adspower.start_profile` now re-polls up to 6× (`1b6a51f`); don't "fix" it back to a single call.
- **The CDP relay is ALREADY built** — `browse-stream-bridge.ts` + a cloudflared quick tunnel + `useBrowseSession.ts` + `connect_tunnel_url`. Phase 2 reuses it; do NOT rebuild an "outbound WS relay."
- **AdsPower cannot run on Cloud Run/Vercel** — it needs a persistent desktop VM (EC2). Cookieless Apify discovery is the only serverless-capable path.
- **No AWS CLI on the dev box** — operator runs SSM / AWS Console for anything on the boxes.
- **Owner scrapes run local-inline** (localhost:3001); Vercel users hit Cloud Run → enqueue → a worker claims. `USE_REMOTE_WORKER=true` in prod.
- **`.superpowers/sdd/` are scratch** (git-ignored) — git history + this brief + the `project-hosted-fb-fleet` memory are the durable record.

## Reference files
- Architecture spec: `docs/superpowers/specs/2026-08-12-hosted-fb-lead-fleet-architecture.md`
- Phase 1 plan: `docs/superpowers/plans/2026-08-12-fb-fleet-phase1-foundation.md`
- Phase 2 plan: `docs/superpowers/plans/2026-08-12-fb-fleet-phase2-cdp-adspower.md`
- Memory: `project-hosted-fb-fleet`
