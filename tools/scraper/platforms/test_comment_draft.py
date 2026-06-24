"""Unit tests for the per-post comment drafter (Gemini call monkeypatched).

Run: ./.venv/Scripts/python.exe -m pytest tools/scraper/platforms/test_comment_draft.py -v
"""
import tools.scraper.shared.social_nlp as nlp


def test_draft_returns_none_without_key(monkeypatch):
    monkeypatch.delenv('GEMINI_API_KEY', raising=False)
    monkeypatch.delenv('NEXT_PUBLIC_GEMINI_API_KEY', raising=False)
    assert nlp.draft_comment_from_post("Looking for a plumber in Austin", "plumbers") is None


def test_draft_passes_post_text_to_model(monkeypatch):
    captured = {}
    def fake_call(prompt: str) -> str:
        captured['prompt'] = prompt
        return "Happy to help — sent you a quick note!"
    monkeypatch.setenv('GEMINI_API_KEY', 'test')
    monkeypatch.setattr(nlp, '_gemini_text_call', fake_call, raising=False)
    out = nlp.draft_comment_from_post("Need a dentist near Cebu, any recos?", "dentists")
    assert out == "Happy to help — sent you a quick note!"
    assert "Cebu" in captured['prompt']  # post content is in the prompt
    assert "dentists" in captured['prompt']
