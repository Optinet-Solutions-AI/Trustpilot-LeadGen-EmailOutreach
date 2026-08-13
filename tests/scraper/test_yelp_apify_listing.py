import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import tools.scraper.platforms.yelp as yelp
from tools.scraper.platforms.yelp import YelpScraper
from tools.scraper.shared.apify import ApifyCreditError

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
