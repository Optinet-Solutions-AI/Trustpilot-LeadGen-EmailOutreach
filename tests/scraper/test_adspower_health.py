from tools.scraper.shared import adspower


def test_health_check_true_when_status_ok(monkeypatch):
    monkeypatch.setattr(adspower, '_call', lambda path, params: {'ok': True})
    assert adspower.health_check() is True


def test_health_check_false_when_api_unreachable(monkeypatch):
    def boom(path, params):
        raise adspower.AdsPowerError('unreachable')
    monkeypatch.setattr(adspower, '_call', boom)
    assert adspower.health_check() is False
