from tools.scraper.platforms.facebook import _extract_country_from_excerpt, _resolve_lead_country


# ── FAULT 1: city names must match as whole words, not raw substrings ───────
#
# Verified live before the fix: plain `needle in lowered` substring matching
# fabricated a country out of an ordinary sentence whenever a city name
# happened to be spelled the same as a common word or appear inside a longer
# word/name.


def test_common_word_that_is_also_a_city_name_does_not_false_positive():
    """'nice' (Nice, France) is also the ordinary English adjective. Verified
    live: this sentence resolved to FR under the old substring matcher."""
    assert _extract_country_from_excerpt("That was nice of them") is None


def test_city_name_inside_a_persons_name_does_not_false_positive():
    """'bern' (Bern, Switzerland) is a substring of the name 'Bernie'.
    Verified live: this resolved to CH under the old substring matcher."""
    assert _extract_country_from_excerpt("Bernie called me back") is None


def test_city_name_inside_an_alternate_spelling_does_not_false_positive():
    """'bern' is also a substring of 'Berne'. Verified live: resolved to CH."""
    assert _extract_country_from_excerpt("Send it to Berne") is None


def test_reading_the_verb_does_not_false_positive_as_reading_the_city():
    """'reading' (Reading, England) is also the ordinary English gerund.
    Companion case to 'nice' — same collision, different word class."""
    assert _extract_country_from_excerpt("reading a book right now") is None


def test_manchester_as_a_substring_still_resolves():
    """Not a false positive in the same sense as the others — 'Manchester' is
    not an ordinary English word — but confirms the word-boundary rewrite
    didn't accidentally break the common case."""
    assert _extract_country_from_excerpt("Manchester United fan") == "GB"


def test_genuine_city_mention_still_resolves_despite_being_a_common_word():
    """The whole point of requiring the fix to be word-boundary (not a
    blanket removal of ambiguous names): a real mention of the city must
    keep working."""
    assert _extract_country_from_excerpt("I live in Nice, France") == "FR"


def test_genuine_reading_city_mention_still_resolves():
    assert _extract_country_from_excerpt("plumber needed in Reading") == "GB"


def test_city_name_fragment_inside_an_unrelated_word_does_not_match():
    """Direct proof the fix is boundary-based, not just capitalisation-based:
    a capitalised fragment inside a longer word must still not match."""
    assert _extract_country_from_excerpt("Nicetown is a neighbourhood") is None


def test_province_in_group_name_disambiguates_to_canada():
    assert _resolve_lead_country("HANDYMAN SERVICES LONDON, Ontario", "London", "Looking for a handyman") == "CA"


def test_bare_london_resolves_uk():
    assert _resolve_lead_country("Plumbers in London UK", "London", "need a plumber") == "GB"


def test_unknown_city_no_longer_falls_back_to_raw_location():
    """CHANGED EXPECTATION (was test_unknown_city_falls_back_to_raw_location,
    asserted == "Nairobi"). `country` must only ever hold a resolvable ISO-2
    code, or nothing — never a town name. Writing the raw operator location
    into `country` when it can't be mapped is the exact fault this rewrite
    removes: 'Nairobi' (and any other unmapped place, or arbitrary operator
    text like 'Wigan'/'Nowheresville') must resolve to None, not be preserved
    verbatim. Operators who want the raw place for reference should read
    `location_confidence`, which already has an 'unconfirmed' bucket for
    exactly this case — there is no separate city column on `leads` to stash
    free text in.
    """
    assert _resolve_lead_country("Some Random Group", "Nairobi", "need help") is None


def test_arbitrary_operator_location_never_leaks_into_country():
    """A raw town/free-text search location must never land in `country`,
    even when the search was geo-scoped (the default) — only a location that
    resolves through the city map is trusted."""
    assert _resolve_lead_country("Some Random Group", "Wigan", "need help") is None
    assert _resolve_lead_country("Some Random Group", "Nowheresville", "need help") is None


def test_nothing_resolvable_returns_none():
    assert _resolve_lead_country(None, "", "") is None
    assert _resolve_lead_country("", None, "") is None


# ── FAULT 2: operator's search-target country only travels when geo_scoped ──


def test_geo_scoped_search_falls_back_to_the_resolvable_target_country():
    """A geo-scoped search (browser discovery, or an Apify query that names
    the place itself) already KNOWS its results are from the target location.
    When the post itself evidences nothing, trusting that location — as long
    as it resolves through the city map to a real ISO-2 code — is legitimate,
    not a guess."""
    assert _resolve_lead_country(None, "Manchester", "need a plumber", geo_scoped=True) == "GB"
    # geo_scoped defaults to True (matches every pre-existing call above).
    assert _resolve_lead_country(None, "Manchester", "need a plumber") == "GB"


def test_global_search_does_not_stamp_the_target_country_on_an_unevidenced_post():
    """THE FIX. A global (non-geo-scoped) search must not stamp its target
    location onto a post that names no place of its own — verified live, a
    20-post global search for 'Manchester' stamped all 20 leads GB when
    roughly 15 were American."""
    assert _resolve_lead_country(None, "Manchester", "need a plumber", geo_scoped=False) is None


def test_post_evidence_wins_regardless_of_geo_scoped():
    """When the post (or its group) names its OWN place, that evidence is
    trustworthy no matter how the search was run — geo_scoped only gates the
    operator's-location fallback, never the post's own evidence."""
    assert _resolve_lead_country(
        None, "Manchester", "Anyone know a plumber in Austin?", geo_scoped=False,
    ) == "US"
    assert _resolve_lead_country(
        None, "Manchester", "Anyone know a plumber in Austin?", geo_scoped=True,
    ) == "US"
