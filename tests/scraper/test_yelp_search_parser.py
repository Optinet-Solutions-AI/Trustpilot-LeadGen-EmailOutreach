import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.scraper.platforms.yelp import _parse_yelp_search_cards

FIXTURE = os.path.join(os.path.dirname(__file__), 'fixtures', 'yelp_search_sf.html')

def _load():
    with open(FIXTURE, encoding='utf-8') as f:
        return _parse_yelp_search_cards(f.read())

def test_extracts_many_businesses():
    assert len(_load()) >= 8

def test_rows_have_name_and_biz_url():
    for r in _load():
        assert r['name'] and isinstance(r['name'], str)
        assert '/biz/' in r['url']

def test_rows_have_numeric_rating_and_reviews():
    rows = _load()
    rated = [r for r in rows if r['rating'] is not None]
    assert len(rated) >= 5
    for r in rated:
        assert 1.0 <= r['rating'] <= 5.0
        assert r['review_count'] >= 0

def test_drops_noise_anchors():
    names = {r['name'].lower() for r in _load()}
    assert 'order' not in names and 'menu' not in names

def test_shape_matches_fusion_consumer():
    for r in _load():
        assert isinstance(r['location'], dict)
        assert 'display_address' in r['location']

if __name__ == '__main__':
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    failed = 0
    for fn in fns:
        try: fn(); print(f'PASS {fn.__name__}')
        except Exception: failed += 1; print(f'FAIL {fn.__name__}'); traceback.print_exc()
    print(f'\n{len(fns)-failed}/{len(fns)} passed'); sys.exit(1 if failed else 0)
