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


def test_default_api_base_matches_the_host_a_real_install_uses(monkeypatch):
    """AdsPower's published docs say local.adspower.NET; the client's own
    config file and a real install on 2026-07-31 both use local.adspower.COM,
    which is also what .env.example documents."""
    monkeypatch.delenv('ADSPOWER_API_BASE', raising=False)
    assert adspower._base() == 'http://local.adspower.com:50325'


def test_api_base_env_var_overrides_the_default(monkeypatch):
    monkeypatch.setenv('ADSPOWER_API_BASE', 'http://127.0.0.1:50325/')
    assert adspower._base() == 'http://127.0.0.1:50325'


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
    # AdsPowerUnreachable is-a AdsPowerError, so existing callers are unaffected.
    with pytest.raises(adspower.AdsPowerUnreachable) as exc:
        adspower.start_profile('kxxxxx')
    assert 'AdsPower desktop app' in str(exc.value)


def test_probe_returns_up_when_status_ok(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {'code': 0, 'data': {}}))
    assert adspower.probe() == 'up'
    assert adspower.health_check() is True


def test_probe_returns_unreachable_on_connection_error(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)

    def refuse(url, **kw):
        raise adspower.requests.exceptions.ConnectionError('connection refused')

    monkeypatch.setattr(adspower.requests, 'get', refuse)
    assert adspower.probe() == 'unreachable'
    assert adspower.health_check() is False


def test_probe_returns_error_when_api_answers_with_error_code(monkeypatch):
    """The client is up but rejects the call (e.g. Security Verification on
    without a key). This must be distinguishable from 'unreachable' so the
    watchdog does not relaunch a running client."""
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': -1, 'msg': 'Please config the api key in Security Verification',
    }))
    assert adspower.probe() == 'error'
    assert adspower.health_check() is False


def test_start_profile_rejects_missing_selenium_address(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': 0, 'data': {'ws': {}, 'webdriver': 'x'},
    }))
    with pytest.raises(adspower.AdsPowerError):
        adspower.start_profile('kxxxxx')


def test_start_profile_retries_until_cdp_port_is_ready(monkeypatch):
    """Live on EC2 (2026-08-13): the FIRST browser/start returns code 0 with an
    EMPTY ws.selenium, and a second idempotent call returns the real debug port
    (127.0.0.1:62108). The client must retry on that empty address instead of
    raising, because browser/start is idempotent and the port comes up shortly."""
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    calls = {'n': 0}

    def flaky(url, **kw):
        calls['n'] += 1
        if calls['n'] == 1:
            return _Resp(200, {'code': 0, 'data': {'ws': {'selenium': ''}, 'webdriver': ''}})
        return _Resp(200, {'code': 0, 'data': {
            'ws': {'selenium': '127.0.0.1:62108'},
            'webdriver': 'C:\\adspower\\chromedriver.exe',
        }})

    monkeypatch.setattr(adspower.requests, 'get', flaky)
    out = adspower.start_profile('kxxxxx')
    assert out['debugger_address'] == '127.0.0.1:62108'
    assert out['webdriver_path'] == 'C:\\adspower\\chromedriver.exe'
    assert calls['n'] == 2, 'should retry exactly once after the empty first address'


def test_start_profile_gives_up_after_max_attempts_when_never_ready(monkeypatch):
    """If the debug port never comes up, retrying can't help — raise, but only
    after exhausting the bounded attempt budget so a genuinely dead profile
    surfaces to the operator."""
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    calls = {'n': 0}

    def always_empty(url, **kw):
        calls['n'] += 1
        return _Resp(200, {'code': 0, 'data': {'ws': {'selenium': ''}, 'webdriver': ''}})

    monkeypatch.setattr(adspower.requests, 'get', always_empty)
    with pytest.raises(adspower.AdsPowerError):
        adspower.start_profile('kxxxxx')
    assert calls['n'] == adspower.START_MAX_ATTEMPTS


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
    # Real response observed live on 2026-07-31 (client 8.7.23, Local API).
    # Do not "correct" this — the string is pinned to observed behavior.
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': -1, 'msg': 'User_id is not open',
    }))
    adspower.stop_profile('kxxxxx')  # must not raise


def test_stop_profile_propagates_other_failures(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'get', lambda url, **kw: _Resp(200, {
        'code': -1, 'msg': 'Unknown error',
    }))
    with pytest.raises(adspower.AdsPowerError) as exc:
        adspower.stop_profile('kxxxxx')
    assert 'Unknown error' in str(exc.value)


def test_api_key_is_sent_when_configured(monkeypatch):
    monkeypatch.setenv('ADSPOWER_API_KEY', 'secret')
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    seen = {}

    def capture(url, **kw):
        seen.update(kw)
        return _Resp(200, {'code': 0, 'data': {'ws': {'selenium': '1:2'}, 'webdriver': 'd'}})

    monkeypatch.setattr(adspower.requests, 'get', capture)
    adspower.start_profile('a')
    assert seen['headers']['Authorization'] == 'Bearer secret'


def test_api_key_header_not_sent_when_unset(monkeypatch):
    monkeypatch.delenv('ADSPOWER_API_KEY', raising=False)
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    seen = {}

    def capture(url, **kw):
        seen.update(kw)
        return _Resp(200, {'code': 0, 'data': {'ws': {'selenium': '1:2'}, 'webdriver': 'd'}})

    monkeypatch.setattr(adspower.requests, 'get', capture)
    adspower.start_profile('a')
    assert 'Authorization' not in seen.get('headers', {}), 'no Authorization header when key is unset'


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


def test_create_profile_returns_new_user_id(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    seen = {}

    def capture(url, **kw):
        seen['url'] = url
        seen['json'] = kw.get('json')
        return _Resp(200, {'code': 0, 'data': {'id': 'knewprof1'}})

    # create uses POST, not GET
    monkeypatch.setattr(adspower.requests, 'post', capture)
    pid = adspower.create_profile(
        name='fleet-GB-1',
        country='GB',
        proxy_config={'proxy_soft': 'other', 'proxy_type': 'http',
                      'proxy_host': 'gb.enigma.io', 'proxy_port': '1000',
                      'proxy_user': 'u', 'proxy_password': 'p'},
    )
    assert pid == 'knewprof1'
    assert seen['url'].endswith('/api/v1/user/create')
    assert seen['json']['user_proxy_config']['proxy_host'] == 'gb.enigma.io'
    assert seen['json']['name'] == 'fleet-GB-1'


def test_create_profile_raises_on_api_error(monkeypatch):
    monkeypatch.setattr(adspower.time, 'sleep', lambda s: None)
    monkeypatch.setattr(adspower.requests, 'post',
                        lambda url, **kw: _Resp(200, {'code': -1, 'msg': 'group not found'}))
    with pytest.raises(adspower.AdsPowerError) as exc:
        adspower.create_profile(name='x', country='GB', proxy_config={})
    assert 'group not found' in str(exc.value)


from tools.scraper.shared import uc_driver


class _FakeDriver:
    def __init__(self, *a, **kw):
        self.kwargs = kw
        self.page_load_timeout = None
        self.quit_calls = 0

    def set_page_load_timeout(self, t):
        self.page_load_timeout = t

    def execute_cdp_cmd(self, *a, **kw):
        return {}

    def quit(self):
        self.quit_calls += 1


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


def _arm_legacy_path_tripwire(monkeypatch):
    """Make the legacy undetected-chromedriver body raise instead of launching
    a real browser, so a fall-through is observable without opening Chrome.

    SOCIAL_CHROME_VERSION must be cleared: when it holds a digit string the
    opener never calls _detect_chrome_major_version and would march on to a
    genuine Chrome launch on a machine where the operator has set it.
    """
    monkeypatch.delenv('SOCIAL_CHROME_VERSION', raising=False)

    def marker(pid):
        raise AssertionError(f'AdsPower must not be used here (got {pid!r})')

    monkeypatch.setattr(uc_driver, '_open_adspower_driver', marker)
    monkeypatch.setattr(uc_driver, '_detect_chrome_major_version',
                        lambda: (_ for _ in ()).throw(RuntimeError('reached legacy path')))


def test_opener_falls_through_when_no_adspower_id(monkeypatch):
    monkeypatch.delenv('ADSPOWER_PROFILE_ID', raising=False)
    # Prove we reached the legacy body by making its first real call raise a
    # distinctive error instead of launching Chrome.
    _arm_legacy_path_tripwire(monkeypatch)
    with pytest.raises(RuntimeError, match='reached legacy path'):
        uc_driver.open_uc_driver('FB_PROFILE_DIR')


def test_instagram_caller_ignores_the_adspower_env_var(monkeypatch):
    """ADSPOWER_PROFILE_ID names the FACEBOOK profile. Instagram must not be
    silently hijacked into it just because the var is set in .env."""
    monkeypatch.setenv('ADSPOWER_PROFILE_ID', 'fb-profile')
    _arm_legacy_path_tripwire(monkeypatch)
    with pytest.raises(RuntimeError, match='reached legacy path'):
        uc_driver.open_uc_driver('IG_PROFILE_DIR')


def test_explicit_id_still_works_for_a_non_facebook_caller(monkeypatch):
    monkeypatch.delenv('ADSPOWER_PROFILE_ID', raising=False)
    seen = {}
    monkeypatch.setattr(uc_driver, '_open_adspower_driver',
                        lambda pid: seen.setdefault('pid', pid) or _FakeDriver())
    uc_driver.open_uc_driver('IG_PROFILE_DIR', adspower_profile_id='ig-profile')
    assert seen['pid'] == 'ig-profile'


def test_explicit_id_beats_the_env_var_for_a_non_facebook_caller(monkeypatch):
    monkeypatch.setenv('ADSPOWER_PROFILE_ID', 'fb-profile')
    seen = {}
    monkeypatch.setattr(uc_driver, '_open_adspower_driver',
                        lambda pid: seen.setdefault('pid', pid) or _FakeDriver())
    uc_driver.open_uc_driver('IG_PROFILE_DIR', adspower_profile_id='ig-profile')
    assert seen['pid'] == 'ig-profile'


def test_whitespace_only_explicit_id_is_not_treated_as_a_profile(monkeypatch):
    monkeypatch.delenv('ADSPOWER_PROFILE_ID', raising=False)
    _arm_legacy_path_tripwire(monkeypatch)
    with pytest.raises(RuntimeError, match='reached legacy path'):
        uc_driver.open_uc_driver('FB_PROFILE_DIR', adspower_profile_id='   ')


def test_whitespace_only_env_id_is_not_treated_as_a_profile(monkeypatch):
    monkeypatch.setenv('ADSPOWER_PROFILE_ID', '  ')
    _arm_legacy_path_tripwire(monkeypatch)
    with pytest.raises(RuntimeError, match='reached legacy path'):
        uc_driver.open_uc_driver('FB_PROFILE_DIR')


def _patch_adspower_attach(monkeypatch, chrome):
    """Point _open_adspower_driver's lazy imports at fakes."""
    from selenium import webdriver
    monkeypatch.setattr(adspower, 'start_profile', lambda pid: {
        'debugger_address': '127.0.0.1:51234', 'webdriver_path': '',
    })
    monkeypatch.setattr(webdriver, 'Chrome', chrome)


def test_adspower_driver_carries_its_profile_id(monkeypatch):
    _patch_adspower_attach(monkeypatch, lambda **kw: _FakeDriver())
    monkeypatch.setattr(adspower, 'stop_profile',
                        lambda pid: (_ for _ in ()).throw(AssertionError('must not stop on success')))
    drv = uc_driver._open_adspower_driver('kxxxxx')
    assert drv._adspower_profile_id == 'kxxxxx'


def test_adspower_driver_stops_the_profile_when_the_attach_fails(monkeypatch):
    """A started profile with no driver attached is a leaked browser."""
    stopped = []

    def boom(**kw):
        raise RuntimeError('cannot attach to debugger address')

    _patch_adspower_attach(monkeypatch, boom)
    monkeypatch.setattr(adspower, 'stop_profile', lambda pid: stopped.append(pid))
    with pytest.raises(RuntimeError, match='cannot attach'):
        uc_driver._open_adspower_driver('kxxxxx')
    assert stopped == ['kxxxxx'], 'failed attach must not leave the profile running'


def test_adspower_attach_failure_survives_a_failing_stop(monkeypatch):
    """The original attach error is what the operator needs to see."""
    def boom(**kw):
        raise RuntimeError('cannot attach to debugger address')

    _patch_adspower_attach(monkeypatch, boom)
    monkeypatch.setattr(adspower, 'stop_profile',
                        lambda pid: (_ for _ in ()).throw(adspower.AdsPowerError('stop blew up')))
    with pytest.raises(RuntimeError, match='cannot attach'):
        uc_driver._open_adspower_driver('kxxxxx')


def test_close_driver_quits_and_stops_the_adspower_profile(monkeypatch):
    stopped = []
    monkeypatch.setattr(adspower, 'stop_profile', lambda pid: stopped.append(pid))
    drv = _FakeDriver()
    drv._adspower_profile_id = 'kxxxxx'
    uc_driver.close_driver(drv)
    assert drv.quit_calls == 1
    assert stopped == ['kxxxxx']


def test_close_driver_stops_the_profile_even_when_quit_raises(monkeypatch):
    """quit() on a debuggerAddress session detaches; if it errors we still
    have to close the browser AdsPower launched or it leaks."""
    stopped = []
    monkeypatch.setattr(adspower, 'stop_profile', lambda pid: stopped.append(pid))

    class _AngryDriver(_FakeDriver):
        def quit(self):
            raise RuntimeError('disconnected')

    drv = _AngryDriver()
    drv._adspower_profile_id = 'kxxxxx'
    uc_driver.close_driver(drv)
    assert stopped == ['kxxxxx']


def test_close_driver_swallows_a_failing_stop(monkeypatch):
    monkeypatch.setattr(adspower, 'stop_profile',
                        lambda pid: (_ for _ in ()).throw(adspower.AdsPowerError('nope')))
    drv = _FakeDriver()
    drv._adspower_profile_id = 'kxxxxx'
    uc_driver.close_driver(drv)  # teardown must never crash a finished scrape
    assert drv.quit_calls == 1


def test_close_driver_only_quits_a_plain_driver(monkeypatch):
    monkeypatch.setattr(adspower, 'stop_profile',
                        lambda pid: (_ for _ in ()).throw(AssertionError('no AdsPower profile here')))
    drv = _FakeDriver()
    uc_driver.close_driver(drv)
    assert drv.quit_calls == 1


def test_close_driver_tolerates_none():
    uc_driver.close_driver(None)


from tools.scraper.platforms import facebook as fbp


def test_open_driver_passes_account_adspower_id(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        'tools.scraper.shared.uc_driver.open_uc_driver',
        lambda env, **kw: seen.update(kw) or 'driver',
    )
    fbp._open_driver({'id': 'a', 'adspower_profile_id': 'kxxxxx'})
    assert seen['adspower_profile_id'] == 'kxxxxx'


def test_open_driver_without_account_passes_none(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        'tools.scraper.shared.uc_driver.open_uc_driver',
        lambda env, **kw: seen.update(kw) or 'driver',
    )
    fbp._open_driver()
    assert seen['adspower_profile_id'] is None


def test_open_driver_tolerates_account_without_the_column(monkeypatch):
    """Rows read before migration 057 have no adspower_profile_id key."""
    seen = {}
    monkeypatch.setattr(
        'tools.scraper.shared.uc_driver.open_uc_driver',
        lambda env, **kw: seen.update(kw) or 'driver',
    )
    fbp._open_driver({'id': 'a'})
    assert seen['adspower_profile_id'] is None
