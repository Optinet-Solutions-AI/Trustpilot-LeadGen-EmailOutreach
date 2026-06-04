"""Regression tests for tools/scraper/platforms/facebook.py helpers.

These cover the three helpers most prone to silent regression:
  - _is_bad: the title classifier that fell through on "(2) Facebook"
    today, leaking 4 broken leads into the DB before we caught it.
  - post_url_re: the regex that decides which anchors in a FB search
    result card point at an actual post. Drift here means real
    permalinks get rejected and we fall back to synthetic '#post-<hash>'
    URLs - the operator can't click through to verify posts.

_is_bad currently lives inside _sync_enrich_authors as a closure and
the regex patterns are inline inside _extract_posts_from_search_page.
We mirror them here exactly. When facebook.py promotes them to module
scope (planned in tomorrow's M3 refactor), switch to direct imports.
"""
import re


# -- _is_bad mirror ----------------------------------------------------

def _is_bad(name):
    """Mirror of facebook.py's nested _is_bad."""
    bad_titles = {'facebook', '', 'log in to facebook', 'log into facebook', 'meta'}
    s = (name or '').strip().lower()
    if s in bad_titles:
        return True
    return re.sub(r'^\(\d+\)\s*', '', s).strip() == 'facebook'


def test_is_bad_catches_notification_badge_titles():
    """FB renders unread-notification badges in <title> as "(N) Facebook".
    The regex must strip those before the equality check, otherwise the
    enrich path saves leads with company_name="(2) Facebook"."""
    assert _is_bad('(2) Facebook') is True
    assert _is_bad('(15) Facebook') is True
    assert _is_bad('(2)  Facebook') is True          # double space
    assert _is_bad('(2) Facebook') is True       # non-breaking space
    assert _is_bad('(0) Facebook') is True


def test_is_bad_catches_plain_bad_titles():
    """Exact-match bad titles (login pages, brand-only, empty, None)."""
    assert _is_bad('Facebook') is True
    assert _is_bad('facebook') is True
    assert _is_bad('  facebook  ') is True
    assert _is_bad('') is True
    assert _is_bad(None) is True
    assert _is_bad('Meta') is True
    assert _is_bad('Log in to Facebook') is True
    assert _is_bad('Log into Facebook') is True


def test_is_bad_accepts_real_names():
    """Real profile names must NOT be classified as bad - otherwise
    we'd fall through to URL-derived names for every lead."""
    assert _is_bad('Brian Kelly') is False
    assert _is_bad('Andreas Inkfish') is False
    assert _is_bad('Pelego Powell') is False
    assert _is_bad('RCA Dental Clinic') is False
    assert _is_bad('Dr. Sarah Chen, DDS') is False


# -- post_url_re mirror ------------------------------------------------

POST_URL_PATTERNS = [
    r'/photo/?\?[^"]*fbid=',
    r'/photo\.php\?[^"]*fbid=',
    r'/posts/(?:pfbid)?[A-Za-z0-9]',
    r'/permalink\.php\?',
    r'/groups/[^/]+/posts/',
    r'/groups/[^/]+/permalink/',
    r'/groups/[^/]+/multi_permalinks/',
    r'/share/p/',
    r'/share/v/',
    r'/share/r/',
    r'/videos/\d',
    r'/story\.php\?',
    r'/people/[^/]+/posts/',
]
post_url_re = re.compile('|'.join(POST_URL_PATTERNS))


def test_post_url_regex_matches_real_permalinks():
    """Every URL shape FB renders for a real post must match."""
    assert post_url_re.search('https://www.facebook.com/share/p/1L7xTDV7oY/')
    assert post_url_re.search('https://www.facebook.com/share/v/abc123/')
    assert post_url_re.search('https://www.facebook.com/share/r/reel123/')
    assert post_url_re.search('https://www.facebook.com/handle/posts/pfbid0XYZ')
    assert post_url_re.search('https://www.facebook.com/handle/posts/12345')
    assert post_url_re.search('https://www.facebook.com/permalink.php?story_fbid=10160')
    assert post_url_re.search('https://www.facebook.com/groups/12345/posts/67890/')
    assert post_url_re.search('https://www.facebook.com/groups/abc/multi_permalinks/123/')
    assert post_url_re.search('https://www.facebook.com/people/Jane-Doe/posts/pfbidABC/')
    assert post_url_re.search('https://www.facebook.com/photo/?fbid=10160')
    assert post_url_re.search('https://www.facebook.com/story.php?story_fbid=10160')


def test_post_url_regex_rejects_non_post_urls():
    """Author profiles, group home pages, and FB nav links must NOT match -
    otherwise the scraper would use those as fake permalinks."""
    assert not post_url_re.search('https://www.facebook.com/pelego.powell')
    assert not post_url_re.search('https://www.facebook.com/profile.php?id=61552636046848')
    assert not post_url_re.search('https://www.facebook.com/groups/12345')
    assert not post_url_re.search('https://www.facebook.com/marketplace/')
    assert not post_url_re.search('https://www.facebook.com/help/123')
