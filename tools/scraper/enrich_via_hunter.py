"""Back-fill emails for CRM leads that have a website_url but no usable email,
using Hunter domain-search (api.hunter.io/v2/domain-search).

This is the BATCH complement to the inline Tier-9 enricher
(server/src/services/scrapers/tier9-hunter.ts): that one fires only during a
fresh scrape, so leads already sitting in the CRM (e.g. Instagram business
leads whose bio sites use contact forms instead of mailto links) never get a
Hunter pass. This script gives them one.

Selection mirrors tier9-hunter's pickBestHunterEmail: generic (info@/contact@)
before personal — cold outreach to a role address is GDPR-cleaner — then
highest confidence. Skip-domains + per-run domain cache mirror tier9's cost
discipline (Hunter free tier is 50 domain-searches/mo).

Usage:
  .venv/Scripts/python.exe tools/scraper/enrich_via_hunter.py --platform instagram --limit 100
  .venv/Scripts/python.exe tools/scraper/enrich_via_hunter.py --limit 50            # all platforms
  .venv/Scripts/python.exe tools/scraper/enrich_via_hunter.py --platform instagram --dry-run
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from urllib.parse import urlparse

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))


def _load_env() -> None:
    p = os.path.join(os.path.dirname(__file__), '..', '..', '.env')
    if not os.path.isfile(p):
        return
    for raw in open(p, encoding='utf-8', errors='replace'):
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, _, v = line.partition('=')
        k = k.strip(); v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


_load_env()
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from tools.db.supabase_client import table
from tools.db.upsert_leads import resolve_primary_email

HUNTER_URL = 'https://api.hunter.io/v2/domain-search'
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$')

# Mirrors SKIP_DOMAINS in tier9-hunter.ts — Hunter has no useful intel on
# free webmail, so never burn a credit on these.
SKIP_DOMAINS = {
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr',
    'yahoo.de', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'outlook.fr',
    'outlook.de', 'live.com', 'icloud.com', 'me.com', 'aol.com', 'mail.com',
    'gmx.com', 'gmx.de', 'web.de', 'protonmail.com', 'proton.me',
    'yandex.com', 'mail.ru',
}


def is_plausible_email(e) -> bool:
    return bool(e) and bool(EMAIL_RE.match(e)) and len(e.split('@')[0]) >= 2


def domain_of(url: str):
    try:
        u = urlparse(url if url.startswith('http') else f'https://{url}')
        return u.hostname.replace('www.', '').lower() if u.hostname else None
    except Exception:
        return None


def pick_best_email(emails: list[dict]):
    """generic > personal, then highest confidence (mirrors tier9-hunter.ts)."""
    valid = [e for e in emails if e.get('value') and '@' in e['value']]
    if not valid:
        return None
    valid.sort(key=lambda e: (0 if e.get('type') == 'generic' else 1, -(e.get('confidence') or 0)))
    return valid[0]['value'].lower()


def hunter_domain_search(domain: str, key: str, cache: dict):
    if domain in cache:
        return cache[domain]
    if domain in SKIP_DOMAINS:
        cache[domain] = None
        return None
    import requests
    try:
        r = requests.get(HUNTER_URL, params={'domain': domain, 'api_key': key, 'limit': 10}, timeout=20)
        if r.status_code == 401:
            raise SystemExit('Hunter 401 — HUNTER_API_KEY invalid')
        if r.status_code == 429:
            print('  WARN: Hunter 429 — monthly quota exhausted; stopping', file=sys.stderr)
            cache[domain] = None
            return '__QUOTA__'
        if r.status_code != 200:
            print(f'  WARN: Hunter {r.status_code} for {domain}', file=sys.stderr)
            cache[domain] = None
            return None
        best = pick_best_email(r.json().get('data', {}).get('emails', []))
        cache[domain] = best
        return best
    except SystemExit:
        raise
    except Exception as exc:
        print(f'  WARN: Hunter error for {domain}: {str(exc)[:80]}', file=sys.stderr)
        cache[domain] = None
        return None


def _candidate_leads(platform: str | None, limit: int) -> list[dict]:
    cols = ('id,company_name,website_url,website_email,website_email_status,'
            'trustpilot_email,trustpilot_email_status,affiliate_email,'
            'affiliate_email_status,primary_email')
    if platform:
        pres = table('lead_platform_presences').select('lead_id').eq('platform', platform).execute().data or []
        ids = list({p['lead_id'] for p in pres if p.get('lead_id')})
        if not ids:
            return []
        rows = table('leads').select(cols).in_('id', ids).not_.is_('website_url', 'null').execute().data or []
    else:
        rows = table('leads').select(cols).not_.is_('website_url', 'null').execute().data or []
    # Only leads lacking a usable primary email.
    return [r for r in rows if not is_plausible_email(r.get('primary_email'))][:limit]


def main() -> None:
    ap = argparse.ArgumentParser(description='Back-fill lead emails via Hunter domain-search.')
    ap.add_argument('--platform', help='Restrict to leads present on this platform (e.g. instagram). Omit for all.')
    ap.add_argument('--limit', type=int, default=100, help='Max leads to process.')
    ap.add_argument('--dry-run', action='store_true', help='Search but do not write to the DB.')
    args = ap.parse_args()

    key = os.environ.get('HUNTER_API_KEY')
    if not key:
        raise SystemExit('HUNTER_API_KEY unset — cannot run domain-search.')

    cand = _candidate_leads(args.platform, args.limit)
    print(f'candidates (website_url present, no usable email): {len(cand)}')

    cache: dict = {}
    found = updated = 0
    for r in cand:
        dom = domain_of(r['website_url'] or '')
        if not dom:
            continue
        email = hunter_domain_search(dom, key, cache)
        if email == '__QUOTA__':
            break
        if not email or not is_plausible_email(email):
            print(f'  {r.get("company_name")}: {dom} -> none')
            continue
        found += 1
        lead = {**r, 'website_email': email, 'website_email_status': None}
        primary = resolve_primary_email(lead)
        if args.dry_run:
            print(f'  [dry] {r.get("company_name")}: {dom} -> {email} (primary={primary})')
            continue
        try:
            table('leads').update({
                'website_email': email,
                'primary_email': primary,
                'website_email_status': None,  # clear stale verdict so verifier re-checks
            }).eq('id', r['id']).execute()
            updated += 1
            print(f'  {r.get("company_name")}: {dom} -> {email} (primary={primary})')
        except Exception as exc:
            print(f'  FAILED update {r["id"]}: {str(exc)[:120]}', file=sys.stderr)

    print(f'DONE: domains searched={len(cache)}, emails found={found}, leads updated={updated}')


if __name__ == '__main__':
    main()
