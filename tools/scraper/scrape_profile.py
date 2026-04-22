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

    // Company name from h1. Trustpilot's h1 layout embeds a review-count
    // badge ("Hard Rock Casino NL Reviews 225") — prefer the first text node,
    // and strip any trailing "Reviews <n>" as a fallback.
    const h1 = document.querySelector('h1');
    if (h1) {
        let rawName = '';
        for (const node of h1.childNodes) {
            if (node.nodeType === 3 /* TEXT_NODE */ && node.textContent.trim()) {
                rawName = node.textContent.trim();
                break;
            }
        }
        if (!rawName) rawName = h1.textContent.trim();
        rawName = rawName.replace(/\s*Reviews\s+[\d,]+\s*$/i, '').trim();
        result.company_name = rawName;
    }

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

            # Clip the businessInfoGrid — captures both the info panel and
            # the rating card side by side, with no navbar or breadcrumb.
            captured = False
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
                    await page.screenshot(path=screenshot_path, clip=clip_box)
                    captured = True
            except Exception:
                pass

            if not captured:
                # Fallback: fixed clip skipping navbar/breadcrumb
                await page.screenshot(
                    path=screenshot_path,
                    clip={'x': 40, 'y': 130, 'width': 1200, 'height': 240},
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


async def _flush_partial(results_dict, output_path, flush_lock):
    """Atomically write the current results_dict (ordered by idx) to output_path."""
    async with flush_lock:
        ordered = [results_dict[i] for i in sorted(results_dict.keys())]
        tmp_path = output_path + '.tmp'
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(ordered, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, output_path)
        print(f"PROGRESS:partial_flush:{len(ordered)}", flush=True)


async def _scrape_batch(context, slugs_batch, screenshots_dir, results_dict, failed_list, start_idx, total,
                         output_path=None, flush_every=25, flush_lock=None):
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
            print(f"  [{idx + 1}/{total}] {slug}", flush=True)
            # Per-item start signal so the UI can say "Scanning acme.co…"
            print(f"PROGRESS:profile_start:{idx + 1}|{total}|{slug}", flush=True)

            try:
                contact = await scrape_single_profile(page, slug, screenshots_dir)

                if not contact:
                    # timeout is the most common cause of an empty response; classify so the UI renders a friendly line
                    print(f"FAILED:profile|{tp_url}|empty_page|Profile page loaded no content", flush=True)
                    failed_list.append(tp_url)
                    results_dict[idx] = {**lead}
                else:
                    # Merge contact data with lead
                    enriched = {**lead}
                    for key in ('company_name', 'website_url', 'trustpilot_email', 'phone', 'screenshot_path'):
                        if contact.get(key):
                            enriched[key] = contact[key]
                    results_dict[idx] = enriched
                    # Rich per-item done event: carries email source + screenshot flag + website presence for the UI
                    email_src = 'trustpilot' if contact.get('trustpilot_email') else 'none'
                    shot_flag = 'shot' if contact.get('screenshot_path') else 'noshot'
                    site_flag = 'site' if contact.get('website_url') else 'nosite'
                    print(f"PROGRESS:profile_saved:{idx + 1}|{total}|{slug}|{email_src}|{shot_flag}|{site_flag}", flush=True)
            except Exception as e:
                error_msg = str(e).replace('\n', ' ').replace('|', ' ')[:200]
                # Classify into a reason code so the UI picks a friendly line (timeouts vs nav errors vs everything else)
                err_lower = error_msg.lower()
                if 'timeout' in err_lower or 'timed out' in err_lower:
                    reason_code = 'timeout'
                elif 'err_' in err_lower or 'net::' in err_lower or 'dns' in err_lower:
                    reason_code = 'nav_error'
                else:
                    reason_code = 'error'
                print(f"FAILED:profile|{tp_url}|{reason_code}|{error_msg}", flush=True)
                failed_list.append(tp_url)
                results_dict[idx] = {**lead}

            # Keep the legacy fraction event — frontend uses it for the live progress bar
            print(f"PROGRESS:profile_progress:{idx + 1}/{total}", flush=True)

            # Incremental flush so the orchestrator can batch-upsert partial results
            if output_path and flush_lock and flush_every > 0:
                completed = len(results_dict)
                if completed > 0 and completed % flush_every == 0:
                    try:
                        await _flush_partial(results_dict, output_path, flush_lock)
                    except Exception as flush_err:
                        # Non-fatal — final write at end of phase will still capture everything
                        print(f"  [flush] partial write failed: {flush_err}", flush=True)

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
    output_path: str = '',
    flush_every: int = 25,
) -> list[dict]:
    """
    Enrich leads with contact details from Trustpilot profiles.
    Uses multiple parallel browser tabs for speed.

    If output_path is provided and flush_every > 0, the accumulated results are
    atomically written to output_path every flush_every completed profiles so
    an orchestrator can upsert partial results incrementally.
    """
    browser, context, _ = await launch_browser()

    if screenshots_dir:
        os.makedirs(screenshots_dir, exist_ok=True)

    total = len(leads)
    results_dict: dict[int, dict] = {}
    failed_list: list[str] = []
    flush_lock = asyncio.Lock() if output_path and flush_every > 0 else None

    try:
        # Split leads into groups for parallel tabs
        indexed_leads = list(enumerate(leads))
        batches = []
        for t in range(parallel_tabs):
            batch = indexed_leads[t::parallel_tabs]
            if batch:
                batches.append(batch)

        print(f"Scraping {total} profiles using {len(batches)} parallel tabs...", flush=True)

        # Run all tabs concurrently
        tasks = [
            _scrape_batch(context, batch, screenshots_dir, results_dict, failed_list, 0, total,
                          output_path=output_path, flush_every=flush_every, flush_lock=flush_lock)
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
    parser.add_argument('--flush-every', type=int, default=25,
                        help='Write partial results to --output every N completed profiles (0 to disable)')
    args = parser.parse_args()

    with open(args.input, 'r', encoding='utf-8') as f:
        leads = json.load(f)

    print(f"Enriching {len(leads)} leads from profiles...", flush=True)
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    enriched = asyncio.run(scrape_profiles(
        leads,
        screenshots_dir=args.screenshots_dir,
        parallel_tabs=args.parallel,
        output_path=args.output,
        flush_every=args.flush_every,
    ))

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(enriched, f, indent=2, ensure_ascii=False)

    print(f"Enriched leads saved to {args.output}")


if __name__ == '__main__':
    main()
