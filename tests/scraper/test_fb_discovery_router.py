"""Router tests: FB_DISCOVERY picks the discovery source, and the Apify
branch feeds the SAME downstream filter chain the browser branch does."""
import asyncio

import pytest

from tools.scraper.platforms import facebook as fb


def test_discovery_source_defaults_to_apify(monkeypatch):
    monkeypatch.delenv('FB_DISCOVERY', raising=False)
    assert fb._discovery_source() == 'apify'


def test_discovery_source_honours_browser_override(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'browser')
    assert fb._discovery_source() == 'browser'


def test_discovery_source_is_case_insensitive(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'APIFY')
    assert fb._discovery_source() == 'apify'


def test_apify_branch_returns_mapped_stubs(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {
            'url': 'https://www.facebook.com/p/1',
            'message': 'looking for a plumber in Manchester',
            'user': {'name': 'Jane', 'profile_url': 'https://www.facebook.com/jane'},
        },
    ])
    stubs = fb._search_posts_via_apify('plumber Manchester', {}, 10, None)
    assert len(stubs) == 1
    assert stubs[0]['author_profile_url'] == 'https://www.facebook.com/jane'


def test_apify_branch_skips_unmappable_items(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {'url': 'https://fb/p/1', 'message': 'x', 'user': {}},          # no profile url
        {'url': 'https://fb/p/2', 'message': 'y', 'user': {'profile_url': 'https://fb/u'}},
    ])
    stubs = fb._search_posts_via_apify('q', {}, 10, None)
    assert len(stubs) == 1


def test_search_posts_uses_apify_and_still_runs_the_consumer_filters(monkeypatch):
    """The Apify branch must sit ABOVE the stamping + filter chain so Apify
    stubs get country/category stamping and the Gemini classifier."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {'url': 'https://fb/p/1', 'message': 'anyone know a plumber in Manchester?',
         'user': {'name': 'Jane', 'profile_url': 'https://fb/jane'}},
    ])
    # Neutralize the LLM + translation so the test is deterministic.
    monkeypatch.setattr(fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None)
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)

    scraper = fb.FacebookScraper()
    stubs = asyncio.run(scraper.search_posts(
        'plumber Manchester',
        {'niche': 'plumber', 'location': 'Manchester', 'groups_only': False},
        max_results=10,
    ))
    assert len(stubs) == 1
    assert stubs[0]['category'] == 'plumber', 'category stamping must still run'
    assert stubs[0].get('location_confidence'), 'confidence classifier must still run'


def test_browser_mode_never_calls_apify(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'browser')

    def boom(*a, **k):
        raise AssertionError('Apify must not be called in browser mode')

    monkeypatch.setattr(fb.apify, 'run_actor', boom)
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)
    monkeypatch.setattr(
        fb.FacebookScraper, '_sync_search_posts',
        lambda self, query, groups_only, max_results, on_progress: [],
    )
    scraper = fb.FacebookScraper()
    out = asyncio.run(scraper.search_posts('q', {'groups_only': False}, max_results=5))
    assert out == []
