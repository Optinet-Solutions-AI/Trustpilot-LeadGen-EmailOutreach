"""Tests for the canonical lead-category map.

Run with: pytest tools/db/test_category_canonical.py -v
"""
from __future__ import annotations

import os
import re
import sys

import pytest

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from tools.db.category_canonical import (  # noqa: E402
    ALIAS_TO_CANONICAL,
    CANONICAL_FAMILIES,
    DELIBERATELY_UNMERGED,
    canonicalize_category,
    category_family,
    category_filter_patterns,
    slugify_category,
)

# Every distinct `leads.category` value in the live table, surveyed across all
# 13,251 rows on 2026-08-04. This is the regression fence: canonicalisation
# must do something predictable to every single one of them and nothing at all
# to the ones we deliberately left fragmented.
LIVE_INVENTORY: tuple[str, ...] = (
    'casino', 'money_insurance', 'gaming', 'investment_service', 'gambling',
    'event_management_company', 'betting_agency', 'car_dealer', 'dental_services',
    'utilities', 'video_game_store', 'online_casino_or_bookmaker', 'game_store',
    'online_sports_betting', 'bars_cafes', 'clinics', 'restaurants_bars',
    'gambling_service', 'hvac', 'repair_services', 'electronics_technology',
    'hotels', 'handyman', 'shopping_fashion', 'autorepair', 'gyms', 'event_venue',
    'gambling_house', 'electrician', 'electricians', 'events_entertainment',
    'plumbing', 'wellness_spa', 'contractors', 'amusement_center', 'bingo_hall',
    'salons_clinics', 'roofing', 'plumbers', 'clothing_store', 'lottery_vendor',
    'restaurants', 'wedding_venue', 'theater_opera', 'chiropractors', 'lawyers',
    'landscaping', 'bookmaker', 'locksmiths', 'online_lottery_ticket_vendor',
    'travel_vacation', 'shipping_logistics', 'animals_pets', 'gambling_instructor',
    'gaming_service_provider', 'plumber', 'lottery_retailer',
    'contractors_consultants', 'lottery_shop',
)


# ─────────────────────── safe variants canonicalise ────────────────────────

@pytest.mark.parametrize(('raw', 'expected'), [
    # the two families the operator actually complained about
    ('plumber', 'plumber'),
    ('plumbers', 'plumber'),
    ('plumbing', 'plumber'),
    ('plumbing_service', 'plumber'),
    ('plumbing_services', 'plumber'),
    ('electrician', 'electrician'),
    ('electricians', 'electrician'),
    ('electrical', 'electrician'),
    ('electrical_services', 'electrician'),
    # remaining trades — activity noun folds onto the agent noun
    ('roofing', 'roofer'),
    ('roofers', 'roofer'),
    ('landscaping', 'landscaper'),
    ('landscapers', 'landscaper'),
    ('handymen', 'handyman'),
    ('locksmiths', 'locksmith'),
    ('chiropractors', 'chiropractor'),
    ('lawyers', 'lawyer'),
    ('contractors', 'contractor'),
    # business kinds — plural folds onto singular
    ('restaurants', 'restaurant'),
    ('hotels', 'hotel'),
    ('gyms', 'gym'),
    ('clinics', 'clinic'),
    # sector slugs — platform form stays canonical, variants fold onto it
    ('hvac_services', 'hvac'),
    ('auto_repair', 'autorepair'),
    ('auto_repair_shop', 'autorepair'),
    ('car_dealership', 'car_dealer'),
    ('car_dealers', 'car_dealer'),
    ('game_stores', 'game_store'),
    ('video_game_stores', 'video_game_store'),
    ('clothing_stores', 'clothing_store'),
    ('event_venues', 'event_venue'),
    ('wedding_venues', 'wedding_venue'),
    ('utility', 'utilities'),
])
def test_safe_variants_canonicalise(raw: str, expected: str) -> None:
    assert canonicalize_category(raw) == expected


def test_every_declared_alias_maps_to_its_canonical() -> None:
    """No family member may be left behind — the whole point of the map."""
    for canonical, aliases in CANONICAL_FAMILIES.items():
        for alias in aliases:
            assert canonicalize_category(alias) == canonical, (
                f"alias {alias!r} of family {canonical!r} does not canonicalise"
            )


def test_canonical_forms_are_idempotent() -> None:
    for canonical in CANONICAL_FAMILIES:
        assert canonicalize_category(canonical) == canonical
        assert canonicalize_category(canonicalize_category(canonical)) == canonical


# ─────────────────────── unsafe values pass through ────────────────────────

def test_gambling_cluster_is_untouched() -> None:
    """3,000+ rows of live outreach. Merging these is a commercial call."""
    for value in DELIBERATELY_UNMERGED['gambling_cluster']:
        assert canonicalize_category(value) == value, (
            f"{value!r} was merged — the gambling cluster must stay fragmented"
        )


def test_deliberately_unmerged_values_stay_distinct() -> None:
    """Every value we chose not to merge canonicalises to ITSELF, and no two
    members of the same look-alike cluster collapse onto one another."""
    for cluster, values in DELIBERATELY_UNMERGED.items():
        canonicals = [canonicalize_category(v) for v in values]
        for value, canonical in zip(values, canonicals):
            assert canonical == value, f"{cluster}: {value!r} -> {canonical!r}"
        assert len(set(canonicals)) == len(canonicals), (
            f"{cluster}: two members collapsed onto the same canonical"
        )


def test_whole_live_inventory_is_either_a_known_alias_or_unchanged() -> None:
    """No value in the live table may be silently rewritten into something
    that is not a declared family alias."""
    for value in LIVE_INVENTORY:
        canonical = canonicalize_category(value)
        if canonical != value:
            assert value in ALIAS_TO_CANONICAL, (
                f"{value!r} changed to {canonical!r} without a declared family"
            )


def test_unknown_values_pass_through_unchanged() -> None:
    for value in ('pet_grooming', 'bail_bonds', 'zzz_not_a_real_category'):
        assert canonicalize_category(value) == value


# ─────────────────────────── slugify behaviour ─────────────────────────────

@pytest.mark.parametrize(('raw', 'expected'), [
    ('  Plumber  ', 'plumber'),
    ('Plumbers', 'plumber'),
    ('PLUMBING', 'plumber'),
    ('Auto Repair', 'autorepair'),
    ('auto-repair', 'autorepair'),
])
def test_messy_operator_input_is_normalised(raw: str, expected: str) -> None:
    assert canonicalize_category(raw) == expected


@pytest.mark.parametrize('raw', [None, '', '   ', '---', '&&&'])
def test_empty_ish_input_is_none(raw: str | None) -> None:
    assert canonicalize_category(raw) is None
    assert slugify_category(raw) is None
    assert category_family(raw) == []
    assert category_filter_patterns(raw) == []


def test_slugify_is_a_noop_on_the_entire_live_inventory() -> None:
    """Existing rows are all snake_case already, so slugification alone can
    never rewrite live data — only declared aliases can."""
    for value in LIVE_INVENTORY:
        assert slugify_category(value) == value


def test_free_text_is_slugified_not_mangled() -> None:
    assert slugify_category('Pool Cleaning') == 'pool_cleaning'
    assert slugify_category('Plumbing & Heating') == 'plumbing_heating'


# ──────────────────────────── family symmetry ──────────────────────────────

def test_family_lookup_is_symmetric() -> None:
    """Canonicalising any member yields the canonical, and the canonical's
    family contains every member. Both directions, every family."""
    for canonical, aliases in CANONICAL_FAMILIES.items():
        family = category_family(canonical)
        assert family[0] == canonical, 'canonical must come first'
        assert set(family) == set(aliases)
        for alias in aliases:
            assert canonicalize_category(alias) == canonical
            assert category_family(alias) == family, (
                f"family({alias!r}) differs from family({canonical!r})"
            )


def test_family_of_unknown_value_is_just_itself() -> None:
    assert category_family('pet_grooming') == ['pet_grooming']
    assert category_family('casino') == ['casino']


def test_no_alias_is_claimed_by_two_families() -> None:
    seen: dict[str, str] = {}
    for canonical, aliases in CANONICAL_FAMILIES.items():
        for alias in aliases:
            assert alias not in seen or seen[alias] == canonical, (
                f"{alias!r} claimed by {seen.get(alias)!r} and {canonical!r}"
            )
            seen[alias] = canonical
    assert seen == ALIAS_TO_CANONICAL


# ─────────────────────────── filter needles ────────────────────────────────

def test_filter_patterns_drop_redundant_needles() -> None:
    """%plumbing% already matches plumbing_services, so only the short needle
    survives — the generated or=(...) has to fit in a REST URL."""
    assert category_filter_patterns('plumbers') == ['plumber', 'plumbing']
    assert category_filter_patterns('electricians') == ['electrical', 'electrician']
    assert category_filter_patterns('hvac') == ['hvac']


def test_filter_patterns_cover_every_family_member() -> None:
    """Every label in the family must be matched by at least one needle,
    treating each needle as a case-insensitive substring match."""
    for canonical, aliases in CANONICAL_FAMILIES.items():
        needles = category_filter_patterns(canonical)
        for alias in aliases:
            assert any(n in alias for n in needles), (
                f"family {canonical!r}: no needle matches {alias!r}"
            )


def test_filter_needles_are_url_safe() -> None:
    """Needles are interpolated into a PostgREST or=(...) list — a comma or a
    paren would break the expression, so they must be slug characters only."""
    for value in (*LIVE_INVENTORY, 'Bar, Cafe (Downtown)', "o'brien plumbing"):
        for needle in category_filter_patterns(value):
            assert re.fullmatch(r'[a-z0-9_]+', needle), needle


def test_partial_typing_still_works() -> None:
    """The Lead Matrix has always let the operator type a fragment. 'plumb'
    is not a family member, so it stays a single substring needle."""
    assert category_filter_patterns('plumb') == ['plumb']


# ───────────────────── drift guard: Python vs TypeScript ───────────────────

_TS_MIRROR = os.path.join(_PROJECT_ROOT, 'server', 'src', 'services', 'lead-categories.ts')


def _parse_ts_families(source: str) -> dict[str, tuple[str, ...]]:
    """Pull CANONICAL_FAMILIES out of the TypeScript mirror.

    Deliberately dumb line-based parsing: it only understands the one-family-
    per-line format both files are written in, so a reformat that breaks the
    parse fails the test instead of silently passing.
    """
    lines = source.splitlines()
    start = next(
        (i for i, line in enumerate(lines) if 'CANONICAL_FAMILIES' in line and '=' in line),
        None,
    )
    assert start is not None, 'CANONICAL_FAMILIES not found in the TS mirror'
    families: dict[str, tuple[str, ...]] = {}
    for line in lines[start + 1:]:
        if line.startswith('};'):
            break
        match = re.match(r"\s*([a-z0-9_]+):\s*\[([^\]]*)\],?\s*$", line)
        if match:
            members = re.findall(r"'([a-z0-9_]+)'", match.group(2))
            families[match.group(1)] = tuple(members)
    return families


def test_typescript_mirror_has_not_drifted() -> None:
    with open(_TS_MIRROR, 'r', encoding='utf-8') as handle:
        ts_families = _parse_ts_families(handle.read())

    assert ts_families, 'parsed no families out of the TS mirror — check its format'
    assert sorted(ts_families) == sorted(CANONICAL_FAMILIES), (
        'canonical key sets differ between '
        'tools/db/category_canonical.py and server/src/services/lead-categories.ts:\n'
        f"  only in Python: {sorted(set(CANONICAL_FAMILIES) - set(ts_families))}\n"
        f"  only in TS:     {sorted(set(ts_families) - set(CANONICAL_FAMILIES))}"
    )
    for canonical, aliases in CANONICAL_FAMILIES.items():
        assert ts_families[canonical] == aliases, (
            f"family {canonical!r} differs between Python and TS:\n"
            f"  Python: {aliases}\n"
            f"  TS:     {ts_families[canonical]}"
        )
