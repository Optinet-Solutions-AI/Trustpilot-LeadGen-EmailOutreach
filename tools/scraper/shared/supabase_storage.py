"""
Supabase Storage upload helper for scraper plugins.

Previously screenshots were saved to a local /tmp/screenshots/ directory
and the TypeScript scrape-runner.ts ran a separate `uploadScreenshotsToStorage`
pass after enrich finished, matching local filenames back to rows. That
approach had two failure modes in production:
  1. The match step needed the enriched JSON to carry both `platform` and
     `profile_url` AND a `screenshot_path` whose basename matched a disk
     file — silently dropped any row where the join missed.
  2. Local-only paths in the row meant a window where the DB pointed at
     a non-existent URL until the upload step caught up. If the upload
     step crashed (e.g. quota error), the row was permanently stale.

This module lets the Python plugin upload directly during enrich_profiles,
so the row's screenshot_path is the public URL from the moment it's
written to Supabase — no second pass, no matcher, no race window.

NETWORK
    Hits POST /storage/v1/object/<bucket>/<path> against
    $SUPABASE_URL with the service-role key (same as everything else
    in tools/db/supabase_client.py). Bucket must already exist and be
    public; we don't try to create it.

CREDENTIALS
    Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the env. If
    either is missing, every call returns None and the caller proceeds
    with a no-screenshot row (same shape upload_screenshot already
    used when local disk save failed).

CONCURRENCY
    Storage uploads can fire concurrently — Supabase's storage layer
    accepts parallel PUTs to different keys. Callers run enrich_profiles
    with a parallel_tabs semaphore that already throttles ScrapingBee
    calls; we ride that limit.
"""
from __future__ import annotations

import os
from typing import Optional

import requests


_DEFAULT_BUCKET = 'screenshots'
_UPLOAD_TIMEOUT_S = 30


def supabase_storage_enabled() -> bool:
    return bool(
        os.environ.get('SUPABASE_URL')
        and os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
    )


def upload_screenshot_bytes(
    png_bytes: bytes,
    object_path: str,
    *,
    bucket: str = _DEFAULT_BUCKET,
    upsert: bool = True,
) -> Optional[str]:
    """
    Upload PNG bytes to the storage bucket and return the public URL.

    `object_path` is the in-bucket path, e.g. 'yelp/flatrate-moving-new-york-7.png'.
    The function is idempotent — `upsert=True` (default) means re-uploading
    the same object_path overwrites the previous version. The returned
    URL is the bucket's public URL format, which works for any caller
    that can hit Supabase's edge.

    Returns None on:
      - missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
      - non-2xx response from the storage API
      - transport / DNS errors
    Callers treat None as "screenshot didn't upload — store the row
    without screenshot_path" rather than as a hard failure.
    """
    if not supabase_storage_enabled():
        return None
    if not png_bytes:
        return None

    base_url = os.environ['SUPABASE_URL'].rstrip('/')
    service_key = os.environ['SUPABASE_SERVICE_ROLE_KEY']

    # Strip leading slashes — Supabase Storage rejects "//" in the path.
    safe_path = object_path.lstrip('/')

    upload_url = f'{base_url}/storage/v1/object/{bucket}/{safe_path}'
    headers = {
        'Authorization': f'Bearer {service_key}',
        'apikey': service_key,
        'Content-Type': 'image/png',
        'Cache-Control': '3600',
    }
    if upsert:
        # Tell Supabase to overwrite an existing object at the same path.
        # Without this, repeat uploads return 409 Duplicate.
        headers['x-upsert'] = 'true'

    try:
        resp = requests.post(
            upload_url,
            headers=headers,
            data=png_bytes,
            timeout=_UPLOAD_TIMEOUT_S,
        )
    except requests.exceptions.RequestException as e:
        print(f"[storage:upload] transport error for {safe_path}: {e}")
        return None

    if resp.status_code >= 400:
        # Supabase storage returns JSON on errors. Truncate for log hygiene.
        snippet = resp.text[:300]
        print(f"[storage:upload] non-2xx {resp.status_code} for {safe_path}: {snippet}")
        return None

    # Public URL format. Works for any public bucket regardless of how
    # we authenticated for the upload.
    public_url = f'{base_url}/storage/v1/object/public/{bucket}/{safe_path}'
    return public_url


def upload_screenshot_file(
    file_path: str,
    object_path: str,
    *,
    bucket: str = _DEFAULT_BUCKET,
    upsert: bool = True,
) -> Optional[str]:
    """Convenience wrapper for callers that already wrote the PNG to disk."""
    try:
        with open(file_path, 'rb') as f:
            data = f.read()
    except OSError as e:
        print(f"[storage:upload] read error for {file_path}: {e}")
        return None
    return upload_screenshot_bytes(data, object_path, bucket=bucket, upsert=upsert)
