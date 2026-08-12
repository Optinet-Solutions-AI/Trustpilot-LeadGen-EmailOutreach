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


def main() -> int:
    ap = argparse.ArgumentParser(description='Open/stop a secured AdsPower profile for the fleet.')
    grp = ap.add_mutually_exclusive_group(required=True)
    grp.add_argument('--account', help='social_accounts.id')
    grp.add_argument('--profile', help='raw AdsPower profile id')
    ap.add_argument('--print-port', action='store_true',
                    help='Open the session and print ONLY the CDP port (for the spawner).')
    ap.add_argument('--stop', action='store_true',
                    help='Stop the profile instead of opening it.')
    args = ap.parse_args()
    try:
        if args.stop:
            close_account_session(account_id=args.account, profile_id=args.profile)
            return 0
        out = open_account_session(account_id=args.account, profile_id=args.profile)
    except FleetSessionError as exc:
        print(f'FLEET SESSION FAILED: {exc}', file=sys.stderr, flush=True)
        return 1
    if args.print_port:
        print(port_from_cdp_address(out['cdp_address']))
    else:
        print(json.dumps(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
