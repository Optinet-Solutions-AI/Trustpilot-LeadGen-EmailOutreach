# FB Niche Auto-Translate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an operator submits a FB consumer scrape with an English niche term (`electrician`) and a non-English-primary city (`Frankfurt`), the scraper translates the niche to the local language (`Elektriker`) before group discovery + per-group search, and the Gemini consumer-classifier accepts native-language posts as valid leads.

**Architecture:** Two surgical edits to one Python file (`tools/scraper/platforms/facebook.py`). One new module-level helper + cache. One existing function (the Gemini classifier prompt) loses its English-only guard. No new files; no run.py changes; no frontend changes; no DB schema changes.

**Tech Stack:** Python 3 (existing scraper). Gemini 2.5 Flash via the same API endpoint `_classify_consumer_posts_with_gemini` already uses. In-process Python `dict` for cache (rebuilds on worker restart; the cache miss costs ~0.5s of Gemini latency).

---

## Why this plan is contained

Today's electrician+Frankfurt scrape proved the group-first architecture works structurally:
- ✓ Discovered 10 Frankfurt groups
- ✓ Filtered to 5 consumer-facing
- ✓ Scraped 34 posts across them
- ✗ Gemini classifier rejected all 17 substring-survivors with "wrong location" (a hard-coded English-bias guard in the prompt)

The English bias is in *one* code path (`_classify_consumer_posts_with_gemini`) and the niche-language mismatch is solvable at *one* code path (`_sync_group_first_scrape`). Both live in `facebook.py`.

Existing helpers we reuse:
- `_extract_country_from_excerpt(text)` at `facebook.py:541` — text → ISO country code. Already has 100+ city→country pairs including Frankfurt→DE, Rome→IT, etc.
- `_classify_consumer_posts_with_gemini` at `facebook.py:314` — Gemini API call boilerplate (URL, JSON payload, response parsing). We replicate ~10 lines of it for the translation call.
- `_sync_group_first_scrape` at `facebook.py:1833` — orchestrator; takes `(niche, location)` and does discover → per-group search → aggregate.
- `_emit` at `facebook.py:59` — SSE progress event emitter.

---

## File structure (existing file only)

```
tools/scraper/platforms/facebook.py
├── COUNTRY_TO_LANGUAGE              ← NEW module-level constant (Task 1)
├── _NICHE_TRANSLATION_CACHE         ← NEW module-level dict (Task 1)
├── _translate_niche_to_local        ← NEW helper (Task 2)
├── _sync_group_first_scrape         ← MODIFY (Task 3): call translation before discovery
└── _classify_consumer_posts_with_gemini  ← MODIFY (Task 4): drop English-only guard
```

---

## Task 1: Add `COUNTRY_TO_LANGUAGE` map + translation cache at module scope

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (add near the existing `_BROAD_POST_URL_RE` constant ~line 54)

- [ ] **Step 1.1: Locate the insertion point**

Run: `grep -n "_BROAD_POST_URL_RE = re.compile" tools/scraper/platforms/facebook.py | head -2`

Expected output: one line, e.g. `54:_BROAD_POST_URL_RE = re.compile('|'.join([`. Find the closing `]))` of that block (~line 72). The new constants insert right after.

- [ ] **Step 1.2: Add the COUNTRY_TO_LANGUAGE map + cache dict**

Open `tools/scraper/platforms/facebook.py`. After the closing `]))` of `_BROAD_POST_URL_RE` and the trailing blank line, before the `def _now_iso():` function definition, insert:

```python
# ISO country code → primary spoken language name (in English).
# Used by _translate_niche_to_local to ask Gemini for the native niche term
# when the operator submits an English term + a non-English city. Keep in
# sync with _extract_country_from_excerpt's CITY_TO_COUNTRY mapping at
# line ~556 below: every country that appears there should appear here.
#
# Skip entries (omit a country from this dict) when:
#   - the country is English-primary (UK, US, IE, CA, AU, NZ, SG, PH, IN, ZA)
#   - the country has multiple official languages and no clear single
#     consumer-FB-post default — caller falls back to skip-translate
COUNTRY_TO_LANGUAGE: dict[str, str] = {
    'DE': 'German',
    'AT': 'German',
    'CH': 'German',  # majority — Italian/French regions skip translate
    'FR': 'French',
    'BE': 'Dutch',   # Brussels can be French — picked Dutch as FB-more-active
    'NL': 'Dutch',
    'IT': 'Italian',
    'ES': 'Spanish',
    'PT': 'Portuguese',
    'BR': 'Portuguese',
    'MX': 'Spanish',
    'PL': 'Polish',
    'CZ': 'Czech',
    'SK': 'Slovak',
    'HU': 'Hungarian',
    'RO': 'Romanian',
    'BG': 'Bulgarian',
    'GR': 'Greek',
    'HR': 'Croatian',
    'SI': 'Slovenian',
    'RS': 'Serbian',
    'AL': 'Albanian',
    'MK': 'Macedonian',
    'ME': 'Montenegrin',
    'BA': 'Bosnian',
    'TR': 'Turkish',
    'SE': 'Swedish',
    'DK': 'Danish',
    'NO': 'Norwegian',
    'FI': 'Finnish',
    'IS': 'Icelandic',
    'LT': 'Lithuanian',
    'LV': 'Latvian',
    'EE': 'Estonian',
    'MD': 'Romanian',
    'UA': 'Ukrainian',
    'CY': 'Greek',
    'MT': 'Maltese',
    'LU': 'German',  # also French/Lëtzebuergesch — German is most-FB-active
}

# In-process cache: (language, niche_slug) → native_term
# Avoids hitting Gemini for every scrape when the same niche+language combo
# repeats. Cache lives for the worker process lifetime; warms up in <60s
# of normal use. Keys are lower-case for case-insensitive hits.
_NICHE_TRANSLATION_CACHE: dict[tuple[str, str], str] = {}
```

- [ ] **Step 1.3: Syntax-check**

Run: `.venv/Scripts/python.exe -m py_compile tools/scraper/platforms/facebook.py && echo OK`
Expected: `OK`

- [ ] **Step 1.4: Commit**

```bash
git add tools/scraper/platforms/facebook.py
git commit -m "feat(scraper): add COUNTRY_TO_LANGUAGE map + niche-translation cache scaffolding"
```

---

## Task 2: Implement `_translate_niche_to_local` helper

**Files:**
- Modify: `tools/scraper/platforms/facebook.py` (add a new top-level function near `_classify_consumer_posts_with_gemini` at line ~314)

The helper takes a niche + location, derives the country via `_extract_country_from_excerpt`, looks up the language via `COUNTRY_TO_LANGUAGE`, checks cache, falls back to Gemini, and caches the result.

- [ ] **Step 2.1: Locate the insertion point**

Run: `grep -n "^def _classify_consumer_posts_with_gemini" tools/scraper/platforms/facebook.py`

Expected: one line like `314:def _classify_consumer_posts_with_gemini(`. The new helper goes RIGHT ABOVE this function (so both Gemini-using helpers cluster together).

- [ ] **Step 2.2: Add the helper function**

Insert immediately above `def _classify_consumer_posts_with_gemini(` (before the `def` line, after any preceding blank lines):

```python
def _translate_niche_to_local(
    niche: str,
    location: str,
    *,
    timeout_s: int = 15,
) -> Optional[str]:
    """Translate a niche term to the local language of the given location.

    Returns the translated term on success. Returns None when:
      - location can't be mapped to a country (e.g. unknown city)
      - country is English-primary (no translation needed)
      - country has no entry in COUNTRY_TO_LANGUAGE (multilingual edge case)
      - GEMINI_API_KEY is unset or the API call fails

    Caller should treat None as "use original niche unchanged" — DO NOT
    fall back to a different niche; we'd rather under-translate than
    pick something semantically wrong.

    Cache lookup is O(1) on (language_lower, niche_lower). The first call
    for a new combo costs ~0.5s of Gemini latency; subsequent calls are
    free for the worker's lifetime.
    """
    if not niche or not location:
        return None

    country = _extract_country_from_excerpt(location)
    if not country:
        return None  # unknown city — caller uses original niche

    language = COUNTRY_TO_LANGUAGE.get(country)
    if not language:
        return None  # English-primary OR multilingual without default

    # Cache check (case-insensitive)
    cache_key = (language.lower(), niche.lower().strip())
    if cache_key in _NICHE_TRANSLATION_CACHE:
        return _NICHE_TRANSLATION_CACHE[cache_key]

    api_key = os.environ.get('GEMINI_API_KEY') or os.environ.get('NEXT_PUBLIC_GEMINI_API_KEY')
    if not api_key:
        return None

    # Prompt design: short, deterministic, JSON-only. Ask for the most
    # common consumer-facing word a real local would use in a casual FB
    # group post — NOT a formal/dictionary translation. e.g. for "plumber"
    # in Italian we want "idraulico", not "addetto agli impianti idraulici".
    prompt = f"""You are translating a service-provider niche term for a Facebook group search.

Niche: "{niche}"
Target language: {language}

Return the single most common consumer-facing word(s) a native speaker of {language} would use when asking for this service in a casual community Facebook post. NOT the formal/professional/dictionary term — the everyday term.

Rules:
- 1-3 words maximum
- Lowercase unless the language requires capitalization (e.g. German nouns)
- Use diacritics correctly (é, ñ, ü, ß, etc.)
- No quotation marks, no explanations, no alternatives
- If the niche is already in {language}, return it unchanged
- If no good translation exists in {language}, return the niche unchanged

Return ONLY a JSON object with this exact shape:
{{"native_term": "..."}}
"""

    url = (
        'https://generativelanguage.googleapis.com/v1beta/models/'
        f'gemini-2.5-flash:generateContent?key={api_key}'
    )
    payload = {
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {
            'temperature': 0.1,
            'maxOutputTokens': 64,
            'responseMimeType': 'application/json',
        },
    }

    try:
        import requests as _requests  # lazy
        resp = _requests.post(url, json=payload, timeout=timeout_s)
        resp.raise_for_status()
        body = resp.json()
        text = (
            body.get('candidates', [{}])[0]
                .get('content', {})
                .get('parts', [{}])[0]
                .get('text', '')
        ).strip()
        parsed = json.loads(text)
        native = (parsed.get('native_term') or '').strip()
        if not native or len(native) > 60:
            return None
        _NICHE_TRANSLATION_CACHE[cache_key] = native
        return native
    except Exception as exc:  # noqa: BLE001
        print(f'[niche-translate] failed for "{niche}" -> {language}: {exc}', file=sys.stderr)
        return None
```

- [ ] **Step 2.3: Syntax-check**

Run: `.venv/Scripts/python.exe -m py_compile tools/scraper/platforms/facebook.py && echo OK`
Expected: `OK`

- [ ] **Step 2.4: Commit**

```bash
git add tools/scraper/platforms/facebook.py
git commit -m "feat(scraper): _translate_niche_to_local helper with Gemini + in-process cache"
```

---

## Task 3: Wire `_translate_niche_to_local` into `_sync_group_first_scrape`

**Files:**
- Modify: `tools/scraper/platforms/facebook.py:1833-1850` (top of `_sync_group_first_scrape`)

Translate the niche before group discovery + per-group search. Emit the new `niche_translated` SSE event so the operator sees the translation in the live log.

- [ ] **Step 3.1: Re-read the current top of `_sync_group_first_scrape`**

Run: `grep -n "def _sync_group_first_scrape\|groups_raw = self._sync_discover_groups" tools/scraper/platforms/facebook.py | head -2`

Expected output:
```
1833:    def _sync_group_first_scrape(
1844:        groups_raw = self._sync_discover_groups(niche, location, on_progress)
```

The function takes `(self, niche, location, on_progress)` and immediately calls `_sync_discover_groups(niche, location, on_progress)`. We insert the translation step between the docstring (ends ~line 1842) and the discover call (line 1844).

- [ ] **Step 3.2: Insert translation BEFORE the discovery call**

Locate the existing code at the top of `_sync_group_first_scrape` body. After the docstring ends and before `groups_raw = self._sync_discover_groups(...)`, change the body to:

```python
        # Auto-translate niche to local language when the city is non-English.
        # Operator submits "electrician" + "Frankfurt" → we search FB groups
        # for "Elektriker Frankfurt" because that's what German consumers
        # actually post. Falls through silently if no translation available
        # (English-primary city, unknown city, or Gemini error).
        #
        # Operator escape hatch: pass disable_niche_translate=true in filters
        # to keep the literal niche. Wired in via the on_progress's parent
        # frame's filters — easiest path is to read it off self._current_filters
        # which scrape_listing sets, but consumer-mode goes through search_posts
        # not scrape_listing, so we just always translate (no escape hatch yet).
        translated = _translate_niche_to_local(niche, location)
        effective_niche = niche
        if translated and translated.strip().lower() != niche.strip().lower():
            effective_niche = translated
            _emit(
                on_progress,
                'niche_translated',
                **{
                    'from': niche,
                    'to': translated,
                    'location': location,
                },
            )

        groups_raw = self._sync_discover_groups(effective_niche, location, on_progress)
```

Then find the line later in the function that constructs the in-group keyword. Currently it's at line ~1859:

```python
        in_group_keyword = f'looking for a {niche}'
```

Replace with:

```python
        in_group_keyword = f'looking for a {effective_niche}'
```

- [ ] **Step 3.3: Verify there are no other references to `niche` in the function body that should use `effective_niche`**

Run: `grep -n "niche" tools/scraper/platforms/facebook.py | awk -F: 'NR>=1{print}' | head -40`

Look at lines 1833-1900 only. After Steps 3.2, every use of `niche` inside the function body should either:
- Be the original parameter name (acceptable if we want to keep the original for logging) OR
- Be `effective_niche` (for the translated value used in actual FB calls)

If you find any line inside this function still using `niche` to query FB (e.g. as part of a URL or search keyword), change it to `effective_niche`.

- [ ] **Step 3.4: Syntax-check**

Run: `.venv/Scripts/python.exe -m py_compile tools/scraper/platforms/facebook.py && echo OK`
Expected: `OK`

- [ ] **Step 3.5: Commit**

```bash
git add tools/scraper/platforms/facebook.py
git commit -m "feat(scraper): translate niche before FB group-first scrape for non-English cities"
```

---

## Task 4: Drop the English-only guard from `_classify_consumer_posts_with_gemini`

**Files:**
- Modify: `tools/scraper/platforms/facebook.py:357-366` (the `location_clause` f-string inside the Gemini classifier prompt)

The current prompt rejects English posts in non-English cities and accepts English posts in English-primary cities. Now that posts come back in the native language (because we translated the niche), the bifurcation is harmful — it would reject German posts about Frankfurt as "non-English text without explicit Frankfurt mention".

Replace with language-neutral logic: judge based on intent, regardless of post language.

- [ ] **Step 4.1: Re-read the current location_clause**

Run: `grep -n "location_clause = " tools/scraper/platforms/facebook.py`

Expected: one line at ~344 like `location_clause = (`. The current block ends at line ~367 with the closing `if location else ''`. Read it in full once.

- [ ] **Step 4.2: Replace the location_clause with language-neutral version**

Find this block (around lines 344-367):

```python
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
        f'  - If {location} is a city where ENGLISH IS NOT the primary spoken language (Rome, '
        f'    Paris, Tokyo, Berlin, Madrid, São Paulo, Moscow, Seoul, etc.), then an English-'
        f'    language post with NO explicit mention of {location} (no neighborhood, no '
        f'    postcode, no "I live in {location}", no flag emoji, no FB-tagged location) is '
        f'    almost certainly NOT from {location} — locals would post in their native '
        f'    language. Classify FALSE on insufficient location signal in this case.\n'
        f'  - If {location} is an ENGLISH-PRIMARY city (London, Manchester, Birmingham, NYC, '
        f'    Los Angeles, Sydney, Toronto, Dublin, etc.), an English post with no explicit '
        f'    location mention can still pass — the language matches, we cannot rule it out.\n'
        if location else ''
    )
```

Replace with:

```python
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
```

The substantive change: removed the two language-bifurcation rules at the bottom and replaced with a single language-agnostic rule that says "use city names as the signal, regardless of post language".

- [ ] **Step 4.3: Syntax-check**

Run: `.venv/Scripts/python.exe -m py_compile tools/scraper/platforms/facebook.py && echo OK`
Expected: `OK`

- [ ] **Step 4.4: Commit**

```bash
git add tools/scraper/platforms/facebook.py
git commit -m "fix(scraper): make Gemini consumer-classifier prompt language-agnostic"
```

---

## Task 5: Push, deploy to Windows EC2, verify with three scrapes

The Windows EC2 still requires manual deploy (Task Scheduler bug not fixed).

- [ ] **Step 5.1: Push all 4 commits**

```bash
git push origin main
```

Expected: `627076a..<new-SHA> main -> main` (4 new commits).

- [ ] **Step 5.2: Manual deploy on Windows EC2 (paste in SSM)**

```powershell
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
cd C:\scraper
git pull --ff-only origin main
git log -1 --oneline
nssm restart scraper-worker
Start-Sleep -Seconds 5
Get-Service scraper-worker | Format-List Name,Status
Remove-Item C:\scraper-deploy\last_attempted_commit -Force -ErrorAction SilentlyContinue
```

Expected: `git log` shows the Task 4 SHA (most recent), `Get-Service` shows `Status: Running`.

If `nssm restart` returns `Unexpected status SERVICE_PAUSED in response to START control.`, do a clean stop/start instead:

```powershell
nssm stop scraper-worker
Start-Sleep -Seconds 5
nssm start scraper-worker
Start-Sleep -Seconds 10
Get-Service scraper-worker | Format-List Name,Status
```

- [ ] **Step 5.3: Reset the cap before testing (we're going to fire 3 scrapes back-to-back)**

```bash
SUPABASE_URL=$(grep '^SUPABASE_URL=' .env | cut -d= -f2- | tr -d '"')
SUPABASE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env | cut -d= -f2- | tr -d '"')
ACCOUNT_ID="0eec969c-a888-4e54-bdfe-057ca11c2af5"
curl -sS "$SUPABASE_URL/rest/v1/social_accounts?id=eq.$ACCOUNT_ID" \
  -X PATCH \
  -H "apikey: $SUPABASE_KEY" \
  -H "Authorization: Bearer $SUPABASE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"used_today":0,"used_this_hour":0}'
```

Each scrape consumes ~30 cap units; 3 scrapes = ~90 units. Daily cap is 2000, so plenty of headroom.

- [ ] **Step 5.4: Verification scrape #1 — electrician + Frankfurt (was 0 leads, expect non-zero)**

```bash
SUPABASE_URL=$(grep '^SUPABASE_URL=' .env | cut -d= -f2- | tr -d '"')
SUPABASE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env | cut -d= -f2- | tr -d '"')
PAYLOAD='{"country":"_facebook_","category":"all","min_rating":1,"max_rating":3.5,"enrich":false,"verify":false,"status":"pending","platform":"facebook","source":"manual","priority":100,"max_attempts":3,"filters":{"niche":"electrician","query":"looking for electrician Frankfurt","enrich":false,"verify":false,"location":"Frankfurt","lead_type":"consumers","max_results":10}}'
curl -sS "$SUPABASE_URL/rest/v1/scrape_jobs" -X POST -H "apikey: $SUPABASE_KEY" -H "Authorization: Bearer $SUPABASE_KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" -d "$PAYLOAD" | head -c 200
```

Capture the job ID. Then poll until terminal (use the same polling pattern as previous verification runs).

Expected events in `recent_events`:
- `niche_translated: from=electrician to=Elektriker location=Frankfurt` ← new event proves Task 3 worked
- `groups_search_start: query=Elektriker Frankfurt` (NOT "electrician Frankfurt")
- `groups_found: count=<N>` where N > 0
- Per-group `group_progress` and `group_posts_kept` events
- `llm_filtered: dropped=X kept=Y` where Y > 0 (the new prompt accepts German posts)
- `completed` with `total_scraped > 0`

If `total_scraped` is still 0 after this run, sample one of the dropped posts and verify Gemini's reasoning was actually about location signal (not e.g. the prompt now passes "Elektriker" but Gemini still flags business-self-promotion as FALSE — which would be correct).

- [ ] **Step 5.5: Verification scrape #2 — plumber + Rome (expect translation to "idraulico")**

```bash
SUPABASE_URL=$(grep '^SUPABASE_URL=' .env | cut -d= -f2- | tr -d '"')
SUPABASE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env | cut -d= -f2- | tr -d '"')
PAYLOAD='{"country":"_facebook_","category":"all","min_rating":1,"max_rating":3.5,"enrich":false,"verify":false,"status":"pending","platform":"facebook","source":"manual","priority":100,"max_attempts":3,"filters":{"niche":"plumber","query":"looking for plumber Rome","enrich":false,"verify":false,"location":"Rome","lead_type":"consumers","max_results":10}}'
curl -sS "$SUPABASE_URL/rest/v1/scrape_jobs" -X POST -H "apikey: $SUPABASE_KEY" -H "Authorization: Bearer $SUPABASE_KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" -d "$PAYLOAD" | head -c 200
```

Expected `niche_translated: from=plumber to=idraulico location=Rome` event and non-zero leads. (Gemini may also return "idraulico" with slight variant; that's fine — anything reasonable for Italian "plumber" passes.)

- [ ] **Step 5.6: Verification scrape #3 — handyman + London (control: should NOT translate, same yield as before)**

```bash
SUPABASE_URL=$(grep '^SUPABASE_URL=' .env | cut -d= -f2- | tr -d '"')
SUPABASE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env | cut -d= -f2- | tr -d '"')
PAYLOAD='{"country":"_facebook_","category":"all","min_rating":1,"max_rating":3.5,"enrich":false,"verify":false,"status":"pending","platform":"facebook","source":"manual","priority":100,"max_attempts":3,"filters":{"niche":"handyman","query":"looking for handyman London","enrich":false,"verify":false,"location":"London","lead_type":"consumers","max_results":10}}'
curl -sS "$SUPABASE_URL/rest/v1/scrape_jobs" -X POST -H "apikey: $SUPABASE_KEY" -H "Authorization: Bearer $SUPABASE_KEY" -H "Content-Type: application/json" -H "Prefer: return=representation" -d "$PAYLOAD" | head -c 200
```

Expected:
- NO `niche_translated` event (London → GB, which is not in COUNTRY_TO_LANGUAGE → translation skipped)
- Yield similar to today's earlier run (~25-35 leads)

If a `niche_translated` event DOES fire on this scrape, Task 1's `COUNTRY_TO_LANGUAGE` map is wrong — confirm GB is NOT in the dict.

- [ ] **Step 5.7: Sanity-check sample translations in the cache (optional)**

If you want to confirm the cache is populated after the runs, you'd have to read it from the worker's Python process — which isn't easy without a debug endpoint. Skip this; the SSE events from Steps 5.4-5.5 already prove the translation fired.

---

## Self-Review

**Spec coverage** ✓
- Spec Part 1 (auto-translate niche) → Tasks 1-3 ✓
- Spec Part 1 escape hatches:
  - English-primary city → COUNTRY_TO_LANGUAGE omits GB/US/IE/etc. ✓
  - Unknown city → `_extract_country_from_excerpt` returns None → helper returns None ✓
  - `disable_niche_translate=true` filter → **GAP** — the plan notes this in Step 3.2 but doesn't implement it. Acceptable for v1 since the plan describes the gap explicitly and the escape hatch is low-priority (no operator has asked for it). Add a sentence to Step 3.2 noting this and continue.
- Spec Part 1 `niche_translated` SSE event → Step 3.2 emits it ✓
- Spec Part 2 (multilingual classifier) → Task 4 ✓
- Spec Verification (Frankfurt + Rome + London) → Steps 5.4-5.6 ✓

**Placeholder scan** ✓
No TBDs, no "implement later". Every step has concrete code or commands. The escape-hatch gap is explicit and intentional (Step 3.2's inline note).

**Type consistency** ✓
- `COUNTRY_TO_LANGUAGE: dict[str, str]` (Task 1) — keys are 2-letter ISO codes, values are language names; consumed by `_translate_niche_to_local` in Task 2.
- `_NICHE_TRANSLATION_CACHE: dict[tuple[str, str], str]` (Task 1) — keys are (language_lower, niche_lower) tuples; populated and read by `_translate_niche_to_local` (Task 2).
- `_translate_niche_to_local(niche, location) -> Optional[str]` — caller in Task 3.2 handles None correctly (`if translated and ... != niche`).
- `effective_niche` local variable (Task 3.2) is used for downstream FB calls; `niche` parameter is preserved for original-value logging in the `niche_translated` event.

**Scope check** ✓
Four small Python edits to one file, in one PR. Inline-execution friendly. ~2-2.5 hours of focused work + verification scrape wall time (3 × ~15 min = 45 min, mostly idle).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-05-fb-niche-auto-translate.md`. Two execution options:

**1. Subagent-Driven** — fresh subagent per task, review between tasks
**2. Inline Execution** — execute tasks in this session using executing-plans

For 4 surgical Python edits in one file with a clear sequence, **inline execution** is the right call.

**Which approach?**
