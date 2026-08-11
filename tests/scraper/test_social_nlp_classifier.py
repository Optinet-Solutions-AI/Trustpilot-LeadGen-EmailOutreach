"""Reliability tests for the Facebook consumer-post classifier's batching
and retry behavior (tools/scraper/shared/social_nlp.py).

Bug being guarded against: sending ALL posts to Gemini in one call exhausts
gemini-2.5-flash's thinking-token budget on large batches (40+ posts), the
visible JSON comes back empty, and the whole classifier returns None —
silently dropping the caller back to the weak substring-heuristic fallback.
The fix batches into chunks of _CLASSIFIER_BATCH_SIZE and retries a batch
before giving up on it.
"""
import json

import tools.scraper.shared.social_nlp as social_nlp
from tools.scraper.shared.social_nlp import classify_consumer_posts_with_gemini


class _FakeResponse:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def _gemini_body(verdicts):
    """Build a fake Gemini response body carrying `verdicts`."""
    return {
        'candidates': [
            {'content': {'parts': [{'text': json.dumps({'verdicts': verdicts})}]}}
        ]
    }


def _empty_body():
    """Simulate a thinking-budget-exhausted response: no text part."""
    return {'candidates': [{'content': {'parts': [{'text': ''}]}}]}


def test_empty_input_returns_empty_list_with_no_http_call(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')
    calls = []
    monkeypatch.setattr(social_nlp.requests, 'post', lambda *a, **k: calls.append(1))

    result = classify_consumer_posts_with_gemini([], 'plumber')

    assert result == []
    assert calls == []


def test_small_batch_makes_one_post_and_returns_verdicts_in_order(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')
    posts = [f'post {i}' for i in range(5)]
    fake_verdicts = [True, False, True, True, False]
    calls = []

    def fake_post(url, json=None, timeout=None):  # noqa: A002
        calls.append(json)
        return _FakeResponse(_gemini_body(fake_verdicts))

    monkeypatch.setattr(social_nlp.requests, 'post', fake_post)

    result = classify_consumer_posts_with_gemini(posts, 'plumber')

    assert len(calls) == 1
    assert result == fake_verdicts


def test_large_batch_splits_into_three_calls_and_concatenates_in_order(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')
    posts = [f'post {i}' for i in range(45)]  # 20 + 20 + 5
    calls = []

    def fake_post(url, json=None, timeout=None):  # noqa: A002
        calls.append(json)
        prompt_text = json['contents'][0]['parts'][0]['text']
        # Number of posts in THIS batch = number of "\n[i]" numbered entries
        # (the numbered list is always preceded by "Posts:\n", so even
        # entry [0] is counted).
        batch_size = prompt_text.count('\n[')
        # Deterministic per-batch verdicts: alternate True/False by index.
        verdicts = [i % 2 == 0 for i in range(batch_size)]
        return _FakeResponse(_gemini_body(verdicts))

    monkeypatch.setattr(social_nlp.requests, 'post', fake_post)

    result = classify_consumer_posts_with_gemini(posts, 'plumber')

    assert len(calls) == 3
    assert result is not None
    assert len(result) == 45
    # Order preserved: verify against the expected pattern per batch
    # (20, 20, 5) each starting fresh at True for index 0.
    expected = (
        [i % 2 == 0 for i in range(20)]
        + [i % 2 == 0 for i in range(20)]
        + [i % 2 == 0 for i in range(5)]
    )
    assert result == expected


def test_batch_retries_after_empty_response_then_succeeds(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')
    posts = [f'post {i}' for i in range(5)]
    fake_verdicts = [True, True, False, False, True]
    call_count = {'n': 0}

    def fake_post(url, json=None, timeout=None):  # noqa: A002
        call_count['n'] += 1
        if call_count['n'] == 1:
            return _FakeResponse(_empty_body())
        return _FakeResponse(_gemini_body(fake_verdicts))

    sleep_calls = []
    monkeypatch.setattr(social_nlp.requests, 'post', fake_post)
    monkeypatch.setattr(social_nlp.time, 'sleep', lambda s: sleep_calls.append(s))

    result = classify_consumer_posts_with_gemini(posts, 'plumber')

    assert call_count['n'] == 2  # retried once
    assert len(sleep_calls) == 1  # backoff happened between attempts
    assert result == fake_verdicts


def test_batch_returns_none_when_all_attempts_fail(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')
    posts = [f'post {i}' for i in range(5)]
    call_count = {'n': 0}

    def fake_post(url, json=None, timeout=None):  # noqa: A002
        call_count['n'] += 1
        return _FakeResponse(_empty_body())

    monkeypatch.setattr(social_nlp.requests, 'post', fake_post)
    monkeypatch.setattr(social_nlp.time, 'sleep', lambda s: None)

    result = classify_consumer_posts_with_gemini(posts, 'plumber')

    assert result is None
    assert call_count['n'] == 2  # exhausted both attempts


def test_whole_function_returns_none_when_one_batch_of_many_fails(monkeypatch):
    """Preserve the caller's fallback contract: if ANY batch fails after
    retries, the whole call returns None so facebook.py falls back to the
    substring heuristic rather than silently shipping partial verdicts."""
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')
    posts = [f'post {i}' for i in range(25)]  # 20 + 5 -> two batches
    call_count = {'n': 0}

    def fake_post(url, json=None, timeout=None):  # noqa: A002
        call_count['n'] += 1
        prompt_text = json['contents'][0]['parts'][0]['text']
        batch_size = prompt_text.count('\n[')
        if batch_size == 20:
            # First batch always succeeds.
            return _FakeResponse(_gemini_body([True] * 20))
        # Second (5-post) batch always comes back empty -> exhausts retries.
        return _FakeResponse(_empty_body())

    monkeypatch.setattr(social_nlp.requests, 'post', fake_post)
    monkeypatch.setattr(social_nlp.time, 'sleep', lambda s: None)

    result = classify_consumer_posts_with_gemini(posts, 'plumber')

    assert result is None


def test_returns_none_without_api_key(monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.delenv('NEXT_PUBLIC_GEMINI_API_KEY', raising=False)
    calls = []
    monkeypatch.setattr(social_nlp.requests, 'post', lambda *a, **k: calls.append(1))

    result = classify_consumer_posts_with_gemini(['anyone know a plumber?'], 'plumber')

    assert result is None
    assert calls == []
