"""Operator-driven login + captcha-recovery flows for social_accounts.

Both flows open a non-headless undetected-chromedriver window and hand
the keyboard over to the operator. The operator completes the login or
clears the captcha; we wait for either (a) the platform's session
cookie to appear, or (b) a sentinel file to be touched by the API
layer (operator clicked "Done" in the UI).

The browser stays open for ``LOGIN_MAX_SECONDS`` (default 10 min). On
success the cookie jar is encrypted and written to
``social_accounts.encrypted_cookies``; status flips to ``active``. On
timeout or operator-cancel, status stays / returns to whatever it
was (``checkpoint`` recovery doesn't downgrade to ``banned``).

INVOKE AS A SCRIPT (the API spawns this as a child process):

    py -m tools.scraper.shared.login_flows --account-id <uuid>
    py -m tools.scraper.shared.login_flows --account-id <uuid> --recover

The script prints structured single-line events to stdout (the API tails
the pipe):

    STAGE:browser_open
    STAGE:waiting_for_login        (operator should now log in)
    STAGE:cookies_captured
    STAGE:done
    STAGE:failed:<reason>
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime, timezone
from typing import Optional

from tools.db.supabase_client import table
from tools.scraper.shared.session_store import save_cookies

LOGIN_MAX_SECONDS = int(os.getenv('SOCIAL_LOGIN_TIMEOUT_SECONDS', '600'))
POLL_INTERVAL = 2.0

# Cookies whose presence proves the operator finished login. We don't
# decode their value — that's the scraper's job.
SESSION_COOKIE_BY_PLATFORM = {
    'facebook': 'c_user',
    'instagram': 'sessionid',
}

START_URL_BY_PLATFORM = {
    'facebook': 'https://www.facebook.com/login',
    'instagram': 'https://www.instagram.com/accounts/login/',
}


def _emit(stage: str, detail: str = '') -> None:
    """Single-line structured event for the parent process to parse."""
    msg = f'STAGE:{stage}' if not detail else f'STAGE:{stage}:{detail}'
    print(msg, flush=True)


def _fetch_account(account_id: str) -> dict:
    rows = (
        table('social_accounts')
        .select('id,platform,handle,status,encrypted_cookies')
        .eq('id', account_id)
        .execute()
        .data
    )
    if not rows:
        raise ValueError(f'social_accounts row not found: {account_id}')
    return rows[0]


def _mark_status(account_id: str, status: str, **extra) -> None:
    payload = {
        'status': status,
        'updated_at': datetime.now(timezone.utc).isoformat(),
        **extra,
    }
    table('social_accounts').update(payload).eq('id', account_id).execute()


def _open_driver(headless: bool = False):
    """Lazy-import undetected_chromedriver so the module imports cheap.

    Returns a webdriver instance. Caller must ``driver.quit()``.
    """
    import undetected_chromedriver as uc  # noqa: WPS433 — lazy import is correct here

    options = uc.ChromeOptions()
    if headless:
        options.add_argument('--headless=new')
    # Reasonable defaults that mimic an everyday browser session.
    options.add_argument('--window-size=1280,900')
    options.add_argument('--disable-blink-features=AutomationControlled')
    return uc.Chrome(options=options, use_subprocess=True)


def _load_jar_into_driver(driver, jar: list[dict]) -> None:
    """Restore a saved cookie jar before navigating to the platform.

    We seed cookies one at a time after navigating to the root URL —
    Selenium rejects cookies whose domain doesn't match the current
    page, so we visit the platform first, then inject.
    """
    for cookie in jar:
        try:
            driver.add_cookie(cookie)
        except Exception as exc:  # noqa: BLE001 — best-effort cookie restore
            print(f'WARN: failed to inject cookie {cookie.get("name")}: {exc}', file=sys.stderr)


def _wait_for_session_cookie(driver, cookie_name: str, deadline: float) -> Optional[list[dict]]:
    """Poll the driver until the session cookie appears or the deadline passes.

    Returns the full cookie jar on success, ``None`` on timeout.
    """
    while time.monotonic() < deadline:
        try:
            cookies = driver.get_cookies()
        except Exception as exc:  # noqa: BLE001 — browser may close mid-poll
            _emit('failed', f'driver-error: {exc}')
            return None
        if any(c.get('name') == cookie_name for c in cookies):
            return cookies
        time.sleep(POLL_INTERVAL)
    return None


def start_login_session(account_id: str) -> bool:
    """Drive an operator-completed login for ``social_accounts.id``.

    Returns True on success (cookies saved, status='active'), False
    otherwise.
    """
    account = _fetch_account(account_id)
    platform = account['platform']
    cookie_name = SESSION_COOKIE_BY_PLATFORM.get(platform)
    if not cookie_name:
        _emit('failed', f'unsupported-platform: {platform}')
        return False

    _emit('browser_open')
    driver = _open_driver(headless=False)
    try:
        driver.get(START_URL_BY_PLATFORM[platform])
        _emit('waiting_for_login')
        deadline = time.monotonic() + LOGIN_MAX_SECONDS
        jar = _wait_for_session_cookie(driver, cookie_name, deadline)
        if jar is None:
            _emit('failed', 'login-timeout')
            return False
        _emit('cookies_captured', f'{len(jar)} cookies')
        save_cookies(account_id, jar)
        _mark_status(
            account_id,
            'active',
            last_login_at=datetime.now(timezone.utc).isoformat(),
        )
        _emit('done')
        return True
    finally:
        try:
            driver.quit()
        except Exception:  # noqa: BLE001
            pass


def start_checkpoint_recovery(account_id: str) -> bool:
    """Reopen an existing logged-in session so the operator can clear a captcha.

    Loads the existing encrypted cookies, drops them into the browser,
    navigates to the platform's home page (where the checkpoint usually
    fires). Waits for the session cookie to be present + a sentinel
    file at ``CRM_CHECKPOINT_DONE_FILE`` (or until login timeout).
    """
    account = _fetch_account(account_id)
    platform = account['platform']
    if not account.get('encrypted_cookies'):
        _emit('failed', 'no-cookies-on-file')
        return False

    from tools.scraper.shared.session_store import load_cookies

    jar = load_cookies(account_id)
    if not jar:
        _emit('failed', 'cookie-decrypt-empty')
        return False

    _emit('browser_open')
    driver = _open_driver(headless=False)
    try:
        # Visit the root first so cookie injection is accepted.
        root = START_URL_BY_PLATFORM[platform].rsplit('/login', 1)[0]
        driver.get(root)
        _load_jar_into_driver(driver, jar)
        driver.get(root)  # re-navigate so the injected cookies stick

        _emit('waiting_for_checkpoint_clear')
        deadline = time.monotonic() + LOGIN_MAX_SECONDS
        cookie_name = SESSION_COOKIE_BY_PLATFORM[platform]
        fresh_jar = _wait_for_session_cookie(driver, cookie_name, deadline)
        if fresh_jar is None:
            _emit('failed', 'checkpoint-timeout')
            return False
        save_cookies(account_id, fresh_jar)
        _mark_status(
            account_id,
            'active',
            last_checkpoint_at=datetime.now(timezone.utc).isoformat(),
            checkpoint_reason=None,
        )
        _emit('done')
        return True
    finally:
        try:
            driver.quit()
        except Exception:  # noqa: BLE001
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description='Drive a social_accounts login or recovery session.')
    parser.add_argument('--account-id', required=True)
    parser.add_argument('--recover', action='store_true', help='Run checkpoint-recovery instead of fresh login.')
    args = parser.parse_args()

    fn = start_checkpoint_recovery if args.recover else start_login_session
    ok = fn(args.account_id)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
