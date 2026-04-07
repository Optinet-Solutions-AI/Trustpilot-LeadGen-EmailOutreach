"""
Website Email Enricher — visits company websites to find primary contact emails.
Usage: python tools/scraper/scrape_website.py --input .tmp/enriched_leads.json --output .tmp/enriched_leads.json

Only enriches leads that have NO primary_email yet (skips those already found on Trustpilot).
Uses parallel browser tabs for speed.
Email ranking: prefers specific contact/sales emails, accepts info@, skips noreply/mailer-daemon.
"""

import argparse
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.scraper.browser_utils import launch_browser, human_delay, safe_goto


# Paths to check for contact emails (in priority order)
CONTACT_PATHS = ['/contact', '/contact-us', '/about', '/about-us', '/impressum', '/kontakt', '/contacto']

# Emails that can NEVER be delivered to — skip entirely
UNDELIVERABLE_PREFIXES = {
    'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
    'postmaster', 'mailer-daemon', 'bounce', 'bounces', 'abuse',
    'spam', 'unsubscribe',
}

# Best emails for cold outreach — ranked first
TOP_PREFIXES = [
    'contact', 'hello', 'hi', 'sales', 'partnerships', 'partner',
    'business', 'marketing', 'outreach', 'pr', 'media',
]

# Acceptable emails — ranked second
ACCEPTABLE_PREFIXES = [
    'info', 'enquiries', 'enquiry', 'inquiries', 'inquiry',
    'office', 'team', 'mail', 'email', 'general', 'admin',
    'reception', 'help', 'support',
]


def rank_email(email: str) -> int:
    """
    Return sort priority for an email address.
    Lower = better. Undeliverable = excluded before ranking.
    """
    prefix = email.split('@')[0].lower()
    if prefix in TOP_PREFIXES:
        return 0
    if prefix in ACCEPTABLE_PREFIXES:
        return 1
    return 2  # Specific/unknown prefix — probably best (e.g. john.smith@company.com)


def is_undeliverable(email: str) -> bool:
    prefix = email.split('@')[0].lower()
    return prefix in UNDELIVERABLE_PREFIXES


async def find_emails_on_page(page) -> list[str]:
    """Extract all email addresses from the current page."""
    emails = await page.evaluate(r'''() => {
        const found = new Set();
        const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

        // Prefer explicit mailto: links first
        document.querySelectorAll('a[href^="mailto:"]').forEach(el => {
            const email = el.href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
            if (email) found.add(email);
        });

        // Also scan visible text for email patterns
        const bodyText = document.body ? document.body.innerText : '';
        const matches = bodyText.match(emailPattern) || [];
        matches.forEach(m => found.add(m.toLowerCase()));

        return [...found];
    }''')
    return emails


async def scrape_website_email(page, website_url: str) -> str | None:
    """
    Visit a company's website and find their best contact email.
    Checks homepage + common contact pages.
    Returns the best-ranked deliverable email, or None.
    """
    if not website_url:
        return None

    if not website_url.startswith('http'):
        website_url = f"https://{website_url}"

    all_emails: set[str] = set()

    # 1. Homepage
    if await safe_goto(page, website_url, retries=2, timeout=15000):
        emails = await find_emails_on_page(page)
        all_emails.update(emails)

    # 2. Contact sub-pages
    base_url = website_url.rstrip('/')
    for path in CONTACT_PATHS:
        contact_url = f"{base_url}{path}"
        try:
            response = await page.goto(contact_url, wait_until='domcontentloaded', timeout=8000)
            if response and response.ok:
                emails = await find_emails_on_page(page)
                all_emails.update(emails)
        except Exception:
            continue
        await asyncio.sleep(0.3)

    if not all_emails:
        return None

    # Filter out undeliverable, then rank
    deliverable = [e for e in all_emails if not is_undeliverable(e)]
    if not deliverable:
        return None

    # Sort: rank 0 (contact/sales) → rank 1 (info/admin) → rank 2 (specific/custom)
    # For rank 2 (custom), custom emails beat generic, so we reverse within rank 2
    def sort_key(e: str):
        r = rank_email(e)
        # Within rank 2 (specific names), prefer shorter/simpler prefixes
        return (r, len(e))

    deliverable.sort(key=sort_key)
    return deliverable[0]


async def _enrich_batch(context, batch: list[tuple[int, dict]], results_dict: dict, total: int):
    """Enrich a batch of leads using a single browser tab."""
    page = await context.new_page()
    try:
        for i, (idx, lead) in enumerate(batch):
            website_url = lead.get('website_url')
            print(f"  [{idx + 1}/{total}] {website_url or '(no website)'}")

            try:
                email = await scrape_website_email(page, website_url)
                if email:
                    lead = {**lead, 'website_email': email}
                    print(f"    Found: {email}")
                else:
                    print(f"    No email found")
            except Exception as e:
                print(f"    Error: {e}")

            results_dict[idx] = lead

            if i < len(batch) - 1:
                await human_delay(1.0, 2.5)
    finally:
        await page.close()


async def enrich_websites(
    leads: list[dict],
    parallel_tabs: int = 3,
    progress_callback=None,
) -> list[dict]:
    """
    Add website_email to each lead that doesn't already have a primary_email.
    Uses multiple parallel browser tabs for speed.
    """
    # Split into: needs enrichment vs already has email
    needs_enrichment = []
    already_has_email = {}

    for i, lead in enumerate(leads):
        if lead.get('primary_email') or lead.get('trustpilot_email') or lead.get('website_email'):
            already_has_email[i] = lead
        elif lead.get('website_url'):
            needs_enrichment.append((i, lead))
        else:
            # No website URL, nothing we can do
            already_has_email[i] = lead

    skipped = len(leads) - len(needs_enrichment)
    total_to_enrich = len(needs_enrichment)

    print(f"\nEnrichment plan:")
    print(f"  {skipped} leads already have an email — skipping")
    print(f"  {total_to_enrich} leads need website enrichment")

    if total_to_enrich == 0:
        print("Nothing to enrich.")
        print(f"PROGRESS:enrich_done:0")
        return leads

    browser, context, _ = await launch_browser()
    results_dict: dict[int, dict] = dict(already_has_email)

    try:
        # Split into batches for parallel tabs
        batches = []
        for t in range(parallel_tabs):
            batch = needs_enrichment[t::parallel_tabs]
            if batch:
                batches.append(batch)

        print(f"Starting enrichment with {len(batches)} parallel tabs...\n")

        tasks = [
            _enrich_batch(context, batch, results_dict, total_to_enrich)
            for batch in batches
        ]
        await asyncio.gather(*tasks)

    finally:
        await browser.close()

    # Rebuild ordered list
    enriched_out = [results_dict[i] for i in range(len(leads)) if i in results_dict]

    found_count = sum(1 for l in enriched_out if l.get('website_email'))
    print(f"\nEnrichment complete: {found_count} new emails found out of {total_to_enrich} attempted.")
    print(f"PROGRESS:enrich_done:{found_count}")

    if progress_callback:
        progress_callback({'stage': 'enrich', 'current': total_to_enrich, 'total': total_to_enrich, 'enriched': found_count})

    return enriched_out


def main():
    parser = argparse.ArgumentParser(description='Enrich leads with emails from company websites')
    parser.add_argument('--input', required=True, help='Path to enriched leads JSON')
    parser.add_argument('--output', default='.tmp/enriched_leads.json', help='Output path')
    parser.add_argument('--parallel', type=int, default=3, help='Number of parallel browser tabs (default: 3)')
    args = parser.parse_args()

    with open(args.input, 'r', encoding='utf-8') as f:
        leads = json.load(f)

    print(f"Loaded {len(leads)} leads for website enrichment...")
    enriched = asyncio.run(enrich_websites(leads, parallel_tabs=args.parallel))

    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(enriched, f, indent=2, ensure_ascii=False)

    print(f"Saved to {args.output}")


if __name__ == '__main__':
    main()
