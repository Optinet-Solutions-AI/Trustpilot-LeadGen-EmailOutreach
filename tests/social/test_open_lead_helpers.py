"""Unit tests for the pure login-state detection helpers in open_lead_browser.

These tests use a fake Selenium WebDriver stub — no real browser needed.
"""

from __future__ import annotations

import pytest

from tools.social.open_lead_browser import (
    _page_is_logged_in,
    _url_is_login_or_checkpoint,
)


# ── Fake driver stubs ────────────────────────────────────────────────────────

class _FakeDriver:
    """Minimal WebDriver stub for testing login-state detection."""

    def __init__(self, *, c_user_cookie=None, has_email_field=True, has_pass_field=True):
        self._c_user = c_user_cookie
        self._has_email = has_email_field
        self._has_pass = has_pass_field

    def get_cookie(self, name: str):
        if name == "c_user" and self._c_user is not None:
            return {"value": self._c_user}
        return None

    def find_elements(self, by: str, value: str):
        # Simulate presence of login form fields.
        if "email" in value:
            return [object()] if self._has_email else []
        if "pass" in value:
            return [object()] if self._has_pass else []
        return []


# ── _page_is_logged_in ───────────────────────────────────────────────────────

class TestPageIsLoggedIn:
    def test_c_user_cookie_present_returns_true(self):
        driver = _FakeDriver(c_user_cookie="123456789")
        assert _page_is_logged_in(driver) is True

    def test_no_cookie_but_no_login_form_returns_true(self):
        # No c_user cookie, but login form fields are also absent → logged in.
        driver = _FakeDriver(c_user_cookie=None, has_email_field=False, has_pass_field=False)
        assert _page_is_logged_in(driver) is True

    def test_no_cookie_and_login_form_present_returns_false(self):
        driver = _FakeDriver(c_user_cookie=None, has_email_field=True, has_pass_field=True)
        assert _page_is_logged_in(driver) is False

    def test_empty_c_user_falls_through_to_form_check(self):
        # c_user cookie exists but value is empty string → falsy → not trusted.
        driver = _FakeDriver(c_user_cookie="", has_email_field=True, has_pass_field=True)
        assert _page_is_logged_in(driver) is False

    def test_driver_raises_on_cookie_still_checks_form(self):
        # Even if get_cookie explodes, we fall back to DOM check.
        class _BrokenCookieDriver(_FakeDriver):
            def get_cookie(self, name):
                raise RuntimeError("driver disconnected")
        driver = _BrokenCookieDriver(has_email_field=False, has_pass_field=False)
        assert _page_is_logged_in(driver) is True


# ── _url_is_login_or_checkpoint ──────────────────────────────────────────────

class TestUrlIsLoginOrCheckpoint:
    @pytest.mark.parametrize("url", [
        "https://www.facebook.com/login/",
        "https://www.facebook.com/login?next=https%3A%2F%2Fwww.facebook.com%2F",
        "https://www.facebook.com/checkpoint/",
        "https://www.facebook.com/checkpoint/?next=https://www.facebook.com/",
        "https://www.facebook.com/login.php",
    ])
    def test_blocked_urls_return_true(self, url):
        assert _url_is_login_or_checkpoint(url) is True

    @pytest.mark.parametrize("url", [
        "https://www.facebook.com/",
        "https://www.facebook.com/groups/12345/posts/67890",
        "https://www.facebook.com/profile.php?id=123",
        "https://www.facebook.com/groups/somedomain/",
    ])
    def test_normal_urls_return_false(self, url):
        assert _url_is_login_or_checkpoint(url) is False
