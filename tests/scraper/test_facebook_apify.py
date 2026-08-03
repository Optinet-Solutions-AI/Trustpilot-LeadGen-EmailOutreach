"""Pure-function tests for Apify->PostStub mapping. No network."""
from tools.scraper.platforms import facebook_apify as fa


def test_actor_ids_come_from_env_not_literals(monkeypatch):
    monkeypatch.delenv('APIFY_FB_SEARCH_ACTOR', raising=False)
    assert fa.search_actor() == 'scrapeforge/facebook-search-posts'
    monkeypatch.setenv('APIFY_FB_SEARCH_ACTOR', 'scraper_one/facebook-posts-search')
    assert fa.search_actor() == 'scraper_one/facebook-posts-search'
    monkeypatch.delenv('APIFY_FB_GROUP_POSTS_ACTOR', raising=False)
    assert fa.group_posts_actor() == 'data-slayer/facebook-group-posts'
    monkeypatch.setenv('APIFY_FB_GROUP_POSTS_ACTOR', 'someone/other-group-actor')
    assert fa.group_posts_actor() == 'someone/other-group-actor'


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


def test_build_group_posts_input_sets_group_id():
    got = fa.build_group_posts_input('123', max_results=50)
    assert got['groupId'] == '123'


def test_build_group_posts_input_enforces_min_page_count():
    got = fa.build_group_posts_input('456', max_results=5)
    assert got['maxPages'] >= 1


def test_build_group_posts_input_scales_pages():
    got = fa.build_group_posts_input('789', max_results=100)
    assert got['maxPages'] > fa.build_group_posts_input('789', max_results=10)['maxPages']


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
