"""Trustpilot must run with the operator's laptop switched off.

AWS WAF fronts the whole site. Measured 2026-09-04, only a stealth HEADED
browser on a residential IP cleared it, which pinned Trustpilot to the owner's
machine while every other platform moved to the server.

Measured 2026-09-28: Apify UNBLOCKER clears that WAF. Plain HTTP through the
proxy returned a real 694KB profile (bet365, TrustScore 1.3, 7052 reviews) and
a real category page (20 businesses with scores and websites), and a HEADLESS
browser through the same proxy read them with the scraper's own __NEXT_DATA__
evaluation. So the wall is no longer a reason to stay local.

These guard the decision, not the network: which transport a run picks.
"""
import pytest

from tools.scraper.browser_utils import browser_proxy_for

FAKE = {'server': 'http://proxy.apify.com:8000', 'username': 'groups-UNBLOCKER',
        'password': 'pw'}


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """The password is fetched from Apify's API; these test the DECISION.

    Without this the suite makes a live HTTP call per test and fails on a
    401 rather than on the logic it is meant to be guarding.
    """
    import tools.scraper.shared.apify_screenshot as shot
    # Mirrors the real function: no token, no proxy — never a broken one.
    import os as _os
    monkeypatch.setattr(
        shot, 'unblocker_proxy',
        lambda: FAKE if _os.getenv('APIFY_API_TOKEN') else None,
    )


class TestBrowserProxyFor:
    def test_a_headless_server_run_uses_the_unblocker(self, monkeypatch):
        # The whole point: no laptop, no residential IP, still gets the page.
        monkeypatch.setenv('APIFY_API_TOKEN', 'apify_api_x')
        monkeypatch.setenv('PLAYWRIGHT_HEADLESS', 'true')
        monkeypatch.delenv('TRUSTPILOT_FETCH', raising=False)
        proxy = browser_proxy_for('trustpilot')
        assert proxy is not None
        assert 'server' in proxy and proxy.get('password')

    def test_the_owners_headed_run_stays_free(self, monkeypatch):
        # Headed on a residential line already clears the wall for nothing.
        # Paying the proxy there would be spending money to be slower.
        monkeypatch.setenv('APIFY_API_TOKEN', 'apify_api_x')
        monkeypatch.setenv('PLAYWRIGHT_HEADLESS', 'false')
        monkeypatch.delenv('TRUSTPILOT_FETCH', raising=False)
        assert browser_proxy_for('trustpilot') is None

    def test_no_token_means_no_proxy_rather_than_a_broken_one(self, monkeypatch):
        monkeypatch.delenv('APIFY_API_TOKEN', raising=False)
        monkeypatch.setenv('PLAYWRIGHT_HEADLESS', 'true')
        monkeypatch.delenv('TRUSTPILOT_FETCH', raising=False)
        assert browser_proxy_for('trustpilot') is None

    def test_an_explicit_choice_wins(self, monkeypatch):
        monkeypatch.setenv('APIFY_API_TOKEN', 'apify_api_x')
        monkeypatch.setenv('PLAYWRIGHT_HEADLESS', 'false')
        monkeypatch.setenv('TRUSTPILOT_FETCH', 'unblocker')
        assert browser_proxy_for('trustpilot') is not None
        monkeypatch.setenv('PLAYWRIGHT_HEADLESS', 'true')
        monkeypatch.setenv('TRUSTPILOT_FETCH', 'browser')
        assert browser_proxy_for('trustpilot') is None

    @pytest.mark.parametrize('platform', ['facebook', 'instagram'])
    def test_logged_in_platforms_are_never_proxied(self, platform, monkeypatch):
        # A session minted on one IP and used from another is how an account
        # gets checkpointed. These carry cookies; they must keep their own IP.
        monkeypatch.setenv('APIFY_API_TOKEN', 'apify_api_x')
        monkeypatch.setenv('PLAYWRIGHT_HEADLESS', 'true')
        assert browser_proxy_for(platform) is None

    def test_an_unknown_caller_gets_nothing(self, monkeypatch):
        # Opt-in per platform. A new scraper does not silently start spending.
        monkeypatch.setenv('APIFY_API_TOKEN', 'apify_api_x')
        monkeypatch.setenv('PLAYWRIGHT_HEADLESS', 'true')
        assert browser_proxy_for('some_new_platform') is None
