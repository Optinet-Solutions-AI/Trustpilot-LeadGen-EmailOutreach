"""audit_fb_locations.py — read-only location-confidence audit for FB leads.

Re-derives location_confidence for already-scraped Facebook leads from the
group name + post excerpt stored in lead_platform_posts. No re-scraping.

`--location` should be a CITY (the value the operator searched), e.g. Bristol —
that's what location_confidence is judged against.

Run from repo root:
    ./.venv/Scripts/python.exe -m tools.scraper.audit_fb_locations --location Bristol
    ./.venv/Scripts/python.exe -m tools.scraper.audit_fb_locations --location Bristol --write
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict

from tools.db.supabase_client import table
from tools.scraper.platforms.facebook import (
    _derive_location_confidence,
    _extract_country_from_excerpt,
)

# When a lead has several posts, which single verdict best represents it?
# A real confirmation wins outright; a foreign-country signal (wrong_country)
# is more informative than no signal (unconfirmed), so it must beat the
# 'unconfirmed' floor — otherwise the audit would hide the very leads it exists
# to surface.
_MERGE_PRIORITY = {'unconfirmed': 0, 'wrong_country': 1, 'same_country': 2, 'confirmed_city': 3}

# Display order for the table: most concerning first.
_SORT_ORDER = {'wrong_country': 0, 'unconfirmed': 1, 'same_country': 2, 'confirmed_city': 3}


def _audit_verdict(group_name, excerpt, loc):
    """Like _derive_location_confidence, but adds an audit-only 'wrong_country'
    so historical pre-gate leads (Atlanta on a Bristol search) are visible."""
    base = _derive_location_confidence(group_name, excerpt, loc)
    if base == 'unconfirmed':
        oc = _extract_country_from_excerpt(loc or '')
        dc = _extract_country_from_excerpt(f"{group_name or ''} {excerpt or ''}")
        if dc and oc and dc != oc:
            return 'wrong_country'
    return base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--location', help='only leads whose country ILIKE this')
    ap.add_argument('--since', help='only leads scraped on/after this ISO timestamp')
    ap.add_argument('--write', action='store_true', help='back-fill leads.location_confidence')
    args = ap.parse_args()

    posts = (table('lead_platform_posts')
             .select('lead_id,group_name,content_excerpt')
             .eq('platform', 'facebook').execute())
    by_lead = defaultdict(list)
    for p in posts.data:
        if p.get('lead_id'):
            by_lead[p['lead_id']].append(p)

    q = table('leads').select('id,company_name,country,scraped_at,location_confidence')
    if args.location:
        q = q.ilike('country', args.location)
    if args.since:
        q = q.gte('scraped_at', args.since)
    leads = [l for l in q.execute().data if l['id'] in by_lead]

    rows, summary = [], Counter()
    for l in leads:
        loc = l.get('country')
        # Pick the verdict that best represents the lead, and remember the post
        # that produced it so the table shows the group/excerpt that drove it.
        best_verdict, best_post = 'unconfirmed', by_lead[l['id']][0]
        for p in by_lead[l['id']]:
            v = _audit_verdict(p.get('group_name'), p.get('content_excerpt'), loc)
            if _MERGE_PRIORITY[v] >= _MERGE_PRIORITY[best_verdict]:
                best_verdict, best_post = v, p
        rows.append((l['id'], l.get('company_name') or '', best_post.get('group_name') or '',
                     best_verdict, (best_post.get('content_excerpt') or '').replace('\n', ' ')[:60]))
        summary[best_verdict] += 1

    print(f"{'CONFIDENCE':<16}{'COMPANY':<26}{'GROUP':<38}EXCERPT")
    for _id, name, group, verdict, excerpt in sorted(rows, key=lambda r: _SORT_ORDER[r[3]]):
        print(f"{verdict:<16}{name[:25]:<26}{group[:37]:<38}{excerpt}")
    print()
    print('SUMMARY:', dict(summary), f'| {len(leads)} FB leads matched')

    if args.write:
        n = 0
        for _id, _name, _group, verdict, _excerpt in rows:
            table('leads').update({'location_confidence': verdict}).eq('id', _id).execute()
            n += 1
        print(f"WROTE location_confidence for {n} leads")


if __name__ == '__main__':
    main()
