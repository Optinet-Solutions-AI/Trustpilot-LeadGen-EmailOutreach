"""Router tests: FB_DISCOVERY picks the discovery source, and the Apify
branch feeds the SAME downstream filter chain the browser branch does."""
import asyncio

import pytest

from tools.scraper.platforms import facebook as fb


def test_discovery_source_defaults_to_apify(monkeypatch):
    monkeypatch.delenv('FB_DISCOVERY', raising=False)
    assert fb._discovery_source() == 'apify'


def test_discovery_source_honours_browser_override(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'browser')
    assert fb._discovery_source() == 'browser'


def test_discovery_source_is_case_insensitive(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'APIFY')
    assert fb._discovery_source() == 'apify'


def test_unrecognised_discovery_value_warns_and_falls_back_to_browser(monkeypatch, capsys):
    """A typo ('apfiy') used to fall through to the browser path with no
    signal at all — on a Windows worker that silently burns a Facebook
    account's daily cap. Failing safe to browser is right; failing SILENTLY
    is not."""
    monkeypatch.setenv('FB_DISCOVERY', 'apfiy')
    assert fb._discovery_source() == 'browser'
    err = capsys.readouterr().err
    assert 'WARN' in err
    assert 'apfiy' in err
    assert 'FB_DISCOVERY' in err


def test_recognised_discovery_values_do_not_warn(monkeypatch, capsys):
    for value in ('apify', 'browser'):
        monkeypatch.setenv('FB_DISCOVERY', value)
        fb._discovery_source()
    assert 'WARN' not in capsys.readouterr().err


def test_apify_branch_returns_mapped_stubs(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {
            'url': 'https://www.facebook.com/p/1',
            'message': 'looking for a plumber in Manchester',
            'user': {'name': 'Jane', 'profile_url': 'https://www.facebook.com/jane'},
        },
    ])
    stubs = fb._search_posts_via_apify('plumber Manchester', {}, 10, None)
    assert len(stubs) == 1
    assert stubs[0]['author_profile_url'] == 'https://www.facebook.com/jane'


def test_apify_branch_skips_unmappable_items(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {'url': 'https://fb/p/1', 'message': 'x', 'user': {}},          # no profile url
        {'url': 'https://fb/p/2', 'message': 'y', 'user': {'profile_url': 'https://fb/u'}},
    ])
    stubs = fb._search_posts_via_apify('q', {}, 10, None)
    assert len(stubs) == 1


def test_search_posts_uses_apify_and_still_runs_the_consumer_filters(monkeypatch):
    """The Apify branch must sit ABOVE the stamping + filter chain so Apify
    stubs get country/category stamping and the Gemini classifier."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {'url': 'https://fb/p/1', 'message': 'anyone know a plumber in Manchester?',
         'user': {'name': 'Jane', 'profile_url': 'https://fb/jane'}},
    ])
    # Neutralize the LLM + translation so the test is deterministic.
    monkeypatch.setattr(fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None)
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)

    scraper = fb.FacebookScraper()
    stubs = asyncio.run(scraper.search_posts(
        'plumber Manchester',
        {'niche': 'plumber', 'location': 'Manchester', 'groups_only': False},
        max_results=10,
    ))
    assert len(stubs) == 1
    assert stubs[0]['category'] == 'plumber', 'category stamping must still run'
    assert stubs[0].get('location_confidence'), 'confidence classifier must still run'


def test_browser_mode_never_calls_apify(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'browser')

    def boom(*a, **k):
        raise AssertionError('Apify must not be called in browser mode')

    monkeypatch.setattr(fb.apify, 'run_actor', boom)
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)
    monkeypatch.setattr(
        fb.FacebookScraper, '_sync_search_posts',
        lambda self, query, groups_only, max_results, on_progress: [],
    )
    scraper = fb.FacebookScraper()
    out = asyncio.run(scraper.search_posts('q', {'groups_only': False}, max_results=5))
    assert out == []


def test_discover_group_ids_returns_id_name_pairs(monkeypatch):
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {'id': '111', 'name': 'Manchester Tradespeople'},
        {'group_id': '222', 'title': 'Manchester Home Help'},
        {'name': 'no id here'},
    ])
    pairs = fb._discover_group_ids_via_apify('plumber Manchester', 10)
    assert pairs == [('111', 'Manchester Tradespeople'), ('222', 'Manchester Home Help')]


def test_group_posts_via_apify_stamps_group_context(monkeypatch):
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [
        {'url': 'https://fb/p/1', 'message': 'need a plumber',
         'user': {'profile_url': 'https://fb/jane'}},
    ])
    stubs = fb._group_posts_via_apify([('111', 'Manchester Tradespeople')], 10, None)
    assert stubs[0]['group_id'] == '111'
    assert stubs[0]['group_name'] == 'Manchester Tradespeople'


def test_group_posts_survives_one_failing_group(monkeypatch):
    """One broken group must not lose the other groups' results."""
    calls = {'n': 0}

    def flaky(actor, run_input, **kw):
        calls['n'] += 1
        if calls['n'] == 1:
            raise fb.apify.ApifyError('group 111 is private')
        return [{'url': 'https://fb/p/2', 'message': 'roofer?',
                 'user': {'profile_url': 'https://fb/bob'}}]

    monkeypatch.setattr(fb.apify, 'run_actor', flaky)
    stubs = fb._group_posts_via_apify([('111', 'A'), ('222', 'B')], 10, None)
    assert len(stubs) == 1
    assert stubs[0]['group_id'] == '222'


def test_group_posts_survives_transport_error_on_one_group(monkeypatch):
    """Transport errors (as ApifyError) on one group must not lose other groups' results."""
    calls = {'n': 0}

    def transport_flaky(actor, run_input, **kw):
        calls['n'] += 1
        if calls['n'] == 1:
            # Simulate a transport error surfaced as ApifyError (as apify.py now does)
            raise fb.apify.ApifyError('Apify actor some/actor failed after 3 attempts: ConnectionError: network down')
        return [{'url': 'https://fb/p/2', 'message': 'roofer?',
                 'user': {'profile_url': 'https://fb/bob'}}]

    monkeypatch.setattr(fb.apify, 'run_actor', transport_flaky)
    stubs = fb._group_posts_via_apify([('111', 'A'), ('222', 'B')], 10, None)
    assert len(stubs) == 1
    assert stubs[0]['group_id'] == '222'


def test_enrich_mode_defaults_to_stub(monkeypatch):
    monkeypatch.delenv('FB_ENRICH', raising=False)
    assert fb._enrich_mode() == 'stub'


def test_stub_enrich_builds_leads_without_a_browser(monkeypatch):
    def boom(*a, **k):
        raise AssertionError('stub enrichment must not open a browser')

    monkeypatch.setattr(fb, '_open_driver', boom)
    leads = fb._stub_enrich_authors([
        {'platform': 'facebook', 'author_profile_url': 'https://fb/jane',
         'author_handle': 'jane', 'display_name': 'Jane Doe',
         'content_excerpt': 'need a plumber', 'country': 'GB', 'category': 'plumber'},
    ])
    assert len(leads) == 1
    assert leads[0]['profile_url'] == 'https://fb/jane'
    assert leads[0]['display_name'] == 'Jane Doe'
    assert leads[0]['platform'] == 'facebook'
    assert leads[0]['is_business_profile'] is False
    # location is a bio-derived string in the browser path (always None
    # there) — country travels separately via the `country` passthrough.
    assert leads[0]['location'] is None


def test_stub_enrich_sets_company_name_for_upsert():
    """upsert_leads.py:212 reads `company_name`, not `display_name` — every
    stub-enriched lead would land in the CRM as 'Unknown' without this."""
    leads = fb._stub_enrich_authors([
        {'author_profile_url': 'https://fb/jane', 'author_handle': 'jane',
         'display_name': 'Jane Doe'},
    ])
    assert leads[0]['company_name'] == 'Jane Doe'


def test_stub_enrich_company_name_falls_back_with_display_name():
    """company_name must track display_name's own handle/non-name fallback,
    not just display_name, so a missing/junk name still resolves in the CRM."""
    leads = fb._stub_enrich_authors([
        {'author_profile_url': 'https://fb/jane', 'author_handle': 'jane',
         'display_name': '(2) Facebook'},
    ])
    assert leads[0]['display_name'] == 'jane'
    assert leads[0]['company_name'] == 'jane'


def test_stub_enrich_dedupes_keeping_first_stubs_values():
    """A repeat author might post in two groups: one stub resolves a
    country, the other doesn't. The FIRST stub's stamped fields must win
    (matching the browser path's posts[0] precedent at facebook.py
    :3028-3029) — a later stub must never override them."""
    leads = fb._stub_enrich_authors([
        {'author_profile_url': 'https://fb/jane', 'display_name': 'Jane', 'author_handle': 'jane'},
        {'author_profile_url': 'https://fb/jane', 'display_name': 'Jane', 'author_handle': 'jane',
         'country': 'FR'},
        {'author_profile_url': 'https://fb/bob', 'display_name': 'Bob', 'author_handle': 'bob'},
    ])
    assert len(leads) == 2
    jane = next(l for l in leads if l['profile_url'] == 'https://fb/jane')
    assert 'country' not in jane


def test_stub_enrich_keeps_every_post_for_a_repeat_author():
    """Beyond-first stubs must not be discarded — upsert_leads.py:279-304
    writes each into lead_platform_posts, which is what powers 'we saw
    your post about X' outreach personalization."""
    stub_a = {'author_profile_url': 'https://fb/jane', 'display_name': 'Jane',
              'author_handle': 'jane', 'post_url': 'https://fb/p/1',
              'content_excerpt': 'need a plumber'}
    stub_b = {'author_profile_url': 'https://fb/jane', 'display_name': 'Jane',
              'author_handle': 'jane', 'post_url': 'https://fb/p/2',
              'content_excerpt': 'also need a roofer'}
    leads = fb._stub_enrich_authors([stub_a, stub_b])
    assert len(leads) == 1
    assert leads[0]['posts'] == [stub_a, stub_b]


def test_stub_enrich_falls_back_to_handle_when_no_display_name():
    leads = fb._stub_enrich_authors([
        {'author_profile_url': 'https://fb/jane', 'author_handle': 'jane.doe'},
    ])
    assert leads[0]['display_name'] == 'jane.doe'


def test_stub_enrich_never_emits_the_facebook_title_bug():
    """The browser path once wrote company_name='(2) Facebook' from a tab
    title. The stub path reads no titles, so this must hold by construction."""
    leads = fb._stub_enrich_authors([
        {'author_profile_url': 'https://fb/jane', 'author_handle': 'jane',
         'display_name': '(2) Facebook'},
    ])
    assert leads[0]['display_name'] == 'jane'


def test_stub_enrich_skips_stubs_without_profile_url():
    assert fb._stub_enrich_authors([{'author_handle': 'nobody'}]) == []


def test_apify_groups_only_falls_back_to_open_feed_when_no_groups_found(monkeypatch):
    """Live-tested 2026-08-03: both community group actors return 0 items.
    groups_only defaults True + FB_DISCOVERY defaults apify, so a naive
    implementation loops zero times over an empty group list and returns
    nothing. The run must instead fall back to the open-feed keyword search,
    which demonstrably works, so the job still produces leads."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    calls = {'groups': 0, 'posts': 0}

    def fake_run_actor(actor, run_input, **kw):
        if run_input.get('search_type') == 'groups':
            calls['groups'] += 1
            return []
        calls['posts'] += 1
        return [
            {'url': 'https://fb/p/1', 'message': 'need a reliable plumber',
             'user': {'name': 'Jane', 'profile_url': 'https://fb/jane'}},
        ]

    monkeypatch.setattr(fb.apify, 'run_actor', fake_run_actor)
    monkeypatch.setattr(fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None)
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)

    scraper = fb.FacebookScraper()
    stubs = asyncio.run(scraper.search_posts(
        'plumber Manchester',
        {'niche': 'plumber', 'location': 'Manchester', 'groups_only': True},
        max_results=10,
    ))
    assert calls['groups'] == 1, 'group discovery must still be attempted first'
    assert calls['posts'] == 1, 'must fall back to the open-feed search'
    assert len(stubs) == 1, 'fallback must actually produce leads, not another empty result'
    assert stubs[0]['author_profile_url'] == 'https://fb/jane'


def test_apify_groups_unavailable_event_emitted_with_actor_id(monkeypatch):
    """The diagnostic operators need: a loud, actionable progress event
    naming the actor that returned nothing, not a silent search_done:0."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')

    def fake_run_actor(actor, run_input, **kw):
        return []  # both the groups call and the open-feed fallback come back empty

    monkeypatch.setattr(fb.apify, 'run_actor', fake_run_actor)
    monkeypatch.setattr(fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None)
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)

    events = []
    scraper = fb.FacebookScraper()
    asyncio.run(scraper.search_posts(
        'plumber Manchester',
        {'niche': 'plumber', 'location': 'Manchester', 'groups_only': True},
        max_results=10,
        on_progress=events.append,
    ))
    unavailable = [e for e in events if e.get('stage') == 'apify_groups_unavailable']
    assert len(unavailable) == 1
    assert unavailable[0]['actor'] == fb.facebook_apify.search_actor()
    assert unavailable[0].get('reason')


def test_apify_groups_found_uses_group_path_and_skips_unavailable_event(monkeypatch):
    """When group discovery DOES return groups, the existing group-posts
    path must run unchanged and must NOT emit apify_groups_unavailable —
    even if every group then yields zero posts, apify_groups_done already
    tells that story."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')

    def fake_run_actor(actor, run_input, **kw):
        if run_input.get('search_type') == 'groups':
            return [{'id': '111', 'name': 'Manchester Tradespeople'}]
        return [{'url': 'https://fb/p/1', 'message': 'need a reliable plumber',
                  'user': {'profile_url': 'https://fb/jane'}}]

    monkeypatch.setattr(fb.apify, 'run_actor', fake_run_actor)
    monkeypatch.setattr(fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None)
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)

    events = []
    scraper = fb.FacebookScraper()
    stubs = asyncio.run(scraper.search_posts(
        'plumber Manchester',
        {'niche': 'plumber', 'location': 'Manchester', 'groups_only': True},
        max_results=10,
        on_progress=events.append,
    ))
    assert len(stubs) == 1
    assert not any(e.get('stage') == 'apify_groups_unavailable' for e in events)
    assert any(e.get('stage') == 'apify_groups_done' for e in events)


def test_enrich_authors_uses_stub_path_by_default_and_never_opens_browser(monkeypatch):
    """The dispatch inside enrich_authors is what actually matters in
    production — a test that only calls _stub_enrich_authors directly
    would still pass even if the `if _enrich_mode() == 'stub':` branch in
    enrich_authors were deleted, inverted, or mis-indented."""
    monkeypatch.delenv('FB_ENRICH', raising=False)

    def boom(*a, **k):
        raise AssertionError('enrich_authors default mode must not open a browser')

    monkeypatch.setattr(fb, '_open_driver', boom)
    scraper = fb.FacebookScraper()
    leads = asyncio.run(scraper.enrich_authors([
        {'author_profile_url': 'https://fb/jane', 'author_handle': 'jane',
         'display_name': 'Jane Doe'},
    ]))
    assert len(leads) == 1
    assert leads[0]['profile_url'] == 'https://fb/jane'
    assert leads[0]['company_name'] == 'Jane Doe'


# -- Account loaders must not drop unknown columns (AdsPower binding) ------


class _FakeSelectQuery:
    """Minimal PostgREST-builder stand-in.

    Records the select projection AND actually applies it: PostgREST returns
    only the named columns, so a fake that ignores the projection could never
    reproduce the bug where adspower_profile_id was silently dropped.
    """

    def __init__(self, rows: list[dict], recorder: list[str]):
        self._rows = rows
        self._recorder = recorder

    def select(self, columns, *a, **kw):
        self._recorder.append(columns)
        if columns != '*':
            wanted = [c.strip() for c in columns.split(',')]
            self._rows = [
                {k: v for k, v in row.items() if k in wanted} for row in self._rows
            ]
        return self

    def update(self, *a, **kw):
        return self

    def eq(self, *a, **kw):
        return self

    def order(self, *a, **kw):
        return self

    def limit(self, *a, **kw):
        return self

    def execute(self):
        rows = self._rows

        class _Result:
            data = rows

        return _Result()


_ADSPOWER_ROW = {
    'id': 'acct-1',
    'platform': 'facebook',
    'handle': 'james@optiratesolutions.net',
    'status': 'active',
    'country': 'GB',
    'proxy_location': 'GB',
    'daily_cap': 10,
    'hourly_cap': 3,
    'used_today': 0,
    'used_this_hour': 0,
    'encrypted_cookies': 'deadbeef',
    'last_used_at': None,
    # Migration 057. The loaders' old explicit projections omitted it, so
    # _open_driver's `.get('adspower_profile_id')` returned None forever and
    # AdsPower never activated -- including on the comment path it exists for.
    'adspower_profile_id': 'ap-profile-123',
}


def _patch_table(monkeypatch, rows):
    selects: list[str] = []
    fake = _FakeSelectQuery(rows, selects)
    monkeypatch.setattr(fb, 'table', lambda name: fake)
    return selects


def test_claim_account_selects_star_so_new_columns_survive(monkeypatch):
    """An explicit column list silently drops any column added later --
    exactly how the AdsPower binding became dead code. Asserting on '*'
    makes a future re-introduced projection fail loudly here."""
    selects = _patch_table(monkeypatch, [dict(_ADSPOWER_ROW)])
    account = fb._claim_account('facebook')
    assert selects == ['*'], 'the projection must stay select(*)'
    assert account['adspower_profile_id'] == 'ap-profile-123'


def test_load_account_by_id_selects_star_so_new_columns_survive(monkeypatch):
    selects = _patch_table(monkeypatch, [dict(_ADSPOWER_ROW)])
    account = fb._load_account_by_id('acct-1')
    assert selects == ['*'], 'the projection must stay select(*)'
    assert account['adspower_profile_id'] == 'ap-profile-123'


def test_adspower_profile_id_reaches_open_driver_from_a_claimed_account(monkeypatch):
    """Full-stack: loader -> _open_driver. This is the behaviour that was
    broken, not the SQL string."""
    import tools.scraper.shared.uc_driver as uc_driver

    captured: dict = {}

    def fake_open(*args, **kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(uc_driver, 'open_uc_driver', fake_open)
    _patch_table(monkeypatch, [dict(_ADSPOWER_ROW)])
    fb._open_driver(fb._claim_account('facebook'))
    assert captured['adspower_profile_id'] == 'ap-profile-123'


def test_adspower_profile_id_reaches_open_driver_on_the_comment_path(monkeypatch):
    """post_comment resolves its account through _load_account_by_id -- the
    engagement path AdsPower exists for."""
    import tools.scraper.shared.uc_driver as uc_driver

    captured: dict = {}

    def fake_open(*args, **kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(uc_driver, 'open_uc_driver', fake_open)
    _patch_table(monkeypatch, [dict(_ADSPOWER_ROW)])
    fb._open_driver(fb._load_account_by_id('acct-1'))
    assert captured['adspower_profile_id'] == 'ap-profile-123'


# -- Entry points that cannot honour FB_DISCOVERY / FB_ENRICH must say so --


def test_scrape_listing_group_first_refuses_to_run_under_apify_discovery(monkeypatch):
    """--action list + groups_only goes straight to the browser crawl. Under
    FB_DISCOVERY=apify that silently claims an account and opens a browser."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')

    def boom(*a, **k):
        raise AssertionError('must not run the browser crawl under FB_DISCOVERY=apify')

    monkeypatch.setattr(fb.FacebookScraper, '_sync_group_first_scrape', boom)
    monkeypatch.setattr(fb, '_claim_account', boom)

    scraper = fb.FacebookScraper()
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(scraper.scrape_listing(
            {'niche': 'plumber', 'location': 'Manchester'}, max_results=10,
        ))
    message = str(exc.value)
    assert 'FB_DISCOVERY' in message
    assert 'search-posts' in message


def test_scrape_listing_group_first_still_runs_under_browser_discovery(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'browser')
    monkeypatch.setattr(
        fb.FacebookScraper, '_sync_group_first_scrape',
        lambda self, niche, location, on_progress, cap: [],
    )
    scraper = fb.FacebookScraper()
    assert asyncio.run(scraper.scrape_listing(
        {'niche': 'plumber', 'location': 'Manchester'}, max_results=10,
    )) == []


def test_enrich_profiles_author_pivot_refuses_to_run_under_stub_enrich(monkeypatch):
    """--action enrich pivots to the browser author crawl on any PostStub.
    Under the default FB_ENRICH=stub that contradicts the operator's config."""
    monkeypatch.delenv('FB_ENRICH', raising=False)

    def boom(*a, **k):
        raise AssertionError('must not run the browser author crawl under FB_ENRICH=stub')

    monkeypatch.setattr(fb.FacebookScraper, '_sync_enrich_authors', boom)

    scraper = fb.FacebookScraper()
    with pytest.raises(RuntimeError) as exc:
        asyncio.run(scraper.enrich_profiles([
            {'post_url': 'https://fb/p/1', 'author_profile_url': 'https://fb/jane'},
        ]))
    message = str(exc.value)
    assert 'FB_ENRICH' in message
    assert 'enrich-authors' in message


def test_enrich_profiles_author_pivot_still_runs_under_browser_enrich(monkeypatch):
    monkeypatch.setenv('FB_ENRICH', 'browser')
    monkeypatch.setattr(
        fb.FacebookScraper, '_sync_enrich_authors',
        lambda self, stubs, on_progress: [{'profile_url': 'https://fb/jane'}],
    )
    scraper = fb.FacebookScraper()
    out = asyncio.run(scraper.enrich_profiles([
        {'post_url': 'https://fb/p/1', 'author_profile_url': 'https://fb/jane'},
    ]))
    assert out == [{'profile_url': 'https://fb/jane'}]


# -- The operator's query must survive to the actor on the open-feed path --


def _record_search_inputs(monkeypatch):
    """Capture every build_search_input call without changing its behaviour."""
    calls: list[dict] = []
    real = fb.facebook_apify.build_search_input

    def spy(query, **kwargs):
        calls.append({'query': query, **kwargs})
        return real(query, **kwargs)

    monkeypatch.setattr(fb.facebook_apify, 'build_search_input', spy)
    return calls


def test_open_feed_apify_search_passes_the_operators_query_verbatim(monkeypatch):
    """f'{niche} {location}' discarded the operator's query on every dashboard
    submission. Measured live: the geo-stuffed form returned 0 usable of 20
    (adverts); intent phrasing returned real consumer asks. The browser path
    passes `query` through verbatim -- so must this."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [])
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)
    calls = _record_search_inputs(monkeypatch)

    scraper = fb.FacebookScraper()
    asyncio.run(scraper.search_posts(
        'need a plumber recommendation',
        {'niche': 'plumber', 'location': 'Manchester', 'groups_only': False},
        max_results=10,
    ))
    assert [c['query'] for c in calls] == ['need a plumber recommendation']


def test_group_discovery_still_uses_the_geo_stuffed_term(monkeypatch):
    """Group discovery is the one place a place-name match IS what we want."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [])
    monkeypatch.setattr(fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None)
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)
    calls = _record_search_inputs(monkeypatch)

    scraper = fb.FacebookScraper()
    asyncio.run(scraper.search_posts(
        'need a plumber recommendation',
        {'niche': 'plumber', 'location': 'Manchester', 'groups_only': True},
        max_results=10,
    ))
    groups_calls = [c for c in calls if c.get('search_type') == 'groups']
    assert [c['query'] for c in groups_calls] == ['plumber Manchester']
    # ...and the open-feed fallback still gets the operator's query verbatim.
    posts_calls = [c for c in calls if c.get('search_type') != 'groups']
    assert [c['query'] for c in posts_calls] == ['need a plumber recommendation']


def test_explicit_max_results_zero_is_not_coerced_to_fifty(monkeypatch):
    """`max_results or 50` turned an explicit 0 into 50. Free on the browser
    path; on Apify it launches a billable run and, on the free plan, spends
    the day's only run."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [])
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)
    calls = _record_search_inputs(monkeypatch)

    scraper = fb.FacebookScraper()
    asyncio.run(scraper.search_posts(
        'need a plumber',
        {'niche': 'plumber', 'location': 'Manchester', 'groups_only': False},
        max_results=0,
    ))
    assert [c['max_results'] for c in calls] == [0]


def test_omitted_max_results_still_defaults_to_fifty(monkeypatch):
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', lambda actor, run_input, **kw: [])
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)
    calls = _record_search_inputs(monkeypatch)

    scraper = fb.FacebookScraper()
    asyncio.run(scraper.search_posts(
        'need a plumber',
        {'niche': 'plumber', 'location': 'Manchester', 'groups_only': False},
    ))
    assert [c['max_results'] for c in calls] == [50]


# -- A config error must never look like "no leads found" ------------------


def test_search_posts_propagates_apify_config_error(monkeypatch):
    """The plan's central invariant: an empty result set must never come from
    a configuration error. A missing APIFY_API_TOKEN raises ApifyError, and
    that must reach the caller instead of degrading to []."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')

    def boom(actor, run_input, **kw):
        raise fb.apify.ApifyError('APIFY_API_TOKEN is not set')

    monkeypatch.setattr(fb.apify, 'run_actor', boom)
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)

    scraper = fb.FacebookScraper()
    with pytest.raises(fb.apify.ApifyError, match='APIFY_API_TOKEN'):
        asyncio.run(scraper.search_posts(
            'need a plumber',
            {'niche': 'plumber', 'location': 'Manchester', 'groups_only': False},
            max_results=10,
        ))


def test_search_posts_propagates_apify_credit_error_from_group_discovery(monkeypatch):
    """Group discovery is NOT inside the per-group try/except, so an exhausted
    plan there must surface too, not read as 'no groups found'."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')

    def boom(actor, run_input, **kw):
        raise fb.apify.ApifyCreditError('402 monthly usage exceeded')

    monkeypatch.setattr(fb.apify, 'run_actor', boom)
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)

    scraper = fb.FacebookScraper()
    with pytest.raises(fb.apify.ApifyError, match='402'):
        asyncio.run(scraper.search_posts(
            'need a plumber',
            {'niche': 'plumber', 'location': 'Manchester', 'groups_only': True},
            max_results=10,
        ))


# -- Stub enrichment must apply the browser path's business-name gate ------


def test_stub_enrich_drops_business_named_authors():
    """The browser path rejects 'RCA Dental Clinic' at its second-pass name
    filter. The stub path is the NEW DEFAULT, so without the same gate that
    profile becomes a consumer lead in the CRM."""
    leads = fb._stub_enrich_authors([
        {'author_profile_url': 'https://fb/rca', 'author_handle': 'rca',
         'display_name': 'RCA Dental Clinic'},
        {'author_profile_url': 'https://fb/xlrt', 'author_handle': 'xlrt',
         'display_name': 'XLRT Ltd'},
        {'author_profile_url': 'https://fb/acme', 'author_handle': 'acme',
         'display_name': 'Acme Web Agency'},
        {'author_profile_url': 'https://fb/jane', 'author_handle': 'jane',
         'display_name': 'Jane Doe'},
    ])
    assert [lead['display_name'] for lead in leads] == ['Jane Doe']


def test_stub_enrich_emits_the_same_enrich_skipped_business_event():
    """Same event NAME as the browser path -- anything parsing progress
    events reads that string."""
    events = []
    fb._stub_enrich_authors(
        [{'author_profile_url': 'https://fb/rca', 'author_handle': 'rca',
          'display_name': 'RCA Dental Clinic'}],
        events.append,
    )
    skipped = [e for e in events if e.get('stage') == 'enrich_skipped_business']
    assert len(skipped) == 1
    assert skipped[0]['name'] == 'RCA Dental Clinic'
    assert skipped[0]['url'] == 'https://fb/rca'


def test_stub_enrich_business_gate_runs_on_the_resolved_name_not_the_raw_one():
    """The gate must sit AFTER the display_name/handle fallback, so a junk
    '(2) Facebook' name that resolves to a business-looking handle is still
    judged on what actually lands in leads.company_name."""
    leads = fb._stub_enrich_authors([
        {'author_profile_url': 'https://fb/x', 'author_handle': 'Bright Smile Dental',
         'display_name': '(2) Facebook'},
    ])
    assert leads == []


def test_display_name_business_gate_covers_suffixes_and_niche_tokens():
    for name in ('XLRT Ltd', 'Foo LLC', 'Bar Consulting', 'Baz Studios',
                 'RCA Dental Clinic', 'Glow Medspa', 'Central Pharmacy'):
        assert fb._display_name_looks_like_business(name), name
    for name in ('Jane Doe', 'Bob', 'Maria Santos-Cruz', '', 'jane.doe.5'):
        assert not fb._display_name_looks_like_business(name), name


def test_enrich_authors_default_path_drops_business_named_authors(monkeypatch):
    """Dispatch-level proof: the gate is reachable through the real entry
    point, not just the helper."""
    monkeypatch.delenv('FB_ENRICH', raising=False)
    scraper = fb.FacebookScraper()
    leads = asyncio.run(scraper.enrich_authors([
        {'author_profile_url': 'https://fb/rca', 'author_handle': 'rca',
         'display_name': 'RCA Dental Clinic'},
        {'author_profile_url': 'https://fb/jane', 'author_handle': 'jane',
         'display_name': 'Jane Doe'},
    ]))
    assert [lead['display_name'] for lead in leads] == ['Jane Doe']
