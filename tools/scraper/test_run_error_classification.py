"""Unit tests for run.py operator-actionable error classification.

Run: ./.venv/Scripts/python.exe -m pytest tools/scraper/test_run_error_classification.py -v
"""
from tools.scraper.run import _is_operator_actionable


def test_no_account_for_country_is_actionable():
    assert _is_operator_actionable(
        "No active Facebook account pinned to country GB. Connect one in Social Accounts and pin it to GB."
    )


def test_cant_determine_country_is_actionable():
    assert _is_operator_actionable(
        "Cannot determine the scrape's target country, so no geo-consistent Facebook account can be selected."
    )


def test_stale_session_is_actionable():
    assert _is_operator_actionable("Facebook rejected cookies for account james — needs re-connect")


def test_generic_no_account_is_actionable():
    assert _is_operator_actionable("No active Facebook account available. Connect one in Social Accounts ...")


def test_genuine_bug_is_NOT_actionable():
    assert not _is_operator_actionable("KeyError: 'foo'")
    assert not _is_operator_actionable("list index out of range")


def test_empty_or_none_is_safe():
    assert not _is_operator_actionable("")
    assert not _is_operator_actionable(None)
