"""Apify actor runner — cookieless public-data discovery.

WHY THIS EXISTS

  Facebook post discovery used to require driving a logged-in account through
  undetected-chromedriver. That capped throughput at ~1 scrape/day (the
  social_accounts daily_cap of 10, set after a real FB "automated behaviour"
  warning), pinned the work to a Windows host with a residential IP, and put
  the account at ban risk for reading data that is public anyway.

  Apify runs the extraction on their infrastructure and hands back JSON. No
  account, no cookies, no fingerprint, no cap — and because it is a plain HTTP
  call it runs on Cloud Run and Linux workers, which the browser path never
  could.

FAILURE POLICY

  Every failure raises. A misconfigured token, an exhausted plan and a broken
  actor must never be reported as "no leads found" — that is indistinguishable
  from a genuinely empty search and silently hides billing and config faults.
"""
from __future__ import annotations

import os
import time
from typing import Any

import requests

APIFY_BASE = 'https://api.apify.com/v2'
DEFAULT_TIMEOUT = 300
MAX_ATTEMPTS = 3
BACKOFF_SECONDS = (2, 5)


class ApifyError(RuntimeError):
    """An actor run could not be completed."""


class ApifyCreditError(ApifyError):
    """HTTP 402 — plan limit reached or account out of credit."""


def _token() -> str:
    token = (os.environ.get('APIFY_API_TOKEN') or '').strip()
    if not token:
        raise ApifyError(
            'APIFY_API_TOKEN is not set — Apify discovery cannot run. Set it in '
            '.env. Raising rather than returning an empty list, because an empty '
            'result set is indistinguishable from a misconfigured token.'
        )
    return token


def _actor_path(actor_id: str) -> str:
    """Apify encodes the owner/name separator as a tilde inside URL paths."""
    return actor_id.replace('/', '~')


def run_actor(
    actor_id: str,
    run_input: dict,
    *,
    timeout: int = DEFAULT_TIMEOUT,
) -> list[dict]:
    """Run an actor to completion and return its dataset items.

    Uses run-sync-get-dataset-items, which blocks until the run finishes and
    returns the dataset in one response — no polling loop to maintain.
    """
    url = f'{APIFY_BASE}/acts/{_actor_path(actor_id)}/run-sync-get-dataset-items'
    last_error = ''
    for attempt in range(1, MAX_ATTEMPTS + 1):
        started = time.time()
        resp = requests.post(
            url,
            params={'token': _token()},
            json=run_input,
            timeout=timeout,
        )
        elapsed = round(time.time() - started, 1)

        if resp.status_code == 402:
            raise ApifyCreditError(
                f'Apify returned 402 (out of credit / plan limit) for actor '
                f'{actor_id}: {resp.text[:300]}'
            )
        if resp.status_code >= 500:
            last_error = f'HTTP {resp.status_code}: {resp.text[:200]}'
            if attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)])
                continue
            raise ApifyError(f'Apify actor {actor_id} failed after {MAX_ATTEMPTS} attempts: {last_error}')
        if resp.status_code >= 400:
            raise ApifyError(f'Apify actor {actor_id} rejected the request — HTTP {resp.status_code}: {resp.text[:300]}')

        try:
            payload: Any = resp.json()
        except ValueError as exc:
            raise ApifyError(f'Apify actor {actor_id} returned non-JSON: {resp.text[:200]}') from exc
        if not isinstance(payload, list):
            raise ApifyError(f'Apify actor {actor_id} returned {type(payload).__name__}, expected a dataset list: {str(payload)[:300]}')

        print(f'INFO: apify actor={actor_id} items={len(payload)} elapsed={elapsed}s', flush=True)
        return payload

    raise ApifyError(f'Apify actor {actor_id} failed: {last_error}')


def get_actor_input_schema(actor_id: str) -> dict:
    """Fetch an actor's metadata so callers can read its real input key names.

    Community actors document inputs in prose that does not always match the
    JSON keys. Read the schema rather than guessing.
    """
    resp = requests.get(
        f'{APIFY_BASE}/acts/{_actor_path(actor_id)}',
        params={'token': _token()},
        timeout=30,
    )
    if resp.status_code >= 400:
        raise ApifyError(f'Could not read actor {actor_id} metadata — HTTP {resp.status_code}: {resp.text[:200]}')
    return resp.json()
