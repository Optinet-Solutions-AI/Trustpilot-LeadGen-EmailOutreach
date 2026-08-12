# Hosted FB Lead Fleet — Platform Architecture Spec

**Date:** 2026-08-12
**Status:** Approved architecture, pending implementation plans (one per phase)
**Owner path:** internal tool for the operator's own VAs; hosted secured browser fleet on EC2

## Goal

Let the operator's VAs — from the Vercel web app, independent of any one person's
local machine — discover Facebook consumer leads, join niche (including private)
groups, capture "rich" leads from those groups, and broker them to tradespeople.
Accounts must be run securely (isolated fingerprints + country-pinned proxies).

Today this only works on the owner's local machine (local AdsPower + a logged-in
account). The platform makes it **hosted, multi-operator, and cloud-triggered**
without sacrificing account safety.

## Scope (decided via brainstorming 2026-08-12)

- **Users:** the operator's own VAs / operators. **Internal tool**, not public SaaS —
  no self-serve signup, no billing, no abuse controls, no fleet auto-scaling.
- **Scale:** a small fleet, ~5–15 controlled FB accounts. Add capacity by adding
  boxes, not by building elastic infrastructure.
- **Automation level:** **human-in-the-loop writes.** The fleet hosts secured
  browsers and automates the *safe* work (discovery, queueing, reads); VAs
  remote-control the browser through the web app to do the *risky* work — answering
  membership questions when joining, and commenting — as real humans.
- **Lead delivery:** **thin.** Package leads + export/notify a buyer by hand;
  payment stays out-of-band. No marketplace, no buyer portal.
- **Fleet technology:** **AdsPower-on-EC2, CDP-streamed** (chosen over a native
  uc_driver fleet and over a cloud anti-detect vendor) — it delivers the "secure
  accounts" requirement and reuses the AdsPower profiles, provisioner, sticky
  country proxy, and CDP browse feature already built and validated.

## Non-goals

- Public/self-serve product, billing, buyer-facing portal.
- Fully autonomous join/comment bots (rejected: auto-answering membership
  questions and templated comments are exactly what FB flags).
- Multi-country geo-ID seeding beyond what account provisioning already covers.
- Replacing the cookieless discovery path — it stays the cheap public layer.

## Architecture — two planes

The system splits into a cheap, always-on **control plane** and a secured
**fleet plane**. Expensive browsers run only in the fleet plane; everything that
can be done without a logged-in account stays in the cheap control plane. That
split is the core cost discipline.

```
CONTROL PLANE (cloud, cheap, always-on)
  Vercel web app  ─►  Cloud Run API  ─►  Supabase (jobs, accounts, groups, leads)
        │                  │
        │                  └─►  Cookieless Apify discovery (public groups/feed) — no account
        │
        ▼  VA picks niche/country; sees discovered groups + live public asks;
           remote-drives a secured browser for private/engagement work
FLEET PLANE (EC2 — only the secured browsers)
  Windows EC2 + AdsPower  ──  one profile per account (fingerprint + sticky country proxy)
  Fleet worker: claims browser jobs, opens the profile, exposes its CDP port
```

**End-to-end loop:**
1. VA opens the web app → picks niche + country.
2. Control plane runs cookieless discovery → candidate groups + live *public* asks
   (pennies, no account).
3. For private groups / commenting: VA clicks "work this account" → control plane
   enqueues a browser job → fleet worker opens that account's AdsPower profile →
   returns a live CDP stream.
4. Web app embeds the live browser → VA remote-controls it: join (answer
   questions), read private posts, comment on asks — as a human, through the
   secured profile.
5. Leads (public discovery + private reads) → packaged → VA delivers to a buyer.

## Subsystems

### 1. Hosted secure browser fleet (keystone — net-new)

- **Host:** one Windows EC2 to start (~t3.large/xlarge, 8–16 GB) running the
  AdsPower desktop client. Scale by adding boxes, not by cramming profiles.
- **Profiles:** one AdsPower profile per FB account via the existing provisioner
  (`tools/scraper/provision_adspower_profile.py`) — country-pinned sticky Enigma
  proxy + desktop fingerprint. This *is* "secure accounts."
- **Persistent-desktop rig (the one genuinely new operational burden):** auto-logon
  to the console session, AdsPower auto-start, session kept alive across RDP
  disconnect (e.g. `tscon` to console), and a **watchdog** that pings AdsPower's
  Local API and relaunches it if it dies. Without this the fleet silently goes
  dark (AdsPower is a GUI app, not a service).
- **Fleet worker:** extends the existing `server/src/worker/scraper-worker.ts` —
  claims *browser-mode* FB jobs, opens the account's AdsPower profile via the
  Local API (loopback `local.adspower.com:50325`) → gets its CDP address, and
  registers it so the control plane can stream it. Reuses the AdsPower branch of
  `tools/scraper/shared/uc_driver.py`.
- **CDP relay:** the AdsPower CDP port is loopback on the EC2. The fleet worker
  opens an **outbound** websocket to the Cloud Run API that proxies the profile's
  CDP to the VA's browser — **no inbound ports** on the EC2, works from anywhere
  the VA is. Generalizes the existing `/leads/:id/browse` CDP path.
- **Concurrency:** ~3–5 live profiles per box (RAM-bound); the queue caps it,
  boxes add capacity.

### 2. Account onboarding + security (partial — extends `social_accounts`)

- Each FB account is a `social_accounts` row: `adspower_profile_id`, `country`,
  `status` (active/checkpoint/banned), `warmup_started_at`, and the existing daily
  caps (`comment_daily_cap`, `group_join_daily_cap`).
- **Onboarding a VA account:** run the provisioner → the VA logs FB in *once*
  through the CDP stream (or RDP) → bind `adspower_profile_id` → warm 2–3 weeks.
- **Safety (mostly built):** warmup ramp, per-account daily caps, checkpoint
  detection flipping `status`, human-paced writes. A flagged account cools down
  (status flip) rather than being hammered.

### 3. Cloud orchestration (mostly exists)

- Reuses `scrape_jobs` + the claim RPC (`claim_next_pending_scrape_job`, extended
  by migration 061 for browserless FB).
- **New browser-job types:** `open-session` (fleet opens a profile + registers its
  CDP), `join-groups` (convert `server/src/routes/social-groups.ts` `/join` from
  in-process `spawn()` → enqueue, as its own code comment already prescribes), and
  engagement actions.
- **CDP session brokering:** Cloud Run relays the outbound websocket between the
  VA's browser and the fleet worker's profile.

### 4. Discovery + private-group joining (hybrid — mostly exists)

- **Public** (cheap, no account): cookieless Apify on the control plane → live asks
  + new group candidates. Browserless-FB was just wired to the always-on Linux
  worker (migration 061) — this half is effectively done.
- **Private** (fleet): browser-path reads (`FB_DISCOVERY=browser`) of groups the
  account has joined.
- Candidates ranked in `fb_group_candidates` (audience label + per-group yield
  tracking — both exist). **Joining:** VA remote-drives the secured browser to
  request-join and answer membership questions by hand; status flips
  candidate→requested→joined (migration 059) already model this. Automation never
  answers questions.

### 5. Engagement + lead capture (partial — generalizes CDP browse)

- VA works a queue of live asks inside the streamed browser — open the post,
  comment naturally / DM.
- Lead capture (ask text, author handle, group, URL, screenshot) writes to `leads`
  + `lead_platform_posts` (exist), gated by the consumer classifier
  (`tools/scraper/shared/social_nlp.py`, exists).
- This is `/leads/:id/browse` generalized from "browse one post" to "work this
  account's groups/feed."

### 6. Lead delivery (thin — net-new but small)

- A **package** view (niche, location, ask text, contact/handle, group, timestamp,
  screenshot) + a **deliver** action that exports to sheet/email and marks the lead
  delivered. Payment out-of-band.

## Cost model

- 1 Windows EC2 (~$60–100/mo, 24/7) + AdsPower subscription (already paid) +
  residential proxy data per account + Apify (pennies per discovery run).
- Start with **one box, a few accounts.** Add boxes only when VAs are saturated.
- The recurring variable cost of this model is **account churn** — promotional
  commenting gets accounts flagged; budget for warming replacements. Human-in-the-
  loop pacing minimizes but does not eliminate this.

## Build order (phased — each phase independently useful)

1. **Fleet foundation** *(keystone, net-new)* — AdsPower-on-EC2 + persistent-desktop
   rig + fleet worker opens a profile on a claimed job.
2. **CDP relay** *(net-new)* — stream a profile to the web app; VA remote-controls
   it. Generalize `/leads/:id/browse`.
3. **Enqueue conversion** *(small)* — `/join` + engagement become fleet jobs.
4. **Discovery hybrid** *(≈done)* — public (cookieless) + private (browser) reads
   feed the group/lead queues.
5. **Workflow UI** *(moderate)* — the VA's niche → groups → asks → work-account loop.
6. **Delivery** *(small)* — package + export.

Phases 1–2 are the real new work. Phases 3–6 lean heavily on what exists. Each
phase gets its own implementation plan.

## What exists vs net-new

| Component | Status |
|---|---|
| AdsPower provisioner, profiles, sticky country proxy, uc_driver AdsPower branch | ✅ exists / validated |
| Job queue + claim RPC (incl. browserless-FB routing, migration 061) | ✅ exists |
| Cookieless Apify public discovery | ✅ exists |
| `fb_group_candidates` (audience label, yield tracking), join status states | ✅ exists |
| Consumer classifier, lead/post capture tables | ✅ exists |
| `/leads/:id/browse` CDP browse (~80%) | 🟡 partial → generalize |
| `social_accounts` onboarding + warmup/caps | 🟡 partial |
| Persistent-desktop rig on Windows EC2 | ❌ net-new |
| CDP relay (fleet → Cloud Run → VA browser) | ❌ net-new |
| `/join` (and engagement) enqueue conversion | ❌ net-new (prescribed by existing code comment) |
| Workflow UI (niche→groups→asks→work-account) | 🟡 partial → assemble |
| Lead package + deliver/export | ❌ net-new (small) |

## Risks / open questions (to resolve during per-phase planning)

- **Desktop-session reliability on Windows EC2** — the persistent-desktop rig is
  the highest-risk new piece; a dropped console session kills the fleet. Needs a
  proven keep-alive + watchdog before relying on it.
- **CDP-over-relay latency** — remote-controlling a browser across the relay must be
  responsive enough for natural commenting; measure before scaling.
- **AdsPower concurrency ceiling per box** — confirm real RAM headroom for
  simultaneous profiles on the chosen instance size.
- **Account churn rate** — the true recurring cost; measure how fast accounts get
  flagged under human-paced commenting before scaling account count.
