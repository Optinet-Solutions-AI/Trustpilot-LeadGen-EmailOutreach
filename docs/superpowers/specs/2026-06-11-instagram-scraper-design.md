# Instagram Scraper — Design Spec (planning → smoke → live)

**Date:** 2026-06-11
**Status:** Draft — pending user review, then implementation plan
**Supersedes the IG portion of:** [`2026-05-18-social-platforms-design.md`](2026-05-18-social-platforms-design.md) (the master social spec; this narrows it to Instagram and reflects what actually shipped for Facebook since then).

## Goal

Take the existing Instagram scraper from an **untested skeleton** to a **live, lead-producing platform**, mirroring the proven Facebook stack (undetected-chromedriver + persistent Brave profile + Enigma residential proxy + `social_accounts` connect/checkpoint flow). Two lead modes ship in v1:

- **Business mode** — the email-outreach value path. Find business profiles by keyword/category → capture `website_url` (bio link) → chain `scrape_website.py` → ZeroBounce → contactable verified email → campaigns.
- **Consumer / hashtag mode** — find post authors under a hashtag, **with caption capture** so a Gemini intent-classifier can keep only people actively asking for a service, and so the `{{post_excerpt}}` campaign token works (parity with Facebook consumer mode).

## Current state (ground truth, 2026-06-11)

- [`tools/scraper/platforms/instagram.py`](../../../tools/scraper/platforms/instagram.py) — a real **408-line skeleton**, registered in [`platforms/__init__.py`](../../../tools/scraper/platforms/__init__.py) and the [`scrape.ts`](../../../server/src/routes/scrape.ts) manifest. **Never run against live Instagram.** Selectors are best-effort guesses.
- **Critical gap:** [`_open_ig_driver()`](../../../tools/scraper/platforms/instagram.py) opens a vanilla `undetected_chromedriver` with a mobile UA but **no residential proxy and no persistent profile** — the two things that keep Facebook from being instantly checkpointed. On any non-residential IP this fails on the first request.
- It reuses Facebook's private helpers by cross-import (`_claim_account`, `_emit`, `_flag_checkpoint`, `_inject_cookies`, `_is_checkpoint`, `_bump_counters`) — a known smell.
- The 2026-06-06 brief (Tier 4a) records the IG brainstorm as paused on the "Connect-IG first vs full-scraper first" sequencing question. **Resolved here: Connect-IG first.**

## What is already wired (no work needed)

1. **Dispatch.** `isFbConsumerMode` is gated on `platform === 'facebook'` ([`scrape-runner.ts:687`](../../../server/src/services/scrape-runner.ts)), so Instagram falls through to the standard `list`→`enrich` path. IG's `scrape_listing`/`enrich_profiles` self-route by `lead_type` and PostStub-shape, so **no new dispatch branch is required.**
2. **Upsert + schema.** [`_upsert_nontrustpilot_lead`](../../../tools/db/upsert_leads.py) already writes `author_handle`/`follower_count`/`is_business_profile` to `lead_platform_presences` (migration 039) and fans a lead's `posts[]` into `lead_platform_posts` keyed on `(platform, post_url)`. IG leads land with **zero DB/upsert/migration changes.**
3. **Connect / login / checkpoint flow.** [`login_flows.py`](../../../tools/scraper/shared/login_flows.py) is platform-generic and already IG-aware: `instagram → sessionid` cookie, IG login URL, IG autofill selectors, and a proxy-bound `_open_driver` that binds captured cookies to the proxy IP from inception. [`social-accounts.ts`](../../../server/src/routes/social-accounts.ts) already accepts `platform: 'instagram'` and defaults its `daily_cap` to 25.

## Architectural decisions (this session)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Lead types in v1 | **Both** — business profiles AND hashtag post authors |
| 2 | Session onboarding | **Connect-IG flow** (verify the existing generic flow end-to-end for IG) |
| 3 | Run environment | **Local for smoke-test, EC2 for live** |
| 4 | Browser driver | **Extract a shared UC-driver helper now** (refactor FB + IG onto it) |
| 5 | Hashtag captions | **Capture captions in v1** → enable Gemini classifier + `{{post_excerpt}}` |
| 6 | Live success bar | ≥10 business profiles with `website_url`, ≥3 enriching to a verified email in the CRM, IG account stays `active` (no checkpoint) through the run |

## Components & changes

### A. Shared UC-driver extraction — `tools/scraper/shared/uc_driver.py` (new)

Extract Facebook's driver logic verbatim into one parameterized opener:

```python
open_uc_driver(profile_dir_env: str, user_agent: str, window_size: tuple[int,int],
               *, headless: bool, proxy_region: str | None) -> driver
```

Moves into this module (from `facebook.py`): Brave-binary resolution, `SingletonLock`/`SingletonCookie`/`SingletonSocket` cleanup, `--user-data-dir` wiring, the proxy-auth Chrome extension (`_build_proxy_auth_extension`), and the country-code swap helpers (`_resolve_proxy_country`, `_apply_proxy_country`, `_apply_proxy_country_password`).

- `facebook._open_driver()` → thin call with `FB_PROFILE_DIR`, desktop UA, `(1280,900)`.
- `instagram._open_ig_driver()` → thin call with `IG_PROFILE_DIR`, mobile UA, `(414,896)`.
- `login_flows._open_driver` → delegates to the shared opener instead of reaching into `facebook`.

**HARD GATE (repo golden rule):** before editing `facebook._open_driver`, run `gitnexus_impact({target:"_open_driver", direction:"upstream"})` and report the blast radius. After the refactor, a **live Facebook regression scrape must produce leads with no checkpoint** before any IG work continues. If FB regresses and can't be fixed quickly, revert the extraction and give IG a self-contained copy of the driver logic instead (fallback to approach "B").

### B. Shared consumer-intent NLP — `tools/scraper/shared/social_nlp.py` (new)

Extract from `facebook.py` (cross-platform, reused by IG captions): `_classify_consumer_posts_with_gemini` (batch Gemini intent classifier) and the substring pre-filters `_is_actively_asking` / `_looks_like_business_post`. Facebook imports them back from the shared module. **Same impact-analysis gate** as the driver. Niche→local-language translation stays in `facebook.py` (it's group-search-specific; IG hashtags are operator-supplied and need no translation).

### C. Instagram scraper — `tools/scraper/platforms/instagram.py`

- `_open_ig_driver` → shared opener (now gets proxy + persistent profile + Brave).
- `_open_session` → trust the persistent `IG_PROFILE_DIR` profile first, inject `sessionid` as a second layer; keep the `/accounts/login` redirect = checkpoint signal.
- **Caption capture (new):** in `_sync_search_hashtag`, after collecting post URLs, visit each post (cap at `max_results`) and read the caption from the `meta[property="og:description"]` content (primary) with a DOM fallback; populate `content_excerpt` on each PostStub. Add per-post delay; this increases page loads, so respect per-account caps.
- **Intent filter (new):** batch the captured captions through `social_nlp` → drop business/self-promo posts, keep consumer-intent asks. Surviving PostStubs carry their caption through to `lead_platform_posts.content_excerpt`.
- **Selector tuning (the core smoke-test work):** hashtag grid `a[href*="/p/"]`, business search `a[role="link"][href^="/"]`, profile title/bio-link extraction — all currently guesses; fix against live DOM.

### D. Worker / dispatch — `server/src/services/scrape-runner.ts` + worker env

- Generalize the **Linux guard** ([line 655](../../../server/src/services/scrape-runner.ts)) to refuse `facebook` **or** `instagram` on Linux workers (prevents the Tier-2a race-claim-burn for IG).
- Generalize **profile-dir routing** ([line 643](../../../server/src/services/scrape-runner.ts)): when a job carries `socialAccountId`, set `IG_PROFILE_DIR` for IG jobs the same way `FB_PROFILE_DIR` is set for FB.
- Windows EC2 worker `PLATFORM_FILTER` → `facebook,instagram`; Linux EC2 worker `PLATFORM_EXCLUDE` → include `instagram`.

### E. Campaign token — `server/src/services/template-engine.ts`

Wire `{{post_excerpt}}` and `{{post_url}}` into `TOKEN_MAP` (reading the most-recent `lead_platform_posts` row per lead at send time). This was already pending for Facebook (brief Tier 3b); doing it here completes it for both platforms.

## Data flow

```
search_posts(hashtag)  ──►  PostStub{post_url, author_handle, content_excerpt}
       │ (caption capture + social_nlp intent filter)
       ▼
enrich_authors / enrich_profiles  ──►  AuthorLead{profile_url, website_url, posts[...]}
       │
       ▼  upsert_leads._upsert_nontrustpilot_lead  (UNCHANGED)
       ▼
leads ──► lead_platform_presences(platform='instagram', profile_url, author_handle, …)
                                  └─► lead_platform_posts(post_url, content_excerpt)  [consumer mode]

[business mode]  AuthorLead.website_url ──► scrape_website.py ──► website_email ──► ZeroBounce ──► campaign
```

## Delivery phases

1. **Refactor** — extract `uc_driver.py` + `social_nlp.py`; run gitnexus impact analysis on both touched FB symbols; **FB regression scrape (GATE)** must pass.
2. **Connect** — create an `instagram` `social_accounts` row; run the local connect flow; confirm `sessionid` captured + status `active`.
3. **Smoke (local)** — one business-mode run + one hashtag-mode run on your residential IP; iterate selectors until each returns ≥1 correctly-parsed result with no checkpoint; confirm caption capture + intent filter on the hashtag run.
4. **Pipeline test (local)** — business-mode run → upsert → `scrape_website.py` → ZeroBounce → leads visible in the CRM with verified emails; consumer-mode run → `lead_platform_posts.content_excerpt` populated → `{{post_excerpt}}` renders in a test template.
5. **Live (EC2)** — connect a second IG session via the EC2 noVNC tunnel + Enigma; add `instagram` to the worker platform filters; run one real category/city and meet the success bar in decision #6.

## Risks

1. **FB regression from the shared extraction.** Mitigation: gitnexus impact analysis + mandatory live-FB regression gate + revert-to-self-contained fallback.
2. **Caption capture raises ban exposure** (one extra page load per post). Mitigation: cap posts per run, per-action delays, keep the IG `daily_cap` low (25).
3. **IG fingerprints harder than FB** (mobile UA, aggressive checkpoints, especially on fresh accounts). Mitigation: persistent profile, residential proxy, low caps; expect first-run selector + flow tuning.
4. **Selector drift** — IG is a React SPA that redesigns aggressively. Mitigation: prefer `og:` meta tags over DOM walks where possible; capture HTML fixtures during smoke for regression tests.
5. **Cookie/IP binding mismatch** — connecting on one IP and scraping from another trust-gates the account. Mitigation: local session for local smoke, EC2-tunnel session for EC2 live; never transplant.

## Out of scope for v1

- DM sending (separate sender lane + ADR) — consumer-mode IG leads are surfaced but not yet contacted.
- Multi-account rotation for IG (single connected account in v1; the `social_accounts` cap model already supports adding more later).
- Cross-platform identity merge (IG ↔ FB ↔ Yelp) — keep separate `lead_platform_presences` rows.
- The polished in-app "Connect Instagram" UX beyond what the existing generic flow already provides.
