import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import tools.scraper.platforms.yelp as yelp
from tools.scraper.platforms.yelp import YelpScraper
from tools.scraper.shared.apify import ApifyCreditError, ApifyError

FIXTURES = os.path.join(os.path.dirname(__file__), 'fixtures')
FILTERS = {'country': 'US', 'category': 'plumbers',
           'max_rating': 5.0, 'min_rating': 1.0, 'min_review_count': 1}


def _mapped():
    from tools.scraper.platforms.yelp_apify import map_business
    with open(os.path.join(FIXTURES, 'yelp_apify_memo23_sample.json'), encoding='utf-8') as f:
        return [m for m in (map_business(i) for i in json.load(f)) if m]


def _run(scraper, filters=None, **kw):
    return asyncio.run(scraper.scrape_listing(filters or FILTERS, **kw))


def test_apify_source_produces_stubs_with_email_and_claimed(monkeypatch, capsys):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setattr(yelp, 'search_city_apify', lambda *a, **k: _mapped())
    rows = _run(YelpScraper(), max_results=10)
    assert rows, 'apify source returned no stubs'
    assert any(r.get('website_email') for r in rows)
    assert any(r.get('profile_claimed') is not None for r in rows)
    assert all(r['platform'] == 'yelp' for r in rows)


def test_apify_source_emits_the_frozen_progress_events(monkeypatch, capsys):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setattr(yelp, 'search_city_apify', lambda *a, **k: _mapped())
    _run(YelpScraper(), max_results=10)
    out = capsys.readouterr().out
    assert 'PROGRESS:category_progress:' in out
    assert 'PROGRESS:category_page_done:' in out
    assert 'PROGRESS:category_done:' in out


def test_unverified_market_fails_fast_instead_of_falling_back(monkeypatch, capsys):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setenv('YELP_APIFY_MARKETS', 'US')

    def explode(*a, **k):
        raise AssertionError('must not call the actor for an unverified market')

    monkeypatch.setattr(yelp, 'search_city_apify', explode)
    rows = _run(YelpScraper(), {**FILTERS, 'country': 'DE'})
    assert rows == []
    assert 'FAILED:listing|yelp|apify_market_unverified|DE' in capsys.readouterr().out


def test_out_of_credit_is_not_reported_as_an_empty_market(monkeypatch, capsys):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')

    def broke(*a, **k):
        raise ApifyCreditError('402 out of credit')

    monkeypatch.setattr(yelp, 'search_city_apify', broke)
    rows = _run(YelpScraper())
    assert rows == []
    assert 'FAILED:listing|yelp|apify_credit' in capsys.readouterr().out


def test_generic_apify_error_reports_distinctly_and_keeps_partial_results(monkeypatch, capsys):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    calls = {'n': 0}

    def flaky(*a, **k):
        calls['n'] += 1
        if calls['n'] == 1:
            return _mapped()
        raise ApifyError('actor run failed: HTTP 500')

    monkeypatch.setattr(yelp, 'search_city_apify', flaky)
    rows = _run(YelpScraper())
    out = capsys.readouterr().out
    assert rows, 'leads collected from the first city before the failure must survive'
    assert 'FAILED:listing|yelp|apify_error' in out
    assert 'apify_credit' not in out


def test_empty_actor_result_is_distinct_from_filtered_out(monkeypatch, capsys):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setattr(yelp, 'search_city_apify', lambda *a, **k: [])
    _run(YelpScraper())
    assert 'FAILED:listing|yelp|apify_empty' in capsys.readouterr().out


def test_all_filtered_out_reports_filter_too_strict_not_empty(monkeypatch, capsys):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setattr(yelp, 'search_city_apify', lambda *a, **k: _mapped())
    # The fixture is all 4.5+, so a 1.0-2.0 band keeps nothing.
    rows = _run(YelpScraper(), {**FILTERS, 'max_rating': 2.0})
    out = capsys.readouterr().out
    assert rows == []
    assert 'FAILED:listing|yelp|filter_too_strict' in out
    assert 'apify_empty' not in out


def test_per_city_ask_is_bounded_by_what_the_job_still_needs(monkeypatch):
    """per_city_cap defaults to 240 and is independent of max_results, so a
    10-lead job used to ask the actor for a full city's worth. Every returned
    row is billed, and an oversized ask is what blew through the sync
    endpoint's 300s ceiling in the first place."""
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    asks = []

    def fake(city, category, cap, item_budget=None):
        asks.append(cap)
        return _mapped()[:3]

    monkeypatch.setattr(yelp, 'search_city_apify', fake)
    _run(YelpScraper(), max_results=5)
    assert asks, 'the actor was never called'
    assert asks[0] == 5, f'first city should ask for at most the job total, got {asks[0]}'
    assert all(a <= 5 for a in asks), f'no city may out-ask the job total: {asks}'


def test_job_stops_and_reports_when_the_apify_budget_runs_out(monkeypatch, capsys):
    """A wide country fans out over every seeded city, each billed separately.
    Nothing bounded that before the job budget, and once the token is on Cloud
    Run any operator can start such a job."""
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    # 60 items buys one city at the 6x default, so the second city is refused.
    monkeypatch.setenv('YELP_APIFY_MAX_ITEMS_PER_JOB', '60')
    calls = []

    def fake(city, category, cap, item_budget=None):
        calls.append(city)
        return _mapped()[:1]

    monkeypatch.setattr(yelp, 'search_city_apify', fake)
    rows = _run(YelpScraper(), max_results=50)
    out = capsys.readouterr().out
    assert len(calls) == 1, f'budget should have stopped the fan-out after one city, got {calls}'
    assert 'FAILED:listing|yelp|apify_budget_exhausted' in out
    # Leads already gathered are kept, not discarded.
    assert len(rows) == 1
