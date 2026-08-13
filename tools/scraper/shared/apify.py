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

A TIMEOUT IS NOT A FAILURE

  run-sync-get-dataset-items is a "start the actor, then block on this HTTP
  socket until it finishes" endpoint. If OUR socket gives up waiting, that
  says nothing about the actor: the run keeps executing and billing on
  Apify's infrastructure regardless of whether anyone is still listening.

  Measured incident (2026-08): three attempts against
  memo23/facebook-public-group-posts-scraper each timed out client-side at
  ~301s and were retried. All three showed up on the Apify account as
  SUCCEEDED runs, each billed $0.0948 — we paid three times for one job and
  the retry loop threw every result away, because a fresh retry starts a NEW
  run rather than reattaching to the one already in flight.

  So: requests.exceptions.Timeout (ReadTimeout, ConnectTimeout) is handled
  completely differently from a genuine transport failure. It is never
  retried — retrying would start (and bill) a second run — and instead
  triggers recovery: find the run our request actually started, wait for it
  to reach a terminal state, and return its dataset instead of discarding
  work that has already been paid for. A real requests.exceptions.
  ConnectionError that is NOT a Timeout means the request never reached
  Apify at all — nothing started, nothing billed — so that case keeps the
  normal retry-with-backoff path.

  THIS FAILURE ARRIVES BY TWO DOORS

  The client-side exception above is only half of it. run-sync-get-dataset-
  items ALSO enforces its own hard 300-second ceiling server-side, entirely
  independent of the `timeout` we pass, and when a run outlives it the
  endpoint answers HTTP 408 with error.type "run-timeout-exceeded". That is
  a normal response, not an exception, so it used to fall through to the
  generic 4xx branch and raise — walking straight past this module's whole
  reason for existing.

  Measured incident (2026-08-13, Yelp): a 408 came back at 301.6s. The run
  behind it was still RUNNING, had already scraped 169 items and billed
  $0.45, and every one of those items was thrown away — the operator was
  told "0 businesses". A 408 therefore routes to the same recovery as a
  client timeout, and is likewise never retried.

  The practical consequence for callers: sizing a request so it plausibly
  finishes inside 300s is a cost optimisation, not a correctness
  requirement. Overrunning is survivable — you wait longer and still get
  the data — but it is never free.
"""
from __future__ import annotations

import os
import sys
import time
from datetime import datetime
from typing import Any, Optional

import requests

APIFY_BASE = 'https://api.apify.com/v2'
# 15 minutes. The old 300s default was BELOW this actor's real runtime (see
# the incident above — 301s and still going) and it exactly matched
# scrape-runner.ts's WATCHDOG_TIMEOUT_MS (5 * 60 * 1000): when the two
# coincide, the Node watchdog kills the whole process first and reports it as
# "hung — likely OOM or Playwright freeze", hiding the real cause. 900s gives
# a multi-group run genuine headroom above both. Callers with a known-larger
# job can still pass an explicit `timeout=`.
DEFAULT_TIMEOUT = 900
MAX_ATTEMPTS = 3
BACKOFF_SECONDS = (2, 5)

# Timeout recovery (see "A TIMEOUT IS NOT A FAILURE" above). Poll interval is
# deliberately loose — this is not a status endpoint we should hammer — and
# the cap gives roughly the same order of extra headroom as DEFAULT_TIMEOUT
# itself before we give up and tell a human to go collect the data by hand.
RECOVERY_POLL_INTERVAL_SECONDS = 20
RECOVERY_MAX_POLLS = 60  # 60 * 20s = 20 minutes
# Runs whose startedAt is before (call_started - this) are assumed to predate
# our request and are never treated as candidates — see _find_started_run.
_RUN_MATCH_CLOCK_SKEW_SECONDS = 15
_TERMINAL_RUN_STATUSES = {'SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'}


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
        try:
            resp = requests.post(
                url,
                params={'token': _token()},
                json=run_input,
                timeout=timeout,
            )
        except requests.exceptions.Timeout as exc:
            # Timeout (incl. ReadTimeout, and ConnectTimeout which also
            # subclasses ConnectionError) is caught here, BEFORE the generic
            # RequestException branch below, specifically so it never falls
            # into the retry path. See "A TIMEOUT IS NOT A FAILURE" — the run
            # almost certainly started and is billed regardless; retrying
            # would start and bill a second one. Recover instead of raising.
            elapsed = round(time.time() - started, 1)
            print(
                f'INFO: apify actor={actor_id} error={type(exc).__name__} elapsed={elapsed}s '
                f'attempt={attempt} — client gave up waiting but the run likely started and IS '
                f'BEING BILLED on Apify right now; NOT retrying (that would double-bill) — '
                f'switching to recovery: locating the run and waiting for it to finish',
                file=sys.stderr, flush=True,
            )
            return _recover_timed_out_run(actor_id, started, client_timeout=timeout)
        except requests.exceptions.RequestException as exc:
            elapsed = round(time.time() - started, 1)
            last_error = f'{type(exc).__name__}: {str(exc)[:200]}'
            print(f'INFO: apify actor={actor_id} error={type(exc).__name__} elapsed={elapsed}s attempt={attempt}', file=sys.stderr, flush=True)
            if attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)])
                continue
            raise ApifyError(f'Apify actor {actor_id} failed after {MAX_ATTEMPTS} attempts: {last_error}') from exc

        elapsed = round(time.time() - started, 1)

        if resp.status_code == 402:
            print(f'INFO: apify actor={actor_id} status=402 elapsed={elapsed}s', file=sys.stderr, flush=True)
            raise ApifyCreditError(
                f'Apify returned 402 (out of credit / plan limit) for actor '
                f'{actor_id}: {resp.text[:300]}'
            )
        if resp.status_code == 408:
            # The SERVER-side twin of the client Timeout handled above. This
            # endpoint has its own hard 300s ceiling, independent of our
            # `timeout`, and answers 408 run-timeout-exceeded when a run
            # outlives it — while the run itself keeps going and keeps
            # billing. Falling through to the generic 4xx raise below would
            # discard work already paid for, so this routes to the same
            # recovery as a client timeout. Deliberately NOT retried: the
            # first run is still in flight, so a second POST bills twice for
            # one job.
            print(
                f'INFO: apify actor={actor_id} status=408 elapsed={elapsed}s attempt={attempt} — '
                f'the API endpoint gave up at its 300s ceiling but the run is still executing and '
                f'IS BEING BILLED on Apify right now; NOT retrying (that would double-bill) — '
                f'switching to recovery: locating the run and waiting for it to finish',
                file=sys.stderr, flush=True,
            )
            return _recover_timed_out_run(actor_id, started, client_timeout=timeout)
        if resp.status_code >= 500:
            print(f'INFO: apify actor={actor_id} status={resp.status_code} elapsed={elapsed}s attempt={attempt}', file=sys.stderr, flush=True)
            if attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)])
                continue
            raise ApifyError(f'Apify actor {actor_id} failed after {MAX_ATTEMPTS} attempts: HTTP {resp.status_code}: {resp.text[:200]}')
        if resp.status_code >= 400:
            print(f'INFO: apify actor={actor_id} status={resp.status_code} elapsed={elapsed}s', file=sys.stderr, flush=True)
            raise ApifyError(f'Apify actor {actor_id} rejected the request — HTTP {resp.status_code}: {resp.text[:300]}')

        try:
            payload: Any = resp.json()
        except ValueError as exc:
            print(f'INFO: apify actor={actor_id} status={resp.status_code} elapsed={elapsed}s error=non-JSON', file=sys.stderr, flush=True)
            raise ApifyError(f'Apify actor {actor_id} returned non-JSON: {resp.text[:200]}') from exc
        if not isinstance(payload, list):
            print(f'INFO: apify actor={actor_id} status={resp.status_code} elapsed={elapsed}s error=non-list', file=sys.stderr, flush=True)
            raise ApifyError(f'Apify actor {actor_id} returned {type(payload).__name__}, expected a dataset list: {str(payload)[:300]}')

        print(f'INFO: apify actor={actor_id} items={len(payload)} elapsed={elapsed}s', file=sys.stderr, flush=True)
        return payload


def _iso_to_epoch(value: Optional[str]) -> Optional[float]:
    """Parse an Apify ISO-8601 UTC timestamp ("...Z") into epoch seconds.

    Returns None on anything unparsable rather than raising — a malformed
    timestamp on one run in a list should never take down recovery for the
    others.
    """
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError):
        return None


def _find_started_run(actor_id: str, call_started: float, token: str) -> Optional[dict]:
    """Find the run our timed-out POST call most likely started.

    Scoped to THIS actor via /v2/acts/{actor}/runs — not the account-wide
    /v2/actor-runs list — so a run of some completely different actor on the
    same account can never be mistaken for ours.

    Even scoped to one actor, "most recent run of this actor" is NOT safe
    enough on its own: if another call for the SAME actor (a different
    group/job, a different process) started after ours, it sorts ahead of
    ours in a newest-first list and would be silently picked instead —
    handing back someone else's dataset. So candidates are bounded to runs
    whose startedAt is at-or-after our own call time (allowing a little
    clock-skew slack), and among those we take the EARLIEST — the one Apify
    created at the moment it received OUR request, not a later racer.

    Returns None (not an exception) on any transport/parse hiccup so the
    polling loop in _recover_timed_out_run just treats it as "not found yet"
    and tries again on the next poll.
    """
    try:
        resp = requests.get(
            f'{APIFY_BASE}/acts/{_actor_path(actor_id)}/runs',
            params={'token': token, 'desc': 'true', 'limit': 20},
            timeout=30,
        )
    except requests.exceptions.RequestException:
        return None
    if resp.status_code >= 400:
        return None
    try:
        payload = resp.json()
    except ValueError:
        return None
    items = ((payload or {}).get('data') or {}).get('items') or []

    cutoff = call_started - _RUN_MATCH_CLOCK_SKEW_SECONDS
    candidates = [
        (started_epoch, item)
        for item in items
        for started_epoch in (_iso_to_epoch(item.get('startedAt')),)
        if started_epoch is not None and started_epoch >= cutoff
    ]
    if not candidates:
        return None
    candidates.sort(key=lambda pair: pair[0])
    return candidates[0][1]


def _fetch_dataset_items(dataset_id: str, token: str) -> list[dict]:
    """Fetch a dataset's items directly — the recovery-path equivalent of
    what run-sync-get-dataset-items would have handed back if our socket
    hadn't given up first."""
    resp = requests.get(
        f'{APIFY_BASE}/datasets/{dataset_id}/items',
        params={'token': token, 'format': 'json', 'clean': 'true'},
        timeout=60,
    )
    if resp.status_code >= 400:
        raise ApifyError(
            f'Recovered run pointed at dataset {dataset_id}, but fetching its items failed — '
            f'HTTP {resp.status_code}: {resp.text[:200]}'
        )
    try:
        payload = resp.json()
    except ValueError as exc:
        raise ApifyError(f'Recovered dataset {dataset_id} returned non-JSON: {resp.text[:200]}') from exc
    if not isinstance(payload, list):
        raise ApifyError(
            f'Recovered dataset {dataset_id} returned {type(payload).__name__}, expected a list: '
            f'{str(payload)[:300]}'
        )
    return payload


def _recover_timed_out_run(actor_id: str, call_started: float, *, client_timeout: int) -> list[dict]:
    """After our client gave up waiting on run-sync-get-dataset-items, find
    the run it started, wait for it to finish, and return its dataset.

    The run keeps executing and billing on Apify regardless of our socket —
    see "A TIMEOUT IS NOT A FAILURE" at the top of this module. Polls rather
    than blocking on a second long HTTP call so progress is visible and the
    wait is bounded independently of whatever the original `timeout` was.
    """
    token = _token()
    run: Optional[dict] = None
    for poll_num in range(1, RECOVERY_MAX_POLLS + 1):
        run = _find_started_run(actor_id, call_started, token)
        status = run.get('status') if run else None
        print(
            f'INFO: apify recovery actor={actor_id} poll={poll_num}/{RECOVERY_MAX_POLLS} '
            f'status={status or "not-found-yet"} — billed run likely still in flight',
            file=sys.stderr, flush=True,
        )
        if run is not None and status in _TERMINAL_RUN_STATUSES:
            break
        if poll_num < RECOVERY_MAX_POLLS:
            time.sleep(RECOVERY_POLL_INTERVAL_SECONDS)

    if run is None or run.get('status') not in _TERMINAL_RUN_STATUSES:
        raise ApifyError(
            f'Apify actor {actor_id} timed out locally after {client_timeout}s. The run it '
            f'started is billed regardless of our client and may still be running or may already '
            f'have completed — recovery polling for '
            f'{RECOVERY_MAX_POLLS * RECOVERY_POLL_INTERVAL_SECONDS}s could not confirm a finished '
            f'run. Do NOT just re-run this — it will bill again. Check '
            f'https://console.apify.com/actors/runs for a run of {actor_id} started around now '
            f'and pull its dataset by hand.'
        )

    status = run['status']
    run_id = run.get('id')
    if status != 'SUCCEEDED':
        raise ApifyError(
            f'Apify actor {actor_id} run {run_id} was recovered after a local timeout, but the '
            f'run itself ended {status}, not SUCCEEDED — there is no dataset to return. See '
            f'https://console.apify.com/actors/runs/{run_id} for details.'
        )

    dataset_id = run.get('defaultDatasetId')
    if not dataset_id:
        raise ApifyError(
            f'Apify actor {actor_id} run {run_id} succeeded but reported no defaultDatasetId — '
            f'cannot fetch its items automatically. It is billed and its data exists; retrieve it '
            f'manually at https://console.apify.com/actors/runs/{run_id}.'
        )

    items = _fetch_dataset_items(dataset_id, token)
    print(
        f'INFO: apify recovery actor={actor_id} run={run_id} items={len(items)} — recovered a '
        f'billed run our client had timed out on instead of discarding it',
        file=sys.stderr, flush=True,
    )
    return items


def get_actor_input_schema(actor_id: str) -> dict:
    """Fetch an actor's metadata so callers can read its real input key names.

    Community actors document inputs in prose that does not always match the
    JSON keys. Read the schema rather than guessing.
    """
    started = time.time()
    try:
        resp = requests.get(
            f'{APIFY_BASE}/acts/{_actor_path(actor_id)}',
            params={'token': _token()},
            timeout=30,
        )
    except requests.exceptions.RequestException as exc:
        elapsed = round(time.time() - started, 1)
        print(f'INFO: apify get_actor_input_schema actor={actor_id} error={type(exc).__name__} elapsed={elapsed}s', file=sys.stderr, flush=True)
        raise ApifyError(f'Could not read actor {actor_id} metadata — transport error {type(exc).__name__}: {str(exc)[:200]}') from exc

    elapsed = round(time.time() - started, 1)
    if resp.status_code >= 400:
        print(f'INFO: apify get_actor_input_schema actor={actor_id} status={resp.status_code} elapsed={elapsed}s', file=sys.stderr, flush=True)
        raise ApifyError(f'Could not read actor {actor_id} metadata — HTTP {resp.status_code}: {resp.text[:200]}')
    try:
        payload = resp.json()
    except ValueError as exc:
        print(f'INFO: apify get_actor_input_schema actor={actor_id} status={resp.status_code} elapsed={elapsed}s error=non-JSON', file=sys.stderr, flush=True)
        raise ApifyError(f'Could not parse actor {actor_id} metadata — non-JSON response: {resp.text[:200]}') from exc
    print(f'INFO: apify get_actor_input_schema actor={actor_id} elapsed={elapsed}s', file=sys.stderr, flush=True)
    return payload
