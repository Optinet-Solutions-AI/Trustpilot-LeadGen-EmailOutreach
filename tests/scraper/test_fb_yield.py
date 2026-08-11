"""Unit tests for FB per-group yield tracking pure helpers. No browser, no DB."""
from tools.scraper.platforms import facebook as fb


def test_is_yield_farm_true_when_scraped_twice_never_a_lead():
    assert fb._is_yield_farm({'scrape_count': 2, 'total_leads': 0}) is True


def test_is_yield_farm_false_below_min_scrapes():
    assert fb._is_yield_farm({'scrape_count': 1, 'total_leads': 0}) is False


def test_is_yield_farm_false_when_it_has_produced_leads():
    assert fb._is_yield_farm({'scrape_count': 3, 'total_leads': 5}) is False


def test_is_yield_farm_false_on_empty_row():
    assert fb._is_yield_farm({}) is False


def test_yield_score_leads_per_scrape():
    assert fb._yield_score({'scrape_count': 2, 'total_leads': 8}) == 4.0


def test_yield_score_zero_when_never_scraped():
    assert fb._yield_score({'scrape_count': 0, 'total_leads': 0}) == 0.0


def test_yield_score_zero_when_scraped_but_no_leads():
    assert fb._yield_score({'scrape_count': 3, 'total_leads': 0}) == 0.0


def test_rank_join_candidates_excludes_farms():
    rows = [
        {
            'group_id': 'farm', 'status': 'candidate', 'audience': 'customers',
            'relevance_tier': 2, 'location': 'GB', 'member_count_text': '50K',
            'scrape_count': 2, 'total_leads': 0,
        },
        {
            'group_id': 'gem', 'status': 'candidate', 'audience': 'customers',
            'relevance_tier': 2, 'location': 'GB', 'member_count_text': '50K',
            'scrape_count': 2, 'total_leads': 8,
        },
    ]
    out = fb._rank_join_candidates(rows, 'GB', 10)
    assert [r['group_id'] for r in out] == ['gem']
