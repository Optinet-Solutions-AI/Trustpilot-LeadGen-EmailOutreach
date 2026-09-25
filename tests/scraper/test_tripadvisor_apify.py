"""The TripAdvisor Apify adapter's pure parts.

Measured live on Cologne, 2026-09-25 — the whole city, 104 hotels, $0.30:
15 at or under 3.5 (14%), 13 of those with an email (87%), i.e. $0.020 per
usable lead against the OpenAI path's $0.204.

A first 40-result sample suggested only 2% qualified. That was the TOP of a
ranked list — by definition the best-rated hotels — and the low-rated ones sit
deeper. Sampling the head of a ranking to estimate its tail is the mistake
these numbers exist to record.
"""
import pytest

from tools.scraper.platforms.tripadvisor_apify import (
    build_actor_input,
    keep_business,
    map_business,
)

# A real row, trimmed, exactly as the actor returned it.
RAW = {
    'name': 'Hotel Esplanade in Koln',
    'localName': 'Hotel Esplanade in Köln',
    'webUrl': 'https://www.tripadvisor.com/Hotel_Review-g187371-d234018-Reviews-Hotel_Esplanade.html',
    'website': 'https://hotelesplanade.de/',
    'email': 'info@hotelesplanade.de',
    'phone': '011492219215570',
    'rating': 4.3,
    'numberOfReviews': 495,
    'address': 'Hohenstaufenring 56, 50674 Cologne',
    'id': 234018,
}


def _map(**over):
    return map_business({**RAW, **over}, city='Cologne', country='DE', category='hotels')


class TestMapBusiness:
    def test_keeps_the_canonical_profile_url_as_the_dedupe_key(self):
        # webUrl is the one field nothing else can supply. The OpenAI path had
        # to ask a model for it and got 9 of 11 as the placeholder `dXXXXX`.
        assert _map()['profile_url'] == RAW['webUrl']

    def test_carries_the_contact_details_the_second_pass_used_to_cost_money_for(self):
        s = _map()
        assert s['platform_email'] == 'info@hotelesplanade.de'
        assert s['website_url'] == 'https://hotelesplanade.de/'
        assert s['phone'] == '011492219215570'

    def test_carries_rating_and_review_count(self):
        s = _map()
        assert s['rating'] == 4.3
        assert s['review_count'] == 495

    def test_is_tagged_so_the_upsert_and_screenshot_paths_can_branch(self):
        s = _map()
        assert s['platform'] == 'tripadvisor'
        assert s['listing_source'] == 'apify'
        assert s['country'] == 'DE' and s['city'] == 'Cologne'

    @pytest.mark.parametrize('url', [
        '', None,
        'https://www.tripadvisor.com/Hotels-g187371-Cologne-Hotels.html',   # a listing
        'https://example.com/Hotel_Review-g1-d2-Reviews-x.html',            # wrong host
        'https://www.tripadvisor.com/Hotel_Review-g187371-dXXXXX-Reviews-x.html',
    ])
    def test_drops_a_row_without_a_real_profile_url(self, url):
        # Better to lose the row than to write a dedupe key that will create a
        # fresh duplicate lead on every re-scrape.
        assert _map(webUrl=url) is None

    def test_drops_a_nameless_row(self):
        assert _map(name='', localName='') is None

    def test_falls_back_to_the_local_name(self):
        assert _map(name='')['name'] == 'Hotel Esplanade in Köln'

    def test_survives_junk(self):
        for junk in (None, 'text', 42, []):
            assert map_business(junk, city='c', country='DE', category='hotels') is None

    def test_empty_contact_fields_become_none_not_empty_strings(self):
        s = _map(email='', website='   ', phone=None)
        assert s['platform_email'] is None and s['website_url'] is None and s['phone'] is None


class TestKeepBusiness:
    def _stub(self, rating, reviews=100):
        return {'rating': rating, 'review_count': reviews}

    def test_keeps_a_business_at_or_under_the_ceiling(self):
        assert keep_business(self._stub(3.0), max_rating=3.5, min_rating=1.0)
        assert keep_business(self._stub(3.5), max_rating=3.5, min_rating=1.0)

    def test_drops_the_well_rated_ones_we_cannot_sell_to(self):
        # 86% of a city is above the ceiling; this filter IS the product.
        assert not keep_business(self._stub(4.3), max_rating=3.5, min_rating=1.0)

    def test_applies_the_floor(self):
        assert not keep_business(self._stub(1.2), max_rating=3.5, min_rating=2.0)

    def test_applies_the_review_floor(self):
        assert not keep_business(self._stub(3.0, reviews=2), max_rating=3.5,
                                 min_rating=1.0, min_review_count=5)

    def test_an_unrated_listing_is_dropped_unless_asked_for(self):
        # Outside the big markets a great many carry no rating, and silently
        # dropping them is how a working market reports zero.
        s = self._stub(None)
        assert not keep_business(s, max_rating=3.5, min_rating=1.0)
        assert keep_business(s, max_rating=3.5, min_rating=1.0, include_unrated=True)

    def test_rating_floors_do_not_apply_to_an_unrated_row(self):
        assert keep_business({'rating': None, 'review_count': 0}, max_rating=3.5,
                             min_rating=1.0, min_review_count=99, include_unrated=True)


class TestActorInput:
    @pytest.mark.parametrize('kind,flag', [
        ('hotels', 'includeHotels'),
        ('restaurants', 'includeRestaurants'),
        ('attractions', 'includeAttractions'),
    ])
    def test_each_listing_type_asks_for_only_itself(self, kind, flag):
        got = build_actor_input('Cologne', kind, 100)
        assert got[flag] is True
        assert sum(1 for k in ('includeHotels', 'includeRestaurants', 'includeAttractions')
                   if got[k]) == 1

    def test_an_unknown_listing_type_falls_back_to_hotels(self):
        assert build_actor_input('Cologne', 'spaceships', 10)['includeHotels'] is True

    def test_does_not_pay_for_add_ons_we_do_not_display(self):
        # Review tags and photos are billed separately and shown nowhere.
        assert build_actor_input('Cologne', 'hotels', 10)['includeTags'] is False

    def test_passes_the_cap_through(self):
        assert build_actor_input('Cologne', 'hotels', 42)['maxItemsPerQuery'] == 42


class TestPhoneCleaning:
    """The actor returns placeholders where a number should be.

    A live Cologne row came back with phone "OTHER". Written through it
    reaches the CRM looking like a callable number and wastes someone's time.
    """

    def test_keeps_a_real_number(self):
        assert _map(phone='+49 221 46706470')['phone'] == '+49 221 46706470'

    @pytest.mark.parametrize('junk', ['OTHER', 'N/A', '', '   ', None, 'n/a', '-', 'none'])
    def test_drops_a_placeholder(self, junk):
        assert _map(phone=junk)['phone'] is None

    def test_drops_something_too_short_to_be_a_number(self):
        assert _map(phone='12345')['phone'] is None
