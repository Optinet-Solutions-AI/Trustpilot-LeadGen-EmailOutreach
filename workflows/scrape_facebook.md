# Workflow: Scrape Facebook

**Objective:** Discover consumer leads asking for a service ("need a plumber recommendation" — see the phrasing warning under Network strategy before choosing a query) across public Facebook posts, build author leads, and upsert via the multi-platform path — without opening a browser or risking a connected account.

Facebook used to require a logged-in `undetected-chromedriver` session for every step, which capped throughput at the `social_accounts.daily_cap` (real ban risk, Windows-only, one scrape/day in practice). Since 2026-07-31 discovery and author enrichment default to **Apify** — a cookieless actor platform that returns public post/group data over plain HTTP. No account, no cap, no fingerprint, and it runs on Cloud Run and Linux workers (see `server/src/services/social-routing.ts` → `facebookJobUsesBrowser` / `shouldRefuseSocialOnLinux`). The browser path still exists and is still required for two things the Apify actors cannot see: **private groups** and **engagement** (opening a lead's post, commenting, DMs).

---

## Inputs

| Filter | Required | Notes |
|---|---|---|
| `query` | yes (open-feed mode) | Free-text search term. Required by `run.py --action search-posts`; ignored when `niche`+`location` drive group-first mode. |
| `niche` | yes (group-first mode) | Service term, e.g. `plumber`. Auto-translated to the local language of `location` via Gemini before searching (English-primary countries skip translation). |
| `location` | yes (group-first mode) | City name. Resolved to an ISO-2 country for account pinning, proxy routing, and result filtering. |
| `lead_type` | no | `consumers` (default) runs the asking-vs-business filter chain; anything else skips it. |
| `groups_only` | no | **Two different defaults, on purpose — know which one applies.** The platform manifest / dashboard default is **`false`** (`server/src/routes/scrape.ts`), and `scrape-runner.ts` always sends the key explicitly, so **any job started from the UI defaults to open-feed**. The Python plugin's own default is **`true`**, which only takes effect on direct `run.py` CLI runs and direct-DB-insert jobs that omit the key. Either way it makes little practical difference today: group mode is non-functional (see Network strategy) and the code falls back to open-feed. |
| `max_results` | no | Default 50. **Free Apify plan hard-caps this at 20 regardless of what you pass.** |
| `start_date` / `end_date` | no | Recency window passed through to the search actor. **`start_date` is NOT reachable from the dashboard**: the manifest exposes `date_from` / `date_to`, nothing maps those onto `start_date`, so the Apify router never sees a UI-supplied window. Usable only from a direct CLI `--filters` payload or a direct-DB-insert job that spells the key `start_date`. |
| `generic_group_cap` | no | Default 5 — caps how many non-obviously-relevant discovered groups get searched per run (tier-0 groups after relevance ranking). |
| `exclude_businesses` / `asking_only` | no | Default ON for English markets, OFF for non-English (the multilingual Gemini classifier is the sole gate there). Explicit value always wins. |
| `use_llm_classifier` | no | Default `true` — final Gemini consumer-vs-business pass after the substring filters. |

---

## Discovery modes — `FB_DISCOVERY`

| Value | Behavior | When to use |
|---|---|---|
| `apify` (default) | Cookieless Apify actor call. No account, no cap, no browser — runs on Cloud Run / Linux workers. **Open-feed keyword search only in practice** — both community group actors are non-functional (see Network strategy), so group mode falls back to open feed. | Everything except group-scoped and private-group work. |
| `browser` | Original logged-in `undetected-chromedriver` crawl via `_sync_group_first_scrape` / `_sync_search_posts`. Claims a `social_accounts` row, burns daily/hourly cap, Windows/residential-IP only. | **Any group-scoped work at all** — private groups the account has joined (Apify's actors are cookieless and structurally cannot see private content) *and*, as of 2026-08-03, public groups too, because both community group actors return 0 items. |

Read via `_discovery_source()` in `tools/scraper/platforms/facebook.py`, `(os.environ.get('FB_DISCOVERY') or 'apify').strip().lower()`. The TypeScript routing helper (`facebookJobUsesBrowser` in `server/src/services/social-routing.ts`) mirrors the same `or` + `.trim().toLowerCase()` fallback so the two sides never disagree about whether a job needs a browser.

## Author enrichment — `FB_ENRICH`

| Value | Behavior | Cost |
|---|---|---|
| `stub` (default) | `_stub_enrich_authors()` builds an `AuthorLead` straight from the `PostStub`s Apify already returned (display name + profile URL). Every post from the same author is kept and attached as a `posts` entry — `upsert_leads.py` writes each into `lead_platform_posts`, which is what powers "we saw your post about X" personalization. | Zero — no browser, no account. |
| `browser` | Visits each author's profile with a logged-in account to pull `website_url` / `email` / `bio_excerpt`. | One account-quota visit per author. These fields are rare on personal profiles, so the payoff is usually not worth the quota — opt in only when a campaign genuinely needs them. |

`run.py --action enrich-authors` calls `platform.enrich_authors(stubs, ...)`, which checks `_enrich_mode()` and dispatches accordingly.

---

## Tools

| Step | Tool |
|---|---|
| Post/group search | `tools/scraper/platforms/facebook.py` → `FacebookScraper.search_posts()` — routes to Apify or the browser crawl per `FB_DISCOVERY` |
| Apify actor I/O | `tools/scraper/shared/apify.py` → `run_actor()` (run-sync-get-dataset-items, retries transport/5xx, raises on 402/4xx) |
| Apify input/output mapping | `tools/scraper/platforms/facebook_apify.py` — pure functions: `build_search_input()`, `build_group_posts_input()`, `post_to_stub()` |
| Author enrichment | `tools/scraper/platforms/facebook.py` → `FacebookScraper.enrich_authors()` — routes to `_stub_enrich_authors()` or the browser profile-visit path per `FB_ENRICH` |
| Consumer/business classifier | `tools/scraper/shared/social_nlp.py` → `classify_consumer_posts_with_gemini()` |
| Niche translation | `facebook.py` → `_translate_niche_to_local()` (Gemini, cached per language+niche for the process lifetime) |
| Engagement (comment/DM) | `facebook.py` → `post_comment()` — still browser-only, still claims a `social_accounts` row; optionally routed through AdsPower when the account carries an `adspower_profile_id` (see `tools/scraper/shared/adspower.py`) |
| Upsert | `tools/db/upsert_leads.py` → `_upsert_nontrustpilot_lead` (writes `lead_platform_presences(platform='facebook')` + `lead_platform_posts`) |

---

## Network strategy

> ### ⚠️ Read this first — query phrasing is the biggest lever on cost per lead (2026-08-03 finding)
>
> Geo-stuffed, advertisement-shaped phrasings like **`"looking for a plumber in Manchester"`** returned **0 usable results out of 20** — every item was a business advert. Intent-shaped phrasings like **`"need a plumber recommendation"`** returned genuine consumer asks. Prefer short, natural "someone asking a friend" phrasing over keyword-stuffed geo+service strings when building `query` (or `niche`+`location`). On a paid plan this single choice is the difference between a viable and a worthless cost per lead — nothing else in this document moves the number as much.

**Two backends, picked by `FB_DISCOVERY`:**

| Path | Reaches | Cost |
|---|---|---|
| Apify `scrapeforge/facebook-search-posts` (build 1.0.19) | Public post/group search | $2.59 / 1,000 results |
| Apify `data-slayer/facebook-group-posts` (build 1.0.5) | Posts inside a specific public group (`groupId`) | $5.00 / 1,000 results |
| Browser crawl (`undetected-chromedriver`) | Anything the connected account can see, including private groups it has joined | One `social_accounts` daily/hourly slot per session |

**Actor input keys (verified against the live schema 2026-07-31 — do not trust the actor's prose docs):**

- `scrapeforge/facebook-search-posts` — required key is **`query`** (NOT `search_query`). Other inputs: `search_type` (`posts`/`groups`), `max_results`, `start_date`, `end_date`, `recent_posts`, `location_uid` (unused here — location already rides inside the query string).
- `data-slayer/facebook-group-posts` — `groupId`, `maxPages`.

If either actor is swapped via `APIFY_FB_SEARCH_ACTOR` / `APIFY_FB_GROUP_POSTS_ACTOR`, re-probe with `apify.get_actor_input_schema(actor_id)` before trusting a new input shape — community actors document inputs in prose that does not always match the real JSON keys.

**Apify FREE plan: 20 results per run, 1 run per 24 hours.** This is a hard platform limit, not something the code can work around — `max_results` above 20 is silently truncated by Apify itself. A paid plan (~$39/mo) is required for real volume. Every `run_actor()` call is retried on transport errors and 5xx, and raises `ApifyCreditError` (402) or `ApifyError` (anything else 4xx/malformed) rather than ever returning an empty list for a billing/config fault — an empty list must always mean "genuinely no results."

**Open-feed keyword search is ad-heavy, and open-feed is all you get.** The `/search` results are dominated by business posts phrased as consumer asks ("Looking for a plumber? We've got you covered!"). Group-first discovery would in principle be cleaner, but **it does not work with the current actors** (see two paragraphs down) — setting `groups_only=true` does not buy you a cleaner feed, it just makes the run attempt group discovery, fail, and fall back to the same open-feed search. So the two real levers on precision are (1) **query phrasing** — see the phrasing note below, it is the single biggest one — and (2) the Gemini consumer classifier (`social_nlp.classify_consumer_posts_with_gemini`), which is the actual gate. **Measure qualified yield (`returned` from Apify vs. final stub count after the classifier) before scaling spend**, especially on a paid plan where a bad ratio burns real money.

**Private groups remain invisible to the Apify actors** — they are cookieless by design and can only enumerate what's public. There is no workaround inside the Apify path; it is `FB_DISCOVERY=browser` with an account that has already joined the group, or nothing.

**Both community group actors are non-functional (live-tested 2026-08-03).** `scrapeforge/facebook-search-posts` with `search_type=groups` returned **0 items** even for a deliberately broad one-word query (`"Manchester"`) — `groups` is a documented enum value in the actor's inputSchema, but the actor does not deliver on it. `data-slayer/facebook-group-posts` returned **0 items** even for its own documented default input (`groupId: "new york"`). `search_type=posts` (open-feed) works fine — it returned 20 real, well-formed consumer posts in the same test session. **Practical consequence: Apify discovery is open-feed only right now**, regardless of the `groups_only` filter — the code still attempts group discovery first (actor IDs are env-swappable via `APIFY_FB_SEARCH_ACTOR`/`APIFY_FB_GROUP_POSTS_ACTOR`, so the capability stays wired for whenever a working group actor turns up), but when discovery comes back empty it emits `apify_groups_unavailable` (actor id + reason) and falls back to `_search_posts_via_apify` automatically — the job still produces leads instead of silently returning zero. Any work that genuinely needs group-scoped or private-group coverage still requires `FB_DISCOVERY=browser` with an account that has joined the group.

(Query-phrasing guidance is at the top of this section — it is the first thing to get right.)

---

## Mapping Apify output → `PostStub`

`facebook_apify.post_to_stub()` drops any item missing a post URL or an author profile URL — both are required downstream (`post_url` identifies the lead's post, `author_profile_url` keys `lead_platform_presences`).

| `PostStub` field | Source |
|---|---|
| `post_url` | `item.url` or `item.post_url` |
| `author_profile_url` | `item.user.profile_url` or `item.user.url` |
| `author_handle` | `item.user.id`, else derived from the profile URL path (`profile.php?id=123` → `123`) |
| `content_excerpt` | `item.message` or `item.text` |
| `posted_at` | `item.timestamp` or `item.published_at`. The live actor returns a **Unix epoch integer**, which `_to_iso8601_timestamp()` converts to an ISO-8601 UTC string; already-ISO strings pass through unchanged. |
| `media_urls` | `item.image.uri` first, then the video fields (`item.video_files` / `item.video` / `item.video_thumbnail`). **There is no `attachments` key in the real actor payload** (verified against live output 2026-08-03) — `item.attachments[].url` is kept only as a last-resort fallback for older/alternative actor shapes, so do not rely on it. |
| `display_name` (stub-enrich only, not part of the `PostStub` contract) | `item.user.name` |

---

## Expected output

**`PostStub`** (from `search-posts`):
```python
{
  'platform': 'facebook',
  'post_url': 'https://www.facebook.com/groups/<gid>/posts/<pid>/',
  'author_profile_url': 'https://www.facebook.com/<handle>',
  'author_handle': '<handle-or-numeric-id>',
  'content_excerpt': 'Looking for a plumber in Manchester, anyone recommend?',
  'posted_at': '2026-07-30T12:00:00Z',
  'media_urls': [],
  'group_id': '<gid or None>',
  'group_name': '<name or None>',
  'country': 'GB',
  'category': 'plumber',
  'location_confidence': 'confirmed_city',
}
```

**`AuthorLead`** (from `enrich-authors`, stub mode):
```python
{
  'platform': 'facebook',
  'profile_url': 'https://www.facebook.com/<handle>',
  'author_handle': '<handle>',
  'display_name': 'Jane Doe',
  'company_name': 'Jane Doe',   # mapped to leads.company_name by upsert_leads.py
  'website_url': None,
  'email': None,
  'is_business_profile': False,
  'posts': [ /* every PostStub observed for this author */ ],
}
```

---

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `ApifyError: APIFY_API_TOKEN is not set` | Missing env var | Set `APIFY_API_TOKEN` in `.env` (or Cloud Run env) |
| `ApifyCreditError` (HTTP 402) | Free-plan run limit hit (20 results / 1 run per 24h), or paid credit exhausted | Wait for the 24h window, or upgrade the Apify plan |
| `ApifyError: ... rejected the request — HTTP 4xx` | Actor input shape changed, or a bad actor id in `APIFY_FB_SEARCH_ACTOR` / `APIFY_FB_GROUP_POSTS_ACTOR` | Re-probe with `apify.get_actor_input_schema()`; fix `facebook_apify.build_search_input()` / `build_group_posts_input()` |
| Every post looks like a business ad | Advertisement-shaped query phrasing, and/or the Gemini classifier is disabled | **Rephrase the query** to an intent-shaped ask (`"need a plumber recommendation"`, not `"looking for a plumber in Manchester"`) — this is the biggest fix by far; and confirm `GEMINI_API_KEY` is set so `use_llm_classifier` actually runs. **`groups_only=true` is NOT a fix** — both group actors are non-functional, so the run just falls back to the same open-feed search. Genuine group-scoped coverage needs `FB_DISCOVERY=browser` with an account that has joined the groups |
| `RuntimeError: Cannot determine the scrape's target country` | Browser mode with no resolvable `country`/`location` in filters | Pass a `country`, or a `location` that maps via `_extract_country_from_excerpt` |
| `RuntimeError: No active Facebook account pinned to country X` (browser mode only) | No `social_accounts` row active for that country | Connect/pin an account in Social Accounts |
| Group posts return 0 for a real public group | `data-slayer/facebook-group-posts` skipped that group and emitted `group_skipped` | Non-fatal by design — check the `reason` in the progress event; other groups in the batch still run |
| `apify_groups_unavailable` progress event, run still completes with leads | Group discovery (`_discover_group_ids_via_apify`) returned no groups — both community group actors are known non-functional as of 2026-08-03 | Expected today; not an error. The run auto-falls-back to the open-feed search. If you need real group-scoped results, use `FB_DISCOVERY=browser` |
| A lead lands with `company_name = "(N) Facebook"` | Historical bug in the browser-path tab-title scrape (fixed) — the tab title, not the person's name, got written to `leads.company_name` | Should not reproduce; `_is_non_name()` in `facebook.py` filters `(N) Facebook` / `Facebook` / `Log in to Facebook` titles before falling back to the handle. If it recurs, it's a regression — file it, don't just clean the row |

---

## Env vars

| Variable | Required | Notes |
|---|---|---|
| `APIFY_API_TOKEN` | Yes, for `FB_DISCOVERY=apify` (the default) | No default — every call raises `ApifyError` without it, on purpose (an empty result set must never look like a misconfigured token) |
| `APIFY_FB_SEARCH_ACTOR` | No | Default `scrapeforge/facebook-search-posts` |
| `APIFY_FB_GROUP_POSTS_ACTOR` | No | Default `data-slayer/facebook-group-posts` |
| `FB_DISCOVERY` | No | Default `apify`; set `browser` for private-group crawls |
| `FB_ENRICH` | No | Default `stub`; set `browser` only when a campaign needs bio/website/email |
| `GEMINI_API_KEY` (or `NEXT_PUBLIC_GEMINI_API_KEY`) | Recommended | Powers the consumer/business classifier and niche translation; falls back to substring-only filtering when unset |
| `RESIDENTIAL_PROXY_*` | Only for `FB_DISCOVERY=browser` / engagement | Same shared residential proxy used by IG and Yelp's relay path |
| `FB_PROFILE_DIR` | Only for `FB_DISCOVERY=browser` / engagement | Persistent logged-in Chrome profile |
| `ADSPOWER_PROFILE_ID` | No — and **do not put it in `.env`** | One-shot **command-line** override naming a single AdsPower profile for the **Facebook** browser/engagement path. Normally the profile id comes from the claimed `social_accounts` row (`adspower_profile_id`); this env var is only the fallback for callers with no account row (interactive login, the browse worker). It is a **process-global naming exactly one profile**, so putting it in `.env` makes every Facebook session on the host share that one profile. Set it inline for the one command that needs it (`ADSPOWER_PROFILE_ID=<id> .venv/Scripts/python.exe ...`) and let it die with the process. It is scoped to Facebook only — Instagram (`IG_PROFILE_DIR`) ignores it. |

`ADSPOWER_API_BASE` / `ADSPOWER_API_KEY` are consumed by the engagement path (`post_comment()` → `_open_driver()`), not discovery — see the AdsPower section of `CLAUDE.md`'s environment table for the documented-vs-real host gotcha.

---

## Smoke-testing before merge

Per the project's standing rule, no scraper change ships on fixture tests alone. Discovery-only smoke:

```bash
.venv/Scripts/python.exe -m tools.scraper.run --platform facebook --action search-posts \
  --filters '{"query":"need a plumber recommendation","niche":"plumber","location":"Manchester","lead_type":"consumers","groups_only":false,"max_results":20}' \
  --output .tmp/fb_apify_smoke.json
```

Confirm: `PROGRESS:apify_run` with a non-zero `returned`, then `PROGRESS:search_done`, and the output file contains stubs with populated `post_url`, `author_profile_url`, `content_excerpt`. **Record the yield** (`returned` vs. the final stub count after the Gemini filter) — that ratio is the number to watch before scaling Apify spend.

**Respect the free-plan limit before running this** — 20 results per run, 1 run per 24 hours. Running it twice in a day burns the day's only shot at live validation. With only one shot, **use an intent-shaped query** (as above) — a geo-stuffed advert-shaped query wastes the whole day's run on adverts.

Full chain to the database (only after the discovery smoke above looks right):

```bash
.venv/Scripts/python.exe -m tools.scraper.run --platform facebook --action enrich-authors \
  --input .tmp/fb_apify_smoke.json --output .tmp/fb_apify_leads.json

.venv/Scripts/python.exe tools/db/upsert_leads.py --input .tmp/fb_apify_leads.json
```

Confirm in Supabase: new rows in `leads` and `lead_platform_presences` with `platform='facebook'`, and no row with `company_name` matching `(N) Facebook`.
