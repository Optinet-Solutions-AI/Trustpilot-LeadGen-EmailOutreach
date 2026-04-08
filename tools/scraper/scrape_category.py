"""
Trustpilot Category Scraper — paginates category pages, filters by star rating.
Usage: python tools/scraper/scrape_category.py --country US --category casino --max-rating 3.5

Output: JSON array of { name, slug, rating, trustpilot_url } saved to --output path.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.scraper.browser_utils import launch_browser, human_delay, safe_goto


async def scrape_category(
    country: str,
    category: str,
    min_rating: float = 1.0,
    max_rating: float = 3.5,
    max_pages: int = 50,
    progress_callback=None,
) -> list[dict]:
    """
    Scrape all companies from a Trustpilot category page filtered by rating.
    Returns list of { name, slug, rating, trustpilot_url }.
    """
    browser, context, page = await launch_browser()
    results = []
    consecutive_above = 0  # Track pages where ALL cards are above max_rating

    try:
        page_num = 1
        while page_num <= max_pages:
            url = f"https://www.trustpilot.com/categories/{category}?country={country}&page={page_num}"
            print(f"\n[Page {page_num}] {url}")

            # Retry page up to 2 times if navigation or card loading fails
            page_loaded = False
            for attempt in range(3):
                if attempt > 0:
                    print(f"  Retry attempt {attempt} for page {page_num}...")
                    await human_delay(3.0, 6.0)

                if not await safe_goto(page, url):
                    print(f"  Navigation failed (attempt {attempt + 1}).")
                    continue

                # Wait for company cards to appear
                try:
                    await page.wait_for_selector(
                        '[class*="businessUnitMain"]',
                        timeout=12000,
                    )
                    # Small wait to let all cards finish rendering
                    await asyncio.sleep(1.5)
                    page_loaded = True
                    break
                except Exception:
                    # Fallback selectors for layout changes
                    try:
                        await page.wait_for_selector(
                            'a[href*="/review/"]',
                            timeout=8000,
                        )
                        await asyncio.sleep(1.5)
                        page_loaded = True
                        break
                    except Exception:
                        print(f"  No company cards found (attempt {attempt + 1}).")
                        continue

            if not page_loaded:
                print(f"  Failed to load page {page_num} after 3 attempts. Stopping pagination.")
                break

            # Extract company data from the page (with retry if 0 results on first try)
            extract_js = r'''() => {
                const cards = document.querySelectorAll('[class*="businessUnitMain"]');
                const results = [];

                for (const card of cards) {
                    // Get company name from heading element
                    const nameEl = card.querySelector('[class*="heading"]');
                    const name = nameEl ? nameEl.textContent.trim() : null;

                    // Get link/slug from parent <a> or child <a>
                    const linkEl = card.closest('a[href*="/review/"]')
                        || card.querySelector('a[href*="/review/"]');
                    let slug = null;
                    if (linkEl) {
                        const href = linkEl.getAttribute('href');
                        const match = href.match(/\/review\/(.+)/);
                        if (match) slug = match[1].replace(/\/$/, '');
                    }

                    // Get star rating from TrustScore span (most reliable)
                    let rating = null;
                    const scoreEl = card.querySelector('[class*="trustScore"] span');
                    if (scoreEl) {
                        const m = scoreEl.textContent.match(/(\d+\.?\d*)/);
                        if (m) rating = parseFloat(m[1]);
                    }

                    // Fallback: parse from star image alt text
                    if (rating === null) {
                        const imgEl = card.querySelector('img[alt*="TrustScore"]');
                        if (imgEl) {
                            const alt = imgEl.getAttribute('alt') || '';
                            const m = alt.match(/TrustScore\s+(\d+\.?\d*)/);
                            if (m) rating = parseFloat(m[1]);
                        }
                    }

                    if (name && slug) {
                        results.push({ name, slug, rating });
                    }
                }
                return results;
            }'''

            companies = await page.evaluate(extract_js)

            # If 0 companies extracted but page loaded, wait and retry extraction
            if len(companies) == 0 and page_num == 1:
                print("  0 companies on first extraction, waiting for full render...")
                await human_delay(3.0, 5.0)
                companies = await page.evaluate(extract_js)

            # Filter by rating range
            page_results = []
            for company in companies:
                rating = company.get('rating')
                if rating is not None and min_rating <= rating <= max_rating:
                    company['trustpilot_url'] = f"https://www.trustpilot.com/review/{company['slug']}"
                    page_results.append(company)
                elif rating is None:
                    # Include companies with unknown rating for manual review
                    company['trustpilot_url'] = f"https://www.trustpilot.com/review/{company['slug']}"
                    page_results.append(company)

            results.extend(page_results)

            # Determine the lowest rating on this page
            page_ratings = [c['rating'] for c in companies if c.get('rating') is not None]
            lowest_on_page = min(page_ratings) if page_ratings else None
            highest_on_page = max(page_ratings) if page_ratings else None

            print(f"  Found {len(companies)} companies, {len(page_results)} match filter (rating {min_rating}-{max_rating})")
            if page_ratings:
                print(f"  Page rating range: {lowest_on_page}-{highest_on_page}")

            print(f"PROGRESS:category_progress:{page_num}:{len(results)}")

            # Smart skip: if all companies on page are above max_rating, jump ahead
            if page_results == [] and lowest_on_page is not None and lowest_on_page > max_rating:
                consecutive_above += 1
                # Jump by larger increments: first skip by 5, then 10
                skip = 5 if consecutive_above == 1 else 10
                old_page = page_num
                page_num = min(page_num + skip, max_pages)
                print(f"  All above {max_rating}, skipping ahead from page {old_page} to {page_num}")
                await human_delay(2.0, 5.0)
                continue
            else:
                consecutive_above = 0

            # Early stop: if all companies on page are below min_rating, we've gone too far
            if page_ratings and highest_on_page is not None and highest_on_page < min_rating:
                print(f"  All companies below min_rating {min_rating}. Stopping.")
                break

            if progress_callback:
                progress_callback({
                    'stage': 'category',
                    'page': page_num,
                    'found': len(results),
                    'page_found': len(page_results),
                })

            # Check if there's a next page
            has_next = await page.evaluate(r'''() => {
                const next = document.querySelector(
                    'a[name="pagination-button-next"], [aria-label="Next page"], a[data-pagination-button-next-link]'
                );
                return next !== null && !next.hasAttribute('disabled');
            }''')

            if not has_next:
                print(f"  No more pages. Stopping after page {page_num}.")
                break

            page_num += 1
            await human_delay(2.0, 5.0)

    finally:
        await browser.close()

    print(f"\nTotal: {len(results)} companies found matching filter.")
    return results


def main():
    parser = argparse.ArgumentParser(description='Scrape Trustpilot category pages')
    parser.add_argument('--country', required=True, help='Country code (e.g. US, GB, AU)')
    parser.add_argument('--category', required=True, help='Trustpilot category slug (e.g. casino)')
    parser.add_argument('--min-rating', type=float, default=1.0, help='Minimum star rating (default: 1.0)')
    parser.add_argument('--max-rating', type=float, default=3.5, help='Maximum star rating (default: 3.5)')
    parser.add_argument('--max-pages', type=int, default=50, help='Max pages to scrape (default: 50)')
    parser.add_argument('--output', default='.tmp/raw_scrape_results.json', help='Output JSON file path')
    args = parser.parse_args()

    # Ensure output directory exists
    os.makedirs(os.path.dirname(args.output), exist_ok=True)

    results = asyncio.run(scrape_category(
        country=args.country,
        category=args.category,
        min_rating=args.min_rating,
        max_rating=args.max_rating,
        max_pages=args.max_pages,
    ))

    # Add country/category metadata to each result
    for r in results:
        r['country'] = args.country
        r['category'] = args.category

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    print(f"Results saved to {args.output}")

    # Print progress to stdout for API scrape-runner to parse
    print(f"PROGRESS:category_done:{len(results)}")


if __name__ == '__main__':
    main()
