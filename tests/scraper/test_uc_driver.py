"""Regression tests for tools/scraper/shared/uc_driver.py pure helpers.

These cover only the string-rewriting proxy helpers that moved out of
facebook.py into the shared uc_driver module. They never launch Chrome —
following the pure-function fixture-test convention in
tests/scraper/test_facebook_helpers.py.
"""
from tools.scraper.shared.uc_driver import (
    resolve_proxy_country, apply_proxy_country, apply_proxy_country_password,
)


def test_resolve_proxy_country_falls_back_when_unmappable():
    assert resolve_proxy_country(None, fallback='AT') == 'AT'
    assert resolve_proxy_country('Atlantis, Nowhere', fallback='AT') == 'AT'


def test_apply_proxy_country_rewrites_area_token():
    assert apply_proxy_country('pl-XYZ_area-AT', 'GB') == 'pl-XYZ_area-GB'


def test_apply_proxy_country_password_rewrites_country_token():
    assert apply_proxy_country_password('58fc_country-AT', 'GB') == '58fc_country-GB'
