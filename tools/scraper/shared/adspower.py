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

  The Local API is PAID-ONLY — only available in the paid version of AdsPower.
  Free accounts cannot use this API.

OPTIONAL ENDPOINTS (NOT CALLED HERE)

  /api/v1/browser/active reports Inactive/Active with ws details if profile
  state needs querying. We deliberately do not call it — start_profile is
  idempotent and returns the existing session if already running.
"""
from __future__ import annotations

import os
import sys
import time

import requests

# AdsPower's own published docs give the Local API host as
# local.adspower.NET. That is incorrect: the AdsPower client writes
# local.adspower.COM into its own config file, and .com is the host that
# actually answers — verified against a real install (client 8.7.23) on
# 2026-07-31. Override with ADSPOWER_API_BASE if a future build moves it.
DEFAULT_BASE = 'http://local.adspower.com:50325'
REQUEST_TIMEOUT = 60
# AdsPower documents a 1 request/second limit on the Local API.
MIN_INTERVAL_SECONDS = 1.1
# browser/start can return code 0 with an EMPTY ws.selenium on the first call
# while the profile's Chrome + CDP debug port are still coming up (observed
# live on EC2, 2026-08-13: first call empty, second call returned the port).
# Since browser/start is idempotent, re-poll it until the port is ready.
START_MAX_ATTEMPTS = 6
START_RETRY_DELAY_SECONDS = 1.5

_last_call_at: float = 0.0


class AdsPowerError(RuntimeError):
    """A Local API call failed."""


class AdsPowerUnreachable(AdsPowerError):
    """The Local API could not be reached at all (connection refused/timeout).

    Distinct from a call that reached the API but got an error code back: the
    watchdog relaunches AdsPower only when it is genuinely unreachable. A
    reachable-but-erroring API (e.g. Security Verification on without a key)
    is a config problem a relaunch cannot fix — see probe()."""


def _base() -> str:
    return (os.environ.get('ADSPOWER_API_BASE') or DEFAULT_BASE).rstrip('/')


def _headers() -> dict:
    key = (os.environ.get('ADSPOWER_API_KEY') or '').strip()
    return {'Authorization': f'Bearer {key}'} if key else {}


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
        raise AdsPowerUnreachable(
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


def _call_post(path: str, body: dict) -> dict:
    _throttle()
    url = f'{_base()}{path}'
    try:
        resp = requests.post(url, json=body, headers=_headers(), timeout=REQUEST_TIMEOUT)
    except requests.exceptions.RequestException as exc:
        raise AdsPowerUnreachable(
            f'Could not reach the AdsPower Local API at {url}. Is the AdsPower '
            f'desktop app running on this host? Underlying error: {exc}'
        ) from exc
    if resp.status_code >= 400:
        raise AdsPowerError(f'AdsPower {path} returned HTTP {resp.status_code}: {resp.text[:200]}')
    try:
        payload = resp.json()
    except ValueError as exc:
        raise AdsPowerError(f'AdsPower {path} returned non-JSON response: {resp.text[:200]}') from exc
    if payload.get('code') != 0:
        raise AdsPowerError(f'AdsPower {path} failed: {payload.get("msg") or payload}')
    return payload.get('data') or {}


def create_profile(*, name: str, country: str, proxy_config: dict) -> str:
    """Create a fresh AdsPower profile bound to a country proxy. Returns the new
    profile id (user_id). The login itself is NOT done here — a human logs into
    Facebook in the streamed browser afterward, and AdsPower persists it in the
    profile. `group_id` '0' = ungrouped; override with ADSPOWER_FLEET_GROUP_ID."""
    group_id = (os.environ.get('ADSPOWER_FLEET_GROUP_ID') or '0').strip()
    body = {
        'name': name,
        'group_id': group_id,
        'user_proxy_config': proxy_config or {'proxy_soft': 'no_proxy'},
        # AdsPower requires a fingerprint_config object; empty = auto-randomised,
        # which is exactly what we want (each account a distinct fingerprint).
        'fingerprint_config': {'automatic_timezone': '1'},
        'remark': f'fleet onboarded country={country}',
    }
    data = _call_post('/api/v1/user/create', body)
    pid = str(data.get('id') or '').strip()
    if not pid:
        raise AdsPowerError(f'AdsPower create returned no profile id. Response: {data}')
    print(f'INFO: AdsPower created profile {pid} (country={country})', file=sys.stderr, flush=True)
    return pid


def start_profile(profile_id: str) -> dict:
    """Launch an AdsPower profile and return its Selenium attach details.

    Idempotent: if the profile is already running, AdsPower returns code 0 with
    the existing debug port and webdriver path (verified live on 2026-07-31).
    Callers need no is_running check.

    The webdriver_path points to AdsPower's bundled chromedriver (e.g.
    .../cwd_global/chrome_150/chromedriver.exe), so there is no version-matching
    problem on this path (unlike the legacy Brave path).
    """
    data: dict = {}
    for attempt in range(1, START_MAX_ATTEMPTS + 1):
        data = _call('/api/v1/browser/start', {
            'user_id': profile_id,
            'open_tabs': 1,       # don't restore the previous session's tabs
            'ip_tab': 0,          # skip AdsPower's own IP-check tab
        })
        debugger_address = ((data.get('ws') or {}).get('selenium') or '').strip()
        webdriver_path = (data.get('webdriver') or '').strip()
        if debugger_address:
            suffix = f' (attempt {attempt})' if attempt > 1 else ''
            print(f'INFO: AdsPower profile {profile_id} at {debugger_address}{suffix}',
                  file=sys.stderr, flush=True)
            return {'debugger_address': debugger_address, 'webdriver_path': webdriver_path}
        if attempt < START_MAX_ATTEMPTS:
            print(f'INFO: AdsPower profile {profile_id} started but its CDP debug port '
                  f'is not ready yet (attempt {attempt}/{START_MAX_ATTEMPTS}); retrying...',
                  file=sys.stderr, flush=True)
            time.sleep(START_RETRY_DELAY_SECONDS)
    raise AdsPowerError(
        f'AdsPower started profile {profile_id} but returned no selenium debugger '
        f'address after {START_MAX_ATTEMPTS} attempts. Last response data: {data}'
    )


def stop_profile(profile_id: str) -> None:
    """Close an AdsPower profile. Already-closed is not an error."""
    try:
        _call('/api/v1/browser/stop', {'user_id': profile_id})
    except AdsPowerError as exc:
        # Only suppress the already-stopped case. AdsPower words it
        # "User_id is not open" — observed live on 2026-07-31 (client
        # 8.7.23), and the test is pinned to that exact string. Match on
        # the loose "not open" substring rather than the full message so a
        # reworded variant still counts as already-stopped; do NOT narrow
        # it. Let real failures propagate.
        if 'not open' in str(exc).lower():
            print(f'WARN: AdsPower stop for {profile_id}: {exc}', file=sys.stderr, flush=True)
        else:
            raise


def health_check() -> bool:
    """True if the AdsPower Local API is up (answers code 0 on /status).

    A simple boolean for callers that only care whether the API is usable.
    Never raises — an unreachable or erroring API both read as False. The
    watchdog uses probe() instead, because it must distinguish those two."""
    return probe() == 'up'


def probe() -> str:
    """Classify the Local API state for the watchdog. Never raises.

      'up'          — /status answered code 0; the client is healthy.
      'unreachable' — could not connect at all; the client is down and a
                      relaunch is the right recovery.
      'error'       — the client answered but with an error code / bad body
                      (e.g. Security Verification enabled without a valid
                      ADSPOWER_API_KEY). A relaunch cannot fix this and would
                      just thrash the GUI every watchdog tick, so the watchdog
                      must surface it instead of relaunching.
    """
    try:
        _call('/status', {})
        return 'up'
    except AdsPowerUnreachable:
        return 'unreachable'
    except AdsPowerError:
        return 'error'
