"""Unit tests for the Hunter back-fill enricher's pure helpers.
Mirrors the selection logic in server/src/services/scrapers/tier9-hunter.ts."""
from tools.scraper.enrich_via_hunter import pick_best_email, is_plausible_email, domain_of


def test_pick_best_prefers_generic_then_confidence():
    emails = [
        {'value': 'charlie@x.com', 'type': 'personal', 'confidence': 95},
        {'value': 'info@x.com', 'type': 'generic', 'confidence': 80},
        {'value': 'support@x.com', 'type': 'generic', 'confidence': 88},
    ]
    # generic beats personal regardless of confidence; among generics, higher conf wins
    assert pick_best_email(emails) == 'support@x.com'


def test_pick_best_falls_back_to_personal_when_no_generic():
    assert pick_best_email([{'value': 'a@x.com', 'type': 'personal', 'confidence': 70}]) == 'a@x.com'


def test_pick_best_empty_returns_none():
    assert pick_best_email([]) is None


def test_is_plausible_email():
    assert is_plausible_email('info@cityprime.uk') is True
    assert is_plausible_email('not-an-email') is False
    assert is_plausible_email('') is False
    assert is_plausible_email('a@b') is False          # no TLD
    assert is_plausible_email('a@b.co') is False        # local part too short


def test_domain_of_strips_www_and_scheme():
    assert domain_of('https://www.charliemullinsobe.com/') == 'charliemullinsobe.com'
    assert domain_of('cityprime.uk') == 'cityprime.uk'
    assert domain_of('') is None        # no hostname → None
