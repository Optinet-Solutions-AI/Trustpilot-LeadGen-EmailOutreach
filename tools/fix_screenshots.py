"""
Re-capture screenshots for leads with broken local paths.
Takes a cropped screenshot of the Trustpilot profile header only.
Saves to .tmp/screenshots_fix/ — a separate Node script handles upload.
"""

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'db'))
from supabase_client import table

from playwright.async_api import async_playwright

SCREENSHOTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.tmp', 'screenshots_fix')


async def take_header_screenshot(page, url: str, output_path: str) -> bool:
    try:
        await page.goto(url, wait_until='domcontentloaded', timeout=20000)
        await page.wait_for_timeout(3000)

        selectors = [
            'section.styles_headerSection__BTHbz',
            '[data-business-unit-card-section]',
            '.business-unit-profile-summary',
            'div.styles_businessUnitHeader__sMrpj',
            'section[class*="header"]',
        ]

        for selector in selectors:
            try:
                el = await page.query_selector(selector)
                if el:
                    box = await el.bounding_box()
                    if box and box['height'] > 50:
                        await el.screenshot(path=output_path)
                        print(f"  OK section ({selector})")
                        return True
            except Exception:
                continue

        await page.screenshot(
            path=output_path,
            clip={'x': 0, 'y': 0, 'width': 1280, 'height': 350},
        )
        print(f"  OK viewport crop")
        return True
    except Exception as e:
        print(f"  FAIL: {e}")
        return False


async def main():
    result = table('leads').select(
        'id', 'company_name', 'screenshot_path', 'trustpilot_url'
    ).not_.is_('screenshot_path', 'null').not_.like('screenshot_path', 'http%').neq('screenshot_path', '').execute()

    leads = result.data
    print(f"Found {len(leads)} leads with broken local screenshot paths\n")

    if not leads:
        print("Nothing to fix!")
        return

    os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

    # Save manifest for the Node upload script
    manifest = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={'width': 1280, 'height': 900},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        )

        success = 0
        failed = 0

        for i, lead in enumerate(leads):
            tp_url = lead.get('trustpilot_url', '')
            if not tp_url or tp_url.startswith('manual:'):
                print(f"[{i+1}/{len(leads)}] {lead['company_name']} — skip (manual)")
                failed += 1
                continue

            filename = os.path.basename(lead['screenshot_path'])
            local_path = os.path.join(SCREENSHOTS_DIR, filename)

            print(f"[{i+1}/{len(leads)}] {lead['company_name']} -> {tp_url}")

            page = await context.new_page()
            try:
                ok = await take_header_screenshot(page, tp_url, local_path)
                if ok and os.path.exists(local_path):
                    manifest.append({
                        'id': lead['id'],
                        'filename': filename,
                        'local_path': local_path,
                    })
                    success += 1
                else:
                    failed += 1
            except Exception as e:
                print(f"  ERROR: {e}")
                failed += 1
            finally:
                await page.close()

            await asyncio.sleep(2)

        await browser.close()

    # Write manifest for Node upload script
    manifest_path = os.path.join(SCREENSHOTS_DIR, 'manifest.json')
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    print(f"\n{'='*50}")
    print(f"Screenshots: {success} captured, {failed} failed")
    print(f"Manifest: {manifest_path}")
    print(f"Run the Node upload script next to push to Supabase Storage.")


if __name__ == '__main__':
    asyncio.run(main())
