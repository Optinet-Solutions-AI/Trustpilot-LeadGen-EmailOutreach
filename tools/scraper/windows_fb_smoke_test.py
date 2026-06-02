"""Windows EC2 FB smoke test (Phase 1, 2026-06-02).

Mirrors tools/scraper/local_fb_smoke_test.py but takes a social_account_id
argument and reads the profile from C:\\fb-profiles\\<account_id>\\. Runs
three configs to validate the EC2 box can scrape FB:

  1. headless, direct (no proxy)              — baseline
  2. headed, Enigma PH proxy                  — proxy works
  3. headless, Enigma PH proxy                — what the worker daemon will do

PASS = all three return the authenticated FB homepage (title contains
"Facebook" + body shows feed sidebar) without redirecting to /login/.

USAGE:
    .venv\\Scripts\\python.exe -m tools.scraper.windows_fb_smoke_test <account_id>

The Enigma proxy creds are read from environment vars matching the
worker's `.env` convention (RESIDENTIAL_PROXY_HOST, _PORT, _USERNAME,
_PASSWORD). If unset, falls back to the constants below (Enigma PH —
the proxy we've been using since 2026-06-01).
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional


PROFILE_ROOT = Path(r"C:\fb-profiles")


def _find_brave() -> str:
    """Chocolatey on Windows Server may install Brave under %LOCALAPPDATA%
    rather than Program Files. Probe the usual locations."""
    import os
    import shutil
    candidates = [
        r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
        r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        os.path.join(str(Path.home()), "AppData", "Local", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    on_path = shutil.which("brave")
    if on_path:
        return on_path
    return candidates[0]  # default for error message


BRAVE_BIN = _find_brave()

PROXY_HOST = os.environ.get("RESIDENTIAL_PROXY_HOST", "resi.enigmaproxy.net")
PROXY_PORT = os.environ.get("RESIDENTIAL_PROXY_PORT", "12321")
PROXY_USER = os.environ.get("RESIDENTIAL_PROXY_USERNAME", "0048277fc210")
PROXY_PASS = os.environ.get("RESIDENTIAL_PROXY_PASSWORD", "58fc5cbc0ebf_country-PH")

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def run(config_name: str, profile_dir: Path, headless: bool, use_proxy: bool) -> str:
    import undetected_chromedriver as uc  # noqa: WPS433

    print(f"\n=== {config_name} ===", file=sys.stderr)
    options = uc.ChromeOptions()
    if headless:
        options.add_argument("--headless=new")
    options.add_argument(f"--user-data-dir={profile_dir}")
    options.add_argument("--window-size=1280,900")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    options.binary_location = BRAVE_BIN

    seleniumwire_options: Optional[dict] = None
    if use_proxy:
        proxy_url = f"http://{PROXY_USER}:{PROXY_PASS}@{PROXY_HOST}:{PROXY_PORT}"
        seleniumwire_options = {
            "proxy": {
                "http": proxy_url,
                "https": proxy_url,
                "no_proxy": "localhost,127.0.0.1",
            },
            "verify_ssl": False,
            "disable_capture": True,
        }
        options.add_argument("--ignore-certificate-errors")

    driver = None
    try:
        if seleniumwire_options:
            from seleniumwire.undetected_chromedriver import Chrome as WireUCChrome
            driver = WireUCChrome(
                options=options,
                seleniumwire_options=seleniumwire_options,
                use_subprocess=True,
                version_main=148,
            )
        else:
            driver = uc.Chrome(options=options, use_subprocess=True, version_main=148)

        driver.set_page_load_timeout(60)
        driver.get("https://www.facebook.com/")
        time.sleep(7)
        url = driver.current_url
        title = driver.title
        body = driver.find_element("tag name", "body").text[:500]
        login_form_visible = (
            "/login" in url
            or "Log into Facebook" in body
            or ("Log in" in body and "Email or mobile number" in body)
        )
        feed_visible = any(t in body for t in (
            "What's on your mind",
            "Friends",
            "Memories",
            "Saved",
            "Groups",
            "Marketplace",
        ))
        verdict = "PASS" if feed_visible and not login_form_visible else "FAIL"
        return (
            f"[{verdict}] {config_name}\n"
            f"  url={url}\n"
            f"  title={title!r}\n"
            f"  body[:200]={body[:200]!r}"
        )
    except Exception as exc:  # noqa: BLE001
        return f"[ERROR] {config_name}: {exc}"
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:  # noqa: BLE001
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("account_id", help="social_accounts.id UUID — profile dir is C:\\fb-profiles\\<account_id>\\")
    args = parser.parse_args()

    if not UUID_RE.match(args.account_id):
        print(f"ERROR: account_id must be a UUID, got: {args.account_id!r}", file=sys.stderr)
        return 1

    profile_dir = PROFILE_ROOT / args.account_id
    if not profile_dir.exists():
        print(f"ERROR: profile dir not found at {profile_dir}", file=sys.stderr)
        print("Run `python -m tools.scraper.windows_fb_login <account_id>` first.", file=sys.stderr)
        return 1

    print(f"INFO: profile = {profile_dir}", file=sys.stderr)
    print(f"INFO: proxy   = {PROXY_HOST}:{PROXY_PORT} (user={PROXY_USER})", file=sys.stderr)

    results = []
    results.append(run("1. headless, direct (baseline)", profile_dir, headless=True, use_proxy=False))
    results.append(run("2. headed, Enigma PH proxy", profile_dir, headless=False, use_proxy=True))
    results.append(run("3. headless, Enigma PH proxy (worker simulation)", profile_dir, headless=True, use_proxy=True))

    print("\n\n========== SUMMARY ==========\n")
    for r in results:
        print(r)
        print()

    all_pass = all(r.startswith("[PASS]") for r in results)
    return 0 if all_pass else 3


if __name__ == "__main__":
    sys.exit(main())
