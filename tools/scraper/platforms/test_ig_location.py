"""Location-confidence + wrong-country gate for the Instagram scraper.

Mirrors the Facebook location handling (migration 049) so IG leads carry the
same honesty flag and don't reproduce the wrong-country pollution FB had before
the gate existed. Like FB, matching is CITY-based (cities are unambiguous
location signals; a caption that only names a *country* — or an adjective like
"American-style" — stays 'unconfirmed' rather than risking a false-positive
drop). The underlying classifier (_derive_location_confidence) is covered by
test_location_confidence.py — these cover the IG-side verdict: stamp + keep/drop.
"""
from tools.scraper.platforms.instagram import _location_verdict, _best_location_confidence


def test_searched_city_in_caption_is_confirmed_and_kept():
    conf, keep = _location_verdict("Need a plumber in London today!", "London")
    assert conf == "confirmed_city"
    assert keep is True


def test_different_city_same_country_is_same_country_and_kept():
    conf, keep = _location_verdict("electrician based in Manchester, great work", "London")
    assert conf == "same_country"
    assert keep is True


def test_clear_other_country_city_is_dropped():
    conf, keep = _location_verdict("best electrician in Dublin hands down", "London")
    assert keep is False
    assert conf == "wrong_country"


def test_other_country_pair_is_dropped():
    conf, keep = _location_verdict("plumber serving Paris", "Berlin")
    assert keep is False
    assert conf == "wrong_country"


def test_no_location_signal_is_unconfirmed_and_kept():
    conf, keep = _location_verdict("amazing service, highly recommend!!", "London")
    assert conf == "unconfirmed"
    assert keep is True


def test_no_operator_location_keeps_everything_unconfirmed():
    # Operator didn't specify a location → we can't gate; keep, mark unconfirmed.
    conf, keep = _location_verdict("plumber in Dublin", "")
    assert keep is True
    assert conf == "unconfirmed"


def test_best_location_confidence_picks_strongest_across_posts():
    posts = [
        {"location_confidence": "unconfirmed"},
        {"location_confidence": "same_country"},
        {"location_confidence": "confirmed_city"},
    ]
    assert _best_location_confidence(posts) == "confirmed_city"


def test_best_location_confidence_is_none_when_unstamped():
    assert _best_location_confidence([{}, {"location_confidence": None}]) is None
