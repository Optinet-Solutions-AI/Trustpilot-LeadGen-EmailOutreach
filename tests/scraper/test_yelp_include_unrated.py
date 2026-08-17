"""Tests for the `include_unrated` listing filter.

WHY IT EXISTS

  Measured live 2026-08-14: all 133 roofing businesses in Austria came back
  with NO rating at all. Yelp outside the US is largely a bare directory —
  listings exist, nobody reviews them. The listing loop drops any business
  without a rating, so those 133 were unreachable at ANY filter setting: the
  market "worked" and still returned nothing.

  An unrated, unclaimed business is a perfectly good cold-outreach target —
  arguably a better one than a low-rated business, since nobody is managing
  the listing at all. This flag makes them reachable.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import tools.scraper.platforms.yelp as yelp
from tools.scraper.platforms.yelp import YelpScraper

BASE = {'country': 'US', 'category': 'plumbers',
        'max_rating': 3.5, 'min_rating': 1.0, 'min_review_count': 5}


def _biz(name, rating, reviews):
    """One listing row in the shape scrape_listing consumes."""
    return {
        'name': name,
        'url': f'https://www.yelp.com/biz/{name.lower().replace(" ", "-")}',
        'rating': rating,
        'review_count': reviews,
        'phone': None,
        'location': {'display_address': []},
        'id': None,
    }


def _run(rows, **overrides):
    """Run one listing pass against a fixed set of rows from a single city."""
    filters = {**BASE, **overrides}
    return asyncio.run(YelpScraper().scrape_listing(filters, max_results=50))


def _patch(monkeypatch, rows):
    monkeypatch.setenv('YELP_LISTING_SOURCE', 'apify')
    seen = {'done': False}

    def one_city(city, category, cap, item_budget=None):
        # Only the first city yields rows; the rest are empty so the dedup
        # and per-city accounting stay realistic without repeating the batch.
        if seen['done']:
            return []
        seen['done'] = True
        return rows

    monkeypatch.setattr(yelp, 'search_city_apify', one_city)


def test_unrated_businesses_are_dropped_by_default(monkeypatch):
    """Today's behaviour, preserved: a US run should not silently gain
    ratingless rows just because this feature exists."""
    _patch(monkeypatch, [_biz('Rated Low', 2.5, 10), _biz('No Rating', None, 0)])
    rows = _run(None)
    assert [r['name'] for r in rows] == ['Rated Low']


def test_include_unrated_keeps_them(monkeypatch):
    _patch(monkeypatch, [_biz('Rated Low', 2.5, 10), _biz('No Rating', None, 0)])
    rows = _run(None, include_unrated=True)
    assert sorted(r['name'] for r in rows) == ['No Rating', 'Rated Low']


def test_unrated_rows_bypass_the_review_count_floor(monkeypatch):
    """The trap this feature would otherwise ship with: an unrated business
    has 0 reviews, so the default min_review_count of 5 would drop every one
    and the flag would appear to do nothing at all."""
    _patch(monkeypatch, [_biz('No Rating', None, 0)])
    rows = _run(None, include_unrated=True, min_review_count=5)
    assert [r['name'] for r in rows] == ['No Rating']
    assert rows[0]['rating'] is None, 'no rating must be invented'


def test_rated_rows_still_obey_the_review_floor_and_band(monkeypatch):
    """The flag must not loosen anything for businesses that DO have a
    rating — otherwise it quietly widens every filter it touches."""
    _patch(monkeypatch, [
        _biz('Too Few Reviews', 2.0, 1),    # in band, under the review floor
        _biz('Too Highly Rated', 4.8, 50),  # plenty of reviews, out of band
        _biz('Keeper', 2.0, 50),
    ])
    rows = _run(None, include_unrated=True, min_review_count=5)
    assert [r['name'] for r in rows] == ['Keeper']


def test_all_unrated_says_so_instead_of_blaming_the_filter(monkeypatch, capsys):
    """The Austria case. If every row was dropped for having no rating, the
    operator must be told that — and told the option exists — rather than
    being sent to widen a rating band that was never the problem."""
    _patch(monkeypatch, [_biz('A', None, 0), _biz('B', None, 0)])
    rows = _run(None)
    out = capsys.readouterr().out
    assert rows == []
    assert 'unrated' in out.lower()
    assert 'include_unrated' in out
    assert 'FAILED:listing|yelp|all_unrated' in out


def test_schema_advertises_the_flag():
    names = {f['name'] for f in YelpScraper().filter_schema}
    assert 'include_unrated' in names
    field = next(f for f in YelpScraper().filter_schema if f['name'] == 'include_unrated')
    assert field['type'] == 'boolean'
    assert field['default'] is False
