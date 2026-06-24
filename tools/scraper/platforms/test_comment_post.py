"""Unit tests for FB comment-post and draft-comment CLI actions.

Run from repo root:
    ./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_comment_post.py -v

Tests that ARE unit-testable (no browser / no network):
  - Comment-cap guard: post_comment returns early without opening a browser.
  - _load_account_by_id: raises RuntimeError when the account row is missing.
  - draft-comment CLI action: prints the correct JSON to stdout.

Selenium / FB comment composer interaction is NOT tested here — it is
marked LIVE-DISCOVERY in facebook.py and requires a real FB session on
james@optiratesolutions.net to verify selectors.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import types

import tools.scraper.platforms.facebook as fb
from tools.scraper.platforms.facebook import _load_account_by_id
from tools.scraper.run import _run_draft_comment


# ── Helpers ─────────────────────────────────────────────────────────────────

def _fake_account(**overrides) -> dict:
    """Return a minimal social_accounts row dict suitable for testing."""
    base = dict(
        id='test-acct-id',
        platform='facebook',
        handle='james',
        status='active',
        country='GB',
        proxy_location='GB',
        daily_cap=50,
        hourly_cap=10,
        comment_daily_cap=3,
        comment_used_today=0,
        used_today=0,
        used_this_hour=0,
        encrypted_cookies='c',
        last_used_at=None,
    )
    base.update(overrides)
    return base


class _FakeQuery:
    """Minimal chainable stand-in for the postgrest query builder.

    Supports the chaining pattern:
        table('social_accounts').select(...).eq(...).execute()
    and returns a SimpleNamespace(data=[...]).
    """
    def __init__(self, rows):
        self._rows = list(rows)

    def select(self, *_a, **_k):
        return self

    def eq(self, col, val):
        self._rows = [r for r in self._rows if r.get(col) == val]
        return self

    def update(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        return types.SimpleNamespace(data=list(self._rows))


# ── Tests ────────────────────────────────────────────────────────────────────

def test_post_comment_cap_reached(monkeypatch):
    """When comment_used_today >= comment_daily_cap, post_comment must return
    {posted: False, error: 'comment_cap_reached'} WITHOUT opening a browser.
    """
    capped_account = _fake_account(comment_used_today=3, comment_daily_cap=3)

    # Monkeypatch _load_account_by_id to return the capped account.
    monkeypatch.setattr(fb, '_load_account_by_id', lambda _id: capped_account)

    # Monkeypatch _open_session to FAIL the test if called — it must NOT be
    # reached when the cap is already exhausted.
    def _must_not_open(self, account):
        raise AssertionError("_open_session must NOT be called when comment cap is reached")
    monkeypatch.setattr(fb.FacebookScraper, '_open_session', _must_not_open)

    scraper = fb.FacebookScraper()
    result = scraper.post_comment(
        post_url='https://www.facebook.com/groups/123/posts/456',
        text='Test comment',
        account_id='test-acct-id',
    )

    assert result == {'posted': False, 'error': 'comment_cap_reached'}, (
        f"Expected cap guard to fire but got: {result!r}"
    )


def test_load_account_by_id_not_found(monkeypatch):
    """_load_account_by_id raises RuntimeError when no matching row exists."""
    # Install a fake table that always returns an empty result set.
    monkeypatch.setattr(fb, 'table', lambda _name: _FakeQuery([]))

    try:
        _load_account_by_id('nope')
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert 'not found' in str(exc).lower(), (
            f"Expected 'not found' in error message but got: {str(exc)!r}"
        )


def test_draft_comment_action_prints_json(monkeypatch, capsys):
    """_run_draft_comment prints a single JSON line {"text": <draft>} to stdout."""
    import tools.scraper.shared.social_nlp as social_nlp

    # Patch draft_comment_from_post to return a fixed string.
    monkeypatch.setattr(social_nlp, 'draft_comment_from_post', lambda excerpt, niche, **kw: 'hi')

    args = argparse.Namespace(
        platform='facebook',
        filters='{"post_excerpt": "x", "niche": "y"}',
    )
    _run_draft_comment(args)

    captured = capsys.readouterr()
    parsed = json.loads(captured.out.strip())
    assert parsed == {'text': 'hi'}, (
        f"Expected {{\"text\": \"hi\"}} but got: {parsed!r}"
    )


def test_draft_comment_action_null_when_no_api_key(monkeypatch, capsys):
    """When draft_comment_from_post returns None (no API key), JSON text is null."""
    import tools.scraper.shared.social_nlp as social_nlp

    monkeypatch.setattr(social_nlp, 'draft_comment_from_post', lambda *_a, **_kw: None)

    args = argparse.Namespace(
        platform='facebook',
        filters='{"post_excerpt": "some post", "niche": "plumber"}',
    )
    _run_draft_comment(args)

    captured = capsys.readouterr()
    parsed = json.loads(captured.out.strip())
    assert parsed == {'text': None}, (
        f"Expected {{\"text\": null}} but got: {parsed!r}"
    )


def test_post_comment_open_session_checkpoint(monkeypatch):
    """C1 regression test: RuntimeError from _open_session is caught and flagged
    as a checkpoint. driver.quit() must NOT raise NameError/UnboundLocalError.
    """
    active_account = _fake_account(
        id='x',
        handle='h',
        comment_used_today=0,
        comment_daily_cap=3,
    )

    # _load_account_by_id returns a valid, non-capped account.
    monkeypatch.setattr(fb, '_load_account_by_id', lambda _id: active_account)

    # _open_session raises RuntimeError (e.g. cookies rejected / login gate).
    def _open_session_raises(self, account):
        raise RuntimeError('cookies rejected')
    monkeypatch.setattr(fb.FacebookScraper, '_open_session', _open_session_raises)

    # Track whether _flag_checkpoint was called and with what args.
    checkpoint_calls: list[tuple] = []

    def _record_checkpoint(account_id: str, reason: str) -> None:
        checkpoint_calls.append((account_id, reason))

    monkeypatch.setattr(fb, '_flag_checkpoint', _record_checkpoint)

    scraper = fb.FacebookScraper()
    result = scraper.post_comment(
        post_url='https://www.facebook.com/groups/123/posts/456',
        text='Test comment',
        account_id='x',
    )

    assert result == {'posted': False, 'error': 'checkpoint'}, (
        f"Expected checkpoint result but got: {result!r}"
    )
    assert len(checkpoint_calls) == 1, (
        f"Expected _flag_checkpoint called once, got: {checkpoint_calls!r}"
    )
