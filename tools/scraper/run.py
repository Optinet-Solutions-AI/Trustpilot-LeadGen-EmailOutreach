"""
Unified scraper entry point — dispatches to the platform plugin
registered in tools.scraper.platforms.

Replaces the platform-specific spawn shape (scrape_category.py,
scrape_profile.py, discover_taxonomy.py) with one CLI the API layer
can invoke for any platform:

    python -m tools.scraper.run --platform trustpilot --action list \\
        --filters '{"country":"US","category":"casino","min_rating":1,"max_rating":3.5}' \\
        --output .tmp/raw_scrape_results.json

    python -m tools.scraper.run --platform trustpilot --action enrich \\
        --input .tmp/raw_scrape_results.json --output .tmp/enriched_leads.json \\
        --screenshots-dir .tmp/screenshots --parallel 3 --flush-every 25

    python -m tools.scraper.run --platform trustpilot --action discover-taxonomy

    python -m tools.scraper.run --action manifests          # list registered plugins

The output shapes match the legacy scripts byte-for-byte (modulo two
additive fields: every row now carries `platform` + `profile_url`).
That keeps the existing scrape-runner.ts orchestration working
without changes — the API can adopt --platform routing incrementally
in Phase 3.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Optional

# Allow `python tools/scraper/run.py` invocation in addition to
# `python -m tools.scraper.run` — both paths need the project root
# on sys.path so `tools.scraper.platforms` resolves.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

# Load .env from the project root if present. Production callers
# (scrape-runner.ts) inject the env explicitly via spawn(), so this is
# strictly a developer-convenience for `python -m tools.scraper.run`
# from a terminal. Silent no-op when there's no .env file.
def _load_dotenv_if_present() -> None:
    env_path = os.path.join(os.path.dirname(__file__), '..', '..', '.env')
    if not os.path.isfile(env_path):
        return
    try:
        with open(env_path, 'r', encoding='utf-8') as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, _, v = line.partition('=')
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                # Don't clobber values the caller explicitly set.
                if k and k not in os.environ:
                    os.environ[k] = v
    except OSError:
        pass
_load_dotenv_if_present()

# Force UTF-8 stdout/stderr — scrape-runner parses subprocess output line
# by line and non-ASCII (company names, emails) is common.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from tools.scraper.platforms import get_platform, list_manifests


def _ensure_parent_dir(path: str) -> None:
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def _parse_filters(raw: Optional[str]) -> dict:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"--filters must be valid JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise SystemExit("--filters JSON must be an object")
    return parsed


async def _run_list(args: argparse.Namespace) -> None:
    platform = get_platform(args.platform)
    filters = _parse_filters(args.filters)

    results = await platform.scrape_listing(
        filters,
        max_results=args.max_results,
    )

    # Preserve the legacy contract: every row gets country/category mirrored
    # from filters so downstream upsert paths (which expect them on the lead
    # row, not in a separate envelope) keep working. Trustpilot only — other
    # platforms with no country/category concept will simply not set them.
    for r in results:
        if 'country' in filters and 'country' not in r:
            r['country'] = filters['country']
        if 'category' in filters and 'category' not in r:
            r['category'] = filters['category']

    _ensure_parent_dir(args.output)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(results)} listing rows to {args.output}")
    # Mirror the legacy completion event so scrape-runner's progress
    # parser picks up the same signal.
    print(f"PROGRESS:category_done:{len(results)}", flush=True)


async def _run_enrich(args: argparse.Namespace) -> None:
    platform = get_platform(args.platform)

    with open(args.input, 'r', encoding='utf-8') as f:
        stubs = json.load(f)

    enriched = await platform.enrich_profiles(
        stubs,
        screenshots_dir=args.screenshots_dir,
        parallel_tabs=args.parallel,
        output_path=args.output,
        flush_every=args.flush_every,
    )

    _ensure_parent_dir(args.output)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(enriched, f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(enriched)} enriched rows to {args.output}")


async def _run_discover_taxonomy(args: argparse.Namespace) -> None:
    platform = get_platform(args.platform)
    summary = await platform.discover_taxonomy()
    print(f"Taxonomy refresh summary: {summary}")


async def _run_search_posts(args: argparse.Namespace) -> None:
    """Social-platforms post search — consumer-mode lead discovery.

    Reads ``query`` out of --filters (the same envelope the listing path
    uses, so frontends can submit one shape). Writes PostStubs as JSON.
    """
    platform = get_platform(args.platform)
    if not hasattr(platform, 'search_posts'):
        raise SystemExit(f"Platform '{args.platform}' does not support post search.")
    filters = _parse_filters(args.filters)
    query = filters.get('query', '').strip()
    if not query:
        raise SystemExit("--filters must include a non-empty 'query' for --action search-posts.")

    stubs = await platform.search_posts(query, filters, max_results=args.max_results)
    _ensure_parent_dir(args.output)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(stubs, f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(stubs)} post stubs to {args.output}")
    print(f"PROGRESS:search_done:{len(stubs)}", flush=True)


async def _run_enrich_authors(args: argparse.Namespace) -> None:
    """Social-platforms author enrichment — turns PostStubs into AuthorLeads."""
    platform = get_platform(args.platform)
    if not hasattr(platform, 'enrich_authors'):
        raise SystemExit(f"Platform '{args.platform}' does not support author enrichment.")
    with open(args.input, 'r', encoding='utf-8') as f:
        stubs = json.load(f)
    leads = await platform.enrich_authors(stubs, screenshots_dir=args.screenshots_dir)
    _ensure_parent_dir(args.output)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(leads, f, indent=2, ensure_ascii=False)
    print(f"Wrote {len(leads)} author leads to {args.output}")
    print(f"PROGRESS:enrich_done:{len(leads)}", flush=True)


def _run_manifests(_: argparse.Namespace) -> None:
    print(json.dumps(list_manifests(), indent=2, ensure_ascii=False))


def _run_draft_comment(args: argparse.Namespace) -> None:
    """Draft a comment for a FB post using Gemini. Pure — no browser."""
    from tools.scraper.shared import social_nlp
    filters = _parse_filters(args.filters)
    post_excerpt = filters.get('post_excerpt', '')
    niche = filters.get('niche', '')
    if not post_excerpt:
        raise SystemExit("--filters must include 'post_excerpt' for --action draft-comment.")
    if not niche:
        raise SystemExit("--filters must include 'niche' for --action draft-comment.")
    draft = social_nlp.draft_comment_from_post(post_excerpt, niche)
    print(json.dumps({'text': draft}))


async def _run_post_comment(args: argparse.Namespace) -> None:
    """Post a comment on a FB post via an account's saved session."""
    if args.platform and args.platform != 'facebook':
        raise SystemExit("post-comment is only supported for --platform facebook")
    from tools.scraper.platforms.facebook import FacebookScraper
    filters = _parse_filters(args.filters)
    post_url = filters.get('post_url', '').strip()
    text = filters.get('text', '').strip()
    account_id = filters.get('account_id', '').strip()
    if not post_url:
        raise SystemExit("--filters must include 'post_url' for --action post-comment.")
    if not text:
        raise SystemExit("--filters must include 'text' for --action post-comment.")
    if not account_id:
        raise SystemExit("--filters must include 'account_id' for --action post-comment.")
    scraper = FacebookScraper()
    result = await asyncio.to_thread(scraper.post_comment, post_url, text, account_id)
    print(json.dumps(result))


async def _run_join_groups(args: argparse.Namespace) -> None:
    """Auto-join customer-facing FB group candidates for one country (owner-local)."""
    if args.platform and args.platform != 'facebook':
        raise SystemExit("join-groups is only supported for --platform facebook")
    from tools.scraper.platforms.facebook import FacebookScraper
    filters = _parse_filters(args.filters)
    if not filters.get('country'):
        raise SystemExit("--filters must include 'country' for --action join-groups.")
    scraper = FacebookScraper()
    result = await asyncio.to_thread(scraper.join_groups, filters)
    print(json.dumps(result))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog='tools.scraper.run',
        description='Unified multi-platform scraper entry point.',
    )
    p.add_argument(
        '--platform',
        help='Platform name (trustpilot, tripadvisor, ...). Required for everything except --action manifests.',
    )
    p.add_argument(
        '--action',
        required=True,
        choices=[
            'list', 'enrich', 'discover-taxonomy', 'manifests',
            'search-posts', 'enrich-authors',
            'draft-comment', 'post-comment', 'join-groups',
        ],
        help='Pipeline step to execute.',
    )
    # list-specific
    p.add_argument('--filters', help='JSON object of platform-specific filter values (for --action list).')
    p.add_argument('--max-results', type=int, default=None, help='Cap on listing rows (for --action list).')
    # enrich-specific
    p.add_argument('--input', help='Input JSON path of profile stubs (for --action enrich).')
    p.add_argument('--screenshots-dir', default='', help='Directory for profile screenshots (for --action enrich).')
    p.add_argument('--parallel', type=int, default=3, help='Parallel browser tabs (for --action enrich).')
    p.add_argument(
        '--flush-every',
        type=int,
        default=25,
        help='Atomically write partial output every N enriched profiles (0 to disable).',
    )
    # shared
    p.add_argument('--output', help='Output JSON path (for list/enrich).')
    return p


_OPERATOR_ACTIONABLE_MARKERS = (
    'pinned to country',
    'No active Facebook account',
    'target country',
    'needs re-connect',
    'Connect one in Social Accounts',
)


def _is_operator_actionable(message: str) -> bool:
    """True when a RuntimeError is a known, operator-fixable scraper failure
    (no eligible/pinned account for the target country, a stale session, or an
    undeterminable target country) rather than a genuine bug. Lets run.py
    surface a clean one-line message instead of a Python traceback."""
    return any(m in (message or '') for m in _OPERATOR_ACTIONABLE_MARKERS)


def _dispatch_action(args: argparse.Namespace) -> None:
    if args.action == 'list':
        if not args.output:
            raise SystemExit("--output is required for --action list.")
        asyncio.run(_run_list(args))
    elif args.action == 'enrich':
        if not args.input or not args.output:
            raise SystemExit("--input and --output are required for --action enrich.")
        asyncio.run(_run_enrich(args))
    elif args.action == 'discover-taxonomy':
        asyncio.run(_run_discover_taxonomy(args))
    elif args.action == 'search-posts':
        if not args.output:
            raise SystemExit("--output is required for --action search-posts.")
        asyncio.run(_run_search_posts(args))
    elif args.action == 'enrich-authors':
        if not args.input or not args.output:
            raise SystemExit("--input and --output are required for --action enrich-authors.")
        asyncio.run(_run_enrich_authors(args))
    elif args.action == 'draft-comment':
        if not args.platform:
            args.platform = 'facebook'  # only FB has comments for now
        _run_draft_comment(args)
    elif args.action == 'post-comment':
        if not args.platform:
            raise SystemExit("--platform is required for --action post-comment.")
        asyncio.run(_run_post_comment(args))
    elif args.action == 'join-groups':
        if not args.platform:
            raise SystemExit("--platform facebook is required for --action join-groups.")
        asyncio.run(_run_join_groups(args))


def main() -> None:
    args = build_parser().parse_args()

    if args.action == 'manifests':
        _run_manifests(args)
        return

    # draft-comment defaults to facebook and doesn't need --platform.
    # post-comment requires --platform but the per-action check handles it.
    if not args.platform and args.action not in ('draft-comment', 'post-comment'):
        raise SystemExit("--platform is required for this action.")

    try:
        _dispatch_action(args)
    except RuntimeError as exc:
        # Operator-actionable scraper failures (no eligible / pinned account,
        # stale session, undeterminable target country) surface as a clean
        # one-line message instead of a Python traceback, so the UI shows
        # exactly what to fix. Genuine bugs keep their traceback for debugging.
        if _is_operator_actionable(str(exc)):
            raise SystemExit(f"Scrape blocked — {exc}")
        raise


if __name__ == '__main__':
    main()
