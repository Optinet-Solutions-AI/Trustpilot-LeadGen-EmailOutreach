"""
Trustpilot Profile Scraper — visits individual company pages to extract contact details.
Usage: python tools/scraper/scrape_profile.py --input .tmp/raw_scrape_results.json --output .tmp/enriched_leads.json

Extracts: company_name, website_url, trustpilot_email, phone from the "Contact info" section.
Takes a cropped screenshot of the profile header (company name, rating, reviews breakdown).
Uses parallel tabs for speed.
"""

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

    // Look through all links for contact info patterns
    const allLinks = document.querySelectorAll('a[href]');
    for (const link of allLinks) {
        const href = link.getAttribute('href') || '';

        // Website URL — external link in contact section
        if (href.startsWith('http') &&
            !href.includes('trustpilot.com') &&
            !href.includes('facebook.com') &&
            !href.includes('twitter.com') &&
            !href.includes('instagram.com') &&
            !href.includes('linkedin.com') &&
            !href.includes('youtube.com')) {

            const parent = link.closest('[class*="contact"], [class*="info"], [class*="sidebar"], aside');
            if (parent || link.closest('body')) {
                if (!result.website_url) {
                    result.website_url = href.replace(/\/$/, '');
                }
            }
        }

        // Email
        if (href.startsWith('mailto:')) {
            result.trustpilot_email = href.replace('mailto:', '').split('?')[0].trim();
        }

        // Phone
        if (href.startsWith('tel:')) {
            result.phone = href.replace('tel:', '').trim();
        }
    }

    // Fallback: look for website in the info section
    if (!result.website_url) {
        const infoSection = document.querySelector(
            '[class*="contactInfo"], [class*="sidebar"], [data-company-info]'
        );
        if (infoSection) {
            const links = infoSection.querySelectorAll('a[href^="http"]');
            for (const link of links) {
                const href = link.getAttribute('href');
                if (!href.includes('trustpilot.com')) {
                    result.website_url = href.replace(/\/$/, '');
                    break;
                }
            }
        }
    }

    // Fallback: look for phone in text
    if (!result.phone) {
        const phonePattern = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/;
        const infoSection = document.querySelector(
            '[class*="contactInfo"], [class*="contact"], aside'
        );
        if (infoSection) {
            const text = infoSection.textContent || '';
            const match = text.match(phonePattern);
            if (match) result.phone = match[0].trim();
        }
    }

    // Fallback: scan for email in text
    if (!result.trustpilot_email) {
        const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
        const infoSection = document.querySelector(
            '[class*="contactInfo"], [class*="contact"], aside'
        );
        if (infoSection) {
            const text = infoSection.textContent || '';
            const match = text.match(emailPattern);
            if (match) result.trustpilot_email = match[0];
        }
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

            # Try to screenshot just the profile info grid (name + rating + contact)
            profile_section = await page.query_selector(
                '[class*="businessInfoGrid"], [class*="businessUnit"], [class*="summary"]'
            )
            if profile_section:
                await profile_section.screenshot(path=screenshot_path)
            else:
                # Fallback: clip to top 500px of page
                await page.screenshot(
                    path=screenshot_path,
                    clip={'x': 0, 'y': 0, 'width': 1280, 'height': 500},
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
