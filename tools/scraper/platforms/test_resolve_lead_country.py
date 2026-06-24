from tools.scraper.platforms.facebook import _resolve_lead_country


def test_province_in_group_name_disambiguates_to_canada():
    assert _resolve_lead_country("HANDYMAN SERVICES LONDON, Ontario", "London", "Looking for a handyman") == "CA"


def test_bare_london_resolves_uk():
    assert _resolve_lead_country("Plumbers in London UK", "London", "need a plumber") == "GB"


def test_unknown_city_falls_back_to_raw_location():
    # 'Nairobi' is not in the city map -> preserve the operator's raw location
    # (Brooklyn IS in the map as US, so we use a genuinely unmapped place)
    assert _resolve_lead_country("Some Random Group", "Nairobi", "need help") == "Nairobi"


def test_nothing_resolvable_returns_none():
    assert _resolve_lead_country(None, "", "") is None
    assert _resolve_lead_country("", None, "") is None
