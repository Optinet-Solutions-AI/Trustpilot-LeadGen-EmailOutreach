import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.scraper.platforms.yelp import _search_city_browser

PAGE = '''<html><body>
<div><div><div><div><div><a href="/biz/alpha-cafe-london">Alpha Cafe</a><span aria-label="4.5 star rating"></span> 120 reviews</div></div></div></div></div>
<div><div><div><div><div><a href="/biz/beta-bistro-london">Beta Bistro</a><span aria-label="3.0 star rating"></span> 8 reviews</div></div></div></div></div>
</body></html>'''

def test_paginates_and_stops_on_empty():
    calls = []
    def fake_fetch(url):
        calls.append(url)
        return PAGE if 'start=0' in url or 'start=' not in url else '<html><body>no results</body></html>'
    rows = _search_city_browser(fake_fetch, 'London', 'restaurants', max_results=50)
    assert len(rows) == 2
    assert rows[0]['url'].endswith('/biz/alpha-cafe-london')
    assert any('find_loc=London' in u for u in calls)

def test_respects_max_results():
    def fake_fetch(url): return PAGE
    rows = _search_city_browser(fake_fetch, 'London', 'restaurants', max_results=1)
    assert len(rows) == 1

if __name__ == '__main__':
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    failed = 0
    for fn in fns:
        try: fn(); print(f'PASS {fn.__name__}')
        except Exception: failed += 1; print(f'FAIL {fn.__name__}'); traceback.print_exc()
    print(f'\n{len(fns)-failed}/{len(fns)} passed'); sys.exit(1 if failed else 0)
