from tools.scraper.shared.social_nlp import classify_consumer_posts_with_gemini


def test_returns_none_without_api_key(monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.delenv('NEXT_PUBLIC_GEMINI_API_KEY', raising=False)
    assert classify_consumer_posts_with_gemini(['anyone know a plumber?'], 'plumber') is None


def test_returns_none_on_empty_input(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'fake')
    assert classify_consumer_posts_with_gemini([], 'plumber') is None
