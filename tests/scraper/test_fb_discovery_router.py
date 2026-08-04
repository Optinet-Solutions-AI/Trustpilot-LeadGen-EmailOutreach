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


# ==========================================================================
# Gemini is the GATE; the substring heuristics are the FALLBACK
# ==========================================================================
#
# Every excerpt below is a REAL post from the live Apify search for
# "need a plumber recommendation" (2026-08-03, 20 posts, labelled blind by
# three reviewers, 19/20 unanimous). Measured on that ground truth:
#
#   substring filter only   precision  80%   recall 50%
#   Gemini classifier only  precision 100%   recall 88%
#   substring THEN Gemini   precision 100%   recall 50%   <- as shipped
#
# The pre-gate cost half the recall for zero precision benefit. Do not
# re-add it.

# Genuine consumer asks the substring filter DESTROYS (no CONSUMER_PATTERN
# covers 'looking for recommendations' / 'need a recommendation' /
# 'need recommendations').
_ASK_SHOWER = 'Looking for recommendations for a plumber to come in for a shower to be redone.'
_ASK_DEVINE = 'I need a recommendation for a good local plumber around Devine.'
_ASK_MOVED = (
    "House trade recommendations. I've recently moved to the area and need "
    'recommendations for a structural engineer and a plumber.'
)

# Advert the substring filter KEEPS (matches CONSUMER 'in need of';
# POST_EXPERIENCE_PATTERNS has 'i highly recommend' but not 'we highly
# recommend') and Gemini correctly rejects.
_ADVERT_KEPT_BY_SUBSTRING = (
    'If anyone is in need of a reliable & honest plumber, we highly recommend '
    'Chris with Watkins Plumbing, LLC'
)

# Advert the substring filter DOES drop — the safety net that has to survive
# a Gemini outage.
_ADVERT_DROPPED_BY_SUBSTRING = (
    'Need a plumber? Look no further! ABC Plumbing offers free quotes, '
    '24/7 service and competitive prices.'
)

# Consumer ask both layers agree on.
_ASK_PLAIN = 'Anyone know a plumber in Manchester who can look at a leaking radiator?'

_ENGLISH_FILTERS = {
    'niche': 'plumber',
    'location': 'Manchester',
    'groups_only': False,
    'exclude_businesses': True,
    'asking_only': True,
}


def _stub(text: str, handle: str = 'jane') -> dict:
    return {
        'platform': 'facebook',
        'content_excerpt': text,
        'author_handle': handle,
        'author_profile_url': f'https://fb/{handle}',
        'post_url': f'https://fb/p/{handle}',
    }


def _verdicts_from(accepted: set):
    """Fake classifier: accepts exactly the excerpts in `accepted`."""
    def fake(excerpts, niche, location=None, **kw):
        return [e in accepted for e in excerpts]
    return fake


def _excerpts(stubs) -> list:
    return [s['content_excerpt'] for s in stubs]


def test_substring_filter_alone_rejects_the_three_recovered_asks():
    """Ground truth for the tests below: these are genuine consumer asks that
    the substring heuristics get WRONG. If a future pattern-list edit makes
    them pass, this test tells you the recovered-recall tests below stopped
    proving anything."""
    for text in (_ASK_SHOWER, _ASK_DEVINE, _ASK_MOVED):
        assert not fb._is_actively_asking(text), text
    # ...and the advert the heuristics wrongly KEEP.
    assert fb._is_actively_asking(_ADVERT_KEPT_BY_SUBSTRING)
    assert not fb._looks_like_business_post(_ADVERT_KEPT_BY_SUBSTRING, '')


def test_gemini_verdicts_are_the_sole_gate(monkeypatch):
    """+75% recall: a post the substring filter would reject but Gemini
    accepts must SURVIVE. Fails before the fix, because the substring
    pre-gate destroys the post before Gemini ever sees it."""
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini',
        _verdicts_from({_ASK_SHOWER, _ASK_DEVINE, _ASK_MOVED, _ASK_PLAIN}),
    )
    stubs = [_stub(t, f'u{i}') for i, t in enumerate(
        (_ASK_SHOWER, _ASK_DEVINE, _ASK_MOVED, _ASK_PLAIN))]

    kept = fb._apply_consumer_filter_chain(
        stubs, niche='plumber', location='Manchester', filters=_ENGLISH_FILTERS,
    )
    assert _excerpts(kept) == [_ASK_SHOWER, _ASK_DEVINE, _ASK_MOVED, _ASK_PLAIN]


def test_gemini_rejection_drops_a_post_the_substring_filter_would_keep(monkeypatch):
    """The 'we highly recommend Chris' advert. Gemini's verdict is the gate in
    BOTH directions — it drops as well as keeps."""
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', _verdicts_from({_ASK_PLAIN}),
    )
    kept = fb._apply_consumer_filter_chain(
        [_stub(_ADVERT_KEPT_BY_SUBSTRING, 'watkins'), _stub(_ASK_PLAIN, 'jane')],
        niche='plumber', location='Manchester', filters=_ENGLISH_FILTERS,
    )
    assert _excerpts(kept) == [_ASK_PLAIN]


def test_no_verdicts_falls_back_to_the_substring_filter(monkeypatch):
    """THE SAFETY TEST. This chain is the last gate before upsert_leads.py —
    there is no downstream intent filtering. When Gemini returns None
    (missing key, 429, timeout, length-mismatch guard) the fallback must be
    today's substring behaviour, NOT 'keep everything'. A beauty business was
    once saved as an electrician lead exactly because the classifier was
    skipped."""
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None,
    )
    kept = fb._apply_consumer_filter_chain(
        [
            _stub(_ADVERT_DROPPED_BY_SUBSTRING, 'abcplumbing'),
            _stub('Available for work - all plumbing work undertaken, fully '
                  'insured and qualified, no job too small.', 'tradesman'),
            _stub(_ASK_PLAIN, 'jane'),
        ],
        niche='plumber', location='Manchester', filters=_ENGLISH_FILTERS,
    )
    assert _excerpts(kept) == [_ASK_PLAIN], 'fallback must still drop adverts'


def test_no_verdicts_fallback_is_exactly_todays_substring_behaviour(monkeypatch):
    """Corollary of the test above: on the None path the recovered asks are
    dropped again (recall ~50%). That is the documented cost of a Gemini
    outage — losing leads beats emailing tradesmen."""
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None,
    )
    kept = fb._apply_consumer_filter_chain(
        [_stub(_ASK_SHOWER, 'a'), _stub(_ASK_PLAIN, 'b')],
        niche='plumber', location='Manchester', filters=_ENGLISH_FILTERS,
    )
    assert _excerpts(kept) == [_ASK_PLAIN]


def test_llm_skipped_event_still_fires_on_the_none_path(monkeypatch):
    """The SSE stream and job UI parse this stage name — it must not be
    renamed or dropped."""
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None,
    )
    events: list = []
    fb._apply_consumer_filter_chain(
        [_stub(_ASK_PLAIN, 'jane')],
        niche='plumber', location='Manchester', filters=_ENGLISH_FILTERS,
        on_progress=events.append,
    )
    skipped = [e for e in events if e.get('stage') == 'llm_skipped']
    assert len(skipped) == 1
    assert skipped[0].get('reason')


def test_consumer_filtered_event_still_fires_on_the_fallback_path(monkeypatch):
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None,
    )
    events: list = []
    fb._apply_consumer_filter_chain(
        [_stub(_ADVERT_DROPPED_BY_SUBSTRING, 'abc'), _stub(_ASK_PLAIN, 'jane')],
        niche='plumber', location='Manchester', filters=_ENGLISH_FILTERS,
        on_progress=events.append,
    )
    filtered = [e for e in events if e.get('stage') == 'consumer_filtered']
    assert len(filtered) == 1
    assert filtered[0]['dropped'] == 1
    assert filtered[0]['kept'] == 1
    assert filtered[0].get('reason')


def test_llm_filtered_event_still_fires_with_the_same_detail_keys(monkeypatch):
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', _verdicts_from({_ASK_PLAIN}),
    )
    events: list = []
    fb._apply_consumer_filter_chain(
        [_stub(_ADVERT_KEPT_BY_SUBSTRING, 'watkins'), _stub(_ASK_PLAIN, 'jane')],
        niche='plumber', location='Manchester', filters=_ENGLISH_FILTERS,
        on_progress=events.append,
    )
    filtered = [e for e in events if e.get('stage') == 'llm_filtered']
    assert len(filtered) == 1
    assert filtered[0]['dropped'] == 1
    assert filtered[0]['kept'] == 1
    assert filtered[0].get('reason')
    # The substring filter must NOT have run, so no consumer_filtered event.
    assert not any(e.get('stage') == 'consumer_filtered' for e in events)


def test_use_llm_classifier_false_applies_the_substring_filter(monkeypatch):
    """Operator opt-out is unchanged: no classifier call at all, substring
    heuristics gate the output."""
    def boom(*a, **k):
        raise AssertionError('use_llm_classifier=False must not call Gemini')

    monkeypatch.setattr(fb, '_classify_consumer_posts_with_gemini', boom)
    kept = fb._apply_consumer_filter_chain(
        [_stub(_ADVERT_DROPPED_BY_SUBSTRING, 'abc'),
         _stub(_ASK_SHOWER, 'a'),
         _stub(_ASK_PLAIN, 'jane')],
        niche='plumber', location='Manchester',
        filters={**_ENGLISH_FILTERS, 'use_llm_classifier': False},
    )
    assert _excerpts(kept) == [_ASK_PLAIN]


def _apify_returning(texts):
    def fake_run_actor(actor, run_input, **kw):
        if run_input.get('search_type') == 'groups':
            return []
        return [
            {'url': f'https://fb/p/{i}', 'message': t,
             'user': {'name': f'U{i}', 'profile_url': f'https://fb/u{i}'}}
            for i, t in enumerate(texts)
        ]
    return fake_run_actor


def test_search_posts_lets_gemini_recover_the_substring_rejects(monkeypatch):
    """End-to-end through the real entry point, not just the helper."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', _apify_returning(
        [_ASK_SHOWER, _ADVERT_KEPT_BY_SUBSTRING]))
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', _verdicts_from({_ASK_SHOWER}),
    )

    scraper = fb.FacebookScraper()
    stubs = asyncio.run(scraper.search_posts(
        'need a plumber recommendation', dict(_ENGLISH_FILTERS), max_results=10,
    ))
    assert _excerpts(stubs) == [_ASK_SHOWER]


def test_scrape_listing_open_feed_classifies_once_not_twice(monkeypatch):
    """scrape_listing(groups_only=False) delegates to search_posts, which has
    ALREADY run the whole chain. The old code then re-ran the substring
    pre-gate plus a SECOND Gemini call on the result — re-destroying every
    recovered lead and paying twice per job."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', _apify_returning(
        [_ASK_SHOWER, _ASK_DEVINE]))
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)

    calls = {'n': 0}
    accept_all = _verdicts_from({_ASK_SHOWER, _ASK_DEVINE})

    def counting(excerpts, niche, location=None, **kw):
        calls['n'] += 1
        return accept_all(excerpts, niche, location=location, **kw)

    monkeypatch.setattr(fb, '_classify_consumer_posts_with_gemini', counting)

    scraper = fb.FacebookScraper()
    out = asyncio.run(scraper.scrape_listing(dict(_ENGLISH_FILTERS), max_results=10))
    assert calls['n'] == 1, 'the classifier must be invoked exactly once per job'
    assert _excerpts(out) == [_ASK_SHOWER, _ASK_DEVINE]


def test_scrape_listing_group_first_still_applies_the_chain(monkeypatch):
    """The group-first branch produces RAW stubs (it never goes through
    search_posts), so the chain must still run there — otherwise adverts
    reach upsert_leads unfiltered."""
    monkeypatch.setenv('FB_DISCOVERY', 'browser')
    monkeypatch.setattr(
        fb.FacebookScraper, '_sync_group_first_scrape',
        lambda self, niche, location, on_progress, cap: [
            _stub(_ADVERT_KEPT_BY_SUBSTRING, 'watkins'),
            _stub(_ASK_SHOWER, 'jane'),
        ],
    )
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', _verdicts_from({_ASK_SHOWER}),
    )
    scraper = fb.FacebookScraper()
    out = asyncio.run(scraper.scrape_listing(
        {**_ENGLISH_FILTERS, 'groups_only': True}, max_results=10,
    ))
    assert _excerpts(out) == [_ASK_SHOWER]


# ==========================================================================
# Non-English fail-closed: no verdicts AND no applicable substring filter
# ==========================================================================
#
# _consumer_filter_defaults returns (False, False) for non-English markets
# (Frankfurt/Milan/Paris/...) BY DESIGN — the substring heuristics are
# English-only, so the multilingual Gemini classifier is meant to be the
# SOLE gate there. That meant a Gemini outage on a non-English market used
# to fall all the way through `_apply_consumer_filter_chain` to `return
# stubs`: nothing was left to filter, so every advert shipped to
# upsert_leads.py unfiltered. That is exactly how a beauty business
# ("My My Lashes") got saved as an electrician lead during a Frankfurt run
# when the classifier was skipped. The fix: fail CLOSED (return []) and
# emit a named, honest event instead of silently shipping junk leads into a
# production CRM that feeds cold email.

_FRANKFURT_FILTERS = {
    'niche': 'Klempner',
    'location': 'Frankfurt',
    'groups_only': False,
}

# Three adverts probed live against the Frankfurt/no-classifier path.
# Manchester's substring filter drops all three; Frankfurt's pre-fix
# unfiltered exit kept all three.
_ADVERT_TALBOT = 'For all your Plumbing needs, call Talbot Plumbing'
_ADVERT_GERMAN_TRADESMAN = (
    'Ich biete Klempnerarbeiten an, schnell und zuverlässig, jederzeit '
    'erreichbar. Rufen Sie mich an!'
)
_ADVERT_EMERGENCY = 'PLUMBING EMERGENCY? DO NOT WAIT'

# A genuine German consumer ask (no CONSUMER_PATTERNS entry is German, so
# the — inapplicable, English-only — substring filter would never have kept
# this even if it somehow ran). Only Gemini can recognise it.
_ASK_GERMAN = 'Ich suche einen Klempner in Frankfurt, kann jemand einen empfehlen?'


def test_non_english_no_verdicts_fails_closed(monkeypatch):
    """THE HOLE. Frankfurt has no substring filter (exclude_businesses=
    asking_only=False by design), so a Gemini outage must not fall through
    to 'keep everything' — it must drop the whole batch."""
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None,
    )
    kept = fb._apply_consumer_filter_chain(
        [
            _stub(_ADVERT_TALBOT, 'talbot'),
            _stub(_ADVERT_GERMAN_TRADESMAN, 'handwerker'),
            _stub(_ADVERT_EMERGENCY, 'emergency'),
        ],
        niche='Klempner', location='Frankfurt', filters=_FRANKFURT_FILTERS,
    )
    assert kept == []


def test_non_english_no_verdicts_emits_consumer_filter_unavailable(monkeypatch):
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None,
    )
    events: list = []
    fb._apply_consumer_filter_chain(
        [_stub(_ADVERT_TALBOT, 'talbot')],
        niche='Klempner', location='Frankfurt', filters=_FRANKFURT_FILTERS,
        on_progress=events.append,
    )
    unavailable = [e for e in events if e.get('stage') == 'consumer_filter_unavailable']
    assert len(unavailable) == 1
    assert unavailable[0].get('reason')
    assert unavailable[0].get('location') == 'Frankfurt'
    # The substring path never ran — no consumer_filtered event either.
    assert not any(e.get('stage') == 'consumer_filtered' for e in events)


def test_english_no_verdicts_still_falls_back_to_substring_filter(monkeypatch):
    """Control: the English path (a language-appropriate substring filter DOES
    exist) must be byte-for-byte unchanged by the fail-closed fix."""
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None,
    )
    events: list = []
    kept = fb._apply_consumer_filter_chain(
        [
            _stub(_ADVERT_TALBOT, 'talbot'),
            _stub(_ADVERT_EMERGENCY, 'emergency'),
            _stub(_ASK_PLAIN, 'jane'),
        ],
        niche='plumber', location='Manchester', filters=_ENGLISH_FILTERS,
        on_progress=events.append,
    )
    assert _excerpts(kept) == [_ASK_PLAIN]
    assert not any(e.get('stage') == 'consumer_filter_unavailable' for e in events)
    filtered = [e for e in events if e.get('stage') == 'consumer_filtered']
    assert len(filtered) == 1


def test_non_english_gemini_verdicts_still_sole_gate(monkeypatch):
    """Fix must not regress the intended non-English design: when Gemini DOES
    answer, its verdicts are the sole gate — a genuine German ask survives
    even though no (English-only, inapplicable) substring filter would ever
    have kept it, and the new fail-closed event must NOT fire."""
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini',
        _verdicts_from({_ASK_GERMAN}),
    )
    events: list = []
    kept = fb._apply_consumer_filter_chain(
        [_stub(_ASK_GERMAN, 'hans'), _stub(_ADVERT_GERMAN_TRADESMAN, 'handwerker')],
        niche='Klempner', location='Frankfurt', filters=_FRANKFURT_FILTERS,
        on_progress=events.append,
    )
    assert _excerpts(kept) == [_ASK_GERMAN]
    assert not any(e.get('stage') == 'consumer_filter_unavailable' for e in events)


def test_non_english_use_llm_classifier_false_also_fails_closed(monkeypatch):
    """Operator opt-out (use_llm_classifier=False) skips Gemini entirely, but
    the outcome on a non-English market must be identical to a Gemini outage:
    no classifier + no applicable substring filter -> drop the batch rather
    than ship it unfiltered."""
    def boom(*a, **k):
        raise AssertionError('use_llm_classifier=False must not call Gemini')

    monkeypatch.setattr(fb, '_classify_consumer_posts_with_gemini', boom)
    events: list = []
    kept = fb._apply_consumer_filter_chain(
        [_stub(_ADVERT_TALBOT, 'talbot'), _stub(_ADVERT_GERMAN_TRADESMAN, 'handwerker')],
        niche='Klempner', location='Frankfurt',
        filters={**_FRANKFURT_FILTERS, 'use_llm_classifier': False},
        on_progress=events.append,
    )
    assert kept == []
    unavailable = [e for e in events if e.get('stage') == 'consumer_filter_unavailable']
    assert len(unavailable) == 1


def test_llm_skipped_reason_is_accurate_for_english_and_non_english(monkeypatch):
    """The 'llm_skipped' event NAME is parsed downstream and must not change,
    but its reason string must stop falsely claiming a substring filter ran
    when none exists for the market."""
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None,
    )

    english_events: list = []
    fb._apply_consumer_filter_chain(
        [_stub(_ASK_PLAIN, 'jane')],
        niche='plumber', location='Manchester', filters=_ENGLISH_FILTERS,
        on_progress=english_events.append,
    )
    english_skipped = [e for e in english_events if e.get('stage') == 'llm_skipped']
    assert len(english_skipped) == 1
    english_reason = english_skipped[0]['reason']
    assert 'substring filter' in english_reason
    assert 'no language-appropriate' not in english_reason

    non_english_events: list = []
    fb._apply_consumer_filter_chain(
        [_stub(_ADVERT_TALBOT, 'talbot')],
        niche='Klempner', location='Frankfurt', filters=_FRANKFURT_FILTERS,
        on_progress=non_english_events.append,
    )
    non_english_skipped = [e for e in non_english_events if e.get('stage') == 'llm_skipped']
    assert len(non_english_skipped) == 1
    non_english_reason = non_english_skipped[0]['reason']
    assert 'no language-appropriate' in non_english_reason
    assert non_english_reason != english_reason


# ==========================================================================
# Intent vs GEOGRAPHY on the Apify path
# ==========================================================================
#
# THE BUG (measured live 2026-08-04, 20 real posts, same niche, only the
# location argument differing):
#
#   _classify_consumer_posts_with_gemini(excerpts, 'plumber', location='')
#       -> kept 7/20
#   _classify_consumer_posts_with_gemini(excerpts, 'plumber', location='Manchester')
#       -> kept 0/20
#
# and a live end-to-end Apify run with location='Manchester' produced
# "20 mapped, llm_filtered dropped=20 kept=0, search_done:0" â€” i.e. EVERY
# dashboard scrape on the Apify path returned zero leads.
#
# Root cause is an architectural mismatch, not a prompt bug. The Apify actor
# searches Facebook GLOBALLY (we deliberately do NOT feed it location_uid â€”
# that would need a seeded Facebook geo-ID table), so its results are
# geographically scattered: the 20-post sample contained Devine TX and
# assorted other US/UK places. The classifier is then handed the operator's
# target city and its location clause is strict at CITY level ("a different
# city or region in the same country ... is FALSE"), so it correctly rejects
# essentially everything. Geography was being enforced at the WRONG STAGE â€”
# against candidates that were never geo-filtered in the first place.
#
# The BROWSER path never had this problem: its Facebook search is itself
# geo-scoped (group discovery uses a geo-stuffed term and
# _is_consumer_facing_group drops wrong-country groups), so passing location
# to the classifier there is consistent. That path must not change.
#
# The fix separates the two judgements on the non-geo-scoped path:
#   1. intent â€” classifier called WITHOUT location
#   2. geography â€” an explicit post-hoc COUNTRY filter using the evidence in
#      the post itself, keeping posts whose country cannot be resolved, and
#      emitting its own 'geo_filtered' event so intent-vs-geography are two
#      visible numbers instead of one mysterious zero.

# A genuine consumer ask that resolves to a DIFFERENT country than a
# Manchester (GB) search: 'austin' -> US in CITY_TO_COUNTRY. Phrased so the
# substring filter also KEEPS it, which lets the same excerpt exercise the
# geo stage on the Gemini path AND on the substring-fallback path.
_ASK_AUSTIN_US = (
    'Anyone know a plumber in Austin who can look at a leaking radiator?'
)


def _capturing_verdicts(accepted: set, captured: dict):
    """Fake classifier that also records the kwargs it was called with."""
    def fake(excerpts, niche, location=None, **kw):
        captured['location'] = location
        captured['niche'] = niche
        captured['calls'] = captured.get('calls', 0) + 1
        return [e in accepted for e in excerpts]
    return fake


def _run_apify_search(monkeypatch, texts, verdicts_fn, filters=None, events=None,
                       query='need a plumber recommendation'):
    """Drive the real search_posts entry point over a faked Apify dataset."""
    monkeypatch.setenv('FB_DISCOVERY', 'apify')
    monkeypatch.setattr(fb.apify, 'run_actor', _apify_returning(texts))
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)
    monkeypatch.setattr(fb, '_classify_consumer_posts_with_gemini', verdicts_fn)
    scraper = fb.FacebookScraper()
    return asyncio.run(scraper.search_posts(
        query,
        dict(filters or _ENGLISH_FILTERS),
        max_results=10,
        on_progress=(events.append if events is not None else None),
    ))


def test_apify_intent_judging_receives_no_location(monkeypatch):
    """THE FIX. Apify results are globally scattered, so the classifier must
    judge INTENT ONLY â€” handing it the target city is what produced kept=0/20
    on every live run. A post that does resolve to the target country still
    has to come out the other end."""
    captured: dict = {}
    stubs = _run_apify_search(
        monkeypatch, [_ASK_PLAIN],
        _capturing_verdicts({_ASK_PLAIN}, captured),
    )
    assert captured['calls'] == 1
    assert not captured['location'], (
        'intent judging must NOT be given the target location on the Apify '
        'path (got {!r})'.format(captured['location'])
    )
    assert captured['niche'] == 'plumber', 'the niche is still passed'
    assert _excerpts(stubs) == [_ASK_PLAIN]


def test_apify_geo_stage_drops_a_different_country_and_emits_geo_filtered(monkeypatch):
    """Geography still has to be enforced â€” just explicitly, after intent, and
    visibly. Intent accepts both asks; the Austin (US) one resolves to a
    different country than a Manchester (GB) search and is dropped."""
    events: list = []
    captured: dict = {}
    stubs = _run_apify_search(
        monkeypatch, [_ASK_AUSTIN_US, _ASK_PLAIN],
        _capturing_verdicts({_ASK_AUSTIN_US, _ASK_PLAIN}, captured),
        events=events,
    )
    assert _excerpts(stubs) == [_ASK_PLAIN]
    geo = [e for e in events if e.get('stage') == 'geo_filtered']
    assert len(geo) == 1, 'the geographic drop needs its own visible event'
    assert geo[0]['dropped'] == 1
    assert geo[0]['kept'] == 1
    assert geo[0]['target_country'] == 'GB'
    assert geo[0].get('reason')
    # Intent and geography must be two SEPARATE numbers â€” a single
    # llm_filtered=2 is exactly the mystery this fix removes.
    assert not any(e.get('stage') == 'llm_filtered' for e in events)


def test_apify_geo_stage_keeps_posts_whose_country_is_unresolved(monkeypatch):
    """Absence of evidence is not evidence of a mismatch. Most real consumer
    asks name no place at all ('recently moved to the area'); dropping those
    would silently discard the best leads in the batch."""
    events: list = []
    captured: dict = {}
    assert fb._extract_country_from_excerpt(_ASK_MOVED) is None, 'ground truth'
    stubs = _run_apify_search(
        monkeypatch, [_ASK_MOVED, _ASK_SHOWER],
        _capturing_verdicts({_ASK_MOVED, _ASK_SHOWER}, captured),
        events=events,
    )
    assert _excerpts(stubs) == [_ASK_MOVED, _ASK_SHOWER]
    geo = [e for e in events if e.get('stage') == 'geo_filtered']
    assert len(geo) == 1
    assert geo[0]['dropped'] == 0
    assert geo[0]['kept'] == 2


def test_browser_discovery_still_passes_location_to_the_classifier(monkeypatch):
    """The browser search is itself geo-scoped, so location stays in the
    classifier call there and no post-hoc geo stage runs. The regime is decided
    by the discovery source, never guessed."""
    monkeypatch.setenv('FB_DISCOVERY', 'browser')
    monkeypatch.setattr(fb, '_translate_niche_to_local', lambda niche, loc: niche)
    monkeypatch.setattr(
        fb.FacebookScraper, '_sync_search_posts',
        lambda self, query, groups_only, max_results, on_progress: [
            _stub(_ASK_AUSTIN_US, 'austin'), _stub(_ASK_PLAIN, 'jane'),
        ],
    )
    captured: dict = {}
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini',
        _capturing_verdicts({_ASK_AUSTIN_US, _ASK_PLAIN}, captured),
    )
    events: list = []
    scraper = fb.FacebookScraper()
    stubs = asyncio.run(scraper.search_posts(
        'plumber Manchester', dict(_ENGLISH_FILTERS), max_results=10,
        on_progress=events.append,
    ))
    assert captured['location'] == 'Manchester', (
        'the browser path must keep enforcing geography inside the classifier'
    )
    # No post-hoc country filter on this path: the classifier already had the
    # location, so a second geographic opinion would be double-counting.
    assert not any(e.get('stage') == 'geo_filtered' for e in events)
    assert _excerpts(stubs) == [_ASK_AUSTIN_US, _ASK_PLAIN]


def test_browser_group_first_chain_still_passes_location(monkeypatch):
    """Same for the browser group-first branch reached via scrape_listing â€”
    those groups were geo-selected, so location keeps going to the
    classifier."""
    monkeypatch.setenv('FB_DISCOVERY', 'browser')
    monkeypatch.setattr(
        fb.FacebookScraper, '_sync_group_first_scrape',
        lambda self, niche, location, on_progress, cap: [_stub(_ASK_PLAIN, 'jane')],
    )
    captured: dict = {}
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini',
        _capturing_verdicts({_ASK_PLAIN}, captured),
    )
    scraper = fb.FacebookScraper()
    out = asyncio.run(scraper.scrape_listing(
        {**_ENGLISH_FILTERS, 'groups_only': True}, max_results=10,
    ))
    assert captured['location'] == 'Manchester'
    assert _excerpts(out) == [_ASK_PLAIN]


def test_geo_stage_runs_after_the_substring_fallback(monkeypatch):
    """The geo stage sits after WHICHEVER intent gate ran. On a Gemini outage
    the substring fallback judges intent and the country filter still trims
    geography â€” and both events fire, so the operator sees where each lead
    went."""
    events: list = []
    stubs = _run_apify_search(
        monkeypatch,
        [_ADVERT_DROPPED_BY_SUBSTRING, _ASK_AUSTIN_US, _ASK_PLAIN],
        lambda *a, **k: None,
        events=events,
    )
    assert _excerpts(stubs) == [_ASK_PLAIN]
    consumer = [e for e in events if e.get('stage') == 'consumer_filtered']
    assert len(consumer) == 1 and consumer[0]['dropped'] == 1
    geo = [e for e in events if e.get('stage') == 'geo_filtered']
    assert len(geo) == 1 and geo[0]['dropped'] == 1 and geo[0]['kept'] == 1


def test_geo_stage_is_a_noop_when_the_target_country_cannot_be_resolved(monkeypatch):
    """An unmapped operator location ('Nairobi') gives no country to compare
    against. Guessing would be worse than the bug being fixed, so keep
    everything and SAY so â€” the event still fires with target_country None."""
    assert fb._extract_country_from_excerpt('Nairobi') is None, 'ground truth'
    events: list = []
    captured: dict = {}
    stubs = _run_apify_search(
        monkeypatch, [_ASK_AUSTIN_US, _ASK_PLAIN],
        _capturing_verdicts({_ASK_AUSTIN_US, _ASK_PLAIN}, captured),
        filters={**_ENGLISH_FILTERS, 'location': 'Nairobi'},
        events=events,
    )
    assert _excerpts(stubs) == [_ASK_AUSTIN_US, _ASK_PLAIN]
    geo = [e for e in events if e.get('stage') == 'geo_filtered']
    assert len(geo) == 1
    assert geo[0]['dropped'] == 0
    assert geo[0]['target_country'] is None
    assert geo[0].get('reason')


def test_geo_stage_reads_the_group_name_as_evidence(monkeypatch):
    """Group-sourced Apify stubs carry group_name, which is often the only
    geographic signal in the batch ('Sydney Tradies' + a placeless ask)."""
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini',
        _verdicts_from({_ASK_SHOWER, _ASK_MOVED}),
    )
    au = {**_stub(_ASK_SHOWER, 'bruce'), 'group_name': 'Sydney Tradies'}
    unknown = {**_stub(_ASK_MOVED, 'jane'), 'group_name': 'Trade Recommendations'}
    events: list = []
    kept = fb._apply_consumer_filter_chain(
        [au, unknown], niche='plumber', location='Manchester',
        filters=_ENGLISH_FILTERS, geo_scoped=False, on_progress=events.append,
    )
    assert _excerpts(kept) == [_ASK_MOVED]
    geo = [e for e in events if e.get('stage') == 'geo_filtered']
    assert len(geo) == 1 and geo[0]['dropped'] == 1


def test_geo_stage_does_not_mask_the_non_english_fail_closed_case(monkeypatch):
    """Fail-closed still wins: no intent gate at all means the batch is
    dropped with 'consumer_filter_unavailable', and the geo stage never gets a
    chance to reframe an ungated batch as a geographic result."""
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini', lambda *a, **k: None,
    )
    events: list = []
    kept = fb._apply_consumer_filter_chain(
        [_stub(_ADVERT_TALBOT, 'talbot'), _stub(_ASK_GERMAN, 'hans')],
        niche='Klempner', location='Frankfurt', filters=_FRANKFURT_FILTERS,
        geo_scoped=False, on_progress=events.append,
    )
    assert kept == []
    assert len([e for e in events if e.get('stage') == 'consumer_filter_unavailable']) == 1
    assert not any(e.get('stage') == 'geo_filtered' for e in events)


def test_geo_scoped_default_keeps_the_legacy_behaviour(monkeypatch):
    """Every pre-existing caller and test calls the chain without the new flag;
    the default must be the geo-scoped (browser) regime â€” location goes to the
    classifier, no country filter, exactly as before."""
    captured: dict = {}
    monkeypatch.setattr(
        fb, '_classify_consumer_posts_with_gemini',
        _capturing_verdicts({_ASK_AUSTIN_US}, captured),
    )
    events: list = []
    kept = fb._apply_consumer_filter_chain(
        [_stub(_ASK_AUSTIN_US, 'austin')],
        niche='plumber', location='Manchester', filters=_ENGLISH_FILTERS,
        on_progress=events.append,
    )
    assert captured['location'] == 'Manchester'
    assert _excerpts(kept) == [_ASK_AUSTIN_US]
    assert not any(e.get('stage') == 'geo_filtered' for e in events)


# ==========================================================================
# PLACE-ANCHORED QUERIES override the post-hoc geo filter
# ==========================================================================
#
# When the search query itself names the operator's location ("need a
# plumber recommendation Manchester"), Facebook has already scoped the
# results to that place — re-running _apply_geo_country_filter on top would
# only discard genuine local posts that don't spell out their own city (the
# poster already knows where they are), for zero geographic benefit.
# Detected from the actual QUERY TEXT (_query_is_place_anchored), never from
# the discovery source — an operator can submit any query on either path.


def test_query_is_place_anchored_true_when_query_contains_the_location():
    assert fb._query_is_place_anchored(
        'need a plumber recommendation Manchester', 'Manchester',
    )


def test_query_is_place_anchored_is_case_insensitive():
    """Lowercase place name in the query, capitalised location filter — still
    counts as place-anchored."""
    assert fb._query_is_place_anchored(
        'need a plumber recommendation manchester', 'Manchester',
    )
    assert fb._query_is_place_anchored(
        'need a plumber recommendation MANCHESTER', 'manchester',
    )


def test_query_is_place_anchored_false_when_query_omits_the_place():
    """An operator can type any query — omitting the place must NOT be
    treated as place-anchored."""
    assert not fb._query_is_place_anchored('need a plumber recommendation', 'Manchester')


def test_query_is_place_anchored_false_with_no_location():
    assert not fb._query_is_place_anchored('need a plumber recommendation', '')
    assert not fb._query_is_place_anchored('need a plumber recommendation', None)


def test_place_anchored_apify_query_skips_the_geo_filter(monkeypatch):
    """THE OVERRIDE. The query names Manchester, so Facebook already scoped
    the results: a different-country post (Austin, US) AND an unresolved
    post BOTH survive, and the geo_filtered event never fires."""
    events: list = []
    stubs = _run_apify_search(
        monkeypatch, [_ASK_AUSTIN_US, _ASK_MOVED],
        _verdicts_from({_ASK_AUSTIN_US, _ASK_MOVED}),
        events=events,
        query='need a plumber recommendation Manchester',
    )
    assert _excerpts(stubs) == [_ASK_AUSTIN_US, _ASK_MOVED]
    assert not any(e.get('stage') == 'geo_filtered' for e in events)


def test_place_anchored_query_case_insensitive_still_skips_the_geo_filter(monkeypatch):
    """Same override, but the query's place name is lowercase while the
    location filter is capitalised — must still be detected as place-anchored."""
    events: list = []
    stubs = _run_apify_search(
        monkeypatch, [_ASK_AUSTIN_US],
        _verdicts_from({_ASK_AUSTIN_US}),
        events=events,
        query='need a plumber recommendation manchester',
    )
    assert _excerpts(stubs) == [_ASK_AUSTIN_US]
    assert not any(e.get('stage') == 'geo_filtered' for e in events)


def test_non_place_anchored_apify_query_still_filters_exactly_as_before(monkeypatch):
    """Control: a query that does NOT name the place must keep today's
    behaviour unchanged — the foreign-country post is dropped, the unresolved
    post is kept, and the geo_filtered event still fires."""
    events: list = []
    stubs = _run_apify_search(
        monkeypatch, [_ASK_AUSTIN_US, _ASK_MOVED],
        _verdicts_from({_ASK_AUSTIN_US, _ASK_MOVED}),
        events=events,
        query='need a plumber recommendation',
    )
    assert _excerpts(stubs) == [_ASK_MOVED]
    geo = [e for e in events if e.get('stage') == 'geo_filtered']
    assert len(geo) == 1
    assert geo[0]['dropped'] == 1
    assert geo[0]['kept'] == 1
