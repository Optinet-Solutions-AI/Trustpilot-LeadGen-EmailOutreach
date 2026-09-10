"""Picking the right named contact out of a provider's people list.

The operator asked for Head of Marketing / Director of Marketing / CMO. A
provider returns everyone it knows at the domain — support agents, VIP
managers, HR — so the ranking is the whole job: an exact CMO must beat a
"Marketing" generalist, and a support address must never win.
"""
from __future__ import annotations

import pytest

from tools.scraper.discover_contacts import (
    best_contact,
    normalize_domain,
    title_rank,
)


# --- title ranking -----------------------------------------------------------

@pytest.mark.parametrize('title', [
    'Chief Marketing Officer',
    'CMO',
    'cmo',
    'Group Chief Marketing Officer',
])
def test_cmo_titles_rank_highest(title):
    assert title_rank(title) == 0


@pytest.mark.parametrize('title', ['Head of Marketing', 'Global Head of Marketing'])
def test_head_of_marketing_ranks_just_below_cmo(title):
    assert title_rank(title) == 1


@pytest.mark.parametrize('title', ['Director of Marketing', 'Marketing Director'])
def test_marketing_director_ranks_third(title):
    assert title_rank(title) == 2


def test_vp_marketing_is_treated_as_marketing_leadership():
    assert title_rank('VP of Marketing') == 3
    assert title_rank('Vice President, Marketing') == 3


def test_adjacent_leadership_still_ranks_above_a_plain_marketer():
    """Snov returned 'Casino Product & CRM Director' at Novibet — a real
    decision-maker for reputation work, and better than nothing."""
    assert title_rank('Casino Product & CRM Director') < title_rank('Marketing')


def test_a_generic_marketing_title_ranks_last_among_matches():
    assert title_rank('Marketing') > title_rank('Marketing Manager')


def test_a_non_marketing_title_does_not_match_at_all():
    assert title_rank('Senior VIP Manager') is None
    assert title_rank('Suporte') is None
    assert title_rank('Outbound Sales Representative') is None
    assert title_rank('') is None
    assert title_rank(None) is None


def test_ppc_specialist_is_marketing_but_not_leadership():
    """kto.com's only marketing contact. Worth keeping, ranked low."""
    assert title_rank('PPC Specialist') is not None
    assert title_rank('PPC Specialist') > title_rank('Head of Marketing')


# --- choosing one contact ----------------------------------------------------

def _p(email, position, first='Ana', last='Silva'):
    return {'email': email, 'position': position, 'first_name': first, 'last_name': last}


def test_picks_the_highest_ranked_title():
    picked = best_contact([
        _p('ppc@x.com', 'PPC Specialist'),
        _p('cmo@x.com', 'Chief Marketing Officer'),
        _p('dir@x.com', 'Marketing Director'),
    ])
    assert picked['email'] == 'cmo@x.com'


def test_returns_none_when_nobody_matches():
    assert best_contact([_p('vip@x.com', 'Senior VIP Manager')]) is None


def test_returns_none_for_an_empty_people_list():
    assert best_contact([]) is None


def test_skips_a_person_with_no_email_even_if_the_title_is_perfect():
    picked = best_contact([
        _p(None, 'Chief Marketing Officer'),
        _p('head@x.com', 'Head of Marketing'),
    ])
    assert picked['email'] == 'head@x.com'


def test_never_returns_a_role_inbox_as_a_named_contact():
    """Snov handed back HR@novibet.com attached to a sales rep — a shared
    mailbox, not the person, and exactly what this feature exists to avoid."""
    assert best_contact([_p('HR@novibet.com', 'Head of Marketing')]) is None
    assert best_contact([_p('support@x.com', 'CMO')]) is None
    assert best_contact([_p('info@x.com', 'Marketing Director')]) is None


def test_builds_a_display_name_from_the_parts():
    picked = best_contact([_p('cmo@x.com', 'CMO', 'Fotini', 'Matthaiou')])
    assert picked['name'] == 'Fotini Matthaiou'


def test_tolerates_a_missing_surname():
    picked = best_contact([_p('cmo@x.com', 'CMO', 'Fotini', None)])
    assert picked['name'] == 'Fotini'


# --- domain handling ---------------------------------------------------------

@pytest.mark.parametrize('raw,expected', [
    ('https://www.betano.com/', 'betano.com'),
    ('http://betano.com', 'betano.com'),
    ('www.kto.com', 'kto.com'),
    ('novibet.com', 'novibet.com'),
    ('https://apostamax.bet.br/promo?x=1', 'apostamax.bet.br'),
])
def test_normalize_domain_strips_scheme_www_and_path(raw, expected):
    assert normalize_domain(raw) == expected


def test_normalize_domain_returns_none_for_junk():
    assert normalize_domain('') is None
    assert normalize_domain(None) is None
    assert normalize_domain('not a url') is None


# --- collapsing regional variants -------------------------------------------
# Sorting purely by worst rating targets regional pages (betfair.dk,
# vbet.co.uk, bet365.co.uk) and Snov holds no contacts for those. One brand's
# people live on its primary domain, so searching each variant separately both
# misses and burns a credit per miss.

from tools.scraper.discover_contacts import collapse_to_primary_domains  # noqa: E402


def _t(domain, rating=3.0):
    return {'id': domain, 'domain': domain, 'star_rating': rating}


def test_collapses_one_brands_variants_to_a_single_target():
    picked = collapse_to_primary_domains([
        _t('betano.dk'), _t('betano.de'), _t('betano.com'), _t('betano.co.uk')])
    assert [t['domain'] for t in picked] == ['betano.com']


def test_prefers_the_dot_com_over_any_country_domain():
    picked = collapse_to_primary_domains([_t('betfair.dk'), _t('www.betfair.com'), _t('betfair.co.uk')])
    assert picked[0]['domain'] == 'www.betfair.com'


def test_keeps_distinct_brands_apart():
    picked = collapse_to_primary_domains([_t('betano.de'), _t('novibet.com'), _t('kto.com')])
    assert sorted(t['domain'] for t in picked) == ['betano.de', 'kto.com', 'novibet.com']


def test_falls_back_to_the_shortest_domain_when_no_dot_com_exists():
    picked = collapse_to_primary_domains([_t('lottoland.asia'), _t('lottoland.co.uk')])
    assert picked[0]['domain'] == 'lottoland.asia'


def test_keeps_the_worst_rating_of_the_group_for_ordering():
    """The pitch is the group's worst profile even if the contact lives on .com."""
    picked = collapse_to_primary_domains([_t('betano.com', 4.5), _t('betano.de', 1.2)])
    assert picked[0]['domain'] == 'betano.com'
    assert picked[0]['star_rating'] == 1.2


def test_brazilian_licence_domain_is_its_own_brand():
    picked = collapse_to_primary_domains([_t('apostamax.bet.br'), _t('apostamax-br.com')])
    assert len(picked) == 2


# --- provider payload shapes -------------------------------------------------

from tools.scraper.discover_contacts import normalize_snov_person  # noqa: E402


def test_snov_camelcase_names_are_mapped_not_dropped():
    """Snov's v2 endpoint returns firstName/lastName. Reading first_name/last_name
    silently lost every contact's name on the first live run."""
    p = normalize_snov_person({
        'email': 'zion.nahum@sportingbet.com', 'position': 'Head of Marketing',
        'firstName': 'Zion', 'lastName': 'Nahum'})
    assert p['first_name'] == 'Zion'
    assert p['last_name'] == 'Nahum'
    assert best_contact([p])['name'] == 'Zion Nahum'


def test_snov_person_survives_missing_name_fields():
    p = normalize_snov_person({'email': 'a@x.com', 'position': 'CMO'})
    assert p['first_name'] is None and p['last_name'] is None
    assert best_contact([p])['name'] is None
