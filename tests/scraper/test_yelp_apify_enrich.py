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


def test_data_is_never_capped_on_the_apify_path(monkeypatch):
    """The legacy path's cap TRUNCATES the lead list, discarding website and
    phone past the 25th. On this path the cap must only govern screenshots —
    every lead keeps its data.

    (This test previously asserted screenshots were unlimited too. A live
    job disproved that: see test_screenshots_are_bounded_by_default_not_unlimited.)
    """
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.delenv('YELP_MAX_ENRICH', raising=False)
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'fetch_screenshot_via_scrapingbee', lambda *a, **k: b'PNG')
    monkeypatch.setattr(yelp, 'upload_screenshot_bytes', lambda *a, **k: 'https://cdn/x.png')
    rows = _run(_stubs(30))
    assert len(rows) == 30, 'no lead may be dropped — the legacy cap would have lost 5'
    assert all(r['website_email'] for r in rows), 'every lead keeps its contact data'


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


def test_profile_saved_site_flag_reflects_the_stub_on_the_apify_path(monkeypatch, capsys):
    # Regression: `detail` is always {} on the apify path, so a site_flag
    # read from `detail` would report "nosite" for every apify lead even
    # when the stub (and therefore the merged result) carries a real
    # website_url. The flag must be derived from the merged `enriched`
    # dict instead.
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: False)
    stubs = _stubs(2)
    stubs[1]['website_url'] = None
    stubs[1]['website_email'] = None
    _run(stubs)
    out = capsys.readouterr().out
    saved_lines = [
        line for line in out.splitlines()
        if line.startswith('PROGRESS:profile_saved:')
    ]
    assert len(saved_lines) == 2
    with_site = next(line for line in saved_lines if 'biz-0' in line)
    without_site = next(line for line in saved_lines if 'biz-1' in line)
    assert with_site.split('|')[-1] == 'site'
    assert without_site.split('|')[-1] == 'nosite'


def test_legacy_cap_truncates_stubs_to_default_25(monkeypatch, capsys):
    # The legacy (fusion/browser/relay) cap path still truncates the input
    # list itself, unlike the apify path where the cap only governs
    # screenshots. Pin this so the shared cap-block refactor can't silently
    # regress it.
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'browser')
    monkeypatch.delenv('YELP_MAX_ENRICH', raising=False)
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: False)
    monkeypatch.setattr(yelp, 'fetch_via_scrapingbee', lambda *a, **k: '<html></html>')
    rows = _run(_stubs(30))
    assert len(rows) == 25
    out = capsys.readouterr().out
    assert 'PROGRESS:enrich_capped:25|30|' in out
    assert 'skipping' in out and 'long-tail leads' in out
    # Must describe dropping leads, not the apify screenshot-capping wording.
    assert 'screenshotting' not in out
    assert 'keep full data' not in out


def test_browser_stubs_still_get_their_profile_fetch_on_an_apify_box(monkeypatch):
    """The box says apify, but these leads came from the browser source, so
    they carry no website/phone yet and MUST still be fetched. Reading the env
    instead of the stub's provenance would silently return contactless leads."""
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: False)
    fetched = []
    monkeypatch.setattr(yelp, 'fetch_via_scrapingbee',
                        lambda url, **k: fetched.append(url) or '<html></html>')
    stubs = [{**s, 'listing_source': 'browser', 'website_url': None,
              'website_email': None, 'profile_claimed': None} for s in _stubs(2)]
    _run(stubs)
    assert len(fetched) == 2, 'browser-sourced stubs must still be fetched'


def test_apify_stubs_skip_the_fetch_even_if_the_env_says_browser(monkeypatch):
    """Mirror case: provenance says apify, so the 75-credit fetch is redundant
    no matter how this box is configured."""
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'browser')
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: False)

    def explode(*a, **k):
        raise AssertionError('apify-sourced stubs already carry this data')

    monkeypatch.setattr(yelp, 'fetch_via_scrapingbee', explode)
    stubs = [{**s, 'listing_source': 'apify'} for s in _stubs(2)]
    rows = _run(stubs)
    assert len(rows) == 2
    assert all(r['website_email'] for r in rows)


def test_mixed_provenance_takes_the_safe_legacy_path(monkeypatch):
    """Spending credits we didn't strictly need is recoverable; silently
    dropping contact data is not."""
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: False)
    fetched = []
    monkeypatch.setattr(yelp, 'fetch_via_scrapingbee',
                        lambda url, **k: fetched.append(url) or '<html></html>')
    a, b = _stubs(2)
    _run([{**a, 'listing_source': 'apify'}, {**b, 'listing_source': 'browser'}])
    assert len(fetched) == 2


def test_screenshots_are_bounded_by_default_not_unlimited(monkeypatch):
    """Regression for a live incident: a job asking for 5 leads received 195
    from the listing, and an unbounded screenshot pass queued 195 ScrapingBee
    calls at 75 credits each (~14,600 credits). How many leads a listing
    returns is not something this stage controls, so it must not be what
    bounds the spend."""
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.delenv('YELP_MAX_ENRICH', raising=False)
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: True)
    shots = []
    monkeypatch.setattr(yelp, 'fetch_screenshot_via_scrapingbee',
                        lambda url, **k: shots.append(url) or b'PNG')
    monkeypatch.setattr(yelp, 'upload_screenshot_bytes', lambda *a, **k: 'https://cdn/x.png')

    rows = _run(_stubs(195))

    assert len(rows) == 195, 'every lead must still be returned with its data'
    assert len(shots) == 25, f'screenshots must be bounded by default, got {len(shots)}'


def test_explicit_cap_still_raises_the_screenshot_ceiling(monkeypatch):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    monkeypatch.setenv('YELP_MAX_ENRICH', '40')
    monkeypatch.setattr(yelp, 'scrapingbee_enabled', lambda: True)
    monkeypatch.setattr(yelp, 'supabase_storage_enabled', lambda: True)
    shots = []
    monkeypatch.setattr(yelp, 'fetch_screenshot_via_scrapingbee',
                        lambda url, **k: shots.append(url) or b'PNG')
    monkeypatch.setattr(yelp, 'upload_screenshot_bytes', lambda *a, **k: 'https://cdn/x.png')

    _run(_stubs(60))
    assert len(shots) == 40
