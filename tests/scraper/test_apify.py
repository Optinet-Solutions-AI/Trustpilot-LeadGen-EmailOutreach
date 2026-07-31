"""Tests for the Apify actor runner. No network — requests.post is patched."""
import pytest

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
