"""
Chunked scrape + enrich + verify orchestrator with an early-stop on valid-email count.

Pipeline per chunk:
  1. Slice the next N stubs from the cached listing
  2. platform.enrich_profiles(stubs)              -- spends SB credits
  3. tools.scraper.scrape_website.enrich_websites -- free, local Playwright
  4. tools.db.upsert_leads.upsert_leads           -- writes leads + presences
  5. Hunter-verify the new website_emails         -- spends Hunter credits
  6. Tally cumulative `valid` count for the platform
  7. STOP if target reached; otherwise next chunk

Listing happens once up-front (free for Yelp via Fusion API, ~30 SB credits
per page for TripAdvisor). Profile enrichment dominates SB spend, so chunking
lets us bail before the full 800-stub budget is burned.

Usage:
  .venv/Scripts/python.exe tools/scraper/scrape_to_target.py \\
      --platform yelp --target-valid 100 --chunk-size 100 \\
      --filters '{"country":"US","category":"plumbers","max_rating":3.5,"min_review_count":10}' \\
      --max-listing 800
"""
from __future__ import annotations

import argparse
import asyncio
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

load_dotenv(override=True)

from tools.db.supabase_client import table
from tools.db.upsert_leads import upsert_leads, resolve_primary_email
from tools.scraper.platforms import get_platform
from tools.scraper.scrape_website import enrich_websites
from tools.scraper.reenrich_trustpilot_websites import is_plausible_email

HUNTER_KEY = os.getenv('HUNTER_API_KEY', '')
HUNTER_URL = 'https://api.hunter.io/v2/email-verifier'

# Mirror SKIP_DOMAINS from email-verifier.hunter.ts
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

# Load IANA TLDs for the strict cleanup pass.
_iana_path = os.path.join(os.path.dirname(__file__), '..', '..', '.tmp', 'iana_tlds.txt')
REAL_TLDS: set[str] = set()
if os.path.isfile(_iana_path):
    with open(_iana_path) as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith('#'):
                REAL_TLDS.add(line.lower())


def hunter_map(env_data: dict) -> str:
    status = (env_data.get('status') or '').lower()
    result = (env_data.get('result') or '').lower()
    if status == 'invalid' or result == 'undeliverable':
        return 'invalid'
    if status == 'accept_all' or env_data.get('accept_all') is True:
        return 'catch-all'
    if status == 'valid' and result == 'deliverable':
        return 'valid'
    return 'unknown'


def hunter_verify_one(email: str) -> str | None:
    """Returns the mapped status, or None on transient error / skip."""
    domain = email.split('@', 1)[1].lower() if '@' in email else ''
    if domain in SKIP_DOMAINS:
        return 'catch-all'
    for attempt in range(3):
        try:
            r = requests.get(HUNTER_URL, params={'email': email, 'api_key': HUNTER_KEY}, timeout=15)
            if r.status_code == 429:
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code != 200:
                if attempt < 2:
                    time.sleep(2)
                    continue
                return None
            data = (r.json() or {}).get('data') or {}
            return hunter_map(data) if data else 'unknown'
        except Exception:
            if attempt < 2:
                time.sleep(2)
            else:
                return None
    return None


def verify_with_hunter(emails: list[str], concurrency: int = 6) -> dict[str, str]:
    """Threaded Hunter verification. Returns {email: status}."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    verdicts: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(hunter_verify_one, e): e for e in emails}
        for f in as_completed(futures):
            email = futures[f]
            status = f.result()
            if status is not None:
                verdicts[email] = status
    return verdicts


def apply_verdict_updates(verdicts: dict[str, str], platform: str) -> int:
    """Push verification verdicts into the leads table. Returns rows updated."""
    if not verdicts:
        return 0

    # Look up which leads have these website_emails (via the platform).
    # We scope to the given platform so we don't accidentally overwrite verdicts
    # on a TP lead whose website_email coincidentally matches.
    presence_res = (
        table('lead_platform_presences')
        .select('lead_id')
        .eq('platform', platform)
        .execute()
    )
    platform_lead_ids = {r['lead_id'] for r in (presence_res.data or [])}

    # Fetch lead rows that match these emails AND belong to the platform
    rows_to_update: list[tuple[str, str, dict]] = []
    for i in range(0, len(verdicts), 100):
        chunk_emails = list(verdicts.keys())[i:i+100]
        r = (
            table('leads')
            .select('id, trustpilot_email, trustpilot_email_status, website_email, '
                    'website_email_status, affiliate_email, affiliate_email_status')
            .in_('website_email', chunk_emails)
            .execute()
        )
        for row in (r.data or []):
            if row['id'] not in platform_lead_ids:
                continue
            email = (row.get('website_email') or '').lower()
            if email in verdicts:
                rows_to_update.append((row['id'], verdicts[email], row))

    now_iso = datetime.now(timezone.utc).isoformat()
    rank = {'invalid': 4, 'catch-all': 3, 'unknown': 2, 'valid': 1}
    updated = 0
    for lid, status, row in rows_to_update:
        resolver_input = {
            'trustpilot_email': row.get('trustpilot_email'),
            'trustpilot_email_status': row.get('trustpilot_email_status'),
            'website_email': row.get('website_email'),
            'website_email_status': status,
            'affiliate_email': row.get('affiliate_email'),
            'affiliate_email_status': row.get('affiliate_email_status'),
        }
        new_primary = resolve_primary_email(resolver_input)
        if new_primary and new_primary.lower() == (row.get('website_email') or '').lower():
            final_status = status
        else:
            statuses = [row.get('trustpilot_email_status'), status, row.get('affiliate_email_status')]
            known = [s for s in statuses if s]
            final_status = max(known, key=lambda s: rank.get(s, 0)) if known else 'unknown'
        try:
            table('leads').update({
                'website_email_status': status,
                'verification_status': final_status,
                'email_verified': final_status == 'valid',
                'verified_at': now_iso,
                'primary_email': new_primary,
            }).eq('id', lid).execute()
            updated += 1
        except Exception as ex:
            print(f'  FAILED update {lid}: {str(ex)[:120]}')
    return updated


def cleanup_implausible_for_platform(platform: str, lead_ids: list[str]) -> int:
    """Run plausibility + IANA TLD filter on the given leads. Clears website_email
    on failures. Returns the count reverted."""
    if not lead_ids:
        return 0
    rows: list[dict] = []
    for i in range(0, len(lead_ids), 50):
        r = (table('leads')
             .select('id, trustpilot_email, trustpilot_email_status, website_email, '
                     'website_email_status, affiliate_email, affiliate_email_status')
             .in_('id', lead_ids[i:i+50]).execute())
        rows.extend(r.data or [])
    reverted = 0
    for row in rows:
        e = (row.get('website_email') or '').lower()
        if not e:
            continue
        bad = not is_plausible_email(e)
        if not bad and REAL_TLDS:
            tld = e.split('@')[1].rsplit('.', 1)[-1].lower()
            if tld not in REAL_TLDS:
                bad = True
        if not bad:
            continue
        resolver_input = dict(row)
        resolver_input['website_email'] = None
        resolver_input['website_email_status'] = None
        new_primary = resolve_primary_email(resolver_input)
        try:
            table('leads').update({
                'website_email': None,
                'website_email_status': None,
                'primary_email': new_primary,
            }).eq('id', row['id']).execute()
            reverted += 1
        except Exception as ex:
            print(f'  FAILED revert {row["id"]}: {str(ex)[:120]}')
    if reverted:
        print(f'  cleanup: reverted {reverted} implausible website_email writes')
    return reverted


def _retrying(call, attempts: int = 4, base_delay: float = 2.0):
    """Retry a Supabase call when the network momentarily flaps.
    Returns the call's result, or raises the final exception after attempts run out.
    """
    last_exc = None
    for n in range(attempts):
        try:
            return call()
        except Exception as e:
            last_exc = e
            print(f'  Supabase call retry {n + 1}/{attempts}: {str(e)[:120]}')
            time.sleep(base_delay * (n + 1))
    raise last_exc  # type: ignore[misc]


def count_platform_valid(platform: str) -> int:
    """Count leads currently flagged as having a valid email, scoped to this platform.
    Network flaps to Supabase are retried so a single timeout doesn't blow up a
    half-hour scrape that's already past the SB-spending listing phase.
    """
    res = _retrying(lambda: (
        table('lead_platform_presences')
        .select('lead_id')
        .eq('platform', platform)
        .execute()
    ))
    ids = [r['lead_id'] for r in (res.data or [])]
    valid = 0
    for i in range(0, len(ids), 100):
        batch = ids[i:i+100]
        r = _retrying(lambda b=batch: (
            table('leads')
            .select('id', count='exact')
            .in_('id', b)
            .eq('verification_status', 'valid')
            .limit(1).execute()
        ))
        valid += r.count or 0
    return valid


async def _list_tripadvisor_multi_city(plugin, filters: dict, max_listing: int) -> list[dict]:
    """TripAdvisor's scrape_listing takes one city at a time. Fan out across
    the top-ranked active US cities (or whatever country is in filters) from
    the tripadvisor_cities seed until we hit max_listing stubs.

    filters here is expected to carry:
      - country (e.g. 'US') -- mapped to tripadvisor_cities.country_code
      - listing_type (hotels/restaurants/attractions)
      - min_rating, max_rating
    """
    country = (filters.get('country') or 'US').upper()
    listing_type = filters.get('listing_type') or 'hotels'

    res = (
        table('tripadvisor_cities')
        .select('geo_id, slug, name, rank')
        .eq('country_code', country)
        .eq('active', True)
        .order('rank')
        .limit(50)
        .execute()
    )
    cities = res.data or []
    # Defensive: drop seed rows that look mis-tagged (e.g. "See more on Tripadvisor",
    # or slugs that clearly point at another country).
    cities = [c for c in cities if c.get('rank', 0) > 0 and len(c.get('slug', '')) > 3]
    print(f'  TA city fan-out: {len(cities)} active {country} cities in seed')

    accumulated: list[dict] = []
    for city in cities:
        if len(accumulated) >= max_listing:
            break
        city_filters = {
            'location_id': str(city['geo_id']),
            'location_slug': city['slug'],
            'listing_type': listing_type,
            'min_rating': filters.get('min_rating', 1.0),
            'max_rating': filters.get('max_rating', 3.5),
        }
        remaining = max_listing - len(accumulated)
        print(f'  [city {city["name"]}, slug={city["slug"]}] listing (remaining quota {remaining})...')
        try:
            city_stubs = await plugin.scrape_listing(city_filters, max_results=remaining)
        except Exception as ex:
            print(f'    SKIP city {city["name"]}: {str(ex)[:200]}')
            continue
        # Annotate so upsert has country/category
        for s in city_stubs:
            s.setdefault('country', country)
            s.setdefault('category', listing_type)
        accumulated.extend(city_stubs)
        print(f'    +{len(city_stubs)} stubs (cumulative {len(accumulated)}/{max_listing})')
    return accumulated[:max_listing]


async def main_async():
    parser = argparse.ArgumentParser()
    parser.add_argument('--platform', required=True, choices=['yelp', 'tripadvisor'])
    parser.add_argument('--filters', required=True, help='JSON object of filter values')
    parser.add_argument('--max-listing', type=int, default=800)
    parser.add_argument('--chunk-size', type=int, default=100)
    parser.add_argument('--target-valid', type=int, default=100)
    parser.add_argument('--parallel-enrich', type=int, default=3)
    parser.add_argument('--force-relist', action='store_true', help='Ignore cached listing and re-scrape it.')
    args = parser.parse_args()

    if not HUNTER_KEY:
        print('FATAL: HUNTER_API_KEY missing')
        sys.exit(1)

    platform_name = args.platform
    plugin = get_platform(platform_name)
    filters = json.loads(args.filters)

    # Cache key includes the filters so a fresh scrape of a different niche
    # doesn't silently reuse the previous run's stubs. Previously this was
    # a fixed `.tmp/{platform}_listing.json` which led to "yelp autorepair"
    # picking up cached "yelp hvac" stubs and burning SB credits on the wrong data.
    import hashlib as _hashlib
    _filter_key = _hashlib.sha1(json.dumps(filters, sort_keys=True).encode()).hexdigest()[:10]
    listing_path = f'.tmp/{platform_name}_listing_{_filter_key}.json'
    if not args.force_relist and os.path.isfile(listing_path):
        with open(listing_path, encoding='utf-8') as fh:
            cached = json.load(fh)
        if isinstance(cached, list) and cached:
            print(f'\n[{platform_name}] Step 1: REUSING cached listing ({len(cached)} stubs from {listing_path})')
            print(f'  (delete the file or pass --force-relist to re-scrape the listing)')
            stubs = cached
        else:
            stubs = None  # cache empty -> fall through
    else:
        stubs = None

    if stubs is None:
        print(f'\n[{platform_name}] Step 1: list (max {args.max_listing})...')
        if platform_name == 'tripadvisor':
            stubs = await _list_tripadvisor_multi_city(plugin, filters, args.max_listing)
        else:
            stubs = await plugin.scrape_listing(filters, max_results=args.max_listing)
        # Mirror country/category onto rows (used by upsert)
        for r in stubs:
            r.setdefault('country', filters.get('country'))
            r.setdefault('category', filters.get('category'))
        os.makedirs('.tmp', exist_ok=True)
        with open(listing_path, 'w', encoding='utf-8') as f:
            json.dump(stubs, f, indent=2, ensure_ascii=False)
        print(f'[{platform_name}] listed {len(stubs)} stubs -> {listing_path}')

    baseline_valid = count_platform_valid(platform_name)
    print(f'[{platform_name}] baseline valid emails: {baseline_valid}')

    cumulative_valid = baseline_valid
    chunk_index = 0
    pos = 0
    while pos < len(stubs):
        chunk_index += 1
        chunk = stubs[pos:pos + args.chunk_size]
        pos += args.chunk_size
        print(f'\n[{platform_name}] === CHUNK {chunk_index} ({len(chunk)} stubs, pos {pos}/{len(stubs)}) ===')

        # Step 2: enrich profiles via SB
        print(f'[{platform_name}] enriching profiles (SB)...')
        enriched = await plugin.enrich_profiles(
            chunk,
            screenshots_dir='.tmp/screenshots',
            parallel_tabs=args.parallel_enrich,
            output_path=f'.tmp/{platform_name}_chunk{chunk_index}_enriched.json',
            flush_every=25,
        )

        # Step 3: website-enrich (local Playwright)
        print(f'[{platform_name}] enriching websites (local)...')
        enriched = await enrich_websites(enriched, parallel_tabs=3)

        # Save the chunk for traceability
        with open(f'.tmp/{platform_name}_chunk{chunk_index}_enriched.json', 'w', encoding='utf-8') as f:
            json.dump(enriched, f, indent=2, ensure_ascii=False)

        # Step 4: upsert
        print(f'[{platform_name}] upserting to Supabase...')
        upsert_leads(enriched)

        # Step 4b: cleanup implausible website_email writes
        # First fetch the IDs back from DB by profile_url
        profile_urls = [e.get('profile_url') for e in enriched if e.get('profile_url')]
        ids_for_chunk: list[str] = []
        for i in range(0, len(profile_urls), 50):
            r = (table('lead_platform_presences')
                 .select('lead_id, profile_url')
                 .eq('platform', platform_name)
                 .in_('profile_url', profile_urls[i:i+50])
                 .execute())
            for row in (r.data or []):
                ids_for_chunk.append(row['lead_id'])
        cleanup_implausible_for_platform(platform_name, ids_for_chunk)

        # Step 5: Hunter verify
        # Re-fetch leads to get current website_email after cleanup
        emails_to_verify: list[str] = []
        if ids_for_chunk:
            for i in range(0, len(ids_for_chunk), 100):
                r = (table('leads')
                     .select('id, website_email, website_email_status')
                     .in_('id', ids_for_chunk[i:i+100])
                     .execute())
                for row in (r.data or []):
                    we = (row.get('website_email') or '').lower()
                    if we and not row.get('website_email_status'):
                        emails_to_verify.append(we)
        emails_to_verify = sorted(set(emails_to_verify))

        if emails_to_verify:
            print(f'[{platform_name}] verifying {len(emails_to_verify)} new emails via Hunter...')
            verdicts = verify_with_hunter(emails_to_verify)
            tally = defaultdict(int)
            for s in verdicts.values():
                tally[s] += 1
            print(f'[{platform_name}] verdicts: valid={tally["valid"]} catch-all={tally["catch-all"]} '
                  f'unknown={tally["unknown"]} invalid={tally["invalid"]}')
            applied = apply_verdict_updates(verdicts, platform_name)
            print(f'[{platform_name}] applied verdicts to {applied} lead rows')
        else:
            print(f'[{platform_name}] no new emails to verify this chunk')

        cumulative_valid = count_platform_valid(platform_name)
        new_valid_this_chunk = cumulative_valid - baseline_valid
        print(f'[{platform_name}] cumulative valid since baseline: {new_valid_this_chunk}  (total {cumulative_valid})')

        if new_valid_this_chunk >= args.target_valid:
            print(f'[{platform_name}] TARGET HIT ({args.target_valid}) — stopping.')
            break

    print(f'\n[{platform_name}] FINAL — valid since baseline: {cumulative_valid - baseline_valid}  '
          f'(total {cumulative_valid})')


def main():
    asyncio.run(main_async())


if __name__ == '__main__':
    main()
