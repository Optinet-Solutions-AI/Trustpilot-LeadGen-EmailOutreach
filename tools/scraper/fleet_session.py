"""Fleet session — open a secured AdsPower profile for one FB account and return
its CDP address.

This is the seam the queue-driven fleet worker (Phase 3) will call. In Phase 1
it is exercised directly via the CLI to prove the box can open any account's
profile on demand. It does NOT drive the browser or relay CDP (Phase 2) — it
launches the profile and returns where to attach.
"""
from __future__ import annotations

import argparse
import json
import sys
import uuid
from typing import Optional

from tools.db.supabase_client import table
from tools.scraper.shared import adspower


class FleetSessionError(RuntimeError):
    """Could not open a fleet session for the requested account/profile."""


def _resolve_profile_id(account_id: str) -> tuple[str, Optional[str]]:
    rows = (table('social_accounts')
            .select('adspower_profile_id,status,country')
            .eq('id', account_id).limit(1).execute().data)
    if not rows:
        raise FleetSessionError(f'No social_accounts row for id={account_id!r}')
    row = rows[0]
    if row.get('status') != 'active':
        raise FleetSessionError(f'Account {account_id} is not active (status={row.get("status")!r})')
    profile_id = (row.get('adspower_profile_id') or '').strip()
    if not profile_id:
        raise FleetSessionError(f'Account {account_id} has no adspower_profile_id bound')
    return profile_id, row.get('country')


def open_account_session(*, account_id: Optional[str] = None, profile_id: Optional[str] = None) -> dict:
    """Open the AdsPower profile for an account (or a raw profile id) and return
    {profile_id, account_id, country, cdp_address, webdriver_path}.

    Fails closed (FleetSessionError) if the Local API is down or the account has
    no bound active profile — never returns a half-open session."""
    if not account_id and not profile_id:
        raise FleetSessionError('Pass account_id or profile_id')
    if account_id and profile_id:
        raise FleetSessionError('Pass account_id OR profile_id, not both')
    country = None
    if account_id:
        profile_id, country = _resolve_profile_id(account_id)
    if not adspower.health_check():
        raise FleetSessionError('AdsPower Local API is not responding on this host')
    try:
        attach = adspower.start_profile(profile_id)
    except adspower.AdsPowerError as exc:
        raise FleetSessionError(f'AdsPower failed to start profile {profile_id}: {exc}') from exc
    return {
        'profile_id': profile_id,
        'account_id': account_id,
        'country': country,
        'cdp_address': attach['debugger_address'],
        'webdriver_path': attach.get('webdriver_path') or '',
    }


def port_from_cdp_address(cdp_address: str) -> int:
    """Extract the integer TCP port from a CDP debugger address, e.g.
    '127.0.0.1:9222' -> 9222. Raises FleetSessionError on a malformed value."""
    addr = (cdp_address or '').strip()
    if ':' not in addr:
        raise FleetSessionError(f'CDP address {cdp_address!r} has no :port')
    port_str = addr.rsplit(':', 1)[1]
    try:
        return int(port_str)
    except ValueError as exc:
        raise FleetSessionError(f'CDP address {cdp_address!r} has a non-integer port') from exc


def create_fleet_profile(*, country: str, proxy_json: str) -> str:
    """Create a brand-new AdsPower profile pinned to `country` (the FB
    onboarding wizard's worker branch). Returns the new profile id.

    `proxy_json` is passed through verbatim as `proxy_config` — the caller
    (the Node worker) is responsible for building a real country-proxy JSON
    payload; an empty/blank value here falls through to adspower.py's own
    no-proxy default. Wraps adspower.AdsPowerError as FleetSessionError so
    main_with_args has one exception type to catch."""
    short_id = uuid.uuid4().hex[:8]
    try:
        proxy_config = json.loads(proxy_json or '{}')
    except (TypeError, ValueError) as exc:
        raise FleetSessionError(f'--proxy-json is not valid JSON: {exc}') from exc
    try:
        return adspower.create_profile(
            name=f'fleet-{country}-{short_id}',
            country=country,
            proxy_config=proxy_config,
        )
    except adspower.AdsPowerError as exc:
        raise FleetSessionError(f'AdsPower failed to create a profile for country={country}: {exc}') from exc


def close_account_session(*, account_id: Optional[str] = None, profile_id: Optional[str] = None) -> None:
    """Stop the AdsPower profile for an account (or a raw profile id). Resolves
    the profile from social_accounts when given an account_id. Stopping an
    already-stopped profile is not an error (adspower.stop_profile handles it)."""
    if not account_id and not profile_id:
        raise FleetSessionError('Pass account_id or profile_id')
    if account_id and profile_id:
        raise FleetSessionError('Pass account_id OR profile_id, not both')
    if account_id:
        profile_id, _country = _resolve_profile_id(account_id)
    adspower.stop_profile(profile_id)


def main_with_args(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description='Open/stop/create a secured AdsPower profile for the fleet.')
    # Not required=True any more: --create is a third action that needs neither
    # --account nor --profile. Presence is validated by hand below so --create
    # keeps a clean, specific error message instead of argparse's generic one.
    grp = ap.add_mutually_exclusive_group(required=False)
    grp.add_argument('--account', help='social_accounts.id')
    grp.add_argument('--profile', help='raw AdsPower profile id')
    ap.add_argument('--create', action='store_true',
                    help='Create a brand-new AdsPower profile (onboarding) instead of opening/stopping one.')
    ap.add_argument('--country', help='ISO2 country code — required with --create')
    ap.add_argument('--proxy-json', default='{}',
                    help='JSON proxy_config to pass through on --create (default: {})')
    ap.add_argument('--print-port', action='store_true',
                    help='Open the session and print ONLY the CDP port (for the spawner).')
    ap.add_argument('--stop', action='store_true',
                    help='Stop the profile instead of opening it.')
    args = ap.parse_args(argv)

    if not args.create and not args.account and not args.profile:
        ap.error('one of --account, --profile, or --create is required')

    try:
        if args.create:
            if not args.country:
                raise FleetSessionError('--create requires --country')
            pid = create_fleet_profile(country=args.country, proxy_json=args.proxy_json)
            print(pid)
            return 0
        if args.stop:
            close_account_session(account_id=args.account, profile_id=args.profile)
            return 0
        out = open_account_session(account_id=args.account, profile_id=args.profile)
        if args.print_port:
            print(port_from_cdp_address(out['cdp_address']))
        else:
            print(json.dumps(out))
    except FleetSessionError as exc:
        print(f'FLEET SESSION FAILED: {exc}', file=sys.stderr, flush=True)
        return 1
    return 0


def main() -> int:
    return main_with_args(sys.argv[1:])


if __name__ == '__main__':
    sys.exit(main())
