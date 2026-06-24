"""Shared undetected-chromedriver opener for social-platform scrapers.

Extracted verbatim from facebook.py's ``_open_driver`` so that both
Facebook and Instagram can open the SAME proxy-aware, persistent-profile
Chrome session. Facebook's residential-proxy wiring (selenium-wire) +
persistent Brave profile is the only browser stack that reliably keeps
these accounts from being checkpointed; Instagram reuses it via this
module rather than maintaining a divergent copy.

⚠️  Facebook is in active production. The opener body below is a
    byte-for-byte move of FB's logic — same flags, same proxy path,
    same window size, same Chrome-version pinning, same SingletonLock
    cleanup. The only generalizations are: the persistent-profile env
    var name, an optional user-agent argument, a configurable window
    size, and the proxy-location source (passed in rather than read
    from facebook's module global). Do NOT change behavior here without
    a live FB regression scrape.
"""
from __future__ import annotations

import os
import re
import sys
from typing import Optional

# How long to wait for individual page loads / scroll-stabilizations.
# Kept in sync with facebook.PAGE_LOAD_TIMEOUT.
PAGE_LOAD_TIMEOUT = 30


def _build_proxy_auth_extension(host: str, port: str, username: str, password: str) -> str:
    """Generate a temporary Chrome extension that auto-fills proxy auth.

    Chrome's --proxy-server flag intentionally rejects user:pass@host:port
    URLs (security-by-design; the dialog has to be filled by the user OR
    by an extension). The well-known workaround is a tiny extension that
    registers a webRequest.onAuthRequired listener and answers with the
    credentials. We generate one per driver session, drop it in /tmp,
    and load it via options.add_extension().
    """
    import zipfile
    import tempfile
    import textwrap

    manifest = textwrap.dedent('''
        {
            "version": "1.0.0",
            "manifest_version": 2,
            "name": "Residential Proxy Auth",
            "permissions": [
                "proxy", "tabs", "unlimitedStorage", "storage",
                "<all_urls>", "webRequest", "webRequestBlocking"
            ],
            "background": {"scripts": ["background.js"]},
            "minimum_chrome_version": "22.0.0"
        }
    ''').strip()
    background = textwrap.dedent(f'''
        var config = {{
            mode: "fixed_servers",
            rules: {{
                singleProxy: {{
                    scheme: "http",
                    host: "{host}",
                    port: parseInt({port})
                }},
                bypassList: ["localhost"]
            }}
        }};
        chrome.proxy.settings.set({{value: config, scope: "regular"}}, function() {{}});
        chrome.webRequest.onAuthRequired.addListener(
            function(details) {{
                return {{authCredentials: {{username: "{username}", password: "{password}"}}}};
            }},
            {{urls: ["<all_urls>"]}},
            ['blocking']
        );
    ''').strip()
    fd, path = tempfile.mkstemp(suffix='_proxy_auth.zip')
    os.close(fd)
    with zipfile.ZipFile(path, 'w') as zp:
        zp.writestr('manifest.json', manifest)
        zp.writestr('background.js', background)
    return path


def resolve_proxy_country(location: Optional[str], fallback: str = 'AT') -> str:
    """Pick the residential-proxy country code that matches the operator's
    location. Falls back to whatever country code is baked into the
    proxy credentials when we can't map the location.
    """
    if not location:
        return fallback
    loc = location.strip()
    # Already an ISO-2 country code? The country-pinned-fleet path sets
    # _CURRENT_LOCATION to the claimed account's own country (e.g. 'PH',
    # 'US') — an ISO code, not a city. _extract_country_from_excerpt only
    # maps CITY names, so an ISO code would miss and fall back to 'AT',
    # silently routing a PH account through an Austrian IP. Accept ISO
    # codes directly so the proxy matches the account's pinned country.
    if len(loc) == 2 and loc.isalpha():
        return loc.upper()
    # Lazy import to avoid a circular import: facebook.py imports this
    # module, and _extract_country_from_excerpt stays in facebook.py.
    from tools.scraper.platforms.facebook import _extract_country_from_excerpt
    cc = _extract_country_from_excerpt(loc)
    return cc if cc else fallback


def apply_proxy_country(username: str, cc: str) -> str:
    """Swap the country code inside a residential-proxy username so the
    proxy issues an IP from the requested country. Each provider has
    a slightly different convention:

      Proxy Lite : pl-XYZ_area-AT          -> pl-XYZ_area-GB
      Proxio     : abc-region-AT           -> abc-region-GB
      Bright Data: lum-customer-X-cc-at    -> lum-customer-X-cc-gb

    We pattern-match the common ones rather than hard-coding a single
    convention so swapping providers via env vars doesn't require code.
    """
    # _area-XX (Proxy Lite, Smartproxy variants)
    out = re.sub(r'(?<=_area-)[A-Za-z]{2}\b', cc.upper(), username)
    # -region-XX (Proxio)
    out = re.sub(r'(?<=-region-)[A-Za-z]{2}\b', cc.upper(), out)
    # _country-XX (Enigma format, but theirs is in the PASSWORD — see
    # apply_proxy_country_password). Include here for providers that
    # use it in username too.
    out = re.sub(r'(?<=_country-)[A-Za-z]{2}\b', cc.upper(), out)
    # -cc-XX (some Bright Data variants)
    out = re.sub(r'(?<=-cc-)[A-Za-z]{2}\b', cc.lower(), out)
    return out


def apply_proxy_country_password(password: str, cc: str) -> str:
    """Some providers put the country code in the PASSWORD slot
    (Enigma: 58fc5cbc0ebf_country-AT). Same pattern set, applied
    to the password string.
    """
    out = re.sub(r'(?<=_country-)[A-Za-z]{2}\b', cc.upper(), password)
    out = re.sub(r'(?<=_area-)[A-Za-z]{2}\b', cc.upper(), out)
    return out


def _detect_chrome_major_version() -> Optional[int]:
    """Read installed Chrome's major version so chromedriver matches.

    Supports Windows (typical dev machine) and Linux (EC2 worker / Cloud
    Run). On Linux, Chrome was installed via `apt install
    google-chrome-stable_current_amd64.deb` so the binary lives at
    /usr/bin/google-chrome. We call it with --version because Linux
    binaries don't expose VersionInfo the way Windows PEs do.
    """
    import re
    import subprocess
    win_candidates = [
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    ]
    linux_candidates = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
    ]
    candidates = linux_candidates if sys.platform.startswith('linux') else win_candidates
    chrome_path = next((p for p in candidates if os.path.isfile(p)), None)
    if not chrome_path:
        return None
    try:
        if sys.platform.startswith('linux'):
            out = subprocess.check_output(
                [chrome_path, '--version'],
                text=True, timeout=5,
            ).strip()
        else:
            out = subprocess.check_output(
                ['powershell', '-NoProfile', '-Command',
                 f"(Get-Item '{chrome_path}').VersionInfo.ProductVersion"],
                text=True, timeout=5,
            ).strip()
        # Linux output: "Google Chrome 148.0.7778.215"
        # Windows output: "148.0.7778.215"
        m = re.search(r'(\d+)\.', out)
        return int(m.group(1)) if m else None
    except Exception:  # noqa: BLE001
        return None


def open_uc_driver(
    profile_dir_env: str,
    *,
    user_agent: Optional[str] = None,
    window_size: tuple[int, int] = (1280, 900),
    headless: Optional[bool] = None,
    proxy_location: Optional[str] = None,
):
    """Open an undetected-chromedriver, headless if PLAYWRIGHT_HEADLESS=true.

    On Linux hosts (EC2 worker / Cloud Run) AND when the
    RESIDENTIAL_PROXY_* env vars are set, routes all Chrome traffic
    through the residential proxy so the platform sees a consumer IP
    instead of a datacenter IP. Windows / local runs use the
    operator's home IP directly — no point burning paid proxy
    bandwidth when the platform already trusts the residential connection.

    Parameterized out of facebook.py so Instagram can reuse it:
      • ``profile_dir_env`` — env var naming the persistent user-data-dir
        (FB passes 'FB_PROFILE_DIR').
      • ``user_agent`` — if set, adds --user-agent; FB passes None.
      • ``window_size`` — (W, H) for --window-size.
      • ``headless`` — explicit override; None defers to PLAYWRIGHT_HEADLESS.
      • ``proxy_location`` — city/location string the proxy country-code
        resolver maps to a country (FB passes its module global).
    """
    import undetected_chromedriver as uc  # noqa: WPS433 — lazy

    if headless is None:
        headless = os.getenv('PLAYWRIGHT_HEADLESS', 'false').lower() == 'true'
    # Persistent-profile mode (2026-05-30): when the profile-dir env var
    # is set, Chrome loads its entire user-data-dir from disk (cookies +
    # localStorage + IndexedDB + fingerprint state). The profile is
    # minted once by the operator via scripts/ec2-fb-login-session.sh
    # and reused by every subsequent scrape — same Chrome instance,
    # same fingerprint, no cross-machine cookie transplant for FB to
    # flag as a new device. FB_PROFILE_HEADFUL=true forces headful
    # (used by the login flow); scraping honors PLAYWRIGHT_HEADLESS.
    profile_dir = os.environ.get(profile_dir_env)
    if profile_dir and os.environ.get('FB_PROFILE_HEADFUL', '').lower() == 'true':
        headless = False
    options = uc.ChromeOptions()
    # Browser binary resolution. By default undetected-chromedriver
    # auto-detects Google Chrome in standard locations. On the Windows
    # EC2 worker we use BRAVE instead (better fingerprint resistance,
    # no Google Chrome installed), so we set options.binary_location
    # explicitly. Order:
    #   1. BROWSER_BIN env var (override)
    #   2. Brave at common Windows paths (per-user LOCALAPPDATA first,
    #      then Program Files variants)
    #   3. Leave unset → uc auto-detects Chrome (Linux EC2 path)
    browser_bin = os.environ.get('BROWSER_BIN')
    if not browser_bin and sys.platform == 'win32':
        for candidate in (
            os.path.join(os.environ.get('LOCALAPPDATA', ''), 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            r'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe',
            r'C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe',
        ):
            if candidate and os.path.exists(candidate):
                browser_bin = candidate
                break
    if browser_bin:
        options.binary_location = browser_bin
        print(f'INFO: using browser binary {browser_bin}', file=sys.stderr)
    if headless:
        options.add_argument('--headless=new')
    if profile_dir:
        # Clean up stale Brave/Chromium singleton lock files. When a prior
        # Brave crashed (or was killed) it leaves SingletonLock/Cookie/Socket
        # behind, and the next launch with --user-data-dir refuses to start.
        # Manifests as `undetected_chromedriver!GetHandleVerifier` native
        # crashes on the second invocation. Cleanup is safe because we only
        # remove these files when we are about to start the only legitimate
        # Brave that should be using this profile.
        for stale in ('SingletonLock', 'SingletonCookie', 'SingletonSocket'):
            stale_path = os.path.join(profile_dir, stale)
            try:
                os.remove(stale_path)
                print(f'INFO: removed stale {stale} from profile', file=sys.stderr)
            except FileNotFoundError:
                pass
            except OSError as exc:
                print(f'WARN: could not remove {stale_path}: {exc}', file=sys.stderr)
        options.add_argument(f'--user-data-dir={profile_dir}')
        print(f'INFO: using persistent Chrome profile at {profile_dir}', file=sys.stderr)
    if user_agent is not None:
        options.add_argument(f'--user-agent={user_agent}')
    options.add_argument(f'--window-size={window_size[0]},{window_size[1]}')
    options.add_argument('--lang=en-US,en')
    options.add_argument('--disable-blink-features=AutomationControlled')
    # Grant clipboard read/write so _click_share_and_capture() can read
    # the /share/p/<token>/ URL that FB writes when "Copy link" is clicked.
    # Without this Chrome blocks navigator.clipboard.readText() with
    # NotAllowedError. The "*" pattern grants for all origins (we're a
    # single-purpose scraper instance).
    options.add_experimental_option(
        'prefs',
        {
            'profile.content_settings.exceptions.clipboard': {
                '[*.]facebook.com,*': {'setting': 1},
            },
        },
    )
    # Linux-server essentials. Chrome's renderer process crashes
    # without these on headless EC2 / Cloud Run hosts because the
    # sandbox needs user-namespace cloning (not always available),
    # /dev/shm is tiny on most containers, and there's no GPU.
    # These flags are harmless on Windows dev machines but only
    # appended on Linux to keep dev-mode security checks intact.
    if sys.platform.startswith('linux'):
        options.add_argument('--no-sandbox')
        options.add_argument('--disable-dev-shm-usage')
        options.add_argument('--disable-gpu')

    # Residential proxy wiring. Only kicks in on Linux (server) AND when
    # all four env vars are set. Local runs always use the host's own IP.
    proxy_host = os.environ.get('RESIDENTIAL_PROXY_HOST')
    proxy_port = os.environ.get('RESIDENTIAL_PROXY_PORT')
    proxy_user = os.environ.get('RESIDENTIAL_PROXY_USERNAME')
    proxy_pass = os.environ.get('RESIDENTIAL_PROXY_PASSWORD')
    proxy_force = os.environ.get('RESIDENTIAL_PROXY_FORCE', '').lower() == 'true'
    proxy_active = (
        (sys.platform.startswith('linux') or proxy_force)
        and proxy_host and proxy_port and proxy_user and proxy_pass
    )
    seleniumwire_options: Optional[dict] = None
    if proxy_active:
        cc = resolve_proxy_country(proxy_location)
        proxy_user_rewritten = apply_proxy_country(proxy_user, cc)
        proxy_pass_rewritten = apply_proxy_country_password(proxy_pass, cc)
        # selenium-wire intercepts traffic locally and handles proxy auth
        # in Python — required because Manifest V2 auth extensions are
        # silently disabled by Chrome 128+ in --headless=new mode (the
        # blank page we got from api.ipify.org through the proxy was
        # Chrome receiving a 407, no extension responding, page erroring
        # to ""). undetected-chromedriver detects seleniumwire_options
        # and uses selenium-wire's driver internally — same uc.Chrome
        # call, just with an extra kwarg.
        proxy_url = f'http://{proxy_user_rewritten}:{proxy_pass_rewritten}@{proxy_host}:{proxy_port}'
        seleniumwire_options = {
            'proxy': {
                'http': proxy_url,
                'https': proxy_url,
                'no_proxy': 'localhost,127.0.0.1',
            },
            # selenium-wire MITMs HTTPS to inspect requests — accepting
            # its self-signed CA is required for Chrome to trust the
            # intercepted certs. The CA is generated per process; no
            # security risk because nothing else trusts it.
            'verify_ssl': False,
            'disable_capture': True,
        }
        # Chrome refuses to load HTTPS pages through selenium-wire by
        # default because the MITM cert is signed by an unknown CA
        # (selenium-wire generates a per-process root CA in
        # ~/.mitmproxy and signs per-domain leaves). The proper fix is
        # to install that CA in the OS trust store, but for a scraper
        # process we just trust everything — the only "attacker" in
        # the cert chain is our own local interceptor.
        options.add_argument('--ignore-certificate-errors')
        options.add_argument('--ignore-ssl-errors=yes')
        options.add_argument('--allow-running-insecure-content')
        print(
            f'INFO: residential proxy active {proxy_host}:{proxy_port} cc={cc} (selenium-wire)',
            file=sys.stderr,
        )

    # Pin chromedriver to installed Chrome major version so we don't get
    # the version-149-but-Chrome-148 mismatch.
    version_main: Optional[int] = None
    override = os.getenv('SOCIAL_CHROME_VERSION')
    if override and override.isdigit():
        version_main = int(override)
    else:
        version_main = _detect_chrome_major_version()
    if version_main:
        print(f'INFO: pinning chromedriver to Chrome major version {version_main}', file=sys.stderr)
    if seleniumwire_options:
        # selenium-wire ships its own undetected-chromedriver wrapper —
        # plain `uc.Chrome(seleniumwire_options=...)` accepts the kwarg
        # but doesn't actually wire selenium-wire's interceptor in
        # (uc.Chrome forwards **kwargs to selenium's Chrome which then
        # silently drops the unknown kwarg). The Singapore EC2 IP we
        # got back from api.ipify.org through the proxy was the
        # signature: selenium-wire was being skipped, Chrome went
        # direct. The seleniumwire.undetected_chromedriver wrapper
        # registers the local intercepting proxy and patches Chrome's
        # --proxy-server flag to point at it, before delegating to
        # undetected-chromedriver for the stealth patches.
        from seleniumwire.undetected_chromedriver import Chrome as WireUCChrome  # noqa: WPS433
        driver = WireUCChrome(
            options=options,
            seleniumwire_options=seleniumwire_options,
            use_subprocess=True,
            version_main=version_main,
        )
    else:
        driver = uc.Chrome(options=options, use_subprocess=True, version_main=version_main)
    driver.set_page_load_timeout(PAGE_LOAD_TIMEOUT)
    # CDP-level clipboard grant. Required for navigator.clipboard.readText()
    # to succeed in _click_share_and_capture(). The prefs route only covers
    # fresh profiles — existing user-data-dir profiles ignore it. CDP grant
    # applies to the live session unconditionally.
    try:
        driver.execute_cdp_cmd(
            'Browser.grantPermissions',
            {
                'origin': 'https://www.facebook.com',
                'permissions': ['clipboardReadWrite', 'clipboardSanitizedWrite'],
            },
        )
    except Exception as exc:  # noqa: BLE001
        print(f'WARN: clipboard CDP grant failed (Share->Copy link fallback will not work): {exc}', file=sys.stderr)
    return driver
