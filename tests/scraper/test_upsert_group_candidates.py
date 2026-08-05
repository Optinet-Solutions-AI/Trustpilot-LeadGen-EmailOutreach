"""Tests for tools/db/upsert_group_candidates.py — the merge-safe upsert
shared by real-time capture (upsert_leads.py) and the one-off backfill
(backfill_fb_groups.py). Covers: insert-when-absent, name filled only when
missing, and the first/last-seen window only ever widening — never
clobbering status/niche/location/relevance_tier on an existing row.
"""
from tools.db import upsert_group_candidates as ugc


class _FakeTable:
    """Minimal chainable fake mirroring the postgrest query-builder shape
    used elsewhere in this codebase (select/eq/limit/insert/update/execute).
    Records every insert/update payload for assertions.
    """

    def __init__(self, existing_rows):
        self._existing_rows = existing_rows
        self.inserted: list[dict] = []
        self.updated: list[tuple[str, dict]] = []
        self._pending_update_id = None
        self._filters: dict = {}

    def select(self, *_a, **_kw):
        return self

    def eq(self, col, val):
        self._filters[col] = val
        if col == 'id':
            self._pending_update_id = val
        return self

    def limit(self, *_a, **_kw):
        return self

    def insert(self, row):
        self.inserted.append(row)
        return self

    def update(self, patch):
        self._pending_patch = patch
        return self

    def execute(self):
        class _Result:
            pass

        result = _Result()
        if self._pending_update_id is not None:
            self.updated.append((self._pending_update_id, self._pending_patch))
            result.data = [dict(self._pending_patch)]
            self._pending_update_id = None
        else:
            # select().eq(platform).eq(group_id).limit().execute() lookup path
            gid = self._filters.get('group_id')
            result.data = [r for r in self._existing_rows if r['group_id'] == gid]
        return result


def test_inserts_new_group_when_absent(monkeypatch):
    fake = _FakeTable(existing_rows=[])
    monkeypatch.setattr(ugc, 'table', lambda name: fake)

    ugc.upsert_group_candidate(
        platform='facebook', group_id='123', name='Find a Tradesman Bristol',
        seen_at='2026-06-01T00:00:00+00:00',
    )

    assert len(fake.inserted) == 1
    row = fake.inserted[0]
    assert row['group_id'] == '123'
    assert row['name'] == 'Find a Tradesman Bristol'
    assert row['first_seen_at'] == row['last_seen_at'] == '2026-06-01T00:00:00+00:00'
    assert fake.updated == []


def test_existing_row_only_widens_the_seen_window(monkeypatch):
    existing = [{
        'id': 'row-1', 'group_id': '123', 'name': 'Old Name',
        'first_seen_at': '2026-06-05T00:00:00+00:00',
        'last_seen_at': '2026-06-05T00:00:00+00:00',
    }]
    fake = _FakeTable(existing_rows=existing)
    monkeypatch.setattr(ugc, 'table', lambda name: fake)

    # A later post: last_seen_at should move forward, first_seen_at untouched.
    ugc.upsert_group_candidate(
        platform='facebook', group_id='123', name='New Name',
        seen_at='2026-06-10T00:00:00+00:00',
    )

    assert fake.inserted == []
    assert len(fake.updated) == 1
    _id, patch = fake.updated[0]
    assert _id == 'row-1'
    assert patch == {'last_seen_at': '2026-06-10T00:00:00+00:00'}
    # Name is NOT overwritten — an existing name always wins.
    assert 'name' not in patch


def test_earlier_post_widens_first_seen_at_only(monkeypatch):
    existing = [{
        'id': 'row-1', 'group_id': '123', 'name': 'Group',
        'first_seen_at': '2026-06-05T00:00:00+00:00',
        'last_seen_at': '2026-06-05T00:00:00+00:00',
    }]
    fake = _FakeTable(existing_rows=existing)
    monkeypatch.setattr(ugc, 'table', lambda name: fake)

    ugc.upsert_group_candidate(
        platform='facebook', group_id='123', name=None,
        seen_at='2026-06-01T00:00:00+00:00',
    )

    assert len(fake.updated) == 1
    _id, patch = fake.updated[0]
    assert patch == {'first_seen_at': '2026-06-01T00:00:00+00:00'}


def test_fills_missing_name_but_never_overwrites_niche_location_status(monkeypatch):
    """The row already carries operator-set fields (status/niche/location/
    relevance_tier from an earlier browser crawl or the labelling job) that
    this module must never touch — only `name` may be filled when absent."""
    existing = [{
        'id': 'row-1', 'group_id': '123', 'name': None,
        'first_seen_at': '2026-06-05T00:00:00+00:00',
        'last_seen_at': '2026-06-05T00:00:00+00:00',
    }]
    fake = _FakeTable(existing_rows=existing)
    monkeypatch.setattr(ugc, 'table', lambda name: fake)

    ugc.upsert_group_candidate(
        platform='facebook', group_id='123', name='Discovered Name',
        seen_at='2026-06-05T00:00:00+00:00',  # same instant — window doesn't move
    )

    assert len(fake.updated) == 1
    _id, patch = fake.updated[0]
    assert patch == {'name': 'Discovered Name'}


def test_no_op_when_nothing_new(monkeypatch):
    existing = [{
        'id': 'row-1', 'group_id': '123', 'name': 'Group',
        'first_seen_at': '2026-06-05T00:00:00+00:00',
        'last_seen_at': '2026-06-05T00:00:00+00:00',
    }]
    fake = _FakeTable(existing_rows=existing)
    monkeypatch.setattr(ugc, 'table', lambda name: fake)

    ugc.upsert_group_candidate(
        platform='facebook', group_id='123', name='Group',
        seen_at='2026-06-05T00:00:00+00:00',
    )

    assert fake.inserted == []
    assert fake.updated == []


def test_missing_required_args_is_a_silent_noop(monkeypatch):
    fake = _FakeTable(existing_rows=[])
    monkeypatch.setattr(ugc, 'table', lambda name: fake)

    ugc.upsert_group_candidate(platform='facebook', group_id='', name='x', seen_at='2026-06-05T00:00:00+00:00')
    ugc.upsert_group_candidate(platform='facebook', group_id='123', name='x', seen_at='')

    assert fake.inserted == []
    assert fake.updated == []
