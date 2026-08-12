#!/usr/bin/env python3
"""Provision a country-pinned AdsPower profile for the Facebook engagement fleet.

Replicates the manual GB setup verified live 2026-08-11: a desktop Windows
Chrome fingerprint + a sticky Enigma residential proxy pinned to the target
country. One profile per country. After running this, log a country-appropriate
Facebook account into the profile by hand, clear checkpoints, warm it ~2-3 weeks,
then bind social_accounts.adspower_profile_id to it.

Requires the AdsPower desktop client running on THIS host (Local API is loopback).

Usage:
    python tools/scraper/provision_adspower_profile.py --country US
    python tools/scraper/provision_adspower_profile.py --country AU --name OptiRate-FB-AU
"""
from __future__ import annotations

import argparse
import json
import os
import time

import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', '.env'))

ADSPOWER_BASE = (os.environ.get('ADSPOWER_API_BASE') or 'http://local.adspower.com:50325').rstrip('/')
# Desktop Windows Chrome UA whose major matches the AdsPower kernel (chrome_150),
# verified desktop on the GB profile. random_ua is NOT reliable on this path, so
# we pin an explicit desktop UA.
DESKTOP_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36')
GROUP_NAME = 'OptiRate-FB'
_MIN_INTERVAL = 1.1  # AdsPower documents a 1 request/second Local API limit


def _headers() -> dict:
    key = (os.environ.get('ADSPOWER_API_KEY') or '').strip()
    return {'Authorization': f'Bearer {key}'} if key else {}


def _call(method: str, path: str, **kw) -> dict:
    time.sleep(_MIN_INTERVAL)
    try:
        r = requests.request(method, f'{ADSPOWER_BASE}{path}', headers=_headers(), timeout=60, **kw)
    except requests.exceptions.RequestException as exc:
        raise SystemExit(
            f'Could not reach the AdsPower Local API at {ADSPOWER_BASE}. Is the '
            f'AdsPower desktop client running on this host? Underlying error: {exc}'
        )
    if r.status_code >= 400:
        raise SystemExit(f'AdsPower {path} HTTP {r.status_code}: {r.text[:200]}')
    data = r.json()
    if data.get('code') != 0:
        raise SystemExit(f'AdsPower {path} failed: {data.get("msg") or data}')
    return data.get('data') or {}


def _sticky_proxy_password(cc: str, session_id: str) -> str:
    """Enigma sticky-session password: <base>_country-<CC>_session-<id>_lifetime-30.
    Strips any existing _country-/_session- suffixes from the .env base value."""
    base_pw = os.environ.get('RESIDENTIAL_PROXY_PASSWORD', '')
    base = base_pw.split('_country-')[0].split('_session-')[0].strip()
    if not base:
        raise SystemExit('RESIDENTIAL_PROXY_PASSWORD is not set in .env')
    return f'{base}_country-{cc.upper()}_session-{session_id}_lifetime-30'


def _ensure_group() -> str:
    data = _call('GET', '/api/v1/group/list', params={'page': 1, 'page_size': 100})
    for g in (data.get('list') or []):
        if g.get('group_name') == GROUP_NAME:
            return g['group_id']
    return _call('POST', '/api/v1/group/create', json={'group_name': GROUP_NAME})['group_id']


def provision(cc: str, name: str | None = None) -> dict:
    cc = cc.upper()
    name = name or f'OptiRate-FB-{cc}'
    session_id = f'optifb{cc.lower()}1'
    group_id = _ensure_group()
    proxy = {
        'proxy_soft': 'other',
        'proxy_type': 'http',
        'proxy_host': os.environ['RESIDENTIAL_PROXY_HOST'],
        'proxy_port': os.environ['RESIDENTIAL_PROXY_PORT'],
        'proxy_user': os.environ['RESIDENTIAL_PROXY_USERNAME'],
        'proxy_password': _sticky_proxy_password(cc, session_id),
    }
    body = {
        'name': name,
        'group_id': group_id,
        'user_proxy_config': proxy,
        'fingerprint_config': {
            'automatic_timezone': '1',  # follows the proxy IP's country
            'language': ['en-US', 'en'],
            'screen_resolution': '1920_1080',
            'ua': DESKTOP_UA,
        },
    }
    res = _call('POST', '/api/v1/user/create', json=body)
    return {
        'profile_id': res.get('id'),
        'serial_number': res.get('serial_number'),
        'name': name,
        'country': cc,
        'proxy_session': session_id,
        'group_id': group_id,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description='Provision a country-pinned AdsPower profile for the FB fleet.')
    ap.add_argument('--country', required=True, help='ISO2 country code, e.g. US, AU, GB')
    ap.add_argument('--name', help='Profile name (default OptiRate-FB-<CC>)')
    args = ap.parse_args()

    result = provision(args.country, args.name)
    print(json.dumps(result, indent=2))
    print(
        f"\nProfile '{result['name']}' ({result['profile_id']}) created with a sticky "
        f"{result['country']} residential proxy + desktop Windows fingerprint."
    )
    print("Next (human):")
    print(f"  1. Open this profile in AdsPower and log a {result['country']} Facebook account in by hand; clear checkpoints.")
    print("  2. Warm it ~2-3 weeks before any outreach.")
    print(f"  3. Bind it: update social_accounts set adspower_profile_id='{result['profile_id']}' "
          f"where platform='facebook' and country='{result['country']}';")


if __name__ == '__main__':
    main()
