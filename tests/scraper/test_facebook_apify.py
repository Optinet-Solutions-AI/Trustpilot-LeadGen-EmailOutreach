"""Pure-function tests for Apify->PostStub mapping. No network."""
from tools.scraper.platforms import facebook_apify as fa


def test_actor_ids_come_from_env_not_literals(monkeypatch):
    monkeypatch.delenv('APIFY_FB_SEARCH_ACTOR', raising=False)
    assert fa.search_actor() == 'scrapeforge/facebook-search-posts'
    monkeypatch.setenv('APIFY_FB_SEARCH_ACTOR', 'scraper_one/facebook-posts-search')
    assert fa.search_actor() == 'scraper_one/facebook-posts-search'
    monkeypatch.delenv('APIFY_FB_GROUP_POSTS_ACTOR', raising=False)
    assert fa.group_posts_actor() == 'memo23/facebook-public-group-posts-scraper'
    monkeypatch.setenv('APIFY_FB_GROUP_POSTS_ACTOR', 'someone/other-group-actor')
    assert fa.group_posts_actor() == 'someone/other-group-actor'


def test_group_posts_actor_default_is_not_the_dead_actor(monkeypatch):
    """data-slayer/facebook-group-posts returns 0 items even for its own
    documented default input (verified live 2026-08-03). Defaulting to it made
    every group poll silently empty."""
    monkeypatch.delenv('APIFY_FB_GROUP_POSTS_ACTOR', raising=False)
    assert 'data-slayer' not in fa.group_posts_actor()


def test_build_search_input_sets_keyword_and_caps():
    got = fa.build_search_input('plumber Manchester', max_results=25)
    assert got['query'] == 'plumber Manchester'
    assert got['search_type'] == 'posts'
    assert got['max_results'] == 25
    assert got['recent_posts'] is True


def test_build_search_input_supports_group_discovery():
    got = fa.build_search_input('plumber Manchester', max_results=10, search_type='groups')
    assert got['search_type'] == 'groups'


def test_build_search_input_omits_absent_date():
    assert 'start_date' not in fa.build_search_input('x', max_results=5)
    got = fa.build_search_input('x', max_results=5, start_date='2026-07-01')
    assert got['start_date'] == '2026-07-01'


# ==========================================================================
# memo23/facebook-public-group-posts-scraper — input builder
# ==========================================================================
#
# Schema read verbatim off build 0.0.63 (2026-08-04):
#   startUrls array REQUIRED / search string / maxItems integer /
#   onlyPostsNewerThanHours integer / viewOption string / includeComments bool
# Its keys share NOTHING with the dead data-slayer actor's {groupId, maxPages},
# so the old builder was deleted rather than kept alongside this one.

_G1 = 'https://www.facebook.com/groups/1572344082987398'
_G2 = 'https://www.facebook.com/groups/435424147376112'


def test_build_group_posts_input_uses_start_urls_not_group_id():
    got = fa.build_group_posts_input([_G1, _G2], max_items=25)
    assert got['startUrls'] == [_G1, _G2]
    assert 'groupId' not in got
    assert 'maxPages' not in got


def test_build_group_posts_input_sets_per_group_item_cap():
    assert fa.build_group_posts_input([_G1], max_items=40)['maxItems'] == 40


def test_build_group_posts_input_enforces_min_item_cap():
    """maxItems=0 would bill a run that can return nothing."""
    assert fa.build_group_posts_input([_G1], max_items=0)['maxItems'] >= 1


def test_build_group_posts_input_defaults_to_chronological_view():
    assert fa.build_group_posts_input([_G1], max_items=10)['viewOption'] == 'CHRONOLOGICAL'


def test_build_group_posts_input_includes_keyword_when_supplied():
    got = fa.build_group_posts_input([_G1], max_items=10, keyword='recommend')
    assert got['search'] == 'recommend'


def test_build_group_posts_input_omits_empty_keyword():
    """The actor filters on `search` BEFORE billing, so a keyword saves money —
    but an EMPTY string is a filter that matches nothing, which would return 0
    posts and look like a dead group."""
    for empty in (None, '', '   '):
        assert 'search' not in fa.build_group_posts_input([_G1], max_items=10, keyword=empty)


def test_build_group_posts_input_omits_freshness_window_by_default():
    assert 'onlyPostsNewerThanHours' not in fa.build_group_posts_input([_G1], max_items=10)


def test_build_group_posts_input_exposes_freshness_window():
    got = fa.build_group_posts_input([_G1], max_items=10, newer_than_hours=48)
    assert got['onlyPostsNewerThanHours'] == 48


def test_build_group_posts_input_normalises_bare_numeric_ids():
    got = fa.build_group_posts_input(['1572344082987398'], max_items=10)
    assert got['startUrls'] == ['https://www.facebook.com/groups/1572344082987398']


def test_build_group_posts_input_accepts_a_single_string():
    assert fa.build_group_posts_input(_G1, max_items=10)['startUrls'] == [_G1]


def test_build_group_posts_input_rejects_an_empty_group_list():
    """startUrls is REQUIRED — an empty array would launch a billable run that
    cannot return anything."""
    import pytest
    with pytest.raises(ValueError):
        fa.build_group_posts_input([], max_items=10)


# -- group URL normalisation ------------------------------------------------


def test_normalise_group_url_passes_full_urls_through():
    assert fa.normalise_group_url(_G1) == _G1


def test_normalise_group_url_wraps_bare_numeric_ids():
    assert fa.normalise_group_url('435424147376112') == \
        'https://www.facebook.com/groups/435424147376112'


def test_normalise_group_url_accepts_integer_ids():
    assert fa.normalise_group_url(435424147376112) == \
        'https://www.facebook.com/groups/435424147376112'


def test_normalise_group_url_wraps_bare_slugs():
    assert fa.normalise_group_url('manchestertradespeople') == \
        'https://www.facebook.com/groups/manchestertradespeople'


def test_normalise_group_url_upgrades_scheme_relative_and_bare_hosts():
    assert fa.normalise_group_url('facebook.com/groups/123').startswith('https://')
    assert fa.normalise_group_url('www.facebook.com/groups/123').startswith('https://')


def test_normalise_group_url_returns_none_for_blanks():
    for blank in (None, '', '   '):
        assert fa.normalise_group_url(blank) is None


def test_parse_group_urls_normalises_and_drops_blanks():
    assert fa.parse_group_urls([_G1, '', '435424147376112', None]) == [
        _G1, 'https://www.facebook.com/groups/435424147376112',
    ]


def test_parse_group_urls_accepts_a_comma_separated_string():
    """Operators paste lists; the CLI --filters JSON may carry one string."""
    assert fa.parse_group_urls(f'{_G1}, 435424147376112') == [
        _G1, 'https://www.facebook.com/groups/435424147376112',
    ]


def test_parse_group_urls_dedupes():
    assert fa.parse_group_urls([_G1, _G1]) == [_G1]


def test_parse_group_urls_of_nothing_is_empty():
    assert fa.parse_group_urls(None) == []
    assert fa.parse_group_urls([]) == []


def test_group_id_from_url_extracts_the_id():
    assert fa.group_id_from_url(_G1) == '1572344082987398'
    assert fa.group_id_from_url(
        'https://www.facebook.com/groups/1772363682936388/permalink/336/'
    ) == '1772363682936388'
    assert fa.group_id_from_url('https://www.facebook.com/nope') is None


def test_post_to_stub_maps_every_field():
    item = {
        'url': 'https://www.facebook.com/groups/123/posts/456/',
        'message': 'Anyone know a good plumber in Manchester?',
        'timestamp': '2026-07-30T09:12:00Z',
        'user': {
            'name': 'Jane Doe',
            'profile_url': 'https://www.facebook.com/jane.doe.5',
            'id': 'jane.doe.5',
        },
        'attachments': [{'url': 'https://scontent.example/1.jpg'}],
    }
    stub = fa.post_to_stub(item)
    assert stub['platform'] == 'facebook'
    assert stub['post_url'] == 'https://www.facebook.com/groups/123/posts/456/'
    assert stub['content_excerpt'] == 'Anyone know a good plumber in Manchester?'
    assert stub['author_profile_url'] == 'https://www.facebook.com/jane.doe.5'
    assert stub['author_handle'] == 'jane.doe.5'
    assert stub['display_name'] == 'Jane Doe'
    assert stub['posted_at'] == '2026-07-30T09:12:00Z'
    assert stub['media_urls'] == ['https://scontent.example/1.jpg']


def test_post_to_stub_handles_mixed_attachment_shapes():
    item = {
        'url': 'https://www.facebook.com/p/1',
        'message': 'see attachments',
        'user': {'profile_url': 'https://www.facebook.com/user1'},
        'attachments': [
            {'url': 'https://scontent.example/real1.jpg'},
            {'type': 'photo'},  # dict without url
            'https://scontent.example/real2.jpg',  # string url
        ],
    }
    stub = fa.post_to_stub(item)
    assert stub['media_urls'] == ['https://scontent.example/real1.jpg', 'https://scontent.example/real2.jpg']
    assert None not in stub['media_urls']


def test_post_to_stub_handles_integer_id():
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/1',
        'message': 'need a plumber',
        'user': {'profile_url': 'https://www.facebook.com/profile.php?id=987654321', 'id': 987654321},
    })
    assert stub is not None
    assert stub['author_handle'] == '987654321'


def test_post_to_stub_tolerates_missing_optional_fields():
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/1',
        'message': 'need a roofer',
        'user': {'profile_url': 'https://www.facebook.com/bob'},
    })
    assert stub['post_url'] == 'https://www.facebook.com/p/1'
    assert stub['media_urls'] == []
    assert stub.get('posted_at') is None
    assert stub['author_handle'] == 'bob'


def test_post_to_stub_drops_items_with_no_author_url():
    assert fa.post_to_stub({'url': 'https://x', 'message': 'hi', 'user': {}}) is None


def test_post_to_stub_drops_items_with_no_post_url():
    assert fa.post_to_stub({'message': 'hi', 'user': {'profile_url': 'https://fb/u'}}) is None


def test_group_posts_stub_carries_group_context():
    stub = fa.post_to_stub(
        {'url': 'https://fb/p/9', 'message': 'x', 'user': {'profile_url': 'https://fb/u'}},
        group_id='123',
        group_name='Manchester Tradespeople',
    )
    assert stub['group_id'] == '123'
    assert stub['group_name'] == 'Manchester Tradespeople'


# GAP 1: Media extraction from real actor shapes
def test_post_to_stub_extracts_media_from_image_uri():
    """Real actor shape: {"image": {"uri": "https://..."}}"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/1',
        'message': 'see photo',
        'user': {'profile_url': 'https://www.facebook.com/user1'},
        'image': {'uri': 'https://scontent.example/img.jpg'},
    })
    assert stub['media_urls'] == ['https://scontent.example/img.jpg']


def test_post_to_stub_extracts_media_from_video_fields():
    """Real actor shapes: video_files array, video dict with uri, video_thumbnail"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/2',
        'message': 'see video',
        'user': {'profile_url': 'https://www.facebook.com/user2'},
        'video_files': [
            {'uri': 'https://video.example/v1.mp4'},
            {'uri': 'https://video.example/v2.mp4'},
        ],
    })
    assert 'https://video.example/v1.mp4' in stub['media_urls']
    assert 'https://video.example/v2.mp4' in stub['media_urls']


def test_post_to_stub_handles_video_as_dict_with_uri():
    """video field as a dict with uri"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/3',
        'message': 'video',
        'user': {'profile_url': 'https://www.facebook.com/user3'},
        'video': {'uri': 'https://video.example/single.mp4'},
    })
    assert 'https://video.example/single.mp4' in stub['media_urls']


def test_post_to_stub_dedupes_media_urls():
    """If same URL appears in multiple fields, include only once"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/4',
        'message': 'mixed',
        'user': {'profile_url': 'https://www.facebook.com/user4'},
        'image': {'uri': 'https://shared.example/media.jpg'},
        'attachments': [{'url': 'https://shared.example/media.jpg'}],
    })
    assert stub['media_urls'].count('https://shared.example/media.jpg') == 1


# GAP 2: Group context from associated_group
def test_post_to_stub_derives_group_context_from_payload():
    """Extract group_id and group_name from associated_group in payload"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/5',
        'message': 'in group',
        'user': {'profile_url': 'https://www.facebook.com/user5'},
        'associated_group': {
            'group_id': '1572344082987398',
            'name': 'MANEA CAMBRIDGESHIRE DISCUSSION PAGE',
            'url': 'https://www.facebook.com/groups/1572344082987398/',
        },
    })
    assert stub['group_id'] == '1572344082987398'
    assert stub['group_name'] == 'MANEA CAMBRIDGESHIRE DISCUSSION PAGE'


def test_post_to_stub_uses_associated_group_id_fallback():
    """Fall back to top-level associated_group_id if associated_group missing"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/6',
        'message': 'in group',
        'user': {'profile_url': 'https://www.facebook.com/user6'},
        'associated_group_id': '999999999999999',
    })
    assert stub['group_id'] == '999999999999999'
    assert 'group_name' not in stub


def test_post_to_stub_explicit_args_override_payload_group_context():
    """Explicit group_id/group_name args (from group-posts path) win over payload"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/7',
        'message': 'in group',
        'user': {'profile_url': 'https://www.facebook.com/user7'},
        'associated_group': {
            'group_id': 'payload_group_id',
            'name': 'Payload Group Name',
        },
    }, group_id='explicit_group_id', group_name='Explicit Group Name')
    assert stub['group_id'] == 'explicit_group_id'
    assert stub['group_name'] == 'Explicit Group Name'


# GAP 3: Timestamp conversion
def test_post_to_stub_converts_epoch_timestamp_to_iso8601():
    """Convert Unix epoch integer to ISO-8601"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/8',
        'message': 'x',
        'user': {'profile_url': 'https://www.facebook.com/user8'},
        'timestamp': 1785741360,  # 2026-08-03T07:16:00+00:00
    })
    assert stub['posted_at'] == '2026-08-03T07:16:00+00:00'


def test_post_to_stub_converts_epoch_as_float():
    """Convert Unix epoch float to ISO-8601"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/9',
        'message': 'x',
        'user': {'profile_url': 'https://www.facebook.com/user9'},
        'timestamp': 1785741360.5,
    })
    assert stub['posted_at'] is not None
    assert '2026-08-03' in stub['posted_at']


def test_post_to_stub_converts_epoch_as_numeric_string():
    """Convert numeric string epoch to ISO-8601"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/10',
        'message': 'x',
        'user': {'profile_url': 'https://www.facebook.com/user10'},
        'timestamp': '1785741360',
    })
    assert stub['posted_at'] == '2026-08-03T07:16:00+00:00'


def test_post_to_stub_passes_iso_string_through():
    """ISO-8601 strings pass through untouched"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/11',
        'message': 'x',
        'user': {'profile_url': 'https://www.facebook.com/user11'},
        'timestamp': '2026-08-03T07:16:00Z',
    })
    assert stub['posted_at'] == '2026-08-03T07:16:00Z'


def test_post_to_stub_handles_invalid_timestamp():
    """Invalid timestamp values return None instead of crashing"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/12',
        'message': 'x',
        'user': {'profile_url': 'https://www.facebook.com/user12'},
        'timestamp': 'not-a-timestamp',
    })
    assert stub['posted_at'] is None


def test_post_to_stub_handles_none_timestamp():
    """None timestamp stays None"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/13',
        'message': 'x',
        'user': {'profile_url': 'https://www.facebook.com/user13'},
        'timestamp': None,
    })
    assert stub['posted_at'] is None


def test_post_to_stub_handles_epoch_zero():
    """Epoch 0 converts to 1970-01-01T00:00:00+00:00, not dropped"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/14',
        'message': 'x',
        'user': {'profile_url': 'https://www.facebook.com/user14'},
        'timestamp': 0,
    })
    assert stub['posted_at'] == '1970-01-01T00:00:00+00:00'


def test_post_to_stub_handles_overflow_timestamp():
    """Absurdly large epoch raises OverflowError, returns None instead of crashing"""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/p/15',
        'message': 'x',
        'user': {'profile_url': 'https://www.facebook.com/user15'},
        'timestamp': 99999999999999999999,
    })
    assert stub['posted_at'] is None


# ==========================================================================
# memo23/facebook-public-group-posts-scraper — output mapping
# ==========================================================================
#
# This fixture is a VERBATIM item from a real 23-post run across three UK
# groups (2026-08-04). Every field name below is the actor's own: `text` not
# `message`, `time` (already ISO-8601, NOT an epoch int), `groupTitle`,
# `facebookId`, and a `user` object carrying NO profile URL at all.

_MEMO23_ITEM = {
    'url': 'https://www.facebook.com/groups/1772363682936388/permalink/3362762127229861/',
    'text': 'Can anyone recommend a decent plumber please? Kitchen tap is dripping.',
    'time': '2026-08-03T20:52:40.000Z',
    'user': {'id': '2102601427270949', 'name': 'booboogizmo'},
    'groupTitle': 'Spotted littlehampton',
    'facebookId': 1772363682936388,
    'attachments': [],
    'commentsCount': 4,
    'likesCount': 2,
    'sharesCount': 0,
    'photoCount': 0,
    'inputUrl': 'https://www.facebook.com/groups/1772363682936388',
    'id': '3362762127229861',
    'legacyId': '3362762127229861',
    'feedbackId': 'ZmVlZGJhY2s6MzM2Mjc2MjEyNzIyOTg2MQ==',
}


def test_memo23_item_maps_every_required_field():
    stub = fa.post_to_stub(dict(_MEMO23_ITEM))
    assert stub is not None
    assert stub['platform'] == 'facebook'
    assert stub['post_url'] == \
        'https://www.facebook.com/groups/1772363682936388/permalink/3362762127229861/'
    assert stub['content_excerpt'] == \
        'Can anyone recommend a decent plumber please? Kitchen tap is dripping.'
    assert stub['posted_at'] == '2026-08-03T20:52:40.000Z'
    assert stub['author_handle'] == '2102601427270949'
    assert stub['display_name'] == 'booboogizmo'
    assert stub['author_profile_url'] == 'https://www.facebook.com/2102601427270949'
    assert stub['group_id'] == '1772363682936388'
    assert stub['group_name'] == 'Spotted littlehampton'
    assert stub['media_urls'] == []


def test_memo23_iso_time_passes_through_byte_for_byte():
    """`time` is ALREADY ISO-8601. Re-parsing it as an epoch would either crash
    or produce 1970 — the string must survive untouched."""
    stub = fa.post_to_stub({**_MEMO23_ITEM})
    assert stub['posted_at'] == _MEMO23_ITEM['time']


def test_memo23_author_profile_url_is_synthesised_from_user_id():
    """The actor returns NO author profile URL. Without synthesis post_to_stub
    drops the item and the post can never become a lead."""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/groups/1/permalink/2/',
        'text': 'need a roofer',
        'user': {'id': '61550123456789', 'name': 'Dave'},
    })
    assert stub['author_profile_url'] == 'https://www.facebook.com/61550123456789'
    assert stub['author_handle'] == '61550123456789'


def test_synthesis_handles_pfbid_style_ids():
    """The search actor's own author.url was https://www.facebook.com/pfbid0do86...
    so the same /<id> form is a real, working profile URL for pfbid ids too."""
    stub = fa.post_to_stub({
        'url': 'https://fb/p/1', 'text': 'x',
        'user': {'id': 'pfbid0do86AbCdEf', 'name': 'Sam'},
    })
    assert stub['author_profile_url'] == 'https://www.facebook.com/pfbid0do86AbCdEf'


def test_synthesis_coerces_an_integer_user_id():
    stub = fa.post_to_stub({
        'url': 'https://fb/p/1', 'text': 'x', 'user': {'id': 2102601427270949},
    })
    assert stub['author_profile_url'] == 'https://www.facebook.com/2102601427270949'


def test_a_real_profile_url_always_beats_synthesis():
    """The search actor DOES supply a URL — its value must win, never be
    replaced by a /<id> guess."""
    stub = fa.post_to_stub({
        'url': 'https://fb/p/1', 'message': 'x',
        'user': {'id': '999', 'profile_url': 'https://www.facebook.com/jane.doe.5'},
    })
    assert stub['author_profile_url'] == 'https://www.facebook.com/jane.doe.5'
    stub = fa.post_to_stub({
        'url': 'https://fb/p/1', 'message': 'x',
        'author': {'id': '999', 'url': 'https://www.facebook.com/pfbid0do86'},
    })
    assert stub['author_profile_url'] == 'https://www.facebook.com/pfbid0do86'


def test_no_url_and_no_id_is_still_dropped():
    """Synthesis must not rescue an item with no author identity at all."""
    assert fa.post_to_stub({'url': 'https://fb/p/1', 'text': 'x', 'user': {'name': 'Anon'}}) is None


def test_memo23_group_context_comes_from_facebook_id_and_group_title():
    stub = fa.post_to_stub({
        'url': 'https://fb/p/1', 'text': 'x', 'user': {'id': '5'},
        'facebookId': 435424147376112, 'groupTitle': 'Dane Bank Community Page',
    })
    assert stub['group_id'] == '435424147376112'
    assert stub['group_name'] == 'Dane Bank Community Page'


def test_explicit_group_args_still_beat_memo23_payload_fields():
    stub = fa.post_to_stub(
        {**_MEMO23_ITEM}, group_id='explicit', group_name='Explicit Name',
    )
    assert stub['group_id'] == 'explicit'
    assert stub['group_name'] == 'Explicit Name'


def test_memo23_attachments_become_media_urls():
    stub = fa.post_to_stub({
        'url': 'https://fb/p/1', 'text': 'x', 'user': {'id': '5'},
        'attachments': [{'url': 'https://scontent.example/a.jpg'},
                        'https://scontent.example/b.jpg'],
    })
    assert stub['media_urls'] == ['https://scontent.example/a.jpg',
                                  'https://scontent.example/b.jpg']


def test_search_actor_shape_is_unchanged_by_the_memo23_support():
    """Regression guard: extending the or-chains must not shift the search
    actor's own mapping."""
    stub = fa.post_to_stub({
        'url': 'https://www.facebook.com/groups/123/posts/456/',
        'message': 'Anyone know a good plumber in Manchester?',
        'timestamp': 1785741360,
        'user': {'name': 'Jane Doe', 'profile_url': 'https://www.facebook.com/jane.doe.5',
                 'id': 'jane.doe.5'},
        'associated_group': {'group_id': '123', 'name': 'Manc Trades'},
    })
    assert stub['content_excerpt'] == 'Anyone know a good plumber in Manchester?'
    assert stub['posted_at'] == '2026-08-03T07:16:00+00:00'
    assert stub['author_profile_url'] == 'https://www.facebook.com/jane.doe.5'
    assert stub['group_id'] == '123'
    assert stub['group_name'] == 'Manc Trades'


def test_timestamp_wins_over_time_when_both_present():
    """Belt-and-braces: if some future actor sends both, the epoch field the
    search actor owns is read first and still converted."""
    stub = fa.post_to_stub({
        'url': 'https://fb/p/1', 'text': 'x', 'user': {'id': '5'},
        'timestamp': 1785741360, 'time': '1999-01-01T00:00:00.000Z',
    })
    assert stub['posted_at'] == '2026-08-03T07:16:00+00:00'
