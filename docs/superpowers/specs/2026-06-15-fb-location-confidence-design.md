# FB Lead Location Confidence — Design Spec

**Date:** 2026-06-15
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** `tools/scraper/platforms/facebook.py`, `tools/db/upsert_leads.py`, one Supabase migration, one new audit script.

---

## Problem

Facebook consumer-mode scrapes stamp the operator's **search location** onto every captured lead as `leads.country`, regardless of where the person or group actually is. The location is a blind copy of the filter value:

- `facebook.py:2127` — `'country': location or None` (consumer path)
- `facebook.py:2223-2224` — stamps `stamp_location` onto any lead missing a country (group-first path)

A real "Bristol / handyman" batch (57 leads, all stamped `country = "Bristol"`, identical `scraped_at`) was sourced from groups including **ATLANTA Handyman Services (US)**, **Washington Handyman Services (US)**, **Handyman Services Dublin (IE)**, **HANDYMAN SERVICES LONDON, Ontario (CA)**, plus Doncaster, Reading, London, Liverpool, Birmingham, Warrington, Bridlington. Only four groups were genuinely Bristol.

The post that triggered this (Jennifer Scott, group "T T handyman services") has **no location in its text**, sits in a **generically-named group**, and the top comment literally asks *"Whats the location where you need this done?"* — yet it carries `country = "Bristol"`.

### Root cause

`_is_consumer_facing_group()` (facebook.py:1019) already has a Stage-1 country-mismatch drop, but it only matches group names against **country tokens** (`_COUNTRY_NAME_TOKENS`: `uk`, `usa`, `ireland`, …). Group names carry **city** names ("Atlanta", "Dublin", "Washington"), which are never resolved to a country. The existing `_extract_country_from_excerpt()` (facebook.py:598) *does* know `atlanta→US`, `dublin→IE`, etc., but it is only applied to the **operator's** location, never to the group name.

---

## Goals

1. **Drop wrong-country groups at discovery time** — before scraping budget is spent on them.
2. **Label every kept lead with `location_confidence`** so an unconfirmed "Bristol" stamp can no longer mislead.
3. **Provide a read-only audit/back-fill command** to check accuracy of any batch and label already-scraped leads without re-scraping.

## Non-goals (v1)

- No exhaustive world city gazetteer. Narrow towns not in the existing `CITY_TO_COUNTRY` map (Doncaster, Reading, Warrington, Bridlington) stay `unconfirmed` — honest, not wrong.
- No change to which leads are **kept**, except dropping clearly-wrong-country groups.
- No Gemini-based location extraction (the classifier already reads every post and *could* return a location field at ~zero cost — deferred to a follow-up).
- No frontend confidence badge yet (follow-up; a chip in the Lead view).
- `leads.country` keeps storing the **search target** (the campaign intent, e.g. "Bristol"). It is NOT overwritten — the new confidence flag sits beside it.

---

## Design

### Component 1 — City-aware discovery gate

Extend `_is_consumer_facing_group(group_name, operator_location)` Stage 1 (country mismatch):

In addition to the existing `_COUNTRY_NAME_TOKENS` scan over the group name, also call `_extract_country_from_excerpt(group_name)`. If it returns a country **and** that country ≠ the operator's resolved country → return `False` (drop).

Edge case — **"London, Ontario"**: `CITY_TO_COUNTRY` maps `london→GB`, so a Canadian "London, Ontario" group would falsely resolve to GB and survive a UK search. Add province/region tokens (`ontario`, `alberta`, `quebec`, `manitoba`, `saskatchewan`, plus `, on`/`, ab` style) → `CA`, checked **before** the bare-city scan so the province wins. Keep this list small and only for provinces actually seen in data.

**Effect:** Atlanta, Washington (US), Dublin (IE), London-Ontario (CA) groups are dropped at discovery, saving in-group scraping cost.

### Component 2 — Per-lead `location_confidence`

A new pure helper, e.g. `_derive_location_confidence(group_name, post_excerpt, operator_location) -> str`, returns one of:

| Value | When |
|---|---|
| `confirmed_city` | group name **or** post text contains the searched city (substring, word-boundary) |
| `same_country` | a *different* city is detected that resolves to the **same** country as the operator |
| `unconfirmed` | no location signal in group name or post text (generic group, no city in post) |

`wrong_country` is not a stored value — those groups are dropped at Component 1. If one ever reaches here (e.g. a city in post text resolves to another country), the lead is still dropped/marked at upsert; v1 treats this as `unconfirmed` if it slips through, since the gate is the primary defense.

The derived value is attached to the lead dict in **both** build paths (consumer `facebook.py:2127` area and group-first `facebook.py:2223` area) and persisted by `upsert_leads.py` into the new column.

Detection reuses the existing deterministic `CITY_TO_COUNTRY` list — no new data source.

### Component 3 — Audit / back-fill command

New `tools/scraper/audit_fb_locations.py` (read-only by default):

- Joins `leads` ↔ `lead_platform_posts` (group_name, content_excerpt already stored) and re-derives confidence for each FB lead using the **same** `_derive_location_confidence` helper (imported, single source of truth).
- `--location <city>` and/or `--batch <scraped_at|since>` to scope (e.g. the 57 Bristol leads).
- Prints a per-lead table: company_name | group_name | detected_city | confidence | excerpt-snippet, plus a summary count per tier.
- `--write` flag (off by default): back-fills `leads.location_confidence` for the matched rows so historical data gets labeled without re-scraping.

This directly answers "how can we check it" — accuracy of any batch is one read-only command.

### Component 4 — Schema

`supabase/migrations/049_lead_location_confidence.sql`:

```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS location_confidence text;
```

Nullable, non-breaking. Existing rows are `NULL` until the audit `--write` back-fill or the next scrape labels them. No enum constraint in v1 (values are written only by our code); document the allowed set in a comment.

---

## Data flow (after change)

```
group-first search "handyman" + "Bristol"
  ↓ discover groups
  ↓ _is_consumer_facing_group(name, "Bristol")
      ├─ city in name resolves to non-GB country → DROP   (Atlanta, Dublin, London-Ontario)
      └─ else keep
  ↓ scrape in-group posts (consumer asks)
  ↓ per lead: _derive_location_confidence(group_name, excerpt, "Bristol")
      ├─ "bristol" found            → confirmed_city
      ├─ other GB city found        → same_country
      └─ nothing                    → unconfirmed   (Jennifer Scott)
  ↓ upsert_leads → leads.country="Bristol", leads.location_confidence=<tier>
```

---

## Testing

- **Unit (pure helpers, no network):**
  - `_is_consumer_facing_group`: "ATLANTA HANDYMAN SERVICES" + Bristol → drop; "HANDYMAN SERVICES LONDON, Ontario" + Bristol → drop; "Find a Tradesman Bristol and surrounding" + Bristol → keep; "T T handyman services" + Bristol → keep (no geo).
  - `_derive_location_confidence`: searched-city in group → `confirmed_city`; other-same-country city → `same_country`; generic group + locationless post → `unconfirmed`.
- **Audit script:** run against the real 57-lead Bristol batch; assert the four genuinely-Bristol groups label `confirmed_city`, the foreign ones would have been dropped (now flagged in output), and Jennifer Scott labels `unconfirmed`. Confirms the design against live data.
- **Regression:** existing consumer-mode tests still pass; no change to kept-lead counts except dropped wrong-country groups.

---

## Rollout

1. Migration 049 (additive).
2. Code changes to `facebook.py` + `upsert_leads.py`.
3. Run `audit_fb_locations.py --location Bristol --write` to label the existing batch.
4. Smoke-test a fresh small FB consumer scrape (per the smoke-test-before-ship rule) to confirm gate + labeling on real HTML.
