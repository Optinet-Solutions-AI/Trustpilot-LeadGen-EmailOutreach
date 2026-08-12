"""Unit tests for the group-country-lookup pure helper. No browser, no DB."""
from tools.scraper.platforms.facebook import _group_country_from_location


def test_bare_iso_code():
    assert _group_country_from_location('GB') == 'GB'


def test_lowercase_iso_code():
    assert _group_country_from_location('gb') == 'GB'


def test_city_comma_iso_code():
    assert _group_country_from_location('Leicester, GB') == 'GB'


def test_bare_city_no_country():
    assert _group_country_from_location('Leicester') is None


def test_none_input():
    assert _group_country_from_location(None) is None


def test_empty_string():
    assert _group_country_from_location('') is None


def test_three_letter_token_rejected():
    assert _group_country_from_location('GBR') is None


def test_other_country_code():
    assert _group_country_from_location('Bristol, US') == 'US'
