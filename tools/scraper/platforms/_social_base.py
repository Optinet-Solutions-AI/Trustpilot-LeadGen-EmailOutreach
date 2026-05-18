"""
SocialPlatformScraper — abstract base for Facebook / Instagram / FB Groups
and any future logged-in, search-driven scraping platform.

PHASE: design + scaffold only. No platform implementation is registered
yet. The contract is committed so when Facebook lands, the shape is
locked in advance.

WHY A SEPARATE BASE CLASS?

  Review platforms (Trustpilot, TripAdvisor, Yelp) all share the same
  shape: paginate a listing, enrich each profile, dedupe by URL. The
  existing BasePlatformScraper covers them with three methods.

  Social platforms diverge:

    - Listing is keyword search, not category pagination. Operators
      type "looking for a plumber" and get back posts AND groups AND
      pages.
    - Lead identity is fluid: the lead might be a post author, a group
      admin, or a page owner. Same person on Yelp == same business.
      Same person on Facebook == "are they posting in a group I monitor?"
    - Login is mandatory. No anonymous access; every search burns
      against a per-account daily cap; bans are real.
    - Captcha checkpoints are routine, not exceptional. Recovery is a
      manual operator step (planned in-app UI).

  These three differences justify a sibling ABC that ADDS methods
  (search_posts, search_groups, enrich_authors) while keeping the
  base contract's listing/enrich/taxonomy methods optional.

CONTRACT EXTENSIONS

  All three new methods are optional on a per-platform basis. A platform
  that only does page scraping (no posts) returns [] from search_posts.
  A platform that has no group concept returns [] from search_groups.

  Returned dicts are stable across implementations. Adding a new field
  is fine; renaming or removing is breaking.

RELATED DOCS

  - docs/superpowers/specs/2026-05-18-social-platforms-design.md
    (architecture, anti-bot stack, account management, captcha flow,
     out-of-scope decisions)
  - supabase/migrations/037_social_platforms_skeleton.sql (drafted,
    NOT yet applied — applies in the Facebook implementation session)

WHEN THE FIRST PLATFORM LANDS

  1. Apply migration 037 (social_accounts + lead_platform_posts tables).
  2. Implement FacebookScraper(SocialPlatformScraper) at
     tools/scraper/platforms/facebook.py.
  3. Register in tools/scraper/platforms/__init__.py.
  4. Add manifest entry in server/src/routes/scrape.ts PLATFORM_MANIFESTS.
  5. Wire the in-app social-account onboarding UI (mirrors the Email
     Accounts page pattern but with checkpoint handling).
"""
from __future__ import annotations

from abc import abstractmethod
from typing import Optional, TypedDict

from tools.scraper.platforms.base import BasePlatformScraper, ProgressCallback


class PostStub(TypedDict, total=False):
    """One post returned by search_posts."""

    platform: str           # 'facebook' | 'instagram' | ...
    post_url: str           # canonical permalink to the post
    author_handle: str      # @username or numeric profile id
    author_profile_url: str # canonical author profile URL
    group_id: Optional[str] # group/community id when the post is inside a group
    group_name: Optional[str]
    content_excerpt: str    # truncated post body (use for "we saw your post about X" personalization)
    posted_at: Optional[str]   # ISO-8601 if available
    media_urls: list[str]   # attached images/video URLs (truncated)


class GroupStub(TypedDict, total=False):
    """One group/community returned by search_groups."""

    platform: str
    group_id: str
    group_url: str
    name: str
    member_count: Optional[int]
    is_private: bool
    description_excerpt: Optional[str]


class AuthorLead(TypedDict, total=False):
    """One enriched author returned by enrich_authors — the lead row that
    eventually lands in `leads` + `lead_platform_presences`."""

    platform: str
    profile_url: str        # author's profile URL — keys lead_platform_presences
    author_handle: str
    display_name: str
    website_url: Optional[str]      # any bio link extracted from the profile
    email: Optional[str]            # rare; only present when public on profile
    location: Optional[str]
    is_business_profile: bool       # FB Page / IG business account flag
    follower_count: Optional[int]
    bio_excerpt: Optional[str]


class SocialPlatformScraper(BasePlatformScraper):
    """
    Subclass of BasePlatformScraper that adds three social-only abstract
    methods. Concrete platforms (Facebook, Instagram, …) MUST implement
    at least one of search_posts / search_groups; enrich_authors is
    required whenever search_posts is used.

    The base class's scrape_listing / enrich_profiles still apply for
    Page/Profile scraping that doesn't go through search — set their
    bodies to `return []` if your platform only supports search.
    """

    # Override in subclasses to declare which social capabilities the
    # platform exposes. The frontend uses this to pick the right form
    # variant (post-search vs page-listing).
    supports_post_search: bool = False
    supports_group_search: bool = False

    @abstractmethod
    async def search_posts(
        self,
        query: str,
        filters: dict,
        *,
        max_results: Optional[int] = None,
        on_progress: ProgressCallback = None,
    ) -> list[PostStub]:
        """
        Search the platform for posts matching `query` (keyword, hashtag,
        phrase). `filters` carries platform-specific narrowing (date range,
        in-group-only, language, …).

        Implementations are responsible for:
          • Picking a logged-in account from social_accounts respecting
            daily/hourly caps and status='active'
          • Persisting any new cookies after the search session ends
          • Emitting FAILED:checkpoint when a CAPTCHA is hit; marking
            the account status='checkpoint' in social_accounts

        Returns a list of PostStubs. Empty list means no matches OR
        no available logged-in account.
        """
        raise NotImplementedError

    @abstractmethod
    async def search_groups(
        self,
        query: str,
        filters: dict,
        *,
        max_results: Optional[int] = None,
        on_progress: ProgressCallback = None,
    ) -> list[GroupStub]:
        """
        Discover groups/communities matching `query`. Used to populate
        the in-app "monitor this group" UI so operators can pin groups
        they want search_posts to scope to.

        Same account/checkpoint concerns as search_posts.
        """
        raise NotImplementedError

    @abstractmethod
    async def enrich_authors(
        self,
        post_stubs: list[PostStub],
        *,
        screenshots_dir: str = '',
        on_progress: ProgressCallback = None,
    ) -> list[AuthorLead]:
        """
        For each PostStub, visit the author's profile and extract lead-
        ready contact info. Dedupes by author_profile_url internally:
        if the same author appears across 12 posts, you get one author
        lead with the 12 posts linked via lead_platform_posts.

        Cost-sensitive: this drives the bulk of session usage. Cache
        author profiles aggressively (skip authors already in
        lead_platform_presences within the last N days).
        """
        raise NotImplementedError
