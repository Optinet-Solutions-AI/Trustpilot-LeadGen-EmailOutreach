"""Unit tests for FB location-confidence helpers (pure functions).

Run from repo root:
    ./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_location_confidence.py -v
"""
from tools.scraper.platforms.facebook import _extract_country_from_excerpt


def test_province_token_disambiguates_shared_city_name():
    # Bare 'london' maps to GB, but an explicit Canadian province must win.
    assert _extract_country_from_excerpt("HANDYMAN SERVICES LONDON, Ontario") == "CA"
    assert _extract_country_from_excerpt("Calgary, Alberta trades") == "CA"


def test_plain_city_still_resolves_without_a_province():
    assert _extract_country_from_excerpt("London Handyman Services") == "GB"
    assert _extract_country_from_excerpt("ATLANTA HANDYMAN SERVICES") == "US"
    assert _extract_country_from_excerpt("Handyman Services Dublin") == "IE"


def test_no_known_place_returns_none():
    assert _extract_country_from_excerpt("Doncaster and local areas Handy man Services") is None
    assert _extract_country_from_excerpt("") is None
