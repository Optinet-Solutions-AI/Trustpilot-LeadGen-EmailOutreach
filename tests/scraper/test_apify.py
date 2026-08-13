"""Tests for the Apify actor runner. No network — requests.post is patched."""
from datetime import datetime, timezone

import pytest
import requests

from tools.scraper.shared import apify


class _Resp:
    def __init__(self, status_code, payload=None, text=''):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError('no json')
        return self._payload


def _iso_now() -> str:
    """A fresh ISO-8601 UTC timestamp, for stubbing a run's startedAt so it
    always lands inside _find_started_run's clock-skew window in tests."""
    return datetime.now(timezone.utc).isoformat()


def _runs_resp(items):
    return _Resp(200, {'data': {'items': items}})


def test_missing_token_raises_not_empty_list(monkeypatch):
    monkeypatch.delenv('APIFY_API_TOKEN', raising=False)
    with pytest.raises(apify.ApifyError) as exc:
        apify.run_actor('some/actor', {})
    assert 'APIFY_API_TOKEN' in str(exc.value)


def test_successful_run_returns_dataset_items(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return _Resp(200, [{'a': 1}, {'a': 2}])

    monkeypatch.setattr(apify.requests, 'post', fake_post)
    out = apify.run_actor('scrapeforge/facebook-search-posts', {'q': 'x'})
    assert out == [{'a': 1}, {'a': 2}]
    # actor id must be slash-escaped into the path, token passed as a param
    assert 'scrapeforge~facebook-search-posts' in calls[0][0]
    assert calls[0][1]['params']['token'] == 'tok'


def test_402_raises_credit_error_with_actor_id(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'post',
        lambda url, **kw: _Resp(402, None, 'monthly usage exceeded'),
    )
    with pytest.raises(apify.ApifyCreditError) as exc:
        apify.run_actor('some/actor', {})
    assert 'some/actor' in str(exc.value)
    assert 'monthly usage exceeded' in str(exc.value)


def test_retries_5xx_then_succeeds(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    seq = [_Resp(503, None, 'bad gateway'), _Resp(200, [{'ok': True}])]
    monkeypatch.setattr(apify.requests, 'post', lambda url, **kw: seq.pop(0))
    slept = []
    monkeypatch.setattr(apify.time, 'sleep', slept.append)
    assert apify.run_actor('some/actor', {}) == [{'ok': True}]
    assert slept, 'should have backed off before retrying'


def test_gives_up_after_max_attempts(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(apify.requests, 'post', lambda url, **kw: _Resp(500, None, 'boom'))
    monkeypatch.setattr(apify.time, 'sleep', lambda s: None)
    with pytest.raises(apify.ApifyError):
        apify.run_actor('some/actor', {})


def test_non_list_payload_raises(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'post',
        lambda url, **kw: _Resp(200, {'error': 'actor not found'}),
    )
    with pytest.raises(apify.ApifyError):
        apify.run_actor('some/actor', {})


def test_plain_4xx_raises(monkeypatch):
    """Test that plain 4xx errors (404, 401) are handled correctly."""
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'post',
        lambda url, **kw: _Resp(404, None, 'actor not found'),
    )
    with pytest.raises(apify.ApifyError) as exc:
        apify.run_actor('some/actor', {})
    assert 'some/actor' in str(exc.value)
    assert '404' in str(exc.value)


def test_get_actor_input_schema_success(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    schema = {'input': {'properties': {'query': {'type': 'string'}}}}
    monkeypatch.setattr(
        apify.requests, 'get',
        lambda url, **kw: _Resp(200, schema),
    )
    result = apify.get_actor_input_schema('scrapeforge/facebook-search-posts')
    assert result == schema


def test_get_actor_input_schema_4xx_raises(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'get',
        lambda url, **kw: _Resp(404, None, 'actor not found'),
    )
    with pytest.raises(apify.ApifyError) as exc:
        apify.get_actor_input_schema('nonexistent/actor')
    assert 'nonexistent/actor' in str(exc.value)
    assert '404' in str(exc.value)


def test_get_actor_input_schema_malformed_json(monkeypatch):
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'get',
        lambda url, **kw: _Resp(200, None, 'invalid json'),
    )
    with pytest.raises(apify.ApifyError) as exc:
        apify.get_actor_input_schema('some/actor')
    assert 'some/actor' in str(exc.value)
    assert 'non-JSON' in str(exc.value)


def test_connection_error_on_all_attempts_raises_apify_error(monkeypatch):
    """Transport errors are caught and retried, then raised as ApifyError."""
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'post',
        lambda url, **kw: (_ for _ in ()).throw(requests.exceptions.ConnectionError('network down'))
    )
    monkeypatch.setattr(apify.time, 'sleep', lambda s: None)
    with pytest.raises(apify.ApifyError) as exc:
        apify.run_actor('some/actor', {})
    assert 'some/actor' in str(exc.value)
    assert 'ConnectionError' in str(exc.value)
    # Ensure it's not the raw requests exception
    assert not isinstance(exc.value, requests.exceptions.ConnectionError)


def test_connection_error_then_success_retries(monkeypatch):
    """First attempt raises ConnectionError; second attempt succeeds."""
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    seq = [
        lambda url, **kw: (_ for _ in ()).throw(requests.exceptions.ConnectionError('net')),
        lambda url, **kw: _Resp(200, [{'item': 1}])
    ]
    seq_iter = iter(seq)
    monkeypatch.setattr(apify.requests, 'post', lambda url, **kw: next(seq_iter)(url, **kw))
    slept = []
    monkeypatch.setattr(apify.time, 'sleep', slept.append)
    result = apify.run_actor('some/actor', {})
    assert result == [{'item': 1}]
    assert slept, 'should have backed off before retrying'


def test_get_actor_input_schema_connection_error_raises_apify_error(monkeypatch):
    """Transport errors in get_actor_input_schema are raised as ApifyError."""
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'get',
        lambda url, **kw: (_ for _ in ()).throw(requests.exceptions.Timeout('request timeout'))
    )
    with pytest.raises(apify.ApifyError) as exc:
        apify.get_actor_input_schema('some/actor')
    assert 'some/actor' in str(exc.value)
    assert 'Timeout' in str(exc.value)
    # Ensure it's not the raw requests exception
    assert not isinstance(exc.value, requests.exceptions.Timeout)


# ---------------------------------------------------------------------------
# Timeout handling: a timeout is not a failure. It must never trigger a
# second (billable) requests.post, and must recover the run that Apify
# already started and is already charging for.
# ---------------------------------------------------------------------------

def test_read_timeout_does_not_call_post_twice(monkeypatch):
    """The money-saving assertion: a ReadTimeout must not trigger a retry —
    a retry would start (and bill) a second Apify run on top of the one
    already in flight from the first, timed-out call."""
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    post_calls = []

    def fake_post(url, **kwargs):
        post_calls.append(url)
        raise requests.exceptions.ReadTimeout('read timed out')

    monkeypatch.setattr(apify.requests, 'post', fake_post)
    monkeypatch.setattr(apify.time, 'sleep', lambda s: None)

    def fake_get(url, **kwargs):
        if url.endswith('/runs'):
            return _runs_resp([
                {'id': 'run1', 'status': 'SUCCEEDED', 'startedAt': _iso_now(), 'defaultDatasetId': 'ds1'},
            ])
        if url.endswith('/items'):
            return _Resp(200, [{'ok': True}])
        raise AssertionError(f'unexpected GET {url}')

    monkeypatch.setattr(apify.requests, 'get', fake_get)

    result = apify.run_actor('some/actor', {})

    assert result == [{'ok': True}]
    assert len(post_calls) == 1, 'a timeout must never cause a second POST — that bills a duplicate run'


def test_connect_timeout_also_does_not_retry(monkeypatch):
    """ConnectTimeout multiply-inherits from both Timeout and ConnectionError.
    It must land in the no-retry/recovery branch, not the generic
    ConnectionError retry branch — regression guard for except-clause order."""
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    post_calls = []

    def fake_post(url, **kwargs):
        post_calls.append(url)
        raise requests.exceptions.ConnectTimeout('connect timed out')

    monkeypatch.setattr(apify.requests, 'post', fake_post)
    monkeypatch.setattr(apify.time, 'sleep', lambda s: None)

    def fake_get(url, **kwargs):
        if url.endswith('/runs'):
            return _runs_resp([
                {'id': 'runY', 'status': 'SUCCEEDED', 'startedAt': _iso_now(), 'defaultDatasetId': 'dsY'},
            ])
        if url.endswith('/items'):
            return _Resp(200, [{'x': 1}])
        raise AssertionError(f'unexpected GET {url}')

    monkeypatch.setattr(apify.requests, 'get', fake_get)

    result = apify.run_actor('some/actor', {})

    assert result == [{'x': 1}]
    assert len(post_calls) == 1


def test_connection_error_still_retries_then_succeeds(monkeypatch):
    """A genuine ConnectionError (not a Timeout) means we never reached
    Apify — no run started, nothing billed — so it stays safely retryable."""
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    post_calls = []
    seq = [
        lambda: (_ for _ in ()).throw(requests.exceptions.ConnectionError('net down')),
        lambda: _Resp(200, [{'item': 1}]),
    ]

    def fake_post(url, **kwargs):
        post_calls.append(url)
        return seq[len(post_calls) - 1]()

    monkeypatch.setattr(apify.requests, 'post', fake_post)
    monkeypatch.setattr(apify.time, 'sleep', lambda s: None)

    result = apify.run_actor('some/actor', {})

    assert result == [{'item': 1}]
    assert len(post_calls) == 2, 'ConnectionError (no Timeout) should still retry'


def test_timeout_recovery_returns_dataset_items_as_normal_return_value(monkeypatch):
    """After a timeout, the caller gets the dataset items back as a normal
    return value — not an exception — once the recovered run finishes."""
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'post',
        lambda url, **kw: (_ for _ in ()).throw(requests.exceptions.ReadTimeout('read timed out')),
    )
    monkeypatch.setattr(apify.time, 'sleep', lambda s: None)

    def fake_get(url, **kwargs):
        if url.endswith('/runs'):
            return _runs_resp([
                {'id': 'run7', 'status': 'SUCCEEDED', 'startedAt': _iso_now(), 'defaultDatasetId': 'ds7'},
            ])
        if url.endswith('/items'):
            return _Resp(200, [{'post': 'a'}, {'post': 'b'}])
        raise AssertionError(f'unexpected GET {url}')

    monkeypatch.setattr(apify.requests, 'get', fake_get)

    result = apify.run_actor('some/actor', {})
    assert result == [{'post': 'a'}, {'post': 'b'}]


def test_timeout_recovery_polls_while_running_then_succeeds(monkeypatch):
    """The run is RUNNING on the first poll(s) and only reaches SUCCEEDED
    later — recovery must keep polling rather than giving up early."""
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'post',
        lambda url, **kw: (_ for _ in ()).throw(requests.exceptions.ReadTimeout('read timed out')),
    )
    slept = []
    monkeypatch.setattr(apify.time, 'sleep', slept.append)

    run_statuses = iter(['RUNNING', 'RUNNING', 'SUCCEEDED'])

    def fake_get(url, **kwargs):
        if url.endswith('/runs'):
            status = next(run_statuses)
            return _runs_resp([
                {'id': 'run42', 'status': status, 'startedAt': _iso_now(), 'defaultDatasetId': 'ds42'},
            ])
        if url.endswith('/items'):
            return _Resp(200, [{'post': 1}, {'post': 2}])
        raise AssertionError(f'unexpected GET {url}')

    monkeypatch.setattr(apify.requests, 'get', fake_get)

    result = apify.run_actor('some/actor', {})

    assert result == [{'post': 1}, {'post': 2}]
    assert len(slept) >= 2, 'should have waited between polls while the run was still RUNNING'


@pytest.mark.parametrize('bad_status', ['FAILED', 'ABORTED'])
def test_timeout_recovery_run_ended_failed_or_aborted_raises(monkeypatch, bad_status):
    """A recovered run that ended FAILED/ABORTED must raise — never return
    junk or a silent empty list as if it were a normal empty result."""
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'post',
        lambda url, **kw: (_ for _ in ()).throw(requests.exceptions.ReadTimeout('read timed out')),
    )
    monkeypatch.setattr(apify.time, 'sleep', lambda s: None)

    def fake_get(url, **kwargs):
        if url.endswith('/runs'):
            return _runs_resp([
                {'id': 'runX', 'status': bad_status, 'startedAt': _iso_now(), 'defaultDatasetId': 'dsX'},
            ])
        raise AssertionError(f'unexpected GET {url}')

    monkeypatch.setattr(apify.requests, 'get', fake_get)

    with pytest.raises(apify.ApifyError) as exc:
        apify.run_actor('some/actor', {})
    assert bad_status in str(exc.value)
    assert 'some/actor' in str(exc.value)


def test_timeout_recovery_gives_up_raises_apify_error_mentions_billing(monkeypatch):
    """If recovery can never confirm a finished run, it must raise ApifyError
    with a message that tells a human a billed run may exist — so they go
    retrieve the data instead of just re-running (and paying again)."""
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(apify, 'RECOVERY_MAX_POLLS', 2)
    monkeypatch.setattr(
        apify.requests, 'post',
        lambda url, **kw: (_ for _ in ()).throw(requests.exceptions.ReadTimeout('read timed out')),
    )
    monkeypatch.setattr(apify.time, 'sleep', lambda s: None)
    monkeypatch.setattr(apify.requests, 'get', lambda url, **kw: _runs_resp([]))

    with pytest.raises(apify.ApifyError) as exc:
        apify.run_actor('some/actor', {})
    msg = str(exc.value)
    assert 'bill' in msg.lower()
    assert 'some/actor' in msg
    assert 'console.apify.com' in msg


def test_timeout_recovery_finds_correct_run_not_a_newer_racer(monkeypatch):
    """Regression guard for the "most-recent-run-for-this-actor is not safe
    enough" case: if a second, unrelated run of the SAME actor was started
    by someone/something else AFTER ours, a naive "take the newest" pick
    would return the racer's dataset instead of ours. The earliest run
    at-or-after our own call time must win."""
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    monkeypatch.setattr(
        apify.requests, 'post',
        lambda url, **kw: (_ for _ in ()).throw(requests.exceptions.ReadTimeout('read timed out')),
    )
    monkeypatch.setattr(apify.time, 'sleep', lambda s: None)

    our_start = datetime.now(timezone.utc)
    ours_iso = our_start.isoformat()
    # The racer started a few seconds AFTER ours — newest-first, it would be
    # items[0] in a real API response.
    racer_iso = (our_start.timestamp() + 5)
    racer_iso = datetime.fromtimestamp(racer_iso, tz=timezone.utc).isoformat()

    def fake_get(url, **kwargs):
        if url.endswith('/runs'):
            return _runs_resp([
                {'id': 'racer', 'status': 'SUCCEEDED', 'startedAt': racer_iso, 'defaultDatasetId': 'ds-racer'},
                {'id': 'ours', 'status': 'SUCCEEDED', 'startedAt': ours_iso, 'defaultDatasetId': 'ds-ours'},
            ])
        if url.endswith('/items'):
            if 'ds-ours' in url:
                return _Resp(200, [{'mine': True}])
            return _Resp(200, [{'mine': False}])
        raise AssertionError(f'unexpected GET {url}')

    monkeypatch.setattr(apify.requests, 'get', fake_get)

    result = apify.run_actor('some/actor', {})
    assert result == [{'mine': True}]


def test_408_run_timeout_recovers_instead_of_raising(monkeypatch):
    """run-sync-get-dataset-items has a HARD 300s SERVER-side cap, separate
    from our client `timeout`. When it trips Apify answers HTTP 408
    run-timeout-exceeded — while the run keeps executing and BILLING.

    Measured live 2026-08-13: a 408 came back at 301.6s and the run behind it
    was still RUNNING, had scraped 169 items and had already billed $0.45 —
    every item discarded, reported to the operator as "0 businesses". That is
    the same condition as a client-side Timeout arriving by a different door,
    so it must route to recovery rather than fall through to the generic 4xx
    raise.
    """
    monkeypatch.setenv('APIFY_API_TOKEN', 'tok')
    post_calls = []

    def fake_post(url, **kwargs):
        post_calls.append(url)
        return _Resp(
            408, None,
            '{"error":{"type":"run-timeout-exceeded","message":'
            '"Actor run exceeded the timeout of 300 seconds for this API endpoint"}}',
        )

    monkeypatch.setattr(apify.requests, 'post', fake_post)
    monkeypatch.setattr(apify.time, 'sleep', lambda s: None)

    def fake_get(url, **kwargs):
        if url.endswith('/runs'):
            return _runs_resp([
                {'id': 'run408', 'status': 'SUCCEEDED', 'startedAt': _iso_now(),
                 'defaultDatasetId': 'ds408'},
            ])
        if url.endswith('/items'):
            return _Resp(200, [{'biz': 1}, {'biz': 2}])
        raise AssertionError(f'unexpected GET {url}')

    monkeypatch.setattr(apify.requests, 'get', fake_get)

    result = apify.run_actor('memo23/yelp-scraper', {})

    assert result == [{'biz': 1}, {'biz': 2}]
    assert len(post_calls) == 1, (
        'a 408 must never cause a second POST — the first run is still '
        'executing and billing, so a retry pays twice for one job'
    )
