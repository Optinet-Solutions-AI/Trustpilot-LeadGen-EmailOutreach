"""Unit tests for FB auto-join-groups pure helpers. No browser, no DB."""
from datetime import datetime, timezone, timedelta

from tools.scraper.platforms import facebook as fb


def _days_ago(n):
    return (datetime(2026, 8, 10, tzinfo=timezone.utc) - timedelta(days=n)).isoformat()


NOW = datetime(2026, 8, 10, tzinfo=timezone.utc)


def test_join_cap_null_warmup_is_full_cap():
    assert fb._effective_join_cap(3, None, NOW) == 3


def test_join_cap_week1_is_one():
    assert fb._effective_join_cap(3, _days_ago(2), NOW) == 1


def test_join_cap_week2_is_two():
    assert fb._effective_join_cap(3, _days_ago(9), NOW) == 2


def test_join_cap_week3_is_three():
    assert fb._effective_join_cap(3, _days_ago(16), NOW) == 3


def test_join_cap_never_exceeds_configured():
    assert fb._effective_join_cap(2, _days_ago(30), NOW) == 2
    assert fb._effective_join_cap(1, _days_ago(9), NOW) == 1
