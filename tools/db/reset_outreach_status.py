#!/usr/bin/env python3
"""Reset `leads.outreach_status` to 'new' for a window of past sends.

WHY
The sending domain changed, so mail that went out from the retired one is not
a reason to leave a lead parked at 'contacted' forever. This walks
`campaign_leads.sent_at`, picks the leads whose sends all fall inside the
window, and flips them back to 'new' so the campaign wizard (which filters on
`status=new`) can pick them up again.

WHAT IT WILL NOT TOUCH
  - a lead that REPLIED in the window        -> a live conversation
  - a lead that BOUNCED in the window        -> the mailbox is dead
  - a lead also emailed AFTER the window     -> already re-touched
  - do_not_contact = true                    -> opted out
  - verification_status = 'invalid'          -> the send gate blocks it anyway
  - a lead with no address on file           -> nothing to send to
`contacted_at` is deliberately LEFT ALONE: it is the honest record of when we
last wrote, and `screenshot-cleanup.ts` reads it.

IMPORTANT — the status reset alone does NOT make these leads sendable. The
dedupe in getSentEmails() is keyed on the ADDRESS across all history, so it
would skip every one of them as 'already_contacted_in_another_campaign'. That
is what SEND_DEDUPE_SINCE (server/src/config.ts) exists for; set it to the
same date as --until-exclusive here.

USAGE
  # dry run (default) — prints exactly what would change, writes nothing
  .venv/Scripts/python.exe tools/db/reset_outreach_status.py

  # write
  .venv/Scripts/python.exe tools/db/reset_outreach_status.py --apply

  # different window / keep auto-replies parked
  .venv/Scripts/python.exe tools/db/reset_outreach_status.py \
      --since 2026-06-01 --until-exclusive 2026-08-07 --exclude-auto-replied
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import urllib.error
import urllib.request

# Statuses on campaign_leads that mean an email really left the building.
SENT_STATUSES = ("sent", "opened", "replied", "auto_replied", "bounced")

# Outcomes that permanently disqualify a lead from being re-approached.
# 'auto_replied' is NOT here — an unmonitored support inbox is not a
# conversation — but it can be added back with --exclude-auto-replied.
BLOCKING_OUTCOMES = ("replied", "bounced")

# Worst-outcome ranking, so a lead with several sends is judged on its most
# serious one rather than whichever row happened to come back last.
OUTCOME_RANK = {"opened": 1, "sent": 1, "auto_replied": 2, "replied": 3, "bounced": 4}

CHUNK = 100  # PostgREST `in.()` URL-length ceiling; 150 is the documented max


def load_env() -> tuple[str, str]:
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    env: dict[str, str] = {}
    with open(os.path.join(root, ".env"), encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    url = env.get("SUPABASE_URL", "")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        sys.exit("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env")
    return url.rstrip("/"), key


def rest(url: str, key: str, path: str, method: str = "GET", body=None, prefer=None):
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{url}/rest/v1/{path}", headers=headers, method=method, data=data)
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else []
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} -> HTTP {e.code}: {e.read().decode()[:400]}")


def paged(url: str, key: str, path: str) -> list[dict]:
    """PostgREST caps a response at 1000 rows — always page."""
    out: list[dict] = []
    offset = 0
    while True:
        batch = rest(url, key, f"{path}&limit=1000&offset={offset}")
        out += batch
        if len(batch) < 1000:
            return out
        offset += 1000


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", default="2026-06-01", help="window start, inclusive (YYYY-MM-DD)")
    ap.add_argument("--until-exclusive", default="2026-08-07",
                    help="window end, EXCLUSIVE — 2026-08-07 means 'through 6 August'")
    ap.add_argument("--exclude-auto-replied", action="store_true",
                    help="also leave leads that sent an automated reply parked at 'contacted'")
    ap.add_argument("--apply", action="store_true", help="write the changes (default is a dry run)")
    args = ap.parse_args()

    url, key = load_env()
    blocking = set(BLOCKING_OUTCOMES) | ({"auto_replied"} if args.exclude_auto_replied else set())

    rows = paged(url, key, "campaign_leads?select=lead_id,email_used,status,sent_at"
                           f"&status=in.({','.join(SENT_STATUSES)})&sent_at=not.is.null")
    print(f"campaign_leads rows with a real send : {len(rows)}")

    worst: dict[str, str] = {}
    touched_after: set[str] = set()
    for r in rows:
        lid, day = r.get("lead_id"), (r.get("sent_at") or "")[:10]
        if not lid:
            continue
        if day >= args.until_exclusive:
            touched_after.add(lid)
        elif day >= args.since:
            if OUTCOME_RANK.get(r["status"], 0) > OUTCOME_RANK.get(worst.get(lid, ""), 0):
                worst[lid] = r["status"]

    in_window = set(worst)
    print(f"leads emailed {args.since} .. before {args.until_exclusive} : {len(in_window)}")
    print(f"  ...also emailed on/after {args.until_exclusive}: {len(in_window & touched_after)}")

    candidates = sorted(in_window - touched_after)
    leads: dict[str, dict] = {}
    for i in range(0, len(candidates), CHUNK):
        sel = ("leads?select=id,company_name,country,primary_email,outreach_status,"
               "verification_status,do_not_contact")
        for l in paged(url, key, f"{sel}&id=in.({','.join(candidates[i:i + CHUNK])})"):
            leads[l["id"]] = l

    keep, skipped = [], collections.Counter()
    for lid in candidates:
        lead = leads.get(lid)
        if lead is None:
            skipped["lead row not found"] += 1
        elif worst[lid] in blocking:
            skipped[f"{worst[lid]} in window"] += 1
        elif lead["do_not_contact"]:
            skipped["do_not_contact"] += 1
        elif lead["verification_status"] == "invalid":
            skipped["verified invalid"] += 1
        elif not lead["primary_email"]:
            skipped["no address on file"] += 1
        elif lead["outreach_status"] == "new":
            skipped["already 'new'"] += 1
        else:
            keep.append(lid)

    print("\nexcluded:")
    for reason, n in skipped.most_common():
        print(f"  {reason:24s} {n}")
    print(f"\n--> WILL RESET TO 'new': {len(keep)} leads")
    if keep:
        by_status = collections.Counter(leads[i]["outreach_status"] for i in keep)
        by_verdict = collections.Counter(str(leads[i]["verification_status"]) for i in keep)
        by_country = collections.Counter(str(leads[i]["country"]) for i in keep)
        print(f"    from status : {dict(by_status)}")
        print(f"    verdicts    : {dict(by_verdict)}")
        print(f"    top markets : {dict(by_country.most_common(8))}")
        print("    sample      : " + ", ".join(
            f"{leads[i]['company_name']} ({leads[i]['country']})" for i in keep[:5]))

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply to commit.")
        return
    if not keep:
        print("\nNothing to do.")
        return

    written = 0
    for i in range(0, len(keep), CHUNK):
        batch = keep[i:i + CHUNK]
        res = rest(url, key, f"leads?id=in.({','.join(batch)})", method="PATCH",
                   body={"outreach_status": "new"}, prefer="return=representation")
        written += len(res)
        print(f"  patched {written}/{len(keep)}")

    still = paged(url, key, "leads?select=id&outreach_status=neq.new"
                            f"&id=in.({','.join(keep[:CHUNK])})")
    print(f"\nWROTE {written} leads -> outreach_status='new'")
    print(f"verification: {len(still)} of the first {min(CHUNK, len(keep))} are still not 'new' (expect 0)")
    print("\nREMINDER: set SEND_DEDUPE_SINCE=" + args.until_exclusive
          + " on Cloud Run, or the address dedupe will skip every one of these.")


if __name__ == "__main__":
    main()
