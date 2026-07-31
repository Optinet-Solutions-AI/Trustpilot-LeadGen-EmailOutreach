"""AdsPower Local API client.

WHY THIS EXISTS

  Facebook links accounts by browser fingerprint as well as by IP. Running
  several accounts from one machine through one Chrome build makes them
  trivially correlatable. AdsPower gives each account an isolated profile —
  its own canvas/WebGL/audio/font/screen fingerprint, user-agent, timezone and
  proxy slot — and exposes a Local API to launch one and drive it with
  Selenium over CDP.

  It is NOT a proxy. It isolates fingerprints, not IPs. A profile still exits
  through whatever IP the host has unless a proxy is configured on the profile.

REQUIREMENTS

  The AdsPower desktop app must be running on the SAME host as this process —
  the API listens on localhost. That keeps this half host-bound, unlike the
  Apify discovery path which is a plain outbound HTTPS call.
"""
from __future__ import annotations

import os
import sys
import time

import requests

DEFAULT_BASE = 'http://local.adspower.net:50325'
REQUEST_TIMEOUT = 60
# AdsPower documents a 1 request/second limit on the Local API.
MIN_INTERVAL_SECONDS = 1.1

_last_call_at: float = 0.0


class AdsPowerError(RuntimeError):
    """A Local API call failed."""


def _base() -> str:
    return (os.environ.get('ADSPOWER_API_BASE') or DEFAULT_BASE).rstrip('/')


def _headers() -> dict:
    key = (os.environ.get('ADSPOWER_API_KEY') or '').strip()
    return {'Authorization': key} if key else {}


def _throttle() -> None:
    global _last_call_at
    elapsed = time.time() - _last_call_at
    if _last_call_at and elapsed < MIN_INTERVAL_SECONDS:
        time.sleep(MIN_INTERVAL_SECONDS - elapsed)
    _last_call_at = time.time()


def _call(path: str, params: dict) -> dict:
    _throttle()
    url = f'{_base()}{path}'
    try:
        resp = requests.get(url, params=params, headers=_headers(), timeout=REQUEST_TIMEOUT)
    except requests.exceptions.RequestException as exc:
        raise AdsPowerError(
            f'Could not reach the AdsPower Local API at {url}. Is the AdsPower '
            f'desktop app running on this host? Underlying error: {exc}'
        ) from exc
    if resp.status_code >= 400:
        raise AdsPowerError(f'AdsPower {path} returned HTTP {resp.status_code}: {resp.text[:200]}')
    try:
        payload = resp.json()
    except ValueError as exc:
        raise AdsPowerError(
            f'AdsPower {path} returned non-JSON response: {resp.text[:200]}'
        ) from exc
    if payload.get('code') != 0:
        raise AdsPowerError(f'AdsPower {path} failed: {payload.get("msg") or payload}')
    return payload.get('data') or {}


def start_profile(profile_id: str) -> dict:
    """Launch an AdsPower profile and return its Selenium attach details."""
    data = _call('/api/v1/browser/start', {
        'user_id': profile_id,
        'open_tabs': 1,       # don't restore the previous session's tabs
        'ip_tab': 0,          # skip AdsPower's own IP-check tab
    })
    debugger_address = ((data.get('ws') or {}).get('selenium') or '').strip()
    webdriver_path = (data.get('webdriver') or '').strip()
    if not debugger_address:
        raise AdsPowerError(
            f'AdsPower started profile {profile_id} but returned no selenium '
            f'debugger address. Response data: {data}'
        )
    print(f'INFO: AdsPower profile {profile_id} at {debugger_address}', file=sys.stderr, flush=True)
    return {'debugger_address': debugger_address, 'webdriver_path': webdriver_path}


def stop_profile(profile_id: str) -> None:
    """Close an AdsPower profile. Already-closed is not an error."""
    try:
        _call('/api/v1/browser/stop', {'user_id': profile_id})
    except AdsPowerError as exc:
        # Only suppress the "browser is not open" case. Let real failures propagate.
        if 'not open' in str(exc).lower():
            print(f'WARN: AdsPower stop for {profile_id}: {exc}', file=sys.stderr, flush=True)
        else:
            raise
