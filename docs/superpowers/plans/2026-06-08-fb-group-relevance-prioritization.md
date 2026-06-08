# Niche-Aware FB Group Prioritization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Facebook group-first consumer scrape search niche/classifieds/community groups first and cap generic city/lifestyle groups, so non-English markets (Frankfurt-style) stop drowning in lifestyle-group noise without hurting English-market yield.

**Architecture:** Add a pure relevance-tier function and a per-language classifieds/trade vocabulary. The existing KEEP/DROP gate (`_is_consumer_facing_group`) gains a classifieds strong-positive override and an optional `niche` param. A new pure helper (`_order_and_cap_groups`) sorts gated groups by tier (2→1→0) and caps tier-0 generics. `_sync_group_first_scrape` calls the helper, emits a `groups_prioritized` progress event, and searches the ordered+capped list.

**Tech Stack:** Python 3.12, pytest 9.0.3 (already in `.venv`), Selenium/undetected-chromedriver (untouched here — all new logic is pure string functions).

**Spec:** `docs/superpowers/specs/2026-06-08-fb-group-relevance-prioritization-design.md`

**Key facts (verified during planning):**
- All edits are in `tools/scraper/platforms/facebook.py`.
- `_is_consumer_facing_group` is defined at line 914; its ONLY caller is line 2070 (inside `_sync_group_first_scrape`).
- `_sync_group_first_scrape` is defined at line 2048; signature `(self, niche, location, on_progress)`; called from two sites — `scrape_listing` (~line 2196) and `search_posts` (~line 2361), both via `asyncio.to_thread(...)`.
- Language resolution chain works: `_extract_country_from_excerpt("Frankfurt")` → `"DE"`; `COUNTRY_TO_LANGUAGE["DE"]` → `"German"`. `"London"` → `"GB"`, which is NOT in `COUNTRY_TO_LANGUAGE` → falls back to English (intended).
- The production path is `search_posts` (translates niche to local language BEFORE calling `_sync_group_first_scrape`). The `scrape_listing` path passes the un-translated niche — accepted limitation (classifieds tokens still work there).
- Run tests from the **repo root**: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`

---

## File Structure

- **Modify** `tools/scraper/platforms/facebook.py`:
  - New module-level dict `_GROUP_RELEVANCE_VOCAB` (per-language classifieds/trade tokens, for ranking).
  - New module-level dict `_GATE_OVERRIDE_TOKENS` (curated classifieds-only subset, for the gate override).
  - New `_resolve_relevance_language(location) -> str`.
  - New `_group_relevance_tier(name, location, niche) -> int`.
  - New `_order_and_cap_groups(groups, niche, location, generic_group_cap) -> tuple[list, dict]`.
  - `_is_consumer_facing_group(group_name, operator_location=None)` — signature UNCHANGED; add a curated classifieds strong-positive override.
  - Modify `_sync_group_first_scrape` — add `generic_group_cap=5` param; replace the inline group list with `_order_and_cap_groups` output; emit `groups_prioritized`.
  - Update both call sites to pass `generic_group_cap=int(filters.get('generic_group_cap', 5) or 5)`.
- **Create** `tools/scraper/platforms/test_group_relevance.py` — pure-function unit tests.

---

## Task 1: Per-language vocabulary, language resolver, and relevance tier

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (add 3 module-level definitions, placed just ABOVE `_is_consumer_facing_group` at line 914)
- Test: `tools/scraper/platforms/test_group_relevance.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tools/scraper/platforms/test_group_relevance.py`:

```python
"""Unit tests for FB group relevance tiering + capping (pure functions).

Run from repo root:
    ./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v
"""
from tools.scraper.platforms.facebook import (
    _resolve_relevance_language,
    _group_relevance_tier,
)


# Real 2026-06-05 Frankfurt discovery sample (from the next-session brief).
FRANKFURT_GROUPS = [
    "Neu in Frankfurt",
    "Frankfurt Events",
    "Nightlife Frankfurt",
    "EINTRACHT FRANKFURT NEWS",
    "Kleinanzeigen Frankfurt und Umgebung",
    "Elektriker für alle",
]


def test_resolve_language_maps_city_to_local_language():
    assert _resolve_relevance_language("Frankfurt") == "German"
    assert _resolve_relevance_language("Paris") == "French"
    # English-primary city → English fallback (GB not in COUNTRY_TO_LANGUAGE)
    assert _resolve_relevance_language("London") == "English"
    assert _resolve_relevance_language("") == "English"
    assert _resolve_relevance_language(None) == "English"


def test_tier2_niche_token_match():
    # Translated niche term appears in the group name → tier 2.
    assert _group_relevance_tier("Elektriker für alle", "Frankfurt", "Elektriker") == 2


def test_tier2_classifieds_token_german():
    # German classifieds token → tier 2 even when niche doesn't match.
    assert _group_relevance_tier("Kleinanzeigen Frankfurt und Umgebung", "Frankfurt", "Klempner") == 2


def test_tier1_community_token():
    assert _group_relevance_tier("West Hampstead Community", "London", "handyman") == 1


def test_tier0_generic_lifestyle():
    for name in ("Neu in Frankfurt", "Frankfurt Events", "Nightlife Frankfurt", "EINTRACHT FRANKFURT NEWS"):
        assert _group_relevance_tier(name, "Frankfurt", "Elektriker") == 0, name


def test_tier2_english_niche_match_in_london():
    assert _group_relevance_tier("London Handyman Recommendations", "London", "handyman") == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`
Expected: FAIL — `ImportError: cannot import name '_resolve_relevance_language'`.

- [ ] **Step 3: Write minimal implementation**

In `tools/scraper/platforms/facebook.py`, insert this block immediately BEFORE the `def _is_consumer_facing_group(` line (currently line 914):

```python
# Per-language classifieds / general-trade tokens. A group whose name
# contains one of these is a strong consumer/lead signal (tier 2): local
# classifieds boards and trade communities are where people post "looking
# for a <tradesperson>" asks. Language is resolved from the operator's
# location; English tokens are ALWAYS also checked (bilingual group names
# are common). Seed list — expand as real group names surface, same as the
# negative/country token lists above.
_GROUP_RELEVANCE_VOCAB: dict[str, tuple[str, ...]] = {
    'English': ('classifieds', 'for sale', 'buy and sell', 'car boot', 'tradesmen', 'handyman'),
    'German': ('kleinanzeigen', 'marktplatz', 'handwerker', 'flohmarkt', 'gesuche'),
    'French': ('petites annonces', 'artisans', 'bon coin', 'marché'),
    'Italian': ('mercatino', 'annunci', 'artigiani'),
    'Spanish': ('clasificados', 'oficios', 'anuncios', 'mercadillo'),
    'Dutch': ('marktplaats', 'vakmensen', 'klusjesman'),
    'Portuguese': ('classificados', 'anúncios', 'artesãos'),
}

# Consumer-positive tokens that signal a tier-1 (community / help) group.
# Mirrors the POSITIVE_TOKENS used by _is_consumer_facing_group, plus
# locality words that indicate a neighbourhood community group.
_GROUP_TIER1_TOKENS: tuple[str, ...] = (
    'free', 'affordable', 'cheap', 'budget', 'barato', 'mura',
    'help', 'community', 'recommendation', 'recommendations',
    'buy and sell', 'local', 'neighbourhood', 'neighborhood',
)


def _resolve_relevance_language(location: str | None) -> str:
    """Map an operator location (city or country) to its primary language
    name (matching COUNTRY_TO_LANGUAGE values). Falls back to 'English' for
    English-primary or unknown locations."""
    if not location:
        return 'English'
    country = _extract_country_from_excerpt(location)
    if not country:
        return 'English'
    return COUNTRY_TO_LANGUAGE.get(country, 'English')


def _group_relevance_tier(name: str, location: str | None, niche: str | None) -> int:
    """Rank a (gate-surviving) FB group by how likely it is to contain
    consumer service-asks. Pure function, no side effects.

      2 = translated-niche token match, OR per-language classifieds/trade token
      1 = generic consumer-positive token (community/help/local/...)
      0 = generic city/lifestyle group (passed the gate by default only)
    """
    n = (name or '').lower()

    niche_l = (niche or '').strip().lower()
    if niche_l and niche_l in n:
        return 2

    lang = _resolve_relevance_language(location)
    tokens = set(_GROUP_RELEVANCE_VOCAB.get(lang, ())) | set(_GROUP_RELEVANCE_VOCAB['English'])
    if any(tok in n for tok in tokens):
        return 2

    if any(tok in n for tok in _GROUP_TIER1_TOKENS):
        return 1

    return 0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add "tools/scraper/platforms/facebook.py" "tools/scraper/platforms/test_group_relevance.py"
git commit -m "feat(scraper): add FB group relevance tiering + per-language classifieds vocab

Pure tiering function ranks discovered groups 2/1/0 by niche-token and
per-language classifieds/trade signals; used next to prioritize search order.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add a curated classifieds strong-positive override to the gate

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (`_is_consumer_facing_group` — signature UNCHANGED; add `_GATE_OVERRIDE_TOKENS` dict + override block)
- Test: `tools/scraper/platforms/test_group_relevance.py`

- [ ] **Step 1: Impact analysis (CLAUDE.md GitNexus rule)**

Run impact analysis before editing the symbol. If the GitNexus MCP tools are available:
`gitnexus_impact({target: "_is_consumer_facing_group", direction: "upstream"})`
Report the blast radius. If GitNexus is unavailable, fall back to:
`grep -n "_is_consumer_facing_group" tools/scraper/platforms/facebook.py`
Expected: exactly TWO hits — the definition and one call (inside `_sync_group_first_scrape`). The signature is UNCHANGED (still 2-arg), so this edit is fully non-breaking. Proceed (risk: LOW).

- [ ] **Step 2: Write the failing test**

Append to `tools/scraper/platforms/test_group_relevance.py`:

```python
from tools.scraper.platforms.facebook import _is_consumer_facing_group


def test_gate_keeps_classifieds_group():
    # German classifieds board → KEEP (no negative present anyway).
    assert _is_consumer_facing_group("Kleinanzeigen Frankfurt und Umgebung", "Frankfurt") is True


def test_gate_classifieds_overrides_a_negative_token():
    # 'flohmarkt' (DE classifieds override token) co-occurs with the
    # 'equipment' negative; the classifieds override must win → KEEP.
    assert _is_consumer_facing_group("Flohmarkt Equipment Frankfurt", "Frankfurt") is True


def test_gate_trade_role_word_does_NOT_rescue_b2b_supplier():
    # 'handyman' is a trade-role word (tier-2 for ranking) but is NOT a gate
    # override token, so the 'suppliers' negative still wins → DROP.
    assert _is_consumer_facing_group("Handyman Suppliers UK", "London") is False


def test_gate_backcompat_unchanged():
    # Existing behavior preserved for non-classifieds names.
    assert _is_consumer_facing_group("West Hampstead Community", "London") is True
    assert _is_consumer_facing_group("Dental Equipment Suppliers", "London") is False
```

- [ ] **Step 3: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v -k gate`
Expected: FAIL — `test_gate_classifieds_overrides_a_negative_token` fails (today "Flohmarkt Equipment Frankfurt" is dropped by the `'equipment'` negative).

- [ ] **Step 4: Write minimal implementation**

First add a new module-level dict. Place it immediately AFTER `_GROUP_RELEVANCE_VOCAB` (the dict added in Task 1):

```python
# Curated CONSUMER-CLASSIFIEDS tokens used ONLY as a gate override in
# _is_consumer_facing_group: a name carrying one of these is an unambiguous
# consumer classifieds / flea-market / for-sale board, so it KEEPS even if
# it also trips a generic negative token (e.g. 'equipment'). This is a
# STRICT SUBSET of _GROUP_RELEVANCE_VOCAB — it deliberately omits the
# trade-role words (handyman/handwerker/artisans/...), because those
# co-occur with B2B negatives ("Handyman Suppliers") and must NOT override.
# Trade-role words still earn tier-2 for RANKING via _group_relevance_tier.
_GATE_OVERRIDE_TOKENS: dict[str, tuple[str, ...]] = {
    'English': ('classifieds', 'for sale', 'buy and sell', 'car boot'),
    'German': ('kleinanzeigen', 'marktplatz', 'flohmarkt', 'gesuche'),
    'French': ('petites annonces', 'bon coin'),
    'Italian': ('mercatino', 'annunci'),
    'Spanish': ('clasificados', 'anuncios', 'mercadillo'),
    'Dutch': ('marktplaats',),
    'Portuguese': ('classificados', 'anúncios'),
}
```

Then edit `_is_consumer_facing_group`. Leave the signature UNCHANGED. The function already computes `name = (group_name or '').lower()` near the top and runs the Stage-1 country-mismatch block. Insert this override AFTER the Stage-1 block (the `if operator_location:` block ending in `return False`) and BEFORE the `POSITIVE_TOKENS = (` line, reusing the existing `name` variable:

```python
    # Stage 2a (NEW): a curated consumer-classifieds token is a STRONG
    # positive — a local classifieds / flea-market / for-sale board is
    # exactly where consumer service-asks live, so KEEP it even if the name
    # also carries a generic negative token (e.g. 'equipment'). Uses the
    # CURATED _GATE_OVERRIDE_TOKENS subset (NOT the full relevance vocab):
    # trade-role words like 'handyman' co-occur with B2B negatives and must
    # NOT override here. Niche is irrelevant to the gate (ranking-only).
    _lang = _resolve_relevance_language(operator_location)
    _override = set(_GATE_OVERRIDE_TOKENS.get(_lang, ())) | set(_GATE_OVERRIDE_TOKENS['English'])
    if any(tok in name for tok in _override):
        return True
```

Do NOT add or remove the `name = ...` assignment (it already exists at the top of the function); do NOT change the signature; leave POSITIVE_TOKENS / NEGATIVE_TOKENS / default `return True` exactly as is.

- [ ] **Step 5: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`
Expected: PASS (all tests — Task-1 tests + the new gate tests).

- [ ] **Step 6: Commit**

```bash
git add "tools/scraper/platforms/facebook.py" "tools/scraper/platforms/test_group_relevance.py"
git commit -m "feat(scraper): classifieds groups override negative tokens in FB gate

_is_consumer_facing_group keeps genuine classifieds/flea-market boards
('Kleinanzeigen'/'Flohmarkt') even when a generic negative co-occurs, via a
curated _GATE_OVERRIDE_TOKENS subset. Trade-role words and niche matches do
NOT override (keeps B2B 'Handyman Suppliers' dropped).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Order-and-cap helper

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (add `_order_and_cap_groups` just below `_group_relevance_tier`)
- Test: `tools/scraper/platforms/test_group_relevance.py`

- [ ] **Step 1: Write the failing test**

Append to `tools/scraper/platforms/test_group_relevance.py`:

```python
from tools.scraper.platforms.facebook import _order_and_cap_groups


def _g(name, gid):
    return {"name": name, "group_id": gid}


def test_order_and_cap_sorts_by_tier_and_caps_generics():
    groups = [
        _g("Frankfurt Events", "1"),            # tier 0
        _g("Kleinanzeigen Frankfurt", "2"),     # tier 2
        _g("Nightlife Frankfurt", "3"),         # tier 0
        _g("Neu in Frankfurt", "4"),            # tier 0
        _g("Elektriker für alle", "5"),         # tier 2 (niche)
        _g("Frankfurt Community", "6"),         # tier 1
        _g("EINTRACHT FRANKFURT NEWS", "7"),    # tier 0
    ]
    ordered, stats = _order_and_cap_groups(groups, niche="Elektriker", location="Frankfurt", generic_group_cap=1)

    ids = [g["group_id"] for g in ordered]
    # tier-2 first (in discovery order: 2 then 5), then tier-1 (6), then ONE generic (1).
    assert ids == ["2", "5", "6", "1"]
    assert stats == {"relevant": 3, "generic_searched": 1, "generic_skipped": 3}


def test_order_and_cap_zero_cap_drops_all_generics():
    groups = [_g("Frankfurt Events", "1"), _g("Kleinanzeigen Frankfurt", "2")]
    ordered, stats = _order_and_cap_groups(groups, niche="Elektriker", location="Frankfurt", generic_group_cap=0)
    assert [g["group_id"] for g in ordered] == ["2"]
    assert stats == {"relevant": 1, "generic_searched": 0, "generic_skipped": 1}


def test_order_and_cap_all_relevant_keeps_everything():
    groups = [_g("Kleinanzeigen Frankfurt", "1"), _g("Handwerker Frankfurt", "2")]
    ordered, stats = _order_and_cap_groups(groups, niche="Klempner", location="Frankfurt", generic_group_cap=5)
    assert len(ordered) == 2
    assert stats == {"relevant": 2, "generic_searched": 0, "generic_skipped": 0}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v -k order_and_cap`
Expected: FAIL — `ImportError: cannot import name '_order_and_cap_groups'`.

- [ ] **Step 3: Write minimal implementation**

In `tools/scraper/platforms/facebook.py`, immediately AFTER the `_group_relevance_tier` function added in Task 1, add:

```python
def _order_and_cap_groups(
    groups: list,
    niche: str | None,
    location: str | None,
    generic_group_cap: int = 5,
) -> tuple[list, dict]:
    """Order gate-surviving groups by relevance tier (2 → 1 → 0, stable
    within a tier) and cap how many tier-0 generic groups are searched.

    Returns (ordered_kept_groups, stats) where stats has integer keys
    'relevant' (tier>=1 count), 'generic_searched', 'generic_skipped'.
    Pure function — does no I/O.
    """
    tiered = [(_group_relevance_tier(g.get('name', ''), location, niche), g) for g in groups]
    # Stable sort, highest tier first (negate tier; sorted() is stable so
    # discovery order is preserved within each tier).
    tiered.sort(key=lambda t: -t[0])

    kept: list = []
    relevant = 0
    generic_searched = 0
    generic_skipped = 0
    for tier, g in tiered:
        if tier >= 1:
            kept.append(g)
            relevant += 1
        elif generic_searched < generic_group_cap:
            kept.append(g)
            generic_searched += 1
        else:
            generic_skipped += 1

    return kept, {
        'relevant': relevant,
        'generic_searched': generic_searched,
        'generic_skipped': generic_skipped,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add "tools/scraper/platforms/facebook.py" "tools/scraper/platforms/test_group_relevance.py"
git commit -m "feat(scraper): add order-and-cap helper for FB group search priority

Sorts gated groups by relevance tier and caps tier-0 generics; returns
stats for the groups_prioritized progress event.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire prioritization into `_sync_group_first_scrape`

**Files:**
- Modify: `tools/scraper/platforms/facebook.py:2048-2113` (`_sync_group_first_scrape`)
- Modify: `tools/scraper/platforms/facebook.py` ~line 2196 (`scrape_listing` call site)
- Modify: `tools/scraper/platforms/facebook.py` ~line 2361 (`search_posts` call site)

- [ ] **Step 1: Impact analysis**

If GitNexus is available: `gitnexus_impact({target: "_sync_group_first_scrape", direction: "upstream"})`.
Fallback: `grep -n "_sync_group_first_scrape" tools/scraper/platforms/facebook.py`
Expected callers: the two `asyncio.to_thread(self._sync_group_first_scrape, ...)` sites (~2196, ~2361). Adding a trailing `generic_group_cap=5` default param is non-breaking. Risk: LOW.

- [ ] **Step 2: Change the signature + pass niche into the gate + apply ordering/cap**

Edit `_sync_group_first_scrape`. Change the signature (line 2048):

```python
    def _sync_group_first_scrape(
        self,
        niche: str,
        location: str,
        on_progress: ProgressCallback,
        generic_group_cap: int = 5,
    ) -> list:
```

Then replace the gate-filter block. The current block (lines 2070-2077) is:

```python
        groups = [g for g in groups_raw if _is_consumer_facing_group(g.get('name', ''), location)]
        dropped_pro = len(groups_raw) - len(groups)
        if dropped_pro:
            _emit(on_progress, 'groups_filtered', dropped=dropped_pro, kept=len(groups),
                  reason='professional/job/supplier groups removed')
        if not groups:
            _emit(on_progress, 'groups_found', count=0)
            return []
```

Replace it with (gate stays 2-arg; niche is used only for ranking in the order+cap helper):

```python
        gated = [g for g in groups_raw if _is_consumer_facing_group(g.get('name', ''), location)]
        dropped_pro = len(groups_raw) - len(gated)
        if dropped_pro:
            _emit(on_progress, 'groups_filtered', dropped=dropped_pro, kept=len(gated),
                  reason='professional/job/supplier groups removed')
        if not gated:
            _emit(on_progress, 'groups_found', count=0)
            return []

        # Prioritize niche/classifieds/community groups; cap generic
        # city/lifestyle groups so non-English markets stop drowning in
        # lifestyle-group noise (and we don't burn account quota on it).
        groups, prio = _order_and_cap_groups(gated, niche, location, generic_group_cap)
        _emit(on_progress, 'groups_prioritized',
              relevant=prio['relevant'],
              generic_searched=prio['generic_searched'],
              generic_skipped=prio['generic_skipped'])
        if not groups:
            _emit(on_progress, 'groups_found', count=0)
            return []
```

Leave the rest of `_sync_group_first_scrape` (the `in_group_keyword`, session reuse, per-group loop) unchanged — it already iterates `groups`.

- [ ] **Step 3: Update the `scrape_listing` call site (~line 2196)**

Current:

```python
                post_stubs = await asyncio.to_thread(
                    self._sync_group_first_scrape, niche, location, on_progress,
                )
```

Change to:

```python
                post_stubs = await asyncio.to_thread(
                    self._sync_group_first_scrape, niche, location, on_progress,
                    int(filters.get('generic_group_cap', 5) or 5),
                )
```

- [ ] **Step 4: Update the `search_posts` call site (~line 2361)**

Current:

```python
            stubs = await asyncio.to_thread(
                self._sync_group_first_scrape, niche, location, on_progress,
            )
```

Change to:

```python
            stubs = await asyncio.to_thread(
                self._sync_group_first_scrape, niche, location, on_progress,
                int(filters.get('generic_group_cap', 5) or 5),
            )
```

- [ ] **Step 5: Sanity-check the module imports + tests still pass**

Run: `./.venv/Scripts/python.exe -c "from tools.scraper.platforms import facebook; print('import OK')"`
Expected: `import OK` (no syntax/indentation errors).

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add "tools/scraper/platforms/facebook.py"
git commit -m "feat(scraper): prioritize + cap FB groups in group-first scrape

_sync_group_first_scrape now passes the niche into the consumer gate, then
orders survivors by relevance tier and caps tier-0 generics (filter knob
generic_group_cap, default 5). Emits a groups_prioritized progress event.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Live smoke runs (MANDATORY before push — smoke-test-before-ship rule)

**Files:** none (verification only). Runs against real Facebook via a connected `social_accounts` row; needs the Windows machine with a logged-in FB session.

> ⚠️ Live FB scrape — consumes account quota and hits the network. Confirm with the operator before running, and that an `active` FB `social_accounts` row exists.

- [ ] **Step 1: Frankfurt electrician re-run**

Run (repo root):

```bash
./.venv/Scripts/python.exe tools/scraper/run.py --platform facebook --action search-posts \
  --filters '{"lead_type":"consumers","niche":"electrician","location":"Frankfurt","groups_only":true}'
```

Expected in the progress output:
- a `niche_translated` event (`electrician` → `Elektriker`)
- a `groups_prioritized` event with a non-trivial `generic_skipped` (the lifestyle groups), e.g. `relevant=5 generic_searched=5 generic_skipped~=25`
- `> 0` posts kept after the classifier (the design's success bar). Record the actual lead count.

- [ ] **Step 2: London handyman regression check**

Run:

```bash
./.venv/Scripts/python.exe tools/scraper/run.py --platform facebook --action search-posts \
  --filters '{"lead_type":"consumers","niche":"handyman","location":"London","groups_only":true}'
```

Expected: yield in the same ballpark as the prior ~32 (community + niche groups searched first; generics capped). Record the count. If it dropped materially, the tier-1 token set is too narrow — note which good groups landed in tier 0 and widen `_GROUP_TIER1_TOKENS` before shipping.

- [ ] **Step 3: Record results in the spec**

Append a short "Smoke results 2026-06-08" note (Frankfurt lead count, London lead count, sample `groups_prioritized` numbers) to the bottom of `docs/superpowers/specs/2026-06-08-fb-group-relevance-prioritization-design.md` and commit it:

```bash
git add "docs/superpowers/specs/2026-06-08-fb-group-relevance-prioritization-design.md"
git commit -m "docs(scraper): record FB group prioritization smoke results

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Pre-ship verification + handoff

- [ ] **Step 1: Full test pass**

Run: `./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v`
Expected: all PASS.

- [ ] **Step 2: detect_changes scope check (CLAUDE.md rule)**

If GitNexus is available: `gitnexus_detect_changes({scope: "staged"})` (or `compare` vs `main`) and confirm only the FB plugin + the new test file changed. Fallback: `git status` / `git diff --stat main`.

- [ ] **Step 3: Refresh the GitNexus index (post-commit)**

`npx gitnexus analyze --embeddings` (preserve embeddings if `.gitnexus/meta.json` `stats.embeddings` > 0). A PostToolUse hook may already do this on commit.

- [ ] **Step 4: Output deploy commands for the operator (do NOT run — deployment policy)**

The scraper runs on the Windows EC2 worker, not Cloud Run, so this is a push + worker pull, not a `gcloud run deploy`. Output for the operator to run:

```bash
git push origin main
```

Then (per the EC2 deploy memory) either wait for the 5-min deploy cron on the Windows EC2 box, or trigger the manual `git pull / npm run build / nssm restart scraper-worker` via SSM. Frontend SSE consumers tolerate the new `groups_prioritized` stage (unknown stages are ignored), so no frontend change is required.

---

## Self-Review (completed during planning)

- **Spec coverage:** §Architecture-1 (gate override) → Task 2; §Architecture-2 (tier fn) → Task 1; §Architecture-3 (order+cap in `_sync_group_first_scrape`) → Tasks 3+4; §Architecture-4 (per-language vocab) → Task 1; §Architecture-5 (`generic_group_cap` knob) → Task 4; §Known-Limitation (un-translated scrape_listing path) → covered (classifieds tokens still fire); §Testing (unit + live smoke) → Tasks 1-3 + Task 5. ✅
- **Refinement vs spec:** the spec said the niche term joins the gate strong-positive; the plan narrows this so the niche is RANKING-only and does NOT override negatives (prevents "Plumber Suppliers" resurrection). Sync the spec §Architecture-1 to match (one-line edit) when implementing, or note it. This is the one intentional deviation.
- **Type consistency:** `_group_relevance_tier(name, location, niche)`, `_order_and_cap_groups(groups, niche, location, generic_group_cap)`, stats keys `relevant`/`generic_searched`/`generic_skipped`, and the `groups_prioritized` event fields are used identically across Tasks 1, 3, and 4. ✅
- **Placeholder scan:** no TBD/TODO; every code step has complete code. ✅
