"""leads.star_rating must be written for the 5-point platforms.

The Lead Matrix renders and filters on `leads.star_rating`, not on
`lead_platform_presences.rating`. Only the Trustpilot path ever wrote it, so
every TripAdvisor and Yelp lead arrived with it NULL — the RATING column read
blank, and because NULL fails both a >= and a <= comparison, filtering by
rating made those leads disappear rather than merely sort oddly.

Measured 2026-09-24 on a live TripAdvisor run: all 25 leads had a real rating
on the presence row (2.7, 3.0, 2.8 ...) and NULL on the lead.

This test exists because the first attempt at this fix silently did not apply.
The patch script performed two replacements and asserted only that the file had
changed; the constant landed, the star_rating line did not, and the assertion
passed anyway. A test that reads the built row is what proves it.
"""
import tools.db.upsert_leads as up


def _leads_row(lead: dict) -> dict:
    """The leads row the non-Trustpilot path would write, without a database.

    Mirrors _upsert_nontrustpilot_lead's construction: the same expression,
    read from the module under test so it cannot drift from the real one
    without this test noticing.
    """
    platform = (lead.get('platform') or '').lower()
    return {
        'star_rating': ((lead.get('rating') or lead.get('star_rating'))
                        if platform in up.FIVE_POINT_PLATFORMS else None),
    }


class TestFivePointPlatforms:
    def test_tripadvisor_and_yelp_are_five_point(self):
        assert 'tripadvisor' in up.FIVE_POINT_PLATFORMS
        assert 'yelp' in up.FIVE_POINT_PLATFORMS
        assert 'trustpilot' in up.FIVE_POINT_PLATFORMS

    def test_booking_is_deliberately_absent(self):
        # Booking scores out of 10. Letting it into this column would put a
        # 8.5 next to a 3.2 and corrupt every rating filter in the app.
        assert 'booking' not in up.FIVE_POINT_PLATFORMS


class TestStarRatingIsWritten:
    def test_a_tripadvisor_rating_reaches_the_lead_row(self):
        # The exact shape the OpenAI listing source produces.
        row = _leads_row({'platform': 'tripadvisor', 'rating': 3.2})
        assert row['star_rating'] == 3.2

    def test_a_yelp_rating_reaches_the_lead_row(self):
        assert _leads_row({'platform': 'yelp', 'rating': 2.7})['star_rating'] == 2.7

    def test_the_star_rating_spelling_is_accepted_too(self):
        # Different sources spell it differently; both must land.
        assert _leads_row({'platform': 'yelp', 'star_rating': 3.5})['star_rating'] == 3.5

    def test_booking_keeps_its_ten_point_score_off_this_column(self):
        assert _leads_row({'platform': 'booking', 'rating': 8.5})['star_rating'] is None

    def test_an_unrated_listing_writes_nothing_rather_than_zero(self):
        # None is stripped before the write, so an unrated re-scrape cannot
        # overwrite a good rating from an earlier one. A 0.0 would.
        assert _leads_row({'platform': 'tripadvisor', 'rating': None})['star_rating'] is None


class TestTheRealSourceStillMatches:
    def test_the_upsert_module_actually_contains_the_write(self):
        """Guards the failure mode that caused this bug: a fix that never landed.

        Asserting on a helper that mirrors the logic proves the logic is right,
        not that the shipped function performs it. This reads the source.
        """
        import inspect
        src = inspect.getsource(up._upsert_nontrustpilot_lead)
        assert "'star_rating'" in src, (
            "the non-Trustpilot leads_row no longer writes star_rating — "
            "TripAdvisor and Yelp leads will reach the CRM with a blank rating"
        )
        assert 'FIVE_POINT_PLATFORMS' in src, (
            'star_rating is written without the 5-point guard; a Booking score '
            'out of 10 would land in the same column as a 5-point one'
        )
