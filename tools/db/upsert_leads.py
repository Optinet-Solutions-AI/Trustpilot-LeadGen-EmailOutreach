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
    """Three-pass resolver mirroring server/src/services/email/resolve-primary-email.ts.

    Pass 1 — verified-first: a source explicitly status='valid' beats any
      unverified source, even from a higher-priority brand. So website=valid
      wins over trustpilot=unknown. Within the same verification tier, brand
      order is trustpilot_email > website_email > affiliate_email.
    Pass 2 — non-invalid: no source is strictly valid, so fall back to any
      non-'invalid' source by brand priority. Covers the common state where
      everything is status=null or unknown.
    Pass 3 — last resort: every non-null source is invalid. Return whatever
      exists so the row keeps a display email instead of nulling out.
    """
    tp = lead.get('trustpilot_email')
    web = lead.get('website_email')
    aff = lead.get('affiliate_email')
    tp_status = lead.get('trustpilot_email_status')
    web_status = lead.get('website_email_status')
    aff_status = lead.get('affiliate_email_status')

    # Pass 1: prefer verified
    if tp and tp_status == 'valid':
        return tp
    if web and web_status == 'valid':
        return web
    if aff and aff_status == 'valid':
        return aff

    # Pass 2: prefer non-invalid
    if tp and tp_status != 'invalid':
        return tp
    if web and web_status != 'invalid':
        return web
    if aff and aff_status != 'invalid':
        return aff

    # Pass 3: any non-null
    return tp or web or aff or None


def normalize_screenshot_path(raw_path: str | None) -> str | None:
    """Pass through the screenshot path unchanged.
    TypeScript uploadScreenshotsToStorage in scrape-runner.ts uploads every
    /app/.tmp/ screenshot to Supabase Storage in one batch AFTER the profile
    scrape finishes and rewrites each row's screenshot_path to the public URL.
    Doing the upload here instead would re-upload every file on every partial
    save and pile up the 20s partial-upsert loop.
    """
    return raw_path or None


def _build_presence_rows(
    leads: list[dict],
    url_to_lead_id: dict[str, str],
    now_iso: str,
) -> list[dict]:
    """
    Build lead_platform_presences rows from the source `leads` input
    after the parent `leads` upsert has resolved their IDs.

    Each lead can declare its platform (added by the platform plugin in
    run.py — Phase 2). Pre-Phase-2 callers won't set this, so we default
    to 'trustpilot' which is the only platform that wrote into this
    pipeline before migration 032.

    The presence row mirrors the legacy denormalized columns on `leads`
    one-to-one so the cleanup migration can drop those columns later
    without losing data.
    """
    presence_rows: list[dict] = []
    for lead in leads:
        cleaned_url = sanitize_trustpilot_url(lead.get('trustpilot_url'))
        if not cleaned_url:
            continue
        lead_id = url_to_lead_id.get(cleaned_url)
        if not lead_id:
            # Leads row failed to upsert (probably an earlier batch error).
            # Skip the presence write rather than insert an orphan.
            continue
        platform = (lead.get('platform') or 'trustpilot').lower()
        presence_rows.append({
            'lead_id': lead_id,
            'platform': platform,
            # `profile_url` is the platform-agnostic column on presences.
            # For Trustpilot it equals the cleaned trustpilot_url; future
            # platforms set it from their own profile URL.
            'profile_url': lead.get('profile_url') or cleaned_url,
            'rating': lead.get('star_rating') or lead.get('rating'),
            'screenshot_path': normalize_screenshot_path(lead.get('screenshot_path')),
            'platform_email': lead.get('platform_email') or lead.get('trustpilot_email'),
            'scraped_at': now_iso,
        })
    # Strip None values so we don't blow away existing presence columns
    # with nulls on a re-scrape (same rule as the leads upsert above).
    return [{k: v for k, v in row.items() if v is not None} for row in presence_rows]


def _upsert_presences(presence_rows: list[dict]) -> int:
    """Bulk-upsert lead_platform_presences with on_conflict=(platform, profile_url)."""
    if not presence_rows:
        return 0
    # Same key-signature grouping logic as the leads upsert — PostgREST
    # rejects bulk arrays whose objects have different key sets.
    from collections import defaultdict
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for row in presence_rows:
        groups[tuple(sorted(row.keys()))].append(row)

    batch_size = 50
    upserted = 0
    for group_rows in groups.values():
        for i in range(0, len(group_rows), batch_size):
            batch = group_rows[i:i + batch_size]
            for attempt in range(3):
                try:
                    result = (
                        table('lead_platform_presences')
                        .upsert(batch, on_conflict='platform,profile_url')
                        .execute()
                    )
                    upserted += len(result.data) if result.data else 0
                    break
                except Exception as e:
                    if attempt < 2:
                        import time
                        time.sleep(2)
                    else:
                        error_msg = str(e).replace('\n', ' ')[:200]
                        print(f"FAILED:upsert_presence:{error_msg}")
    return upserted


def _upsert_nontrustpilot_lead(lead: dict, now_iso: str) -> tuple[str | None, bool]:
    """
    Upsert one non-Trustpilot lead via the presence-first path.

    Returns (lead_id, is_new) where is_new=True when we created a new row,
    False when we updated an existing one. lead_id is None when the input
    was unusable (no platform, no profile_url) or the DB write failed.

    Flow:
      1. Look up the (platform, profile_url) tuple in lead_platform_presences.
         If found, we know which existing `leads` row to update.
      2. Build the leads row WITHOUT `trustpilot_url` (it's now nullable per
         migration 033). For TripAdvisor we carry website_url + phone +
         company_name; country/category stay null because the TA filter
         shape doesn't map onto them.
      3. INSERT or UPDATE the leads row.
      4. UPSERT the presence row with on_conflict=(platform, profile_url).

    Each non-trustpilot lead therefore costs 2-3 round-trips. Acceptable at
    typical TripAdvisor batch sizes (30-100 leads); future optimization
    is a bulk RPC.
    """
    platform = (lead.get('platform') or '').lower()
    profile_url = lead.get('profile_url') or lead.get('trustpilot_url')
    if not platform or platform == 'trustpilot' or not profile_url:
        # Trustpilot leads or shape-invalid rows shouldn't reach this path.
        return None, False

    # 1. Look up existing presence
    existing_lead_id: str | None = None
    try:
        result = (
            table('lead_platform_presences')
            .select('lead_id')
            .eq('platform', platform)
            .eq('profile_url', profile_url)
            .limit(1)
            .execute()
        )
        if result.data:
            existing_lead_id = result.data[0]['lead_id']
    except Exception as e:
        print(f"FAILED:presence_lookup|{profile_url}|{str(e)[:100]}")
        return None, False

    # 2. Build the leads row. None values are stripped so we never blow
    #    away existing data with nulls on re-scrape (same convention as
    #    the trustpilot path below).
    #
    # country + category are populated here because `leads` is the table
    # the Lead Matrix UI filters on. Without them, the 4 existing TA leads
    # (and any future non-Trustpilot scrape) would land in `leads` with
    # NULL country, and filtering by country='BR' would show nothing.
    # Bug discovered 2026-05-19.
    leads_row = {
        'company_name': lead.get('company_name') or lead.get('name', 'Unknown'),
        'country': lead.get('country'),
        'category': lead.get('category'),
        'website_url': lead.get('website_url'),
        'phone': lead.get('phone'),
        'primary_email': lead.get('primary_email') or lead.get('website_email'),
        'website_email': lead.get('website_email'),
        'scraped_at': now_iso,
    }
    leads_row = {k: v for k, v in leads_row.items() if v is not None}

    # 3. INSERT new or UPDATE existing leads row
    lead_id: str | None
    is_new = False
    try:
        if existing_lead_id:
            (
                table('leads')
                .update(leads_row)
                .eq('id', existing_lead_id)
                .execute()
            )
            lead_id = existing_lead_id
        else:
            ins = table('leads').insert(leads_row).execute()
            if not ins.data:
                print(f"FAILED:insert_lead|{profile_url}|empty response")
                return None, False
            lead_id = ins.data[0]['id']
            is_new = True
    except Exception as e:
        print(f"FAILED:upsert_lead|{profile_url}|{str(e)[:200]}")
        return None, False

    # 4. UPSERT presence row (platform, profile_url) — idempotent on re-scrape
    presence_row = {
        'lead_id': lead_id,
        'platform': platform,
        'profile_url': profile_url,
        'rating': lead.get('rating') or lead.get('star_rating'),
        'screenshot_path': normalize_screenshot_path(lead.get('screenshot_path')),
        'platform_email': lead.get('platform_email'),
        'scraped_at': now_iso,
        # Social-platform columns (M1 / migration 039) — null on review platforms
        'author_handle': lead.get('author_handle'),
        'follower_count': lead.get('follower_count'),
        'is_business_profile': lead.get('is_business_profile'),
    }
    presence_row = {k: v for k, v in presence_row.items() if v is not None}
    try:
        (
            table('lead_platform_presences')
            .upsert(presence_row, on_conflict='platform,profile_url')
            .execute()
        )
    except Exception as e:
        # Leads row already wrote — partial success. Log and move on; the
        # next scrape will repair the missing presence.
        print(f"FAILED:upsert_presence|{profile_url}|{str(e)[:200]}")

    # 5. UPSERT any attached posts into lead_platform_posts (M8).
    #
    # Social leads come with a `posts: [PostStub]` field listing the
    # specific posts the author was observed in. Each PostStub becomes
    # one lead_platform_posts row, keyed on (platform, post_url) so
    # rerunning the same search doesn't multiply rows.
    posts = lead.get('posts') or []
    if posts and isinstance(posts, list):
        for post in posts:
            post_url = post.get('post_url')
            if not post_url:
                continue
            post_row = {
                'lead_id': lead_id,
                'platform': platform,
                'post_url': post_url,
                'group_id': post.get('group_id'),
                'group_name': post.get('group_name'),
                'content_excerpt': post.get('content_excerpt'),
                'posted_at': post.get('posted_at'),
                'media_urls': post.get('media_urls'),
                'scraped_at': now_iso,
            }
            post_row = {k: v for k, v in post_row.items() if v is not None}
            try:
                (
                    table('lead_platform_posts')
                    .upsert(post_row, on_conflict='platform,post_url')
                    .execute()
                )
            except Exception as e:
                print(f"FAILED:upsert_post|{post_url}|{str(e)[:200]}")

    return lead_id, is_new


def _split_by_platform(leads: list[dict]) -> tuple[list[dict], list[dict]]:
    """Partition `leads` into (trustpilot, others) based on `platform` key."""
    tp: list[dict] = []
    others: list[dict] = []
    for lead in leads:
        platform = (lead.get('platform') or 'trustpilot').lower()
        if platform == 'trustpilot':
            tp.append(lead)
        else:
            others.append(lead)
    return tp, others


def upsert_leads(leads: list[dict]) -> int:
    """
    Upsert leads into Supabase. Returns count of upserted rows.

    Dispatches by platform:
      * Trustpilot (legacy default) — runs the original sanitize + validate
        + ON CONFLICT (trustpilot_url) pipeline below. Untouched from
        pre-multi-platform behavior.
      * Other (tripadvisor and any future plugin) — routes through
        `_upsert_nontrustpilot_lead`, which writes the lead row WITHOUT
        a trustpilot_url and upserts the lead_platform_presences row with
        on_conflict (platform, profile_url).
    """
    trustpilot_leads, other_leads = _split_by_platform(leads)
    now_iso = datetime.now(timezone.utc).isoformat()

    # ── Non-Trustpilot platforms (tripadvisor and beyond) ─────────────
    other_count = 0
    other_failed = 0
    for lead in other_leads:
        lead_id, _is_new = _upsert_nontrustpilot_lead(lead, now_iso)
        if lead_id:
            other_count += 1
        else:
            other_failed += 1
    if other_leads:
        print(f"Multi-platform upsert: {other_count}/{len(other_leads)} succeeded.")
        print(f"PROGRESS:upsert_multiplatform:{other_count}/{len(other_leads)}")

    # If there are no Trustpilot leads in this batch, skip the original
    # heavyweight pipeline entirely (avoids a no-op pass + the requests
    # Session creation).
    if not trustpilot_leads:
        print(f"PROGRESS:upsert_done:{other_count}/{other_count + other_failed}")
        return other_count

    # ── Trustpilot pipeline (original logic below, unchanged) ─────────
    leads = trustpilot_leads  # re-bind so the existing loop iterates only TP rows
    rows = []
    now = now_iso

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
            'affiliate_email': lead.get('affiliate_email'),
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

    # Upsert each batch with retry. We also collect (trustpilot_url -> id)
    # from each batch response so we can write lead_platform_presences
    # rows after all leads have landed (Phase 4 of migration 032).
    count = 0
    failed_count = 0
    total_batches = len(batches)
    url_to_lead_id: dict[str, str] = {}
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
                # Capture the upserted IDs for the presence upsert below.
                for r in (result.data or []):
                    url = r.get('trustpilot_url')
                    lead_id = r.get('id')
                    if url and lead_id:
                        url_to_lead_id[url] = lead_id
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

    # Mirror each lead into lead_platform_presences so the new normalized
    # shape stays in sync with the legacy denormalized columns on `leads`.
    # `leads` is built from the original input (carries `platform`) — we
    # only need the resolved lead_ids from the upsert above.
    presence_rows = _build_presence_rows(leads, url_to_lead_id, now)
    if presence_rows:
        presence_count = _upsert_presences(presence_rows)
        print(f"Upserted {presence_count} platform-presence rows.")
        print(f"PROGRESS:upsert_presences:{presence_count}/{len(presence_rows)}")

    # Aggregate counts across the trustpilot pipeline + the non-trustpilot
    # path that ran above. The DONE event drives the API progress bar so the
    # operator sees one combined total.
    total_saved = count + other_count
    total_failed = failed_count + other_failed
    print(f"PROGRESS:upsert_done:{total_saved}/{total_saved + total_failed}")
    return total_saved


def main():
    parser = argparse.ArgumentParser(description='Upsert leads into Supabase')
    parser.add_argument('--input', required=True, help='Path to enriched leads JSON file')
    args = parser.parse_args()

    with open(args.input, 'r', encoding='utf-8') as f:
        leads = json.load(f)

    upsert_leads(leads)


if __name__ == '__main__':
    main()
