"""Screenshot backend selection and challenge detection.

Context, measured 2026-09-24: ScrapingBee is out of credits and not being
renewed. The free browser clears both walls but only HEADED on a residential
IP, so it cannot run on the EC2 worker. Apify's UNBLOCKER proxy clears them
HEADLESS — TripAdvisor in 77s, Yelp in 100s — and is what replaces it.

The detection test below encodes a mistake worth not repeating: the first
probe reported the plain residential proxy as "cleared" because it only
searched for block PHRASES, and TripAdvisor's interstitial renders almost no
text at all. An empty body scored as a pass. The screenshot showed the truth.
"""
import os

import pytest

from tools.scraper.shared.apify_screenshot import looks_blocked, screenshot_source


class TestLooksBlocked:
    def test_an_empty_page_is_blocked_not_fine(self):
        # The exact false negative from the first probe run.
        for body in ('', '   ', '\n\n', 'tripadvisor.com'):
            assert looks_blocked(body) is True, repr(body)

    @pytest.mark.parametrize('body', [
        'Access is temporarily restricted. We detected unusual activity from your device '
        'or network. Reasons may include rapid taps or clicks, JavaScript disabled.',
        'Just a moment... Please wait while we verify your browser before continuing on.',
        'Access to this page has been denied because we believe you are using automation.',
        'Attention Required! Cloudflare is checking your browser before you may continue.',
    ])
    def test_recognises_the_real_challenge_pages(self, body):
        assert looks_blocked(body) is True

    def test_a_real_profile_page_passes(self):
        # Shortened from the live TripAdvisor capture.
        body = ('Skip to main content Plan with AI Rewards Discover Review USD Sign in '
                'Cologne Things to Do Hotels Restaurants Cruises Forums Europe Germany '
                'North Rhine-Westphalia Cologne Messehotel Köln-Deutz 3.2 (42 reviews)')
        assert looks_blocked(body) is False

    def test_a_real_yelp_page_passes(self):
        body = ('Back to Search Yelp Miller Mechanical Heating and Air 3.5 (13 reviews) '
                'Heating & Air Conditioning/HVAC Write a review Add photos/videos Share Save')
        assert looks_blocked(body) is False

    def test_the_word_unusual_alone_does_not_condemn_a_page(self):
        # A business whose reviews mention "unusual" must not read as a block;
        # the signal is the phrase "unusual activity", not the word.
        body = ('Back to Search Yelp The Unusual Cafe 2.9 (41 reviews) Coffee & Tea '
                'Write a review Add photos Share Save Do you recommend this business?')
        assert looks_blocked(body) is False


class TestScreenshotSource:
    def setup_method(self):
        self._saved = {k: os.environ.get(k) for k in ('SCREENSHOT_SOURCE', 'APIFY_API_TOKEN')}

    def teardown_method(self):
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_defaults_to_apify_when_a_token_exists(self):
        # ScrapingBee is out of credits and not being renewed, so defaulting
        # to it would mean every screenshot silently fails on a new deploy.
        os.environ.pop('SCREENSHOT_SOURCE', None)
        os.environ['APIFY_API_TOKEN'] = 'apify_api_xxx'
        assert screenshot_source() == 'apify'

    def test_falls_back_to_scrapingbee_with_no_token(self):
        os.environ.pop('SCREENSHOT_SOURCE', None)
        os.environ.pop('APIFY_API_TOKEN', None)
        assert screenshot_source() == 'scrapingbee'

    def test_an_explicit_setting_always_wins(self):
        os.environ['APIFY_API_TOKEN'] = 'apify_api_xxx'
        os.environ['SCREENSHOT_SOURCE'] = 'scrapingbee'
        assert screenshot_source() == 'scrapingbee'
        os.environ['SCREENSHOT_SOURCE'] = 'APIFY'
        assert screenshot_source() == 'apify'
