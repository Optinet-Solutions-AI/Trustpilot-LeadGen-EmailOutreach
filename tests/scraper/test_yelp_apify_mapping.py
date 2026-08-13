import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.scraper.platforms.yelp_apify import (
    map_business,
    parse_claimed,
    parse_review_count,
)

FIXTURES = os.path.join(os.path.dirname(__file__), 'fixtures')


def _load(name):
    with open(os.path.join(FIXTURES, name), encoding='utf-8') as f:
        return json.load(f)


def test_parses_review_count_from_actor_string():
    # memo23 returns "118 reviews", NOT 118. Without this the min_review_count
    # filter reads 0 and drops every lead.
    assert parse_review_count('118 reviews') == 118
    assert parse_review_count('1,097 reviews') == 1097
    assert parse_review_count('5.7k reviews') == 5700
    assert parse_review_count(7) == 7          # epctex returns a plain int
    assert parse_review_count(None) == 0
    assert parse_review_count('no reviews yet') == 0


def test_parses_claimed_status():
    # memo23 returns the words, not a boolean.
    assert parse_claimed('Claimed') is True
    assert parse_claimed('Unclaimed') is False
    assert parse_claimed(True) is True
    assert parse_claimed(False) is False
    assert parse_claimed(None) is None
    assert parse_claimed('') is None


def test_maps_memo23_fixture_to_fusion_shape():
    rows = [map_business(i) for i in _load('yelp_apify_memo23_sample.json')]
    rows = [r for r in rows if r]
    assert len(rows) == 10
    for r in rows:
        assert r['name']
        assert '/biz/' in r['url']
        assert isinstance(r['review_count'], int)
        assert r['rating'] is None or 0.0 <= r['rating'] <= 5.0
        assert set(['name', 'url', 'rating', 'review_count', 'phone',
                    'location', 'id', 'website_url', 'website_email',
                    'profile_claimed']) <= set(r.keys())


def test_memo23_carries_email_and_claimed():
    rows = [map_business(i) for i in _load('yelp_apify_memo23_sample.json')]
    rows = [r for r in rows if r]
    assert sum(1 for r in rows if r['website_email']) >= 4
    assert all(r['profile_claimed'] is not None for r in rows)


def test_maps_epctex_fixture_too():
    # The actor is env-swappable, so the mapper must handle both shapes:
    # epctex uses address{} + businessId and has no email/claimed fields.
    rows = [map_business(i) for i in _load('yelp_apify_epctex_sample.json')]
    rows = [r for r in rows if r]
    assert len(rows) == 10
    for r in rows:
        assert r['name'] and '/biz/' in r['url']
        assert r['website_email'] is None
        assert r['profile_claimed'] is None


def test_skips_unusable_items():
    assert map_business({}) is None
    assert map_business({'title': 'No URL'}) is None
    assert map_business({'url': 'https://www.yelp.com/biz/x'}) is None


def test_real_fixture_values_flow_through_mapping():
    # Regression: _parse_yelp_search_cards returns review_count as int, memo23 supplies
    # "118 reviews", so the mapping must call parse_review_count, not stub it.
    # A typo'd key (e.g., reviewCounts instead of reviewCount) would silently return 0
    # and break the min_review_count filter. This test pins the wiring end-to-end.
    rows = [map_business(i) for i in _load('yelp_apify_memo23_sample.json')]
    rows = [r for r in rows if r]

    # Find Mike The Plumber (first item, "118 reviews" in fixture)
    mike = next((r for r in rows if r['name'] == 'Mike The Plumber'), None)
    assert mike is not None, "Mike The Plumber fixture item must exist"
    assert mike['review_count'] == 118, f"Expected 118, got {mike['review_count']}"

    # Verify another load-bearing field: profile_claimed (from isClaimed: "Claimed")
    assert mike['profile_claimed'] is True, "parse_claimed must convert 'Claimed' to True"

    # Verify id mapping (yelp_biz_id field must not be silently null'd)
    assert mike['id'] == "7Ia8F7JoGLeaJE1z5qGXpw", "yelp_biz_id must flow through to id"

    # Find Green Tech Plumbing (last item)
    green_tech = next((r for r in rows if r['name'] == 'Green Tech Plumbing'), None)
    assert green_tech is not None, "Green Tech Plumbing fixture item must exist"
    # "397 reviews" in fixture
    assert green_tech['review_count'] == 397, f"Expected 397, got {green_tech['review_count']}"
    assert green_tech['profile_claimed'] is True
