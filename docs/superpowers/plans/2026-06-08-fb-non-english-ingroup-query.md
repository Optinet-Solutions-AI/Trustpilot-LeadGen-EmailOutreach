# Non-English In-Group Query + Filter Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make non-English Facebook group-first scrapes actually yield leads by searching groups with the bare (translated) niche term and bypassing the English-only substring filters, letting the multilingual Gemini classifier judge — without changing English-market behavior.

**Architecture:** Two pure helpers gated on `_resolve_relevance_language(location) != 'English'`: `_in_group_keyword` picks the in-group search query (niche-alone for non-English, `"looking for a {niche}"` for English), and `_consumer_filter_defaults` returns language-aware defaults for the `exclude_businesses`/`asking_only` substring filters (off for non-English, on for English; explicit operator filters still win). Wired into `_sync_group_first_scrape` and both consumer-filter chains.

**Tech Stack:** Python 3.12, pytest 9.0.3 (in `.venv`).

**Spec:** `docs/superpowers/specs/2026-06-08-fb-non-english-ingroup-query-design.md`

**Key facts (verified during planning):**
- All edits in `tools/scraper/platforms/facebook.py`. `_resolve_relevance_language(location)` already exists (returns `"German"` for Frankfurt, `"English"` for London/unknown).
- In-group keyword: `facebook.py:2245` → `in_group_keyword = f'looking for a {niche}'`, inside `_sync_group_first_scrape(self, niche, location, on_progress, generic_group_cap=5)` (so `location` is in scope).
- Consumer-filter chain #1 — `scrape_listing` (uses var `post_stubs`): `facebook.py:2374-2377`.
- Consumer-filter chain #2 — `search_posts` (uses var `stubs`): `facebook.py:2565-2569`.
- Both filter chains have `location` in scope (set from `filters['location']`/`['country']` earlier in each method). The production dispatch is `search_posts`.
- Run tests from repo root: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`
- Do NOT push/deploy. Local commits only.

---

## File Structure

- **Modify** `tools/scraper/platforms/facebook.py`:
  - new `_in_group_keyword(niche, location) -> str`
  - new `_consumer_filter_defaults(filters, location) -> tuple[bool, bool]`
  - `_sync_group_first_scrape` — use `_in_group_keyword` (line 2245)
  - `scrape_listing` + `search_posts` consumer-filter chains — use `_consumer_filter_defaults`
- **Modify** `tools/scraper/platforms/test_group_relevance.py` — unit tests for the two helpers

---

## Task 1: Pure helpers — in-group keyword + filter defaults

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (add two functions immediately AFTER `_resolve_generic_cap`)
- Test: `tools/scraper/platforms/test_group_relevance.py`

- [ ] **Step 1: Write the failing tests** (append to `tools/scraper/platforms/test_group_relevance.py`)

```python
from tools.scraper.platforms.facebook import _in_group_keyword, _consumer_filter_defaults


def test_in_group_keyword_non_english_uses_bare_niche():
    # Non-English market: search the translated niche term alone (max recall).
    assert _in_group_keyword("Elektriker", "Frankfurt") == "Elektriker"


def test_in_group_keyword_english_uses_carrier_phrase():
    # English market: unchanged "looking for a {niche}" carrier phrase.
    assert _in_group_keyword("handyman", "London") == "looking for a handyman"


def test_in_group_keyword_unknown_location_defaults_english():
    assert _in_group_keyword("plumber", "") == "looking for a plumber"
    assert _in_group_keyword("plumber", None) == "looking for a plumber"


def test_consumer_filter_defaults_non_english_both_off():
    assert _consumer_filter_defaults({}, "Frankfurt") == (False, False)


def test_consumer_filter_defaults_english_both_on():
    assert _consumer_filter_defaults({}, "London") == (True, True)


def test_consumer_filter_defaults_operator_override_wins():
    # Explicit operator filter overrides the language-aware default.
    assert _consumer_filter_defaults({"asking_only": True}, "Frankfurt") == (False, True)
    assert _consumer_filter_defaults({"exclude_businesses": False}, "London") == (False, True)
```

- [ ] **Step 2: Run to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v -k "in_group_keyword or consumer_filter_defaults"`
Expected: FAIL — `ImportError: cannot import name '_in_group_keyword'`.

- [ ] **Step 3: Implement** — add both functions in `tools/scraper/platforms/facebook.py` immediately AFTER the `_resolve_generic_cap` function:

```python
def _in_group_keyword(niche: str, location: str | None) -> str:
    """Build the in-group post-search query for a niche.

    Non-English markets: search the (already-translated) niche term ALONE
    for maximum recall — German consumers write 'Suche Elektriker', not
    'looking for a Elektriker', so the English carrier phrase misses them.
    The multilingual Gemini classifier handles precision downstream.

    English markets: unchanged 'looking for a {niche}' carrier phrase.
    """
    if _resolve_relevance_language(location) != 'English':
        return niche
    return f'looking for a {niche}'


def _consumer_filter_defaults(filters: dict, location: str | None) -> tuple[bool, bool]:
    """Resolve (exclude_businesses, asking_only) with language-aware defaults.

    The substring filters _looks_like_business_post / _is_actively_asking are
    English-only, so for non-English markets they DROP real local-language
    asks. Default them OFF for non-English (let the multilingual Gemini
    classifier be the sole gate) and ON for English (unchanged). An explicit
    operator value in `filters` always wins.
    """
    default = _resolve_relevance_language(location) == 'English'
    eb = filters.get('exclude_businesses')
    ao = filters.get('asking_only')
    return (
        default if eb is None else bool(eb),
        default if ao is None else bool(ao),
    )
```

- [ ] **Step 4: Run to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`
Expected: ALL pass (prior tests + 6 new = 32 total).

- [ ] **Step 5: Commit**

```bash
git add "tools/scraper/platforms/facebook.py" "tools/scraper/platforms/test_group_relevance.py"
git commit -m "feat(scraper): add non-English in-group keyword + filter-default helpers

Pure helpers: _in_group_keyword (bare niche for non-English, carrier phrase
for English) and _consumer_filter_defaults (English-only substring filters
default off for non-English so the multilingual classifier judges).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire the helpers into the scrape flow

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (3 edit sites: 2245, 2374-2375, 2565-2566)

No new unit tests (these are integration edits to browser-driven methods); verification is module import + the full pytest suite + the live re-smoke in Task 3. Locate by content (line numbers may shift).

- [ ] **Step 1: Impact analysis**

Run the Grep tool for `_in_group_keyword`, `_consumer_filter_defaults`, and `in_group_keyword = ` in `tools/scraper/platforms/facebook.py`. Confirm the helpers (added in Task 1) exist and `in_group_keyword = f'looking for a {niche}'` appears once. Risk: LOW — string/default changes only, gated on language; English path unchanged.

- [ ] **Step 2: Replace the in-group keyword (in `_sync_group_first_scrape`)**

Find:
```python
        in_group_keyword = f'looking for a {niche}'
```
Replace with:
```python
        in_group_keyword = _in_group_keyword(niche, location)
```

- [ ] **Step 3: Replace consumer-filter defaults in `scrape_listing` (the `post_stubs` chain)**

Find this exact pair of lines:
```python
            exclude_businesses = filters.get('exclude_businesses', True)
            asking_only = filters.get('asking_only', True)
```
that is immediately followed (a couple of lines down) by `if exclude_businesses or asking_only:` and `before = len(post_stubs)`. Replace ONLY those two lines with:
```python
            exclude_businesses, asking_only = _consumer_filter_defaults(filters, location)
```
Leave the `use_llm_classifier = filters.get('use_llm_classifier', True)` line and everything else unchanged.

- [ ] **Step 4: Replace consumer-filter defaults in `search_posts` (the `stubs` chain)**

Find this exact pair of lines:
```python
            exclude_businesses = filters.get('exclude_businesses', True)
            asking_only = filters.get('asking_only', True)
```
that is immediately followed by `use_llm_classifier = filters.get('use_llm_classifier', True)` and then `if exclude_businesses or asking_only:` with `before = len(stubs)`. Replace ONLY those two lines with:
```python
            exclude_businesses, asking_only = _consumer_filter_defaults(filters, location)
```
(There are TWO matching pairs in the file — this is the one in the `stubs`/`search_posts` chain. Use surrounding context (`before = len(stubs)`) to target the right one. After editing, there should be ZERO remaining occurrences of `exclude_businesses = filters.get('exclude_businesses', True)`.)

- [ ] **Step 5: Verify**

Run: `./.venv/Scripts/python.exe -c "from tools.scraper.platforms import facebook; print('import OK')"`
Expected: `import OK`.

Run (confirm both raw-default lines are gone): the Grep tool for `exclude_businesses = filters.get` in `tools/scraper/platforms/facebook.py` — expect NO matches.

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`
Expected: ALL pass (32).

- [ ] **Step 6: Commit**

```bash
git add "tools/scraper/platforms/facebook.py"
git commit -m "feat(scraper): localize FB in-group query + filters for non-English markets

_sync_group_first_scrape searches the bare niche term for non-English
locations; both consumer-filter chains use language-aware substring-filter
defaults so the multilingual classifier judges non-English posts. English
path byte-identical.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Live re-smoke (MANDATORY — needs operator go-ahead)

**Files:** none (verification). Live FB scrape — burns `social_accounts` quota, needs the logged-in Windows session. Confirm with the operator before running.

- [ ] **Step 1: Frankfurt re-smoke (the fix)**

```bash
./.venv/Scripts/python.exe tools/scraper/run.py --platform facebook --action search-posts \
  --filters '{"lead_type":"consumers","niche":"electrician","location":"Frankfurt","groups_only":true,"query":"electrician Frankfurt"}' \
  --output .tmp/fb_smoke_frankfurt2.json
```
Expect in the progress output:
- `niche_translated electrician → Elektriker`
- `groups_prioritized` with non-zero `generic_skipped` (unchanged from prior smoke)
- the gold group **"Elektriker Handwerker Gesucht"** now showing non-zero `group_posts_kept`
- `consumer_filtered` skipped (non-English bypasses the substring filters) — posts flow straight to the classifier
- **final `search_done` / `Wrote N post stubs` with N > 0** (the success bar; prior smoke was 0)

If N is still 0: read the classifier output — either the surfaced posts genuinely aren't consumer asks, or the multilingual classifier is rejecting valid German asks (a classifier-prompt issue, separate from this change). Report which.

- [ ] **Step 2: London regression**

```bash
./.venv/Scripts/python.exe tools/scraper/run.py --platform facebook --action search-posts \
  --filters '{"lead_type":"consumers","niche":"handyman","location":"London","groups_only":true,"query":"handyman London"}' \
  --output .tmp/fb_smoke_london.json
```
Expect: English path unchanged — `looking for a handyman` in-group query, substring filters active, yield ≈ 32. Materially lower = regression; investigate before merge.

- [ ] **Step 3: Record results**

Append a "Smoke results 2026-06-08 (round 2)" note (Frankfurt N, London N, whether the gold group yielded) to the bottom of `docs/superpowers/specs/2026-06-08-fb-non-english-ingroup-query-design.md` and commit:
```bash
git add "docs/superpowers/specs/2026-06-08-fb-non-english-ingroup-query-design.md"
git commit -m "docs(scraper): record non-English in-group query smoke results

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §Architecture-1 (`_in_group_keyword`) → Task 1 + Task 2 Step 2; §Architecture-2 (`_consumer_filter_defaults`) → Task 1 + Task 2 Steps 3-4; §Architecture-3 (wiring both chains) → Task 2; §Testing (unit + live re-smoke) → Tasks 1 + 3. ✅
- **Placeholder scan:** every code step has complete code; no TBD/TODO. ✅
- **Type consistency:** `_in_group_keyword(niche, location) -> str` and `_consumer_filter_defaults(filters, location) -> (exclude_businesses, asking_only)` used identically across Tasks 1 and 2; tuple unpack order `exclude_businesses, asking_only` matches the helper's return order and the existing variable names at both call sites. ✅
- **Regression safety:** English path (London) is byte-identical — `_in_group_keyword` returns the same string and `_consumer_filter_defaults` returns `(True, True)` for English. ✅
