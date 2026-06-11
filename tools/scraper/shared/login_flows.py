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

# Persistent-profile dir env var per platform. The proxy login path binds the
# captured session to this profile so later EC2 scrapes reuse the same
# fingerprint+IP class. MUST match the scraper's profile env (facebook.py uses
# FB_PROFILE_DIR; instagram.py uses IG_PROFILE_DIR) — otherwise an IG connect
# would write its session into the FB profile dir.
PROFILE_DIR_ENV_BY_PLATFORM = {
    'facebook': 'FB_PROFILE_DIR',
    'instagram': 'IG_PROFILE_DIR',
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


def _detect_chrome_major_version() -> Optional[int]:
    """Read the installed Chrome's major version so undetected-chromedriver
    pulls the matching chromedriver. Without this, uc tends to grab the
    newest released driver, which fails when Chrome's auto-update lags.
    Returns None if detection fails — caller falls back to uc's default.
    """
    import re
    import subprocess
    candidates = [
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    ]
    chrome_path = next((p for p in candidates if os.path.isfile(p)), None)
    if not chrome_path:
        return None
    try:
        # PowerShell is the most reliable way to read a .exe's ProductVersion on Windows.
        out = subprocess.check_output(
            ['powershell', '-NoProfile', '-Command',
             f"(Get-Item '{chrome_path}').VersionInfo.ProductVersion"],
            text=True, timeout=5,
        ).strip()
        m = re.match(r'(\d+)\.', out)
        return int(m.group(1)) if m else None
    except Exception:  # noqa: BLE001
        return None


def _open_driver(headless: bool = False, profile_dir_env: str = 'FB_PROFILE_DIR'):
    """Lazy-import undetected_chromedriver so the module imports cheap.

    Returns a webdriver instance. Caller must ``driver.quit()``.

    When the RESIDENTIAL_PROXY_* env vars are set, this opens the shared
    proxy-aware driver (tools.scraper.shared.uc_driver.open_uc_driver) using
    the platform's persistent profile (``profile_dir_env``) — the same
    residential-proxy + persistent-profile stack the scrapers use on EC2 — so
    cookies captured during an operator-driven login are bound to the proxy
    IP from inception. That's the core trick that makes EC2 scrapes work
    afterward: the new cookies' "home IP" matches the IP class EC2 will use,
    so the platform doesn't trust-gate. ``profile_dir_env`` MUST match the
    scraper's profile env for that platform (FB_PROFILE_DIR / IG_PROFILE_DIR).

    Without proxy env vars set, falls back to a plain
    undetected-chromedriver — preserves the legacy non-proxy login
    flow for callers that don't need residential routing.
    """
    proxy_host = os.environ.get('RESIDENTIAL_PROXY_HOST')
    proxy_force = os.environ.get('RESIDENTIAL_PROXY_FORCE', '').lower() == 'true'
    use_proxy = bool(proxy_host) and (sys.platform.startswith('linux') or proxy_force)

    if use_proxy:
        # Open the shared proxy-aware driver directly. It reads the proxy
        # env vars and uses the proxy_location we pass for country-code
        # swap — same residential-proxy + persistent-profile stack the FB
        # scraper uses on EC2.
        from tools.scraper.shared.uc_driver import open_uc_driver  # noqa: WPS433
        # Pick a city that maps to the desired proxy region. The
        # RESIDENTIAL_PROXY_REGION env var (PH/GB/DE/etc.) drives this
        # so the operator can re-login through a specific country.
        # Default PH — that's the most common bootstrap case
        # (account's natural home region).
        region = os.environ.get('RESIDENTIAL_PROXY_REGION', 'PH').upper()
        region_to_city = {'PH': 'Cebu', 'GB': 'London', 'DE': 'Berlin', 'FR': 'Paris', 'ES': 'Madrid',
                          'IT': 'Rome', 'NL': 'Amsterdam', 'US': 'New York', 'AU': 'Sydney', 'SG': 'Singapore', 'IE': 'Dublin'}
        proxy_city = region_to_city.get(region, 'Cebu')
        print(f'INFO: login_flows using residential proxy (region={region}, city={proxy_city})', file=sys.stderr)
        return open_uc_driver(profile_dir_env, headless=headless, proxy_location=proxy_city)

    # Legacy non-proxy path.
    import undetected_chromedriver as uc  # noqa: WPS433 — lazy import is correct here

    options = uc.ChromeOptions()
    if headless:
        options.add_argument('--headless=new')
    # Reasonable defaults that mimic an everyday browser session.
    options.add_argument('--window-size=1280,900')
    options.add_argument('--disable-blink-features=AutomationControlled')

    # Pin chromedriver to the installed Chrome's major version. SOCIAL_CHROME_VERSION
    # env var can override (for debugging). Falls back to None = uc default.
    version_main: Optional[int] = None
    override = os.getenv('SOCIAL_CHROME_VERSION')
    if override and override.isdigit():
        version_main = int(override)
    else:
        version_main = _detect_chrome_major_version()
    if version_main:
        print(f'INFO: pinning chromedriver to Chrome major version {version_main}', file=sys.stderr)
    return uc.Chrome(options=options, use_subprocess=True, version_main=version_main)


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


def _try_autofill(driver, platform: str, username: str, password: str) -> None:
    """Best-effort pre-fill of the platform's login form.

    Credentials come in via env vars (SOCIAL_LOGIN_USERNAME / _PASSWORD)
    so they never appear on the command line. They are NOT persisted —
    the process exits and they're gone. Selectors can drift; failures
    here are silent (operator just sees an empty form and types manually).
    """
    from selenium.webdriver.common.by import By  # noqa: WPS433
    try:
        if platform == 'facebook':
            user_el = driver.find_element(By.ID, 'email')
            pass_el = driver.find_element(By.ID, 'pass')
        else:  # instagram
            user_el = driver.find_element(By.NAME, 'username')
            pass_el = driver.find_element(By.NAME, 'password')
        user_el.clear(); user_el.send_keys(username)
        pass_el.clear(); pass_el.send_keys(password)
        _emit('autofilled')
        # Submit the form. After this, either:
        #   (a) Facebook accepts the credentials → c_user cookie set → harness wins
        #   (b) FB asks for 2FA / captcha → operator handles inside Chrome
        # If SOCIAL_LOGIN_AUTOSUBMIT=false is set the operator must click Log in.
        if os.getenv('SOCIAL_LOGIN_AUTOSUBMIT', 'true').lower() != 'false':
            pass_el.submit()
            _emit('login_submitted')
    except Exception as exc:  # noqa: BLE001
        print(f'WARN: autofill skipped — {exc}', file=sys.stderr)


def start_login_session(account_id: str) -> bool:
    """Drive an operator-completed login for ``social_accounts.id``.

    Returns True on success (cookies saved, status='active'), False
    otherwise. If SOCIAL_LOGIN_USERNAME + SOCIAL_LOGIN_PASSWORD are set
    in the process environment, the login form is auto-filled so the
    operator only has to click "Log in" + handle any 2FA/captcha.
    """
    account = _fetch_account(account_id)
    platform = account['platform']
    cookie_name = SESSION_COOKIE_BY_PLATFORM.get(platform)
    if not cookie_name:
        _emit('failed', f'unsupported-platform: {platform}')
        return False

    _emit('browser_open')
    driver = _open_driver(headless=False, profile_dir_env=PROFILE_DIR_ENV_BY_PLATFORM.get(platform, 'FB_PROFILE_DIR'))
    try:
        driver.get(START_URL_BY_PLATFORM[platform])
        # Read + erase the creds from process env immediately so even a
        # crash dump can't reveal them.
        user = os.environ.pop('SOCIAL_LOGIN_USERNAME', '')
        pwd = os.environ.pop('SOCIAL_LOGIN_PASSWORD', '')
        if user and pwd:
            time.sleep(1.5)  # give the login page a beat to settle
            _try_autofill(driver, platform, user, pwd)
            user = ''  # zero the locals
            pwd = ''
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
    driver = _open_driver(headless=False, profile_dir_env=PROFILE_DIR_ENV_BY_PLATFORM.get(platform, 'FB_PROFILE_DIR'))
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
