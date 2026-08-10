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


def test_country_match_trailing_iso_token():
    assert fb._candidate_matches_country('Bristol, GB', 'GB') is True
    assert fb._candidate_matches_country('GB', 'GB') is True
    assert fb._candidate_matches_country('Bristol, GB', 'US') is False


def test_country_match_is_not_loose_substring():
    # 'GBworld' or a city containing the letters must NOT match.
    assert fb._candidate_matches_country('Gbagada, NG', 'GB') is False
    assert fb._candidate_matches_country(None, 'GB') is False


def test_rank_filters_out_non_eligible_rows():
    rows = [
        {'group_id': '1', 'status': 'candidate', 'audience': 'customers', 'relevance_tier': 2, 'location': 'Leeds, GB', 'member_count_text': '12K members'},
        {'group_id': '2', 'status': 'candidate', 'audience': 'trades',    'relevance_tier': 2, 'location': 'Leeds, GB', 'member_count_text': '9K'},
        {'group_id': '3', 'status': 'joined',    'audience': 'customers', 'relevance_tier': 2, 'location': 'Leeds, GB', 'member_count_text': '9K'},
        {'group_id': '4', 'status': 'candidate', 'audience': 'customers', 'relevance_tier': 0, 'location': 'Leeds, GB', 'member_count_text': '9K'},
        {'group_id': '5', 'status': 'candidate', 'audience': 'customers', 'relevance_tier': 2, 'location': 'Paris, FR', 'member_count_text': '9K'},
    ]
    out = fb._rank_join_candidates(rows, 'GB', 10)
    assert [r['group_id'] for r in out] == ['1']


def test_rank_orders_by_tier_then_member_count_and_caps():
    rows = [
        {'group_id': 'a', 'status': 'candidate', 'audience': 'customers', 'relevance_tier': 1, 'location': 'GB', 'member_count_text': '50K members'},
        {'group_id': 'b', 'status': 'candidate', 'audience': 'customers', 'relevance_tier': 2, 'location': 'GB', 'member_count_text': '1.2K members'},
        {'group_id': 'c', 'status': 'candidate', 'audience': 'customers', 'relevance_tier': 2, 'location': 'GB', 'member_count_text': '8K members'},
    ]
    out = fb._rank_join_candidates(rows, 'GB', 2)
    # tier 2 before tier 1; within tier 2, 8K before 1.2K; capped to 2
    assert [r['group_id'] for r in out] == ['c', 'b']
