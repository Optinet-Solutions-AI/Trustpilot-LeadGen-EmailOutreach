import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.scraper.shared.local_browser import LocalBrowserFetcher

def test_default_block_markers_detect_tripadvisor_wall():
    f = LocalBrowserFetcher()
    assert f._is_block('... Access is temporarily restricted ...') is True

def test_custom_block_markers_detect_yelp_wall():
    f = LocalBrowserFetcher(block_markers=('Access to this page has been denied',))
    assert f._is_block('<h1>Access to this page has been denied</h1>') is True

def test_custom_block_markers_ignore_perimeterx_sdk():
    f = LocalBrowserFetcher(block_markers=('Access to this page has been denied',))
    assert f._is_block('<script>window._pxAppId="PXxxxx";// perimeterx px-captcha</script>') is False

if __name__ == '__main__':
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    failed = 0
    for fn in fns:
        try: fn(); print(f'PASS {fn.__name__}')
        except Exception: failed += 1; print(f'FAIL {fn.__name__}'); traceback.print_exc()
    print(f'\n{len(fns)-failed}/{len(fns)} passed'); sys.exit(1 if failed else 0)
