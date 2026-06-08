# Design — Non-English In-Group Query + Filter Localization

**Date:** 2026-06-08
**Status:** Approved (brainstorming → ready for implementation plan)
**Area:** `tools/scraper/platforms/facebook.py` — group-first consumer scrape
**Builds on:** `2026-06-08-fb-group-relevance-prioritization-design.md` (group *selection* is fixed; this fixes the in-group *query* + downstream filters)

---

## Problem

The 2026-06-08 Frankfurt smoke proved that group **prioritization** works (42 found → searched the 9 right groups, skipped 25 lifestyle groups) but yield was still **0** classifier-passed leads. Two English-only links downstream of group selection are the cause:

1. **In-group search query** is hardcoded English at `facebook.py:2245`:
   `in_group_keyword = f'looking for a {niche}'` → `"looking for a Elektriker"`. German
   consumers write *"Suche Elektriker"* / *"Elektriker gesucht"*, so the gold group
   **"Elektriker Handwerker Gesucht"** returned **0** in-group matches.
2. **`_is_actively_asking`** (`asking_only` filter, `CONSUMER_PATTERNS` at `facebook.py:356`)
   and **`_looks_like_business_post`** (`BUSINESS_PATTERNS`) are **entirely English**. Even
   if a German ask were surfaced, the substring `asking_only` filter would drop it before
   the (multilingual) Gemini classifier sees it.

Net: the 11 posts that survived in the smoke were English-ish Kleinanzeigen noise that
matched the English search phrase AND English asking-patterns; the classifier correctly
rejected all 11.

## Goal

Make non-English markets actually yield, by feeding the right posts into the
already-multilingual Gemini classifier and getting the English-only substring pre-filters
out of the way — **without touching English-market behavior** (London must stay ~32).

Success criteria:
- Frankfurt electrician re-smoke: the gold "Elektriker Handwerker Gesucht" group returns
  asks; **> 0** classifier-passed leads.
- London handyman re-smoke: yield ≈ 32, byte-identical pipeline behavior.

## Non-Goals

- No change to the Gemini classifier (already multilingual + niche-translated).
- No per-language asking/business phrase vocabularies (rejected as high-maintenance).
- No change to group selection / prioritization (done in the prior spec).

---

## Architecture

One language gate drives everything — a market is **non-English** when
`_resolve_relevance_language(location) != 'English'` (the helper added in the prior spec;
Frankfurt→German→non-English, London→GB→English, unknown→English).

### 1. `_in_group_keyword(niche, location) -> str` — new pure helper

```
non-English  → niche                     # e.g. "Elektriker"  (max recall; classifier judges precision)
English      → f'looking for a {niche}'  # e.g. "looking for a handyman"  (UNCHANGED)
```

Used in `_sync_group_first_scrape` to replace the hardcoded
`in_group_keyword = f'looking for a {niche}'` at `facebook.py:2245`. The translated niche
term (the production `search_posts` path already translates before calling
`_sync_group_first_scrape`) becomes the bare in-group query for non-English markets.

### 2. `_consumer_filter_defaults(filters, location) -> tuple[bool, bool]` — new pure helper

Returns `(exclude_businesses, asking_only)` with **language-aware defaults**, while still
honoring an explicit operator override:

```
English      → exclude_businesses=True,  asking_only=True    # UNCHANGED
non-English  → exclude_businesses=False, asking_only=False   # bypass English substring filters
operator override: filters.get('exclude_businesses'/'asking_only') wins if present (not None)
```

Implementation shape:
```python
def _consumer_filter_defaults(filters, location):
    non_english = _resolve_relevance_language(location) != 'English'
    default = not non_english          # English → True, non-English → False
    eb = filters.get('exclude_businesses')
    ao = filters.get('asking_only')
    return (default if eb is None else bool(eb),
            default if ao is None else bool(ao))
```

`use_llm_classifier` is **unchanged** (still `filters.get('use_llm_classifier', True)`).
For non-English markets the classifier becomes the sole gate.

### 3. Wiring

The consumer-filter chain currently reads `exclude_businesses`/`asking_only` directly from
`filters` in **two** places (duplicated): `search_posts` (~`facebook.py:2394`) and
`scrape_listing` (~`facebook.py:2206`). Both switch to
`exclude_businesses, asking_only = _consumer_filter_defaults(filters, location)`. The
production dispatch is `search_posts` (`--action search-posts`); `scrape_listing` is updated
for parity so both call paths behave identically.

`location` is in scope at both sites (read from `filters['location']`/`['country']` earlier
in each method).

### 4. What stays the same

- English markets: in-group keyword, both substring filters, and classifier are byte-identical → no London regression.
- Group discovery, gate, prioritization + cap (prior spec): untouched.

---

## Known Trade-offs (explicit)

- **More posts to the classifier on non-English scrapes** (≈48 vs ≈11 in the Frankfurt
  sample) — acceptable at Gemini Flash pricing, and bounded by the group cap from the prior
  spec.
- **Classifier-off + non-English** = posts pass largely unfiltered (noise), because the
  substring pre-filters are bypassed. This is an explicit operator choice (`use_llm_classifier`
  defaults `True`; production keeps it on). Noted, not guarded — adding fallback logic for a
  config the production path never uses is YAGNI.

---

## Testing

### Unit (pytest, pure functions — no network)
- `_in_group_keyword("Elektriker", "Frankfurt") == "Elektriker"`
- `_in_group_keyword("handyman", "London") == "looking for a handyman"`
- `_in_group_keyword("plumber", "") == "looking for a plumber"` (unknown → English carrier)
- `_consumer_filter_defaults({}, "Frankfurt") == (False, False)`
- `_consumer_filter_defaults({}, "London") == (True, True)`
- operator override respected: `_consumer_filter_defaults({"asking_only": True}, "Frankfurt") == (False, True)`

### Live re-smoke (mandatory before declaring success)
- **electrician + Frankfurt**: expect the gold "Elektriker Handwerker Gesucht" group to
  return asks (non-zero `group_posts_kept`), `consumer_filtered` either skipped or near
  pass-through, and **`search_done` / final stub count > 0**.
- **handyman + London**: expect yield ≈ 32 (regression guard — English path unchanged).

---

## Files Touched

- `tools/scraper/platforms/facebook.py`
  - new `_in_group_keyword(niche, location)`
  - new `_consumer_filter_defaults(filters, location)`
  - `_sync_group_first_scrape` — use `_in_group_keyword` instead of the hardcoded English phrase
  - `search_posts` + `scrape_listing` consumer-filter chains — use `_consumer_filter_defaults`
- `tools/scraper/platforms/test_group_relevance.py` (or a sibling test module) — unit tests

## Impact / Blast Radius (confirm at plan time)

- `_sync_group_first_scrape` — internal to the FB plugin; change is the keyword string only.
- The two consumer-filter chains — behavior change is gated on language; English unaffected.
- No signature changes to public/cross-module symbols. No SSE event changes.
