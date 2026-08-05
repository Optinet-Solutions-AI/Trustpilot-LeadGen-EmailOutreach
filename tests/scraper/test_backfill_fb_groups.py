"""Tests for tools/scraper/backfill_fb_groups.py's aggregation logic
(_collect_groups): folds every Facebook post carrying a group_id into one
{group_id: {name, first, last, count}} entry, paginating past PostgREST's
default page size so growth past today's ~230 posts doesn't silently drop
groups seen only on a later page.
"""
from tools.scraper import backfill_fb_groups as backfill


class _FakePagedTable:
    """Mimics table('lead_platform_posts').select(...).eq(...).not_.is_(...)
    .range(offset, end).execute() — serves `all_rows` back in offset/end
    slices exactly like PostgREST's range() would."""

    def __init__(self, all_rows):
        self._all_rows = all_rows
        self._range: tuple[int, int] | None = None

    def select(self, *_a, **_kw):
        return self

    def eq(self, *_a, **_kw):
        return self

    @property
    def not_(self):
        return self

    def is_(self, *_a, **_kw):
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def execute(self):
        start, end = self._range
        class _Result:
            pass
        r = _Result()
        r.data = self._all_rows[start:end + 1]
        return r


def test_collect_groups_aggregates_name_count_and_window(monkeypatch):
    rows = [
        {'group_id': '1', 'group_name': 'Find a Tradesman Bristol', 'posted_at': '2026-06-05T00:00:00+00:00', 'scraped_at': None},
        {'group_id': '1', 'group_name': None, 'posted_at': '2026-06-09T00:00:00+00:00', 'scraped_at': None},
        {'group_id': '2', 'group_name': 'HANDYMAN SERVICES LONDON, Ontario', 'posted_at': '2026-06-01T00:00:00+00:00', 'scraped_at': None},
        {'group_id': None, 'group_name': 'no group id, must be skipped', 'posted_at': '2026-06-01T00:00:00+00:00', 'scraped_at': None},
    ]
    monkeypatch.setattr(backfill, 'table', lambda name: _FakePagedTable(rows))
    monkeypatch.setattr(backfill, '_PAGE_SIZE', 1000)

    groups = backfill._collect_groups()

    assert set(groups.keys()) == {'1', '2'}
    assert groups['1']['count'] == 2
    assert groups['1']['name'] == 'Find a Tradesman Bristol'  # first non-null name wins
    assert groups['1']['first'] == '2026-06-05T00:00:00+00:00'
    assert groups['1']['last'] == '2026-06-09T00:00:00+00:00'
    assert groups['2']['name'] == 'HANDYMAN SERVICES LONDON, Ontario'
    assert groups['2']['count'] == 1


def test_collect_groups_paginates_past_page_size(monkeypatch):
    # 5 rows, all distinct groups, page size 2 -> 3 pages (2, 2, 1).
    rows = [
        {'group_id': str(i), 'group_name': f'Group {i}', 'posted_at': f'2026-06-0{i}T00:00:00+00:00', 'scraped_at': None}
        for i in range(1, 6)
    ]
    monkeypatch.setattr(backfill, 'table', lambda name: _FakePagedTable(rows))
    monkeypatch.setattr(backfill, '_PAGE_SIZE', 2)

    groups = backfill._collect_groups()

    assert len(groups) == 5
    assert set(groups.keys()) == {'1', '2', '3', '4', '5'}


def test_collect_groups_falls_back_to_scraped_at_when_posted_at_missing(monkeypatch):
    rows = [
        {'group_id': '1', 'group_name': 'Group', 'posted_at': None, 'scraped_at': '2026-07-01T00:00:00+00:00'},
    ]
    monkeypatch.setattr(backfill, 'table', lambda name: _FakePagedTable(rows))
    monkeypatch.setattr(backfill, '_PAGE_SIZE', 1000)

    groups = backfill._collect_groups()

    assert groups['1']['first'] == groups['1']['last'] == '2026-07-01T00:00:00+00:00'
