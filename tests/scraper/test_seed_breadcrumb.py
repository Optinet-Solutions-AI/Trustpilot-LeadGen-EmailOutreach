"""
Fixture-based tests for the TripAdvisor seeder's breadcrumb-containment filter.

The seeder used to harvest EVERY Tourism-g link on a page (continent
breadcrumbs + "travelers also viewed" cross-promo), so seeding Malta pulled in
Paris/London/Rome/etc. and — because the upsert keys on geo_id — re-tagged
those shared rows to country_code='MT'. The fix: a city is kept only if the
target country's geo appears in that city page's JSON-LD BreadcrumbList.

These tests pin the parser + containment decision with no network.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from tools.scraper.seed_tripadvisor_cities import _breadcrumb_geos, _in_country

MALTA_GEO = '190311'


def _breadcrumb_html(items: list[tuple[str, str | None]]) -> str:
    """items: [(name, url_or_None)] — last item (current page) has url=None."""
    elements = []
    for i, (name, url) in enumerate(items, start=1):
        if url:
            elements.append(
                f'{{"@type":"ListItem","position":{i},"name":"{name}",'
                f'"item":"{url}"}}'
            )
        else:
            elements.append(
                f'{{"@type":"ListItem","position":{i},"name":"{name}"}}'
            )
    body = ",".join(elements)
    return (
        '<html><head>'
        '<script type="application/ld+json">'
        '{"@context":"https://schema.org","@type":"BreadcrumbList",'
        f'"itemListElement":[{body}]}}'
        '</script></head><body></body></html>'
    )


VALLETTA_HTML = _breadcrumb_html([
    ('Europe', 'https://www.tripadvisor.com/Tourism-g4-Europe-Vacations.html'),
    ('Malta', 'https://www.tripadvisor.com/Tourism-g190311-Malta-Vacations.html'),
    ('Island of Malta', 'https://www.tripadvisor.com/Tourism-g190320-Island_of_Malta-Vacations.html'),
    ('Valletta', None),
])

PARIS_HTML = _breadcrumb_html([
    ('Europe', 'https://www.tripadvisor.com/Tourism-g4-Europe-Vacations.html'),
    ('France', 'https://www.tripadvisor.com/Tourism-g187070-France-Vacations.html'),
    ('Ile-de-France', 'https://www.tripadvisor.com/Tourism-g187077-Ile_de_France-Vacations.html'),
    ('Paris', None),
])

# A page with no JSON-LD breadcrumb at all (e.g. a Cloudflare interstitial).
EMPTY_HTML = '<html><body>Just a moment...</body></html>'


def test_breadcrumb_geos_extracts_ancestor_geo_ids():
    geos = _breadcrumb_geos(VALLETTA_HTML)
    assert '4' in geos          # Europe
    assert '190311' in geos     # Malta (ancestor of Valletta)
    assert '190320' in geos     # Island of Malta


def test_breadcrumb_geos_empty_on_missing_jsonld():
    assert _breadcrumb_geos(EMPTY_HTML) == set()


def test_in_country_keeps_real_maltese_city():
    assert _in_country(VALLETTA_HTML, MALTA_GEO) is True


def test_in_country_drops_foreign_cross_promo_city():
    # Paris must NOT count as a Maltese city — this is the exact bug.
    assert _in_country(PARIS_HTML, MALTA_GEO) is False


def test_in_country_drops_when_breadcrumb_unparseable():
    # Fail safe: no breadcrumb -> not in country (drop, never pollute).
    assert _in_country(EMPTY_HTML, MALTA_GEO) is False


def test_walk_country_falls_back_to_country_geo_when_no_children():
    # City-territories (Hong Kong) and pages whose child module didn't render
    # yield no child geos — the walk must still seed the country geo itself so
    # the scraper has at least the country-level listing to fan out to.
    from tools.scraper.seed_tripadvisor_cities import _walk_country
    hk_country_page = _breadcrumb_html([
        ('Asia', 'https://www.tripadvisor.com/Tourism-g2-Asia-Vacations.html'),
        ('China', 'https://www.tripadvisor.com/Tourism-g294211-China-Vacations.html'),
        ('Hong Kong', None),
    ])
    out = _walk_country('294217', 'Hong_Kong', shallow=True,
                        fetch=lambda url: hk_country_page)
    assert len(out) == 1
    assert out[0]['geo_id'] == '294217'


if __name__ == '__main__':
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f'PASS {fn.__name__}')
        except Exception:
            failed += 1
            print(f'FAIL {fn.__name__}')
            traceback.print_exc()
    print(f'\n{len(fns) - failed}/{len(fns)} passed')
    sys.exit(1 if failed else 0)
