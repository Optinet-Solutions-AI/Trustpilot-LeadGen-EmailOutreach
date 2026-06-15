"""Unit tests for FB location-confidence helpers (pure functions).

Run from repo root:
    ./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_location_confidence.py -v
"""
from tools.scraper.platforms.facebook import _extract_country_from_excerpt, _is_consumer_facing_group


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


def test_gate_drops_other_country_city_in_group_name():
    # City names (not country words) now resolve to a country and mismatch-drop.
    assert _is_consumer_facing_group("ATLANTA HANDYMAN SERVICES", "Bristol") is False
    assert _is_consumer_facing_group("Washington Handyman Services", "Bristol") is False
    assert _is_consumer_facing_group("Handyman Services Dublin", "Bristol") is False
    assert _is_consumer_facing_group("HANDYMAN SERVICES LONDON, Ontario", "Bristol") is False


def test_gate_keeps_same_country_and_generic_groups():
    # Same-country city or no geo at all -> keep (Tiered policy: don't lose leads).
    assert _is_consumer_facing_group("Find a Tradesman Bristol and surrounding", "Bristol") is True
    assert _is_consumer_facing_group("London Handyman Services", "Bristol") is True   # GB == GB
    assert _is_consumer_facing_group("T T handyman services", "Bristol") is True       # no geo


def test_gate_does_not_drop_when_operator_or_country_unknown():
    # Operator city not in the country map (Doncaster) -> Stage 1b is skipped,
    # so a foreign-city group is NOT dropped on an unresolvable search.
    assert _is_consumer_facing_group("Atlanta Handyman Services", "Doncaster") is True
    # No operator location at all -> all of Stage 1 is bypassed, keep.
    assert _is_consumer_facing_group("Atlanta Handyman Services", None) is True
