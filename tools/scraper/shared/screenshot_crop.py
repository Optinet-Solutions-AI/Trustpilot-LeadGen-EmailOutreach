"""Crop a TripAdvisor profile screenshot down to the business header.

TripAdvisor captures come back as tall full-page (or 1920x1080 viewport)
PNGs; displayed in the CRM that's a useless multi-thousand-pixel sliver.
We crop to just the header — business name + rating + review count +
ranking/category — mirroring the small, relevant shot the legacy
Trustpilot scraper takes of its reputation panel.

WHY IT'S ADAPTIVE
    A single fixed clip doesn't work across TripAdvisor page types:
    restaurants render name (1 line) + rating in a short header with a
    full-width photo gallery immediately below (~y415), while hotels wrap
    long names to 2 lines and push the rating + contact links down to
    ~y520 with no photo band there. So we crop to a fixed header box, then
    scan downward and cut at the first sustained "photo band" (rows that
    aren't mostly-white page background). Restaurants trim tight to the
    rating; hotels keep their taller header.

PILLOW-OPTIONAL
    If Pillow isn't installed (or the bytes don't decode), the original
    bytes are returned unchanged — a screenshot cosmetic must never fail
    a scrape.
"""
from __future__ import annotations

import io

# Header box on a 1920-wide capture. LEFT/RIGHT bracket the content column
# (excludes the left gutter and the Save/Review buttons); TOP sits just below
# the breadcrumb; MIN/MAX bottom bound the adaptive cut.
_LEFT, _RIGHT, _TOP = 384, 1345, 298
_MIN_BOTTOM, _MAX_BOTTOM = 408, 548


def crop_tripadvisor_header(png_bytes: bytes) -> bytes:
    """Return PNG bytes cropped to the TripAdvisor header, or the input
    unchanged if Pillow is unavailable / the image isn't the expected shape."""
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
    # Already cropped (width==961) or an unexpected layout — leave it alone.
    if img.width < _RIGHT:
        return png_bytes

    px = img.load()
    step = 3
    samples = len(range(_LEFT, _RIGHT, step))
    max_y = min(_MAX_BOTTOM, img.height)
    bottom = max_y
    consec = 0
    for y in range(_MIN_BOTTOM, max_y):
        whites = 0
        for x in range(_LEFT, _RIGHT, step):
            r, g, b = px[x, y]
            if r > 232 and g > 232 and b > 232:
                whites += 1
        if whites / samples < 0.62:      # not a mostly-white text row → photo
            consec += 1
            if consec >= 12:             # sustained band → header ended above
                bottom = y - consec + 1
                break
        else:
            consec = 0
    bottom = max(_MIN_BOTTOM, min(bottom, max_y))

    cropped = img.crop((_LEFT, _TOP, _RIGHT, bottom))
    out = io.BytesIO()
    cropped.save(out, format='PNG')
    return out.getvalue()
