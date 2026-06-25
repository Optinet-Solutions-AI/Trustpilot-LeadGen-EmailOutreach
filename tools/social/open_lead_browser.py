"""Local operator tool — open a Facebook lead's post as the assigned account.

Launches a real Chrome window (headful, persistent profile), auto-fills stored
credentials, waits for the operator to solve any captcha, then navigates to
the lead's scraped Facebook post and leaves the browser OPEN.

WHY LOCAL-ONLY: FB's risk engine rejects EC2/datacenter sessions even with
valid credentials (documented in tools/scraper/local_fb_login.py). Running
on the operator's Windows machine + home IP + Brave is the only reliable path.

USAGE EXAMPLES:

  # Immediate smoke-test — no DB, no migration needed:
  .venv/Scripts/python.exe -m tools.social.open_lead_browser \\
      --url "https://www.facebook.com/groups/12345/posts/67890" \\
      --username "yourfb@email.com" --password "yourpassword"

  # Load account from DB by account UUID (needs CRM_ACCOUNT_ENCRYPTION_KEY):
  .venv/Scripts/python.exe -m tools.social.open_lead_browser \\
      --url "https://www.facebook.com/groups/12345/posts/67890" \\
      --account-id "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

  # Fully automatic — resolve everything from lead UUID:
  .venv/Scripts/python.exe -m tools.social.open_lead_browser \\
      --lead-id "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional, Tuple

# ── Constants ────────────────────────────────────────────────────────────────

# Chrome first — the operator uses Brave personally, so this automation runs in
# Chrome to stay out of their personal browser. Brave is kept as a fallback.
# Override either with the BROWSER_BIN env var.
BROWSER_CANDIDATES_WIN = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.join(
        os.environ.get("LOCALAPPDATA", ""),
        "Google", "Chrome", "Application", "chrome.exe",
    ),
    # Brave fallback
    os.path.join(
        os.environ.get("LOCALAPPDATA", ""),
        "BraveSoftware", "Brave-Browser", "Application", "brave.exe",
    ),
    r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
]

FB_URL = "https://www.facebook.com/"
POLL_INTERVAL_S = 2
POLL_TIMEOUT_S = 180  # 3 minutes for operator to solve captcha


# ── Browser binary probe (Chrome preferred, Brave fallback) ──────────────────

def _find_browser() -> str:
    """Return path to the automation browser (Chrome preferred, Brave fallback)."""
    override = os.environ.get("BROWSER_BIN")
    if override and os.path.isfile(override):
        return override
    for candidate in BROWSER_CANDIDATES_WIN:
        if candidate and os.path.isfile(candidate):
            return candidate
    raise FileNotFoundError(
        "No Chrome or Brave install found. Install Chrome from "
        "https://www.google.com/chrome or set the BROWSER_BIN env var."
    )


# ── Login-state detection (pure helpers — unit-testable) ────────────────────

def _page_is_logged_in(driver) -> bool:
    """Return True if the driver's current page looks like a logged-in FB session.

    Two signals:
    1. c_user cookie is present (FB sets it only for logged-in sessions).
    2. The login form fields (email + pass) are absent from the DOM.

    Either is sufficient; both together are conclusive.
    """
    try:
        c_user = driver.get_cookie("c_user")
        if c_user and c_user.get("value"):
            return True
    except Exception:  # noqa: BLE001
        pass
    # Fall back to DOM: if there's no email or password login input visible,
    # assume we're logged in (covers FB's various login-page layouts).
    try:
        email_field = driver.find_elements("css selector", "input[name='email']")
        pass_field = driver.find_elements("css selector", "input[name='pass']")
        if not email_field and not pass_field:
            return True
    except Exception:  # noqa: BLE001
        pass
    return False


def _url_is_login_or_checkpoint(url: str) -> bool:
    """Return True if the current URL is still a login/checkpoint page."""
    blocked = ("/login", "/checkpoint", "login.php", "checkpoint/?next")
    return any(token in url for token in blocked)


# ── DB helpers ───────────────────────────────────────────────────────────────

def _resolve_lead(lead_id: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """Query Supabase for (post_url, account_id, country) from a lead UUID.

    Returns (post_url, account_id, country). Any may be None if not found.
    """
    from tools.db.supabase_client import table  # noqa: WPS433 — lazy import

    post_url: Optional[str] = None
    account_id: Optional[str] = None
    country: Optional[str] = None

    # 1. Most-recent facebook post URL for this lead.
    try:
        resp = (
            table("lead_platform_posts")
            .select("post_url")
            .eq("lead_id", lead_id)
            .eq("platform", "facebook")
            .order("scraped_at", desc=True)
            .limit(1)
            .execute()
        )
        if resp.data:
            post_url = resp.data[0].get("post_url")
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: could not query lead_platform_posts: {exc}", file=sys.stderr)

    # 2. Facebook presence — get social_account_id and lead's country.
    try:
        resp = (
            table("lead_platform_presences")
            .select("social_account_id")
            .eq("lead_id", lead_id)
            .eq("platform", "facebook")
            .limit(1)
            .execute()
        )
        if resp.data:
            account_id = resp.data[0].get("social_account_id")
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: could not query lead_platform_presences: {exc}", file=sys.stderr)

    # 3. Lead's country (for fallback account resolution).
    try:
        resp = (
            table("leads")
            .select("country")
            .eq("id", lead_id)
            .limit(1)
            .execute()
        )
        if resp.data:
            country = resp.data[0].get("country")
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: could not query leads: {exc}", file=sys.stderr)

    return post_url, account_id, country


def _resolve_account_id_by_country(country: str) -> Optional[str]:
    """Return the active facebook account pinned to `country`, or None."""
    from tools.db.supabase_client import table  # noqa: WPS433

    try:
        resp = (
            table("social_accounts")
            .select("id")
            .eq("platform", "facebook")
            .eq("status", "active")
            .eq("country", country)
            .limit(1)
            .execute()
        )
        if resp.data:
            return resp.data[0]["id"]
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: country-fallback account query failed: {exc}", file=sys.stderr)
    return None


def _load_creds_from_account(account_id: str) -> Tuple[Optional[str], Optional[str]]:
    """Fetch and decrypt FB username + password from social_accounts.

    Returns (username, password). Either may be None:
    - Row not found → (None, None)
    - Columns don't exist yet (Task 2 adds them) → (None, None), with WARN
    - Decrypt failure → (None, None), with WARN

    The caller falls back to manual login when (None, None) is returned.
    """
    from tools.db.supabase_client import table  # noqa: WPS433

    try:
        resp = (
            table("social_accounts")
            .select("encrypted_fb_username,encrypted_fb_password")
            .eq("id", account_id)
            .limit(1)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: could not fetch social_accounts row: {exc}", file=sys.stderr)
        return None, None

    if not resp.data:
        print(f"WARN: social_accounts row not found for id={account_id}", file=sys.stderr)
        return None, None

    row = resp.data[0]

    # Columns may not exist yet (Task 2 migration pending).
    enc_username = row.get("encrypted_fb_username")
    enc_password = row.get("encrypted_fb_password")

    if not enc_username or not enc_password:
        print(
            "WARN: encrypted_fb_username / encrypted_fb_password not set on this account. "
            "Use --username/--password args for now, or store creds via the Social Accounts UI.",
            file=sys.stderr,
        )
        return None, None

    try:
        from tools.scraper.shared.encryption import decrypt_cookie  # noqa: WPS433
        username = decrypt_cookie(enc_username)
        password = decrypt_cookie(enc_password)
        return username, password
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: credential decryption failed: {exc}", file=sys.stderr)
        return None, None


# ── Selenium / Brave driver ───────────────────────────────────────────────────

def _open_brave_driver(profile_dir: str):
    """Open a Selenium WebDriver pointed at Brave with a persistent profile.

    We use undetected-chromedriver (same as uc_driver.py) because it patches
    the navigator.webdriver property and other automation tells that FB's risk
    engine reads. The persistent profile (--user-data-dir) keeps the session
    alive between runs — after the first captcha the operator usually skips
    straight to the post.

    NOTE: We intentionally do NOT route through the residential proxy here.
    This tool runs on the operator's Windows machine with a home IP, which is
    exactly what we want — no proxy needed, and the proxy wiring (selenium-wire)
    only kicks in on Linux anyway (see uc_driver.py:open_uc_driver).
    """
    import undetected_chromedriver as uc  # noqa: WPS433 — lazy

    browser_bin = _find_browser()
    print(f"INFO: using browser binary: {browser_bin}", file=sys.stderr)
    print(f"INFO: persistent profile: {profile_dir}", file=sys.stderr)

    # Clean up stale singleton lock files from a prior crashed session.
    for stale in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        stale_path = os.path.join(profile_dir, stale)
        try:
            os.remove(stale_path)
            print(f"INFO: removed stale {stale}", file=sys.stderr)
        except FileNotFoundError:
            pass
        except OSError as exc:
            print(f"WARN: could not remove {stale_path}: {exc}", file=sys.stderr)

    options = uc.ChromeOptions()
    options.binary_location = browser_bin
    # Always headful — this tool is for operator interaction.
    options.add_argument(f"--user-data-dir={profile_dir}")
    options.add_argument("--window-size=1280,900")
    options.add_argument("--lang=en-US,en")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    options.add_argument("--disable-blink-features=AutomationControlled")

    # Try to pin chromedriver to the installed Chrome/Brave major version.
    version_main: Optional[int] = None
    override = os.getenv("SOCIAL_CHROME_VERSION")
    if override and override.isdigit():
        version_main = int(override)
    else:
        # Re-use the version detector from uc_driver.py.
        try:
            from tools.scraper.shared.uc_driver import _detect_chrome_major_version  # noqa: WPS433
            version_main = _detect_chrome_major_version()
        except Exception:  # noqa: BLE001
            pass
    if version_main:
        print(f"INFO: pinning chromedriver to major version {version_main}", file=sys.stderr)

    driver = uc.Chrome(
        options=options,
        use_subprocess=True,
        version_main=version_main,
    )
    driver.set_page_load_timeout(30)
    return driver


# ── Login flow ───────────────────────────────────────────────────────────────

def _do_login(driver, username: str, password: str) -> bool:
    """Type credentials into the FB login form and click Log In.

    Returns True if the form was found and submitted, False if login fields
    were not present (already logged in or unexpected page state).
    """
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC

    try:
        # Wait up to 10s for the email field to appear.
        wait = WebDriverWait(driver, 10)
        email_field = wait.until(EC.presence_of_element_located((By.NAME, "email")))
        pass_field = driver.find_element(By.NAME, "pass")
        login_btn = driver.find_element(By.NAME, "login")
    except Exception:  # noqa: BLE001
        # Fields not found — probably already logged in.
        return False

    print("INFO: filling login form…", file=sys.stderr)
    email_field.clear()
    email_field.send_keys(username)
    time.sleep(0.3)
    pass_field.clear()
    pass_field.send_keys(password)
    time.sleep(0.3)
    login_btn.click()
    return True


def _wait_for_login(driver) -> bool:
    """Poll until the operator clears any captcha/checkpoint or times out.

    Returns True if logged in within POLL_TIMEOUT_S seconds, False otherwise.
    """
    print(
        "NOTICE: ──────────────────────────────────────────────────────────────",
        file=sys.stderr,
    )
    print(
        "NOTICE: FB login submitted. If a captcha or security check appears,",
        file=sys.stderr,
    )
    print(
        "NOTICE: solve it in the Chrome window. This script will continue",
        file=sys.stderr,
    )
    print(
        "NOTICE: automatically once you're past it (up to 3 minutes).",
        file=sys.stderr,
    )
    print(
        "NOTICE: ──────────────────────────────────────────────────────────────",
        file=sys.stderr,
    )

    deadline = time.time() + POLL_TIMEOUT_S
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL_S)
        try:
            current_url = driver.current_url
        except Exception:  # noqa: BLE001
            # Driver gone (operator closed the window).
            return False

        if not _url_is_login_or_checkpoint(current_url) and _page_is_logged_in(driver):
            print("INFO: login confirmed.", file=sys.stderr)
            return True

    print(
        "WARN: timed out waiting for login. The browser will stay open — "
        "continue in the window manually.",
        file=sys.stderr,
    )
    return False


# ── Main ─────────────────────────────────────────────────────────────────────

def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Open a Facebook lead's post in Brave, logged in as the assigned account.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    # Mutually supportive arg groups — at least one of these must resolve to a URL.
    parser.add_argument("--lead-id", metavar="UUID",
                        help="Lead UUID — resolves post URL and account from Supabase.")
    parser.add_argument("--url", metavar="POST_URL",
                        help="Direct Facebook post URL (skips DB resolution).")
    parser.add_argument("--account-id", metavar="UUID",
                        help="Social account UUID — loads + decrypts creds from social_accounts.")
    parser.add_argument("--username", metavar="EMAIL",
                        help="FB login email (plaintext, for immediate smoke-test).")
    parser.add_argument("--password", metavar="PASS",
                        help="FB password (plaintext, for immediate smoke-test).")
    parser.add_argument("--profile-dir", metavar="PATH",
                        help="Override persistent profile dir (default: ~/.scraper-profiles/fb-<accountId>).")
    args = parser.parse_args(argv)

    # ── 1. Resolve URL and account ──────────────────────────────────────────
    post_url: Optional[str] = args.url
    account_id: Optional[str] = args.account_id
    username: Optional[str] = args.username
    password: Optional[str] = args.password

    if args.lead_id:
        print(f"INFO: resolving lead {args.lead_id} from Supabase…", file=sys.stderr)
        resolved_url, resolved_account_id, lead_country = _resolve_lead(args.lead_id)

        if resolved_url and not post_url:
            post_url = resolved_url
            print(f"INFO: resolved post URL: {post_url}", file=sys.stderr)
        elif not post_url:
            print(
                "WARN: no Facebook post URL found for this lead. "
                "Navigating to facebook.com instead.",
                file=sys.stderr,
            )

        # Account: presence's account > country-fallback > nothing
        if resolved_account_id and not account_id:
            # Verify the resolved account is active.
            from tools.db.supabase_client import table  # noqa: WPS433
            try:
                resp = (
                    table("social_accounts")
                    .select("id,status")
                    .eq("id", resolved_account_id)
                    .limit(1)
                    .execute()
                )
                row = resp.data[0] if resp.data else None
                if row and row.get("status") == "active":
                    account_id = resolved_account_id
                    print(f"INFO: using presence-assigned account {account_id}", file=sys.stderr)
                else:
                    print(
                        f"WARN: presence-assigned account {resolved_account_id} is not active "
                        f"(status={row.get('status') if row else 'not found'}); "
                        "falling back to country match.",
                        file=sys.stderr,
                    )
            except Exception as exc:  # noqa: BLE001
                print(f"WARN: account status check failed: {exc}", file=sys.stderr)

        if not account_id and lead_country:
            print(
                f"INFO: looking for active facebook account for country={lead_country}…",
                file=sys.stderr,
            )
            account_id = _resolve_account_id_by_country(lead_country)
            if account_id:
                print(f"INFO: found country-fallback account {account_id}", file=sys.stderr)
            else:
                print(
                    f"WARN: no active facebook account found for country={lead_country}.",
                    file=sys.stderr,
                )

    # ── 2. Load credentials if we have an account ID ────────────────────────
    if account_id and not (username and password):
        print(f"INFO: loading credentials for account {account_id}…", file=sys.stderr)
        loaded_user, loaded_pass = _load_creds_from_account(account_id)
        if loaded_user and loaded_pass:
            username, password = loaded_user, loaded_pass
        # If None, we'll fall through to manual login — already warned inside helper.

    if not username or not password:
        print(
            "INFO: no credentials available — Chrome will open Facebook and you can log in manually.",
            file=sys.stderr,
        )

    # ── 3. Determine profile directory ──────────────────────────────────────
    if args.profile_dir:
        profile_dir = args.profile_dir
    elif account_id:
        profile_dir = str(Path.home() / ".scraper-profiles" / f"fb-{account_id}")
    else:
        profile_dir = str(Path.home() / ".scraper-profiles" / "fb-default")

    Path(profile_dir).mkdir(parents=True, exist_ok=True)

    # ── 4. Launch Brave + Selenium ───────────────────────────────────────────
    target_url = post_url or FB_URL
    print(f"INFO: launching Chrome (profile: {profile_dir})", file=sys.stderr)

    driver = _open_brave_driver(profile_dir)

    try:
        # Go to FB homepage to check login state.
        print("INFO: navigating to facebook.com…", file=sys.stderr)
        driver.get(FB_URL)
        time.sleep(2)  # Let the page settle before checking cookies.

        already_logged_in = _page_is_logged_in(driver)

        if already_logged_in:
            print("INFO: already logged in (session from profile).", file=sys.stderr)
        elif username and password:
            submitted = _do_login(driver, username, password)
            if submitted:
                # Poll for captcha / checkpoint clearance.
                _wait_for_login(driver)
            else:
                print(
                    "INFO: login form not found (possibly already logged in or unexpected page).",
                    file=sys.stderr,
                )
        else:
            print(
                "INFO: not logged in and no credentials provided. "
                "Log in manually in the Chrome window.",
                file=sys.stderr,
            )

        # ── 5. Navigate to the post ──────────────────────────────────────────
        if target_url != FB_URL:
            print(f"INFO: navigating to post URL: {target_url}", file=sys.stderr)
            driver.get(target_url)
        else:
            print(
                "INFO: no post URL — staying on facebook.com homepage.",
                file=sys.stderr,
            )

        # ── 6. Emit result JSON and block until window closes ────────────────
        result = {
            "opened": True,
            "account_id": account_id,
            "url": target_url,
        }
        print(json.dumps(result))  # stdout — the machine-readable signal

        print(
            "INFO: browser is open. Close the Chrome window when you are done.",
            file=sys.stderr,
        )

        # Block until the browser window closes (same approach as local_fb_login.py).
        while True:
            try:
                # Accessing window_handles raises if the driver session ended.
                _ = driver.window_handles
                time.sleep(2)
            except Exception:  # noqa: BLE001
                break

    finally:
        # Attempt graceful quit — silently ignore if already gone.
        try:
            driver.quit()
        except Exception:  # noqa: BLE001
            pass

    print("INFO: browser closed. Session saved to profile.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
