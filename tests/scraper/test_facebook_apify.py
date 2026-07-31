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
