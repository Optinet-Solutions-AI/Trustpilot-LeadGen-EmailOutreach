"""audit_fb_locations.py — read-only location-confidence audit for FB leads.

Re-derives location_confidence for already-scraped Facebook leads from the
group name + post excerpt stored in lead_platform_posts. No re-scraping.

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

# Lower rank = more concerning; used for sort order + strongest-wins merge.
_RANK = {'wrong_country': -1, 'unconfirmed': 0, 'same_country': 1, 'confirmed_city': 2}


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


def _best(a, b):
    return a if _RANK[a] >= _RANK[b] else b


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
        verdict = 'unconfirmed'
        for p in by_lead[l['id']]:
            verdict = _best(verdict, _audit_verdict(p.get('group_name'), p.get('content_excerpt'), loc))
        first = by_lead[l['id']][0]
        rows.append((l['id'], l.get('company_name') or '', first.get('group_name') or '',
                     verdict, (first.get('content_excerpt') or '').replace('\n', ' ')[:60]))
        summary[verdict] += 1

    print(f"{'CONFIDENCE':<16}{'COMPANY':<26}{'GROUP':<38}EXCERPT")
    for _id, name, group, verdict, excerpt in sorted(rows, key=lambda r: _RANK[r[3]]):
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
