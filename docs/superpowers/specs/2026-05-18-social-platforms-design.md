# Social Platforms (Facebook, Instagram, FB Groups) — Design Spec

**Date:** 2026-05-18
**Status:** Draft — pending implementation plan
**Goal:** Extend the scraper to surface leads from social platforms (Facebook Pages, Facebook Groups, Instagram business profiles) in addition to the existing review platforms (Trustpilot, Yelp, TripAdvisor). The key new capability is **searching INSIDE posts and groups** for keywords and capturing post authors / group admins as leads — not just enumerating static page directories.

This is the design phase. Code scaffolding committed in this round:
- [`tools/scraper/platforms/_social_base.py`](../../../tools/scraper/platforms/_social_base.py) — `SocialPlatformScraper` ABC.
- [`supabase/migrations/037_social_platforms_skeleton.sql`](../../../supabase/migrations/037_social_platforms_skeleton.sql) — **drafted, not applied.**

Implementation (the FacebookScraper / InstagramScraper subclasses, login flow UI, captcha recovery, frontend search wiring) happens in a future session.

---

## Why a new contract sibling, not just another `BasePlatformScraper` subclass?

Review platforms share a clean three-step shape: paginate listing → enrich profiles → optionally refresh taxonomy. Social platforms diverge on three axes that justify additional contract surface:

| Axis | Review platforms (current) | Social platforms (this spec) |
|---|---|---|
| **Discovery primitive** | Static category pagination | Keyword search across posts/groups/pages |
| **Lead identity** | Business == profile URL | Author handle, group admin, page owner — same person across many posts |
| **Access model** | Anonymous IP fetch (or proxy) | Logged-in session per account; daily cap; ban risk |

A subclass with new abstract methods isolates social concerns without bending the review contract:

```python
class SocialPlatformScraper(BasePlatformScraper):
    supports_post_search: bool = False
    supports_group_search: bool = False
    async def search_posts(query, filters)  -> list[PostStub]
    async def search_groups(query, filters) -> list[GroupStub]
    async def enrich_authors(post_stubs)    -> list[AuthorLead]
```

`scrape_listing` / `enrich_profiles` remain available for Page/Profile enumeration that doesn't go through search.

---

## In-scope platforms (v1)

1. **Facebook Pages** — enumerate pages by category; capture page owner contact info.
2. **Facebook Groups** — keyword search within groups; capture post authors (cold outreach DM target) and group admins.
3. **Instagram business profiles** — keyword + hashtag search across posts; capture business-profile owners.

Out-of-scope for v1:
- DMing the lead from inside the scraper. DM sending belongs in the email-equivalent send lane and gets its own ADR.
- LinkedIn, X/Twitter, TikTok — additive once the FB/IG pattern is proven.
- Comment-thread scraping — high cost-per-lead vs post search; revisit if conversion data justifies.
- Real-time monitoring — v1 is operator-triggered batch runs.

---

## Lead model — post authors are first-class

```
                       POST observed in a group/feed
                            │
                            ▼
                    PostStub (author_handle, post_url, group_id, excerpt)
                            │
                            ▼ enrich_authors() dedupes by author_profile_url
                            │
                            ▼
                    AuthorLead (profile_url, display_name, bio link, location)
                            │
                            ▼ upsert_leads.py / _upsert_nontrustpilot_lead
                            │
                            ▼
       leads row  ────────► lead_platform_presences(platform, profile_url)
                            │
                            ▼
                            One row per post in lead_platform_posts
                            (links the lead to "we saw them in posts X, Y, Z")
```

Template engine gets two new tokens for personalization:
- `{{post_excerpt}}` — most recent observed post body, truncated.
- `{{post_url}}` — permalink (drives "we saw your post about [topic]" framing).

---

## Anti-bot & account management

### Login is mandatory

Every social search needs a logged-in session. We mirror the `email_accounts` pattern with a new `social_accounts` table (migration 037 — drafted):

```sql
social_accounts (
    platform        text CHECK (platform IN ('facebook','instagram')),
    handle          text,
    encrypted_cookies   text,           -- pgp_sym_encrypt at app layer
    status          'active'|'checkpoint'|'banned'|'disabled',
    daily_cap       int DEFAULT 50,
    hourly_cap      int DEFAULT 10,
    used_today / used_this_hour int,
    last_login_at / last_checkpoint_at timestamptz,
    ...
)
```

Operators connect accounts in-app via a "Connect Facebook" / "Connect Instagram" flow (mirrors the Gmail OAuth pattern). The browser shell stays open for the operator to complete login + 2FA; the cookie jar is captured server-side and stored encrypted. Status `checkpoint` triggers an in-app recovery UI that re-opens the browser for the operator to clear the captcha manually.

### Browser stack

- **`undetected-chromium`** (Python `undetected-chromedriver`) — not the same as Playwright + stealth; necessary for FB/IG which fingerprint Playwright's CDP signals.
- **Residential proxy** — already have ScrapingBee `stealth_proxy` available; for FB/IG we likely need a different vendor with per-account stickiness (Bright Data, Smartproxy). Decision deferred to implementation.
- **Per-account browser context** — never reuse cookies across accounts; switch UA + viewport per account.

### Rate budgets

Per account, defaults that keep us comfortably under ban thresholds (numbers from public ToS research, validate empirically):

- 50 post searches / day
- 10 group searches / day
- 100 author profile fetches / day
- Sleep 5-15s between actions within a session
- Max 30min continuous session before tearing down and rotating accounts

The orchestrator picks the next account from `social_accounts` where `status='active'` and `used_today < daily_cap`. Accounts run out → scrape stalls until tomorrow OR operator adds another account.

### Captcha checkpoint flow

```
                 worker hits captcha during search
                            │
                            ▼
              UPDATE social_accounts SET status='checkpoint',
                last_checkpoint_at=now(), checkpoint_reason=…
                            │
                            ▼
              FAILED:checkpoint|<account>|<url> emitted (worker stops the run)
                            │
                            ▼
              Operator notification (planned: in-app + email)
                            │
                            ▼
              Operator clicks "Recover account" → server opens a
              non-headless browser tab pre-loaded with the account cookies
                            │
                            ▼
              Operator completes captcha → cookies refreshed →
              UPDATE social_accounts SET status='active'
                            │
                            ▼
              Worker resumes on next poll
```

The cost of human intervention is the binding constraint on social-scrape throughput. v1 accepts it; v2 may explore captcha-solving APIs (2captcha, Anti-Captcha).

---

## Data flow into the existing schema

Re-use the multi-platform tables introduced in migration 032. The new pieces in migration 037:

**`lead_platform_posts`** — one row per `(platform, post_url)`:
```sql
lead_platform_posts (
    lead_id     uuid → leads,
    platform    text,
    post_url    text,
    group_id / group_name  optional,
    content_excerpt        text,
    posted_at              timestamptz,
    media_urls             jsonb,
    UNIQUE (platform, post_url)
)
```

**Augment `lead_platform_presences`** with social-specific columns (nullable, additive):
- `author_handle text` — the @username at scrape time
- `follower_count int`
- `is_business_profile boolean`

A FacebookScraper running `enrich_authors` produces enriched dicts shaped like:
```python
{
    'platform': 'facebook',
    'profile_url': 'https://www.facebook.com/<handle>',
    'company_name': '<display_name>',
    'website_url': '<bio link or None>',
    'phone': None,                   # rarely on profiles
    'author_handle': '<handle>',
    'follower_count': 1234,
    'is_business_profile': True,
    'screenshot_path': '<storage URL>',
}
```

The standard `_upsert_nontrustpilot_lead` path keys on `(platform, profile_url)` — same as Yelp/TripAdvisor. Posts attach via a separate insert into `lead_platform_posts`.

---

## Pipeline

### Operator UX
1. Operator picks "Facebook" or "Instagram" in the platform dropdown.
2. UI swaps to the social form variant (revealed by `supports_post_search=true` in the manifest):
   - **Search mode**: free-text keyword + optional groups-only checkbox.
   - **Page mode**: category dropdown (mirrors the Trustpilot UX, returns Page owners).
3. Optional: pick which connected `social_accounts` to allow the run to consume.
4. Click "Start Scrape" → standard `scrape_jobs` flow.

### Worker
1. `scrape-runner.ts` spawns `run.py --platform facebook --action search-posts` (new `--action`).
2. Plugin claims a `social_accounts` row → loads cookies into undetected-chromium → executes the search.
3. Emits `PROGRESS:search_page:<n>/<total>` per result page.
4. For each post → `PROGRESS:post_found:<url>` → flush PostStubs.
5. Then `--action enrich-authors` runs over the PostStub batch, deduping by author and producing AuthorLeads.
6. Standard upsert path; the SSE bridge shows results live in the Scrape page.

### CLI extension

`tools/scraper/run.py` grows two `--action` values:
- `search-posts` — input filters include `query` (str); output is PostStubs.
- `enrich-authors` — input is the PostStub JSON; output is AuthorLeads.

Backward-compatible — existing `list` / `enrich` / `discover-taxonomy` actions are unchanged.

---

## Risks

1. **ToS exposure.** FB/IG ToS prohibits automation. Mitigation: keep volume per-account low (under the public threshold for "normal browsing"), no scraping of private content the account doesn't have access to, never resell raw FB data. Risk owner: legal.
2. **Account ban.** Even with rate budgets, accounts can be flagged. Mitigation: per-account daily caps, residential proxies with sticky IPs, multiple accounts rotated, manual checkpoint recovery. Expected steady-state: 1 account ban every 1-3 months at the volume budgets above.
3. **Captcha frequency** could make throughput uneconomic. Mitigation: empirical measurement during v1 implementation; if captcha rate >1/hour per account, add captcha-solving service.
4. **Schema drift.** FB/IG redesign their DOM aggressively. Mitigation: lean on Graph API where possible (Pages and Page Insights have official APIs) and capture HTML fixtures for regression testing.
5. **Lead quality.** Cold-outreach to post authors via email is harder than to claimed Yelp businesses — many social profiles have no bio link. v1 surfaces phone + DM URL; v2 may add DM sending as a campaign action.

---

## Out of scope for v1

- DM sending (separate sender lane, separate ADR)
- LinkedIn, X/Twitter, TikTok
- Comment scraping
- Real-time post monitoring
- Cross-platform identity resolution (e.g. matching a Yelp business to its FB page) — keep separate `lead_platform_presences` rows; let humans dedupe manually until we have signal that auto-merge is worth the false-positive cost.

---

## Implementation order (preview)

1. Apply migration 037 (social_accounts + lead_platform_posts).
2. Account connection UI: "Connect Facebook" + "Connect Instagram" buttons that spawn a server-side browser the operator drives via screen-share UX (mirrors the planned social recovery flow).
3. `tools/scraper/shared/session_store.py` — load/save cookies per `social_accounts.id`.
4. `tools/scraper/shared/login_flows.py` — handles the non-headless cookie-capture session + the checkpoint recovery session.
5. `FacebookScraper(SocialPlatformScraper)` implementing search_posts + enrich_authors.
6. Register + manifest in `platforms/__init__.py` + `scrape.ts`.
7. Extend `run.py` with `--action search-posts|enrich-authors`.
8. Frontend: dynamic form variant for social search + `social_accounts` management page.
9. `InstagramScraper` (same shape, mobile-UA, more captcha-prone).
10. Captcha recovery UI + notification.
11. Template engine: `{{post_excerpt}}`, `{{post_url}}` tokens.

Each step lands in a separate PR with its own implementation plan.
