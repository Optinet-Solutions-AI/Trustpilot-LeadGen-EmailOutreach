# FB Auto-Join Groups — Design Spec

**Date:** 2026-08-10
**Status:** Approved design, pending implementation plan
**Owner path:** browser/AdsPower (owner-local; loopback-bound), country-pinned account pool

## Goal

Automatically join the Facebook group candidates the scraper has already discovered
and relevance-labelled, so the account becomes a member of the customer-facing groups
where consumer leads actually post. Joining is the missing step: discovery, relevance
tiering, and the `customers`/`trades` audience label already populate
`fb_group_candidates`; today the operator clicks Join by hand.

This is deliberately small and low-risk: it rides existing infrastructure and only adds
a capped, jittered "click Join and record the outcome" step on the logged-in browser.

## Non-goals

- **No group discovery.** Consumes the existing `fb_group_candidates` queue; does not
  search for new groups (that is `_sync_discover_groups`, unchanged).
- **No auto-answering membership questions.** Question-gated groups are skipped — bot-like
  and needs human judgement.
- **No commenting/DMing.** Separate engagement path.
- **One country per run.** No cross-country batching.
- **Facebook only.** Instagram out of scope.

## Trigger & entry point

Standalone, on-demand CLI action mirroring the existing social actions:

```
python -m tools.scraper.run --platform facebook --action join-groups \
    --filters '{"country":"GB"}'
```

→ `FacebookScraper.join_groups(filters)`. Owner-local (AdsPower is loopback-bound). Not
chained to scrapes — maximum control over pacing/safety. New action registered in
`run.py`'s `--action` choices with a `_run_join_groups(args)` handler.

## Account resolution

Resolve the single active Facebook account bound to the target country
(`social_accounts` where `platform='facebook'`, `status='active'`, `country=<CC>`, with a
non-null `adspower_profile_id`). Reuse the existing claim/resolve path
(`_claim_or_raise` / the pool resolver semantics). **Fail-closed:** if no eligible
account exists, raise — never fall back to a wrong-country or unbound account. For GB this
is account `1734c719-4d71-4929-8b42-84d232f46ec5` → AdsPower profile `k1flq0bx`.

## Candidate selection (the "related to scraped niche" rule)

Every row in `fb_group_candidates` already carries the FB-scrape `niche` it was discovered
under, so membership in the queue *is* the "related to a scraped niche" guarantee. The
effective selection is:

```
status         = 'candidate'
audience        = 'customers'          -- Gemini-labelled; excludes 'trades'/'unclear'
relevance_tier >= 1                     -- name matches niche/location (tier 2 > 1 > 0)
location country-token = target CC      -- location is '<City>, <ISO2>' or bare ISO2;
                                          match the ISO2 token (after the comma, or the
                                          bare value) == CC — not a loose substring
order by relevance_tier desc, then parsed member count desc
```

> Decision (2026-08-10): we do **not** intersect with `leads.category`. Those are
> review-platform *business* verticals (casino, dental, car_dealer) and do not overlap the
> FB consumer-service niches groups are discovered under (plumber, roofer, …); intersecting
> yields zero and conflates B2B targets with B2C ask-groups. The candidate's own FB niche is
> the correct linkage.

Live counts at design time (GB): 34 candidates → 14 `customers` / 15 `trades` / 5 `unclear`;
14 actionable under this filter.

## Daily cap (warmup-ramped)

A **separate** join budget from the comment budget, using the same warmup ramp shape as
`effectiveCommentCap`:

- week 1 (days 0–6): **1/day** · week 2 (7–13): **2/day** · week 3+ (14+): **3/day**
- `warmup_started_at` null → full configured cap (preserves pre-warmup accounts).
- Effective joins this run = `min(rampCap − group_join_used_today, len(candidates))`.

New per-account columns (migration 059): `group_join_daily_cap` (default 3),
`group_join_used_today` (default 0). `group_join_used_today` is reset by the **same daily
reset mechanism** that already zeroes `comment_used_today` (implementation plan to locate
and extend that reset so joins reset with comments).

## Per-group outcome handling

For each selected candidate, up to the effective cap:

1. Navigate to `https://www.facebook.com/groups/<group_id>`.
2. Human pause (jittered).
3. Locate the primary Join control (resilient: `role=button` + `aria-label`/visible-text
   matching "Join", with fallbacks) and click.
4. Classify the resulting page state via an **isolated, fixture-tested** pure function
   `_classify_join_outcome(...)`:

| Detected state | DB action | Counts toward cap? |
|---|---|---|
| Joined instantly (shows "Joined"/"Leave"/member UI) | `status='joined'`, `joined_detected_at=now` | yes |
| Pending approval ("Requested"/"Cancel request") | `status='requested'` *(new status)* | yes |
| Membership **questions** appear (answer form/dialog) | set `status='questions'` (terminal — leaves the candidate pool, awaits manual answer), emit `join_skipped_questions` | no |
| Already a member | `status='joined'`, `joined_detected_at=now` | no |
| Join control not found / unexpected | leave `candidate`, emit `join_failed` (reason) | no |

5. Increment `group_join_used_today` for cap-counting outcomes.
6. Jittered delay before the next group (in-session human pace, randomized ~2–8 min).

> Pacing note: the brainstorm floated 20–90 min gaps; that is impractical inside one CLI
> session (3 joins ≈ hours). The real throttle is the **daily cap + warmup ramp**; within a
> run we use a human-plausible ~2–8 min jittered gap. Operator may run the command again
> later in the day up to the daily cap.

## Schema changes — migration 059

```sql
-- fb_group_candidates: allow the pending-approval state
ALTER TABLE fb_group_candidates DROP CONSTRAINT IF EXISTS fb_group_candidates_status_check;
ALTER TABLE fb_group_candidates ADD CONSTRAINT fb_group_candidates_status_check
    CHECK (status IN ('candidate', 'joined', 'ignored', 'requested', 'questions'));

-- social_accounts: separate join budget (mirrors comment budget)
ALTER TABLE social_accounts
    ADD COLUMN IF NOT EXISTS group_join_daily_cap  int NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS group_join_used_today int NOT NULL DEFAULT 0;
```

Idempotent; safe to re-apply. Latest applied migration is 058.

## Session / browser

Reuse `_open_session(account)` → `_open_driver(account)` → `open_uc_driver(...,
adspower_profile_id=...)` — the AdsPower branch attaches to the country-pinned profile with
its sticky GB residential proxy and desktop fingerprint. No new driver code.

## Progress events (SSE / log)

New, additive (existing event names unchanged): `join_started` (country, account, cap,
candidates), `join_attempt` (group_id, name), `join_result` (group_id, outcome),
`join_skipped_questions` (group_id), `join_failed` (group_id, reason), `join_done`
(joined, requested, skipped, failed).

## Safety

- Warmup ramp + hard daily cap + in-session jitter.
- Fail-closed on no bound account.
- Never auto-answer questions.
- Owner-local only (AdsPower loopback); respects the post-checkpoint idle window
  operationally (operator decides when to run).
- Every outcome/skip logged.

## Testing

**Pure-function unit tests (no browser):**
- Candidate selection: audience/tier/status/country filter and ordering.
- Cap math: warmup ramp × `group_join_used_today` (days 3 / 10 / 20 / null).
- `_classify_join_outcome`: saved HTML fixtures for instant-join / pending / questions /
  already-member / control-missing.

**Live smoke (mandatory before merge, project rule):** one real join on the GB account,
observed; confirm the `fb_group_candidates` row flips to `joined`/`requested` and
`group_join_used_today` increments.

## Prerequisites / operational notes

- Requires customer-facing candidates in the queue for the country. GB has 14 today;
  other countries need a group-discovery scrape first.
- Runs only where the AdsPower desktop client + the country profile live (owner host for GB).
- Account must be past its post-checkpoint idle window before first run.

## Files (anticipated)

| File | Change |
|---|---|
| `supabase/migrations/059_fb_group_join.sql` | Create (schema above) |
| `tools/scraper/platforms/facebook.py` | Add `join_groups()` + `_select_join_candidates()` + `_classify_join_outcome()` + join-click driver |
| `tools/scraper/run.py` | Register `join-groups` action + `_run_join_groups()` |
| `tests/scraper/test_fb_join_groups.py` | Create — selection, cap math, outcome classifier |
| `server/src/services/pool-account-resolver.ts` | (If a TS trigger is later added — not in this scope) |
