"""Parser + matcher tests for the Trustpilot brand reverse-lookup.

Fixture is a real `/search?query=betano` payload captured 2026-09-04, trimmed to
the `__NEXT_DATA__` script. No live URLs — Trustpilot sits behind AWS WAF and
only a headed stealth browser reaches it, so CI must never try.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from tools.scraper.trustpilot_reverse_lookup import (
    classify_match,
    normalize_brand,
    parse_business_units,
    slug_label,
)

FIXTURE = Path(__file__).parent / 'fixtures' / 'trustpilot_search_betano.html'


@pytest.fixture(scope='module')
def units() -> list[dict]:
    return parse_business_units(FIXTURE.read_text(encoding='utf-8'))


# --- parsing -----------------------------------------------------------------

def test_parses_every_business_unit_on_the_page(units):
    assert len(units) == 10


def test_maps_slug_rating_and_review_count(units):
    betano_com = next(u for u in units if u['slug'] == 'betano.com')
    assert betano_com['name'] == 'Betano'
    assert betano_com['trust_score'] == 1.3
    assert betano_com['review_count'] == 499


def test_builds_the_canonical_profile_url(units):
    betano_com = next(u for u in units if u['slug'] == 'betano.com')
    assert betano_com['profile_url'] == 'https://www.trustpilot.com/review/betano.com'


def test_lifts_the_published_contact_email_when_present(units):
    uk = next(u for u in units if u['slug'] == 'betano.co.uk')
    assert uk['email'] == 'help@betano.co.uk'


def test_leaves_email_none_when_the_profile_publishes_none(units):
    de = next(u for u in units if u['slug'] == 'betano.de')
    assert de['email'] is None


def test_reads_the_country_off_the_location_block(units):
    ar = next(u for u in units if u['slug'] == 'betano.bet.ar')
    assert ar['country'] == 'Argentina'


def test_returns_empty_list_when_the_page_carries_no_next_data():
    assert parse_business_units('<html><body>Verifying your connection</body></html>') == []


# --- normalisation -----------------------------------------------------------

@pytest.mark.parametrize('raw,expected', [
    ('BETANO', 'betano'),
    ('CASA DE APOSTAS', 'casadeapostas'),
    ('F12.BET', 'f12bet'),
    ('MR. JACK BET', 'mrjackbet'),
    ('BETÃO', 'betao'),
    ('GALERA.BET', 'galerabet'),
])
def test_normalize_brand_strips_case_punctuation_and_accents(raw, expected):
    assert normalize_brand(raw) == expected


@pytest.mark.parametrize('slug,expected', [
    ('betano.com', 'betano'),
    ('betano.co.uk', 'betano'),
    ('betano.bet.ar', 'betano'),
    ('casadeapostas.bet.br', 'casadeapostas'),
    ('betano-promo.cz', 'betanopromo'),
])
def test_slug_label_takes_the_registrable_prefix(slug, expected):
    assert slug_label(slug) == expected


# --- matching ----------------------------------------------------------------

def test_exact_brazilian_domain_is_the_strongest_match():
    brand = {'brand': 'SUPERBET', 'domain': 'superbet.bet.br'}
    unit = {'slug': 'superbet.bet.br', 'name': 'Superbet'}
    assert classify_match(brand, unit) == 'exact_br_domain'


def test_other_brazilian_domain_for_the_same_brand_is_br_domain():
    brand = {'brand': 'BETANO', 'domain': 'betano.bet.br'}
    unit = {'slug': 'betano.com.br', 'name': 'Betano Brasil'}
    assert classify_match(brand, unit) == 'br_domain'


def test_regional_profile_with_the_brand_as_its_slug_label_is_a_name_match():
    brand = {'brand': 'BETANO', 'domain': 'betano.bet.br'}
    unit = {'slug': 'betano.co.uk', 'name': 'Betano UK'}
    assert classify_match(brand, unit) == 'name_match'


def test_display_name_equal_to_the_brand_is_a_name_match():
    brand = {'brand': 'REI DO PITACO', 'domain': 'reidopitaco.bet.br'}
    unit = {'slug': 'rdp.com', 'name': 'Rei do Pitaco'}
    assert classify_match(brand, unit) == 'name_match'


def test_unrelated_business_from_a_fuzzy_search_is_weak():
    brand = {'brand': 'BETANO', 'domain': 'betano.bet.br'}
    unit = {'slug': 'vita.no', 'name': 'VITA.NO'}
    assert classify_match(brand, unit) == 'weak'


def test_affiliate_lookalike_slug_is_not_promoted_to_a_name_match():
    brand = {'brand': 'BETANO', 'domain': 'betano.bet.br'}
    unit = {'slug': 'betano-promo.cz', 'name': 'Betano Promo CZ'}
    assert classify_match(brand, unit) == 'weak'


def test_short_brand_does_not_swallow_longer_slugs():
    """SUPER must not claim superbet.com — substring matching would."""
    brand = {'brand': 'SUPER', 'domain': 'super.bet.br'}
    unit = {'slug': 'superbet.com', 'name': 'Superbet'}
    assert classify_match(brand, unit) == 'weak'


def test_brand_with_no_registered_domain_still_matches_on_name():
    brand = {'brand': 'NETPIX', 'domain': ''}
    unit = {'slug': 'netpix.com', 'name': 'Netpix'}
    assert classify_match(brand, unit) == 'name_match'


def test_the_betano_fixture_yields_exactly_the_real_regional_profiles(units):
    brand = {'brand': 'BETANO', 'domain': 'betano.bet.br'}
    matched = sorted(
        u['slug'] for u in units if classify_match(brand, u) != 'weak'
    )
    assert matched == [
        'betano.bet.ar',
        'betano.ca',
        'betano.co.uk',
        'betano.com',
        'betano.de',
        'betano.dk',
        'betano.pt',
    ]
