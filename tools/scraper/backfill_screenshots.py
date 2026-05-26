"""
Backfill Trustpilot profile screenshots for leads that don't have one.

Runs locally with the project's stealth-Playwright setup, visits each
lead's trustpilot_url, captures a cropped header screenshot, uploads it
to the Supabase `screenshots` bucket, and writes the public URL back to
leads.screenshot_path. Same capture logic as the production
scrape_profile.py — same cropped business-info grid, same fallback
ladder, same upsert-on-upload semantics — just iterating over the
existing leads table instead of fresh scrape input.

Usage:
    .venv/Scripts/python.exe tools/scraper/backfill_screenshots.py [options]

Options:
    --missing-only      Only target rows where screenshot_path is null or
                        not an HTTPS URL (default).
    --all               Re-capture screenshots for every Trustpilot lead,
                        even ones that already have a working URL.
    --country CC        Filter by ISO country code (e.g. US, NL, DE).
    --limit N           Cap the run at N leads (handy for dry runs).
    --dry-run           Print which leads would be processed without
                        launching the browser or writing anything back.
    --batch-size N      Number of leads to process per browser context
                        before recycling. Default 10.
    --delay-min FLOAT   Minimum delay between profile visits, seconds
                        (default 2.0). Trustpilot rate-limits aggressive
                        scraping — keep this honest.
    --delay-max FLOAT   Maximum delay between profile visits, seconds
                        (default 5.0).

Exit codes:
    0  success (zero failures, OR --dry-run)
    1  partial failure (some leads succeeded, some failed)
    2  hard failure (couldn't connect to Supabase / browser launch failed)

Environment:
    Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env. Storage
    upload bucket is hard-coded to 'screenshots' to match
    scrape-runner.ts and the public URL pattern the frontend reads.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import random
import sys
import time
from typing import Optional
from urllib.parse import urlparse

# Windows console defaults to cp1252; force UTF-8 so non-ASCII lead names
# (German Umlaute, accents) don't crash with 'charmap' codec errors when
# we print them. No-op on POSIX terminals that already default to UTF-8.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from tools.db.supabase_client import get_client  # noqa: E402
from tools.scraper.browser_utils import (  # noqa: E402
    launch_browser,
    safe_goto,
    dismiss_popups,
)
from tools.scraper.shared.supabase_storage import upload_screenshot_bytes  # noqa: E402


def extract_slug(trustpilot_url: str) -> Optional[str]:
    """
    Pull the review slug from a Trustpilot URL.

    Accepts both 'trustpilot.com/review/<slug>' and the rare
    'businessunit/...?units=...' shapes — we only care about the slug
    segment that fits into /review/<slug>. Returns None when the URL
    doesn't look like a review page so the caller can skip the row.
    """
    if not trustpilot_url:
        return None
    try:
        parsed = urlparse(trustpilot_url)
    except ValueError:
        return None
    if 'trustpilot.com' not in (parsed.netloc or ''):
        return None
    parts = [p for p in parsed.path.split('/') if p]
    # Path looks like ['review', 'company.com'] for a standard profile.
    if len(parts) >= 2 and parts[0] == 'review':
        return parts[1]
    return None


async def capture_screenshot_bytes(page, slug: str) -> Optional[bytes]:
    """
    Visit the Trustpilot profile and capture a cropped header screenshot.

    Returns the PNG bytes or None if the page never finished loading or
    no readable region could be found. Mirrors the clip-or-fallback
    ladder in scrape_profile.scrape_single_profile so screenshot
    composition is identical to what fresh scrapes already produce.
    """
    url = f"https://www.trustpilot.com/review/{slug}"
    if not await safe_goto(page, url):
        print(f"    [skip] safe_goto bailed for {slug}")
        return None

    try:
        await page.wait_for_selector('h1', timeout=10000)
    except Exception:
        # H1 missing usually means soft 404 or redirect. Take the shot
        # anyway — the fallback paths below will still produce something
        # readable for a real profile, and a soft 404 will read as a
        # generic Trustpilot search page which is at least not blank.
        pass

    # Modals/banners often paint after first interactive. Dismiss + hide
    # them right before the screenshot so the captured image doesn't have
    # a giant cookie banner across the rating panel.
    try:
        await dismiss_popups(page)
        await asyncio.sleep(0.4)
        await page.evaluate("""() => {
            const sels = [
                '[role="dialog"]', '[data-region="modal"]',
                '.cookies-banner', '#onetrust-banner-sdk', '#onetrust-consent-sdk',
                '[data-testid*="locale"]', '[data-testid*="modal"]'
            ];
            sels.forEach(s => document.querySelectorAll(s).forEach(el => {
                el.style.display = 'none';
                el.style.visibility = 'hidden';
            }));
        }""")
    except Exception:
        pass

    try:
        clip_box = await page.evaluate("""() => {
            const grid = document.querySelector('div.styles_businessInfoGrid__T_git');
            if (!grid) return null;
            const r = grid.getBoundingClientRect();
            if (r.width < 200 || r.y < 0 || r.y > 400) return null;
            return { x: Math.round(r.x), y: Math.round(r.y) - 8,
                     width: Math.round(r.width), height: 240 };
        }""")
        if clip_box:
            return await page.screenshot(clip=clip_box)
    except Exception as e:
        print(f"    [warn] business-info-grid clip failed for {slug}: {e}")

    # Fallback 1: known-good fixed clip skipping navbar/breadcrumb.
    try:
        return await page.screenshot(clip={'x': 40, 'y': 130, 'width': 1200, 'height': 240})
    except Exception as e:
        print(f"    [warn] fixed clip failed for {slug}: {e}")

    # Fallback 2: whatever's in the viewport. Worst-case acceptable
    # output — at least the user sees the page they were trying to
    # check.
    try:
        return await page.screenshot(full_page=False)
    except Exception as e:
        print(f"    [fail] viewport screenshot failed for {slug}: {e}")
        return None


def load_target_leads(*, missing_only: bool, country: Optional[str], limit: Optional[int]) -> list[dict]:
    """
    Pull the leads to backfill from Supabase.

    Filters:
      - trustpilot_url NOT NULL (we can't capture without a URL)
      - if missing_only: screenshot_path IS NULL or doesn't start with 'http'
      - optionally: country = <CC>

    Returns up to `limit` rows. Sort order: scraped_at DESC so the most
    recently captured leads jump the queue (those are the ones the
    operator is most likely to be working with right now).
    """
    client = get_client()
    q = client.from_('leads').select('id, company_name, trustpilot_url, screenshot_path, country, scraped_at')
    # We require a Trustpilot URL on the row AND that the slug is parseable
    # below. Filtering null URLs at the DB level cheapens the round trip.
    q = q.not_.is_('trustpilot_url', 'null')
    if missing_only:
        # PostgREST's `or` filter takes a comma-joined list of conditions —
        # any one match selects the row. We want either a null
        # screenshot_path OR one that doesn't look like an HTTPS URL
        # (legacy '.tmp/screenshots/foo.png' and bare-filename rows
        # qualify). PostgREST uses '*' as the LIKE wildcard in URL
        # syntax — it converts to SQL '%' server-side.
        q = q.or_(
            'screenshot_path.is.null,'
            'screenshot_path.not.ilike.http*'
        )
    if country:
        q = q.eq('country', country)
    q = q.order('scraped_at', desc=True)
    # PostgREST caps at 1000 by default — explicit limit lets the caller
    # go higher (or smaller for a dry run). We deliberately don't apply
    # the user's --limit here because the slug-parse filter below can
    # drop rows; we trim to --limit AFTER both DB and slug filters run.
    fetch_cap = (limit or 1000) * 3 if limit else 5000
    q = q.limit(min(fetch_cap, 5000))
    rows = q.execute().data or []

    # Drop any row whose trustpilot_url doesn't yield a parseable slug —
    # they'd just print as [skip] later and waste a browser hop.
    rows = [r for r in rows if extract_slug(r.get('trustpilot_url') or '')]

    # Apply the user's --limit AFTER all filters so they get the count
    # they asked for instead of a deflated number.
    if limit:
        rows = rows[:limit]
    return rows


async def run_backfill(args: argparse.Namespace) -> tuple[int, int]:
    """
    Iterate over target leads and capture+upload each one's screenshot.

    Returns (success_count, failure_count). The caller decides exit code
    based on the ratio.
    """
    print(f"[backfill] loading target leads (missing_only={args.missing_only}, country={args.country}, limit={args.limit})")
    leads = load_target_leads(
        missing_only=args.missing_only,
        country=args.country,
        limit=args.limit,
    )
    print(f"[backfill] {len(leads)} leads matched the filter")

    if args.dry_run:
        for lead in leads:
            slug = extract_slug(lead.get('trustpilot_url') or '')
            print(f"  [dry] {lead['id'][:8]} {lead.get('company_name')!r} -> slug={slug} (existing={lead.get('screenshot_path')!r})")
        return len(leads), 0

    if not leads:
        return 0, 0

    success = 0
    failure = 0
    client = get_client()
    browser = context = None

    try:
        browser, context, _initial_page = await launch_browser()
        # Recycle the page per-lead — Playwright pages occasionally
        # accumulate event listeners on dismissed popups and the JS heap
        # grows. Per-page reuse is cheaper than per-context but still
        # keeps memory bounded over a 1000-lead run.
        i = 0
        while i < len(leads):
            batch = leads[i:i + args.batch_size]
            page = await context.new_page()
            try:
                for lead in batch:
                    slug = extract_slug(lead.get('trustpilot_url') or '')
                    if not slug:
                        print(f"  [skip] {lead['id'][:8]} {lead.get('company_name')!r}: no parseable slug from {lead.get('trustpilot_url')!r}")
                        failure += 1
                        continue
                    print(f"  [capture] {lead['id'][:8]} {lead.get('company_name')!r} (slug={slug})")
                    started = time.time()
                    try:
                        png = await capture_screenshot_bytes(page, slug)
                    except Exception as e:
                        print(f"    [fail] capture threw: {e}")
                        png = None
                    if not png:
                        failure += 1
                        await asyncio.sleep(random.uniform(args.delay_min, args.delay_max))
                        continue

                    object_path = f"{slug}.png"
                    public_url = upload_screenshot_bytes(png, object_path, upsert=True)
                    if not public_url:
                        print(f"    [fail] upload returned None for {object_path}")
                        failure += 1
                        await asyncio.sleep(random.uniform(args.delay_min, args.delay_max))
                        continue

                    try:
                        client.from_('leads').update({'screenshot_path': public_url}).eq('id', lead['id']).execute()
                    except Exception as e:
                        print(f"    [fail] DB update threw for {lead['id']}: {e}")
                        failure += 1
                        await asyncio.sleep(random.uniform(args.delay_min, args.delay_max))
                        continue

                    elapsed = time.time() - started
                    print(f"    [ok]   uploaded {len(png)/1024:.1f} KB in {elapsed:.1f}s -> {public_url}")
                    success += 1
                    await asyncio.sleep(random.uniform(args.delay_min, args.delay_max))
            finally:
                try:
                    await page.close()
                except Exception:
                    pass
            i += args.batch_size
    finally:
        if context is not None:
            try:
                await context.close()
            except Exception:
                pass
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                pass

    return success, failure


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description='Backfill missing Trustpilot screenshots for existing leads.')
    target_group = p.add_mutually_exclusive_group()
    target_group.add_argument('--missing-only', action='store_true', default=True,
                              help='Only target leads whose screenshot_path is missing or non-HTTP (default).')
    target_group.add_argument('--all', action='store_true',
                              help='Re-capture every Trustpilot lead, even ones with a working URL.')
    p.add_argument('--country', type=str, default=None, help='Filter by ISO country code (e.g. US, NL, DE).')
    p.add_argument('--limit', type=int, default=None, help='Cap the run at N leads.')
    p.add_argument('--dry-run', action='store_true', help='List targets without launching the browser.')
    p.add_argument('--batch-size', type=int, default=10, help='Leads per page recycle (default 10).')
    p.add_argument('--delay-min', type=float, default=2.0, help='Min delay between profiles (sec, default 2.0).')
    p.add_argument('--delay-max', type=float, default=5.0, help='Max delay between profiles (sec, default 5.0).')
    args = p.parse_args()
    # --all flips missing_only off; argparse default leaves missing_only=True.
    if args.all:
        args.missing_only = False
    return args


def main() -> int:
    args = parse_args()
    try:
        success, failure = asyncio.run(run_backfill(args))
    except Exception as e:
        print(f"[backfill] fatal: {e}")
        return 2
    total = success + failure
    print(f"\n[backfill] done: {success}/{total} succeeded, {failure} failed")
    if failure == 0:
        return 0
    if success == 0:
        return 2
    return 1


if __name__ == '__main__':
    sys.exit(main())
