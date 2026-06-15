"""
Direct ZeroBounce verification for the leads written by
reenrich_trustpilot_websites.py — bypasses the local Express API so we
don't need server/ running.

Uses the ZeroBounce v2 bulk endpoint (100 emails / call) and writes back:
  - leads.website_email_status   (valid / invalid / catch-all / unknown)
  - leads.verification_status    (mirrors the new website status if it's the
                                  source of primary_email; otherwise worst-of)
  - leads.email_verified         (true only when ZB returned 'valid')
  - leads.verified_at            (now)
  - leads.primary_email          (recomputed via resolve_primary_email)

Does NOT call MillionVerifier / Hunter. Falling those in is the TypeScript
validator's job — when the local API is up, use POST /api/verify instead of
this script. ZeroBounce 'unknown' verdicts therefore stay 'unknown' here.

Usage:
  .venv/Scripts/python.exe tools/scraper/verify_pending_zb.py
  .venv/Scripts/python.exe tools/scraper/verify_pending_zb.py --ids-file .tmp/reenrich_pending_verify_clean.json
  .venv/Scripts/python.exe tools/scraper/verify_pending_zb.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from collections import defaultdict

import requests
from dotenv import load_dotenv

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

load_dotenv()

from tools.db.supabase_client import table
from tools.db.upsert_leads import resolve_primary_email


ZB_KEY = os.getenv('ZEROBOUNCE_API_KEY', '')
ZB_BULK_URL = 'https://bulkapi.zerobounce.net/v2/validatebatch'
ZB_BATCH_SIZE = 100  # ZB hard cap

# Map ZeroBounce verdicts -> our normalized status column values.
# spamtrap / abuse / do_not_mail collapse to 'invalid' because they're all
# "do not send" verdicts from a deliverability standpoint.
ZB_TO_STATUS = {
    'valid': 'valid',
    'invalid': 'invalid',
    'catch-all': 'catch-all',
    'unknown': 'unknown',
    'spamtrap': 'invalid',
    'abuse': 'invalid',
    'do_not_mail': 'invalid',
}


def fetch_lead_emails(ids: list[str]) -> dict:
    """Fetch all source emails + statuses for the given lead IDs.
    Returns a dict keyed by lead id with the full email picture each lead
    has, so resolve_primary_email can re-rank after we update website status.
    """
    leads_by_id: dict[str, dict] = {}
    for i in range(0, len(ids), 50):
        batch = ids[i:i+50]
        res = (
            table('leads')
            .select(
                'id, trustpilot_email, trustpilot_email_status, '
                'website_email, website_email_status, '
                'affiliate_email, affiliate_email_status, '
                'primary_email'
            )
            .in_('id', batch)
            .execute()
        )
        for row in (res.data or []):
            leads_by_id[row['id']] = row
    return leads_by_id


def zb_validate_batch(emails: list[str]) -> dict[str, dict]:
    """Call ZeroBounce bulk endpoint. Returns dict[email] = {status, sub_status}.
    Splits into ZB_BATCH_SIZE chunks transparently.
    """
    verdicts: dict[str, dict] = {}
    for i in range(0, len(emails), ZB_BATCH_SIZE):
        chunk = emails[i:i+ZB_BATCH_SIZE]
        payload = {
            'api_key': ZB_KEY,
            'email_batch': [{'email_address': e, 'ip_address': ''} for e in chunk],
        }
        print(f'  ZB batch {i//ZB_BATCH_SIZE + 1}: {len(chunk)} emails...')
        for attempt in range(3):
            try:
                r = requests.post(ZB_BULK_URL, json=payload, timeout=120)
                if r.status_code != 200:
                    print(f'    HTTP {r.status_code}: {r.text[:300]}')
                    if attempt < 2:
                        time.sleep(3)
                        continue
                    break
                data = r.json()
                for entry in data.get('email_batch', []):
                    addr = (entry.get('address') or '').lower().strip()
                    if not addr:
                        continue
                    raw = (entry.get('status') or 'unknown').lower()
                    verdicts[addr] = {
                        'status': ZB_TO_STATUS.get(raw, 'unknown'),
                        'sub_status': entry.get('sub_status', ''),
                        'raw': raw,
                    }
                # Error reports
                for err in data.get('errors', []):
                    print(f'    ZB error: {err}')
                break
            except Exception as e:
                print(f'    request failed (attempt {attempt+1}): {e}')
                if attempt < 2:
                    time.sleep(3)
    return verdicts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ids-file', default='.tmp/reenrich_pending_verify_clean.json')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    if not ZB_KEY:
        print('FATAL: ZEROBOUNCE_API_KEY missing in .env')
        sys.exit(1)

    with open(args.ids_file) as f:
        ids = json.load(f)
    print(f'Loaded {len(ids)} pending lead IDs from {args.ids_file}')

    leads_by_id = fetch_lead_emails(ids)
    print(f'Fetched {len(leads_by_id)} lead rows from Supabase')

    # Build dedup'd email list + reverse map email -> [lead_ids]
    email_to_leads: dict[str, list[str]] = defaultdict(list)
    for lid, lead in leads_by_id.items():
        we = (lead.get('website_email') or '').lower().strip()
        if we:
            email_to_leads[we].append(lid)
    emails = sorted(email_to_leads.keys())
    print(f'Unique website emails to verify: {len(emails)}')

    if args.dry_run:
        print('--dry-run set, not calling ZeroBounce.')
        for e in emails[:30]:
            print(f'  {e} -> {len(email_to_leads[e])} lead(s)')
        return

    # Call ZB
    print(f'\nCalling ZeroBounce ({len(emails)} unique emails)...')
    verdicts = zb_validate_batch(emails)
    print(f'Got {len(verdicts)} verdicts back')

    # Stats
    tally = defaultdict(int)
    for v in verdicts.values():
        tally[v['status']] += 1
    print('\nVerdict distribution:')
    for k in ('valid', 'catch-all', 'unknown', 'invalid'):
        print(f'  {k:10s}: {tally[k]}')
    print()

    # Apply per lead
    now_iso = datetime.now(timezone.utc).isoformat()
    updated = 0
    failed = 0
    for email, verdict in verdicts.items():
        status = verdict['status']
        for lead_id in email_to_leads[email]:
            lead = leads_by_id[lead_id]
            # Build the resolver input with the new status
            resolver_input = {
                'trustpilot_email': lead.get('trustpilot_email'),
                'trustpilot_email_status': lead.get('trustpilot_email_status'),
                'website_email': lead.get('website_email'),
                'website_email_status': status,
                'affiliate_email': lead.get('affiliate_email'),
                'affiliate_email_status': lead.get('affiliate_email_status'),
            }
            new_primary = resolve_primary_email(resolver_input)

            # verification_status: if the primary is the website email and
            # we just verdicted it, mirror that. Else use worst-of across
            # known statuses so the send-gate stays conservative.
            if new_primary and new_primary.lower() == (lead.get('website_email') or '').lower():
                final_status = status
            else:
                # Worst-of across all known per-source statuses
                rank = {'invalid': 4, 'catch-all': 3, 'unknown': 2, 'valid': 1}
                statuses = [
                    lead.get('trustpilot_email_status'),
                    status,
                    lead.get('affiliate_email_status'),
                ]
                known = [s for s in statuses if s]
                if known:
                    final_status = max(known, key=lambda s: rank.get(s, 0))
                else:
                    final_status = 'unknown'

            patch = {
                'website_email_status': status,
                'verification_status': final_status,
                'email_verified': final_status == 'valid',
                'verified_at': now_iso,
                'primary_email': new_primary,
            }
            try:
                table('leads').update(patch).eq('id', lead_id).execute()
                updated += 1
            except Exception as ex:
                failed += 1
                print(f'  FAILED update {lead_id}: {str(ex)[:120]}')

    print(f'\nDone. Updated {updated} lead rows. Failed: {failed}')
    print(f'Valid emails: {tally["valid"]} / {len(verdicts)}')


if __name__ == '__main__':
    main()
