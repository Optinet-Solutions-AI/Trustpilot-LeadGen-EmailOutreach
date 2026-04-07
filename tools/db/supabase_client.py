"""
Supabase client singleton for all Python tools.
Uses postgrest-py directly since the full supabase package has build issues on Python 3.14.
"""

import os
from dotenv import load_dotenv
from postgrest import SyncPostgrestClient

# Load .env from project root
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', '.env'))

SUPABASE_URL = os.getenv('SUPABASE_URL', '')
SUPABASE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY', '')

if not SUPABASE_URL or not SUPABASE_KEY:
    raise EnvironmentError(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file. "
        "Copy .env.example to .env and fill in your Supabase credentials."
    )

_rest_url = f"{SUPABASE_URL}/rest/v1"
_headers = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

_client = None


def get_client() -> SyncPostgrestClient:
    """Return a reusable PostgREST client pointed at your Supabase project."""
    global _client
    if _client is None:
        _client = SyncPostgrestClient(
            base_url=_rest_url,
            headers=_headers,
            timeout=30,
        )
    return _client


def table(name: str):
    """Shortcut: get_client().from_(name)"""
    return get_client().from_(name)
