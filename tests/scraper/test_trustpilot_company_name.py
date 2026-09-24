"""Company-name cleaning for scraped Trustpilot profiles.

Trustpilot's profile `<h1>` used to read `Acme Reviews 1,234`; the in-page JS
stripped `Reviews <count>`. The count has since moved out of the heading, so
the pattern no longer matched and 1,188 leads landed named `Acme\xa0Reviews`
— which renders straight into `{{company_name}}` in outreach copy.

Cleaning lives in Python, not only in the injected JS, so a future DOM change
degrades to a clean name rather than a broken one.
"""
from __future__ import annotations

import pytest

from tools.scraper.scrape_profile import clean_company_name


@pytest.mark.parametrize('raw,expected', [
    ('VBET\xa0Reviews', 'VBET'),                       # current DOM: nbsp, no count
    ('vbet\xa0reviews', 'vbet'),                       # heading case varies
    ('Betano Reviews 499', 'Betano'),                  # legacy DOM: count present
    ('Betano Reviews 1,234', 'Betano'),                # thousands separator
    ('Matchbook Betting Exchange\xa0Reviews', 'Matchbook Betting Exchange'),
    ('Cgg.Bet.br\xa0Reviews', 'Cgg.Bet.br'),
])
def test_strips_the_trailing_reviews_heading(raw, expected):
    assert clean_company_name(raw) == expected


def test_leaves_a_clean_name_untouched():
    assert clean_company_name('Betano') == 'Betano'


def test_does_not_strip_reviews_from_the_middle_of_a_name():
    assert clean_company_name('Reviews Direct Ltd') == 'Reviews Direct Ltd'


@pytest.mark.parametrize('raw', [
    'Online Casino Canada Reviews',   # onlinecasinocanadareviews.com
    'Casinoreviews',                  # casinoreviews.com
    'Roibets Casino Reviews',         # roibets1.uk
    'UltreosForex.com Reviews',       # ultreosforex.com
])
def test_keeps_a_genuine_business_name_that_ends_in_reviews(raw):
    """A plain space with no review count is a real name, not h1 furniture.

    Trustpilot joins the heading with a non-breaking space; ten real leads in
    the database are businesses actually called "... Reviews", and stripping
    them would rename the company.
    """
    assert clean_company_name(raw) == raw


def test_collapses_the_non_breaking_space_inside_a_name():
    assert clean_company_name('Stake\xa0US\xa0Reviews') == 'Stake US'


def test_returns_none_when_nothing_survives_the_strip():
    """A bare heading is not a company name — the caller must keep its own."""
    assert clean_company_name('Reviews') is None
    assert clean_company_name('') is None
    assert clean_company_name(None) is None
