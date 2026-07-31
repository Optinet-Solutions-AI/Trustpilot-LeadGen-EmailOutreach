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


def test_start_profile_raises_on_non_json_response(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)

    class BadResp:
        status_code = 200
        text = '<html>Internal Server Error</html>'

        def json(self):
            raise ValueError('Invalid JSON')

    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: BadResp())
    with pytest.raises(adspower.AdsPowerError) as exc:
        adspower.start_profile('kxxxxx')
    assert 'non-JSON' in str(exc.value)


def test_stop_profile_propagates_connection_error(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)

    def refuse(url, **kw):
        raise adspower.requests.exceptions.ConnectionError('connection refused')

    monkeypatch.setattr(adspower.requests, 'get', refuse)
    with pytest.raises(adspower.AdsPowerError) as exc:
        adspower.stop_profile('kxxxxx')
    assert 'AdsPower desktop app' in str(exc.value)


from tools.scraper.shared import uc_driver


class _FakeDriver:
    def __init__(self, *a, **kw):
        self.kwargs = kw
        self.page_load_timeout = None

    def set_page_load_timeout(self, t):
        self.page_load_timeout = t

    def execute_cdp_cmd(self, *a, **kw):
        return {}


def test_opener_uses_adspower_when_profile_id_passed(monkeypatch):
    monkeypatch.setattr(uc_driver, '_open_adspower_driver', lambda pid: _FakeDriver(pid=pid))

    def boom(*a, **kw):
        raise AssertionError('must not fall through to undetected-chromedriver')

    monkeypatch.setattr(uc_driver, '_detect_chrome_major_version', boom)
    drv = uc_driver.open_uc_driver('FB_PROFILE_DIR', adspower_profile_id='kxxxxx')
    assert isinstance(drv, _FakeDriver)


def test_opener_reads_adspower_id_from_env_when_not_passed(monkeypatch):
    monkeypatch.setenv('ADSPOWER_PROFILE_ID', 'from-env')
    seen = {}

    def fake_open(pid):
        seen['pid'] = pid
        return _FakeDriver()

    monkeypatch.setattr(uc_driver, '_open_adspower_driver', fake_open)
    uc_driver.open_uc_driver('FB_PROFILE_DIR')
    assert seen['pid'] == 'from-env'


def test_explicit_argument_beats_env(monkeypatch):
    monkeypatch.setenv('ADSPOWER_PROFILE_ID', 'from-env')
    seen = {}
    monkeypatch.setattr(uc_driver, '_open_adspower_driver',
                        lambda pid: seen.setdefault('pid', pid) or _FakeDriver())
    uc_driver.open_uc_driver('FB_PROFILE_DIR', adspower_profile_id='explicit')
    assert seen['pid'] == 'explicit'


def test_opener_falls_through_when_no_adspower_id(monkeypatch):
    monkeypatch.delenv('ADSPOWER_PROFILE_ID', raising=False)

    def marker(pid):
        raise AssertionError('AdsPower must not be used without a profile id')

    monkeypatch.setattr(uc_driver, '_open_adspower_driver', marker)
    # Prove we reached the legacy body by making its first real call raise a
    # distinctive error instead of launching Chrome.
    monkeypatch.setattr(uc_driver, '_detect_chrome_major_version',
                        lambda: (_ for _ in ()).throw(RuntimeError('reached legacy path')))
    with pytest.raises(RuntimeError, match='reached legacy path'):
        uc_driver.open_uc_driver('FB_PROFILE_DIR')
