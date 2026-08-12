"""Facebook <-> Apify translation: actor input building and PostStub mapping.

Pure functions only, no I/O — facebook.py is already ~3000 lines and this
logic is independently testable, so it lives here rather than growing that
file further.

ACTOR INPUT KEYS
  Verified against the live input schema on 2026-07-31 (search actor) and
  2026-08-04 (group actor, build 0.0.63). If an actor is swapped via
  APIFY_FB_SEARCH_ACTOR / APIFY_FB_GROUP_POSTS_ACTOR, re-probe with
  apify.get_actor_input_schema() and update the matching builder.

TWO ACTORS, TWO WIRE SHAPES
  The keyword-search actor and the public-group actor agree on almost
  nothing — inputs ({query,search_type,max_results} vs {startUrls,search,
  maxItems}) or outputs (message/timestamp/user.profile_url vs
  text/time/user-with-no-url). There is ONE builder per actor and ONE
  post_to_stub that tolerates both output shapes; every alternative in its
  or-chains is commented with the actor it belongs to.
"""
from __future__ import annotations

import datetime
import os
import re
from typing import Iterable, Optional
from urllib.parse import urlparse

from tools.scraper.platforms._social_base import PostStub


FB_BASE = 'https://www.facebook.com'
_GROUP_ID_RE = re.compile(r'/groups/([^/?#]+)')


def _to_iso8601_timestamp(value: Optional[str | int | float]) -> Optional[str]:
    """Convert a timestamp to ISO-8601 UTC string.

    Handles:
    - int/float Unix epoch (e.g., 1785741360 -> 2026-08-03T07:16:00+00:00)
    - numeric string epoch (e.g., "1785741360")
    - existing ISO string (passes through untouched)
    - None (returns None)
    - invalid values (returns None instead of crashing)
    """
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        # If it looks like an ISO string (has T or Z or +/-HH:MM), pass through
        if 'T' in value or 'Z' in value:
            return value
        # Try to parse as numeric string
        try:
            value = float(value)
        except ValueError:
            return None
    if isinstance(value, (int, float)):
        try:
            return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat()
        except (ValueError, OSError, OverflowError, TypeError):
            return None
    return None


def _extract_media_urls(item: dict) -> list[str]:
    """Extract media URLs from multiple actor fields.

    Priority: image.uri, then video fields, then fallback to attachments.
    Handles both dict and string shapes for forward compatibility.
    """
    media = []

    # Primary: image.uri (single image)
    image = item.get('image')
    if isinstance(image, dict):
        uri = image.get('uri')
        if uri:
            media.append(uri)

    # Secondary: video/video_files/video_thumbnail (videos)
    for key in ('video_files', 'video', 'video_thumbnail'):
        field = item.get(key)
        if isinstance(field, list):
            for entry in field:
                url = entry.get('uri') if isinstance(entry, dict) else entry
                if url:
                    media.append(url)
        elif isinstance(field, dict):
            url = field.get('uri')
            if url:
                media.append(url)
        elif isinstance(field, str):
            media.append(field)

    # Fallback: attachments (old/alternative actor formats)
    for att in (item.get('attachments') or []):
        url = (att or {}).get('url') if isinstance(att, dict) else att
        if url and url not in media:
            media.append(url)

    return media


def search_actor() -> str:
    """Keyword post/group search actor. Read from env on every call so
    swapping a broken community actor needs no code change or restart."""
    return os.environ.get('APIFY_FB_SEARCH_ACTOR') or 'scrapeforge/facebook-search-posts'


def group_posts_actor() -> str:
    """Public-group post actor. Same env-on-every-call rule as above.

    Default is memo23/facebook-public-group-posts-scraper ("Facebook Public
    Group Posts & Comments [Only $1.5] NO COOKIES", build 0.0.63): verified
    working on 2026-08-04 with ~16.9k successful runs and 0 failures in 30
    days, no login/cookies, $1.50/1000 results.

    The previous default, data-slayer/facebook-group-posts, returns 0 items
    even for its OWN documented default input (verified live 2026-08-03) —
    every group poll came back silently empty.
    """
    return (
        os.environ.get('APIFY_FB_GROUP_POSTS_ACTOR')
        or 'memo23/facebook-public-group-posts-scraper'
    )


def build_search_input(
    query: str,
    *,
    max_results: int,
    search_type: str = 'posts',
    start_date: Optional[str] = None,
    recent: bool = True,
) -> dict:
    """Build the keyword-search actor's run input.

    `query` is passed through verbatim and is NOT geo-stuffed by this module.
    Callers decide: group discovery sends "<niche> <location>" (matching a
    group by place name is the point), while open-feed post search sends the
    operator's own query, because intent phrasing ("need a plumber
    recommendation") returns real consumer asks where "looking for a plumber
    in Manchester" returned only adverts.

    location_uid is deliberately unused: any location the operator wants
    travels inside the query string, and adopting Facebook's internal geo IDs
    would require seeding a location table for marginal gain.
    """
    run_input: dict = {
        'query': query,
        'search_type': search_type,
        'max_results': max_results,
        'recent_posts': recent,
    }
    if start_date:
        run_input['start_date'] = start_date
    return run_input


def normalise_group_url(value: Optional[str | int]) -> Optional[str]:
    """Turn whatever the operator typed into a canonical group URL.

    Operators paste any of these; the actor only accepts a URL:
      https://www.facebook.com/groups/1772363682936388  -> unchanged
      facebook.com/groups/123 / www.facebook.com/...     -> https:// prefixed
      1772363682936388  (bare id)                       -> wrapped
      manchestertradespeople (bare slug)                -> wrapped

    Returns None for blank input so callers can filter without special-casing.
    """
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw.startswith('http://') or raw.startswith('https://'):
        return raw
    if raw.startswith('//'):
        return f'https:{raw}'
    lowered = raw.lower()
    if lowered.startswith('facebook.com/') or lowered.startswith('www.facebook.com/') \
            or lowered.startswith('m.facebook.com/') or lowered.startswith('web.facebook.com/'):
        return f'https://{raw}'
    # Bare group id or slug.
    return f'{FB_BASE}/groups/{raw.strip("/")}'


def parse_group_urls(value: Optional[str | Iterable]) -> list[str]:
    """Normalise an operator-supplied group list, preserving order, deduped.

    Accepts a list (the `group_urls` filter's normal shape) or a single
    comma/newline-separated string, because operators paste lists.
    """
    if value is None:
        return []
    if isinstance(value, (str, int)):
        raw_items: Iterable = re.split(r'[,\n]', str(value))
    else:
        raw_items = value
    out: list[str] = []
    for item in raw_items:
        url = normalise_group_url(item)
        if url and url not in out:
            out.append(url)
    return out


def group_id_from_url(url: str) -> Optional[str]:
    """Pull the group id/slug out of a group or in-group permalink URL."""
    match = _GROUP_ID_RE.search(url or '')
    return match.group(1) if match else None


def build_group_posts_input(
    group_urls: str | Iterable,
    *,
    max_items: int,
    keyword: Optional[str] = None,
    newer_than_hours: Optional[int] = None,
) -> dict:
    """Build memo23/facebook-public-group-posts-scraper's run input.

    Schema (read verbatim off build 0.0.63):
      startUrls               array   REQUIRED
      search                  string  keyword filter
      maxItems                integer default 100 — max posts per group
      onlyPostsNewerThanHours integer
      viewOption              string  default 'CHRONOLOGICAL'
      includeComments         boolean default false
      monitoringMode          boolean default false

    `search` is included ONLY when a keyword is actually supplied: the actor
    filters on it BEFORE billing (so a keyword is a straight cost saving), but
    an empty string is a filter matching nothing — a run that returns 0 posts
    and reads as a dead group.

    `viewOption` is pinned to CHRONOLOGICAL so a fixed maxItems spends its
    budget on the NEWEST posts. Consumer intent decays fast; a six-month-old
    "need a plumber" is not a lead.

    `onlyPostsNewerThanHours` is exposed but left unset by default. It is the
    right lever for a repeat poll (cheaper, fresher), but a hard window on a
    low-traffic village group returns nothing at all, which is
    indistinguishable from a broken run — so the operator opts in.

    `includeComments` is deliberately NOT exposed: comments multiply billable
    results and the lead is the post's author, not a commenter.

    NOTE: this REPLACED the old {groupId, maxPages} builder rather than
    joining it. That builder targeted data-slayer/facebook-group-posts, which
    is verified dead; leaving both would be two builders whose only difference
    is which actor they secretly assume — exactly the silent mis-pick to
    avoid. One actor, one builder.
    """
    urls = parse_group_urls(group_urls)
    if not urls:
        raise ValueError(
            'build_group_posts_input requires at least one group URL — startUrls '
            'is REQUIRED by the actor, and an empty array would launch a '
            'billable run that cannot return anything.'
        )
    run_input: dict = {
        'startUrls': urls,
        'maxItems': max(1, int(max_items or 0)),
        'viewOption': 'CHRONOLOGICAL',
    }
    kw = (keyword or '').strip()
    if kw:
        run_input['search'] = kw
    if newer_than_hours:
        run_input['onlyPostsNewerThanHours'] = int(newer_than_hours)
    return run_input


def _handle_from_profile_url(profile_url: str) -> str:
    """Derive a stable handle from a profile URL.

    facebook.com/jane.doe.5           -> jane.doe.5
    facebook.com/profile.php?id=123   -> 123
    """
    parsed = urlparse(profile_url)
    if 'profile.php' in parsed.path:
        for part in (parsed.query or '').split('&'):
            if part.startswith('id='):
                return part[3:]
    return parsed.path.strip('/').split('/')[-1]


def post_to_stub(
    item: dict,
    *,
    group_id: Optional[str] = None,
    group_name: Optional[str] = None,
) -> Optional[PostStub]:
    """Map one Apify dataset item onto the PostStub contract.

    Handles BOTH actors' output shapes — every or-chain below names which
    alternative belongs to which actor. Where the shapes overlap the SEARCH
    actor's key is read first, so extending this for the group actor can never
    shift an existing search-actor mapping.

    Returns None for items missing a post URL or any author identity at all —
    both are required downstream (post_url identifies the lead's post,
    author_profile_url keys lead_platform_presences), so an item without them
    cannot become a lead.
    """
    # post_url: `url` on BOTH actors; `post_url` is a defensive alias.
    post_url = (item.get('url') or item.get('post_url') or '').strip()
    # author container: `user` on BOTH actors; `author` on the search actor's
    # alternative shape.
    user = item.get('user') or item.get('author') or {}
    # author id: `user.id` on BOTH actors (numeric on the group actor,
    # handle-or-numeric on the search actor).
    handle = str(user.get('id') or '').strip()
    # profile URL: SEARCH actor supplies one (`user.profile_url` /
    # `author.url`). The GROUP actor supplies NONE — synthesise it from the id.
    profile_url = (user.get('profile_url') or user.get('url') or '').strip()
    if not profile_url and handle:
        # `facebook.com/<id>` is exactly the form the search actor returns
        # natively (its author.url was https://www.facebook.com/pfbid0do86…),
        # so this is a real, working profile URL for numeric AND pfbid ids.
        # LOAD-BEARING: without it every group-actor post is dropped below and
        # can never become a lead.
        profile_url = f'{FB_BASE}/{handle}'
    if not post_url or not profile_url:
        return None

    # media: SEARCH actor uses image.uri / video* ; GROUP actor uses
    # `attachments` (handled as the fallback inside _extract_media_urls).
    media = _extract_media_urls(item)

    # posted_at: SEARCH actor sends `timestamp` (Unix epoch) or
    # `published_at`; GROUP actor sends `time`, ALREADY ISO-8601
    # ("2026-08-03T20:52:40.000Z") — _to_iso8601_timestamp passes an ISO
    # string through byte-for-byte rather than re-reading it as an epoch.
    # Explicit None checks (not truthiness) preserve epoch 0.
    posted_at = None
    for key in ('timestamp', 'published_at', 'time'):
        raw_time = item.get(key)
        if raw_time is not None:
            posted_at = _to_iso8601_timestamp(raw_time)
            break

    stub: PostStub = {
        'platform': 'facebook',
        'post_url': post_url,
        'author_profile_url': profile_url,
        'author_handle': handle or _handle_from_profile_url(profile_url),
        # body: `message` on the SEARCH actor, `text` on the GROUP actor.
        'content_excerpt': (item.get('message') or item.get('text') or '').strip(),
        'posted_at': posted_at,
        'media_urls': media,
    }
    # display_name is not part of the PostStub contract but the stub-enrich
    # path in facebook.py reads it to build AuthorLead without a browser visit.
    name = (user.get('name') or '').strip()
    if name:
        stub['display_name'] = name

    # Group context. Precedence: explicit arguments (the group-posts path
    # already knows which group it asked for) > SEARCH actor's
    # `associated_group` / `associated_group_id` > GROUP actor's flat
    # `facebookId` / `groupTitle`.
    associated_group = item.get('associated_group')
    if not group_id:
        if isinstance(associated_group, dict):
            group_id = associated_group.get('group_id')
        if not group_id:
            group_id = item.get('associated_group_id') or item.get('facebookId')
    if not group_name:
        if isinstance(associated_group, dict):
            group_name = associated_group.get('name')
        if not group_name:
            group_name = item.get('groupTitle')

    if group_id:
        # `facebookId` arrives as an int; group_id is a text column downstream.
        stub['group_id'] = str(group_id)
    if group_name:
        stub['group_name'] = group_name
    return stub
