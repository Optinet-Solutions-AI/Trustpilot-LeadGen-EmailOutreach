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


def test_record_group_yield_skips_db_on_outage(monkeypatch):
    """trustworthy=False (consumer filter failed closed) must not touch the DB
    at all — an outage's empty batch never counts as a zero-yield scrape."""
    calls = []

    def _fake_table(*a, **k):
        calls.append(a)
        raise AssertionError('DB must not be touched on a classifier outage')

    monkeypatch.setattr(fb, 'table', _fake_table)
    fb._record_group_yield(['g1'], [{'group_id': 'g1'}], trustworthy=False)
    assert calls == []


def test_record_group_yield_touches_db_when_trustworthy(monkeypatch):
    """The default trustworthy path still reaches the DB (then no-ops on an
    empty existing row), proving the guard only gates the outage case."""
    from types import SimpleNamespace
    calls = []

    class _Chain:
        def select(self, *a, **k): return self
        def eq(self, *a, **k): return self
        def update(self, *a, **k): return self
        def execute(self): return SimpleNamespace(data=[])

    def _fake_table(*a, **k):
        calls.append(a)
        return _Chain()

    monkeypatch.setattr(fb, 'table', _fake_table)
    fb._record_group_yield(['g1'], [{'group_id': 'g1'}], trustworthy=True)
    assert calls  # trustworthy → DB read attempted


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
