"""
Yelp plugin parser tests — fixture-only, no live network.

Coverage:
  • _unwrap_biz_redir — happy path, double-encoded url=, excluded domains
  • _extract_profile_detail — website_url, phone, profile_claimed, JSON-LD name
  • _extract_search_cards — listing card extraction, dedup, sponsored
  • _build_search_url — URL composition + encoding
  • In-process rating + review_count filter logic

Run with: pytest tests/scraper/test_yelp_parser.py -v
"""
from __future__ import annotations

import os
import sys

import pytest

# Make the project root importable so `tools.scraper.platforms.yelp` resolves.
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from tools.scraper.platforms.yelp import (  # noqa: E402
    _build_search_url,
    _extract_profile_detail,
    _extract_search_cards,
    _strip_query,
    _unwrap_biz_redir,
)


FIXTURE_DIR = os.path.join(os.path.dirname(__file__), 'fixtures')


@pytest.fixture
def profile_html() -> str:
    with open(os.path.join(FIXTURE_DIR, 'yelp_profile_sample.html'), encoding='utf-8') as f:
        return f.read()


@pytest.fixture
def search_html() -> str:
    with open(os.path.join(FIXTURE_DIR, 'yelp_search_sample.html'), encoding='utf-8') as f:
        return f.read()


# ── _unwrap_biz_redir ────────────────────────────────────────────────────

def test_unwrap_biz_redir_happy_path():
    href = (
        'https://www.yelp.com/biz_redir?url=https%3A%2F%2Facmeplumbing.example.com%2F'
        '&cachebuster=1700000000&referrer=biz_details'
    )
    assert _unwrap_biz_redir(href) == 'https://acmeplumbing.example.com'


def test_unwrap_biz_redir_strips_trailing_slash():
    href = 'https://www.yelp.com/biz_redir?url=https%3A%2F%2Ffoo.example.com%2F'
    assert _unwrap_biz_redir(href) == 'https://foo.example.com'


def test_unwrap_biz_redir_filters_yelp_self_redirect():
    href = 'https://www.yelp.com/biz_redir?url=https%3A%2F%2Fwww.yelp.com%2Fmap%2Fxyz'
    assert _unwrap_biz_redir(href) is None


def test_unwrap_biz_redir_filters_social_domains():
    href = 'https://www.yelp.com/biz_redir?url=https%3A%2F%2Fwww.facebook.com%2Fpages%2Fxyz'
    assert _unwrap_biz_redir(href) is None


def test_unwrap_biz_redir_returns_input_when_not_biz_redir():
    assert _unwrap_biz_redir('https://other.example.com/foo') == 'https://other.example.com/foo'


def test_unwrap_biz_redir_returns_none_for_empty():
    assert _unwrap_biz_redir('') is None
    assert _unwrap_biz_redir('not-an-http-url') is None


# ── _extract_profile_detail ──────────────────────────────────────────────

def test_extract_profile_detail_unwraps_website(profile_html: str):
    detail = _extract_profile_detail(profile_html)
    assert detail['website_url'] == 'https://acmeplumbing.example.com'


def test_extract_profile_detail_grabs_phone(profile_html: str):
    detail = _extract_profile_detail(profile_html)
    assert detail['phone'] == '+15558675309'


def test_extract_profile_detail_detects_unclaimed(profile_html: str):
    detail = _extract_profile_detail(profile_html)
    assert detail['profile_claimed'] is False


def test_extract_profile_detail_falls_back_to_json_ld_name(profile_html: str):
    detail = _extract_profile_detail(profile_html)
    assert detail['company_name'] == 'Acme Plumbing'


def test_extract_profile_detail_skips_map_redirect(profile_html: str):
    detail = _extract_profile_detail(profile_html)
    assert detail['website_url'] != 'https://www.yelp.com/map/acme-plumbing'
    assert 'yelp.com' not in (detail['website_url'] or '')


# ── _extract_search_cards ────────────────────────────────────────────────

def test_extract_search_cards_finds_all_distinct_businesses(search_html: str):
    cards = _extract_search_cards(search_html)
    slugs = [c['profile_url'].rsplit('/', 1)[-1] for c in cards]
    # Expect 5 distinct businesses (Acme, TopNotch, Minor, Sponsored, NoRating).
    # Sponsored counts; NoRating counts here too (filter happens in scrape_listing).
    assert sorted(slugs) == sorted([
        'acme-plumbing-austin',
        'topnotch-plumbing-austin',
        'minor-plumbing-austin',
        'sponsored-plumbing-austin',
        'no-rating-plumber-austin',
    ])


def test_extract_search_cards_dedupes_repeated_anchors(search_html: str):
    """Each card has TWO anchors with the same /biz/<slug> href (name + review-count link). Only one stub per business."""
    cards = _extract_search_cards(search_html)
    urls = [c['profile_url'] for c in cards]
    assert len(urls) == len(set(urls))


def test_extract_search_cards_parses_rating(search_html: str):
    cards = _extract_search_cards(search_html)
    by_url = {c['profile_url'].rsplit('/', 1)[-1]: c for c in cards}
    assert by_url['acme-plumbing-austin']['rating'] == 2.5
    assert by_url['topnotch-plumbing-austin']['rating'] == 4.5
    assert by_url['minor-plumbing-austin']['rating'] == 1.5
    assert by_url['sponsored-plumbing-austin']['rating'] == 3.0
    # Card without a rating block returns None.
    assert by_url['no-rating-plumber-austin']['rating'] is None


def test_extract_search_cards_parses_review_count(search_html: str):
    cards = _extract_search_cards(search_html)
    by_url = {c['profile_url'].rsplit('/', 1)[-1]: c for c in cards}
    assert by_url['acme-plumbing-austin']['review_count'] == 47
    assert by_url['topnotch-plumbing-austin']['review_count'] == 200
    assert by_url['minor-plumbing-austin']['review_count'] == 2
    assert by_url['sponsored-plumbing-austin']['review_count'] == 15


def test_extract_search_cards_strips_url_query_params(search_html: str):
    """Sponsored listings have ?ad_business_id=... — must be stripped."""
    cards = _extract_search_cards(search_html)
    by_url = {c['profile_url'].rsplit('/', 1)[-1]: c for c in cards}
    assert by_url['sponsored-plumbing-austin']['profile_url'] == (
        'https://www.yelp.com/biz/sponsored-plumbing-austin'
    )


def test_extract_search_cards_returns_business_names(search_html: str):
    cards = _extract_search_cards(search_html)
    names = sorted(c['name'] for c in cards)
    assert 'Acme Plumbing' in names
    assert 'TopNotch Plumbing Co' in names
    assert 'Sponsored Plumbing Inc' in names


# ── _build_search_url ────────────────────────────────────────────────────

def test_build_search_url_encodes_city_and_category():
    url = _build_search_url('plumbers', 'Austin, TX', 0)
    assert 'find_desc=plumbers' in url
    # "Austin, TX" → URL-encoded
    assert 'find_loc=Austin%2C+TX' in url or 'find_loc=Austin%2C%20TX' in url
    assert 'start=0' in url


def test_build_search_url_pagination_offset():
    url = _build_search_url('plumbers', 'Chicago, IL', 30)
    assert 'start=30' in url


# ── _strip_query ─────────────────────────────────────────────────────────

def test_strip_query_removes_utm_params():
    raw = 'https://www.yelp.com/biz/acme-plumbing-austin?adjust_creative=abc'
    assert _strip_query(raw) == 'https://www.yelp.com/biz/acme-plumbing-austin'


def test_strip_query_removes_fragment():
    raw = 'https://www.yelp.com/biz/acme#reviews'
    assert _strip_query(raw) == 'https://www.yelp.com/biz/acme'


# ── In-process filter logic (mirrors scrape_listing) ─────────────────────

def test_rating_and_review_count_filter(search_html: str):
    """
    scrape_listing keeps a card iff:
      rating is not None AND min_rating <= rating <= max_rating
      AND review_count >= min_review_count
    """
    cards = _extract_search_cards(search_html)
    min_rating, max_rating, min_review_count = 1.0, 3.5, 5

    def keep(c):
        r = c.get('rating')
        rc = c.get('review_count') or 0
        return r is not None and min_rating <= r <= max_rating and rc >= min_review_count

    kept = [c for c in cards if keep(c)]
    slugs = [c['profile_url'].rsplit('/', 1)[-1] for c in kept]
    # Acme (2.5, 47) ✓ ; Sponsored (3.0, 15) ✓
    # TopNotch (4.5) fails rating cap.
    # Minor (1.5, 2) fails review count.
    # NoRating (None) fails rating presence.
    assert sorted(slugs) == sorted(['acme-plumbing-austin', 'sponsored-plumbing-austin'])
