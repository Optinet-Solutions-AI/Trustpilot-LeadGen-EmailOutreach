"""social_nlp — shared NLP helpers for social-platform scrapers.

Contains classifier utilities that are reused across multiple platform
plugins (Facebook, Instagram, …) so they live here rather than inside
any single platform module.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Optional


def classify_consumer_posts_with_gemini(
    post_excerpts: list[str],
    niche: str,
    *,
    location: Optional[str] = None,
    timeout_s: int = 30,
) -> Optional[list[bool]]:
    """Send a batch of post excerpts to Gemini Flash and return per-post
    consumer-or-not verdicts.

    Returns a list[bool] aligned 1:1 with post_excerpts (True = real
    consumer ask, False = drop). Returns None when the API key isn't
    configured, the request fails, or the response can't be parsed —
    callers should treat None as "skip the LLM stage, keep substring
    filter verdicts".

    Cost-aware: batches up to 50 excerpts per call (well under
    Gemini's input limit). One call per scrape, not per post.
    """
    api_key = os.environ.get('GEMINI_API_KEY') or os.environ.get('NEXT_PUBLIC_GEMINI_API_KEY')
    if not api_key or not post_excerpts:
        return None

    # Build a numbered list so the model can return verdicts indexed
    # by position. JSON-structured output avoids parse drift.
    numbered = '\n'.join(
        f'[{i}] {(text or "")[:400]}'
        for i, text in enumerate(post_excerpts)
    )

    location_clause = (
        f'\n\nTARGET LOCATION: "{location}".\n'
        f'  - The post must be about a job IN or NEAR {location}. A different city or '
        f'    region in the same country (e.g. operator searched London, post is from '
        f'    Manchester or Bury) is FALSE.\n'
        f'  - Surrounding boroughs / suburbs / postcodes of {location} count as the same '
        f'    location. Example: searching London, a post mentioning E1 / Croydon / '
        f'    Camden / Greater London passes.\n'
        f'  - THE AUTHOR NAME IS NOT A LOCATION SIGNAL. If the author is called "Yvette Rome" '
        f'    or "John London" or "Sarah Paris", that is a SURNAME / COINCIDENCE, not evidence '
        f'    that the post is from the target city. Only the post body, attached photo text, '
        f'    or explicit FB metadata (e.g. "in Manchester, United Kingdom") counts as a '
        f'    location signal.\n'
        f'  - The post can be in ANY language (English, German, French, Italian, Spanish, '
        f'    Portuguese, Polish, etc.). Judge the location signal by the city/neighborhood '
        f'    NAMES in the post text — those names render the same way regardless of the '
        f'    post language. A German post saying "ich suche einen Elektriker in Frankfurt-'
        f'    Sachsenhausen" has a clear Frankfurt signal even though the language is German. '
        f'    Conversely, a German post with NO mention of {location} or any neighborhood of '
        f'    {location} should classify FALSE — we can\'t verify it\'s from there.\n'
        if location else ''
    )

    prompt = f"""You are classifying Facebook group posts to find PROSPECTS — private individuals who currently need to hire someone specifically for "{niche}".

For each numbered post, answer TRUE or FALSE.

NICHE MATCH (strict): the post must be asking for "{niche}" or an exact synonym, NOT a related trade.
  - "Website builder" search: a post asking for a "website developer" or "web designer" passes. A post asking for a "bathroom builder", "house builder", or any physical-construction "builder" is FALSE — different service entirely, only the word matches.
  - "Plumber" search: a post asking for a "plumbing engineer" or "heating engineer" passes. A "handyman" who happens to do plumbing as a side skill is FALSE unless they explicitly mention the plumbing job is the ask.
  - "Dentist" search: orthodontist / dental hygienist / oral surgeon pass. GP, doctor, or unrelated medical specialist is FALSE.
  - When in doubt about whether two services are the same, default to FALSE. We'd rather miss a marginal lead than send cold outreach to someone in the wrong industry.
{location_clause}
TRUE — the author is a private individual or household describing a SPECIFIC personal need FOR THE NICHE:
  - mentions a property, address, postcode, "my house", "my flat", "my mum's"
  - one-off job: install, fix, repair, replace, advice for a personal situation
  - asking on behalf of a family member or friend counts (still a consumer lead)

FALSE — everything else, including:
  - WRONG NICHE — a builder when you wanted a website builder, etc. (see niche rules above)
  - WRONG LOCATION — different city when the operator targeted a specific one (see location rules above)
  - RHETORICAL HEADLINES — "Looking for X?" / "Need a Y?" / "Want a Z?" with no personal context, no address, no "my house / my flat / for my mum" follow-up. These are ad creatives where the body (truncated by FB's "See more") would continue "...we can help! Call us today / DM us / visit our site." If the excerpt is ONLY a question + brand-tagline shape, classify FALSE. A genuine consumer ask always has personal detail attached (a postcode, "my", "asap", "for the bathroom in our flat", etc.).
  - businesses advertising their own services ("Need a reliable plumber? Call us…")
  - clinics/contractors recruiting staff ("Looking for a Gas Safe engineer, full time")
  - agencies pitching websites / marketing / lead-gen to tradespeople
  - SaaS, AI, app, platform, or product pitches aimed at tradespeople
  - practitioner-to-practitioner networking ("Hey fellow plumbers, advice on getting leads?")
  - job seekers posting their CV / availability ("I have a diploma, looking for work")
  - business-partnership offers ("Looking for a master plumber to start a business")
  - past-tense / already-found posts ("Salamat Doc / had my procedure / went to…")
  - vague marketplace lead-gen posts with no concrete personal need

Return ONLY a JSON object with this exact shape, no preamble or markdown:
{{"verdicts": [true, false, true, ...]}}

The verdicts array MUST have exactly {len(post_excerpts)} entries in the same order as the input.

Posts:
{numbered}
"""

    # Same model the frontend's template generator uses, so we stay
    # consistent and the existing API key (which has access to it)
    # works without an additional quota request.
    url = (
        'https://generativelanguage.googleapis.com/v1beta/models/'
        f'gemini-2.5-flash:generateContent?key={api_key}'
    )
    payload = {
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {
            'temperature': 0.1,
            # Gemini 2.5 Flash spends "thinking tokens" before output.
            # 2048 was empirically too low when classifying 30+ posts in a
            # single call — the model burned the budget on reasoning and
            # the visible JSON came back truncated/empty. 8192 leaves plenty
            # of headroom (typical output is a list of ~30 booleans = ~200
            # tokens of actual JSON).
            'maxOutputTokens': 8192,
            'responseMimeType': 'application/json',
        },
    }

    try:
        import requests as _requests  # noqa: WPS433 — lazy
        resp = _requests.post(url, json=payload, timeout=timeout_s)
        resp.raise_for_status()
        body = resp.json()
        text = (
            body.get('candidates', [{}])[0]
                .get('content', {})
                .get('parts', [{}])[0]
                .get('text', '')
        ).strip()
        if not text:
            # Defensive: empty response (thinking-budget exhausted OR safety
            # filter blocked it). Surface the full response body so the
            # caller can see in stderr/DB what Gemini actually returned.
            print(
                f'[gemini-classifier] empty response from Gemini (likely '
                f'thinking-budget exhausted); body summary: {str(body)[:500]}',
                file=sys.stderr,
            )
            return None
        parsed = json.loads(text)
        verdicts = parsed.get('verdicts')
        if not isinstance(verdicts, list) or len(verdicts) != len(post_excerpts):
            print(
                f'[gemini-classifier] verdict count mismatch '
                f'(expected {len(post_excerpts)}, got {len(verdicts) if isinstance(verdicts, list) else "non-list"})',
                file=sys.stderr,
            )
            return None
        return [bool(v) for v in verdicts]
    except Exception as exc:  # noqa: BLE001
        print(f'[gemini-classifier] failed, falling back to substring filter only: {exc}', file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Discovered Groups — batch group labelling (audience + location)
# ---------------------------------------------------------------------------

def label_groups_with_gemini(
    groups: list[dict],
    *,
    timeout_s: int = 30,
) -> Optional[list[dict]]:
    """Batch-label Facebook GROUPS (not posts) from their name alone.

    `groups` is a list of {'name': str} (extra keys are ignored — id/join
    logic is the caller's problem). Returns a list aligned 1:1 with `groups`:

        [{'audience': 'customers' | 'trades' | 'unclear',
          'country_code': 'GB' | None,   # ISO 3166-1 alpha-2, uppercase
          'city': 'Bristol' | None}, ...]

    Returns None when the API key isn't configured, the request fails, or
    the response can't be parsed — callers should leave those rows
    unlabelled (audience stays NULL) rather than write a guess.

    One call per batch, NOT one call per group — callers should chunk large
    backlogs (mirrors classify_consumer_posts_with_gemini's cost-aware
    batching above).
    """
    api_key = os.environ.get('GEMINI_API_KEY') or os.environ.get('NEXT_PUBLIC_GEMINI_API_KEY')
    if not api_key or not groups:
        return None

    numbered = '\n'.join(
        f'[{i}] {(g.get("name") or "(no name)")[:200]}'
        for i, g in enumerate(groups)
    )

    prompt = f"""You are labelling Facebook GROUPS (not posts) for a lead-gen tool that
finds tradespeople's customers. You get ONLY the group's name — judge everything
from that text alone.

For each numbered group, return THREE fields:

1. "audience" — who actually posts in this group:
   - "customers" — private individuals asking to HIRE someone (e.g. "Find a
     Tradesman Bristol and surrounding", "HANDYMAN SERVICES NEEDED", "Looking
     for an electrician"). These are valuable — real people with a job to fill.
   - "trades" — tradespeople/practitioners talking to EACH OTHER: job boards,
     "free advertising" pages for the trade itself, professional networking,
     supplier/wholesaler pages (e.g. "London Builders And Other Tradesman Free
     Advertising", "Offres d'emploi pour Electricien", "les artisans
     electriciens"). Worthless as customer leads — everyone posting is
     already in the trade.
   - "unclear" — can't tell from the name alone (generic city/community
     pages, ambiguous marketplace names).

   PATTERN RULE (apply this before keyword-guessing — the SHAPE of the name
   matters more than the trade word simply appearing in it):
     - An ASK shape means "customers": "Find a [Trade]", "Looking for a
       [Trade]", "[Trade] Recommendations", "Recommended Tradespeople",
       "[Area] Community/Recommendations", "... NEEDED", "Can anyone
       recommend ...". These names frame someone WANTING to hire — a
       homeowner asking, not a worker advertising.
     - A DIRECTORY/PEER shape means "trades" (or "unclear" if truly
       ambiguous — NEVER "customers"): a bare "[TRADE] [City]" or "[City]
       [Trade(s)]" with no ask-verb and no recommendations/community/needed
       wrapper — e.g. "PLUMBER LONDON", "LONDON PLUMBERS", "Manchester
       Plumber", "Electricians Leeds". Tradespeople title their OWN
       advertising/networking pages exactly this way, so everyone posting in
       them is already in the trade — worthless as customer leads even
       though the trade word is right there in the name.
     - Examples: "PLUMBER LONDON" -> trades. "Manchester Plumber" -> trades.
       "Find a Plumber East Midlands" -> customers. "Leeds Home Improvement
       Recommendations" -> customers.

2. "country_code" — the ISO 3166-1 alpha-2 code (e.g. "GB", "US", "CA", "FR",
   "DE") of where the group is based, or null if you can't tell.

3. "city" — the city/town named in the group, or null if none is named.

CRITICAL — do not default a famous city name to its most famous country.
Read the WHOLE name for a qualifier that overrides the obvious guess:
  - "HANDYMAN SERVICES LONDON, Ontario" -> city "London", country_code "CA".
    Ontario is a Canadian province, not a London neighbourhood — the explicit
    qualifier wins over the reflex "London = UK" guess.
  - "ATLANTA HANDYMAN SERVICES" -> city "Atlanta", country_code "US" (no
    other well-known Atlanta).
  - "Find a Tradesman Bristol and surrounding" -> city "Bristol",
    country_code "GB" (nothing in the name contradicts the obvious UK city).
  - A French, German, Dutch, Vietnamese, etc. group name is still a strong
    signal on its own (e.g. "je cherche un electricien" implies France;
    "Netzwerk Frankfurt" implies Germany) even without an explicit country
    word — read the language together with any place name.

Return ONLY a JSON object, no preamble or markdown:
{{"labels": [{{"audience": "customers", "country_code": "GB", "city": "Bristol"}}, ...]}}

The "labels" array MUST have exactly {len(groups)} entries, in the same order
as the input.

Groups:
{numbered}
"""

    url = (
        'https://generativelanguage.googleapis.com/v1beta/models/'
        f'gemini-2.5-flash:generateContent?key={api_key}'
    )
    payload = {
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {
            'temperature': 0.1,
            'maxOutputTokens': 8192,
            'responseMimeType': 'application/json',
        },
    }

    try:
        import requests as _requests  # noqa: WPS433 — lazy
        resp = _requests.post(url, json=payload, timeout=timeout_s)
        resp.raise_for_status()
        body = resp.json()
        text = (
            body.get('candidates', [{}])[0]
                .get('content', {})
                .get('parts', [{}])[0]
                .get('text', '')
        ).strip()
        if not text:
            print(
                f'[group-labeller] empty response from Gemini; body summary: {str(body)[:500]}',
                file=sys.stderr,
            )
            return None
        parsed = json.loads(text)
        labels = parsed.get('labels')
        if not isinstance(labels, list) or len(labels) != len(groups):
            print(
                f'[group-labeller] label count mismatch '
                f'(expected {len(groups)}, got {len(labels) if isinstance(labels, list) else "non-list"})',
                file=sys.stderr,
            )
            return None
        cleaned: list[dict] = []
        for entry in labels:
            if not isinstance(entry, dict):
                cleaned.append({'audience': 'unclear', 'country_code': None, 'city': None})
                continue
            audience = entry.get('audience')
            if audience not in ('customers', 'trades', 'unclear'):
                audience = 'unclear'
            country_code = entry.get('country_code')
            if isinstance(country_code, str) and len(country_code.strip()) == 2 and country_code.strip().isalpha():
                country_code = country_code.strip().upper()
            else:
                country_code = None
            city = entry.get('city')
            city = city.strip() if isinstance(city, str) and city.strip() else None
            cleaned.append({'audience': audience, 'country_code': country_code, 'city': city})
        return cleaned
    except Exception as exc:  # noqa: BLE001
        print(f'[group-labeller] failed: {exc}', file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Low-level Gemini helper — plain-text response (no JSON mode)
# ---------------------------------------------------------------------------

def _gemini_text_call(prompt: str, *, timeout_s: int = 20) -> str:
    """POST a single prompt to Gemini Flash and return the raw text response.

    Raises on HTTP / network errors — callers are responsible for catching.
    Returns '' if the candidate text is absent (safety filter, budget exhausted,
    etc.).
    """
    api_key = os.environ.get('GEMINI_API_KEY') or os.environ.get('NEXT_PUBLIC_GEMINI_API_KEY')
    url = (
        'https://generativelanguage.googleapis.com/v1beta/models/'
        f'gemini-2.5-flash:generateContent?key={api_key}'
    )
    payload = {
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {
            'temperature': 0.7,
            # gemini-2.5-flash spends thinking tokens AGAINST maxOutputTokens
            # before emitting visible text. 256 was exhausted before the comment
            # finished (live truncation: "...going on for"). 1024 leaves ample
            # headroom — a 2-sentence comment is ~60 tokens; the classifier
            # in this file uses 8192 for the same reason.
            'maxOutputTokens': 1024,
            # No responseMimeType — we want natural prose output
        },
    }
    import requests as _requests  # noqa: WPS433 — lazy
    resp = _requests.post(url, json=payload, timeout=timeout_s)
    resp.raise_for_status()
    body = resp.json()
    return (
        body.get('candidates', [{}])[0]
            .get('content', {})
            .get('parts', [{}])[0]
            .get('text', '')
    ).strip()


# ---------------------------------------------------------------------------
# Per-post comment drafter
# ---------------------------------------------------------------------------

def draft_comment_from_post(
    post_excerpt: str,
    niche: str,
    *,
    brand: str = 'OptiRate',
    tone: str = 'helpful, human, non-salesy',
) -> Optional[str]:
    """Draft ONE short FB comment tailored to a specific post.

    Per-post, never templated: the comment must reference what the post
    actually says. Returns None when GEMINI_API_KEY is unset or the call
    fails — the operator then writes their own.
    """
    if not (os.environ.get('GEMINI_API_KEY') or os.environ.get('NEXT_PUBLIC_GEMINI_API_KEY')):
        return None
    prompt = (
        f"You are a {tone} small-business owner replying on Facebook as {brand}.\n"
        f"Service area/niche: {niche}.\n"
        f"Write ONE short (max 2 sentences) comment replying to THIS post. "
        f"Reference what they actually asked. No links, no hard sell, no emojis spam.\n\n"
        f"POST:\n{post_excerpt}\n\nCOMMENT:"
    )
    try:
        text = _gemini_text_call(prompt)
        return (text or '').strip() or None
    except Exception:  # noqa: BLE001
        return None
