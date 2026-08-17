from types import SimpleNamespace
import pytest
from tools.scraper import fleet_session as fs


class _Query:
    """Minimal chainable stand-in for the supabase query builder."""
    def __init__(self, rows):
        self._rows = rows
    def select(self, *a, **k): return self
    def eq(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def execute(self): return SimpleNamespace(data=self._rows)


def test_open_by_profile_id_returns_cdp(monkeypatch):
    monkeypatch.setattr(fs.adspower, 'health_check', lambda: True)
    monkeypatch.setattr(fs.adspower, 'start_profile',
                        lambda pid: {'debugger_address': '127.0.0.1:9222', 'webdriver_path': 'C:/cd.exe'})
    out = fs.open_account_session(profile_id='k1flq0bx')
    assert out['cdp_address'] == '127.0.0.1:9222'
    assert out['profile_id'] == 'k1flq0bx'
    assert out['webdriver_path'] == 'C:/cd.exe'


def test_raises_when_api_down(monkeypatch):
    monkeypatch.setattr(fs.adspower, 'health_check', lambda: False)
    with pytest.raises(fs.FleetSessionError):
        fs.open_account_session(profile_id='k1flq0bx')


def test_resolves_profile_from_account(monkeypatch):
    monkeypatch.setattr(fs, 'table',
                        lambda name: _Query([{'adspower_profile_id': 'p1', 'status': 'active', 'country': 'GB'}]))
    monkeypatch.setattr(fs.adspower, 'health_check', lambda: True)
    monkeypatch.setattr(fs.adspower, 'start_profile',
                        lambda pid: {'debugger_address': '127.0.0.1:9333', 'webdriver_path': ''})
    out = fs.open_account_session(account_id='acc-1')
    assert out['profile_id'] == 'p1'
    assert out['cdp_address'] == '127.0.0.1:9333'
    assert out['country'] == 'GB'


def test_raises_when_account_has_no_profile(monkeypatch):
    monkeypatch.setattr(fs, 'table',
                        lambda name: _Query([{'adspower_profile_id': None, 'status': 'active', 'country': 'GB'}]))
    monkeypatch.setattr(fs.adspower, 'health_check', lambda: True)
    with pytest.raises(fs.FleetSessionError):
        fs.open_account_session(account_id='acc-1')


def test_raises_when_account_not_active(monkeypatch):
    monkeypatch.setattr(fs, 'table',
                        lambda name: _Query([{'adspower_profile_id': 'p1', 'status': 'checkpoint', 'country': 'GB'}]))
    with pytest.raises(fs.FleetSessionError):
        fs.open_account_session(account_id='acc-1')


def test_raises_when_both_account_and_profile_given():
    with pytest.raises(fs.FleetSessionError):
        fs.open_account_session(account_id='acc-1', profile_id='k1flq0bx')


def test_port_from_cdp_address_parses_port():
    assert fs.port_from_cdp_address('127.0.0.1:9222') == 9222
    assert fs.port_from_cdp_address('localhost:50325') == 50325


def test_port_from_cdp_address_rejects_malformed():
    with pytest.raises(fs.FleetSessionError):
        fs.port_from_cdp_address('no-colon-here')
    with pytest.raises(fs.FleetSessionError):
        fs.port_from_cdp_address('127.0.0.1:notaport')


def test_close_account_session_by_profile_stops_it(monkeypatch):
    stopped = []
    monkeypatch.setattr(fs.adspower, 'stop_profile', lambda pid: stopped.append(pid))
    fs.close_account_session(profile_id='k1flq0bx')
    assert stopped == ['k1flq0bx']


def test_close_account_session_resolves_account(monkeypatch):
    monkeypatch.setattr(fs, 'table',
                        lambda name: _Query([{'adspower_profile_id': 'p1', 'status': 'active', 'country': 'GB'}]))
    stopped = []
    monkeypatch.setattr(fs.adspower, 'stop_profile', lambda pid: stopped.append(pid))
    fs.close_account_session(account_id='acc-1')
    assert stopped == ['p1']


def test_close_account_session_rejects_both_and_neither(monkeypatch):
    with pytest.raises(fs.FleetSessionError):
        fs.close_account_session()
    with pytest.raises(fs.FleetSessionError):
        fs.close_account_session(account_id='a', profile_id='p')


def test_create_prints_new_profile_id(monkeypatch, capsys):
    monkeypatch.setattr(fs.adspower, 'create_profile', lambda **kw: 'knew1')
    rc = fs.main_with_args(['--create', '--country', 'GB', '--proxy-json', '{}'])
    assert rc == 0
    assert capsys.readouterr().out.strip() == 'knew1'


def test_create_requires_country(monkeypatch, capsys):
    rc = fs.main_with_args(['--create'])
    assert rc == 1
    assert 'FLEET SESSION FAILED' in capsys.readouterr().err


def test_main_with_args_requires_an_action(capsys):
    with pytest.raises(SystemExit):
        fs.main_with_args([])


# ── has_fb_session (pure helper) ──────────────────────────────────────────

def test_has_fb_session_true_when_c_user_present():
    cookies = [
        {'name': 'datr', 'value': 'abc'},
        {'name': 'c_user', 'value': '100012345678901'},
    ]
    assert fs.has_fb_session(cookies) is True


def test_has_fb_session_false_when_c_user_missing():
    cookies = [{'name': 'datr', 'value': 'abc'}, {'name': 'sb', 'value': 'xyz'}]
    assert fs.has_fb_session(cookies) is False


def test_has_fb_session_false_when_c_user_value_empty():
    cookies = [{'name': 'c_user', 'value': ''}]
    assert fs.has_fb_session(cookies) is False


def test_has_fb_session_false_when_c_user_value_whitespace():
    cookies = [{'name': 'c_user', 'value': '   '}]
    assert fs.has_fb_session(cookies) is False


def test_has_fb_session_false_for_empty_or_none_list():
    assert fs.has_fb_session([]) is False
    assert fs.has_fb_session(None) is False


def test_has_fb_session_ignores_cookies_missing_name_or_value_keys():
    # Malformed cookie dicts must not raise — .get() defaults keep this safe.
    cookies = [{'value': '123'}, {'name': 'c_user'}]
    assert fs.has_fb_session(cookies) is False


# ── check_fb_login (attach + read cookies) ────────────────────────────────

class _FakeDriver:
    def __init__(self, cookies, raise_on_get=False):
        self._cookies = cookies
        self._raise_on_get = raise_on_get
        self.quit_called = False

    def get(self, url):
        if self._raise_on_get:
            raise RuntimeError('navigation timed out')

    def get_cookies(self):
        return self._cookies

    def quit(self):
        self.quit_called = True


def test_check_fb_login_true_when_session_cookie_present(monkeypatch):
    driver = _FakeDriver([{'name': 'c_user', 'value': '123'}])
    monkeypatch.setattr(fs.uc_driver, '_open_adspower_driver', lambda pid: driver)
    assert fs.check_fb_login(profile_id='p1') is True
    assert driver.quit_called is True


def test_check_fb_login_false_when_session_cookie_absent(monkeypatch):
    driver = _FakeDriver([{'name': 'datr', 'value': 'abc'}])
    monkeypatch.setattr(fs.uc_driver, '_open_adspower_driver', lambda pid: driver)
    assert fs.check_fb_login(profile_id='p1') is False
    assert driver.quit_called is True


def test_check_fb_login_fails_closed_on_attach_error(monkeypatch):
    def _boom(pid):
        raise RuntimeError('AdsPower Local API unreachable')
    monkeypatch.setattr(fs.uc_driver, '_open_adspower_driver', _boom)
    assert fs.check_fb_login(profile_id='p1') is False


def test_check_fb_login_fails_closed_on_navigation_error(monkeypatch):
    driver = _FakeDriver([{'name': 'c_user', 'value': '123'}], raise_on_get=True)
    monkeypatch.setattr(fs.uc_driver, '_open_adspower_driver', lambda pid: driver)
    assert fs.check_fb_login(profile_id='p1') is False
    # Detach must still happen even though navigation failed.
    assert driver.quit_called is True


def test_check_fb_login_resolves_profile_from_account(monkeypatch):
    monkeypatch.setattr(fs, 'table',
                        lambda name: _Query([{'adspower_profile_id': 'p1', 'status': 'active', 'country': 'GB'}]))
    driver = _FakeDriver([{'name': 'c_user', 'value': '123'}])
    seen_pid = {}
    def _open(pid):
        seen_pid['pid'] = pid
        return driver
    monkeypatch.setattr(fs.uc_driver, '_open_adspower_driver', _open)
    assert fs.check_fb_login(account_id='acc-1') is True
    assert seen_pid['pid'] == 'p1'


def test_check_fb_login_rejects_both_and_neither():
    with pytest.raises(fs.FleetSessionError):
        fs.check_fb_login()
    with pytest.raises(fs.FleetSessionError):
        fs.check_fb_login(account_id='a', profile_id='p')


def test_check_fb_login_does_not_stop_the_profile(monkeypatch):
    # Regression guard: the caller (the worker) stops the profile itself
    # afterward — check_fb_login must only detach (driver.quit()), never
    # call adspower.stop_profile.
    driver = _FakeDriver([{'name': 'c_user', 'value': '123'}])
    monkeypatch.setattr(fs.uc_driver, '_open_adspower_driver', lambda pid: driver)
    stop_calls = []
    monkeypatch.setattr(fs.adspower, 'stop_profile', lambda pid: stop_calls.append(pid))
    fs.check_fb_login(profile_id='p1')
    assert stop_calls == []


# ── --check-fb-login CLI wiring ────────────────────────────────────────────

def test_cli_check_fb_login_prints_logged_in(monkeypatch, capsys):
    monkeypatch.setattr(fs, 'check_fb_login', lambda **kw: True)
    rc = fs.main_with_args(['--profile', 'p1', '--check-fb-login'])
    assert rc == 0
    assert capsys.readouterr().out.strip() == 'LOGGED_IN'


def test_cli_check_fb_login_prints_not_logged_in(monkeypatch, capsys):
    monkeypatch.setattr(fs, 'check_fb_login', lambda **kw: False)
    rc = fs.main_with_args(['--profile', 'p1', '--check-fb-login'])
    assert rc == 0
    assert capsys.readouterr().out.strip() == 'NOT_LOGGED_IN'


def test_cli_check_fb_login_exits_zero_and_prints_not_logged_in_on_error(monkeypatch, capsys):
    def _boom(**kw):
        raise fs.FleetSessionError('no profile bound')
    monkeypatch.setattr(fs, 'check_fb_login', _boom)
    rc = fs.main_with_args(['--profile', 'p1', '--check-fb-login'])
    assert rc == 0
    captured = capsys.readouterr()
    assert captured.out.strip() == 'NOT_LOGGED_IN'
    assert 'FLEET SESSION FAILED' in captured.err


def test_cli_check_fb_login_does_not_require_account_or_profile():
    # --check-fb-login alone must not trip the "one of ... is required"
    # argparse error — the (missing-account) failure is check_fb_login's
    # own FleetSessionError, caught and turned into NOT_LOGGED_IN/exit 0.
    rc = fs.main_with_args(['--check-fb-login'])
    assert rc == 0
