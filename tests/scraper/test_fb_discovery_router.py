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
