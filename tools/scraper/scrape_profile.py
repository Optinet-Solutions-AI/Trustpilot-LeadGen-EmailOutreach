"""
Trustpilot Profile Scraper — visits individual company pages to extract contact details.
Usage: python tools/scraper/scrape_profile.py --input .tmp/raw_scrape_results.json --output .tmp/enriched_leads.json

Extracts: company_name, website_url, trustpilot_email, phone from the "Contact info" section.
Takes a cropped screenshot of the profile header (company name, rating, reviews breakdown).
Uses parallel tabs for speed.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.scraper.browser_utils import launch_browser, human_delay, safe_goto


CONTACT_EXTRACT_JS = r'''() => {
    const result = {
        company_name: null,
        website_url: null,
        trustpilot_email: null,
        phone: null,
    };

    // Company name from h1
    const h1 = document.querySelector('h1');
    if (h1) result.company_name = h1.textContent.trim();

    // Domains to exclude from website_url (social/tracking/trustpilot)
    const EXCLUDED = [
        'trustpilot.com', 'facebook.com', 'twitter.com', 'x.com',
        'instagram.com', 'linkedin.com', 'youtube.com', 'tiktok.com',
        'pinterest.com', 'google.com', 'apple.com', 'microsoft.com',
        'apps.apple.com', 'play.google.com',
    ];
    const isExternal = (href) => {
        if (!href || !href.startsWith('http')) return false;
        return !EXCLUDED.some(d => href.toLowerCase().includes(d));
    };

    // ── Step 1: Look for website link in the Trustpilot business info sidebar ──
    // Trustpilot uses various class names across versions; try all known patterns
    const sidebarSelectors = [
        '[class*="contactInfo"]',
        '[class*="businessInfo"]',
        '[class*="contactBlock"]',
        '[class*="companyInfo"]',
        '[class*="businessDetails"]',
        '[class*="businessUnit"]',
        '[class*="contact-info"]',
        '[class*="company-info"]',
        'aside',
        'section[class*="contact"]',
        '[data-business-unit-info]',
    ];

    for (const sel of sidebarSelectors) {
        const section = document.querySelector(sel);
        if (!section) continue;

        const links = section.querySelectorAll('a[href]');
        for (const link of links) {
            const href = link.getAttribute('href') || '';
            if (href.startsWith('mailto:') && !result.trustpilot_email) {
                result.trustpilot_email = href.replace('mailto:', '').split('?')[0].trim();
            } else if (href.startsWith('tel:') && !result.phone) {
                result.phone = href.replace('tel:', '').trim();
            } else if (isExternal(href) && !result.website_url) {
                result.website_url = href.replace(/\/$/, '');
            }
        }
        // If found what we need, stop early
        if (result.website_url && result.trustpilot_email) break;
    }

    // ── Step 2: Look for "Visit website" / website button links anywhere on page ──
    if (!result.website_url) {
        const allLinks = document.querySelectorAll('a[href]');
        for (const link of allLinks) {
            const href = link.getAttribute('href') || '';
            const text = (link.textContent || '').toLowerCase().trim();
            const ariaLabel = (link.getAttribute('aria-label') || '').toLowerCase();
            if (href.startsWith('mailto:') && !result.trustpilot_email) {
                result.trustpilot_email = href.replace('mailto:', '').split('?')[0].trim();
            } else if (href.startsWith('tel:') && !result.phone) {
                result.phone = href.replace('tel:', '').trim();
            } else if (isExternal(href) && !result.website_url) {
                // Only pick links that clearly say "website" or "visit"
                if (text.includes('website') || text.includes('visit') ||
                    ariaLabel.includes('website') || ariaLabel.includes('visit') ||
                    link.getAttribute('rel') === 'noopener') {
                    result.website_url = href.replace(/\/$/, '');
                }
            }
        }
    }

    // ── Step 3: Phone fallback — scan contact section text ──
    if (!result.phone) {
        const phonePattern = /(?:\+?\d{1,3}[\s.\-]?)?\(?\d{2,4}\)?[\s.\-]?\d{3,4}[\s.\-]?\d{3,4}/;
        for (const sel of ['[class*="contactInfo"]', '[class*="contact"]', 'aside']) {
            const section = document.querySelector(sel);
            if (!section) continue;
            const match = (section.textContent || '').match(phonePattern);
            if (match) { result.phone = match[0].trim(); break; }
        }
    }

    // ── Step 4: Email fallback — scan visible text anywhere ──
    if (!result.trustpilot_email) {
        const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
        const bodyText = document.body ? document.body.innerText : '';
        const match = bodyText.match(emailPattern);
        if (match) result.trustpilot_email = match[0];
    }

    return result;
}'''


async def scrape_single_profile(page, slug: str, screenshots_dir: str = '') -> dict:
    """
    Visit a Trustpilot profile page and extract contact details.
    Takes a cropped screenshot of the profile header section only.
    """
    url = f"https://www.trustpilot.com/review/{slug}"

    if not await safe_goto(page, url):
        return {}

    # Wait for profile info to load
    try:
        await page.wait_for_selector('h1', timeout=10000)
    except Exception:
        pass

    # Take a cropped screenshot of just the profile header
    screenshot_path = ''
    if screenshots_dir:
        try:
            safe_slug = slug.replace('/', '_').replace('\\', '_')
            screenshot_path = os.path.join(screenshots_dir, f"{safe_slug}.png")

            # Try progressively tighter selectors for the hero card only
            # (company name + stars + rating number + review bars)
            hero_selectors = [
                # Trustpilot's hero/header section (above "Company details")
                '[class*="heroBusinessInfo"]',
                '[class*="businessUnitHeader"]',
                '[class*="businessSummary"]',
                'header[class*="business"]',
            ]
            captured = False
            for sel in hero_selectors:
                section = await page.query_selector(sel)
                if section:
                    await section.screenshot(path=screenshot_path)
                    captured = True
                    break

            if not captured:
                # Fallback: clip to top portion only — hero card is ~350px tall
                await page.screenshot(
                    path=screenshot_path,
                    clip={'x': 0, 'y': 0, 'width': 1280, 'height': 350},
                )
        except Exception as e:
            # Last fallback: viewport screenshot
            try:
                await page.screenshot(path=screenshot_path, full_page=False)
            except Exception:
                print(f"    Screenshot failed for {slug}: {e}")
                screenshot_path = ''

    # Extract contact information
    contact_data = await page.evaluate(CONTACT_EXTRACT_JS)
    contact_data['screenshot_path'] = screenshot_path
    return contact_data


async def _scrape_batch(context, slugs_batch, screenshots_dir, results_dict, failed_list, start_idx, total):
    """Scrape a batch of profiles using a single page (tab)."""
    page = await context.new_page()
    try:
        from playwright_stealth import stealth_async
        await stealth_async(page)
    except ImportError:
        pass
    try:
        for i, (idx, lead) in enumerate(slugs_batch):
            slug = lead.get('slug')
            if not slug:
                continue

            tp_url = lead.get('trustpilot_url', f"https://www.trustpilot.com/review/{slug}")
            print(f"  [{idx + 1}/{total}] {slug}")

            try:
                contact = await scrape_single_profile(page, slug, screenshots_dir)

                if not contact:
                    print(f"FAILED:profile:{tp_url}:Empty response from profile page")
                    failed_list.append(tp_url)
                    results_dict[idx] = {**lead}
                else:
                    # Merge contact data with lead
                    enriched = {**lead}
                    for key in ('company_name', 'website_url', 'trustpilot_email', 'phone', 'screenshot_path'):
                        if contact.get(key):
                            enriched[key] = contact[key]
                    results_dict[idx] = enriched
            except Exception as e:
                error_msg = str(e).replace('\n', ' ')[:200]
                print(f"FAILED:profile:{tp_url}:{error_msg}")
                failed_list.append(tp_url)
                results_dict[idx] = {**lead}

            print(f"PROGRESS:profile_progress:{idx + 1}/{total}")

            # Small delay between profiles within the same tab
            if i < len(slugs_batch) - 1:
                await human_delay(1.5, 3.0)
    finally:
        await page.close()


async def scrape_profiles(
    leads: list[dict],
    screenshots_dir: str = '',
    parallel_tabs: int = 3,
    progress_callback=None,
) -> list[dict]:
    """
    Enrich leads with contact details from Trustpilot profiles.
    Uses multiple parallel browser tabs for speed.
    """
    browser, context, _ = await launch_browser()

    if screenshots_dir:
        os.makedirs(screenshots_dir, exist_ok=True)

    total = len(leads)
    results_dict: dict[int, dict] = {}
    failed_list: list[str] = []

    try:
        # Split leads into groups for parallel tabs
        indexed_leads = list(enumerate(leads))
        batches = []
        for t in range(parallel_tabs):
            batch = indexed_leads[t::parallel_tabs]
            if batch:
                batches.append(batch)

        print(f"Scraping {total} profiles using {len(batches)} parallel tabs...")

        # Run all tabs concurrently
        tasks = [
            _scrape_batch(context, batch, screenshots_dir, results_dict, failed_list, 0, total)
            for batch in batches
        ]
        await asyncio.gather(*tasks)

        # Progress reporting
        if progress_callback:
            progress_callback({
                'stage': 'profile',
                'current': total,
                'total': total,
            })

    finally:
        await browser.close()

    # Reconstruct ordered list
    enriched = []
    for i in range(total):
        if i in results_dict:
            enriched.append(results_dict[i])

    print(f"\nEnriched {len(enriched)} profiles. Failed: {len(failed_list)}")
    print(f"PROGRESS:profile_done:{len(enriched)}")
    return enriched


def main():
    parser = argparse.ArgumentParser(description='Scrape Trustpilot profile pages for contact details')
    parser.add_argument('--input', required=True, help='Path to raw scrape results JSON')
    parser.add_argument('--output', default='.tmp/enriched_leads.json', help='Output enriched leads JSON')
    parser.add_argument('--screenshots-dir', default='.tmp/screenshots', help='Directory to save profile screenshots')
    parser.add_argument('--parallel', type=int, default=3, help='Number of parallel browser tabs (default: 3)')
    args = parser.parse_args()

    with open(args.input, 'r', encoding='utf-8') as f:
        leads = json.load(f)

    print(f"Enriching {len(leads)} leads from profiles...")
    enriched = asyncio.run(scrape_profiles(
        leads,
        screenshots_dir=args.screenshots_dir,
        parallel_tabs=args.parallel,
    ))

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(enriched, f, indent=2, ensure_ascii=False)

    print(f"Enriched leads saved to {args.output}")


if __name__ == '__main__':
    main()
