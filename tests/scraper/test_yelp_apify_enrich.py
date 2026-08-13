import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import tools.scraper.platforms.yelp as yelp
from tools.scraper.platforms.yelp import YelpScraper


def _stubs(n=3):
    return [{
        'name': f'Biz {i}',
        'profile_url': f'https://www.yelp.com/biz/biz-{i}',
        'rating': 3.0,
        'review_count': 10 + i,
        'phone': '(312) 555-0100',
        'website_url': f'https://biz{i}.example.com',
        'website_email': f'hi@biz{i}.example.com',
        'profile_claimed': False,
        'platform': 'yelp',
    } for i in range(n)]


def _run(stubs, **kw):
    return asyncio.run(YelpScraper().enrich_profiles(stubs, **kw))


def test_apify_path_never_fetches_profile_html(monkeypatch):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: False)

    def explode(*a, **k):
        raise AssertionError('the HTML fetch is 75 credits and is redundant here')

    monkeypatch.setattr(yelp, 'fetch_via_scrapingbee', explode)
    rows = _run(_stubs())
    assert len(rows) == 3


def test_apify_path_keeps_the_actor_supplied_fields(monkeypatch):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: False)
    rows = _run(_stubs(1))
    assert rows[0]['website_url'] == 'https://biz0.example.com'
    assert rows[0]['website_email'] == 'hi@biz0.example.com'
    assert rows[0]['profile_claimed'] is False


def test_screenshots_are_uncapped_by_default_on_the_apify_path(monkeypatch):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.delenv('YELP_MAX_ENRICH', raising=False)
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'fetch_screenshot_via_scrapingbee', lambda *a, **k: b'PNG')
    monkeypatch.setattr(yelp, 'upload_screenshot_bytes', lambda *a, **k: 'https://cdn/x.png')
    rows = _run(_stubs(30))
    # The old default of 25 would have dropped 5 leads entirely.
    assert len(rows) == 30
    assert all(r.get('screenshot_path') for r in rows)


def test_explicit_cap_limits_screenshots_but_never_data(monkeypatch):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setenv('YELP_MAX_ENRICH', '2')
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'fetch_screenshot_via_scrapingbee', lambda *a, **k: b'PNG')
    monkeypatch.setattr(yelp, 'upload_screenshot_bytes', lambda *a, **k: 'https://cdn/x.png')
    rows = _run(_stubs(5))
    # Every lead survives with its data; only screenshots are capped.
    assert len(rows) == 5
    assert sum(1 for r in rows if r.get('screenshot_path')) == 2
    assert all(r['website_email'] for r in rows)


def test_missing_scrapingbee_key_still_returns_full_data(monkeypatch, capsys):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: False)
    rows = _run(_stubs(2))
    assert len(rows) == 2
    assert all(r['website_email'] for r in rows)


def test_enrichment_progress_events_are_unchanged(monkeypatch, capsys):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: False)
    _run(_stubs(2))
    out = capsys.readouterr().out
    assert 'PROGRESS:profile_start:' in out
    assert 'PROGRESS:profile_progress:' in out
    assert 'PROGRESS:profile_saved:' in out
    assert 'PROGRESS:profile_done:' in out
