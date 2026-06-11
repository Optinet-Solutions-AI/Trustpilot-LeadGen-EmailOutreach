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


def test_caption_from_og_unescapes_entities_and_strips_quotes():
    html = ('<meta property="og:description" content="35 likes, 4 comments - '
            'charliem_obe on June 18, 2025: &quot;WeFix London &amp; Co&quot;.">')
    assert _caption_from_og(html) == 'WeFix London & Co'


def test_author_handle_from_og_extracts_username():
    from tools.scraper.platforms.instagram import _author_handle_from_og
    html = ('<meta property="og:description" content="29 likes, 10 comments - '
            '247plumberse on May 4, 2026: &quot;24/7 plumbing&quot;.">')
    assert _author_handle_from_og(html) == '247plumberse'


def test_author_handle_from_og_empty_when_no_prefix():
    from tools.scraper.platforms.instagram import _author_handle_from_og
    assert _author_handle_from_og('<meta property="og:description" content="no prefix here">') == ''


def test_decode_bio_link_extracts_target_and_drops_tracking():
    from tools.scraper.platforms.instagram import _decode_bio_link
    href = ('https://l.instagram.com/?u=http%3A%2F%2Fwww.charliemullinsobe.com%2F'
            '%3Futm_source%3Dig%26utm_medium%3Dsocial&e=AUA4juoj')
    assert _decode_bio_link(href) == 'http://www.charliemullinsobe.com/'


def test_decode_bio_link_ignores_meta_nav_links():
    from tools.scraper.platforms.instagram import _decode_bio_link
    assert _decode_bio_link('https://www.meta.ai/?utm_source=ig_web_nav') is None
    assert _decode_bio_link('https://www.threads.com/') is None
