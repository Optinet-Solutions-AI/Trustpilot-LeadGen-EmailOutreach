# Facebook: Apify discovery + AdsPower engagement

**Date:** 2026-07-31
**Status:** Approved design, ready for implementation planning
**Supersedes operationally:** the browser-only FB discovery path (kept as fallback, not deleted)

---

## 1. Problem

Facebook lead generation has been stalled. The current pipeline discovers posts by driving a
logged-in Facebook account through undetected-chromedriver + Brave (`open_uc_driver`), and that
single dependency causes every open problem:

- **Throughput ceiling.** `social_accounts.daily_cap` is 10 (deliberately, after a real FB
  "automated behaviour" warning). One group-first run performs one in-group search per discovered
  group, each bumping `used_today` — an 18-group run pushed the account to 32/10 and locked it out
  for ~24h. Effective rate: roughly one scrape per day.
- **Host lock-in.** FB rejects datacenter-IP sessions at fingerprint level (verified exhaustively
  2026-06-01: WebRTC STUN leak, SwiftShader WebGL, zero media devices, Linux-only fonts). So
  `shouldRefuseSocialOnLinux` refuses FB on every Linux worker, and discovery only runs on the
  operator's Windows desktop or a Windows EC2.
- **Account fragility.** Sessions expire, checkpoints appear, and a single account failure stops
  all discovery.
- **No parallelism.** One account, one fingerprint, one IP — no way to scale to multiple
  countries or multiple concurrent users.

Every one of those is a property of *using an account to read public data*. The data itself is
public.

## 2. Approach

Split the pipeline along the line of **what genuinely requires being logged in as a person**:

```
DISCOVERY — public data, no account, no cap, no ban risk, runs anywhere (incl. Cloud Run)
  Apify actor ──▶ PostStub[] ──▶ existing filter chain ──▶ AuthorLead ──▶ upsert_leads
    • keyword post search    scrapeforge/facebook-search-posts    $2.59 / 1k results
    • public group posts     data-slayer/facebook-group-posts     $5.00 / 1k results

ENGAGEMENT — requires a logged-in person; low volume, high value
  AdsPower profile ──▶ Selenium over CDP ──▶ open a lead's post as the account
                                             post a comment / DM
                                             search private groups the account has joined
```

Apify removes the cap, the host lock-in and the ban risk from discovery. AdsPower makes the
remaining account-bound actions survivable and, later, scalable to several accounts by giving each
one an isolated browser fingerprint.

**They solve different problems and neither replaces the other.** AdsPower is an anti-detect
browser, not a proxy — it isolates fingerprints, not IPs.

### Alternatives rejected

- **Keep both discovery paths and choose per job.** Rejected: two discovery implementations to
  maintain forever, and the browser one is the one that burns accounts. The browser path survives
  only as a flag-gated fallback for private groups and parity testing.
- **AdsPower for discovery too.** Rejected: it fixes fingerprinting but not the daily cap, not the
  ban risk, and not the Windows-host requirement. Public data does not justify an account.
- **AdsPower on Linux headless for everything.** Rejected: highest risk, contradicts the
  2026-06-01 findings, and Apify makes it unnecessary for the high-volume half.

## 3. Stage A — Apify discovery

### 3.1 Client module

New `tools/scraper/shared/apify.py`. One responsibility: run an Apify actor and return its dataset.

```python
def run_actor(actor_id: str, run_input: dict, *, timeout: int = 300) -> list[dict]
```

- `POST https://api.apify.com/v2/acts/{actor_id}/run-sync-get-dataset-items?token=…`
- Token from `APIFY_API_TOKEN`. Raise a clear error when unset — never silently return `[]`,
  because an empty discovery run and a misconfigured token look identical downstream.
- Retry 3× with backoff on 5xx and timeouts (matches the project's async retry standard).
- Raise on 402 (insufficient credit) with the actor id and the plan-limit message intact — a
  billing failure must not be reported as "no leads found".
- Log every call with timestamp, actor id, result count and cost header if present.

Actor IDs are **env vars, not literals**, so a delisted or broken community actor is a config
change:

| Env var | Default |
|---|---|
| `APIFY_FB_SEARCH_ACTOR` | `scrapeforge/facebook-search-posts` |
| `APIFY_FB_GROUP_POSTS_ACTOR` | `data-slayer/facebook-group-posts` |

Identified alternate for keyword search: `scraper_one/facebook-posts-search`.

### 3.2 Discovery functions

New in `tools/scraper/platforms/facebook.py`:

```python
def _search_posts_via_apify(query: str, filters: dict, max_results: int) -> list[PostStub]
def _group_posts_via_apify(group_ids: list[str], max_results: int) -> list[PostStub]
```

Actor input for keyword search:

| Actor input | Source |
|---|---|
| `search_query` | the translated `niche` + `location` (same string the browser path searches) |
| `search_type` | `"posts"`, or `"groups"` for the group-first variant |
| `max_results` | `max_results` from the job |
| `start_date` / `end_date` | optional recency window from filters |
| `recent_posts` | `true` — consumer asks are time-sensitive |

The actor's documented inputs are a required search keyword plus `search_type`, `max_results`,
`start_date`, `end_date`, `location_uid` and `recent_posts`. **The exact JSON key for the keyword
is unverified** — read the actor's input schema from `GET /v2/acts/{id}` as the first
implementation step rather than guessing.

`location_uid` (Facebook's internal geo IDs) is deliberately **not** used. Location already travels
inside the query string the browser path searches ("plumber Manchester"), and adopting geo IDs
would require seeding an FB-location table — a separate project for a marginal gain. Revisit only
if measured yield is poor and geo-narrowing is the identified cause.

Output maps 1:1 onto the existing `PostStub` TypedDict in
`tools/scraper/platforms/_social_base.py`, which is why nothing downstream changes:

| Apify field | `PostStub` field |
|---|---|
| post URL | `post_url` |
| message text | `content_excerpt` |
| author profile URL | `author_profile_url` |
| author id / username | `author_handle` |
| timestamp | `posted_at` |
| image / video URLs | `media_urls` |
| — (keyword search has no group context) | `group_id` / `group_name` left unset |

`group_name` being unset applies to **keyword search only**. `_group_posts_via_apify` knows which
group it queried and sets both fields, so the group-first path in §3.5 keeps full group context.

For keyword search, the unset `group_name` matters only for country resolution:
`_resolve_lead_country` falls back to the job's `location` plus the post excerpt, and
`_derive_location_confidence` already downgrades confidence accordingly. That is correct
behaviour, not a regression.

### 3.3 Router

`search_posts()` currently branches at facebook.py:2388:

```python
if groups_only:
    stubs = await asyncio.to_thread(self._sync_group_first_scrape, …)
else:
    stubs = await asyncio.to_thread(self._sync_search_posts, …)
```

A discovery-source check wraps that branch. **Placement is load-bearing:** the new branch goes
*after* niche translation (line ~2379) and *before* the country/category stamping (line ~2402), so
Apify stubs inherit the stamping, `_resolve_lead_country`, `_derive_location_confidence`, the
substring consumer filters and the Gemini classifier with no duplication.

```
FB_DISCOVERY=apify   (new default)  → _search_posts_via_apify / _group_posts_via_apify
FB_DISCOVERY=browser                → today's code, byte-for-byte unchanged
```

Progress events keep the existing names so the SSE stream and the scrape-job UI don't break. The
Apify branch emits `search_started` / `search_done`; `niche_translated`, `consumer_filtered`,
`llm_filtered` and `llm_skipped` continue to fire from the shared code below the branch. New event
`apify_run` carries `{actor, requested, returned}` for cost visibility.

### 3.4 Enrichment becomes optional

`enrich_authors()` visits each author's profile in a logged-in browser to fill
`display_name`, `website_url`, `email`, `location`, `is_business_profile`, `bio_excerpt`. This is
the single largest consumer of account quota.

Apify's search output already supplies `display_name` and `author_profile_url` — the two fields
that actually key a lead row. The rest are rare on personal FB profiles (the `AuthorLead` contract
itself documents `email` as "rare; only present when public"), and FB consumer leads are contacted
by comment or DM, not email.

```
FB_ENRICH=stub      (new default) → synthesize AuthorLead from the PostStub, open no browser
FB_ENRICH=browser                 → today's profile-visiting behaviour
```

This also fixes the historical `company_name = "(2) Facebook"` bug by construction — the stub path
never reads a browser tab title.

### 3.5 Group-first, without an account

The existing finding stands and must not be discarded: **open-feed keyword search is dominated by
ads phrased as "Looking for X?"; the group-first path is what yields real consumer asks.** Apify
keyword search *is* open-feed search, so it inherits that noise profile.

Two mitigations, in order:

1. The Gemini classifier already lifts precision from ~30% to ~80-90% and now runs on this path.
2. Group-first reproduces cookieless: run the search actor with `search_type: "groups"` to discover
   groups, then run the public-group actor on each. Private groups remain AdsPower-only.

Economics change the calculus. At $2.59 per 1,000 results, a 5% qualified rate is ~$52 per 100
leads — viable at a volume the 10-runs-per-day account could never reach. **Measure actual yield on
the first 1,000 results before scaling spend.**

### 3.6 Routing change

Apify discovery is an HTTP call, so it has no browser, no fingerprint and no host requirement. FB
discovery can finally run on Cloud Run and on the Linux EC2 worker.

`shouldRefuseSocialOnLinux(platform, osPlatform)` in `server/src/services/social-routing.ts` must
narrow: refuse social jobs on Linux **only when the job will open a browser**. With
`FB_DISCOVERY=apify` and `FB_ENRICH=stub`, a Facebook job is pure HTTP and must be allowed. The
Linux worker's `PLATFORM_EXCLUDE=facebook` env setting is relaxed in the same change.

### 3.7 Cost

Apify's free tier caps the search actor at 20 results per run and 1 run per 24h — unusable. Budget
~$39/mo for a paid plan plus per-result spend. This is a prerequisite, not an implementation task.

## 4. Stage B — AdsPower engagement

### 4.1 Schema

Migration **057**: `ALTER TABLE social_accounts ADD COLUMN adspower_profile_id text;`

Nullable. An account without it uses the existing Brave path — that is the rollback.

### 4.2 Client module

New `tools/scraper/shared/adspower.py`:

```python
def start_profile(profile_id: str) -> dict   # {'debugger_address': …, 'webdriver_path': …}
def stop_profile(profile_id: str) -> None
def is_running(profile_id: str) -> bool
```

- Base URL from `ADSPOWER_API_BASE`, default `http://local.adspower.net:50325`.
- `GET /api/v1/browser/start?user_id={id}` and `/api/v1/browser/stop?user_id={id}`.
- Throttled to 1 request/second (AdsPower's documented limit).
- Optional `ADSPOWER_API_KEY` for their headless "api-key mode" — the mode the EC2 phase needs.
- Exact response field names and the plan tier that unlocks Local API must be verified against a
  live install during implementation; the docs are ambiguous on both.

### 4.3 Opener branch

`open_uc_driver()` in `tools/scraper/shared/uc_driver.py` gains **one branch at the top**: when
`ADSPOWER_PROFILE_ID` is set, start that profile, attach Selenium to the returned debugger address
using AdsPower's bundled chromedriver, and return the driver. Otherwise fall through to the
existing body **verbatim**.

This is the whole integration. Every existing caller inherits it with no edit:

- `facebook.py:_open_driver` (scraping, `post_comment`)
- `instagram.py`
- `login_flows.py` (both interactive-login entry points)
- the CDP browse-stream / "Open as James (hosted)" path

The file's header warns that its body is a byte-for-byte move of FB's production logic and must not
change without a live regression scrape. Adding a branch above it honours that.

### 4.4 Env plumbing

`socialProfileEnv(platform, socialAccountId)` in `social-routing.ts` currently returns
`{ FB_PROFILE_DIR: 'C:\\fb-profiles\\<id>' }`. It gains `ADSPOWER_PROFILE_ID` when the account row
carries one — the same per-job mechanism, so no new plumbing concept is introduced.

### 4.5 Operator runbook (phase 1, desktop, no proxy)

1. Install AdsPower on the Windows desktop. Confirm Local API is enabled on the plan.
2. Create one profile: Windows fingerprint, **no proxy** (the home PH IP is residential and already
   trusted — this is what works today).
3. Log `james@optiratesolutions.net` in by hand. **Expect a new-device checkpoint** — the
   fingerprint has changed from the Brave profile. Clear it.
4. Let the profile sit idle ~24h. Do not scrape immediately after a checkpoint.
5. Record the profile id on the `social_accounts` row.
6. Validate: post one AI-drafted comment on the known GB test lead (Radek Andel,
   `11802d64-c161-46ab-9033-1f00588f329c`) and confirm it lands on the real post and the account
   stays `active`.

## 5. Configuration

| Variable | Purpose | Default |
|---|---|---|
| `APIFY_API_TOKEN` | Apify auth | unset — required for Stage A |
| `APIFY_FB_SEARCH_ACTOR` | keyword post/group search actor | `scrapeforge/facebook-search-posts` |
| `APIFY_FB_GROUP_POSTS_ACTOR` | public group post actor | `data-slayer/facebook-group-posts` |
| `FB_DISCOVERY` | `apify` \| `browser` | `apify` |
| `FB_ENRICH` | `stub` \| `browser` | `stub` |
| `ADSPOWER_API_BASE` | Local API base URL | `http://local.adspower.net:50325` |
| `ADSPOWER_API_KEY` | api-key mode auth | unset |
| `ADSPOWER_PROFILE_ID` | per-job, set from the account row | unset |

## 6. Testing

**Stage A**
- Unit: `apify.py` against recorded fixtures — success, 402, 5xx-then-success, missing token.
- Unit: the field mapping, including a result missing optional fields.
- Unit: the router honours `FB_DISCOVERY` and leaves the browser branch untouched.
- Unit: `FB_ENRICH=stub` produces a valid `AuthorLead` and opens no browser.
- Unit: `shouldRefuseSocialOnLinux` allows an Apify-mode FB job and still refuses a browser-mode one.
- **Live smoke, mandatory before merge** (per the project's standing rule for scraper changes): one
  real `--action search-posts` run against the live actor, then the full
  search-posts → enrich-authors → `upsert_leads.py` chain, confirming rows in `leads` and
  `lead_platform_presences` with `platform='facebook'`. Record the qualified-lead yield.

**Stage B**
- Unit: `adspower.py` against a mocked Local API — start, stop, throttle, error paths.
- Unit: `open_uc_driver` takes the AdsPower branch only when `ADSPOWER_PROFILE_ID` is set, and the
  fall-through path is unchanged.
- Live: the runbook in §4.5. No automated substitute exists for "did the comment land and did the
  account survive".

## 7. Rollout and rollback

Stage A ships and is validated alone — it carries no account risk and restores lead flow on its
own. Stage B follows.

Rollback for each is a single env var: `FB_DISCOVERY=browser` restores the browser discovery path;
clearing `adspower_profile_id` on the account row restores the Brave opener. No migration is
reversed, no code is deleted.

## 8. Out of scope

Deferred until Stage A and Stage B are proven in production: Instagram migration, proxy purchase,
the multi-account country pool, installing AdsPower on the Windows EC2, AdsPower team profile sync,
and per-user authentication in the CRM.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Community Apify actor breaks or is delisted | Actor id is an env var; `scraper_one/facebook-posts-search` identified as alternate |
| Open-feed ad noise makes yield uneconomic | Gemini classifier runs on this path; measure yield on the first 1,000 results before scaling spend; group-first via `search_type: groups` as the fallback strategy |
| Apify author data too thin for a useful lead | `FB_ENRICH=browser` re-enables profile visits for a subset |
| Moving james@ into AdsPower triggers a checkpoint | Expected, not a failure — runbook accounts for it and allows a 24h settle |
| AdsPower Local API is plan-gated | Confirm with AdsPower support before purchase; Stage A does not depend on it |
| AdsPower Local API requires the desktop app on the same host | Accepted — the engagement half stays host-bound, unlike Apify |
