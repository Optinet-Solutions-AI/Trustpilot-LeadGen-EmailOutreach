"""Tests for turning reverse-lookup hits into upsertable Trustpilot leads."""
from __future__ import annotations

import pytest

from tools.scraper.trustpilot_reverse_ingest import (
    build_stub,
    country_to_iso,
    resolve_category,
    select_matches,
)


def _unit(**over):
    base = {
        'slug': 'betano.com',
        'name': 'Betano',
        'profile_url': 'https://www.trustpilot.com/review/betano.com',
        'trust_score': 1.3,
        'review_count': 499,
        'country': 'United Kingdom',
        'email': None,
        'phone': None,
        'website': 'https://betano.com',
        'categories': ['online_casino'],
        'consumer_alert': False,
        'match': 'name_match',
    }
    base.update(over)
    return base


def _record(**over):
    base = {
        'company': 'KAIZEN GAMING BRASIL LTDA',
        'brand': 'BETANO',
        'domain': 'betano.bet.br',
        'results': [_unit()],
        'matches': [_unit()],
    }
    base.update(over)
    return base


# --- country mapping ---------------------------------------------------------

@pytest.mark.parametrize('name,code', [
    ('United Kingdom', 'GB'),
    ('Brazil', 'BR'),
    ('Germany', 'DE'),
    ('Argentina', 'AR'),
    ('Gibraltar', 'GI'),
    ('Curaçao', 'CW'),
    ('Malta', 'MT'),
])
def test_country_to_iso_maps_trustpilot_names_to_codes(name, code):
    assert country_to_iso(name) == code


def test_united_kingdom_resolves_to_gb_not_uk():
    """Both GB and UK sit in the shared name table; the DB stores GB."""
    assert country_to_iso('United Kingdom') == 'GB'


def test_country_to_iso_returns_none_for_missing_or_unknown():
    assert country_to_iso(None) is None
    assert country_to_iso('') is None
    assert country_to_iso('Freedonia') is None


# --- category ----------------------------------------------------------------

def test_resolve_category_prefers_the_profiles_own_trustpilot_category():
    assert resolve_category(_unit(categories=['online_casino'])) == 'online_casino'


def test_resolve_category_falls_back_when_the_profile_lists_none():
    assert resolve_category(_unit(categories=[])) == 'betting_agency'


# --- selection ---------------------------------------------------------------

def test_select_matches_keeps_only_graded_matches():
    rec = _record(results=[_unit(), _unit(slug='vita.no', match='weak')])
    picked = select_matches([rec])
    assert [u['slug'] for u in picked] == ['betano.com']


def test_select_matches_dedupes_a_slug_reached_from_two_brands():
    a = _record(brand='BETANO', results=[_unit()])
    b = _record(brand='BETANO BR', results=[_unit()])
    assert len(select_matches([a, b])) == 1


def test_dedupe_keeps_the_stronger_match_tier():
    weakish = _record(brand='SUPER', results=[_unit(slug='superbet.com', match='name_match')])
    strong = _record(
        brand='SUPERBET', domain='superbet.com',
        results=[_unit(slug='superbet.com', match='exact_br_domain')],
    )
    picked = select_matches([weakish, strong])
    assert len(picked) == 1
    assert picked[0]['match'] == 'exact_br_domain'


def test_select_matches_can_be_restricted_to_specific_tiers():
    rec = _record(results=[
        _unit(slug='betano.bet.br', match='exact_br_domain'),
        _unit(slug='betano.de', match='name_match'),
    ])
    picked = select_matches([rec], tiers=('exact_br_domain',))
    assert [u['slug'] for u in picked] == ['betano.bet.br']


# --- stub construction -------------------------------------------------------

def test_stub_carries_the_slug_the_profile_scraper_reads():
    stub = build_stub(_record(), _unit())
    assert stub['slug'] == 'betano.com'


def test_stub_uses_the_canonical_trustpilot_url_as_the_dedup_key():
    stub = build_stub(_record(), _unit())
    assert stub['trustpilot_url'] == 'https://www.trustpilot.com/review/betano.com'


def test_stub_routes_through_the_trustpilot_upsert_path():
    assert build_stub(_record(), _unit())['platform'] == 'trustpilot'


def test_stub_carries_the_trustscore_as_the_star_rating():
    assert build_stub(_record(), _unit())['star_rating'] == 1.3


def test_stub_seeds_the_email_trustpilot_already_published():
    stub = build_stub(_record(), _unit(email='help@betano.co.uk'))
    assert stub['trustpilot_email'] == 'help@betano.co.uk'


def test_stub_country_comes_from_the_profile_not_the_brand_licence():
    """betano.de is a German profile even though the licence row is Brazilian."""
    stub = build_stub(_record(), _unit(slug='betano.de', country='Germany'))
    assert stub['country'] == 'DE'


def test_stub_falls_back_to_brazil_when_the_profile_states_no_country():
    stub = build_stub(_record(), _unit(country=None))
    assert stub['country'] == 'BR'


def test_stub_records_the_licensed_company_and_brand_for_traceability():
    stub = build_stub(_record(), _unit())
    assert stub['source_company'] == 'KAIZEN GAMING BRASIL LTDA'
    assert stub['source_brand'] == 'BETANO'


def test_stub_prefers_the_brand_name_over_a_bare_domain_display_name():
    """Trustpilot shows `betano.ca` as its own display name — use the brand."""
    stub = build_stub(_record(), _unit(slug='betano.ca', name='betano.ca'))
    assert stub['company_name'] == 'BETANO'


def test_stub_keeps_a_real_display_name_when_trustpilot_has_one():
    stub = build_stub(_record(), _unit(name='Betano UK'))
    assert stub['company_name'] == 'Betano UK'


# --- industry filter ---------------------------------------------------------
# A whole-token name match still collides with unrelated businesses: SUPER hits
# Super.com (a hotel/fintech, 62k reviews) and Energia hits an Irish electricity
# utility. Trustpilot's own categories separate them — but only where it has
# categorised the profile at all, and it miscategorises real operators too.

from tools.scraper.trustpilot_reverse_ingest import industry_verdict  # noqa: E402


def test_gambling_categories_confirm_the_profile():
    assert industry_verdict(_unit(categories=['online_casino_or_bookmaker'])) == 'gambling'
    assert industry_verdict(_unit(categories=['betting_agency'])) == 'gambling'
    assert industry_verdict(_unit(categories=['gambling_service'])) == 'gambling'
    assert industry_verdict(_unit(categories=['lottery_vendor'])) == 'gambling'


def test_an_uncategorised_profile_is_unknown_not_rejected():
    """www.bet365.com carries no categories at all — dropping it would be wrong."""
    assert industry_verdict(_unit(categories=[])) == 'unknown'


def test_an_off_industry_profile_is_rejected():
    assert industry_verdict(_unit(categories=['hotel', 'e_commerce_service'])) == 'off_industry'
    assert industry_verdict(_unit(categories=['energy_supplier'])) == 'off_industry'


def test_a_video_game_store_is_not_mistaken_for_a_gaming_service():
    assert industry_verdict(_unit(categories=['video_game_store'])) == 'off_industry'


def test_gaming_service_provider_counts_as_gambling():
    assert industry_verdict(_unit(categories=['gaming_service_provider'])) == 'gambling'


def test_a_domain_tier_match_outranks_a_wrong_category():
    """Trustpilot files ona.bet.br under telecoms; the licence sheet's own
    domain is stronger evidence than its category."""
    unit = _unit(categories=['telecommunications_service_provider'], match='br_domain')
    assert industry_verdict(unit) == 'gambling'


def test_off_industry_collisions_are_dropped_by_default():
    rec = _record(results=[
        _unit(slug='betano.com', categories=['casino']),
        _unit(slug='super.com', categories=['hotel']),
    ])
    assert [u['slug'] for u in select_matches([rec])] == ['betano.com']


def test_off_industry_collisions_can_be_kept_deliberately():
    rec = _record(results=[_unit(slug='super.com', categories=['hotel'])])
    assert len(select_matches([rec], include_off_industry=True)) == 1


# --- resume ------------------------------------------------------------------
# The profile scrape is a ~70 minute headed run and the upsert lands at the very
# end, so an interrupted session used to throw the whole thing away. Enriched
# rows are flushed to disk as they land and can be re-read on the next attempt.

from tools.scraper.trustpilot_reverse_ingest import pending_stubs  # noqa: E402


def test_pending_stubs_is_everything_when_nothing_was_enriched_yet():
    stubs = [{'slug': 'a.com'}, {'slug': 'b.com'}]
    assert pending_stubs(stubs, []) == stubs


def test_pending_stubs_skips_slugs_already_enriched():
    stubs = [{'slug': 'a.com'}, {'slug': 'b.com'}]
    done = [{'slug': 'a.com', 'trustpilot_email': 'x@a.com'}]
    assert [s['slug'] for s in pending_stubs(stubs, done)] == ['b.com']


def test_a_flushed_row_that_never_got_contact_data_is_retried():
    """scrape_profiles writes the bare stub back on a failed profile; that is
    not a completed enrichment and must not be treated as done."""
    stubs = [{'slug': 'a.com'}]
    done = [{'slug': 'a.com'}]
    assert [s['slug'] for s in pending_stubs(stubs, done)] == ['a.com']
