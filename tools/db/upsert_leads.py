"""
Upsert scraped leads into Supabase.
Usage: python tools/db/upsert_leads.py --input .tmp/enriched_leads.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

# Allow running from project root
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.db.supabase_client import table
from tools.db.url_validator import sanitize_trustpilot_url, validate_trustpilot_url

import requests

# Skip the network round-trip during unit tests / dev imports. Set
# UPSERT_VALIDATE_LINKS=0 to write rows with link_status='UNKNOWN' instead.
_VALIDATE_LINKS = os.getenv('UPSERT_VALIDATE_LINKS', '1') != '0'


def resolve_primary_email(lead: dict) -> str | None:
    """Prefer website_email over trustpilot_email (higher deliverability)."""
    return lead.get('website_email') or lead.get('trustpilot_email') or None


def normalize_screenshot_path(raw_path: str | None) -> str | None:
    """Pass through the screenshot path unchanged.
    TypeScript uploadScreenshotsToStorage in scrape-runner.ts uploads every
    /app/.tmp/ screenshot to Supabase Storage in one batch AFTER the profile
    scrape finishes and rewrites each row's screenshot_path to the public URL.
    Doing the upload here instead would re-upload every file on every partial
    save and pile up the 20s partial-upsert loop.
    """
    return raw_path or None


def upsert_leads(leads: list[dict]) -> int:
    """Upsert leads into Supabase. Returns count of upserted rows."""
    rows = []
    now = datetime.now(timezone.utc).isoformat()

    # One pooled session for all validation HTTP calls — connection reuse
    # cuts per-URL latency dramatically on a 100-lead batch.
    http = requests.Session() if _VALIDATE_LINKS else None

    for lead in leads:
        # 1. Auto-correct the URL FIRST, before anything else touches it.
        raw_url = lead.get('trustpilot_url')
        cleaned_url = sanitize_trustpilot_url(raw_url)
        if not cleaned_url:
            # Nothing salvageable — skip this row entirely. Without a URL we
            # have no dedup key and no way to revisit the lead later.
            print(f"SKIP:invalid_url:{(raw_url or '')[:80]}")
            continue

        # 2. Validate the cleaned URL against Trustpilot. Failures don't
        #    block the upsert — they just decide the link_status the row
        #    is written with so the UI can flag it.
        if _VALIDATE_LINKS:
            link_status, link_error = validate_trustpilot_url(cleaned_url, session=http)
            validated_at = now
        else:
            link_status, link_error, validated_at = 'UNKNOWN', None, None

        rows.append({
            'company_name': lead.get('company_name') or lead.get('name', 'Unknown'),
            'trustpilot_url': cleaned_url,
            'website_url': lead.get('website_url'),
            'trustpilot_email': lead.get('trustpilot_email'),
            'website_email': lead.get('website_email'),
            'primary_email': resolve_primary_email(lead),
            'phone': lead.get('phone'),
            'country': lead.get('country'),
            'category': lead.get('category'),
            'star_rating': lead.get('star_rating') or lead.get('rating'),
            'screenshot_path': normalize_screenshot_path(lead.get('screenshot_path')),
            'profile_claimed': lead.get('profile_claimed'),
            'scraped_at': now,
            'link_status': link_status,
            'last_validated_at': validated_at,
            'link_validation_error': link_error,
        })
    if not rows:
        print("No leads to upsert.")
        return 0

    # Deduplicate by trustpilot_url — merge so that enriched data (website_email) is
    # never overwritten by an unenriched duplicate of the same lead.
    seen: dict[str, dict] = {}
    for row in rows:
        key = row['trustpilot_url']
        if key not in seen:
            seen[key] = row
        else:
            existing = seen[key]
            # Prefer whichever version has website_email; otherwise keep the later one
            if row.get('website_email') and not existing.get('website_email'):
                seen[key] = row
            elif not row.get('website_email') and existing.get('website_email'):
                pass  # keep existing
            else:
                # Both have or both lack website_email — merge, preferring non-None values
                merged = {**existing, **{k: v for k, v in row.items() if v is not None}}
                seen[key] = merged
    rows = list(seen.values())

    # Strip None values — prevents overwriting existing DB data with nulls.
    # Supabase upsert will only update columns present in the payload.
    rows = [{k: v for k, v in row.items() if v is not None} for row in rows]
    print(f"Deduplicated to {len(rows)} unique leads.")

    # Group rows by their exact key signature. PostgREST bulk upsert rejects
    # arrays where objects have different key sets (error PGRST102: "All object
    # keys must match"). Stripping None above intentionally creates heterogeneous
    # rows (to avoid nulling existing DB columns), so we must batch by signature.
    from collections import defaultdict
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for row in rows:
        signature = tuple(sorted(row.keys()))
        groups[signature].append(row)

    # Build a flat list of same-shape batches
    batch_size = 25
    batches: list[list[dict]] = []
    for group_rows in groups.values():
        for i in range(0, len(group_rows), batch_size):
            batches.append(group_rows[i:i + batch_size])

    # Upsert each batch with retry
    count = 0
    failed_count = 0
    total_batches = len(batches)
    for batch_num, batch in enumerate(batches, start=1):
        for attempt in range(3):
            try:
                result = (
                    table('leads')
                    .upsert(batch, on_conflict='trustpilot_url')
                    .execute()
                )
                batch_count = len(result.data) if result.data else 0
                count += batch_count
                print(f"  Batch {batch_num}: upserted {batch_count} leads")
                break
            except Exception as e:
                if attempt < 2:
                    import time
                    print(f"  Batch {batch_num}: retry {attempt + 1} after error: {e}")
                    time.sleep(2)
                else:
                    error_msg = str(e).replace('\n', ' ')[:200]
                    print(f"FAILED:upsert:batch_{batch_num}:{error_msg}")
                    failed_count += len(batch)

        print(f"PROGRESS:upsert_progress:{batch_num}/{total_batches}")

    print(f"Upserted {count} leads into Supabase. Failed: {failed_count}")
    print(f"PROGRESS:upsert_done:{count}/{count + failed_count}")
    return count


def main():
    parser = argparse.ArgumentParser(description='Upsert leads into Supabase')
    parser.add_argument('--input', required=True, help='Path to enriched leads JSON file')
    args = parser.parse_args()

    with open(args.input, 'r', encoding='utf-8') as f:
        leads = json.load(f)

    upsert_leads(leads)


if __name__ == '__main__':
    main()
