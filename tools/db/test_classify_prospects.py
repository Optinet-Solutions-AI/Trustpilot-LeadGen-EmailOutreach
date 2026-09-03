"""Guards the prospect classifier's affiliate heuristic.

The cases below are all REAL rows from the live book. The first group is the
one that matters: every entry there is a genuine, sellable operator or an
unrelated business that an earlier single-tier token list mislabelled as an
affiliate. Because the Lead Matrix hides affiliates by default, a false
positive silently removes a prospect from view -- far worse than a miss,
which merely leaves an `unclassified` row for a human to glance at.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from tools.db.classify_prospects import (  # noqa: E402
    classify,
    looks_like_affiliate_domain,
    registered_domain,
)


class TestRegisteredDomain:
    def test_strips_scheme_www_and_path(self):
        assert registered_domain('https://www.Example.COM/a/b?x=1') == 'example.com'
        assert registered_domain('http://foo.co.uk') == 'foo.co.uk'
        assert registered_domain('bare.example') == 'bare.example'

    def test_handles_missing(self):
        assert registered_domain(None) is None
        assert registered_domain('') is None


class TestAffiliateHeuristicMustNotFire:
    """Real operators and unrelated businesses. A hit here loses a prospect."""

    CASES = [
        # `odds` used to match all three of these. They are real operators.
        ('oddset.dk', 'Danske Spil A/S'),
        ('oddsking.com', 'Petfre'),
        ('oddsmaker.ag', 'Oddsmaker'),
        # "amazonp-review" -- substring accident on `review`.
        ('uk.amazonpreview.com', ''),
        # Generic words with no gambling context anywhere.
        ('costaricadentalguide.com', ''),
        ('renownedhealthtips.com', ''),
        ('compare-energysuppliers.co.uk', 'Compare Energysuppliers'),
        # Ordinary operator brands.
        ('spinpalace.com', 'Spin Palace'),
        ('casinoroyaleclub.com', 'Casino Royale Club'),
    ]

    def test_none_are_flagged_as_affiliate(self):
        for domain, name in self.CASES:
            assert looks_like_affiliate_domain(domain, name) is None, (
                f'{domain} is not an affiliate and must not be flagged'
            )


class TestAffiliateHeuristicMustFire:
    """Genuine affiliate / comparison properties."""

    CASES = [
        ('casinoguide.dk', 'casinoguide.dk'),
        ('gamblingguide.eu', 'Online Casino Gambling Guide Reviews'),
        ('50freespinsnodeposit.info', '50 Free Spins No Deposit Reviews'),
        ('topcasinosfr.com', 'Topcasinosfr'),
        ('tipsbetting.co.uk', 'TIPSBETTING.CO.UK'),
        ('casinositesreview.io', 'Casino Sites Review'),
        # Gambling context comes from the COMPANY NAME, not the domain.
        ('winmate88-review.com', 'Winmate88 Casino'),
        ('oddschecker.com', 'Oddschecker'),
    ]

    def test_all_are_flagged(self):
        for domain, name in self.CASES:
            assert looks_like_affiliate_domain(domain, name) is not None, (
                f'{domain} is an affiliate and should be flagged'
            )


class TestClassifyPrecedence:
    """Order is disqualification order: flagged, then redirect, then dead."""

    def test_flagged_wins_over_everything(self):
        kind, _ = classify(
            {'blocked': True, 'redirects_to': 'x.com', 'link_status': 'FLAGGED_DEAD'}, {}
        )
        assert kind == 'flagged'

    def test_redirect_beats_dead(self):
        kind, _ = classify({'redirects_to': 'x.com', 'link_status': 'FLAGGED_DEAD'}, {})
        assert kind == 'redirect'

    def test_dead_from_link_status(self):
        assert classify({'link_status': 'FLAGGED_REMOVED'}, {})[0] == 'dead'

    def test_tracked_affiliate_domain(self):
        kind, reason = classify(
            {'website_url': 'https://known.com'}, {'known.com': 'Known Affiliate'}
        )
        assert kind == 'affiliate'
        assert 'Known Affiliate' in reason

    def test_no_signal_stays_unclassified(self):
        # Never guessed INTO 'operator' -- absence of junk signals is not
        # evidence that this is the real business.
        assert classify({'website_url': 'https://realcasino.se'}, {}) is None
