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
_MIN_BOTTOM, _MAX_BOTTOM = 400, 548


def _is_white(p) -> bool:
    return p[0] > 232 and p[1] > 232 and p[2] > 232


def _is_dark(p) -> bool:
    # TripAdvisor header text is dark: near-black rating/reviews and the dark
    # forest-green name/links (~#004f31). Photo pixels are lighter/colourful and
    # the gray photo-placeholder is light gray — neither trips this.
    return p[0] < 130 and p[1] < 130 and p[2] < 130


def crop_tripadvisor_header(png_bytes: bytes) -> bytes:
    """Return PNG bytes cropped to the TripAdvisor header (name + rating +
    ranking/category + contacts), or the input unchanged if Pillow is
    unavailable / the image isn't the expected shape.

    Two-stage adaptive cut so the result is tight for every page type:
      1. Find the photo-band ceiling — the first sustained run of non-white
         rows below the header (restaurants have a full-width photo gallery
         right under the header; this stops us cropping into it).
      2. Within the header region above that ceiling, find the LAST row that
         still contains dark header text and cut just below it. This trims the
         trailing whitespace AND the light-gray photo-placeholder sliver that
         hotels show under their contact row — so the shot ends cleanly on the
         last line of real header content.
    """
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
    if w >= _RIGHT:
        # Full-page or 1920-wide viewport capture — crop the header column.
        left, top, right = _LEFT, _TOP, _RIGHT
        y_start, y_cap, min_bottom = _MIN_BOTTOM, min(_MAX_BOTTOM, h), _MIN_BOTTOM
    else:
        # Already the header box (e.g. a previously-cropped 961-wide image) —
        # analyse it whole so we can still trim a trailing gray/white sliver.
        left, top, right = 0, 0, w
        y_start, y_cap, min_bottom = min(70, h), h, min(70, h)

    px = img.load()
    step = 3
    xs = range(left, right, step)
    samples = max(1, len(xs))

    # Stage 1: photo-band ceiling — first sustained run of non-white rows.
    # Only for full-page captures, where a full-width photo gallery sits right
    # under the header (restaurants). For an already-cropped header box there's
    # no such gallery, and the large header NAME at the top would itself read as
    # a low-white "band" and cut far too high — so skip it there.
    photo_ceiling = y_cap
    if w >= _RIGHT:
        consec = 0
        for y in range(y_start, y_cap):
            whites = sum(1 for x in xs if _is_white(px[x, y]))
            if whites / samples < 0.62:
                consec += 1
                if consec >= 12:
                    photo_ceiling = y - consec + 1
                    break
            else:
                consec = 0

    # Stage 2: last dark-text row above the ceiling — cut just below it so the
    # trailing whitespace and the light-gray photo-placeholder sliver are gone.
    last_dark = min_bottom
    for y in range(top, min(photo_ceiling, y_cap)):
        if sum(1 for x in xs if _is_dark(px[x, y])) >= 6:
            last_dark = y
    bottom = min(photo_ceiling, last_dark + 6)
    bottom = max(min_bottom, min(bottom, y_cap))

    # Idempotency / no-op guard: if this is already a tight box with nothing
    # meaningful to trim, return the input unchanged (avoids re-shrinking on
    # repeat runs and re-encoding for no reason).
    if w < _RIGHT and bottom >= h - 4:
        return png_bytes

    cropped = img.crop((left, top, right, bottom))
    out = io.BytesIO()
    cropped.save(out, format='PNG')
    return out.getvalue()
