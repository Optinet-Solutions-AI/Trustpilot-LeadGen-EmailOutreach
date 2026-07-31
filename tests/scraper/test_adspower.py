"""AdsPower Local API client tests. No network — requests.get is patched."""
import pytest

from tools.scraper.shared import adspower


class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


def test_start_profile_returns_debug_address_and_driver(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': 0,
        'data': {
            'ws': {'selenium': '127.0.0.1:51234', 'puppeteer': 'ws://127.0.0.1:51234/dev'},
            'webdriver': 'C:\\adspower\\chromedriver.exe',
        },
    }))
    out = adspower.start_profile('kxxxxx')
    assert out['debugger_address'] == '127.0.0.1:51234'
    assert out['webdriver_path'] == 'C:\\adspower\\chromedriver.exe'


def test_start_profile_raises_on_api_error_code(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': -1, 'msg': 'user_id does not exist',
    }))
    with pytest.raises(adspower.AdsPowerError) as exc:
        adspower.start_profile('nope')
    assert 'user_id does not exist' in str(exc.value)


def test_start_profile_raises_when_local_api_unreachable(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)

    def refuse(url, **kw):
        raise adspower.requests.exceptions.ConnectionError('connection refused')

    monkeypatch.setattr(adspower.requests, 'get', refuse)
    with pytest.raises(adspower.AdsPowerError) as exc:
        adspower.start_profile('kxxxxx')
    assert 'AdsPower desktop app' in str(exc.value)


def test_start_profile_rejects_missing_selenium_address(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': 0, 'data': {'ws': {}, 'webdriver': 'x'},
    }))
    with pytest.raises(adspower.AdsPowerError):
        adspower.start_profile('kxxxxx')


def test_calls_are_throttled_to_one_per_second(monkeypatch):
    slept = []
    monkeypatch.setattr(adspower.time, 'sleep', slept.append)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': 0, 'data': {'ws': {'selenium': '127.0.0.1:1'}, 'webdriver': 'd'},
    }))
    adspower.start_profile('a')
    adspower.start_profile('b')
    assert slept, 'second call within 1s must be throttled'


def test_stop_profile_tolerates_already_stopped(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': -1, 'msg': 'browser is not open',
    }))
    adspower.stop_profile('kxxxxx')  # must not raise


def test_api_key_is_sent_when_configured(monkeypatch):
    monkeypatch.setenv('ADSPOWER_API_KEY', 'secret')
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    seen = {}

    def capture(url, **kw):
        seen.update(kw)
        return _Resp(200, {'code': 0, 'data': {'ws': {'selenium': '1:2'}, 'webdriver': 'd'}})

    monkeypatch.setattr(adspower.requests, 'get', capture)
    adspower.start_profile('a')
    assert seen['headers']['Authorization'] == 'secret'
