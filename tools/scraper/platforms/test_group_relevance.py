"""Unit tests for FB group relevance tiering + capping (pure functions).

Run from repo root:
    ./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_group_relevance.py -v
"""
from tools.scraper.platforms.facebook import (
    _resolve_relevance_language,
    _group_relevance_tier,
)


# Real 2026-06-05 Frankfurt discovery sample (from the next-session brief).
FRANKFURT_GROUPS = [
    "Neu in Frankfurt",
    "Frankfurt Events",
    "Nightlife Frankfurt",
    "EINTRACHT FRANKFURT NEWS",
    "Kleinanzeigen Frankfurt und Umgebung",
    "Elektriker für alle",
]


def test_resolve_language_maps_city_to_local_language():
    assert _resolve_relevance_language("Frankfurt") == "German"
    assert _resolve_relevance_language("Paris") == "French"
    # English-primary city → English fallback (GB not in COUNTRY_TO_LANGUAGE)
    assert _resolve_relevance_language("London") == "English"
    assert _resolve_relevance_language("") == "English"
    assert _resolve_relevance_language(None) == "English"


def test_tier2_niche_token_match():
    # Translated niche term appears in the group name → tier 2.
    assert _group_relevance_tier("Elektriker für alle", "Frankfurt", "Elektriker") == 2


def test_tier2_classifieds_token_german():
    # German classifieds token → tier 2 even when niche doesn't match.
    assert _group_relevance_tier("Kleinanzeigen Frankfurt und Umgebung", "Frankfurt", "Klempner") == 2


def test_tier1_community_token():
    assert _group_relevance_tier("West Hampstead Community", "London", "handyman") == 1


def test_tier0_generic_lifestyle():
    for name in ("Neu in Frankfurt", "Frankfurt Events", "Nightlife Frankfurt", "EINTRACHT FRANKFURT NEWS"):
        assert _group_relevance_tier(name, "Frankfurt", "Elektriker") == 0, name


def test_tier2_english_niche_match_in_london():
    assert _group_relevance_tier("London Handyman Recommendations", "London", "handyman") == 2


def test_tier2_english_vocab_fires_for_non_english_location():
    # English vocab tokens are ALWAYS unioned in, even for non-English
    # locations: 'handyman' fires while Frankfurt resolves to German.
    assert _group_relevance_tier("London Handyman Group", "Frankfurt", None) == 2


def test_niche_takes_precedence_over_tier1_token():
    # 'community' is a tier-1 token, but a niche word-boundary match wins.
    assert _group_relevance_tier("Elektriker Community Frankfurt", "Frankfurt", "Elektriker") == 2


from tools.scraper.platforms.facebook import _is_consumer_facing_group


def test_gate_keeps_classifieds_group():
    # German classifieds board → KEEP (no negative present anyway).
    assert _is_consumer_facing_group("Kleinanzeigen Frankfurt und Umgebung", "Frankfurt") is True


def test_gate_classifieds_overrides_a_negative_token():
    # 'flohmarkt' (DE classifieds override token) co-occurs with the
    # 'equipment' negative; the classifieds override must win → KEEP.
    assert _is_consumer_facing_group("Flohmarkt Equipment Frankfurt", "Frankfurt") is True


def test_gate_trade_role_word_does_NOT_rescue_b2b_supplier():
    # 'handyman' is a trade-role word (tier-2 for ranking) but is NOT a gate
    # override token, so the 'suppliers' negative still wins → DROP.
    assert _is_consumer_facing_group("Handyman Suppliers UK", "London") is False


def test_gate_backcompat_unchanged():
    # Existing behavior preserved for non-classifieds names.
    assert _is_consumer_facing_group("West Hampstead Community", "London") is True
    assert _is_consumer_facing_group("Dental Equipment Suppliers", "London") is False


def test_gate_generic_ads_word_does_not_rescue_job_board():
    # 'annunci' (generic IT "ads") was removed from the override, so a job
    # board that also trips the 'jobs' negative is correctly DROPPED.
    assert _is_consumer_facing_group("Annunci di Lavoro Jobs Roma", "Rome") is False


def test_gate_gesuche_word_boundary_excludes_stellengesuche():
    # word-boundary match: standalone 'Gesuche' overrides, but the compound
    # 'Stellengesuche' (job applications) does NOT — and with a 'jobs'
    # negative present it must DROP.
    assert _is_consumer_facing_group("Gesuche Frankfurt", "Frankfurt") is True
    assert _is_consumer_facing_group("Stellengesuche Jobs Frankfurt", "Frankfurt") is False


def test_gate_classifieds_override_still_fires_with_word_boundary():
    # Regression guard: the override still keeps a real classifieds board
    # that co-occurs with a negative, using word-boundary matching.
    assert _is_consumer_facing_group("Flohmarkt Equipment Frankfurt", "Frankfurt") is True


from tools.scraper.platforms.facebook import _order_and_cap_groups


def _g(name, gid):
    return {"name": name, "group_id": gid}


def test_order_and_cap_sorts_by_tier_and_caps_generics():
    groups = [
        _g("Frankfurt Events", "1"),            # tier 0
        _g("Kleinanzeigen Frankfurt", "2"),     # tier 2
        _g("Nightlife Frankfurt", "3"),         # tier 0
        _g("Neu in Frankfurt", "4"),            # tier 0
        _g("Elektriker für alle", "5"),         # tier 2 (niche)
        _g("Frankfurt Community", "6"),         # tier 1
        _g("EINTRACHT FRANKFURT NEWS", "7"),    # tier 0
    ]
    ordered, stats = _order_and_cap_groups(groups, niche="Elektriker", location="Frankfurt", generic_group_cap=1)

    ids = [g["group_id"] for g in ordered]
    # tier-2 first (in discovery order: 2 then 5), then tier-1 (6), then ONE generic (1).
    assert ids == ["2", "5", "6", "1"]
    assert stats == {"relevant": 3, "generic_searched": 1, "generic_skipped": 3}


def test_order_and_cap_zero_cap_drops_all_generics():
    groups = [_g("Frankfurt Events", "1"), _g("Kleinanzeigen Frankfurt", "2")]
    ordered, stats = _order_and_cap_groups(groups, niche="Elektriker", location="Frankfurt", generic_group_cap=0)
    assert [g["group_id"] for g in ordered] == ["2"]
    assert stats == {"relevant": 1, "generic_searched": 0, "generic_skipped": 1}


def test_order_and_cap_all_relevant_keeps_everything():
    groups = [_g("Kleinanzeigen Frankfurt", "1"), _g("Handwerker Frankfurt", "2")]
    ordered, stats = _order_and_cap_groups(groups, niche="Klempner", location="Frankfurt", generic_group_cap=5)
    assert len(ordered) == 2
    assert stats == {"relevant": 2, "generic_searched": 0, "generic_skipped": 0}


def test_order_and_cap_empty_input():
    ordered, stats = _order_and_cap_groups([], niche="Elektriker", location="Frankfurt", generic_group_cap=5)
    assert ordered == []
    assert stats == {"relevant": 0, "generic_searched": 0, "generic_skipped": 0}


def test_order_and_cap_group_without_name_is_tier0():
    # A malformed group dict lacking 'name' must not crash; classified tier 0.
    ordered, stats = _order_and_cap_groups([{"group_id": "1"}], niche="Elektriker", location="Frankfurt", generic_group_cap=5)
    assert [g["group_id"] for g in ordered] == ["1"]
    assert stats == {"relevant": 0, "generic_searched": 1, "generic_skipped": 0}


from tools.scraper.platforms.facebook import _resolve_generic_cap


def test_resolve_generic_cap_explicit_zero_is_honored():
    # The bug this fixes: explicit 0 must NOT become the default 5.
    assert _resolve_generic_cap({"generic_group_cap": 0}) == 0


def test_resolve_generic_cap_default_when_absent_or_none():
    assert _resolve_generic_cap({}) == 5
    assert _resolve_generic_cap({"generic_group_cap": None}) == 5


def test_resolve_generic_cap_passthrough_and_string():
    assert _resolve_generic_cap({"generic_group_cap": 3}) == 3
    assert _resolve_generic_cap({"generic_group_cap": "4"}) == 4  # JSON may send strings


def test_resolve_generic_cap_negative_clamped_and_garbage_defaults():
    assert _resolve_generic_cap({"generic_group_cap": -2}) == 0
    assert _resolve_generic_cap({"generic_group_cap": "abc"}) == 5


def test_tier_word_boundary_avoids_substring_false_positives():
    # 'marché' (FR vocab) must NOT match inside 'supermarché'.
    assert _group_relevance_tier("Supermarché Paris", "Paris", None) == 0
    # 'mura' (tier-1 token) must NOT match inside 'muralist'.
    assert _group_relevance_tier("Muralist Group Berlin", "Berlin", None) == 0


def test_tier_word_boundary_still_matches_real_tokens():
    # Regression guard: legitimate whole-word matches still fire.
    assert _group_relevance_tier("Le Marché de Lyon", "Lyon", None) == 2          # FR 'marché'
    assert _group_relevance_tier("Frankfurt Community Help", "Frankfurt", None) == 1  # tier-1 'community'
