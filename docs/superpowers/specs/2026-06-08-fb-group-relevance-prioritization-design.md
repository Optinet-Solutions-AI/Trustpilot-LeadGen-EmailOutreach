# Design — Niche-Aware FB Group Prioritization (Non-English Market Yield)

**Date:** 2026-06-08
**Status:** Approved (brainstorming → ready for implementation plan)
**Area:** `tools/scraper/platforms/facebook.py` — group-first consumer scrape

---

## Problem

When scraping non-English cities, Facebook's group search returns mostly
generic city groups (events, nightlife, expat, lifestyle) rather than
trade-specific or classifieds groups. The 2026-06-05 Frankfurt run proved
the failure mode: of ~35 discovered groups, ~30 were lifestyle
("Frankfurt Events", "Nightlife Frankfurt", "EINTRACHT FRANKFURT NEWS"),
and only a handful were useful ("Kleinanzeigen Frankfurt und Umgebung",
"Elektriker für alle"). Frankfurt yielded **0** classifier-passed
electrician leads while London yielded 32 handyman leads.

Root cause: `_is_consumer_facing_group` (facebook.py:914) **defaults to
KEEP** for any name that isn't explicitly negative-tagged. Generic city
groups therefore all survive, get searched one-by-one (each search burns
`social_accounts.used_today` quota and wall-clock time), and produce noise
that the Gemini classifier then correctly rejects. The system "works for
English markets" only because English group search happens to surface
relevant groups organically.

## Goal

In the group-first scrape, **search niche / classifieds / community groups
first, and only let a capped number of generic city/lifestyle groups
through.** This cuts noise and account-quota burn in non-English markets
without starving English-market yield (which leans on un-tagged community
groups).

Success criteria:
- Frankfurt electrician re-run: niche + classifieds groups searched, ~25
  generic lifestyle groups skipped, **> 0** classifier-passed leads.
- London handyman re-run: yield unchanged (~32), generics still capped but
  community/niche groups all searched first.

## Non-Goals

- No change to the per-post filters (`_looks_like_business_post`,
  `_is_actively_asking`) or the Gemini classifier.
- No change to niche translation itself (already shipped 2026-06-05).
- Not covering all ~40 `_COUNTRY_NAME_TOKENS` markets — only the active
  outreach languages (see Vocabulary scope).

---

## Architecture

Two functions, separated by concern (keeps blast radius small and makes
each independently unit-testable):

### 1. `_is_consumer_facing_group(name, location, niche=None)` — hard gate

Unchanged KEEP/DROP semantics, **one addition**: the translated niche term
and the per-language classifieds/trade tokens join the existing
STRONG-POSITIVE stage (the same stage that force-keeps "free"/"affordable"
today). This guarantees a group like "Elektriker für alle" or
"Kleinanzeigen Frankfurt" can never be dropped by a stray negative token
(e.g. the existing `'marketplace'` negative).

- `niche` is an **optional** new third parameter, default `None` →
  back-compat preserved for any caller that doesn't pass it.
- Default-KEEP behavior stays. This gate does NOT drop generics — the cap
  in `_sync_group_first_scrape` does.

### 2. `_group_relevance_tier(name, location, niche) -> int` — new ranking signal

Pure function, no side effects, used only for ordering + capping:

| Tier | Meaning | Examples |
|---|---|---|
| **2** | translated-niche token match, OR per-language classifieds/trade token | "Elektriker für alle", "Kleinanzeigen Frankfurt", "Handwerker Frankfurt" |
| **1** | existing consumer-positive tokens (free / affordable / cheap / budget / help / community / recommendation / buy and sell / local / neighbourhood) | "West Hampstead Community" |
| **0** | passed the gate by default only — generic city/lifestyle | "Frankfurt Events", "Nightlife Frankfurt" |

Niche-token match is **language-agnostic**: it matches the already-translated
niche term directly (substring, case-insensitive, word-ish boundary), so it
works for any market the translator covers, not just the 7 vocab languages.

### 3. `_sync_group_first_scrape` — search order + cap

After the existing gate filter (facebook.py:2070):

1. Compute `_group_relevance_tier(name, location, niche)` for each survivor.
2. Sort descending by tier: **2 → 1 → 0** (stable; preserves discovery
   order within a tier).
3. Search **all** tier-2 and tier-1 groups.
4. Search tier-0 (generic) groups only up to **`generic_group_cap`**
   (filter-overridable, **default 5**); skip the remainder.
5. Emit a new progress event:
   `groups_prioritized {relevant=<t2+t1>, generic_searched=<n>, generic_skipped=<n>}`
   — operator sees exactly what was dropped (per the "no silent caps" rule).

The existing per-group search loop is otherwise unchanged (one Chrome
session reused, counters bumped per group, checkpoint handling intact).

### 4. Per-language vocabulary

A module-level dict `_GROUP_RELEVANCE_VOCAB`, keyed by language name, holding
classifieds + general-trade tokens per language. Language is resolved from
`location → country (via _extract_country_from_excerpt) → COUNTRY_TO_LANGUAGE`
(the same map `_translate_niche_to_local` uses). English-primary markets
(no entry in `COUNTRY_TO_LANGUAGE`) fall back to an English token set.

Scope (active outreach markets): **English, German, French, Italian,
Spanish, Dutch, Portuguese**. Initial seed tokens:

- **EN:** classifieds, for sale, buy and sell, marketplace, tradesmen, handyman
- **DE:** kleinanzeigen, marktplatz, handwerker, flohmarkt, gesuche
- **FR:** petites annonces, artisans, bon coin, marché
- **IT:** mercatino, annunci, artigiani
- **ES:** clasificados, oficios, anuncios, mercadillo
- **NL:** marktplaats, vakmensen, klusjesman
- **PT:** classificados, anúncios, artesãos

(Tokens are a starting seed; expand as real group lists surface — same
maintenance pattern as the existing negative/country token lists.)

### 5. Config knobs (filters)

- `generic_group_cap` — int, default **5**. Max number of tier-0 groups to
  search. `0` = search none (strict). Read in `_sync_group_first_scrape`.

No other new knobs. (An overall `max_groups` was considered and dropped as
YAGNI — the tier cap already bounds the dominant cost source.)

---

## Known Limitation (explicit)

The **secondary** `scrape_listing` path (facebook.py:2196) calls
`_sync_group_first_scrape` with the **un-translated** niche, so in-language
niche-token match won't fire there — tier-2 niche matches degrade to tier-1/0
(classifieds tokens still work; nothing breaks). The **production** path is
`search_posts` (facebook.py:2360), which translates the niche first, so the
live `--action search-posts` dispatch gets full niche-aware tiering. We
accept this rather than double-translating; noted here so it isn't a
surprise later.

---

## Testing

### Unit (pytest, fixture-based — no network)
- Feed the real 2026-06-05 Frankfurt group list; assert:
  - "Kleinanzeigen Frankfurt und Umgebung" → tier 2
  - "Elektriker für alle" → tier 2 (niche="Elektriker")
  - "Frankfurt Events" / "Nightlife Frankfurt" / "EINTRACHT FRANKFURT NEWS" → tier 0
  - `_is_consumer_facing_group` never drops the two tier-2 names
- Feed a London list; assert community/recommendation → tier 1, a
  "London Handyman" group → tier 2 (niche="handyman"), generics → tier 0.
- Assert sort + cap logic: given N tier-0 + M tier-(1/2), the searched set =
  all M + min(generic_group_cap, N), in tier order.

### Live smoke (mandatory before push — per the smoke-test-before-ship rule)
- Re-run **electrician + Frankfurt** locally: expect the `groups_prioritized`
  event to show ~25 generic_skipped, and **> 0** classifier-passed leads.
- Re-run **handyman + London** locally: expect yield ≈ 32 (unchanged), with
  community/niche groups searched first.

---

## Files Touched

- `tools/scraper/platforms/facebook.py`
  - `_is_consumer_facing_group` — add optional `niche` param + STRONG-POSITIVE additions
  - new `_group_relevance_tier`
  - new `_GROUP_RELEVANCE_VOCAB` module dict
  - `_sync_group_first_scrape` — tier-sort + cap + `groups_prioritized` emit; pass `niche` into the gate
- `tools/scraper/platforms/test_facebook_group_relevance.py` (or existing FB test module) — unit tests

## Impact / Blast Radius (to confirm at plan time)

- `_is_consumer_facing_group` — run `gitnexus_impact` before edit. Adding an
  optional trailing param is non-breaking for existing 1 caller (line 2070).
- `_sync_group_first_scrape` — internal to the FB plugin; called from
  `scrape_listing` (2196) and `search_posts` (2361). Signature unchanged.
- New progress event `groups_prioritized` — additive; SSE consumers ignore
  unknown stages (confirm the frontend progress renderer tolerates it).
