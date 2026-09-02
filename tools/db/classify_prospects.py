"""Classify what each lead actually IS. DRY RUN BY DEFAULT.

    # look, change nothing (safe, read-only):
    .venv/Scripts/python.exe tools/db/classify_prospects.py

    # actually write:
    .venv/Scripts/python.exe tools/db/classify_prospects.py --apply

    # one country at a time:
    .venv/Scripts/python.exe tools/db/classify_prospects.py --country SE --apply

Why this exists
---------------
A review-platform scrape returns the real operator alongside affiliate review
sites, parked domains, redirects to a rebranded property and dead listings.
They look identical in the Lead Matrix, so a campaign sized at "100 leads with
emails" converts like ~5 (Operations' own numbers, 2026-09-02) and nobody
could tell which 5 before sending. `leads.prospect_type` (migration 063) is
the field that makes the difference visible; this script fills it in.

What it will and won't decide
-----------------------------
It writes a type ONLY when a stored signal supports it:

  flagged   platform put a consumer alert on the listing (leads.blocked)
  redirect  the website redirects off-domain (leads.redirects_to)
  dead      link check found the listing gone (leads.link_status)
  affiliate the registered domain matches a tracked affiliate (affiliates
            table), OR the domain reads as a review/comparison property
            against AFFILIATE_DOMAIN_TOKENS below

Everything else stays `unclassified`. It never guesses a lead INTO 'operator'
— "we found no evidence this is junk" is not the same as "this is the real
casino", and marking the residue sellable would recreate exactly the false
confidence this column exists to remove. Promoting to 'operator' is a human
call from the Lead Detail page.

It also never overwrites a row whose prospect_type_source is 'manual'.

The domain-token heuristic is the only fuzzy rule here, and it is deliberately
conservative: tokens that appear in affiliate domains but essentially never in
an operator's own domain. Expect it to miss affiliates (fine — they stay
unclassified and a human sorts them) rather than mislabel operators.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from tools.db.supabase_client import table  # noqa: E402

PAGE_SIZE = 1000

# Substrings that mark a domain as an affiliate / comparison property rather
# than an operator. Kept narrow on purpose — a false 'affiliate' hides a real
# prospect, which is worse than leaving it unclassified.
AFFILIATE_DOMAIN_TOKENS = (
    'casinoguru', 'askgamblers', 'casinomeister', 'bonus', 'freespins',
    'nodeposit', 'topcasino', 'bestcasino', 'casinoreview', 'casinoranking',
    'casinolist', 'compare', 'comparison', 'affiliate', 'review',
    'guide', 'tips', 'odds', 'bettingsites', 'casinosites', 'slotsites',
)

# Tokens that look affiliate-ish but routinely appear in genuine operator
# domains — checked first so they veto the match above.
OPERATOR_DOMAIN_EXCEPTIONS = (
    'casinoroyale', 'reviewer', 'guidehouse',
)


def registered_domain(url: str | None) -> str | None:
    """Strip scheme, www and path down to the bare host."""
    if not url:
        return None
    m = re.match(r'^(?:https?://)?(?:www\.)?([^/?#]+)', url.strip().lower())
    return m.group(1) if m else None


def looks_like_affiliate_domain(domain: str | None) -> str | None:
    """Return the matching token, or None. See the module docstring for why
    this stays conservative."""
    if not domain:
        return None
    if any(exc in domain for exc in OPERATOR_DOMAIN_EXCEPTIONS):
        return None
    for token in AFFILIATE_DOMAIN_TOKENS:
        if token in domain:
            return token
    return None


def fetch_tracked_affiliate_domains() -> dict[str, str]:
    """domain -> affiliate name, from the affiliates table (migration 014)."""
    out: dict[str, str] = {}
    result = table('affiliates').select('name, website').execute()
    for row in result.data or []:
        domain = registered_domain(row.get('website'))
        if domain:
            out[domain] = row.get('name') or domain
    return out


def fetch_leads(country: str | None) -> list[dict]:
    """Every lead plus the columns the rules read. Paginates past PostgREST's
    1000-row cap — the book is 6k+ rows and a silent truncation here would
    look like "the classifier skipped half my leads"."""
    rows: list[dict] = []
    offset = 0
    cols = (
        'id, company_name, website_url, country, blocked, blocked_reason, '
        'redirects_to, link_status, prospect_type, prospect_type_source'
    )
    while True:
        query = table('leads').select(cols)
        if country:
            query = query.ilike('country', f'%{country}%')
        result = query.range(offset, offset + PAGE_SIZE - 1).execute()
        page = result.data or []
        if not page:
            break
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return rows


def classify(lead: dict, tracked: dict[str, str]) -> tuple[str, str] | None:
    """(prospect_type, reason), or None to leave the lead alone.

    Order is disqualification order: a flagged listing is unsellable whatever
    its website does, and a redirect makes the link status moot."""
    if lead.get('blocked'):
        reason = lead.get('blocked_reason') or 'platform consumer alert'
        return 'flagged', f'platform consumer alert: {reason}'

    if lead.get('redirects_to'):
        return 'redirect', f"website redirects to {lead['redirects_to']}"

    if lead.get('link_status') in ('FLAGGED_DEAD', 'FLAGGED_REMOVED'):
        return 'dead', f"link check: {lead['link_status']}"

    domain = registered_domain(lead.get('website_url'))
    if domain and domain in tracked:
        return 'affiliate', f'domain matches tracked affiliate: {tracked[domain]}'

    token = looks_like_affiliate_domain(domain)
    if token:
        return 'affiliate', f'domain reads as a review/comparison site ("{token}")'

    # No signal. Leave it unclassified rather than assuming it's the operator.
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--apply', action='store_true', help='write the changes (default is a dry run)')
    parser.add_argument('--country', help='restrict to one country (substring match, e.g. SE)')
    parser.add_argument('--reclassify', action='store_true',
                        help='also re-decide rows already auto-classified (manual rows are never touched)')
    args = parser.parse_args()

    tracked = fetch_tracked_affiliate_domains()
    print(f'Tracked affiliate domains: {len(tracked)}')

    leads = fetch_leads(args.country)
    print(f'Leads read: {len(leads)}' + (f' (country ~ {args.country})' if args.country else ''))

    planned: list[tuple[str, str, str]] = []   # (id, type, reason)
    skipped_manual = 0
    already = 0
    no_signal = 0

    for lead in leads:
        if lead.get('prospect_type_source') == 'manual':
            skipped_manual += 1
            continue
        verdict = classify(lead, tracked)
        if verdict is None:
            no_signal += 1
            continue
        new_type, reason = verdict
        current = lead.get('prospect_type')
        if current == new_type and not args.reclassify:
            already += 1
            continue
        if current not in (None, 'unclassified') and not args.reclassify:
            # Already carries a different auto verdict. Needs --reclassify to
            # move, so a rerun can't quietly churn the column.
            already += 1
            continue
        planned.append((lead['id'], new_type, reason))

    counts = Counter(t for _, t, _ in planned)
    print()
    print('── Plan ────────────────────────────────────────────')
    for kind in ('flagged', 'redirect', 'dead', 'affiliate'):
        if counts.get(kind):
            print(f'  {kind:<10} {counts[kind]:>6}')
    print(f'  {"(no signal)":<10} {no_signal:>6}  -> stay unclassified')
    print(f'  {"unchanged":<10} {already:>6}')
    print(f'  {"manual":<10} {skipped_manual:>6}  -> never touched')
    print(f'  TOTAL WRITES {len(planned)}')

    if planned:
        print()
        print('Sample:')
        for lead_id, kind, reason in planned[:10]:
            print(f'  {kind:<10} {lead_id}  {reason}')

    if not args.apply:
        print()
        print('DRY RUN — nothing written. Re-run with --apply to commit.')
        return 0

    now = datetime.now(timezone.utc).isoformat()
    written = 0
    for lead_id, kind, reason in planned:
        table('leads').update({
            'prospect_type': kind,
            'prospect_type_reason': reason[:500],
            'prospect_type_source': 'auto',
            'prospect_type_set_at': now,
        }).eq('id', lead_id).execute()
        written += 1
        if written % 250 == 0:
            print(f'  … {written}/{len(planned)}')

    print()
    print(f'Wrote {written} classification(s).')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
