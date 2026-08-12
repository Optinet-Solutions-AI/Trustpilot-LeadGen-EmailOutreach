"""Backfill-planner tests — the destructive half, so the guard rails matter.

Covers: the plan only ever proposes declared family aliases, dry run is the
default, and --apply is the only thing that writes.

Run with: pytest tools/db/test_backfill_lead_categories.py -v
"""
from __future__ import annotations

import os
import sys
from collections import Counter

import pytest

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from tools.db import backfill_lead_categories as mod  # noqa: E402
from tools.db.category_canonical import ALIAS_TO_CANONICAL  # noqa: E402

# The live inventory (all 13,251 rows, surveyed 2026-08-04) with real counts,
# so the planner is exercised against the data it will actually meet.
LIVE_COUNTS: Counter[str | None] = Counter({
    'casino': 1913, 'money_insurance': 1718, 'gaming': 1257, 'investment_service': 1197,
    'gambling': 983, 'event_management_company': 485, 'betting_agency': 474,
    'car_dealer': 464, 'dental_services': 445, 'utilities': 383, 'video_game_store': 355,
    'online_casino_or_bookmaker': 305, 'game_store': 287, 'online_sports_betting': 227,
    'bars_cafes': 227, 'clinics': 222, 'restaurants_bars': 191, 'gambling_service': 151,
    'hvac': 141, 'repair_services': 119, 'electronics_technology': 105, 'hotels': 101,
    'handyman': 94, 'shopping_fashion': 86, 'autorepair': 82, 'gyms': 82,
    'event_venue': 81, 'gambling_house': 81, 'electrician': 80, 'electricians': 78,
    'events_entertainment': 73, 'plumbing': 66, 'wellness_spa': 63, 'contractors': 54,
    'amusement_center': 48, 'bingo_hall': 47, 'salons_clinics': 42, 'roofing': 42,
    'plumbers': 39, 'clothing_store': 35, 'lottery_vendor': 34, None: 32,
    'restaurants': 28, 'wedding_venue': 27, 'theater_opera': 26, 'chiropractors': 25,
    'lawyers': 25, 'landscaping': 22, 'bookmaker': 21, 'locksmiths': 20,
    'online_lottery_ticket_vendor': 18, 'travel_vacation': 18, 'shipping_logistics': 11,
    'animals_pets': 4, 'gambling_instructor': 4, 'gaming_service_provider': 4,
    'plumber': 4, 'lottery_retailer': 2, 'contractors_consultants': 2, 'lottery_shop': 1,
})


def test_plan_only_proposes_declared_aliases() -> None:
    rewrites, _skipped = mod.plan_changes(LIVE_COUNTS)
    assert rewrites, 'expected the live inventory to need some rewrites'
    for from_value, to_value, _count in rewrites:
        assert from_value in ALIAS_TO_CANONICAL, (
            f"{from_value!r} is not a declared family alias — the backfill must "
            f"never rewrite a value on a guess"
        )
        assert ALIAS_TO_CANONICAL[from_value] == to_value


def test_plan_leaves_the_gambling_cluster_alone() -> None:
    rewrites, skipped = mod.plan_changes(LIVE_COUNTS)
    touched = {r[0] for r in rewrites} | {s[0] for s in skipped}
    for value in (
        'casino', 'gambling', 'gambling_service', 'gambling_house',
        'online_casino_or_bookmaker', 'betting_agency', 'bingo_hall',
        'online_sports_betting', 'bookmaker', 'gaming',
    ):
        assert value not in touched, f"{value!r} appeared in the backfill plan"


def test_plan_covers_the_expected_families() -> None:
    rewrites, _skipped = mod.plan_changes(LIVE_COUNTS)
    plan = {(f, t): c for f, t, c in rewrites}
    assert plan[('plumbing', 'plumber')] == 66
    assert plan[('plumbers', 'plumber')] == 39
    assert plan[('electricians', 'electrician')] == 78
    assert plan[('clinics', 'clinic')] == 222
    assert plan[('roofing', 'roofer')] == 42
    # already canonical -> absent from the plan entirely
    assert not any(f == 'plumber' for f, _t, _c in rewrites)
    assert not any(f == 'electrician' for f, _t, _c in rewrites)
    assert not any(f == 'hvac' for f, _t, _c in rewrites)
    assert not any(f == 'utilities' for f, _t, _c in rewrites)


def test_plan_ignores_null_categories() -> None:
    rewrites, skipped = mod.plan_changes(LIVE_COUNTS)
    assert None not in {r[0] for r in rewrites}
    assert None not in {s[0] for s in skipped}


def test_slugify_only_changes_are_reported_not_rewritten() -> None:
    """A value that is neither canonical nor a declared alias must be surfaced
    for the operator and left in the table."""
    counts: Counter[str | None] = Counter({'Pool Cleaning': 3, 'plumbers': 5})
    rewrites, skipped = mod.plan_changes(counts)
    assert [(f, t, c) for f, t, c in rewrites] == [('plumbers', 'plumber', 5)]
    assert skipped == [('Pool Cleaning', 'pool_cleaning', 3)]


def test_plan_is_sorted_by_row_count_descending() -> None:
    rewrites, _skipped = mod.plan_changes(LIVE_COUNTS)
    counts = [c for _f, _t, c in rewrites]
    assert counts == sorted(counts, reverse=True)


# ───────────────────────────── dry-run safety ──────────────────────────────

def test_dry_run_is_the_default_and_writes_nothing(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(sys, 'argv', ['backfill_lead_categories.py'])
    monkeypatch.setattr(mod, 'fetch_category_counts', lambda: LIVE_COUNTS)

    def _explode(*_args: object, **_kwargs: object) -> int:
        raise AssertionError('apply_rewrite must not run without --apply')

    monkeypatch.setattr(mod, 'apply_rewrite', _explode)

    assert mod.main() == 0
    out = capsys.readouterr().out
    assert 'DRY RUN (no writes)' in out
    assert 'nothing was written' in out
    assert 'plumbers' in out and 'plumber' in out


def test_apply_flag_writes_every_planned_rewrite(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(sys, 'argv', ['backfill_lead_categories.py', '--apply'])
    monkeypatch.setattr(mod, 'fetch_category_counts', lambda: LIVE_COUNTS)
    applied: list[tuple[str, str]] = []

    def _record(from_value: str, to_value: str) -> int:
        applied.append((from_value, to_value))
        return LIVE_COUNTS[from_value]

    monkeypatch.setattr(mod, 'apply_rewrite', _record)

    assert mod.main() == 0
    expected, _skipped = mod.plan_changes(LIVE_COUNTS)
    assert applied == [(f, t) for f, t, _c in expected]
    assert 'APPLY (writing)' in capsys.readouterr().out


def test_apply_reports_a_failed_rewrite_and_keeps_going(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(sys, 'argv', ['backfill_lead_categories.py', '--apply'])
    monkeypatch.setattr(mod, 'fetch_category_counts', lambda: Counter({'plumbers': 5, 'clinics': 7}))
    seen: list[str] = []

    def _flaky(from_value: str, _to_value: str) -> int:
        seen.append(from_value)
        if from_value == 'clinics':
            raise RuntimeError('boom')
        return 5

    monkeypatch.setattr(mod, 'apply_rewrite', _flaky)

    assert mod.main() == 0
    assert set(seen) == {'plumbers', 'clinics'}
    assert 'FAILED clinics -> clinic' in capsys.readouterr().out


def test_no_op_inventory_reports_nothing_to_change(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(sys, 'argv', ['backfill_lead_categories.py'])
    monkeypatch.setattr(mod, 'fetch_category_counts', lambda: Counter({'casino': 10, 'plumber': 2}))
    assert mod.main() == 0
    assert 'Nothing to change' in capsys.readouterr().out
