import json

from tools.scraper.shared.social_nlp import (
    classify_consumer_posts_with_gemini,
    label_groups_with_gemini,
)


def test_returns_none_without_api_key(monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.delenv('NEXT_PUBLIC_GEMINI_API_KEY', raising=False)
    assert classify_consumer_posts_with_gemini(['anyone know a plumber?'], 'plumber') is None


def test_returns_empty_list_on_empty_input(monkeypatch):
    # Empty input short-circuits to [] (a real, no-op verdict list) rather
    # than None — None is reserved for "the LLM call failed/unavailable",
    # which callers use to trigger the substring-heuristic fallback.
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')
    assert classify_consumer_posts_with_gemini([], 'plumber') == []


# ── label_groups_with_gemini ────────────────────────────────────────────────

def test_label_groups_returns_none_without_api_key(monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.delenv('NEXT_PUBLIC_GEMINI_API_KEY', raising=False)
    assert label_groups_with_gemini([{'name': 'Find a Tradesman Bristol'}]) is None


def test_label_groups_returns_none_on_empty_input(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')
    assert label_groups_with_gemini([]) is None


class _FakeResponse:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def _gemini_body(labels):
    return {
        'candidates': [
            {'content': {'parts': [{'text': json.dumps({'labels': labels})}]}}
        ]
    }


def test_label_groups_parses_response_and_gets_london_ontario_right(monkeypatch):
    """The trap the operator flagged: a naive matcher calls
    'HANDYMAN SERVICES LONDON, Ontario' a UK group because of the word
    London. Ontario is a Canadian province — the qualifier must win."""
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')

    groups = [
        {'name': 'Find a Tradesman Bristol and surrounding'},
        {'name': 'London Builders And Other Tradesman Free Advertising'},
        {'name': 'HANDYMAN SERVICES LONDON, Ontario'},
    ]
    fake_labels = [
        {'audience': 'customers', 'country_code': 'GB', 'city': 'Bristol'},
        {'audience': 'trades', 'country_code': 'GB', 'city': 'London'},
        {'audience': 'customers', 'country_code': 'CA', 'city': 'London'},
    ]

    captured_payload = {}

    def fake_post(url, json=None, timeout=None):  # noqa: A002 - mirrors requests.post signature
        captured_payload['json'] = json
        return _FakeResponse(_gemini_body(fake_labels))

    import requests as real_requests
    monkeypatch.setattr(real_requests, 'post', fake_post)

    result = label_groups_with_gemini(groups)

    assert result == fake_labels
    # The London/Ontario row must resolve to Canada, not the UK.
    assert result[2]['country_code'] == 'CA'
    assert result[2]['city'] == 'London'
    assert result[1]['audience'] == 'trades'
    assert result[0]['audience'] == 'customers'
    # Sanity: the prompt actually reached the model with all 3 group names.
    prompt_text = captured_payload['json']['contents'][0]['parts'][0]['text']
    assert 'HANDYMAN SERVICES LONDON, Ontario' in prompt_text


def test_label_groups_returns_none_on_length_mismatch(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')
    import requests as real_requests

    def fake_post(url, json=None, timeout=None):  # noqa: A002
        return _FakeResponse(_gemini_body([{'audience': 'customers', 'country_code': None, 'city': None}]))

    monkeypatch.setattr(real_requests, 'post', fake_post)
    result = label_groups_with_gemini([{'name': 'a'}, {'name': 'b'}])
    assert result is None


def test_label_groups_normalises_bad_country_code(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')
    import requests as real_requests

    def fake_post(url, json=None, timeout=None):  # noqa: A002
        return _FakeResponse(_gemini_body([
            {'audience': 'unclear', 'country_code': 'not-a-code', 'city': '  '},
        ]))

    monkeypatch.setattr(real_requests, 'post', fake_post)
    result = label_groups_with_gemini([{'name': 'Some Group'}])
    assert result == [{'audience': 'unclear', 'country_code': None, 'city': None}]
