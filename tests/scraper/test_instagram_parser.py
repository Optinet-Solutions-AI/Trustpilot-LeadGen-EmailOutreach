from tools.scraper.platforms.instagram import _caption_from_og


def test_caption_from_og_extracts_description():
    html = '<meta property="og:description" content="2,300 likes - someone: Need a plumber in Leeds ASAP">'
    assert 'plumber in Leeds' in _caption_from_og(html)


def test_caption_from_og_returns_empty_when_absent():
    assert _caption_from_og('<html><head></head></html>') == ''


import tools.scraper.platforms.instagram as ig


def test_filter_keeps_only_consumer_verdicts(monkeypatch):
    posts = [{'content_excerpt': 'need a plumber'}, {'content_excerpt': 'BOOK NOW 20% off'}]
    monkeypatch.setattr(ig, 'classify_consumer_posts_with_gemini', lambda excerpts, niche, location=None: [True, False])
    kept = ig._filter_consumer_posts(posts, niche='plumber', location=None)
    assert len(kept) == 1 and kept[0]['content_excerpt'] == 'need a plumber'


def test_filter_keeps_all_when_classifier_unavailable(monkeypatch):
    posts = [{'content_excerpt': 'a'}, {'content_excerpt': 'b'}]
    monkeypatch.setattr(ig, 'classify_consumer_posts_with_gemini', lambda *a, **k: None)
    assert ig._filter_consumer_posts(posts, niche='plumber', location=None) == posts
