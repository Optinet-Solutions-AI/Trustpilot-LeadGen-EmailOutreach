"""
Website Email Enricher — visits company websites to find primary contact emails.
Usage: python tools/scraper/scrape_website.py --input .tmp/enriched_leads.json --output .tmp/enriched_leads.json

Enriches ALL leads that have website_url but no website_email yet.
Uses parallel browser tabs for speed.

Email ranking: prefers specific contact/sales emails, accepts info@, skips noreply/mailer-daemon.
Domain validation: only keeps emails whose domain matches the company website.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys

# Force UTF-8 stdout/stderr so non-ASCII characters in emails/URLs don't crash
# when running as a subprocess (Cloud Run Linux locale may default to ASCII)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
from tools.scraper.browser_utils import launch_browser, human_delay, safe_goto, dismiss_popups


# Paths to check for contact emails (in priority order)
CONTACT_PATHS = [
    '/contact', '/contact-us', '/contact_us',
    '/about', '/about-us', '/about_us',
    '/impressum', '/kontakt', '/contacto',
    '/info', '/reach-us', '/get-in-touch',
    '/support', '/help',
]

# Emails that can NEVER be delivered to — skip entirely
UNDELIVERABLE_PREFIXES = {
    'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
    'postmaster', 'mailer-daemon', 'bounce', 'bounces', 'abuse',
    'spam', 'unsubscribe', 'webmaster',
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

# Email pattern (strict)
EMAIL_RE = re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}')

# Obfuscated email patterns like "user [at] domain [dot] com"
OBFUSCATED_RE = re.compile(
    r'([a-zA-Z0-9._%+\-]+)\s*[\[\(]?\s*(?:at|@)\s*[\]\)]?\s*'
    r'([a-zA-Z0-9\-]+)\s*[\[\(]?\s*(?:dot|\.)\s*[\]\)]?\s*([a-zA-Z]{2,})',
    re.IGNORECASE,
)

# Free/generic email providers — skip these, they're not company emails
FREE_EMAIL_DOMAINS = {
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
    'icloud.com', 'aol.com', 'mail.com', 'protonmail.com', 'yandex.com',
    'gmx.com', 'gmx.de', 'web.de', 'zoho.com',
    # Common support/CRM platforms — emails here go to a third-party, not the company
    'zendesk.com', 'freshdesk.com', 'helpscout.com', 'intercom.io',
    'salesforce.com', 'hubspot.com', 'mailchimp.com', 'sendgrid.net',
}



def email_matches_domain(email: str, website_url: str) -> bool:
    """
    Reject clearly wrong emails: free personal providers and known third-party platforms.
    Does NOT require the email domain to match the website domain — companies often use
    a different TLD or brand name for their emails (e.g. danskespil.dk email on
    danske-spil-casino.dk website), and rejecting those causes too many false negatives.
    """
    if not email:
        return True

    email_domain = email.split('@')[-1].lower()
    return email_domain not in FREE_EMAIL_DOMAINS


def rank_email(email: str) -> int:
    """Return sort priority for an email address. Lower = better."""
    prefix = email.split('@')[0].lower()
    if prefix in TOP_PREFIXES:
        return 0
    if prefix in ACCEPTABLE_PREFIXES:
        return 1
    return 2  # Specific/unknown prefix — probably a real person's email (best for cold outreach)


def is_undeliverable(email: str) -> bool:
    prefix = email.split('@')[0].lower()
    return prefix in UNDELIVERABLE_PREFIXES


def parse_emails_from_text(text: str) -> list[str]:
    """Extract standard emails from plain text."""
    return [m.lower() for m in EMAIL_RE.findall(text)]


def parse_obfuscated_emails(text: str) -> list[str]:
    """Find emails written as 'user [at] domain [dot] com'."""
    emails = []
    for m in OBFUSCATED_RE.finditer(text):
        email = f"{m.group(1)}@{m.group(2)}.{m.group(3)}".lower()
        if EMAIL_RE.match(email):
            emails.append(email)
    return emails


async def find_emails_on_page(page, website_url: str = '') -> list[str]:
    """
    Extract all email addresses from the current page.
    Checks: mailto links, visible text, HTML source, obfuscated patterns, data attributes.
    Filters by domain match against website_url.
    """
    all_emails: set[str] = set()

    try:
        # 1. Explicit mailto: links (most reliable)
        mailto_emails = await page.evaluate(r'''() => {
            const found = [];
            document.querySelectorAll('a[href^="mailto:"]').forEach(el => {
                const email = el.href.replace('mailto:', '').split('?')[0].trim().toLowerCase();
                if (email && email.includes('@')) found.push(email);
            });
            return found;
        }''')
        all_emails.update(mailto_emails)

        # 2. Visible text (rendered by browser)
        body_text = await page.evaluate('() => document.body ? document.body.innerText : ""')
        all_emails.update(parse_emails_from_text(body_text))
        all_emails.update(parse_obfuscated_emails(body_text))

        # 3. Raw HTML source — catches encoded emails and data attributes
        html_source = await page.content()
        all_emails.update(parse_emails_from_text(html_source))

        # 4. data-email / data-mail attributes (some sites use these to avoid scrapers)
        data_emails = await page.evaluate(r'''() => {
            const found = [];
            document.querySelectorAll('[data-email],[data-mail],[data-contact]').forEach(el => {
                const val = el.getAttribute('data-email') || el.getAttribute('data-mail') || el.getAttribute('data-contact');
                if (val && val.includes('@')) found.push(val.toLowerCase().trim());
            });
            return found;
        }''')
        all_emails.update(data_emails)

    except Exception as e:
        print(f"    Warning: email extraction error: {str(e)[:100]}")

    # Filter: undeliverable + domain mismatch
    filtered = []
    for email in all_emails:
        if is_undeliverable(email):
            continue
        if not email_matches_domain(email, website_url):
            continue
        filtered.append(email)

    return filtered


async def scrape_website_email(page, website_url: str) -> tuple[str | None, list[str]]:
    """
    Visit a company's website and find their best contact email.
    Checks homepage + common contact pages.

    Returns: (best_email, all_candidates) — best is None if nothing found.
    """
    if not website_url:
        return None, []

    if not website_url.startswith('http'):
        website_url = f"https://{website_url}"

    all_emails: set[str] = set()

    # 1. Homepage
    print(f"    Visiting homepage: {website_url}")
    if await safe_goto(page, website_url, retries=2, timeout=20000):
        await dismiss_popups(page)
        emails = await find_emails_on_page(page, website_url)
        if emails:
            print(f"    Homepage: found {len(emails)} email(s): {emails}")
        all_emails.update(emails)
    else:
        print(f"    Homepage failed to load — skipping contact pages")
        return None, []

    # If homepage already gave us a top-priority email, we can stop early
    deliverable = [e for e in all_emails if not is_undeliverable(e)]
    top = [e for e in deliverable if rank_email(e) == 0]
    if top:
        print(f"    Found top-priority email on homepage, skipping contact pages")
        best = sorted(top, key=lambda e: (rank_email(e), len(e)))[0]
        return best, deliverable

    # 2. Contact sub-pages
    base_url = website_url.rstrip('/')
    for path in CONTACT_PATHS:
        contact_url = f"{base_url}{path}"
        try:
            response = await page.goto(contact_url, wait_until='domcontentloaded', timeout=12000)
            if response and (response.ok or response.status == 200):
                await dismiss_popups(page)
                emails = await find_emails_on_page(page, website_url)
                if emails:
                    print(f"    {path}: found {len(emails)} email(s): {emails}")
                    all_emails.update(emails)
                    # Stop as soon as we find a top-priority email
                    top = [e for e in all_emails if rank_email(e) == 0]
                    if top:
                        break
        except Exception:
            pass
        await asyncio.sleep(0.5)

    if not all_emails:
        print(f"    No emails found on homepage or contact pages")
        return None, []

    # Final filter and rank
    deliverable = [e for e in all_emails if not is_undeliverable(e)]
    if not deliverable:
        print(f"    All found emails were undeliverable/filtered")
        return None, []

    def sort_key(e: str):
        r = rank_email(e)
        # Within rank 2, prefer shorter prefixes (likely real person emails)
        return (r, len(e))

    deliverable.sort(key=sort_key)
    best = deliverable[0]
    print(f"    Best email: {best} (from candidates: {deliverable})")
    return best, deliverable


async def _enrich_batch(context, batch: list[tuple[int, dict]], results_dict: dict, failed_list: list, total: int):
    """Enrich a batch of leads using a single browser tab."""
    page = await context.new_page()

    # Apply stealth to every new tab
    try:
        from playwright_stealth import stealth_async
        await stealth_async(page)
    except ImportError:
        pass

    try:
        for i, (idx, lead) in enumerate(batch):
            website_url = lead.get('website_url')
            print(f"\n  [{idx + 1}/{total}] Enriching: {website_url or '(no website)'}")

            try:
                best_email, all_candidates = await scrape_website_email(page, website_url)
                updated_lead = {**lead}
                if best_email:
                    updated_lead['website_email'] = best_email
                    print(f"    >> SET website_email = {best_email}")
                else:
                    print(f"    >> No email found")
            except Exception as e:
                error_msg = str(e).replace('\n', ' ')[:200]
                print(f"FAILED:website:{website_url or 'unknown'}:{error_msg}")
                failed_list.append(website_url or 'unknown')
                updated_lead = {**lead}

            results_dict[idx] = updated_lead
            print(f"PROGRESS:enrich_progress:{idx + 1}/{total}")

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
    Add website_email to each lead that has website_url but no website_email yet.
    Uses multiple parallel browser tabs for speed.
    """
    needs_enrichment = []
    skip_dict = {}

    for i, lead in enumerate(leads):
        if lead.get('website_email'):
            # Already has website email from a previous run — skip
            skip_dict[i] = lead
        elif lead.get('website_url'):
            needs_enrichment.append((i, lead))
        else:
            # No website URL — nothing to do
            skip_dict[i] = lead

    total_to_enrich = len(needs_enrichment)
    print(f"\nEnrichment plan:")
    print(f"  {len(skip_dict)} leads skipped (no website_url or already have website_email)")
    print(f"  {total_to_enrich} leads queued for website enrichment")

    if total_to_enrich == 0:
        print("Nothing to enrich.")
        print(f"PROGRESS:enrich_done:0")
        return leads

    browser, context, _ = await launch_browser()
    results_dict: dict[int, dict] = dict(skip_dict)
    failed_list: list[str] = []

    try:
        batches = []
        for t in range(parallel_tabs):
            batch = needs_enrichment[t::parallel_tabs]
            if batch:
                batches.append(batch)

        print(f"Starting enrichment with {len(batches)} parallel tab(s)...\n")

        tasks = [
            _enrich_batch(context, batch, results_dict, failed_list, total_to_enrich)
            for batch in batches
        ]
        await asyncio.gather(*tasks)

    finally:
        await browser.close()

    # Rebuild ordered list
    enriched_out = [results_dict[i] for i in range(len(leads)) if i in results_dict]

    found_count = sum(1 for l in enriched_out if l.get('website_email'))
    new_found = found_count - sum(1 for l in leads if l.get('website_email'))
    print(f"\nEnrichment complete: {new_found} new website emails found out of {total_to_enrich} attempted. Failed: {len(failed_list)}")
    print(f"PROGRESS:enrich_done:{new_found}")

    if progress_callback:
        progress_callback({'stage': 'enrich', 'current': total_to_enrich, 'total': total_to_enrich, 'enriched': new_found})

    return enriched_out


def main():
    parser = argparse.ArgumentParser(description='Enrich leads with emails from company websites')
    parser.add_argument('--input', required=True, help='Path to enriched leads JSON')
    parser.add_argument('--output', default='.tmp/enriched_leads.json', help='Output path')
    parser.add_argument('--parallel', type=int, default=2, help='Number of parallel browser tabs (default: 2)')
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
