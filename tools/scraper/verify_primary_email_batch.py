"""One-off helper: ZeroBounce-verify leads.primary_email directly (not just website_email).

Used when leads are in Supabase with primary_email resolved from trustpilot_email,
before website-enrichment has filled in website_email. Re-uses the ZB batch caller
from verify_pending_zb.py but applies verdicts against whichever source field
produced primary_email.

Usage:
  .venv/Scripts/python.exe tools/scraper/verify_primary_email_batch.py --ids-file .tmp/tp_final_pending_verify.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from tools.db.supabase_client import table
from tools.db.upsert_leads import resolve_primary_email
from tools.scraper.verify_pending_hunter import (
    HUNTER_KEY,
    verify_one,
    SKIP_DOMAINS,
)
from concurrent.futures import ThreadPoolExecutor, as_completed


def hunter_validate_batch(emails: list[str], concurrency: int = 6) -> dict[str, dict]:
    """Hunter verification across a batch. Returns dict[email] = {status, raw}.
    Webmail domains (gmail/yahoo/etc.) are pre-mapped to 'catch-all' to save credits.
    """
    verdicts: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(verify_one, e): e for e in emails}
        done = 0
        for f in as_completed(futures):
            email, status, _ = f.result()
            done += 1
            if status is not None:
                verdicts[email] = {'status': status, 'raw': status}
            if done % 20 == 0:
                print(f'  Hunter progress: {done}/{len(emails)}')
    return verdicts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ids-file', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    if not HUNTER_KEY:
        print('FATAL: HUNTER_API_KEY missing in .env')
        sys.exit(1)

    with open(args.ids_file) as f:
        ids = json.load(f)
    print(f'Loaded {len(ids)} pending lead IDs')

    leads_by_id: dict[str, dict] = {}
    for i in range(0, len(ids), 50):
        r = (
            table('leads')
            .select(
                'id, trustpilot_email, trustpilot_email_status, '
                'website_email, website_email_status, '
                'affiliate_email, affiliate_email_status, '
                'primary_email'
            )
            .in_('id', ids[i:i+50])
            .execute()
        )
        for row in (r.data or []):
            leads_by_id[row['id']] = row
    print(f'Fetched {len(leads_by_id)} lead rows')

    email_to_leads: dict[str, list[str]] = defaultdict(list)
    for lid, lead in leads_by_id.items():
        pe = (lead.get('primary_email') or '').lower().strip()
        if pe:
            email_to_leads[pe].append(lid)
    emails = sorted(email_to_leads.keys())
    print(f'Unique primary_emails to verify: {len(emails)}')

    if args.dry_run:
        for e in emails[:30]:
            print(f'  {e} -> {len(email_to_leads[e])} lead(s)')
        return

    print(f'\nCalling Hunter ({len(emails)} unique emails)...')
    verdicts = hunter_validate_batch(emails, concurrency=6)
    print(f'Got {len(verdicts)} verdicts back')

    tally = defaultdict(int)
    for v in verdicts.values():
        tally[v['status']] += 1
    print('\nVerdict distribution:')
    for k in ('valid', 'catch-all', 'unknown', 'invalid'):
        print(f'  {k:10s}: {tally[k]}')
    print()

    now_iso = datetime.now(timezone.utc).isoformat()
    updated = 0
    rank = {'invalid': 4, 'catch-all': 3, 'unknown': 2, 'valid': 1}

    for lid, lead in leads_by_id.items():
        pe = (lead.get('primary_email') or '').lower().strip()
        if not pe or pe not in verdicts:
            continue
        new_status = verdicts[pe]['status']

        tp_email = (lead.get('trustpilot_email') or '').lower().strip()
        web_email = (lead.get('website_email') or '').lower().strip()
        aff_email = (lead.get('affiliate_email') or '').lower().strip()

        update_payload: dict = {'verified_at': now_iso}
        if pe == tp_email:
            update_payload['trustpilot_email_status'] = new_status
            lead['trustpilot_email_status'] = new_status
        if pe == web_email:
            update_payload['website_email_status'] = new_status
            lead['website_email_status'] = new_status
        if pe == aff_email:
            update_payload['affiliate_email_status'] = new_status
            lead['affiliate_email_status'] = new_status

        new_primary = resolve_primary_email(lead)
        statuses = [lead.get('trustpilot_email_status'), lead.get('website_email_status'), lead.get('affiliate_email_status')]
        known = [s for s in statuses if s]
        if new_primary:
            np_low = new_primary.lower().strip()
            if np_low == tp_email and lead.get('trustpilot_email_status'):
                final_status = lead['trustpilot_email_status']
            elif np_low == web_email and lead.get('website_email_status'):
                final_status = lead['website_email_status']
            elif np_low == aff_email and lead.get('affiliate_email_status'):
                final_status = lead['affiliate_email_status']
            else:
                final_status = max(known, key=lambda s: rank.get(s, 0)) if known else 'unknown'
        else:
            final_status = max(known, key=lambda s: rank.get(s, 0)) if known else 'unknown'

        update_payload['primary_email'] = new_primary
        update_payload['verification_status'] = final_status
        update_payload['email_verified'] = final_status == 'valid'

        try:
            table('leads').update(update_payload).eq('id', lid).execute()
            updated += 1
        except Exception as ex:
            print(f'  FAILED update {lid}: {str(ex)[:120]}')

    print(f'\nApplied verdicts to {updated} lead rows')


if __name__ == '__main__':
    main()
