"""Operator login for Instagram (Playwright, Windows-safe).

Opens a HEADED Instagram login page routed through the residential proxy
(country-pinned, native Playwright proxy auth). This exists because the older
`login_flows.start_login_session` path uses uc_driver + selenium-wire, which
crashes on the Windows fleet box on heavy-auth pages — the same reason the IG
scraper itself moved to Playwright (see tools/scraper/platforms/instagram.py).

The operator logs in (and clears any 2FA / "was this you?" checkpoint) in the
window. Once Instagram issues a `sessionid`, the cookie jar is encrypted into
`social_accounts.encrypted_cookies`, the row is flipped to `active`, and its
daily/hourly usage counters are reset so the next scrape can claim it.

Run it in the INTERACTIVE RDP session on the fleet box — NOT via the worker
service (a Windows service runs in session 0 and can't show a window):

    cd C:\\scraper
    git pull
    .venv\\Scripts\\python.exe -m tools.scraper.local_ig_login ^
        --account-id 583899a2-73b6-4389-b33d-cc2a5fee7302 --country GB

Defaults target the james@optiratesolutions.net Instagram row, exit GB.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime, timezone


def _load_dotenv_if_present() -> None:
    """Populate os.environ from the repo-root .env (residential-proxy creds
    live there). Mirrors tools/scraper/run.py so an interactive shell that
    didn't inherit the worker-service environment still gets the proxy vars.
    Does not clobber values already set in the shell."""
    env_path = os.path.join(os.path.dirname(__file__), '..', '..', '.env')
    if not os.path.isfile(env_path):
        return
    try:
        with open(env_path, 'r', encoding='utf-8') as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except OSError:
        pass


LOGIN_URL = 'https://www.instagram.com/accounts/login/'
SESSION_COOKIE = 'sessionid'
# james@optiratesolutions.net Instagram row (currently disabled). Override with
# --account-id to bind the login to a different social_accounts row.
DEFAULT_ACCOUNT = '583899a2-73b6-4389-b33d-cc2a5fee7302'


def _has_session(cookies) -> bool:
    return any(c.get('name') == SESSION_COOKIE and c.get('value') for c in cookies)


def main() -> int:
    _load_dotenv_if_present()
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')

    ap = argparse.ArgumentParser(
        description='Headed Instagram login -> encrypt cookies into social_accounts + mark active.')
    ap.add_argument('--account-id', default=DEFAULT_ACCOUNT,
                    help='social_accounts.id to bind the login to (default: james@ IG row).')
    ap.add_argument('--country', default='GB',
                    help='Residential-proxy exit country (ISO-2). Instagram sees this IP; keep it '
                         'consistent with where the account is warmed. Default GB.')
    ap.add_argument('--timeout', type=int, default=420,
                    help='Seconds to wait for the login to complete (default 420).')
    args = ap.parse_args()

    # Reuse the scraper's proxy builder so the login IP matches what the scraper
    # will use later (same host/user, country-pinned password tag).
    try:
        from tools.scraper.platforms.instagram import _proxy_for_country
    except Exception as exc:  # noqa: BLE001
        print(f'ERROR: could not import the IG proxy builder: {exc}', file=sys.stderr)
        return 1
    try:
        proxy = _proxy_for_country(args.country)
    except KeyError as exc:
        print(f'ERROR: residential proxy env var missing: {exc}. '
              f'Set RESIDENTIAL_PROXY_HOST/PORT/USERNAME/PASSWORD (or run from C:\\scraper so .env loads).',
              file=sys.stderr)
        return 1

    from tools.scraper.shared.session_store import save_cookies
    from tools.db.supabase_client import table

    print(f'Opening Instagram login through the {args.country.upper()} residential proxy...', flush=True)
    from playwright.sync_api import sync_playwright
    pw = sync_playwright().start()
    browser = pw.chromium.launch(headless=False, proxy=proxy)
    # Desktop context: easiest for a human to log in + clear 2FA. The sessionid
    # cookie works regardless of the mobile UA the scraper reads it back with.
    context = browser.new_context()
    page = context.new_page()
    page.set_default_timeout(60000)
    try:
        page.goto(LOGIN_URL, wait_until='domcontentloaded')
    except Exception as exc:  # noqa: BLE001
        print(f'WARN: initial navigation hiccup ({str(exc)[:80]}) - the window is open, log in there.',
              file=sys.stderr)

    print('\n>>> Log in to Instagram in the window that just opened.', flush=True)
    print('    Dismiss the cookie banner, enter the credentials, and clear any 2FA /', flush=True)
    print('    "was this you?" prompt so you land on the real feed.', flush=True)
    print(f'    Waiting up to {args.timeout}s for the session...\n', flush=True)

    deadline = time.time() + args.timeout
    got = False
    while time.time() < deadline:
        try:
            if _has_session(context.cookies()):
                got = True
                break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(3)

    if not got:
        print('ERROR: no Instagram session detected before the timeout - nothing saved. '
              'Re-run and finish logging in.', file=sys.stderr)
        try:
            browser.close(); pw.stop()
        except Exception:  # noqa: BLE001
            pass
        return 1

    jar = context.cookies()
    save_cookies(args.account_id, jar)
    now_iso = datetime.now(timezone.utc).isoformat()
    table('social_accounts').update({
        'status': 'active',
        'country': args.country.upper(),
        'used_today': 0,
        'used_this_hour': 0,
        'last_used_at': None,
        'last_login_at': now_iso,
        'last_checkpoint_at': None,
        'checkpoint_reason': None,
    }).eq('id', args.account_id).execute()

    print(f'\nSUCCESS: saved {len(jar)} cookies. Account {args.account_id[:8]}... is now ACTIVE '
          f'(country={args.country.upper()}), usage counters reset.', flush=True)
    print('Close the window - the next Instagram scrape can claim this account.', flush=True)
    try:
        browser.close(); pw.stop()
    except Exception:  # noqa: BLE001
        pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
