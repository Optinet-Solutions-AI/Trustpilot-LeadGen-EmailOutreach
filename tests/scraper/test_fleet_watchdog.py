# tests/scraper/test_fleet_watchdog.py
from tools.scraper import fleet_watchdog as fw


def test_returns_ok_when_api_healthy(monkeypatch):
    launched = []
    monkeypatch.setattr(fw.adspower, 'health_check', lambda: True)
    monkeypatch.setattr(fw.subprocess, 'Popen', lambda *a, **k: launched.append(a))
    assert fw.check_and_recover(['AdsPower.exe']) == 'ok'
    assert launched == []  # healthy → never relaunches


def test_recovers_when_api_down_then_up(monkeypatch):
    states = iter([False, True])  # down initially, up after relaunch
    monkeypatch.setattr(fw.adspower, 'health_check', lambda: next(states))
    monkeypatch.setattr(fw.subprocess, 'Popen', lambda *a, **k: None)
    monkeypatch.setattr(fw.time, 'sleep', lambda s: None)
    assert fw.check_and_recover(['AdsPower.exe'], wait_seconds=10, poll_interval=1) == 'recovered'


def test_failed_when_api_stays_down(monkeypatch):
    monkeypatch.setattr(fw.adspower, 'health_check', lambda: False)
    monkeypatch.setattr(fw.subprocess, 'Popen', lambda *a, **k: None)
    monkeypatch.setattr(fw.time, 'sleep', lambda s: None)
    assert fw.check_and_recover(['AdsPower.exe'], wait_seconds=3, poll_interval=1) == 'failed'


def test_failed_when_launch_command_missing(monkeypatch):
    def _boom(*a, **k):
        raise FileNotFoundError('no such exe')
    monkeypatch.setattr(fw.adspower, 'health_check', lambda: False)
    monkeypatch.setattr(fw.subprocess, 'Popen', _boom)
    assert fw.check_and_recover(['C:/nope/AdsPower.exe']) == 'failed'
