"""
Hunter.io verification fallback for the leads written by
reenrich_trustpilot_websites.py. Used when ZeroBounce credits are exhausted
(or the local API server is down so the multi-tier validator can't run).

Mirrors the verdict-mapping logic in server/src/services/email-verifier.hunter.ts:
  - status='invalid' OR result='undeliverable'  -> invalid
  - status='accept_all' OR accept_all=true      -> catch-all
  - status='valid' AND result='deliverable'     -> valid
  - everything else (risky/unknown/disposable)  -> unknown

Free webmail domains (gmail/yahoo/outlook/etc.) are skipped — Hunter charges
a credit per call but the answer is always 'webmail/catch-all' which adds no
information for cold-outreach gating.

Usage:
  .venv/Scripts/python.exe tools/scraper/verify_pending_hunter.py
  .venv/Scripts/python.exe tools/scraper/verify_pending_hunter.py --concurrency 5
  .venv/Scripts/python.exe tools/scraper/verify_pending_hunter.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

load_dotenv(override=True)

from tools.db.supabase_client import table
from tools.db.upsert_leads import resolve_primary_email


HUNTER_KEY = os.getenv('HUNTER_API_KEY', '')
HUNTER_URL = 'https://api.hunter.io/v2/email-verifier'

# Mirror SKIP_DOMAINS in email-verifier.hunter.ts — free-webmail domains
# where Hunter can't help us beyond 'webmail/catch-all'.
SKIP_DOMAINS = {
    'gmail.com', 'googlemail.com',
    'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.es',
    'hotmail.com', 'hotmail.co.uk', 'hotmail.fr',
    'outlook.com', 'outlook.fr', 'outlook.de',
    'live.com', 'live.co.uk',
    'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'mail.com', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de',
    'protonmail.com', 'proton.me', 'pm.me',
    'yandex.com', 'yandex.ru', 'mail.ru',
    'zoho.com', 'fastmail.com',
}


def map_status(env_data: dict) -> str:
    status = (env_data.get('status') or '').lower()
    result = (env_data.get('result') or '').lower()
    accept_all = env_data.get('accept_all') is True

    if status == 'invalid' or result == 'undeliverable':
        return 'invalid'
    if status == 'accept_all' or accept_all:
        return 'catch-all'
    if status == 'valid' and result == 'deliverable':
        return 'valid'
    return 'unknown'


def verify_one(email: str) -> tuple[str, str | None, dict | None]:
    """Returns (email, status, raw_data). status is None when skipped/errored."""
    domain = email.split('@', 1)[1].lower() if '@' in email else ''
    if domain in SKIP_DOMAINS:
        return email, 'catch-all', {'skipped': 'webmail'}

    for attempt in range(3):
        try:
            r = requests.get(
                HUNTER_URL,
                params={'email': email, 'api_key': HUNTER_KEY},
                timeout=15,
            )
            if r.status_code == 429:
                wait = 5 * (attempt + 1)
                print(f'  rate-limited on {email}, waiting {wait}s')
                time.sleep(wait)
                continue
            if r.status_code != 200:
                if attempt < 2:
                    time.sleep(2)
                    continue
                return email, None, {'http_error': r.status_code, 'body': r.text[:200]}
            body = r.json()
            data = body.get('data') or {}
            if not data:
                return email, 'unknown', body
            return email, map_status(data), data
        except Exception as e:
            if attempt < 2:
                time.sleep(2)
            else:
                return email, None, {'exception': str(e)[:200]}
    return email, None, {'error': 'retries exhausted'}


def fetch_lead_emails(ids: list[str]) -> dict:
    leads_by_id: dict[str, dict] = {}
    for i in range(0, len(ids), 50):
        res = (
            table('leads')
            .select(
                'id, trustpilot_email, trustpilot_email_status, '
                'website_email, website_email_status, '
                'affiliate_email, affiliate_email_status'
            )
            .in_('id', ids[i:i+50])
            .execute()
        )
        for row in (res.data or []):
            leads_by_id[row['id']] = row
    return leads_by_id


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ids-file', default='.tmp/reenrich_pending_verify_clean.json')
    parser.add_argument('--concurrency', type=int, default=8)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()

    if not HUNTER_KEY:
        print('FATAL: HUNTER_API_KEY missing in .env')
        sys.exit(1)

    # Check available credits up front
    try:
        r = requests.get('https://api.hunter.io/v2/account',
                         params={'api_key': HUNTER_KEY}, timeout=10)
        info = r.json().get('data', {})
        v = info.get('requests', {}).get('verifications', {})
        used = v.get('used', '?')
        avail = v.get('available', '?')
        print(f'Hunter plan: {info.get("plan_name")} — verifications used {used}/{avail}')
    except Exception as e:
        print(f'(could not fetch account balance: {e})')

    with open(args.ids_file) as f:
        ids = json.load(f)
    print(f'Loaded {len(ids)} pending lead IDs from {args.ids_file}')

    leads_by_id = fetch_lead_emails(ids)
    print(f'Fetched {len(leads_by_id)} lead rows from Supabase')

    email_to_leads: dict[str, list[str]] = defaultdict(list)
    for lid, lead in leads_by_id.items():
        we = (lead.get('website_email') or '').lower().strip()
        if we:
            email_to_leads[we].append(lid)
    emails = sorted(email_to_leads.keys())
    print(f'Unique website emails to verify: {len(emails)}')

    # Pre-count skipped (free webmail) so the user knows the real spend
    will_skip = sum(1 for e in emails if e.split('@', 1)[1].lower() in SKIP_DOMAINS)
    will_call = len(emails) - will_skip
    print(f'  free-webmail skips: {will_skip}')
    print(f'  Hunter calls planned: {will_call}')

    if args.dry_run:
        print('--dry-run set, not calling Hunter.')
        return

    print(f'\nVerifying with concurrency={args.concurrency}...')
    verdicts: dict[str, str] = {}
    done = 0
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {pool.submit(verify_one, e): e for e in emails}
        for f in as_completed(futures):
            email, status, raw = f.result()
            done += 1
            if status is None:
                print(f'  [{done}/{len(emails)}] {email} -> ERROR ({raw})')
                continue
            verdicts[email] = status
            if done % 25 == 0 or done == len(emails):
                print(f'  [{done}/{len(emails)}] processed')

    tally = defaultdict(int)
    for s in verdicts.values():
        tally[s] += 1
    print('\nVerdict distribution:')
    for k in ('valid', 'catch-all', 'unknown', 'invalid'):
        print(f'  {k:10s}: {tally[k]}')
    print()

    now_iso = datetime.now(timezone.utc).isoformat()
    rank = {'invalid': 4, 'catch-all': 3, 'unknown': 2, 'valid': 1}
    updated = 0
    failed = 0
    for email, status in verdicts.items():
        for lid in email_to_leads[email]:
            lead = leads_by_id[lid]
            resolver_input = {
                'trustpilot_email': lead.get('trustpilot_email'),
                'trustpilot_email_status': lead.get('trustpilot_email_status'),
                'website_email': lead.get('website_email'),
                'website_email_status': status,
                'affiliate_email': lead.get('affiliate_email'),
                'affiliate_email_status': lead.get('affiliate_email_status'),
            }
            new_primary = resolve_primary_email(resolver_input)

            if new_primary and new_primary.lower() == (lead.get('website_email') or '').lower():
                final_status = status
            else:
                statuses = [
                    lead.get('trustpilot_email_status'),
                    status,
                    lead.get('affiliate_email_status'),
                ]
                known = [s for s in statuses if s]
                final_status = max(known, key=lambda s: rank.get(s, 0)) if known else 'unknown'

            patch = {
                'website_email_status': status,
                'verification_status': final_status,
                'email_verified': final_status == 'valid',
                'verified_at': now_iso,
                'primary_email': new_primary,
            }
            try:
                table('leads').update(patch).eq('id', lid).execute()
                updated += 1
            except Exception as ex:
                failed += 1
                print(f'  FAILED update {lid}: {str(ex)[:120]}')

    print(f'\nDone. Updated {updated} lead rows. Failed: {failed}')


if __name__ == '__main__':
    main()
