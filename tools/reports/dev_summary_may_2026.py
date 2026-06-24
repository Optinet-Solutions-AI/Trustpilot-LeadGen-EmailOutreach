"""
Monthly DEVELOPMENT summary — narrative of engineering work shipped in
May 2026 (curated from git history, not Supabase data).

Mirrors the April 2026 report style: headline bullets, numbered themed
sections, end-of-month status table.

Usage:
  .venv/Scripts/python.exe tools/reports/dev_summary_may_2026.py
"""

import os
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable,
)

# ── Styles (match April report: blue headings on white) ──────────────────────
styles = getSampleStyleSheet()
BLUE = colors.HexColor("#1f3a93")
TITLE = ParagraphStyle("DTitle", parent=styles["Title"], fontSize=26,
                       textColor=BLUE, spaceAfter=4, alignment=1)
SUB = ParagraphStyle("DSub", parent=styles["Normal"], fontSize=10.5,
                     textColor=colors.HexColor("#555555"), alignment=1,
                     spaceAfter=10)
H1 = ParagraphStyle("DH1", parent=styles["Heading1"], fontSize=13.5,
                    textColor=BLUE, spaceBefore=14, spaceAfter=6)
BODY = ParagraphStyle("DBody", parent=styles["Normal"], fontSize=10,
                      textColor=colors.HexColor("#1e293b"), leading=14)
BULLET = ParagraphStyle("DBullet", parent=BODY, leftIndent=14,
                        bulletIndent=4, spaceAfter=3, leading=13.5)
MUTED = ParagraphStyle("DMuted", parent=BODY, fontSize=9,
                       textColor=colors.HexColor("#64748b"))


def rule():
    return HRFlowable(width="100%", thickness=0.6,
                      color=colors.HexColor("#cbd5e1"),
                      spaceBefore=8, spaceAfter=8)


def bullets(items, story):
    for it in items:
        story.append(Paragraph(it, BULLET, bulletText="•"))


def section(num, title, items, story):
    story.append(Paragraph(f"{num}. {title}", H1))
    bullets(items, story)


# ── Content ──────────────────────────────────────────────────────────────────

def build():
    out_path = os.path.abspath(os.path.join(
        os.path.dirname(__file__), "..", "..", ".tmp",
        "Monthly_Report_May_2026.pdf"))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    doc = SimpleDocTemplate(
        out_path, pagesize=LETTER,
        leftMargin=0.85 * inch, rightMargin=0.85 * inch,
        topMargin=0.8 * inch, bottomMargin=0.7 * inch,
        title="Monthly Summary Report — May 2026", author="OptiRate")

    story = []
    story.append(Paragraph("Monthly Summary Report", TITLE))
    story.append(Paragraph(
        "Multi-Platform Lead Gen &amp; CRM Email Outreach &nbsp;·&nbsp; "
        "May 2026 &nbsp;·&nbsp; 365 commits", SUB))
    story.append(rule())

    # ── Headlines ──
    story.append(Paragraph("Headlines", H1))
    bullets([
        "<b>Went multi-platform.</b> The scraper stopped being Trustpilot-only "
        "— shipped working <b>TripAdvisor</b> and <b>Yelp</b> plugins behind the "
        "<i>BasePlatformScraper</i> contract, then laid the full foundation for "
        "<b>Facebook &amp; Instagram</b> (login, cookie vault, group-first consumer scraping).",
        "<b>Database generalized for many platforms.</b> Migration 032 replaced the "
        "Trustpilot-shaped taxonomy with <i>platform_categories</i> / <i>platform_countries</i>; "
        "migration 039 added the social-platform schema (<i>social_accounts</i>, "
        "<i>lead_platform_posts</i>, attribution columns).",
        "<b>Full mobile-responsive frontend.</b> Every page — dashboard, leads, pipeline, "
        "wizard, inbox, prospects — rebuilt to work on phones with an off-canvas sidebar, "
        "bottom sheets, and card views.",
        "<b>Deeper email infrastructure.</b> Per-account warmup ramps, a colleague-network "
        "warmup pool, DNS health gates (MX/SPF/DMARC/DKIM), AI follow-ups in the lead's own "
        "language, and a hardened scheduler after a double-send incident.",
        "<b>Verification &amp; enrichment extended.</b> Added MillionVerifier (Stage 6) and "
        "Hunter.io (Stage 7 verify + Tier 9 enrich), plus Wayback and crt.sh discovery tiers.",
    ], story)
    story.append(rule())

    section("1", "Multi-Platform Scraper — TripAdvisor &amp; Yelp (May 13–20)", [
        "Generalized the data model (migration 032): dynamic Trustpilot taxonomy with "
        "searchable category/country pickers, backed by <i>platform_categories</i> / "
        "<i>platform_countries</i>.",
        "<b>TripAdvisor</b>: country/category fan-out across a seeded <i>tripadvisor_cities</i> "
        "table (country → geo-ID map, one-time seeder, hybrid 2-pass walk), with a pre-scrape "
        "cost advisory and confirm gate.",
        "<b>Yelp</b>: new plugin using Yelp Fusion API for listings + ScrapingBee "
        "<i>stealth_proxy</i> for profile enrichment; seed expanded to 13 markets.",
        "<b>Performance</b>: cut TripAdvisor + Yelp credit/time spend by ~80% and capped "
        "TripAdvisor profile enrichment to the top-25 by quality.",
        "Platform-aware UI throughout: jobs-table redesign, correct Target/Rating columns, "
        "and progress-event stage names aligned across all platforms.",
    ], story)

    section("2", "Social Platform Foundation — Facebook &amp; Instagram (May 18–29)", [
        "Scaffolded the <i>SocialPlatformScraper</i> contract and shipped migration 039 "
        "(social schema: <i>social_accounts</i>, <i>lead_platform_posts</i>, post-author attribution).",
        "<b>Account security</b>: AES-256-GCM cookie encryption + session store, operator-driven "
        "login with checkpoint/captcha recovery flows, and a global captcha-checkpoint banner.",
        "<b>FacebookScraper + InstagramScraper</b> plugins with <i>search-posts</i> / "
        "<i>enrich-authors</i> actions; group-first consumer scraping that captures the post author "
        "as the DM target.",
        "<b>Lead quality</b>: STRONG_BUSINESS_PATTERNS, group-name/recruiter/job-listing filters, "
        "and a Gemini LLM classifier as the final consumer-vs-business gate.",
        "<b>Anti-detection</b>: routed Linux FB Chrome through a residential proxy via selenium-wire "
        "(Manifest-V2 auth workaround for Chrome 128+), TLS/MITM fixes, and EC2 headless flags.",
        "Frontend: Facebook scrape form (consumer/business modes), combobox LocationPicker with "
        "Europe + US city coverage, and FB/IG entries in the Lead Matrix nav.",
    ], story)

    section("3", "Mobile-Responsive Frontend Overhaul (May 11)", [
        "Converted the sidebar to an off-canvas drawer below <i>lg</i>, added a mobile hamburger "
        "top-bar, and a <i>MobileBottomSheet</i> primitive for dropdowns and filters.",
        "Card views for Leads, Pipeline, Prospects and Redirected Leads on small screens; "
        "responsive layouts for the dashboard, analytics, campaigns and the full campaign wizard.",
        "iOS Safari fixes: viewport meta, stopped focus-zoom on inputs, and a <i>useIsMobile</i> hook "
        "+ <i>UIContext</i> for drawer state with scroll-lock and ESC-close.",
        "Added a per-day Sent + Replied chart to Analytics for reporting.",
    ], story)

    section("4", "Email Deliverability, Warmup &amp; Reliability (May 3–29)", [
        "Per-account warmup ramp + multi-provider warmup pool and a dedicated Warmup Peers page "
        "with a pipeline-snapshot card.",
        "<b>Colleague-network warmup scheduler</b> that keeps internal traffic flowing even while "
        "cold outreach is paused; daily volume ramp + per-sender recipient rotation.",
        "DNS health checker with a pre-send gate on sender domains (MX/SPF/DMARC, then DKIM badges).",
        "<b>Incident response</b>: closed a scheduler race that double-sent follow-ups, added the "
        "<i>EMAIL_SENDING_PAUSED_UNTIL</i> kill switch, and a monitor email-alert channel.",
        "Hardening: fixed BATCH_LIMIT starvation from orphan rows, marked dedup-skipped leads as "
        "<i>skipped</i> rather than stuck <i>pending</i>.",
    ], story)

    section("5", "Verification &amp; Enrichment Pipeline (May 5–6)", [
        "<b>MillionVerifier</b> added as Stage 6 fallback after ZeroBounce; <b>Hunter.io</b> as a "
        "Stage 7 last-resort verifier <i>and</i> a Tier 9 domain-search enrichment, both with cost guards.",
        "New discovery tiers: Tier 7 (Wayback Machine) and Tier 8 (crt.sh certificate transparency).",
        "Multi-tier Cloudflare bypass, bot-protection detection, and redirect-follow in the enricher; "
        "RFC-correct DNS check with A-record fallback and CDN detection.",
        "Verdict broadcast across every source holding the same address, with resolver-source tracking "
        "so lead-level status mirrors the chosen <i>primary_email</i>.",
        "Lateral prospecting tier + <i>affiliate_email</i> column; a dedicated Redirected-Leads workflow "
        "and page.",
    ], story)

    section("6", "Prospects, Auto-Reply Discovery &amp; Inbox (May 7, 25–26)", [
        "Auto-reply handling with a Prospects view and a discovery follow-up campaign; user-driven "
        "promotion of inbox replies into prospects.",
        "Inbox v2: fanned the Sent folder into one row per send, threaded follow-ups, bidirectional "
        "search sync, and a resync button for fresh thread fetches.",
        "Per-message Gemini translation toggle; quoted-reply history collapsed behind a "
        "&lsquo;Show quoted content&rsquo; toggle / styled blockquote.",
        "IMAP reply-body capture + on-demand fetch, Gmail-OAuth sender support, and read-only thread "
        "history for paused mailboxes.",
        "LeadDetail render hardening: per-section loading + retry, global timeout, and a Cloud Run "
        "warm-up ping.",
    ], story)

    section("7", "AI &amp; Multi-Language Outreach (May 8, 13, 15)", [
        "Follow-up emails auto-generated by AI in the lead&rsquo;s country language, on add.",
        "Expanded the AI language map so Austria and other non-English countries auto-translate; "
        "stopped the AI from naming the recipient&rsquo;s country in templates.",
        "Tightened the cold-email prompt (locked length + spintax-grammar guard).",
    ], story)

    section("8", "Nightly Scheduler &amp; EC2 Worker Queue (May 12, 18)", [
        "Supabase job queue + a Singapore EC2 scraper-worker, with a self-deploying 5-minute cron "
        "(<i>scripts/deploy-ec2.sh</i>).",
        "Nightly scheduler with eligibility lookup, auto-pause after 3 consecutive failures, a "
        "30-minute wall-clock cap on stuck jobs, and manual/nightly source tagging.",
        "<i>app_settings</i> layer with read-time value clamping; gated auto-URL extraction from "
        "auto-replies behind <i>AUTO_QUEUE_URLS_FROM_REPLIES</i> (off by default).",
        "Worker now passes platform + filters through to <i>runScrapeJob</i> so non-Trustpilot leads "
        "land with the right country/category.",
    ], story)

    section("9", "Trustpilot Claimed-Status &amp; Screenshots (May 3–4, 26)", [
        "&lsquo;Check Claimed&rsquo; action (per-lead + bulk) that reads canonical claim status from "
        "<i>__NEXT_DATA__</i> and survives the WAF &lsquo;Verifying Connection&rsquo; wall.",
        "Backfilled Trustpilot screenshots for leads missing them; clickable screenshot tiles with "
        "loading/error states and a &lsquo;View live Trustpilot&rsquo; empty-state fallback.",
    ], story)

    story.append(rule())

    # ── End-of-month status table ──
    story.append(Paragraph("Status at end of month (May 29)", H1))
    rows = [
        ["Area", "State"],
        ["Review platforms", "Trustpilot, TripAdvisor, Yelp live behind the plugin contract."],
        ["Social platforms", "FB/IG foundation shipped; operator login + group-first scrape working."],
        ["Frontend", "Fully responsive across desktop and mobile."],
        ["Email sending", "Paused on the kill switch after the double-send fix; warmup pool still running."],
        ["Verification", "9-tier enrich + ZeroBounce → MillionVerifier → Hunter verify chain."],
        ["Outstanding", "Re-enable cold sending after claim-lock re-applied; deepen social lead quality."],
    ]
    t = Table(rows, colWidths=[1.5 * inch, 5.0 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BLUE),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1),
         [colors.white, colors.HexColor("#f1f5f9")]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(t)

    story.append(Spacer(1, 0.25 * inch))
    story.append(rule())
    story.append(Paragraph(
        "Generated 2026-05-29 &nbsp;·&nbsp; OptiRate / Optinet Solutions", MUTED))

    doc.build(story)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    build()
