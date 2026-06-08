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
