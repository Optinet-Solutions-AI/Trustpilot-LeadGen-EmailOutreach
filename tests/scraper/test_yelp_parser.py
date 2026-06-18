"""
Yelp plugin parser tests — fixture-only, no live network.

Coverage:
  • _unwrap_biz_redir — happy path, double-encoded url=, excluded domains
  • _extract_profile_detail — website_url, phone, profile_claimed, JSON-LD name
  • _strip_query — UTM param + fragment removal

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
    _extract_profile_detail,
    _strip_query,
    _unwrap_biz_redir,
)


FIXTURE_DIR = os.path.join(os.path.dirname(__file__), 'fixtures')


@pytest.fixture
def profile_html() -> str:
    with open(os.path.join(FIXTURE_DIR, 'yelp_profile_sample.html'), encoding='utf-8') as f:
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


# ── _strip_query ─────────────────────────────────────────────────────────

def test_strip_query_removes_utm_params():
    raw = 'https://www.yelp.com/biz/acme-plumbing-austin?adjust_creative=abc'
    assert _strip_query(raw) == 'https://www.yelp.com/biz/acme-plumbing-austin'


def test_strip_query_removes_fragment():
    raw = 'https://www.yelp.com/biz/acme#reviews'
    assert _strip_query(raw) == 'https://www.yelp.com/biz/acme'

