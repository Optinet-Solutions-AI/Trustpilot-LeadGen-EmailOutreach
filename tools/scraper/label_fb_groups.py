"""label_fb_groups.py — one-time-per-group Gemini labelling for
fb_group_candidates.

Labels ONLY rows where audience IS NULL — every group gets exactly one
Gemini verdict, ever. Re-running this script once every group is labelled
is a cheap no-op (one empty SELECT); a freshly-captured group picked up by
tools/db/upsert_group_candidates.py gets a label the next time this runs.
Batches up to 40 group names per Gemini call (mirrors the cost-aware
batching convention in tools/scraper/shared/social_nlp.py).

Reads + writes fb_group_candidates ONLY (`audience` + `location` columns).
No lead data is touched. Requires migration 058 (adds the `audience`
column) to already be applied.

Usage (from repo root):
    ./.venv/Scripts/python.exe -m tools.scraper.label_fb_groups
    ./.venv/Scripts/python.exe -m tools.scraper.label_fb_groups --json
"""
from __future__ import annotations

import argparse
import json
import sys

from tools.db.supabase_client import table
from tools.scraper.shared.social_nlp import label_groups_with_gemini

_BATCH_SIZE = 40


def _location_string(label: dict) -> str | None:
    city = label.get('city')
    country_code = label.get('country_code')
    if city and country_code:
        return f"{city}, {country_code}"
    if country_code:
        return country_code
    if city:
        return city
    return None


def main() -> None:
    try:
        sys.stdout.reconfigure(errors='replace')
    except (AttributeError, ValueError):
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true', help='print a JSON summary as the final stdout line')
    args = ap.parse_args()

    res = (
        table('fb_group_candidates')
        .select('id,group_id,name')
        .eq('platform', 'facebook')
        .is_('audience', 'null')
        .execute()
    )
    rows = res.data or []
    print(f"{len(rows)} unlabelled group(s).")

    results: list[dict] = []
    labelled_count = 0

    for i in range(0, len(rows), _BATCH_SIZE):
        batch = rows[i:i + _BATCH_SIZE]
        labels = label_groups_with_gemini([{'name': r.get('name') or ''} for r in batch])
        if labels is None:
            print(
                f"  batch {i // _BATCH_SIZE + 1}: Gemini unavailable — "
                f"{len(batch)} group(s) remain unlabelled",
                file=sys.stderr,
            )
            continue
        for row, label in zip(batch, labels):
            location = _location_string(label)
            patch: dict = {'audience': label['audience']}
            if location:
                patch['location'] = location
            try:
                table('fb_group_candidates').update(patch).eq('id', row['id']).execute()
            except Exception as e:
                print(f"FAILED:label_write|{row['group_id']}|{str(e)[:150]}", file=sys.stderr)
                continue
            labelled_count += 1
            results.append({
                'group_id': row['group_id'],
                'name': row.get('name'),
                'audience': label['audience'],
                'location': location,
            })
            print(f"  {row['group_id']:<20} {label['audience']:<9} {(location or '—'):<20} {row.get('name')}")

    print(f"Labelled {labelled_count}/{len(rows)} group(s).")
    if args.json:
        print(json.dumps({'labelled': labelled_count, 'total_unlabelled': len(rows), 'results': results}))


if __name__ == '__main__':
    main()
