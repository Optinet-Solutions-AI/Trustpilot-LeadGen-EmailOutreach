"""Verify software WebGL works under xvfb (DataDome hardening lever #1).

Run this on the Linux EC2 box, under the SAME xvfb display the scraper uses,
BEFORE minting/scraping. It launches a headed (non---headless) Chrome with the
software-GL flags and prints the WebGL renderer string. A GPU-less box WITHOUT
the flags returns null/empty (which DataDome hard-blocks); WITH them it should
return a SwiftShader/ANGLE renderer — proof the fingerprint now looks like a
real desktop.

    DISPLAY=:99 python3 -m tools.scraper.verify_webgl

PASS  = a non-empty renderer containing 'SwiftShader' or 'ANGLE'.
FAIL  = 'NO WEBGL CONTEXT' or an empty renderer → DataDome will hard-block;
        check the flags / Chrome version / that a WM is running on :99.
"""
from __future__ import annotations

import sys

from tools.scraper.shared.uc_driver import _detect_chrome_major_version

_PROBE = (
    "data:text/html,<canvas id=c></canvas><script>"
    "var gl=document.getElementById('c').getContext('webgl')||"
    "document.getElementById('c').getContext('experimental-webgl');"
    "if(!gl){document.title='NO_WEBGL_CONTEXT';}else{"
    "var e=gl.getExtension('WEBGL_debug_renderer_info');"
    "var r=e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);"
    "var v=e?gl.getParameter(e.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR);"
    "document.title='WEBGL|'+v+'|'+r;}"
    "</script>"
)


def main() -> int:
    import undetected_chromedriver as uc

    opts = uc.ChromeOptions()
    opts.add_argument('--no-sandbox')
    opts.add_argument('--disable-dev-shm-usage')
    opts.add_argument('--window-size=1920,1080')
    # Same software-GL levers as the scrape/mint path.
    opts.add_argument('--enable-unsafe-swiftshader')
    opts.add_argument('--use-gl=angle')
    opts.add_argument('--use-angle=swiftshader')
    opts.add_argument('--ignore-gpu-blocklist')
    opts.add_argument('--enable-webgl')
    opts.add_argument('--disable-blink-features=AutomationControlled')

    driver = uc.Chrome(options=opts, headless=False,
                       version_main=_detect_chrome_major_version())
    try:
        driver.get(_PROBE)
        import time
        time.sleep(1.5)
        title = driver.title or ''
        print(f"[verify_webgl] navigator.userAgent: {driver.execute_script('return navigator.userAgent')}")
        print(f"[verify_webgl] result: {title}")
        if title.startswith('WEBGL|'):
            _, vendor, renderer = title.split('|', 2)
            ok = bool(renderer.strip()) and (
                'swiftshader' in renderer.lower() or 'angle' in renderer.lower()
                or 'swiftshader' in vendor.lower())
            print(f"[verify_webgl] vendor={vendor!r} renderer={renderer!r}")
            print('PASS: software WebGL renderer present.' if ok else
                  'FAIL: WebGL context exists but renderer is empty/unexpected.')
            return 0 if ok else 1
        print('FAIL: no WebGL context (renderer null) — DataDome will hard-block.')
        return 1
    finally:
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
