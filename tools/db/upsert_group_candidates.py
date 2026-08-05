"""upsert_group_candidates.py — merge-safe upsert into fb_group_candidates.

Shared by two callers so groups only ever get written through one code path:

  * tools/db/upsert_leads.py — real-time capture. Every Facebook post that
    carries a group_id/group_name upserts its group here as a side effect
    of the normal lead upsert, so the Discovered Groups list keeps growing
    on its own with no extra scrape work and no second write path to keep
    in sync.
  * tools/scraper/backfill_fb_groups.py — one-off catch-up for groups that
    were already sitting in lead_platform_posts before this feature existed.

Deliberately conservative: this module NEVER overwrites `status`, `niche`,
`location`, `relevance_tier`, or `audience` — those belong to the operator's
Group Queue actions and the labelling job (tools/scraper/label_fb_groups.py).
It only fills `name` when missing and widens the observed window
(`first_seen_at` earlier, `last_seen_at` later). Safe to call once per post
or in a backfill loop; either way the row converges to the same values.
"""
from __future__ import annotations

from tools.db.supabase_client import table


def upsert_group_candidate(
    *,
    platform: str,
    group_id: str,
    name: str | None,
    seen_at: str,
) -> None:
    """Insert a new fb_group_candidates row, or widen an existing one.

    `seen_at` is an ISO-8601 timestamp string (the post's posted_at/
    scraped_at, or "now" for a fresh capture). Never raises — failures are
    printed (FAILED:... convention shared with upsert_leads.py) so a group-
    capture hiccup never blocks the lead it rode in on.
    """
    if not platform or not group_id or not seen_at:
        return

    try:
        existing = (
            table('fb_group_candidates')
            .select('id,name,first_seen_at,last_seen_at')
            .eq('platform', platform)
            .eq('group_id', group_id)
            .limit(1)
            .execute()
        )
    except Exception as e:
        print(f"FAILED:group_candidate_lookup|{group_id}|{str(e)[:150]}")
        return

    if not existing.data:
        row: dict = {
            'platform': platform,
            'group_id': group_id,
            'first_seen_at': seen_at,
            'last_seen_at': seen_at,
        }
        if name:
            row['name'] = name
        try:
            table('fb_group_candidates').insert(row).execute()
        except Exception as e:
            print(f"FAILED:group_candidate_insert|{group_id}|{str(e)[:150]}")
        return

    existing_row = existing.data[0]
    patch: dict = {}
    if name and not existing_row.get('name'):
        patch['name'] = name
    existing_first = existing_row.get('first_seen_at')
    if existing_first and seen_at < existing_first:
        patch['first_seen_at'] = seen_at
    existing_last = existing_row.get('last_seen_at')
    if existing_last and seen_at > existing_last:
        patch['last_seen_at'] = seen_at
    if not patch:
        return
    try:
        table('fb_group_candidates').update(patch).eq('id', existing_row['id']).execute()
    except Exception as e:
        print(f"FAILED:group_candidate_update|{group_id}|{str(e)[:150]}")
