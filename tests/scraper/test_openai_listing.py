"""The pure parts of the OpenAI two-pass listing path.

Measured on live probes, 2026-09-24:

  * A city-scoped batch call returns real, correctly-rated businesses at
    $0.0039 each. A COUNTRY-scoped one returns real businesses with the wrong
    city (hotels in Kuhfelde and Kuesten both labelled "Bergen an der"), so
    the caller must always fan out per city.
  * Asking that same cheap call for the profile URL makes it INVENT one:
    9 of 11 came back as the literal placeholder
    ".../Hotel_Review-g187371-dXXXXX-Reviews-...". The URL is our dedupe key
    (lead_platform_presences(platform, profile_url)), so a fabricated one
    would create a fresh duplicate lead on every re-scrape. Rejecting these is
    the single most important thing in this module.
  * gpt-4.1-mini ignored the rating ceiling outright and returned hotels above
    it, so the ceiling is re-checked locally and never trusted to the model.
"""
import pytest

from tools.scraper.shared.openai_listing import (
    call_cost_usd,
    valid_profile_url,
    parse_candidates,
    SpendGuard,
    SpendExhausted,
)


class TestValidProfileUrl:
    """The fabrication guard."""

    @pytest.mark.parametrize('url', [
        'https://www.tripadvisor.com/Hotel_Review-g187371-d604987-Reviews-Messehotel.html',
        'https://www.tripadvisor.de/Hotel_Review-g187371-d8771835-Reviews-a_o_Koeln.html',
        'https://www.tripadvisor.com/Restaurant_Review-g294458-d1737319-Reviews-Van_Gogh.html',
        'https://www.tripadvisor.com/Attraction_Review-g187371-d243878-Reviews-Dom.html',
    ])
    def test_accepts_a_real_tripadvisor_url(self, url):
        assert valid_profile_url(url, 'tripadvisor')

    @pytest.mark.parametrize('url', [
        # The exact shape the model invented, 9 times out of 11.
        'https://www.tripadvisor.com/Hotel_Review-g187371-dXXXXX-Reviews-a_o_Cologne.html',
        'https://www.tripadvisor.com/Hotel_Review-g187371-dXXXXXXX-Reviews-Fortune.html',
        'https://www.tripadvisor.com/Hotel_Review-g187371-d00000-Reviews-Windsor.html',
        'https://www.tripadvisor.com/Hotel_Review-gXXXX-d123-Reviews-Alt_Deutz.html',
        'https://www.tripadvisor.com/Hotel_Review-g187371-d<id>-Reviews-Skada.html',
    ])
    def test_rejects_a_fabricated_tripadvisor_url(self, url):
        assert not valid_profile_url(url, 'tripadvisor')

    @pytest.mark.parametrize('url', [
        'https://www.tripadvisor.com/Hotels-g187371-Cologne-Hotels.html',
        'https://www.tripadvisor.com/',
        'https://example.com/Hotel_Review-g1-d2-Reviews-x.html',
        '',
        None,
        'not a url',
    ])
    def test_rejects_anything_that_is_not_a_profile(self, url):
        assert not valid_profile_url(url, 'tripadvisor')

    @pytest.mark.parametrize('url,ok', [
        ('https://www.yelp.com/biz/joes-plumbing-chicago', True),
        ('https://www.yelp.com/biz/joes-plumbing-chicago-2', True),
        ('https://m.yelp.com/biz/joes-plumbing', True),
        ('https://www.yelp.com/biz/', False),
        ('https://www.yelp.com/biz/example-slug-here', False),
        ('https://www.yelp.com/search?find_desc=plumber', False),
        ('https://www.tripadvisor.com/Hotel_Review-g1-d2-Reviews-x.html', False),
    ])
    def test_yelp_profile_urls(self, url, ok):
        assert valid_profile_url(url, 'yelp') is ok


class TestParseCandidates:
    def test_keeps_only_businesses_at_or_under_the_ceiling(self):
        # The model returned 3.8 and 3.6 when asked for <= 3.5. Never trust it.
        rows = parse_candidates(
            {'businesses': [
                {'name': 'Under', 'rating': 3.1},
                {'name': 'Exactly', 'rating': 3.5},
                {'name': 'Over', 'rating': 3.8},
            ]},
            max_rating=3.5, min_rating=1.0,
        )
        assert [r['name'] for r in rows] == ['Under', 'Exactly']

    def test_applies_the_floor_too(self):
        rows = parse_candidates(
            {'businesses': [{'name': 'Low', 'rating': 1.2}, {'name': 'Ok', 'rating': 3.0}]},
            max_rating=3.5, min_rating=2.0,
        )
        assert [r['name'] for r in rows] == ['Ok']

    def test_drops_a_row_with_no_usable_name(self):
        rows = parse_candidates(
            {'businesses': [{'name': '  ', 'rating': 3.0}, {'rating': 3.0}]}, 3.5, 1.0)
        assert rows == []

    def test_keeps_an_unrated_row_only_when_asked(self):
        payload = {'businesses': [{'name': 'Unrated', 'rating': None}]}
        assert parse_candidates(payload, 3.5, 1.0) == []
        assert len(parse_candidates(payload, 3.5, 1.0, include_unrated=True)) == 1

    def test_tolerates_the_model_naming_the_list_anything(self):
        for key in ('businesses', 'hotels', 'restaurants', 'results', 'items'):
            assert len(parse_candidates({key: [{'name': 'X', 'rating': 3.0}]}, 3.5, 1.0)) == 1

    def test_tolerates_a_bare_list(self):
        assert len(parse_candidates([{'name': 'X', 'rating': 3.0}], 3.5, 1.0)) == 1

    def test_survives_junk(self):
        for junk in (None, {}, [], 'text', {'businesses': None}, {'businesses': ['x']}):
            assert parse_candidates(junk, 3.5, 1.0) == []

    def test_deduplicates_on_name(self):
        rows = parse_candidates({'businesses': [
            {'name': 'Hotel Fortune', 'rating': 3.5},
            {'name': 'hotel fortune', 'rating': 3.5},
        ]}, 3.5, 1.0)
        assert len(rows) == 1


class TestCallCost:
    def test_prices_a_real_measured_call(self):
        # The real 27-hotel batch: 33,830 tokens on gpt-4.1 plus one search
        # call, billed at $0.088. Most of a web-search call is INPUT (the
        # fetched pages); the JSON it writes back is small.
        cost = call_cost_usd({'input_tokens': 32_000, 'output_tokens': 1_830}, 'gpt-4.1')
        assert 0.085 < cost < 0.092

    def test_a_cheaper_model_costs_less(self):
        u = {'input_tokens': 30_000, 'output_tokens': 3_830}
        assert call_cost_usd(u, 'gpt-4.1-mini') < call_cost_usd(u, 'gpt-4.1')

    def test_an_unknown_model_is_priced_at_the_dearest_known_rate(self):
        # Guessing low would under-report spend and walk through the budget.
        u = {'input_tokens': 10_000, 'output_tokens': 1_000}
        assert call_cost_usd(u, 'some-future-model') >= call_cost_usd(u, 'gpt-4.1')

    def test_missing_usage_still_charges_the_search_fee(self):
        # A call happened, so it cost something. Charging zero is how a budget
        # silently never trips.
        assert call_cost_usd({}, 'gpt-4.1') > 0
        assert call_cost_usd(None, 'gpt-4.1') > 0


class TestSpendGuard:
    def test_allows_spending_up_to_the_budget(self):
        g = SpendGuard(1.00)
        g.charge(0.40)
        g.charge(0.40)
        assert g.spent == pytest.approx(0.80)
        g.check()

    def test_stops_the_job_once_the_budget_is_gone(self):
        g = SpendGuard(0.50)
        g.charge(0.30)
        g.charge(0.30)
        with pytest.raises(SpendExhausted):
            g.check()

    def test_reports_what_was_spent_so_the_operator_can_see_it(self):
        g = SpendGuard(1.00)
        g.charge(0.25)
        assert '0.25' in g.summary() and '1.00' in g.summary()

    def test_a_budget_of_zero_or_less_means_unlimited(self):
        g = SpendGuard(0)
        g.charge(999.0)
        g.check()


class TestBlockedPlatformAbort:
    """A platform the model cannot actually read must stop fast.

    Live-tested 2026-09-24: Yelp pass 1 happily returns plausible business
    names, but pass 2 can never confirm one — handed REAL Yelp URLs from our
    own database it answered page_opened=false every time, because PerimeterX
    blocks OpenAI's crawler just as it blocks ours. Left unguarded that spent
    $0.47 across 7 calls for 0 leads, which is the same "completed, 0 found"
    trap that a drained ScrapingBee account used to produce.

    So: if the first few confirmations in a row all fail, the platform is
    unreadable, not unlucky. Stop and say so.
    """

    def test_gives_up_after_a_run_of_failures(self):
        from tools.scraper.shared.openai_listing import should_abort_blocked
        assert should_abort_blocked(attempted=3, confirmed=0) is True
        assert should_abort_blocked(attempted=5, confirmed=0) is True

    def test_keeps_going_while_anything_is_confirming(self):
        from tools.scraper.shared.openai_listing import should_abort_blocked
        # One success proves the platform is readable; the rest are just
        # businesses it could not find, which is normal.
        assert should_abort_blocked(attempted=9, confirmed=1) is False

    def test_does_not_give_up_too_early(self):
        from tools.scraper.shared.openai_listing import should_abort_blocked
        # Two misses is ordinary; three in a row with nothing is a wall.
        assert should_abort_blocked(attempted=1, confirmed=0) is False
        assert should_abort_blocked(attempted=2, confirmed=0) is False
