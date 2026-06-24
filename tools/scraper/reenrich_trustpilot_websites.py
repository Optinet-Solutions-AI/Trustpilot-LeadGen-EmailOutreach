"""
One-off re-enrichment script for Trustpilot leads whose original
trustpilot_email is gone/invalid and that still need a usable contact.

Pipeline:
  1. Pull N most-recently-scraped TP leads from Supabase that have
     website_url but no website_email yet.
  2. Run them through tools/scraper/scrape_website.py's enrich_websites().
  3. Write website_email + recomputed primary_email back to `leads`.
  4. POST /api/verify on the lead IDs that just got a new website_email
     (ZeroBounce -> MillionVerifier -> Hunter ladder, driven by the API).

Local-only. No ScrapingBee, no EC2 worker. Playwright stealth runs in this
process.

Usage:
  .venv/Scripts/python.exe tools/scraper/reenrich_trustpilot_websites.py --limit 1000
  .venv/Scripts/python.exe tools/scraper/reenrich_trustpilot_websites.py --limit 100 --skip-verify
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

import requests

# Allow running from project root
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

# Force UTF-8 stdout/stderr so non-ASCII characters in lead names/URLs don't
# crash the script on Windows consoles.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from tools.db.supabase_client import table
from tools.db.upsert_leads import resolve_primary_email
from tools.scraper.scrape_website import enrich_websites


API_BASE = os.getenv('LOCAL_API_BASE', 'http://localhost:3001')


# Common English words the shared regex in scrape_website.py mis-identifies
# as TLDs when scanning body text or HTML source. Real ccTLDs like .us, .me,
# .in, .at, .no, .by, .so, .am, .do, .io, .to, .as are deliberately NOT in
# this list — they're legitimate even though they read like English words.
FAKE_TLDS = {
    'we', 'you', 'the', 'this', 'that', 'our', 'their', 'them',
    'what', 'how', 'why', 'when', 'where', 'who', 'which',
    'one', 'some', 'any', 'all', 'every', 'yes',
    'and', 'or', 'but', 'first', 'last',
    'are', 'were', 'with', 'from',
}

# Placeholder addresses commonly written into website copy as examples.
PLACEHOLDER_EMAILS = {
    'your@email.com', 'example@example.com', 'name@email.com',
    'email@example.com', 'user@example.com', 'test@test.com',
    'someone@example.com', 'mail@example.com', 'name@domain.com',
    'someone@domain.com', 'your@domain.com', 'user@domain.com',
    'me@domain.com', 'info@domain.com', 'contact@domain.com',
    'hello@domain.com', 'admin@domain.com', 'mail@domain.com',
    'jouw@email.nl', 'jouw@e-mail.nl',
}


def is_plausible_email(email: str) -> bool:
    """Reject regex false-positives from body-text scans.

    scrape_website.py's EMAIL_RE is broad enough to grab fragments of prose
    like 'this pl@form. You...' -> 'pl@form.you'. Those false positives
    poison the website_email column and burn ZeroBounce credits during
    verification. This filter catches the common shapes without modifying
    the shared scraper (which other callers depend on).
    """
    if not email or '@' not in email:
        return False
    local, _, domain = email.partition('@')
    local_l = local.lower()
    # Real corporate emails almost never have 1-2 char local parts.
    # `pl@`, `m@`, `d@`, `th@` are all prose fragments, not real mailboxes.
    if len(local) < 3:
        return False
    # 'www.goldcityrealest@e.com' style HTML-source garbage
    if local_l.startswith(('www.', 'http', 'https')):
        return False
    if not domain or '.' not in domain:
        return False
    tld = domain.rsplit('.', 1)[-1].lower()
    if tld in FAKE_TLDS:
        return False
    if email.lower() in PLACEHOLDER_EMAILS:
        return False
    return True


def fetch_candidates(limit: int) -> list[dict]:
    """Pull TP leads needing website enrichment, newest first."""
    print(f"Querying Supabase for {limit} TP candidates (newest first)...")
    # PostgREST page-size cap is 1000 by default; loop just in case.
    out: list[dict] = []
    page = 0
    page_size = min(limit, 1000)
    while len(out) < limit:
        offset = page * page_size
        remaining = limit - len(out)
        this_page = min(page_size, remaining)
        res = (
            table('leads')
            .select(
                'id, company_name, trustpilot_url, website_url, '
                'trustpilot_email, trustpilot_email_status, '
                'website_email, website_email_status, '
                'affiliate_email, affiliate_email_status, '
                'scraped_at'
            )
            .not_.is_('trustpilot_url', 'null')
            .not_.is_('website_url', 'null')
            .is_('website_email', 'null')
            .order('scraped_at', desc=True)
            .range(offset, offset + this_page - 1)
            .execute()
        )
        rows = res.data or []
        out.extend(rows)
        if len(rows) < this_page:
            break
        page += 1
    print(f"Fetched {len(out)} candidate leads")
    return out[:limit]


def write_back(enriched: list[dict]) -> tuple[int, list[str]]:
    """
    UPDATE each lead row with the newly-found website_email and a freshly
    computed primary_email. Returns (rows_updated, lead_ids_with_new_email).
    """
    updated = 0
    ids_with_new_email: list[str] = []

    for lead in enriched:
        new_email = lead.get('website_email')
        if not new_email:
            continue

        # Apply our local plausibility filter before any DB write — the
        # shared scraper's regex picks up prose fragments like 'pl@form.you'
        # that we never want in the leads table.
        if not is_plausible_email(new_email):
            print(f"SKIP:implausible_email|{lead['id']}|{new_email}")
            continue

        # resolve_primary_email mirrors the canonical server-side logic in
        # tools/db/upsert_leads.py so the new website_email gets promoted
        # to primary if no other valid source beats it.
        primary = resolve_primary_email(lead)

        patch = {
            'website_email': new_email,
            'primary_email': primary,
            # Clear any stale website_email_status so the verifier doesn't
            # short-circuit on an old verdict against a different email.
            'website_email_status': None,
        }
        try:
            (
                table('leads')
                .update(patch)
                .eq('id', lead['id'])
                .execute()
            )
            updated += 1
            ids_with_new_email.append(lead['id'])
        except Exception as e:
            err = str(e).replace('\n', ' ')[:200]
            print(f"FAILED:update_lead|{lead['id']}|{err}")

    return updated, ids_with_new_email


def trigger_verify(lead_ids: list[str]) -> None:
    """POST /api/verify in batches against the local server."""
    if not lead_ids:
        print("No new emails to verify.")
        return

    # Probe the API server first so we fail fast with a clear message.
    try:
        ping = requests.get(f"{API_BASE}/api/campaigns/platform-status", timeout=5)
        if ping.status_code >= 500:
            raise RuntimeError(f"server unhealthy ({ping.status_code})")
    except Exception as e:
        print()
        print("Local API server is not responding at", API_BASE)
        print(f"  Probe error: {e}")
        print("  Start it with:  cd server && npm run dev")
        print()
        print("Lead IDs that need verification (save these for a retry run):")
        out_path = os.path.join('.tmp', f'reenrich_pending_verify_{int(time.time())}.json')
        os.makedirs('.tmp', exist_ok=True)
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(lead_ids, f)
        print(f"  Saved to {out_path}")
        return

    # The verify route doesn't enforce a per-call cap (other than the wizard
    # sync route). Send a single request for the whole batch — the server
    # streams progress via SSE; for a CLI we just fire-and-forget the start.
    print(f"Triggering /api/verify on {len(lead_ids)} new website emails...")
    try:
        r = requests.post(
            f"{API_BASE}/api/verify",
            json={'leadIds': lead_ids, 'emailField': 'website'},
            timeout=30,
        )
        if r.status_code == 200:
            body = r.json()
            data = body.get('data') or {}
            job_id = data.get('jobId')
            total = data.get('total')
            print(f"Verify job started: jobId={job_id} total={total}")
            print(f"Watch progress:")
            print(f"  curl -N {API_BASE}/api/verify/{job_id}/stream")
            print(f"Or poll status:")
            print(f"  curl {API_BASE}/api/verify/status?jobId={job_id}")
        else:
            print(f"FAILED:verify_post|HTTP {r.status_code}|{r.text[:300]}")
    except Exception as e:
        print(f"FAILED:verify_post|{e}")


async def run(limit: int, parallel_tabs: int, skip_verify: bool) -> None:
    candidates = fetch_candidates(limit)
    if not candidates:
        print("No candidates found. Done.")
        return

    print(f"\nStarting Playwright enrichment ({parallel_tabs} parallel tabs)...\n")
    enriched = await enrich_websites(candidates, parallel_tabs=parallel_tabs)

    new_email_count = sum(1 for l in enriched if l.get('website_email'))
    print(f"\nEnrichment finished: {new_email_count} new website emails found "
          f"out of {len(candidates)} candidates")

    print("\nWriting results back to Supabase...")
    updated, ids = write_back(enriched)
    print(f"Updated {updated} lead rows.")

    if skip_verify:
        print("--skip-verify set; not triggering verification.")
        return

    trigger_verify(ids)


def main():
    parser = argparse.ArgumentParser(description='Re-enrich TP leads via website scrape + verify.')
    parser.add_argument('--limit', type=int, default=1000, help='Max leads to process')
    parser.add_argument('--parallel', type=int, default=3, help='Parallel Playwright tabs')
    parser.add_argument('--skip-verify', action='store_true', help='Skip the /api/verify trigger')
    args = parser.parse_args()

    asyncio.run(run(args.limit, args.parallel, args.skip_verify))


if __name__ == '__main__':
    main()
