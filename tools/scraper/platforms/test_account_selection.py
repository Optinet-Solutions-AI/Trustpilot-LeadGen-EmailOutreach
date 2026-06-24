"""Unit tests for FB account country resolution + country-filtered claim.

Run from repo root:
    ./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_account_selection.py -v
"""
from tools.scraper.platforms.facebook import _target_country_from_filters


def test_explicit_country_iso_wins():
    assert _target_country_from_filters({'country': 'us'}) == 'US'
    assert _target_country_from_filters({'country': 'DE', 'location': 'Paris'}) == 'DE'


def test_location_city_maps_to_country():
    # Frankfurt is in CITY_TO_COUNTRY → DE
    assert _target_country_from_filters({'location': 'Frankfurt'}) == 'DE'


def test_unresolvable_returns_none():
    assert _target_country_from_filters({}) is None
    assert _target_country_from_filters({'location': 'Atlantis'}) is None


import types
import tools.scraper.platforms.facebook as fb


class _FakeQuery:
    """Minimal chainable stand-in for the postgrest query builder.
    Records .eq() calls so we can assert the country filter was applied."""
    def __init__(self, rows, eq_log):
        self._rows = rows
        self._eq_log = eq_log
    def select(self, *_a, **_k): return self
    def eq(self, col, val):
        self._eq_log.append((col, val))
        if col == 'country':
            self._rows = [r for r in self._rows if r.get('country') == val]
        elif col == 'status':
            self._rows = [r for r in self._rows if r.get('status') == val]
        elif col == 'platform':
            self._rows = [r for r in self._rows if r.get('platform') == val]
        return self
    def order(self, *_a, **_k): return self
    def limit(self, *_a, **_k): return self
    def update(self, *_a, **_k): return self
    def execute(self):
        return types.SimpleNamespace(data=list(self._rows))


def _install_fake_table(monkeypatch, rows):
    eq_log: list = []
    monkeypatch.setattr(fb, 'table', lambda _name: _FakeQuery(rows, eq_log))
    return eq_log


def _acct(**kw):
    base = dict(id='x', platform='facebook', handle='h', daily_cap=50, hourly_cap=10,
                used_today=0, used_this_hour=0, encrypted_cookies='c', last_used_at=None,
                status='active', country='US')
    base.update(kw)
    return base


def test_claim_filters_by_country(monkeypatch):
    rows = [_acct(id='us', country='US'), _acct(id='de', country='DE')]
    eq_log = _install_fake_table(monkeypatch, rows)
    got = fb._claim_account('facebook', country='DE')
    assert got is not None and got['id'] == 'de'
    assert ('country', 'DE') in eq_log


def test_claim_no_account_for_country_returns_none(monkeypatch):
    rows = [_acct(id='us', country='US')]
    _install_fake_table(monkeypatch, rows)
    assert fb._claim_account('facebook', country='JP') is None


def test_claim_without_country_is_unfiltered(monkeypatch):
    rows = [_acct(id='us', country='US')]
    eq_log = _install_fake_table(monkeypatch, rows)
    got = fb._claim_account('facebook')
    assert got is not None and got['id'] == 'us'
    assert all(c != 'country' for c, _ in eq_log)
