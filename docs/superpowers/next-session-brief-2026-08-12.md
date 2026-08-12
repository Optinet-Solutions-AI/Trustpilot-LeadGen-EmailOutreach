# Next-Session Brief — 2026-08-12 (Hosted FB Fleet + Cloud Discovery)

**Pick this up cold. Do the three steps in order — money-first, not infra-first.**

## TL;DR
1. **Turn on cloud cookieless discovery** (cheap, ~15 min, operator SSM) → real FB consumer leads from the cloud, no account/AdsPower/fleet host.
2. **Validate the broker model** (prove a tradesperson pays for a lead) — gates all fleet spend.
3. **Only after 1–2 earn:** provision the Windows EC2 fleet host, verify Phases 1 & 2 live, then Phase 3.

---

## Where we are (state as of 2026-08-12, ~midnight)

- **Phase 1 (fleet foundation): SHIPPED to `main`** (merge `0eac740`). Code: `adspower.health_check`, `tools/scraper/fleet_watchdog.py`, `tools/scraper/fleet_session.py`, `scripts/ec2-windows-adspower-fleet-setup.ps1`. Unit-tested; **on-box verify pending** (needs the fleet host).
- **Phase 2 (point the CDP stream at AdsPower): BUILT + reviewed, NOT merged.** Lives on branch `feat/fb-apify-adspower` (commits `41bd5b2..6e80021`). Merge is gated on two things: (a) the parked `.on('error')` one-liner below, (b) on-box verify.
- **DB migrations applied:** 059, 060, 061 (cloud FB routing). 
- **Branches:** `main` = Phase 1 + all prior work. `feat/fb-apify-adspower` = Phase 2 (unmerged) + the same history.
- **Strategy locked:** cookieless discovery is cheap + serverless-capable; the broker model (sell consumer leads to tradespeople) avoids needing to contact consumers ourselves; the AdsPower fleet is the *expensive* engagement path, deferred until proven.

---

## STEP 1 — Cloud cookieless discovery (highest ROI, do first)

**Why:** already built; one config change makes any cloud/Vercel user trigger FB consumer-lead discovery via the always-on Linux worker — no browser, no account, no ban risk.

**Where:** `trustpilot-scra` = `ec2-sg-1` = instance `i-0188e136ef92d0c07`, region `ap-southeast-1`. (No AWS CLI on the dev box — operator runs SSM, or use the AWS Console → Session Manager.)

**1a. Print the secret values locally (keeps them out of chat/git):**
```bash
cd "c:/Users/User/Desktop/TRUSPILOT LEAD GEN AND EMAIL OUTREACH"
grep -E '^(APIFY_API_TOKEN|NEXT_PUBLIC_GEMINI_API_KEY|APIFY_FB_SEARCH_ACTOR|APIFY_FB_GROUP_POSTS_ACTOR)=' .env
```

**1b. SSM into the box:**
```bash
aws ssm start-session --target i-0188e136ef92d0c07 --region ap-southeast-1
```

**1c. On the box — add env + restart (paste real values):**
```bash
sudo -i
cp /etc/scraper-worker.env /etc/scraper-worker.env.bak.$(date +%s)
cat >> /etc/scraper-worker.env <<'EOF'
BROWSERLESS_FB_OK=1
APIFY_API_TOKEN=<paste>
NEXT_PUBLIC_GEMINI_API_KEY=<paste>
APIFY_FB_SEARCH_ACTOR=<paste>
APIFY_FB_GROUP_POSTS_ACTOR=<paste>
EOF
# keep PLATFORM_EXCLUDE=facebook,instagram as-is
systemctl restart scraper-worker.service
sleep 3
journalctl -u scraper-worker.service -n 25 --no-pager | grep -i browserless
```
**Success =** the log shows `browserless_fb_ok=true`. (If a key already exists in the file, edit in place, don't duplicate.)

**1d. Hand back to me** — I'll fire a browserless FB test scrape and confirm `worker_id=ec2-sg-1` with leads landing. (Migration 061 is already applied, so the opt-in is safe.)

---

## STEP 2 — Broker-model validation (prove the money)

- I pull a fresh cheap Apify batch of live consumer asks (e.g. `plumber` + a UK city, ~$0.10/run).
- Operator joins the good **public** groups from local AdsPower (free join-list already identified: handyman Liverpool `1149617693567067` / Bristol `939305670767160`, plumber Manchester `690806680368162`, Leicester biz `leicesterbusiness`).
- Broker 1–3 leads to tradespeople; **prove at least one pays.** Everything downstream is only worth building if this earns.

---

## STEP 3 — Fleet host (only after Steps 1–2 earn)

1. **Land the parked Phase 2 fix** (below), then merge Phase 2 to main.
2. Provision a Windows EC2 + AdsPower; run `scripts/ec2-windows-adspower-fleet-setup.ps1`; verify Phase 1 on-box (AdsPower up + watchdog recovers a kill + `python -m tools.scraper.fleet_session --profile <throwaway>` returns a CDP address).
3. Verify Phase 2 on-box: `npm run build` in `server/`, run `scripts/ec2-windows-spawn-adspower-cdp.ps1 -AccountId <test>`, open the emitted tunnel URL, confirm the VA can click/type in the streamed AdsPower browser and cleanup stops the profile on close.
4. Then **Phase 3** (convert `/join` + engagement from in-process spawn → enqueue) for multi-account/unattended operation (there's a design note in the architecture spec).

---

## Parked / pending — DO NOT lose these

- **Phase 2 MUST-FIX before merge:** the worker's new fire-and-forget `spawn(python … --stop)` inside `finishSession()` in `server/src/worker/social-connect-worker.ts` has no `.on('error', …)` handler — an ENOENT would crash the whole worker process. Model it on `server/src/routes/social-accounts.ts` (which carries the exact handler + a "CRITICAL" comment). One line.
- **Apify:** decide the ~$39/mo paid plan (free tier caps 20 results + 1 run/24h) and get a **durable AdsPower key** (the trial key expires ~daily).
- **Gemini key on servers** — covered by Step 1 (`NEXT_PUBLIC_GEMINI_API_KEY` on the worker); without it the classifier degrades and adverts leak.
- **Titan SMTP block** — chase Bluehost/Titan support to lift the outbound-SMTP suspension (email outreach is throttled until then).
- **Yelp** — decide budget for a captcha-solver to make Yelp discovery fully hands-off.

---

## Key gotchas (so a fresh session doesn't re-derive them)

- **The CDP relay is ALREADY built** — `browse-stream-bridge.ts` + a cloudflared quick tunnel + `useBrowseSession.ts` + `connect_tunnel_url`. Phase 2 reuses it; do NOT rebuild an "outbound WS relay" (the spec's original assumption was wrong — it's corrected).
- **AdsPower cannot run on Cloud Run/Vercel** — it needs a persistent desktop VM (EC2). Cookieless Apify discovery is the only serverless-capable path.
- **No AWS CLI on the dev box** — operator runs SSM / AWS Console for anything on the boxes.
- **The Windows FB worker (`fb-scraper-win`, `i-0a373a528fdf851ff`) has been dormant since 2026-06-16** — browserless FB now routes to the Linux `ec2-sg-1`. It'd need reviving only for browser-mode FB.
- **Owner scrapes run local-inline** (localhost:3001); Vercel users hit Cloud Run → enqueue → a worker claims. `USE_REMOTE_WORKER=true` in prod.
- **`.superpowers/sdd/` are scratch** (git-ignored) — git history + this brief + the `project-hosted-fb-fleet` memory are the durable record.

## Reference files
- Architecture spec: `docs/superpowers/specs/2026-08-12-hosted-fb-lead-fleet-architecture.md`
- Phase 1 plan: `docs/superpowers/plans/2026-08-12-fb-fleet-phase1-foundation.md`
- Phase 2 plan: `docs/superpowers/plans/2026-08-12-fb-fleet-phase2-cdp-adspower.md`
- Memory: `project-hosted-fb-fleet`
