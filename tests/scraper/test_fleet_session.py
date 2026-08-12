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
