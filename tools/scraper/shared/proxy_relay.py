"""Non-MITM CONNECT auth relay for the residential proxy.

WHY THIS EXISTS
  Yelp's /search is guarded by DataDome. Beating it needs (a) a residential
  exit IP and (b) the browser's REAL TLS ClientHello reaching Yelp untouched —
  DataDome fingerprints TLS, so any MITM (selenium-wire, mitmproxy) is flagged
  instantly. The existing `uc_driver.open_uc_driver` proxy path uses
  selenium-wire, which MITMs HTTPS and therefore CANNOT clear DataDome (and it
  crashes on Windows anyway). Chrome's own `--proxy-server` flag refuses
  user:pass@host URLs, and the MV2 proxy-auth extension workaround is dead in
  Chrome 128+.

  This relay closes the gap: it listens on 127.0.0.1 with NO local auth, and
  for each Chrome CONNECT it opens a socket to the Enigma upstream, sends
  `CONNECT host:443` WITH the `Proxy-Authorization` header, then blind-pipes
  bytes both ways WITHOUT terminating TLS. Chrome talks plain TCP to localhost;
  the real TLS handshake flows end-to-end to the origin. Point Chrome at it with
  `--proxy-server=http://127.0.0.1:<port>` (no selenium-wire, no extension).

  Empirically (2026-07-14): a US residential exit through this relay + a reused
  DataDome cookie (minted once by a human solving the slider) returns real Yelp
  /search cards in a HEADED browser. Headless is re-challenged (DataDome
  fingerprints headless), so the server path is headed-under-xvfb.

STICKY SESSION
  The DataDome cookie is bound to the exit IP, so the whole crawl must hold ONE
  IP. Enigma pins an IP when the password carries a `_session-<token>` suffix
  (verified: same IP for minutes). Country stays via `_country-XX`.

USAGE
    with RelayServer(country='US', session='optirate-yelp') as relay:
        # relay.port is an ephemeral localhost port
        driver = uc.Chrome(options=opts_with_proxy_server(relay.port), ...)
"""
from __future__ import annotations

import asyncio
import base64
import os
import re
import threading
from typing import Optional


UPSTREAM_HOST = os.environ.get('RESIDENTIAL_PROXY_HOST', 'resi.enigmaproxy.net')
UPSTREAM_PORT = int(os.environ.get('RESIDENTIAL_PROXY_PORT', '12321'))


def _build_upstream_password(country: Optional[str], session: Optional[str]) -> str:
    """Swap the country code in the env password and append the sticky-session
    token. Enigma format: `<pw>_country-XX[_session-YYY][_lifetime-ZZ]`.

    A `_session-<token>` alone pins ONE exit IP across separate connections /
    processes — measured stable for 10+ min with zero drift (2026-07-14). We
    also append a `_lifetime-<val>` suffix requesting a longer hold; the exact
    Enigma TTL convention is UNVERIFIED (it may be ignored), but it's accepted
    (returns 200) and harmless. Override/disable via
    RESIDENTIAL_PROXY_SESSION_LIFETIME (empty = omit the suffix).

    CRITICAL: mint and scrape MUST build the IDENTICAL password (same token AND
    same lifetime) or they land on different IPs — and the DataDome cookie is
    IP-bound. Both go through this one function, so they stay in lockstep."""
    pw = os.environ.get('RESIDENTIAL_PROXY_PASSWORD', '')
    if country:
        cc = country.strip().upper()
        if re.search(r'_country-[A-Za-z]{2}\b', pw):
            pw = re.sub(r'(?<=_country-)[A-Za-z]{2}\b', cc, pw)
        else:
            pw = f'{pw}_country-{cc}'
    if session and '_session-' not in pw:
        pw = f'{pw}_session-{session}'
        lifetime = os.environ.get('RESIDENTIAL_PROXY_SESSION_LIFETIME', '30m').strip()
        if lifetime and '_lifetime-' not in pw:
            pw = f'{pw}_lifetime-{lifetime}'
    return pw


def _auth_header(country: Optional[str], session: Optional[str]) -> bytes:
    user = os.environ.get('RESIDENTIAL_PROXY_USERNAME', '')
    pw = _build_upstream_password(country, session)
    return base64.b64encode(f'{user}:{pw}'.encode()).decode().encode()


def get_exit_ip(
    country: Optional[str] = None,
    session: Optional[str] = None,
    timeout: int = 30,
) -> Optional[str]:
    """Return the current exit IP for the given sticky session by hitting
    ipinfo directly through the Enigma upstream (no relay/browser needed).
    Used to detect sticky-IP drift before trusting an IP-bound DataDome cookie.
    Returns None on any error."""
    import requests  # lazy — only the Yelp relay path needs it

    user = os.environ.get('RESIDENTIAL_PROXY_USERNAME', '')
    pw = _build_upstream_password(country, session)
    purl = f'http://{user}:{pw}@{UPSTREAM_HOST}:{UPSTREAM_PORT}'
    try:
        r = requests.get(
            'https://ipinfo.io/json',
            proxies={'http': purl, 'https': purl},
            timeout=timeout,
        )
        return (r.json() or {}).get('ip')
    except Exception:
        return None


async def _pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


def _make_handler(auth: bytes):
    async def handle(client_r, client_w):
        up_w = None
        try:
            header = b''
            while b'\r\n\r\n' not in header:
                chunk = await client_r.read(4096)
                if not chunk:
                    client_w.close()
                    return
                header += chunk
                if len(header) > 65536:
                    break
            head, _, rest = header.partition(b'\r\n\r\n')
            lines = head.split(b'\r\n')
            parts = lines[0].split(b' ')
            if len(parts) < 2:
                client_w.close()
                return
            method, target = parts[0], parts[1]
            up_r, up_w = await asyncio.open_connection(UPSTREAM_HOST, UPSTREAM_PORT)
            if method.upper() == b'CONNECT':
                creq = (b'CONNECT ' + target + b' HTTP/1.1\r\n'
                        b'Host: ' + target + b'\r\n'
                        b'Proxy-Authorization: Basic ' + auth + b'\r\n'
                        b'Proxy-Connection: Keep-Alive\r\n\r\n')
                up_w.write(creq)
                await up_w.drain()
                resp = b''
                while b'\r\n\r\n' not in resp:
                    c = await up_r.read(4096)
                    if not c:
                        break
                    resp += c
                if b' 200' in resp.split(b'\r\n', 1)[0]:
                    client_w.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                    await client_w.drain()
                    await asyncio.gather(_pipe(client_r, up_w), _pipe(up_r, client_w))
                else:
                    client_w.write(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
                    await client_w.drain()
                    client_w.close()
                    up_w.close()
            else:
                new_lines = [lines[0]]
                for l in lines[1:]:
                    if l.lower().startswith(b'proxy-authorization:'):
                        continue
                    new_lines.append(l)
                new_lines.append(b'Proxy-Authorization: Basic ' + auth)
                up_w.write(b'\r\n'.join(new_lines) + b'\r\n\r\n' + rest)
                await up_w.drain()
                await asyncio.gather(_pipe(client_r, up_w), _pipe(up_r, client_w))
        except Exception:
            try:
                client_w.close()
            except Exception:
                pass
            if up_w:
                try:
                    up_w.close()
                except Exception:
                    pass

    return handle


class RelayServer:
    """Context manager running the relay on an ephemeral localhost port in a
    background asyncio thread. `.port` is valid once entered."""

    def __init__(self, *, country: Optional[str] = None, session: Optional[str] = None):
        self._auth = _auth_header(country, session)
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._ready = threading.Event()
        self.port: Optional[int] = None

    def __enter__(self) -> 'RelayServer':
        def _run():
            loop = asyncio.new_event_loop()
            self._loop = loop
            asyncio.set_event_loop(loop)
            # Proxied sockets get reset all the time (Chrome closing keep-alives,
            # origins dropping connections). Those surface as noisy
            # ConnectionResetError transport logs — swallow them so a normal
            # scrape doesn't drown in tracebacks.
            loop.set_exception_handler(lambda l, ctx: None)
            server = loop.run_until_complete(
                asyncio.start_server(_make_handler(self._auth), '127.0.0.1', 0)
            )
            self.port = server.sockets[0].getsockname()[1]
            self._ready.set()
            try:
                loop.run_until_complete(server.serve_forever())
            except Exception:
                pass
            # Clean teardown: cancel in-flight tunnels, then close the loop so
            # Python doesn't emit "Task was destroyed but it is pending".
            try:
                server.close()
                pending = asyncio.all_tasks(loop)
                for t in pending:
                    t.cancel()
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            except Exception:
                pass
            finally:
                loop.close()

        self._thread = threading.Thread(target=_run, daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=10):
            raise RuntimeError('proxy relay failed to start within 10s')
        return self

    def __exit__(self, *exc):
        if self._loop:
            try:
                self._loop.call_soon_threadsafe(self._loop.stop)
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=5)
        return False
