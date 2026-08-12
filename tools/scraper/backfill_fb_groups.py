"""backfill_fb_groups.py — populate fb_group_candidates from groups already
seen in lead_platform_posts.

Facebook group scraping is the best lead source this project has — the
geography is self-evident (a post in "Find a Tradesman Bristol and
surrounding" IS Bristol) — but groups only ever arrived as a BY-PRODUCT of a
post-search scrape (`associated_group` on ~30% of Apify results lands on
lead_platform_posts.group_id/group_name). Nobody could see the resulting
list. This script surfaces it once by upserting one fb_group_candidates row
per (platform, group_id) already sitting in lead_platform_posts.

Merge-safe (tools/db/upsert_group_candidates.py) — re-running this script is
a no-op for groups that already have a row, and it never touches the 55 rows
an earlier browser crawl (migration 045) already wrote (status/niche/
location/relevance_tier are untouched by this script; only name and the
first/last-seen window are ever filled in).

Read-only against lead_platform_posts — only fb_group_candidates is written.
No lead data is read either (deliberately: this only needs group_id/
group_name/posted_at/scraped_at, all denormalized onto lead_platform_posts).

Usage (from repo root):
    ./.venv/Scripts/python.exe -m tools.scraper.backfill_fb_groups
    ./.venv/Scripts/python.exe -m tools.scraper.backfill_fb_groups --dry-run
"""
from __future__ import annotations

import argparse
import sys

from tools.db.supabase_client import table
from tools.db.upsert_group_candidates import upsert_group_candidate

# PostgREST's default page size (1000 rows) is far above today's post count
# (~230), but lead_platform_posts only grows — paginate defensively so this
# script keeps seeing every group once volume passes that cap.
_PAGE_SIZE = 1000


def _collect_groups() -> dict[str, dict]:
    """Paginated read of every Facebook post that carries a group_id, folded
    into {group_id: {name, first, last, count}}."""
    groups: dict[str, dict] = {}
    offset = 0
    while True:
        res = (
            table('lead_platform_posts')
            .select('group_id,group_name,posted_at,scraped_at')
            .eq('platform', 'facebook')
            .not_.is_('group_id', 'null')
            .range(offset, offset + _PAGE_SIZE - 1)
            .execute()
        )
        page = res.data or []
        for row in page:
            gid = row.get('group_id')
            if not gid:
                continue
            g = groups.setdefault(gid, {'name': None, 'first': None, 'last': None, 'count': 0})
            g['count'] += 1
            if row.get('group_name') and not g['name']:
                g['name'] = row['group_name']
            ts = row.get('posted_at') or row.get('scraped_at')
            if ts:
                if g['first'] is None or ts < g['first']:
                    g['first'] = ts
                if g['last'] is None or ts > g['last']:
                    g['last'] = ts
        if len(page) < _PAGE_SIZE:
            break
        offset += _PAGE_SIZE
    return groups


def main() -> None:
    # Group names carry accented / non-Latin characters (French, German,
    # Vietnamese) the Windows cp1252 console can choke on mid-table.
    try:
        sys.stdout.reconfigure(errors='replace')
    except (AttributeError, ValueError):
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='preview only, no writes')
    args = ap.parse_args()

    groups = _collect_groups()
    print(f"Found {len(groups)} distinct Facebook groups across posted leads.")

    if args.dry_run:
        for gid, g in sorted(groups.items(), key=lambda kv: -kv[1]['count']):
            print(f"  {gid:<20} {g['count']:>3} posts  {g['name']}")
        print("Dry run — nothing written.")
        return

    # Snapshot of what already existed BEFORE this run so the summary reports
    # a real "N inserted / M already present" split instead of guessing from
    # a row-count delta (which a concurrent capture could throw off).
    existing_before = (
        table('fb_group_candidates').select('group_id').eq('platform', 'facebook').execute()
    )
    known = {row['group_id'] for row in (existing_before.data or [])}

    inserted, refreshed = 0, 0
    for gid, g in groups.items():
        if gid in known:
            refreshed += 1
        else:
            inserted += 1
        # Seed first_seen_at first (establishes the row on first sight for a
        # new group), then widen last_seen_at up — upsert_group_candidate's
        # merge logic only ever moves the window outward, so the order only
        # matters for which timestamp a brand-new row is created with.
        if g['first']:
            upsert_group_candidate(platform='facebook', group_id=gid, name=g['name'], seen_at=g['first'])
        if g['last'] and g['last'] != g['first']:
            upsert_group_candidate(platform='facebook', group_id=gid, name=g['name'], seen_at=g['last'])

    print(f"Backfill complete: {inserted} new group(s) inserted, {refreshed} already present (window refreshed).")


if __name__ == '__main__':
    main()
