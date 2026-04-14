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


def resolve_primary_email(lead: dict) -> str | None:
    """Prefer website_email over trustpilot_email (higher deliverability)."""
    return lead.get('website_email') or lead.get('trustpilot_email') or None


def upsert_leads(leads: list[dict]) -> int:
    """Upsert leads into Supabase. Returns count of upserted rows."""
    rows = []
    now = datetime.now(timezone.utc).isoformat()

    for lead in leads:
        rows.append({
            'company_name': lead.get('company_name') or lead.get('name', 'Unknown'),
            'trustpilot_url': lead['trustpilot_url'],
            'website_url': lead.get('website_url'),
            'trustpilot_email': lead.get('trustpilot_email'),
            'website_email': lead.get('website_email'),
            'primary_email': resolve_primary_email(lead),
            'phone': lead.get('phone'),
            'country': lead.get('country'),
            'category': lead.get('category'),
            'star_rating': lead.get('star_rating') or lead.get('rating'),
            'screenshot_path': lead.get('screenshot_path'),
            'scraped_at': now,
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

    # Upsert in batches of 25 to avoid payload limits and timeouts
    count = 0
    failed_count = 0
    batch_size = 25
    total_batches = (len(rows) + batch_size - 1) // batch_size
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        batch_num = i // batch_size + 1
        # Retry up to 3 times per batch
        batch_ok = False
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
                batch_ok = True
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
