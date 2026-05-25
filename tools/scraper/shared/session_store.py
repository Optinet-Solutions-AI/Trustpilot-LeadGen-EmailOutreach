"""Persist + load encrypted cookie jars for social_accounts rows.

The Facebook / Instagram scrapers (M5 / M9) call ``load_cookies`` at the
start of every session and ``save_cookies`` whenever the session ends
cleanly. Cookies are stored encrypted via AES-256-GCM (see
``encryption.py``) so the database never holds plaintext session
material.

A cookie jar is whatever Selenium / undetected-chromedriver returns from
``driver.get_cookies()`` — a list of dicts. We round-trip it through
JSON so the storage format stays scraper-agnostic.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from tools.db.supabase_client import table
from tools.scraper.shared.encryption import decrypt_cookie, encrypt_cookie

CookieJar = list[dict[str, Any]]


def load_cookies(account_id: str) -> Optional[CookieJar]:
    """Return the decrypted cookie jar for a social_accounts row.

    Returns ``None`` when the row has no cookies yet (newly-connected
    account that hasn't completed login) or when the row doesn't exist.
    """
    rows = (
        table('social_accounts')
        .select('encrypted_cookies')
        .eq('id', account_id)
        .execute()
        .data
    )
    if not rows:
        return None
    payload = rows[0].get('encrypted_cookies')
    if not payload:
        return None
    return json.loads(decrypt_cookie(payload))


def save_cookies(account_id: str, jar: CookieJar) -> None:
    """Encrypt and persist a cookie jar into social_accounts.encrypted_cookies.

    Also bumps ``updated_at`` so the Social Accounts UI (M4) can show a
    reliable "last cookie refresh" timestamp — Postgres only auto-fires
    the column's DEFAULT now() at INSERT time, so updates need to set it
    explicitly.
    """
    payload = encrypt_cookie(json.dumps(jar))
    now_iso = datetime.now(timezone.utc).isoformat()
    (
        table('social_accounts')
        .update({'encrypted_cookies': payload, 'updated_at': now_iso})
        .eq('id', account_id)
        .execute()
    )
