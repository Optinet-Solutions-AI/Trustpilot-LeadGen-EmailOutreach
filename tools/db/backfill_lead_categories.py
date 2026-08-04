"""Backfill `leads.category` onto its canonical form. DRY RUN BY DEFAULT.

    # look, change nothing (safe, read-only):
    .venv/Scripts/python.exe tools/db/backfill_lead_categories.py

    # actually write:
    .venv/Scripts/python.exe tools/db/backfill_lead_categories.py --apply

What it touches
---------------
ONLY rows whose current label is an explicitly-declared alias in
tools/db/category_canonical.py (e.g. `plumbers` -> `plumber`). A value that
merely needs slugifying, or one that has no declared family, is reported but
NEVER written — nothing gets re-labelled on a guess.

Why it is optional
------------------
The API filter is already family-aware, so the operator can find every one of
these rows without migrating them. This script only exists to make the stored
data tidy; skipping it costs nothing but tidiness.
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from tools.db.category_canonical import (  # noqa: E402
    ALIAS_TO_CANONICAL,
    canonicalize_category,
    slugify_category,
)
from tools.db.supabase_client import table  # noqa: E402

PAGE_SIZE = 1000


def fetch_category_counts() -> Counter[str | None]:
    """Read every lead's category, paginating past PostgREST's 1000-row cap."""
    counts: Counter[str | None] = Counter()
    offset = 0
    while True:
        result = (
            table('leads')
            .select('category')
            .range(offset, offset + PAGE_SIZE - 1)
            .execute()
        )
        rows = result.data or []
        if not rows:
            break
        for row in rows:
            counts[row.get('category')] += 1
        if len(rows) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return counts


def plan_changes(counts: Counter[str | None]) -> tuple[list[tuple[str, str, int]], list[tuple[str, str, int]]]:
    """Split the inventory into (safe rewrites, reported-but-skipped).

    A rewrite is safe only when the stored value is a declared family alias.
    Everything else — unknown labels, labels that would only change by
    slugification — is returned in the second list for visibility and is left
    alone.
    """
    rewrites: list[tuple[str, str, int]] = []
    skipped: list[tuple[str, str, int]] = []
    for value, count in counts.items():
        if value is None:
            continue
        canonical = canonicalize_category(value)
        if canonical is None or canonical == value:
            continue
        if slugify_category(value) in ALIAS_TO_CANONICAL:
            rewrites.append((value, canonical, count))
        else:
            skipped.append((value, canonical, count))
    rewrites.sort(key=lambda r: (-r[2], r[0]))
    skipped.sort(key=lambda r: (-r[2], r[0]))
    return rewrites, skipped


def apply_rewrite(from_value: str, to_value: str) -> int:
    """UPDATE every row holding `from_value`. Returns rows written."""
    result = (
        table('leads')
        .update({'category': to_value})
        .eq('category', from_value)
        .execute()
    )
    return len(result.data) if result.data else 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Canonicalise leads.category (dry run unless --apply).',
    )
    parser.add_argument(
        '--apply',
        action='store_true',
        help='Actually write the changes. Without this flag nothing is modified.',
    )
    args = parser.parse_args()

    mode = 'APPLY (writing)' if args.apply else 'DRY RUN (no writes)'
    print(f"=== leads.category canonicalisation - {mode} ===")

    counts = fetch_category_counts()
    total_rows = sum(counts.values())
    print(f"Scanned {total_rows} leads, {len(counts)} distinct category values "
          f"({counts.get(None, 0)} with no category).")

    rewrites, skipped = plan_changes(counts)

    if not rewrites:
        print("\nNothing to change - every value is already canonical.")
        return 0

    by_target: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for from_value, to_value, count in rewrites:
        by_target[to_value].append((from_value, count))

    print(f"\n{len(rewrites)} label(s) would be rewritten, "
          f"{sum(r[2] for r in rewrites)} row(s) affected, "
          f"in {len(by_target)} family(ies):\n")
    print(f"  {'FROM':<28} {'TO':<20} {'ROWS':>6}")
    print(f"  {'-' * 28} {'-' * 20} {'-' * 6}")
    for to_value in sorted(by_target, key=lambda t: -sum(c for _, c in by_target[t])):
        members = sorted(by_target[to_value], key=lambda m: -m[1])
        subtotal = sum(c for _, c in members)
        for from_value, count in members:
            print(f"  {from_value:<28} {to_value:<20} {count:>6}")
        if len(members) > 1:
            print(f"  {'':<28} {'  = ' + to_value:<20} {subtotal:>6}")
    print(f"\n  {'TOTAL':<28} {'':<20} {sum(r[2] for r in rewrites):>6}")

    if skipped:
        print(f"\nReported but NOT touched ({len(skipped)} label(s)) - no declared "
              f"family, so canonicalising them would be a guess:\n")
        for from_value, canonical, count in skipped:
            print(f"  {from_value!r:<30} (would slugify to {canonical!r}, {count} rows)")

    if not args.apply:
        print("\nDRY RUN - nothing was written. Re-run with --apply to commit "
              "the rewrites above.")
        return 0

    print("\nApplying...")
    written = 0
    for from_value, to_value, expected in rewrites:
        try:
            n = apply_rewrite(from_value, to_value)
            written += n
            flag = '' if n == expected else f"  (expected {expected})"
            print(f"  {from_value} -> {to_value}: {n} rows{flag}")
        except Exception as exc:  # noqa: BLE001 — report and keep going
            print(f"  FAILED {from_value} -> {to_value}: {str(exc)[:200]}")
    print(f"\nDone. {written} row(s) rewritten.")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
