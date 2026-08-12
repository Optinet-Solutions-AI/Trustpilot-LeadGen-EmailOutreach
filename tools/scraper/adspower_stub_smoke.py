"""Verify the AdsPower driver path end to end WITHOUT an AdsPower subscription.

WHY THIS EXISTS

  AdsPower's Local API is paid-only (confirmed 2026-07-31 from the client UI:
  "This feature is only available for paid plans"). That left every piece of
  the AdsPower integration - adspower.start_profile, uc_driver's
  _open_adspower_driver, and the branch inside open_uc_driver - verified
  against mocks only. Nothing had proven that attaching Selenium over CDP
  actually drives a real browser.

  This harness closes that gap for $0. It:

    1. Launches a real Chrome/Brave with --remote-debugging-port.
    2. Serves a stub HTTP endpoint that speaks AdsPower's documented Local API
       shape, pointing data.ws.selenium at that debug port.
    3. Points ADSPOWER_API_BASE at the stub and calls the REAL production
       entry point - open_uc_driver(..., adspower_profile_id=...).
    4. Drives the returned driver and asserts it works.
    5. Exercises the real stop_profile path too.

  Everything in the chain is production code except the HTTP responses. What
  this CANNOT verify: AdsPower's actual JSON field names (the stub asserts our
  assumption rather than testing it) and AdsPower's fingerprint masking. Use
  tools/scraper/adspower_probe.py against a paid install for those.

USAGE

    .venv/Scripts/python.exe -m tools.scraper.adspower_stub_smoke

    # If Selenium Manager picks a mismatched chromedriver, pass one:
    .venv/Scripts/python.exe -m tools.scraper.adspower_stub_smoke --driver-path C:\\path\\chromedriver.exe

  Nothing here touches Facebook. It navigates to example.com.
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from typing import Optional

BROWSER_CANDIDATES_WIN = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    os.path.join(os.environ.get('LOCALAPPDATA', ''), 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    r'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe',
]
BROWSER_CANDIDATES_LINUX = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
]


def find_browser() -> Optional[str]:
    override = (os.environ.get('BROWSER_BIN') or '').strip()
    if override and os.path.isfile(override):
        return override
    candidates = BROWSER_CANDIDATES_LINUX if sys.platform.startswith('linux') else BROWSER_CANDIDATES_WIN
    return next((p for p in candidates if p and os.path.isfile(p)), None)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class _StubHandler(http.server.BaseHTTPRequestHandler):
    """Speaks the subset of AdsPower's Local API our client actually calls.

    Response shape mirrors AdsPower's published examples exactly, because the
    point is to exercise our parsing of THAT shape.
    """

    debug_address = ''
    driver_path = ''
    calls: list[str] = []

    def do_GET(self):  # noqa: N802 - stdlib signature
        path = self.path.split('?', 1)[0]
        type(self).calls.append(path)
        if path == '/status':
            body = {'code': 0, 'msg': 'success'}
        elif path == '/api/v1/browser/start':
            body = {
                'code': 0,
                'msg': 'success',
                'data': {
                    'ws': {
                        'selenium': type(self).debug_address,
                        'puppeteer': f'ws://{type(self).debug_address}/devtools/browser/stub',
                    },
                    'webdriver': type(self).driver_path,
                    'debug_port': type(self).debug_address.rsplit(':', 1)[-1],
                },
            }
        elif path == '/api/v1/browser/stop':
            body = {'code': 0, 'msg': 'success'}
        else:
            body = {'code': -1, 'msg': f'stub has no route for {path}'}
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):  # noqa: A003 - silence per-request noise
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description='Verify the AdsPower driver path with a stub API.')
    parser.add_argument('--driver-path', default='',
                        help='Explicit chromedriver path, if Selenium Manager picks a mismatched one.')
    parser.add_argument('--keep-open', action='store_true',
                        help='Leave the browser running at the end (for manual inspection).')
    args = parser.parse_args()

    browser = find_browser()
    if not browser:
        print('FAIL: no Chrome or Brave found. Set BROWSER_BIN to a browser executable.')
        return 1
    print(f'Browser      : {browser}')

    debug_port = free_port()
    stub_port = free_port()
    profile_dir = tempfile.mkdtemp(prefix='adspower_stub_')
    print(f'Debug port   : {debug_port}')
    print(f'Stub API port: {stub_port}')
    print(f'Temp profile : {profile_dir}')
    print()

    # 1. Launch a real browser exposing CDP, standing in for AdsPower's Chromium.
    proc = subprocess.Popen(
        [
            browser,
            f'--remote-debugging-port={debug_port}',
            f'--user-data-dir={profile_dir}',
            '--no-first-run',
            '--no-default-browser-check',
            'about:blank',
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    # 2. Stand up the stub Local API.
    _StubHandler.debug_address = f'127.0.0.1:{debug_port}'
    _StubHandler.driver_path = args.driver_path
    _StubHandler.calls = []
    server = http.server.HTTPServer(('127.0.0.1', stub_port), _StubHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    # Wait for the browser's CDP endpoint to accept connections.
    deadline = time.time() + 30
    ready = False
    while time.time() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', debug_port), timeout=1):
                ready = True
                break
        except OSError:
            time.sleep(0.5)
    if not ready:
        print(f'FAIL: browser never opened CDP on port {debug_port}.')
        proc.terminate()
        server.shutdown()
        shutil.rmtree(profile_dir, ignore_errors=True)
        return 1
    print('== Browser CDP is live ==')
    print()

    # 3. Point our REAL client at the stub. Nothing below is test scaffolding.
    os.environ['ADSPOWER_API_BASE'] = f'http://127.0.0.1:{stub_port}'
    os.environ.pop('ADSPOWER_API_KEY', None)

    exit_code = 0
    driver = None
    try:
        from tools.scraper.shared import adspower
        from tools.scraper.shared.uc_driver import open_uc_driver

        print('== 1. adspower.start_profile (real code, stub transport) ==')
        session = adspower.start_profile('stub-profile-1')
        print(f'   debugger_address = {session["debugger_address"]!r}')
        print(f'   webdriver_path   = {session["webdriver_path"]!r}')
        assert session['debugger_address'] == f'127.0.0.1:{debug_port}', 'parsed the wrong debug address'
        print('   OK - our parsing of the documented response shape is correct.')
        print()

        print('== 2. open_uc_driver(adspower_profile_id=...) - the production entry point ==')
        driver = open_uc_driver('FB_PROFILE_DIR', adspower_profile_id='stub-profile-1')
        print(f'   driver = {type(driver).__name__}')
        print('   OK - the AdsPower branch was taken and returned a live driver.')
        print()

        print('== 3. Drive the browser ==')
        driver.get('https://example.com')
        title = driver.title
        print(f'   page title = {title!r}')
        assert 'Example' in title, f'unexpected page title: {title!r}'
        print('   OK - Selenium is genuinely controlling the attached browser over CDP.')
        print()

        print('== 4. adspower.stop_profile (real code) ==')
        adspower.stop_profile('stub-profile-1')
        print('   OK - stop path ran without raising.')
        print()

        print(f'Stub API received: {_StubHandler.calls}')
        print()
        print('RESULT: PASS - start_profile, the open_uc_driver AdsPower branch,')
        print('        the CDP attach, and stop_profile all work against a real browser.')
        print('        Still unverified (needs a paid install): AdsPower\'s actual JSON')
        print('        field names and its fingerprint masking.')
    except Exception as exc:  # noqa: BLE001
        print(f'RESULT: FAIL - {type(exc).__name__}: {exc}')
        if 'session not created' in str(exc) or 'version' in str(exc).lower():
            print()
            print('   This looks like a chromedriver/browser version mismatch.')
            print('   Re-run with --driver-path pointing at a matching chromedriver.')
        exit_code = 1
    finally:
        if driver is not None and not args.keep_open:
            try:
                driver.quit()
            except Exception:  # noqa: BLE001
                pass
        server.shutdown()
        if not args.keep_open:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            shutil.rmtree(profile_dir, ignore_errors=True)
        else:
            print(f'\n(--keep-open: browser still running, profile at {profile_dir})')

    return exit_code


if __name__ == '__main__':
    sys.exit(main())
