# FB Lead Location Confidence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop blindly trusting the FB search-location stamp — drop wrong-country groups at discovery and label every kept lead with a `location_confidence` honesty flag, plus a read-only audit/back-fill command.

**Architecture:** Three pure helpers in `tools/scraper/platforms/facebook.py` (province disambiguation, a city-aware discovery gate, and a confidence classifier), wired into the two lead-build paths, persisted by `upsert_leads.py` into a new nullable column, and re-derivable over already-stored post data by a standalone audit script. No new data source — reuses the existing `CITY_TO_COUNTRY` map.

**Tech Stack:** Python 3.14, pytest, postgrest-py (Supabase), Supabase SQL.

**Spec:** `docs/superpowers/specs/2026-06-15-fb-location-confidence-design.md`

**Conventions:**
- Run tests from repo root: `./.venv/Scripts/python.exe -m pytest <path> -v`
- All commit commands must end with the footer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Line numbers below are anchors as of writing; if drifted, locate by the quoted surrounding code.
- **GitNexus:** before editing `_extract_country_from_excerpt` and `_is_consumer_facing_group`, run `gitnexus_impact({target:"<name>", direction:"upstream"})` and report blast radius. Both are FB-internal helpers (callers: the gate at line 1881 and each other) — expected LOW risk. Run `gitnexus_detect_changes()` before each commit.

---

## File Structure

- **Modify** `tools/scraper/platforms/facebook.py` — add 3 helpers, wire 2 build paths
- **Create** `tools/scraper/platforms/test_location_confidence.py` — pure-function unit tests
- **Modify** `tools/db/upsert_leads.py` — persist `location_confidence`
- **Create** `supabase/migrations/049_lead_location_confidence.sql` — one nullable column
- **Create** `tools/scraper/audit_fb_locations.py` — read-only audit + `--write` back-fill

---

## Task 1: Province disambiguation in `_extract_country_from_excerpt`

Fixes the "London, **Ontario**" edge: a Canadian London must resolve `CA`, not `GB`, so the gate (Task 2) can drop it on a UK search.

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (function `_extract_country_from_excerpt`, ~line 598, right after `lowered = text.lower()`)
- Test: `tools/scraper/platforms/test_location_confidence.py`

- [ ] **Step 1: Write the failing test** (create the new test file)

```python
"""Unit tests for FB location-confidence helpers (pure functions).

Run from repo root:
    ./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_location_confidence.py -v
"""
from tools.scraper.platforms.facebook import _extract_country_from_excerpt


def test_province_token_disambiguates_shared_city_name():
    # Bare 'london' maps to GB, but an explicit Canadian province must win.
    assert _extract_country_from_excerpt("HANDYMAN SERVICES LONDON, Ontario") == "CA"
    assert _extract_country_from_excerpt("Calgary, Alberta trades") == "CA"


def test_plain_city_still_resolves_without_a_province():
    assert _extract_country_from_excerpt("London Handyman Services") == "GB"
    assert _extract_country_from_excerpt("ATLANTA HANDYMAN SERVICES") == "US"
    assert _extract_country_from_excerpt("Handyman Services Dublin") == "IE"


def test_no_known_place_returns_none():
    assert _extract_country_from_excerpt("Doncaster and local areas Handy man Services") is None
    assert _extract_country_from_excerpt("") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_location_confidence.py::test_province_token_disambiguates_shared_city_name -v`
Expected: FAIL — returns `GB` (bare-city scan matches "london" before any province check).

- [ ] **Step 3: Add the province check** — in `_extract_country_from_excerpt`, immediately after `lowered = text.lower()` and before the `CITY_TO_COUNTRY = [...]` list:

```python
    # Province/state tokens that disambiguate a city name shared across
    # countries (e.g. "London, Ontario" must resolve CA, not GB). Checked
    # BEFORE the bare-city scan so the province wins. Small + data-driven —
    # only provinces actually seen in live group names.
    PROVINCE_TO_COUNTRY = [
        ('ontario', 'CA'), ('quebec', 'CA'), ('québec', 'CA'),
        ('alberta', 'CA'), ('manitoba', 'CA'), ('saskatchewan', 'CA'),
        ('british columbia', 'CA'), ('nova scotia', 'CA'),
    ]
    for needle, country in PROVINCE_TO_COUNTRY:
        if needle in lowered:
            return country
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_location_confidence.py -v`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/platforms/facebook.py tools/scraper/platforms/test_location_confidence.py
git commit -m "fix(scraper): resolve Canadian provinces before shared city names

So 'London, Ontario' maps to CA, not GB, letting the FB discovery gate
drop it on a UK search.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: City-aware discovery gate in `_is_consumer_facing_group`

Closes the actual bug: the gate only checked group names against *country* words, so "ATLANTA HANDYMAN SERVICES" passed a Bristol search.

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (function `_is_consumer_facing_group`, Stage-1 block, ~lines 1044-1052)
- Test: `tools/scraper/platforms/test_location_confidence.py`

- [ ] **Step 1: Write the failing tests** (append to the test file)

```python
from tools.scraper.platforms.facebook import _is_consumer_facing_group


def test_gate_drops_other_country_city_in_group_name():
    # City names (not country words) now resolve to a country and mismatch-drop.
    assert _is_consumer_facing_group("ATLANTA HANDYMAN SERVICES", "Bristol") is False
    assert _is_consumer_facing_group("Washington Handyman Services", "Bristol") is False
    assert _is_consumer_facing_group("Handyman Services Dublin", "Bristol") is False
    assert _is_consumer_facing_group("HANDYMAN SERVICES LONDON, Ontario", "Bristol") is False


def test_gate_keeps_same_country_and_generic_groups():
    # Same-country city or no geo at all → keep (Tiered policy: don't lose leads).
    assert _is_consumer_facing_group("Find a Tradesman Bristol and surrounding", "Bristol") is True
    assert _is_consumer_facing_group("London Handyman Services", "Bristol") is True   # GB == GB
    assert _is_consumer_facing_group("T T handyman services", "Bristol") is True       # no geo
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_location_confidence.py::test_gate_drops_other_country_city_in_group_name -v`
Expected: FAIL — "ATLANTA HANDYMAN SERVICES" returns `True` (Atlanta isn't a country token).

- [ ] **Step 3: Add the city-mismatch check** — inside `_is_consumer_facing_group`, in the `if operator_country:` block, immediately AFTER the existing `for country, pattern in _COUNTRY_NAME_TOKENS.items(): ...` loop (after its `return False`), still inside `if operator_country:`:

```python
            # Stage 1b: city-in-name mismatch. The token loop above only
            # catches explicit COUNTRY words ('usa', 'ireland'); group names
            # usually carry a CITY ('Atlanta', 'Dublin'). Resolve any city in
            # the name to its country and drop if it's a DIFFERENT country.
            group_country = _extract_country_from_excerpt(group_name or '')
            if group_country and group_country != operator_country:
                return False
```

(Place it so it runs only when `operator_country` is known. The existing line `name = (group_name or '').lower()` and Stage 2a override run AFTER this — unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_location_confidence.py -v`
Expected: PASS.

- [ ] **Step 5: Run the existing gate suite to confirm no regression**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`
Expected: PASS (all existing tests still green — e.g. `test_gate_backcompat_unchanged`).

- [ ] **Step 6: Commit**

```bash
git add tools/scraper/platforms/facebook.py tools/scraper/platforms/test_location_confidence.py
git commit -m "fix(scraper): drop foreign-city FB groups at discovery gate

Resolve a city name in the group title to its country and mismatch-drop
(Atlanta/Dublin/London-Ontario on a UK search). Closes the gap where the
gate only checked country words, never cities.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `_derive_location_confidence` classifier

The per-lead honesty flag.

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (add new function directly below `_extract_country_from_excerpt`, before `_COUNTRY_NAME_TOKENS`)
- Test: `tools/scraper/platforms/test_location_confidence.py`

- [ ] **Step 1: Write the failing tests** (append to the test file)

```python
from tools.scraper.platforms.facebook import _derive_location_confidence


def test_confidence_confirmed_when_searched_city_present():
    assert _derive_location_confidence("Find a Tradesman Bristol", None, "Bristol") == "confirmed_city"
    # city appears in the post text rather than the group name
    assert _derive_location_confidence("T T handyman services",
                                       "Need this done in Bristol asap", "Bristol") == "confirmed_city"


def test_confidence_same_country_for_other_city():
    # Different UK city, same country as the Bristol search.
    assert _derive_location_confidence("London Handyman Services", None, "Bristol") == "same_country"


def test_confidence_unconfirmed_when_no_location_signal():
    # Generic group + locationless post (the Jennifer Scott case).
    assert _derive_location_confidence(
        "T T handyman services",
        "Hi I'm looking for a 6x4 wood shed disassembled and reassembled. Would this be possible?",
        "Bristol",
    ) == "unconfirmed"


def test_confidence_word_boundary_no_substring_false_positive():
    # 'bristol' must not match inside an unrelated longer token.
    assert _derive_location_confidence("Bristolian Memes", None, "Bristol") == "confirmed_city"  # whole word
    assert _derive_location_confidence("Bristolboard crafters", None, "Bristol") == "unconfirmed"  # no whole-word match
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_location_confidence.py -k confidence -v`
Expected: FAIL with `ImportError: cannot import name '_derive_location_confidence'`.

- [ ] **Step 3: Implement the classifier** — add directly after `_extract_country_from_excerpt` returns (i.e. after its final `return None`):

```python
def _derive_location_confidence(
    group_name: Optional[str],
    post_excerpt: Optional[str],
    operator_location: Optional[str],
) -> str:
    """Classify how well a captured lead matches the SEARCHED city.

    Returns:
      'confirmed_city' — searched city appears (whole-word) in the group name
                         or the post text.
      'same_country'   — a different city is named that resolves to the SAME
                         country as the operator's search location.
      'unconfirmed'    — no usable location signal (generic group + a post that
                         names no place). The honest default.

    Pure + deterministic; reuses CITY_TO_COUNTRY via _extract_country_from_excerpt.
    Wrong-COUNTRY groups are dropped earlier by _is_consumer_facing_group, so
    they are not expected here; if one slips through it falls to 'unconfirmed'.
    """
    loc = (operator_location or '').strip().lower()
    hay = f"{group_name or ''} {post_excerpt or ''}".lower()

    if loc and re.search(r'\b' + re.escape(loc) + r'\b', hay):
        return 'confirmed_city'

    operator_country = _extract_country_from_excerpt(operator_location or '')
    detected_country = _extract_country_from_excerpt(hay)
    if detected_country and operator_country and detected_country == operator_country:
        return 'same_country'

    return 'unconfirmed'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_location_confidence.py -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/platforms/facebook.py tools/scraper/platforms/test_location_confidence.py
git commit -m "feat(scraper): add _derive_location_confidence classifier

Labels a captured FB lead confirmed_city / same_country / unconfirmed by
matching the searched city against the group name + post text.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire confidence into both lead-build paths

**Files:**
- Modify: `tools/scraper/platforms/facebook.py`
  - Path A — `scrape_listing` consumer reshape (dict literal containing `'country': location or None,`, ~line 2140)
  - Path B — `search_posts` stamping loop (`for s in stubs:` with `s['country'] = stamp_location`, ~lines 2233-2237)

- [ ] **Step 1: Path A — add the confidence key to the reshape dict.** In the `reshaped.append({ ... })` literal, directly after the line `'country': location or None,` add:

```python
                    'location_confidence': _derive_location_confidence(
                        s.get('group_name'), s.get('content_excerpt'), location,
                    ),
```

- [ ] **Step 2: Path B — set confidence in the stamping loop.** Change the loop body from:

```python
        for s in stubs:
            if stamp_niche and not s.get('category'):
                s['category'] = stamp_niche
            if stamp_location and not s.get('country'):
                s['country'] = stamp_location
```

to:

```python
        for s in stubs:
            if stamp_niche and not s.get('category'):
                s['category'] = stamp_niche
            if stamp_location and not s.get('country'):
                s['country'] = stamp_location
            if not s.get('location_confidence'):
                s['location_confidence'] = _derive_location_confidence(
                    s.get('group_name'), s.get('content_excerpt'),
                    s.get('country') or stamp_location,
                )
```

- [ ] **Step 3: Import-smoke the module to confirm no syntax/wiring error**

Run: `./.venv/Scripts/python.exe -c "import tools.scraper.platforms.facebook as f; print(hasattr(f, '_derive_location_confidence'))"`
Expected: prints `True`, no traceback.

- [ ] **Step 4: Re-run the full pure-function suites**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_location_confidence.py tools/scraper/platforms/test_group_relevance.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/scraper/platforms/facebook.py
git commit -m "feat(scraper): stamp location_confidence on FB leads in both build paths

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Migration 049 — `location_confidence` column

**Files:**
- Create: `supabase/migrations/049_lead_location_confidence.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 049_lead_location_confidence.sql
-- Per-lead honesty flag describing how well leads.country (the operator's
-- SEARCH location) matches where the lead actually is. Written only by the FB
-- scraper / audit tool. Allowed values:
--   'confirmed_city' | 'same_country' | 'unconfirmed'
--   ('wrong_country' may appear via audit back-fill of pre-gate historical data)
-- NULL = not yet classified. Additive, non-breaking.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS location_confidence text;
```

- [ ] **Step 2: Commit** (application to Supabase happens in Task 8)

```bash
git add supabase/migrations/049_lead_location_confidence.sql
git commit -m "feat(db): add leads.location_confidence column (migration 049)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Persist `location_confidence` in `upsert_leads.py`

**Files:**
- Modify: `tools/db/upsert_leads.py` (the `leads_row = { ... }` dict in `_upsert_nontrustpilot_lead`, ~lines 211-220)

- [ ] **Step 1: Add the field to `leads_row`.** After the line `'country': lead.get('country'),` add:

```python
        'location_confidence': lead.get('location_confidence'),
```

(The existing `leads_row = {k: v for k, v in leads_row.items() if v is not None}` strips it when absent, preserving the no-null-overwrite convention.)

- [ ] **Step 2: Import-smoke**

Run: `./.venv/Scripts/python.exe -c "import ast; ast.parse(open('tools/db/upsert_leads.py').read()); print('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add tools/db/upsert_leads.py
git commit -m "feat(db): persist location_confidence on non-Trustpilot lead upsert

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `audit_fb_locations.py` — read-only audit + back-fill

Answers "how can we check it": re-derives confidence from the group name + post excerpt ALREADY stored in `lead_platform_posts` — no re-scraping. Surfaces pre-gate `wrong_country` leads for visibility.

**Files:**
- Create: `tools/scraper/audit_fb_locations.py`

- [ ] **Step 1: Write the script**

```python
"""audit_fb_locations.py — read-only location-confidence audit for FB leads.

Re-derives location_confidence for already-scraped Facebook leads from the
group name + post excerpt stored in lead_platform_posts. No re-scraping.

Run from repo root:
    ./.venv/Scripts/python.exe -m tools.scraper.audit_fb_locations --location Bristol
    ./.venv/Scripts/python.exe -m tools.scraper.audit_fb_locations --location Bristol --write
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict

from tools.db.supabase_client import table
from tools.scraper.platforms.facebook import (
    _derive_location_confidence,
    _extract_country_from_excerpt,
)

# Lower rank = more concerning; used for sort order + strongest-wins merge.
_RANK = {'wrong_country': -1, 'unconfirmed': 0, 'same_country': 1, 'confirmed_city': 2}


def _audit_verdict(group_name, excerpt, loc):
    """Like _derive_location_confidence, but adds an audit-only 'wrong_country'
    so historical pre-gate leads (Atlanta on a Bristol search) are visible."""
    base = _derive_location_confidence(group_name, excerpt, loc)
    if base == 'unconfirmed':
        oc = _extract_country_from_excerpt(loc or '')
        dc = _extract_country_from_excerpt(f"{group_name or ''} {excerpt or ''}")
        if dc and oc and dc != oc:
            return 'wrong_country'
    return base


def _best(a, b):
    return a if _RANK[a] >= _RANK[b] else b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--location', help='only leads whose country ILIKE this')
    ap.add_argument('--since', help='only leads scraped on/after this ISO timestamp')
    ap.add_argument('--write', action='store_true', help='back-fill leads.location_confidence')
    args = ap.parse_args()

    posts = (table('lead_platform_posts')
             .select('lead_id,group_name,content_excerpt')
             .eq('platform', 'facebook').execute())
    by_lead = defaultdict(list)
    for p in posts.data:
        if p.get('lead_id'):
            by_lead[p['lead_id']].append(p)

    q = table('leads').select('id,company_name,country,scraped_at,location_confidence')
    if args.location:
        q = q.ilike('country', args.location)
    if args.since:
        q = q.gte('scraped_at', args.since)
    leads = [l for l in q.execute().data if l['id'] in by_lead]

    rows, summary = [], Counter()
    for l in leads:
        loc = l.get('country')
        verdict = 'unconfirmed'
        for p in by_lead[l['id']]:
            verdict = _best(verdict, _audit_verdict(p.get('group_name'), p.get('content_excerpt'), loc))
        first = by_lead[l['id']][0]
        rows.append((l['id'], l.get('company_name') or '', first.get('group_name') or '',
                     verdict, (first.get('content_excerpt') or '').replace('\n', ' ')[:60]))
        summary[verdict] += 1

    print(f"{'CONFIDENCE':<16}{'COMPANY':<26}{'GROUP':<38}EXCERPT")
    for _id, name, group, verdict, excerpt in sorted(rows, key=lambda r: _RANK[r[3]]):
        print(f"{verdict:<16}{name[:25]:<26}{group[:37]:<38}{excerpt}")
    print()
    print('SUMMARY:', dict(summary), f'| {len(leads)} FB leads matched')

    if args.write:
        n = 0
        for _id, _name, _group, verdict, _excerpt in rows:
            table('leads').update({'location_confidence': verdict}).eq('id', _id).execute()
            n += 1
        print(f"WROTE location_confidence for {n} leads")


if __name__ == '__main__':
    main()
```

- [ ] **Step 2: Import-smoke (no DB call)**

Run: `./.venv/Scripts/python.exe -c "import ast; ast.parse(open('tools/scraper/audit_fb_locations.py').read()); print('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add tools/scraper/audit_fb_locations.py
git commit -m "feat(scraper): add read-only FB location-confidence audit + back-fill

Re-derives confidence from stored post data (no re-scrape); --write back-fills
the new column and surfaces pre-gate wrong-country leads.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Apply migration, audit the live batch, smoke-test (operator-gated)

These steps touch the live DB and the logged-in FB account — run WITH the operator, not autonomously.

- [ ] **Step 1: Apply migration 049** — paste into the Supabase SQL editor (or output it for the operator):

```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS location_confidence text;
```

- [ ] **Step 2: Dry-run the audit over the existing Bristol batch (read-only)**

Run: `./.venv/Scripts/python.exe -m tools.scraper.audit_fb_locations --location Bristol`
Expected: a per-lead table + summary. Sanity checks: the four genuine Bristol groups → `confirmed_city`; Atlanta/Washington/Dublin/London-Ontario → `wrong_country`; Jennifer Scott ("T T handyman services") → `unconfirmed`.

- [ ] **Step 3: Back-fill the column**

Run: `./.venv/Scripts/python.exe -m tools.scraper.audit_fb_locations --location Bristol --write`
Expected: `WROTE location_confidence for N leads`. (Drop `--location` to label all historical FB leads.)

- [ ] **Step 4: Live smoke (per the smoke-test-before-ship rule)** — with the operator, run one small fresh FB consumer scrape against a known city (e.g. a Bristol handyman search) from `localhost:3001` and confirm: (a) no foreign-city groups appear in the `group_progress` events, (b) new leads land with a populated `location_confidence`. Verify with the audit dry-run on the new batch.

- [ ] **Step 5: Deploy the EC2 worker** — the scraper runs on the Singapore EC2 box (auto-deploys via its 5-min cron after push). Confirm the branch is pushed so the worker picks up the gate + stamping. No Cloud Run rebuild needed for Python-only scraper changes unless the backend bundles them.

---

## Self-Review

**Spec coverage:**
- Component 1 (city-aware gate) → Task 2 (+ Task 1 province edge). ✓
- Component 2 (`location_confidence` label) → Task 3 (classifier) + Task 4 (wiring) + Task 6 (persist). ✓
- Component 3 (audit/back-fill) → Task 7 + Task 8. ✓
- Component 4 (migration) → Task 5. ✓
- Non-goal "keep `country` = search target" → Task 4 leaves the country stamp untouched, only adds the flag. ✓

**Placeholder scan:** none — every code step has complete code; every run step has an exact command + expected output.

**Type consistency:** `_derive_location_confidence(group_name, post_excerpt, operator_location)` signature is identical in Task 3, Task 4 (both call sites), and Task 7 (via `_audit_verdict`). Return values `confirmed_city`/`same_country`/`unconfirmed` consistent across classifier, tests, and persistence; `wrong_country` is audit-display-only and documented as such in Task 5 and Task 7.
