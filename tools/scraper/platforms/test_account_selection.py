"""Unit tests for FB account country resolution + country-filtered claim.

Run from repo root:
    ./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_account_selection.py -v
"""
from tools.scraper.platforms.facebook import _target_country_from_filters


def test_explicit_country_iso_wins():
    assert _target_country_from_filters({'country': 'us'}) == 'US'
    assert _target_country_from_filters({'country': 'DE', 'location': 'Paris'}) == 'DE'


def test_location_city_maps_to_country():
    # Frankfurt is in CITY_TO_COUNTRY → DE
    assert _target_country_from_filters({'location': 'Frankfurt'}) == 'DE'


def test_unresolvable_returns_none():
    assert _target_country_from_filters({}) is None
    assert _target_country_from_filters({'location': 'Atlantis'}) is None
