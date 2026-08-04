"""Upsert-path tests: no NEW lead may add to the category fragmentation.

Both write paths (the legacy Trustpilot bulk upsert and the presence-first
multi-platform path) must canonicalise `category` before the row is built.
Fully offline — the Supabase table() accessor is replaced with a recorder.

Run with: pytest tools/db/test_upsert_leads_category.py -v
"""
from __future__ import annotations

import os
import sys
from typing import Any

import pytest

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from tools.db import upsert_leads as mod  # noqa: E402


class _Result:
    def __init__(self, data: Any) -> None:
        self.data = data


class _FakeQuery:
    """Chainable stand-in for a PostgREST query builder."""

    def __init__(self, recorder: '_Recorder', table_name: str) -> None:
        self._recorder = recorder
        self._table = table_name
        self._op: str | None = None
        self._payload: Any = None

    # ── chainers ──
    def select(self, *_args: Any, **_kwargs: Any) -> '_FakeQuery':
        self._op = 'select'
        return self

    def eq(self, *_args: Any) -> '_FakeQuery':
        return self

    def limit(self, *_args: Any) -> '_FakeQuery':
        return self

    def range(self, *_args: Any) -> '_FakeQuery':
        return self

    # ── writers ──
    def insert(self, payload: Any) -> '_FakeQuery':
        self._op, self._payload = 'insert', payload
        return self

    def update(self, payload: Any) -> '_FakeQuery':
        self._op, self._payload = 'update', payload
        return self

    def upsert(self, payload: Any, **_kwargs: Any) -> '_FakeQuery':
        self._op, self._payload = 'upsert', payload
        return self

    def execute(self) -> _Result:
        assert self._op is not None
        if self._op != 'select':
            self._recorder.writes.append((self._table, self._op, self._payload))
        return _Result(self._recorder.response(self._table, self._op, self._payload))


class _Recorder:
    """Captures every write and hands back plausible PostgREST responses."""

    def __init__(self) -> None:
        self.writes: list[tuple[str, str, Any]] = []
        self._next_id = 0

    def __call__(self, table_name: str) -> _FakeQuery:
        return _FakeQuery(self, table_name)

    def response(self, table_name: str, op: str, payload: Any) -> Any:
        if op == 'select':
            return []  # no existing presence -> the insert branch
        if table_name == 'leads' and op == 'insert':
            self._next_id += 1
            return [{'id': f'lead-{self._next_id}'}]
        if table_name == 'leads' and op == 'upsert':
            rows = payload if isinstance(payload, list) else [payload]
            out = []
            for row in rows:
                self._next_id += 1
                out.append({'id': f'lead-{self._next_id}', 'trustpilot_url': row.get('trustpilot_url')})
            return out
        return payload if isinstance(payload, list) else [payload]

    def rows_written_to(self, table_name: str) -> list[dict]:
        rows: list[dict] = []
        for name, _op, payload in self.writes:
            if name != table_name:
                continue
            rows.extend(payload if isinstance(payload, list) else [payload])
        return rows


@pytest.fixture()
def recorder(monkeypatch: pytest.MonkeyPatch) -> _Recorder:
    rec = _Recorder()
    monkeypatch.setattr(mod, 'table', rec)
    # Never touch the network to validate Trustpilot URLs in a unit test.
    monkeypatch.setattr(mod, '_VALIDATE_LINKS', False)
    return rec


# ───────────────── multi-platform path (Facebook / Yelp / TA) ──────────────

def test_facebook_niche_is_canonicalised_on_write(recorder: _Recorder) -> None:
    """The FB scraper writes the operator's typed niche verbatim."""
    mod.upsert_leads([{
        'platform': 'facebook',
        'profile_url': 'https://facebook.com/acme-plumbing',
        'company_name': 'Acme Plumbing',
        'category': 'plumbing',
        'country': 'GB',
    }])
    rows = recorder.rows_written_to('leads')
    assert len(rows) == 1
    assert rows[0]['category'] == 'plumber'


def test_yelp_search_slug_lands_on_the_same_label(recorder: _Recorder) -> None:
    """Yelp's 'plumbers' and Facebook's 'plumbing' must converge — that is the
    whole point of canonicalising on write."""
    mod.upsert_leads([
        {'platform': 'yelp', 'profile_url': 'https://yelp.com/biz/a', 'company_name': 'A', 'category': 'plumbers'},
        {'platform': 'facebook', 'profile_url': 'https://facebook.com/b', 'company_name': 'B', 'category': 'plumber'},
        {'platform': 'tripadvisor', 'profile_url': 'https://tripadvisor.com/c', 'company_name': 'C', 'category': 'plumbing'},
    ])
    categories = {row['category'] for row in recorder.rows_written_to('leads')}
    assert categories == {'plumber'}


def test_operator_free_text_is_slugified_on_write(recorder: _Recorder) -> None:
    mod.upsert_leads([{
        'platform': 'facebook',
        'profile_url': 'https://facebook.com/pools',
        'company_name': 'Pools',
        'category': 'Pool Cleaning',
    }])
    assert recorder.rows_written_to('leads')[0]['category'] == 'pool_cleaning'


def test_unsafe_category_is_written_unchanged(recorder: _Recorder) -> None:
    """A gambling label must survive the write byte-for-byte."""
    mod.upsert_leads([{
        'platform': 'yelp',
        'profile_url': 'https://yelp.com/biz/casino',
        'company_name': 'Casino',
        'category': 'online_casino_or_bookmaker',
    }])
    assert recorder.rows_written_to('leads')[0]['category'] == 'online_casino_or_bookmaker'


def test_missing_category_stays_absent(recorder: _Recorder) -> None:
    """None must be stripped, not written as a null that clobbers a re-scrape."""
    mod.upsert_leads([{
        'platform': 'yelp',
        'profile_url': 'https://yelp.com/biz/no-cat',
        'company_name': 'No Cat',
    }])
    assert 'category' not in recorder.rows_written_to('leads')[0]


# ─────────────────────── legacy Trustpilot bulk path ──────────────────────

def test_trustpilot_path_canonicalises_category(recorder: _Recorder) -> None:
    mod.upsert_leads([{
        'trustpilot_url': 'https://www.trustpilot.com/review/acme-electric.com',
        'company_name': 'Acme Electric',
        'category': 'electricians',
        'country': 'GB',
    }])
    rows = recorder.rows_written_to('leads')
    assert len(rows) == 1
    assert rows[0]['category'] == 'electrician'


def test_trustpilot_path_leaves_gambling_alone(recorder: _Recorder) -> None:
    mod.upsert_leads([{
        'trustpilot_url': 'https://www.trustpilot.com/review/bigwin.com',
        'company_name': 'BigWin',
        'category': 'gambling_house',
    }])
    assert recorder.rows_written_to('leads')[0]['category'] == 'gambling_house'
