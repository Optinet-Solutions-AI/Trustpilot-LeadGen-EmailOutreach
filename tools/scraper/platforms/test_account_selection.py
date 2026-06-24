"""Unit tests for FB account country resolution + country-filtered claim.

Run from repo root:
    ./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_account_selection.py -v
"""
import types

import tools.scraper.platforms.facebook as fb
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


def test_claim_or_raise_message_names_country(monkeypatch):
    _install_fake_table(monkeypatch, [_acct(id='us', country='US')])
    scraper = fb.FacebookScraper()
    try:
        scraper._claim_or_raise(country='JP')
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert 'JP' in str(e)


# ── New tests: env-based country resolution (Edit 2) ─────────────────────────

def test_target_country_from_env_resolves(monkeypatch):
    """SCRAPE_TARGET_FILTERS env var carries target country to enrich phase."""
    monkeypatch.setenv('SCRAPE_TARGET_FILTERS', '{"country":"de"}')
    assert fb._target_country_from_env() == 'DE'


def test_target_country_from_env_none_when_unset(monkeypatch):
    """Returns None when env var absent or contains invalid JSON."""
    monkeypatch.delenv('SCRAPE_TARGET_FILTERS', raising=False)
    assert fb._target_country_from_env() is None
    # Invalid JSON must also return None, not raise
    monkeypatch.setenv('SCRAPE_TARGET_FILTERS', 'not json')
    assert fb._target_country_from_env() is None


def test_claim_or_raise_uses_env_country(monkeypatch):
    """_claim_or_raise falls back to SCRAPE_TARGET_FILTERS when module global is None.

    This is the critical cross-process path: listing sets _TARGET_COUNTRY,
    enrich runs in a SEPARATE process where the global is None, so the env
    var must be the fallback that keeps account+proxy country-consistent.
    """
    rows = [_acct(id='us', country='US'), _acct(id='de', country='DE')]
    _install_fake_table(monkeypatch, rows)
    monkeypatch.setenv('SCRAPE_TARGET_FILTERS', '{"country":"DE"}')
    # Clear module global so env is the only source
    monkeypatch.setattr(fb, '_TARGET_COUNTRY', None)
    scraper = fb.FacebookScraper()
    got = scraper._claim_or_raise()
    assert got is not None and got['id'] == 'de'


def test_claim_or_raise_fails_closed_when_country_unresolved(monkeypatch):
    """_claim_or_raise must REFUSE (not silently pick any account) when country is unresolvable.

    Without a country we cannot guarantee geo-consistency: the PH-pinned account
    would be selected for non-PH targets. Fail closed so the caller is forced to
    supply a resolvable country filter.
    """
    _install_fake_table(monkeypatch, [_acct(id='ph', country='PH')])
    monkeypatch.setattr(fb, '_TARGET_COUNTRY', None)
    monkeypatch.delenv('SCRAPE_TARGET_FILTERS', raising=False)
    scraper = fb.FacebookScraper()
    try:
        scraper._claim_or_raise()  # no country anywhere — must raise
        assert False, "expected RuntimeError (fail closed)"
    except RuntimeError as e:
        assert 'target country' in str(e).lower()
