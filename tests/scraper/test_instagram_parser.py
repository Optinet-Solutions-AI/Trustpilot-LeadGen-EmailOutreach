from tools.scraper.platforms.instagram import _caption_from_og


def test_caption_from_og_extracts_description():
    html = '<meta property="og:description" content="2,300 likes - someone: Need a plumber in Leeds ASAP">'
    assert 'plumber in Leeds' in _caption_from_og(html)


def test_caption_from_og_returns_empty_when_absent():
    assert _caption_from_og('<html><head></head></html>') == ''
