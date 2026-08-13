import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import tools.scraper.platforms.yelp_apify as ya

FIXTURES = os.path.join(os.path.dirname(__file__), 'fixtures')


def _fixture():
    with open(os.path.join(FIXTURES, 'yelp_apify_memo23_sample.json'), encoding='utf-8') as f:
        return json.load(f)


def test_over_fetches_because_yelp_cannot_sort_ascending(monkeypatch):
    # No Yelp sort returns low-rated first, so we pull extra and filter
    # client-side. Measured 2026-08-13 over 233 live businesses: only 16.3%
    # sit at or below the default max_rating of 3.5, so a 4x multiplier
    # returned ~65% of the leads asked for. The default is 6x.
    monkeypatch.delenv('YELP_APIFY_OVERFETCH', raising=False)
    monkeypatch.delenv('YELP_APIFY_MAX_ITEMS', raising=False)
    # 10 rather than 20 so this pins the MULTIPLIER, not the 100-item ceiling.
    assert ya.resolve_max_items(10) == 60


def test_over_fetch_is_bounded_so_spend_cannot_run_away(monkeypatch):
    monkeypatch.setenv('YELP_APIFY_OVERFETCH', '4')
    monkeypatch.setenv('YELP_APIFY_MAX_ITEMS', '200')
    assert ya.resolve_max_items(240) == 200


def test_actor_input_carries_search_terms_and_bounded_cache(monkeypatch):
    monkeypatch.delenv('YELP_APIFY_CACHE_DAYS', raising=False)
    monkeypatch.delenv('YELP_APIFY_ENRICH_EMAILS', raising=False)
    payload = ya.build_actor_input('Chicago, IL', 'plumbers', 80)
    assert payload['searchTerms'] == ['plumbers']
    assert payload['searchLocation'] == 'Chicago, IL'
    assert payload['maxItems'] == 80
    assert payload['enrichEmails'] is True
    assert payload['scrapeReviews'] is False
    # Cache defaults to unbounded age on this actor — pin it or rows can be
    # arbitrarily stale.
    assert payload['maxCacheAgeDays'] == 30


def test_market_gate_allows_us_and_blocks_unverified(monkeypatch):
    monkeypatch.delenv('YELP_APIFY_MARKETS', raising=False)
    assert ya.market_allowed('US') is True
    assert ya.market_allowed('us') is True
    assert ya.market_allowed('DE') is False
    monkeypatch.setenv('YELP_APIFY_MARKETS', 'US,CA')
    assert ya.market_allowed('CA') is True


def test_search_city_maps_actor_output(monkeypatch):
    calls = {}

    def fake_run_actor(actor_id, run_input, **kwargs):
        calls['actor_id'] = actor_id
        calls['run_input'] = run_input
        return _fixture()

    monkeypatch.setattr(ya, 'run_actor', fake_run_actor)
    monkeypatch.delenv('APIFY_YELP_ACTOR', raising=False)
    rows = ya.search_city_apify('Chicago, IL', 'plumbers', 20)
    assert calls['actor_id'] == 'memo23/yelp-scraper'
    # 20 x the 6x over-fetch is 120, clipped by the 100-item ceiling.
    assert calls['run_input']['maxItems'] == 100
    assert len(rows) == 10
    assert all('/biz/' in r['url'] for r in rows)


def test_actor_is_env_swappable(monkeypatch):
    calls = {}

    def fake_run_actor(actor_id, run_input, **kwargs):
        calls['actor_id'] = actor_id
        return []

    monkeypatch.setattr(ya, 'run_actor', fake_run_actor)
    monkeypatch.setenv('APIFY_YELP_ACTOR', 'epctex/yelp-business-api')
    ya.search_city_apify('Chicago, IL', 'plumbers', 20)
    assert calls['actor_id'] == 'epctex/yelp-business-api'


def test_junk_rows_do_not_kill_the_city(monkeypatch):
    monkeypatch.setattr(ya, 'run_actor',
                        lambda *a, **k: [{'garbage': 1}] + _fixture())
    rows = ya.search_city_apify('Chicago, IL', 'plumbers', 20)
    assert len(rows) == 10


def test_default_ceiling_is_sized_for_the_300s_sync_window(monkeypatch):
    """run-sync-get-dataset-items dies at a hard 300s. Measured 2026-08-13:
    the actor managed 169 items in 324s (~2s/item), so the old 200-item
    ceiling could never land inside the window — it 408'd every time, and
    the abandoned run still billed."""
    monkeypatch.delenv('YELP_APIFY_OVERFETCH', raising=False)
    monkeypatch.delenv('YELP_APIFY_MAX_ITEMS', raising=False)
    assert ya.resolve_max_items(240) == 100


def test_cache_is_off_by_default_because_it_returns_thinner_rows(monkeypatch):
    """Billing is per returned item, not per fetch, so the actor's cache
    saves time but never money — while measurably costing data. Measured
    2026-08-13 on the same query/market: cached rows had website populated
    on 1/10 (empty strings elsewhere), uncached on 3/10. Paying full price
    for thinner rows is a pure loss, so the default is off."""
    monkeypatch.delenv('YELP_APIFY_USE_CACHE', raising=False)
    assert ya.build_actor_input('New York, NY', 'plumbers', 40)['useCachedData'] is False
    monkeypatch.setenv('YELP_APIFY_USE_CACHE', 'true')
    assert ya.build_actor_input('New York, NY', 'plumbers', 40)['useCachedData'] is True
