"""Crop a TripAdvisor profile screenshot down to a small "preview card".

TripAdvisor captures come back as tall full-page PNGs (up to ~14000px), which
render as a useless sliver in the CRM. We crop to a compact listing preview:
the business header (name + rating + ranking/category) PLUS the first hero-photo
row, so each lead shows an attractive card rather than a bare text strip or a
giant scroll.

PILLOW-OPTIONAL
    If Pillow isn't installed (or the bytes don't decode) the input is returned
    unchanged — a screenshot cosmetic must never fail a scrape.

NOTE
    Only full-page / 1920-wide captures are cropped. An already-cropped image
    (narrower than _FULLPAGE_MIN_WIDTH) is returned untouched — the hero photo
    can't be recovered once a page has been cropped to the header alone.
"""
from __future__ import annotations

import io

# Preview-card box measured on a 1920-wide capture: the content column
# (excludes the left gutter and the Save/Review buttons on the right), from
# just below the breadcrumb down through the first hero-photo row.
_LEFT, _TOP, _RIGHT, _BOTTOM = 384, 300, 1560, 780
# ...and the width those numbers were measured against. The box is SCALED to
# whatever width actually arrives, because the capture width is no longer
# fixed: ScrapingBee shot 1920, the Apify UNBLOCKER path shoots 1400. Applying
# 1920 coordinates to a 1400 capture crops the middle of the page instead of
# the header, which is exactly what reached the CRM on 2026-09-24 — a picture
# of the photo gallery with no business name or rating in it.
_MEASURED_AT_WIDTH = 1920
# Captures at least this wide are full pages we crop; anything narrower is
# already a cropped card and is left alone (idempotent).
_FULLPAGE_MIN_WIDTH = 1400


def crop_tripadvisor_header(png_bytes: bytes) -> bytes:
    """Return PNG bytes cropped to a TripAdvisor preview card, or the input
    unchanged if Pillow is unavailable / the image is already cropped."""
    if not png_bytes:
        return png_bytes
    try:
        from PIL import Image  # lazy — keep Pillow an optional dependency
    except ImportError:
        return png_bytes
    try:
        img = Image.open(io.BytesIO(png_bytes)).convert('RGB')
    except Exception:
        return png_bytes

    w, h = img.size
    if w < _FULLPAGE_MIN_WIDTH:
        return png_bytes  # already a preview/header crop — nothing to recover

    # Scale the measured box to this capture's width. The page is the same
    # layout at any viewport, just narrower, so the box moves with it.
    k = w / _MEASURED_AT_WIDTH
    left, right = int(_LEFT * k), int(_RIGHT * k)
    top, bottom = int(_TOP * k), int(_BOTTOM * k)
    cropped = img.crop((left, top, min(right, w), min(bottom, h)))
    out = io.BytesIO()
    cropped.save(out, format='PNG')
    return out.getvalue()
