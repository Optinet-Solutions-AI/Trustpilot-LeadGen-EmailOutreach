"""Facebook <-> Apify translation: actor input building and PostStub mapping.

Pure functions only, no I/O — facebook.py is already ~3000 lines and this
logic is independently testable, so it lives here rather than growing that
file further.

ACTOR INPUT KEYS
  Verified against the live input schema on 2026-07-31. If the actor is
  swapped via APIFY_FB_SEARCH_ACTOR, re-probe with
  apify.get_actor_input_schema() and update build_search_input.
"""
from __future__ import annotations

import datetime
import os
from typing import Optional
from urllib.parse import urlparse

from tools.scraper.platforms._social_base import PostStub


# UNVERIFIED ASSUMPTION: assumes ~10 posts per group page.
# The actor's schema documents maxPages: integer with default 1, but does NOT
# document page size. The live smoke test should confirm the real rate.
ASSUMED_POSTS_PER_GROUP_PAGE = 10


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
    """Public-group post actor. Same env-on-every-call rule as above."""
    return os.environ.get('APIFY_FB_GROUP_POSTS_ACTOR') or 'data-slayer/facebook-group-posts'


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


def build_group_posts_input(group_id: str, *, max_results: int) -> dict:
    """Build the public-group actor's run input."""
    return {'groupId': group_id, 'maxPages': max(1, max_results // ASSUMED_POSTS_PER_GROUP_PAGE)}


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

    Returns None for items missing a post URL or an author profile URL — both
    are required downstream (post_url identifies the lead's post,
    author_profile_url keys lead_platform_presences), so an item without them
    cannot become a lead.
    """
    post_url = (item.get('url') or item.get('post_url') or '').strip()
    user = item.get('user') or item.get('author') or {}
    profile_url = (user.get('profile_url') or user.get('url') or '').strip()
    if not post_url or not profile_url:
        return None

    # Extract media from real actor shapes (image.uri, video fields, fallback to attachments)
    media = _extract_media_urls(item)

    # Convert epoch timestamp to ISO-8601 if needed.
    # Use explicit None check (not truthiness) to preserve epoch 0.
    posted_at = item.get('timestamp') if item.get('timestamp') is not None else item.get('published_at')
    posted_at = _to_iso8601_timestamp(posted_at) if posted_at is not None else None

    stub: PostStub = {
        'platform': 'facebook',
        'post_url': post_url,
        'author_profile_url': profile_url,
        'author_handle': str(user.get('id') or '').strip() or _handle_from_profile_url(profile_url),
        'content_excerpt': (item.get('message') or item.get('text') or '').strip(),
        'posted_at': posted_at,
        'media_urls': media,
    }
    # display_name is not part of the PostStub contract but the stub-enrich
    # path in facebook.py reads it to build AuthorLead without a browser visit.
    name = (user.get('name') or '').strip()
    if name:
        stub['display_name'] = name

    # Extract group context from associated_group when not explicitly passed.
    # Explicit arguments (from group-posts path) take precedence.
    if not group_id:
        associated_group = item.get('associated_group')
        if isinstance(associated_group, dict):
            group_id = associated_group.get('group_id')
        if not group_id:
            group_id = item.get('associated_group_id')
    if not group_name and isinstance(item.get('associated_group'), dict):
        group_name = item.get('associated_group', {}).get('name')

    if group_id:
        stub['group_id'] = group_id
    if group_name:
        stub['group_name'] = group_name
    return stub
