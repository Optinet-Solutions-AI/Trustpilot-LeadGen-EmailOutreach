"""Tests that the non-Trustpilot upsert carries `profile_claimed` into `leads`.

An UNCLAIMED listing is the highest-converting cold-outreach target — nobody
is monitoring that profile, so a pitch lands fresh. The column has existed
since migration 022 and the Trustpilot pipeline always wrote it, but the
non-Trustpilot path (Yelp, TripAdvisor, and every future plugin) dropped it
on the floor, so those leads always reached the CRM with it NULL.

It went unnoticed while claim status came from a ScrapingBee HTML parse that
only ran for the top 25 leads of a run. The Apify path returns it for every
business, which is what made the omission obvious.
"""
from tools.db import upsert_leads as ul


class _FakeQuery:
    """Chainable postgrest-shaped fake. Records inserts/updates per table."""

    def __init__(self, store, name):
        self._store = store
        self._name = name
        self._wrote = False

    def select(self, *_a, **_kw):
        return self

    def eq(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def insert(self, payload):
        self._store.setdefault(self._name, []).append(('insert', payload))
        self._wrote = True
        return self

    def update(self, payload):
        self._store.setdefault(self._name, []).append(('update', payload))
        self._wrote = True
        return self

    def upsert(self, payload, **_kw):
        self._store.setdefault(self._name, []).append(('upsert', payload))
        self._wrote = True
        return self

    def execute(self):
        # A read against lead_platform_presences is the "has this profile been
        # seen before" lookup — empty means a brand-new lead. Anything we
        # actually wrote comes back carrying the new id.
        if not self._wrote:
            return type('R', (), {'data': []})()
        return type('R', (), {'data': [{'id': 'lead-1'}]})()


def _run(lead, monkeypatch):
    store: dict = {}
    monkeypatch.setattr(ul, 'table', lambda name: _FakeQuery(store, name))
    lead_id, _ = ul._upsert_nontrustpilot_lead(lead, '2026-08-14T00:00:00Z')
    rows = [payload for _op, payload in store.get('leads', [])]
    return lead_id, (rows[0] if rows else {})


def _yelp_lead(**over):
    base = {
        'platform': 'yelp',
        'profile_url': 'https://www.yelp.com/biz/example-plumbing',
        'name': 'Example Plumbing',
        'country': 'US',
        'category': 'plumbers',
        'rating': 3.2,
    }
    base.update(over)
    return base


def test_unclaimed_listing_reaches_the_leads_row(monkeypatch):
    # False is the money case: it means Yelp says nobody has claimed this.
    _, row = _run(_yelp_lead(profile_claimed=False), monkeypatch)
    assert row.get('profile_claimed') is False


def test_claimed_listing_is_recorded_too(monkeypatch):
    _, row = _run(_yelp_lead(profile_claimed=True), monkeypatch)
    assert row.get('profile_claimed') is True


def test_unknown_claim_status_is_omitted_not_written_as_false(monkeypatch):
    """None means "this source doesn't report claim status" and must not be
    written — otherwise a source that can't see it would overwrite a real
    False from an earlier scrape, turning "nobody has claimed this" into
    "claimed"."""
    _, row = _run(_yelp_lead(profile_claimed=None), monkeypatch)
    assert 'profile_claimed' not in row
