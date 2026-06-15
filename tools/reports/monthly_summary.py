"""
Monthly summary report — pulls Supabase data for a given month and
renders a PDF at report-YYYY-MM.pdf.

Usage:
  .venv/Scripts/python.exe tools/reports/monthly_summary.py            # current month
  .venv/Scripts/python.exe tools/reports/monthly_summary.py 2026-05    # specific month
"""

import os
import sys
from collections import Counter
from datetime import datetime, timezone
from calendar import monthrange

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from tools.db.supabase_client import table  # noqa: E402


# ── Time range ─────────────────────────────────────────────────────────────

def month_bounds(arg: str | None):
    """Return (start_iso, end_iso, label) for the requested YYYY-MM (or current)."""
    today = datetime.now(timezone.utc)
    if arg:
        y, m = (int(x) for x in arg.split("-"))
    else:
        y, m = today.year, today.month
    start = datetime(y, m, 1, tzinfo=timezone.utc)
    last_day = monthrange(y, m)[1]
    end = datetime(y, m, last_day, 23, 59, 59, 999_999, tzinfo=timezone.utc)
    label = start.strftime("%B %Y")
    return start.isoformat(), end.isoformat(), label, y, m


# ── Supabase helpers ───────────────────────────────────────────────────────

def fetch_all(query, page_size=1000):
    """Page through PostgREST results — single .range() caps at 1000 rows."""
    rows, offset = [], 0
    while True:
        batch = query.range(offset, offset + page_size - 1).execute().data or []
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    return rows


def counts_by(rows, key):
    c = Counter()
    for r in rows:
        v = r.get(key) or "—"
        c[v] += 1
    return c


# ── Section builders ───────────────────────────────────────────────────────

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1Section", parent=styles["Heading1"],
                   fontSize=18, textColor=colors.HexColor("#0f172a"),
                   spaceAfter=10)
H2 = ParagraphStyle("H2Section", parent=styles["Heading2"],
                   fontSize=13, textColor=colors.HexColor("#334155"),
                   spaceBefore=14, spaceAfter=6)
BODY = ParagraphStyle("Body", parent=styles["Normal"],
                     fontSize=10, textColor=colors.HexColor("#1e293b"),
                     leading=14)
MUTED = ParagraphStyle("Muted", parent=BODY,
                      textColor=colors.HexColor("#64748b"), fontSize=9)
KPI_LABEL = ParagraphStyle("KpiLabel", parent=BODY, fontSize=8,
                          textColor=colors.HexColor("#64748b"),
                          alignment=1)
KPI_VALUE = ParagraphStyle("KpiValue", parent=BODY, fontSize=20,
                          textColor=colors.HexColor("#0f172a"),
                          alignment=1, leading=22)


def kpi_row(items):
    """items = [(label, value), ...]. Returns a Table."""
    cells = []
    for label, value in items:
        cells.append([
            Paragraph(str(value), KPI_VALUE),
            Paragraph(label, KPI_LABEL),
        ])
    # Transpose into a single-row table where each column is one KPI
    row = []
    for label, value in items:
        row.append([Paragraph(str(value), KPI_VALUE),
                    Paragraph(label, KPI_LABEL)])
    t = Table([row], colWidths=[1.4 * inch] * len(items))
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    return t


def data_table(headers, rows, col_widths=None):
    data = [headers] + rows
    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1),
         [colors.white, colors.HexColor("#f8fafc")]),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def counter_to_rows(counter, limit=None):
    items = counter.most_common(limit)
    return [[str(k), str(v)] for k, v in items]


def pct(n, d):
    return f"{(n / d * 100):.1f}%" if d else "—"


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    start_iso, end_iso, label, year, month = month_bounds(arg)
    print(f"Building monthly summary for {label} ({start_iso} -> {end_iso})")

    # ── Leads created this month ───────────────────────────────────────────
    leads = fetch_all(
        table("leads").select(
            "id,company_name,country,category,star_rating,"
            "outreach_status,verification_status,primary_email,"
            "website_email,trustpilot_email,created_at,lead_source"
        ).gte("created_at", start_iso).lte("created_at", end_iso)
    )

    # ── Lead presences scraped this month (multi-platform) ─────────────────
    presences = fetch_all(
        table("lead_platform_presences").select(
            "lead_id,platform,scraped_at"
        ).gte("scraped_at", start_iso).lte("scraped_at", end_iso)
    )

    # ── Status changes in lead_notes this month ────────────────────────────
    status_changes = fetch_all(
        table("lead_notes").select(
            "lead_id,type,content,metadata,created_at"
        ).eq("type", "status_change")
         .gte("created_at", start_iso).lte("created_at", end_iso)
    )

    # ── Follow-ups completed this month ────────────────────────────────────
    follow_ups = fetch_all(
        table("follow_ups").select("id,completed,completed_at")
         .eq("completed", True)
         .gte("completed_at", start_iso).lte("completed_at", end_iso)
    )

    # ── Campaigns created this month ───────────────────────────────────────
    campaigns = fetch_all(
        table("campaigns").select(
            "id,name,status,total_sent,total_opened,total_replied,"
            "total_bounced,created_at,sent_at"
        ).gte("created_at", start_iso).lte("created_at", end_iso)
    )

    # ── Campaign_leads activity this month (sends) ─────────────────────────
    sends = fetch_all(
        table("campaign_leads").select(
            "campaign_id,lead_id,status,sender_email,sent_at,"
            "opened_at,replied_at,bounced_at"
        ).gte("sent_at", start_iso).lte("sent_at", end_iso)
    )

    # ── Scrape jobs this month ─────────────────────────────────────────────
    jobs = fetch_all(
        table("scrape_jobs").select(
            "id,platform,country,category,status,total_scraped,"
            "total_enriched,created_at"
        ).gte("created_at", start_iso).lte("created_at", end_iso)
    )

    # ── Build the PDF ──────────────────────────────────────────────────────
    out_dir = os.path.join(os.path.dirname(__file__), "..", "..", ".tmp", "reports")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.abspath(
        os.path.join(out_dir, f"report-{year:04d}-{month:02d}.pdf")
    )

    doc = SimpleDocTemplate(
        out_path,
        pagesize=LETTER,
        leftMargin=0.7 * inch, rightMargin=0.7 * inch,
        topMargin=0.7 * inch, bottomMargin=0.7 * inch,
        title=f"OptiRate Monthly Summary — {label}",
        author="OptiRate",
    )
    story = []

    # ─── Cover ────────────────────────────────────────────────────────────
    cover_title = ParagraphStyle(
        "CoverTitle", parent=H1, fontSize=32, leading=36,
        textColor=colors.HexColor("#0f172a"), spaceAfter=4)
    cover_sub = ParagraphStyle(
        "CoverSub", parent=BODY, fontSize=14,
        textColor=colors.HexColor("#475569"), spaceAfter=24)
    brand = ParagraphStyle(
        "Brand", parent=BODY, fontSize=10,
        textColor=colors.HexColor("#0ea5e9"))

    story.append(Spacer(1, 1.2 * inch))
    story.append(Paragraph("OptiRate", brand))
    story.append(Spacer(1, 6))
    story.append(Paragraph("Monthly Summary", cover_title))
    story.append(Paragraph(label, cover_sub))
    story.append(Paragraph(
        "Lead generation, pipeline activity, and email campaign performance "
        "across all connected platforms.", BODY))
    story.append(Spacer(1, 0.3 * inch))
    story.append(Paragraph(
        f"Generated {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        MUTED))

    # ─── Executive summary ────────────────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Executive Summary", H1))

    total_sent = len([s for s in sends if s.get("sent_at")])
    total_opened = len([s for s in sends if s.get("opened_at")])
    total_replied = len([s for s in sends if s.get("replied_at")])
    total_bounced = len([s for s in sends if s.get("bounced_at")])
    verified_valid = len([l for l in leads if l.get("verification_status") == "valid"])

    story.append(Spacer(1, 8))
    story.append(kpi_row([
        ("New leads", len(leads)),
        ("Verified emails", verified_valid),
        ("Emails sent", total_sent),
        ("Replies", total_replied),
    ]))
    story.append(Spacer(1, 12))
    story.append(kpi_row([
        ("Platform scrapes", len(presences)),
        ("Campaigns created", len(campaigns)),
        ("Open rate", pct(total_opened, total_sent)),
        ("Reply rate", pct(total_replied, total_sent)),
    ]))

    # ─── Lead generation ──────────────────────────────────────────────────
    story.append(Spacer(1, 0.3 * inch))
    story.append(Paragraph("Lead Generation", H1))

    story.append(Paragraph("By platform (presence records)", H2))
    plat_counts = counts_by(presences, "platform")
    if plat_counts:
        story.append(data_table(
            ["Platform", "Leads scraped"],
            counter_to_rows(plat_counts),
            col_widths=[3 * inch, 1.5 * inch]))
    else:
        story.append(Paragraph("No platform scrapes recorded this month.", MUTED))

    story.append(Paragraph("Top countries", H2))
    country_counts = counts_by(leads, "country")
    if country_counts:
        story.append(data_table(
            ["Country", "New leads"],
            counter_to_rows(country_counts, limit=10),
            col_widths=[3 * inch, 1.5 * inch]))
    else:
        story.append(Paragraph("No new leads recorded this month.", MUTED))

    story.append(Paragraph("Top categories", H2))
    cat_counts = counts_by(leads, "category")
    if cat_counts:
        story.append(data_table(
            ["Category", "New leads"],
            counter_to_rows(cat_counts, limit=10),
            col_widths=[3 * inch, 1.5 * inch]))
    else:
        story.append(Paragraph("No categories recorded.", MUTED))

    story.append(Paragraph("Email verification status", H2))
    verif_counts = counts_by(leads, "verification_status")
    leads_with_email = len([l for l in leads if l.get("primary_email")])
    rows = counter_to_rows(verif_counts)
    rows.append(["Leads with a primary email", str(leads_with_email)])
    story.append(data_table(
        ["Status", "Count"], rows, col_widths=[3 * inch, 1.5 * inch]))

    # ─── Pipeline / CRM activity ──────────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Pipeline & CRM Activity", H1))

    story.append(Paragraph("Outreach status of new leads", H2))
    outreach_counts = counts_by(leads, "outreach_status")
    story.append(data_table(
        ["Status", "Count"],
        counter_to_rows(outreach_counts),
        col_widths=[3 * inch, 1.5 * inch]))

    story.append(Paragraph("Status changes recorded this month", H2))
    # metadata.to gives the new status if recorded; otherwise we can only count totals
    transition_counts = Counter()
    for n in status_changes:
        meta = n.get("metadata") or {}
        if isinstance(meta, dict):
            to = meta.get("to") or meta.get("new") or "—"
            transition_counts[to] += 1
    if transition_counts:
        story.append(data_table(
            ["Moved to", "Count"],
            counter_to_rows(transition_counts),
            col_widths=[3 * inch, 1.5 * inch]))
    else:
        story.append(Paragraph(
            f"{len(status_changes)} status-change entries logged "
            "(no destination metadata available to break down).", MUTED))

    story.append(Paragraph("Follow-ups completed", H2))
    story.append(Paragraph(f"{len(follow_ups)} follow-up tasks marked done.", BODY))

    # ─── Email campaigns ──────────────────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Email Campaigns", H1))

    story.append(Paragraph("Campaigns created this month", H2))
    if campaigns:
        rows = []
        for c in campaigns:
            rows.append([
                (c.get("name") or "")[:40],
                c.get("status") or "",
                str(c.get("total_sent") or 0),
                str(c.get("total_opened") or 0),
                str(c.get("total_replied") or 0),
                str(c.get("total_bounced") or 0),
            ])
        story.append(data_table(
            ["Campaign", "Status", "Sent", "Open", "Reply", "Bounce"],
            rows,
            col_widths=[2.4 * inch, 0.9 * inch, 0.6 * inch,
                        0.6 * inch, 0.7 * inch, 0.7 * inch]))
    else:
        story.append(Paragraph("No campaigns created this month.", MUTED))

    story.append(Paragraph("Send activity (campaign_leads this month)", H2))
    story.append(kpi_row([
        ("Sent", total_sent),
        ("Opened", total_opened),
        ("Replied", total_replied),
        ("Bounced", total_bounced),
    ]))
    story.append(Spacer(1, 10))
    story.append(Paragraph(
        f"Open rate {pct(total_opened, total_sent)} · "
        f"Reply rate {pct(total_replied, total_sent)} · "
        f"Bounce rate {pct(total_bounced, total_sent)}", BODY))

    story.append(Paragraph("Per sending account", H2))
    by_sender = {}
    for s in sends:
        addr = s.get("sender_email") or "(unattributed)"
        d = by_sender.setdefault(addr, {"sent": 0, "open": 0, "reply": 0, "bounce": 0})
        if s.get("sent_at"):    d["sent"] += 1
        if s.get("opened_at"):  d["open"] += 1
        if s.get("replied_at"): d["reply"] += 1
        if s.get("bounced_at"): d["bounce"] += 1
    if by_sender:
        rows = []
        for addr, d in sorted(by_sender.items(), key=lambda x: -x[1]["sent"]):
            rows.append([
                addr[:34],
                str(d["sent"]), str(d["open"]), str(d["reply"]),
                str(d["bounce"]), pct(d["open"], d["sent"]),
                pct(d["reply"], d["sent"]),
            ])
        story.append(data_table(
            ["Sender", "Sent", "Open", "Reply", "Bounce", "Open %", "Reply %"],
            rows,
            col_widths=[2.1 * inch, 0.55 * inch, 0.55 * inch, 0.6 * inch,
                        0.65 * inch, 0.65 * inch, 0.7 * inch]))
    else:
        story.append(Paragraph("No sends attributed this month.", MUTED))

    # ─── Scrape jobs ──────────────────────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Scrape Jobs", H1))
    story.append(Paragraph("Jobs created this month", H2))
    if jobs:
        job_status = counts_by(jobs, "status")
        story.append(data_table(
            ["Status", "Count"],
            counter_to_rows(job_status),
            col_widths=[3 * inch, 1.5 * inch]))
        story.append(Spacer(1, 10))
        story.append(Paragraph("By platform", H2))
        story.append(data_table(
            ["Platform", "Jobs"],
            counter_to_rows(counts_by(jobs, "platform")),
            col_widths=[3 * inch, 1.5 * inch]))
        total_scraped = sum(j.get("total_scraped") or 0 for j in jobs)
        total_enriched = sum(j.get("total_enriched") or 0 for j in jobs)
        story.append(Spacer(1, 10))
        story.append(Paragraph(
            f"Across all jobs: {total_scraped} rows scraped, "
            f"{total_enriched} enriched.", BODY))
    else:
        story.append(Paragraph("No scrape jobs created this month.", MUTED))

    # ─── Footer ───────────────────────────────────────────────────────────
    story.append(Spacer(1, 0.4 * inch))
    story.append(Paragraph(
        "Report data pulled from Supabase. "
        "Time range is UTC; date filters use record created_at / sent_at / "
        "scraped_at / completed_at fields as appropriate.", MUTED))

    doc.build(story)
    print(f"Wrote {out_path}")
    return out_path


if __name__ == "__main__":
    main()
