"""One-command AdsPower Local API probe.

WHY THIS EXISTS

  Three questions about AdsPower were open and could only be answered against
  a real install:

    1. Is the Local API available on the FREE plan? AdsPower's own docs say
       "purchased the paid version ... are granted permission to use the API",
       but 2026 third-party reviews say the free tier includes it. Only a live
       call settles it.
    2. What is the REAL response shape? tools/scraper/shared/adspower.py was
       written against their published examples and assumes
       data.ws.selenium / data.webdriver / code == 0. If those names are
       wrong, start_profile() breaks the moment it is used for real.
    3. Which port? The API is documented on 50325, but the actual address is
       written to a file and is not guaranteed. This resolves it.

  Run this after installing the AdsPower DESKTOP CLIENT (the web app at
  app.adspower.com cannot serve a localhost API).

USAGE

    # Safe: resolves the port, checks the service, lists your profiles.
    .venv/Scripts/python.exe -m tools.scraper.adspower_probe

    # Also starts a profile and dumps the full start response. Opens a
    # real browser window. Use a THROWAWAY profile, not one holding a
    # logged-in Facebook account.
    .venv/Scripts/python.exe -m tools.scraper.adspower_probe --start <PROFILE_ID>

    # As above, then attaches Selenium and drives the browser to prove the
    # whole open_uc_driver AdsPower path works end to end.
    .venv/Scripts/python.exe -m tools.scraper.adspower_probe --start <PROFILE_ID> --attach

  Nothing here touches Facebook. --attach navigates to example.com.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional

import requests

DOCUMENTED_BASE = 'http://local.adspower.net:50325'


def resolve_base_url() -> tuple[str, str]:
    """Find the Local API base URL. Returns (base_url, how_we_found_it).

    AdsPower writes its real address to a `local_api` file. Prefer that over
    the documented default, because the port is not guaranteed to be 50325.
    """
    override = (os.environ.get('ADSPOWER_API_BASE') or '').strip()
    if override:
        return override.rstrip('/'), 'ADSPOWER_API_BASE env var'

    # AdsPower's docs say %LOCALAPPDATA% on Windows, but client 8.7.23
    # actually writes it to %APPDATA% (Roaming). Check Roaming FIRST -
    # verified 2026-07-31 on a real install. Keep the documented Local path
    # as a fallback in case other versions differ.
    candidates = [
        os.path.join(os.environ.get('APPDATA', ''), 'adspower_global', 'cwd_global', 'source', 'local_api'),
        os.path.join(os.environ.get('LOCALAPPDATA', ''), 'adspower_global', 'cwd_global', 'source', 'local_api'),
        os.path.expanduser('~/Library/Application Support/adspower_global/cwd_global/source/local_api'),
        os.path.expanduser('~/.config/adspower_global/cwd_global/source/local_api'),
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            try:
                with open(path, 'r', encoding='utf-8') as fh:
                    value = fh.read().strip()
                if value:
                    if not value.startswith('http'):
                        value = f'http://{value}'
                    return value.rstrip('/'), f'local_api file ({path})'
            except OSError:
                pass
    return DOCUMENTED_BASE, 'documented default (no local_api file found)'


def _headers() -> dict:
    """Match what tools/scraper/shared/adspower.py sends, so this probe
    validates the real auth path and not a different one."""
    key = (os.environ.get('ADSPOWER_API_KEY') or '').strip()
    return {'Authorization': f'Bearer {key}'} if key else {}


def call(base: str, path: str, params: Optional[dict] = None) -> tuple[Optional[dict], str]:
    """GET a Local API endpoint. Returns (payload_or_None, human_note)."""
    url = f'{base}{path}'
    try:
        resp = requests.get(url, params=params or {}, headers=_headers(), timeout=60)
    except requests.exceptions.RequestException as exc:
        return None, f'UNREACHABLE - {exc}'
    try:
        return resp.json(), f'HTTP {resp.status_code}'
    except ValueError:
        return None, f'HTTP {resp.status_code}, non-JSON body: {resp.text[:200]}'


def verdict_on_plan_gating(payload: Optional[dict], note: str) -> str:
    """Turn a response into a plain answer about the free-plan question."""
    if payload is None:
        return f'INCONCLUSIVE - could not reach the API ({note}). Is the desktop client running?'
    code = payload.get('code')
    msg = str(payload.get('msg') or '')
    if code == 0:
        return 'API ACCESS WORKS on this plan - no subscription needed for automation.'
    lowered = msg.lower()
    # Auth, NOT plan. Verified 2026-07-31: a free-plan install with Security
    # Verification enabled answers every endpoint with "Require api-key", and
    # answers a wrong key with "API Key mismatch". Both mean the service is
    # running and willing - it just wants credentials. Distinguishing this
    # from a genuine plan wall matters, because generating an API key IS a
    # paid feature while TURNING SECURITY VERIFICATION OFF is free.
    if 'api-key' in lowered or 'api key' in lowered:
        return (
            f'AUTH REQUIRED, not plan-gated - server said: {msg!r}. The service is '
            'running. Either turn OFF "Security Verification" in the client '
            '(Settings -> API & MCP) so no key is needed, or set ADSPOWER_API_KEY '
            'to a generated key. Note: generating a key is a PAID feature, but '
            'disabling Security Verification is not.'
        )
    if any(word in lowered for word in ('permission', 'vip', 'upgrade', 'package', 'plan', 'purchase', 'subscri')):
        return f'API IS PLAN-GATED - server said: {msg!r}. A paid plan or the 7-day trial is required.'
    return f'API reachable but returned code={code} msg={msg!r} (not a plan or auth error - likely a bad user_id or an app-state issue).'


def check_our_field_assumptions(data: dict) -> list[str]:
    """Compare a real start response against what shared/adspower.py expects."""
    results = []
    ws = data.get('ws') or {}
    selenium_addr = ws.get('selenium')
    results.append(
        f"  data.ws.selenium  -> {selenium_addr!r} "
        f"{'OK' if selenium_addr else 'MISSING - start_profile() would raise'}"
    )
    webdriver_path = data.get('webdriver')
    results.append(
        f"  data.webdriver    -> {webdriver_path!r} "
        f"{'OK' if webdriver_path else 'MISSING - Selenium would fall back to PATH chromedriver'}"
    )
    known = {'ws', 'webdriver', 'debug_port'}
    extra = sorted(set(data.keys()) - known)
    if extra:
        results.append(f'  other keys present: {extra}')
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description='Probe the AdsPower Local API.')
    parser.add_argument('--start', metavar='PROFILE_ID',
                        help='Also start this profile and dump the full response. Opens a real browser.')
    parser.add_argument('--attach', action='store_true',
                        help='With --start: attach Selenium and drive the browser to example.com.')
    parser.add_argument('--stop', action='store_true',
                        help='With --start: stop the profile again when finished.')
    args = parser.parse_args()

    base, how = resolve_base_url()
    print(f'Base URL : {base}')
    print(f'Resolved : {how}')
    print(f'Auth     : {"Bearer <ADSPOWER_API_KEY>" if os.environ.get("ADSPOWER_API_KEY") else "none (no ADSPOWER_API_KEY set)"}')
    print()

    print('== 1. Service status ==')
    payload, note = call(base, '/status')
    print(f'   {note}')
    if payload is not None:
        print(f'   {json.dumps(payload)}')
    if payload is None:
        print()
        print('   The API did not respond. Most likely causes, in order:')
        print('     a) The AdsPower DESKTOP CLIENT is not installed or not running.')
        print('        The web app at app.adspower.com cannot serve a localhost API.')
        print('     b) The port differs - check the local_api file path printed above.')
        print('     c) Local API is disabled in the client (Settings -> API).')
        return 1
    print()

    print('== 2. Profile list ==')
    payload, note = call(base, '/api/v1/user/list', {'page': 1, 'page_size': 20})
    print(f'   {note}')
    print(f'   VERDICT: {verdict_on_plan_gating(payload, note)}')
    if payload and payload.get('code') == 0:
        rows = ((payload.get('data') or {}).get('list')) or []
        if not rows:
            print('   (no profiles returned)')
        for row in rows:
            print(f"   - user_id={row.get('user_id')!r}  name={row.get('name')!r}  group={row.get('group_name')!r}")
    elif payload:
        print(f'   raw: {json.dumps(payload)[:400]}')
    print()

    if not args.start:
        print('Done. Re-run with --start <PROFILE_ID> to dump a real start response')
        print('and check it against what tools/scraper/shared/adspower.py expects.')
        return 0

    print(f'== 3. Starting profile {args.start} ==')
    payload, note = call(base, '/api/v1/browser/start',
                         {'user_id': args.start, 'open_tabs': 1, 'ip_tab': 0})
    print(f'   {note}')
    print(f'   FULL RESPONSE: {json.dumps(payload, indent=2) if payload else "(none)"}')
    if not payload or payload.get('code') != 0:
        print(f'   VERDICT: {verdict_on_plan_gating(payload, note)}')
        return 1

    data = payload.get('data') or {}
    print()
    print('== 4. Do our code assumptions hold? ==')
    for line in check_our_field_assumptions(data):
        print(line)

    selenium_addr = (data.get('ws') or {}).get('selenium')
    exit_code = 0
    if args.attach:
        print()
        print('== 5. Selenium attach ==')
        if not selenium_addr:
            print('   SKIPPED - no selenium debugger address in the response.')
            exit_code = 1
        else:
            try:
                from selenium import webdriver
                from selenium.webdriver.chrome.service import Service

                options = webdriver.ChromeOptions()
                options.add_experimental_option('debuggerAddress', selenium_addr)
                driver_path = data.get('webdriver')
                service = Service(executable_path=driver_path) if driver_path else Service()
                driver = webdriver.Chrome(service=service, options=options)
                driver.get('https://example.com')
                print(f'   ATTACHED. page title = {driver.title!r}')
                print('   This proves the open_uc_driver AdsPower path drives a real browser.')
            except Exception as exc:  # noqa: BLE001
                print(f'   ATTACH FAILED - {type(exc).__name__}: {exc}')
                exit_code = 1

    if args.stop:
        print()
        print('== 6. Stopping profile ==')
        payload, note = call(base, '/api/v1/browser/stop', {'user_id': args.start})
        print(f'   {note}  {json.dumps(payload) if payload else ""}')

    return exit_code


if __name__ == '__main__':
    sys.exit(main())
