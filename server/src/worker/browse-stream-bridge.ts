/**
 * browse-stream-bridge.ts
 *
 * Lightweight CDP screencast → browser bridge for browse-mode remote sessions.
 * Replaces the heavy noVNC desktop stream for browse mode with just the browser
 * viewport, streamed via Chrome DevTools Protocol (CDP) screencast.
 *
 * Usage (compiled to dist/worker/browse-stream-bridge.js):
 *   node dist/worker/browse-stream-bridge.js --cdp-port 9222 --serve-port 6090
 *
 * Lifecycle:
 *   - Serves a self-contained viewer.html (no external deps) at GET /viewer.html
 *   - WebSocket server on /ws bridges CDP screencast frames → client
 *   - Client sends mouse/keyboard events → forwarded to CDP Input domain
 *   - Parent (ec2-windows-spawn-cdp.ps1) kills this process tree on session end
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';

// ---------------------------------------------------------------------------
// Coordinate mapping — pure function, exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Maps a point from the canvas display space to the CDP device pixel space.
 *
 * The canvas element is sized to fill the viewport (CSS width/height 100%).
 * The browser scales the frame image to fit while preserving aspect ratio
 * (object-fit: contain equivalent). The frame itself has a native
 * deviceWidth × deviceHeight reported in screencast frame metadata.
 *
 * We compute the letterbox/pillarbox offsets and scale factor so that
 * a click at (canvasX, canvasY) inside the rendered-image area maps to
 * the correct (deviceX, deviceY).
 *
 * @param canvasX    - pointer x relative to the canvas element (CSS pixels)
 * @param canvasY    - pointer y relative to the canvas element (CSS pixels)
 * @param canvasW    - canvas element width in CSS pixels
 * @param canvasH    - canvas element height in CSS pixels
 * @param deviceW    - frame native width in device pixels (from CDP metadata)
 * @param deviceH    - frame native height in device pixels (from CDP metadata)
 * @returns { x, y } in device pixels, clamped to [0, deviceW-1] × [0, deviceH-1]
 */
export function canvasToDevice(
  canvasX: number, canvasY: number,
  canvasW: number, canvasH: number,
  deviceW: number, deviceH: number,
): { x: number; y: number } {
  // Scale factor that fits the device frame inside the canvas (contain, not cover).
  const scale = Math.min(canvasW / deviceW, canvasH / deviceH);

  // Rendered image size on the canvas.
  const renderedW = deviceW * scale;
  const renderedH = deviceH * scale;

  // Top-left offset of the rendered image (letterbox / pillarbox bars).
  const offsetX = (canvasW - renderedW) / 2;
  const offsetY = (canvasH - renderedH) / 2;

  // Map canvas coords to device coords.
  const rawX = (canvasX - offsetX) / scale;
  const rawY = (canvasY - offsetY) / scale;

  // Clamp to valid device pixel range.
  const x = Math.round(Math.max(0, Math.min(deviceW - 1, rawX)));
  const y = Math.round(Math.max(0, Math.min(deviceH - 1, rawY)));

  return { x, y };
}

// ---------------------------------------------------------------------------
// Self-contained viewer HTML (inlined, no external assets)
// ---------------------------------------------------------------------------

function buildViewerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Browser Session</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #111; }
  #canvas {
    display: block;
    width: 100%;
    height: 100%;
    cursor: default;
    /* Prevent text selection while dragging */
    user-select: none;
    -webkit-user-select: none;
  }
  #status {
    position: fixed;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,0,0,0.7);
    color: #fff;
    font: 13px/1.5 monospace;
    padding: 4px 12px;
    border-radius: 4px;
    pointer-events: none;
    transition: opacity 0.5s;
    z-index: 10;
  }
  #status.hidden { opacity: 0; }
</style>
</head>
<body>
<div id="status">Connecting…</div>
<canvas id="canvas"></canvas>
<script>
(function () {
  'use strict';

  var canvas = document.getElementById('canvas');
  var ctx = canvas.getContext('2d');
  var statusEl = document.getElementById('status');

  // ---------------------------------------------------------------------------
  // Canvas sizing — fill window, track size changes
  // ---------------------------------------------------------------------------
  function resizeCanvas() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl  = proto + '//' + location.host + '/ws';

  // Last known frame dimensions (from CDP metadata).
  var frameDeviceW = 1280;
  var frameDeviceH = 900;

  var ws;
  var statusTimer;

  function showStatus(msg) {
    statusEl.textContent = msg;
    statusEl.classList.remove('hidden');
    clearTimeout(statusTimer);
    // Auto-hide after 3 s when connected.
    if (msg === 'Connected') {
      statusTimer = setTimeout(function () { statusEl.classList.add('hidden'); }, 3000);
    }
  }

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    showStatus('Connecting…');

    ws.onopen = function () { showStatus('Connected'); };

    ws.onclose = function () {
      showStatus('Disconnected — reconnecting…');
      setTimeout(connect, 2000);
    };

    ws.onerror = function () {
      showStatus('Connection error — retrying…');
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'frame') {
        // Update frame dimensions from metadata if provided.
        if (msg.meta) {
          if (msg.meta.deviceWidth)  frameDeviceW = msg.meta.deviceWidth;
          if (msg.meta.deviceHeight) frameDeviceH = msg.meta.deviceHeight;
        }
        var img = new Image();
        img.onload = function () {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          // Scale-to-fit (contain) with letterbox bars.
          var scale = Math.min(canvas.width / frameDeviceW, canvas.height / frameDeviceH);
          var rw = frameDeviceW * scale;
          var rh = frameDeviceH * scale;
          var ox = (canvas.width  - rw) / 2;
          var oy = (canvas.height - rh) / 2;
          ctx.drawImage(img, ox, oy, rw, rh);
        };
        img.src = 'data:image/jpeg;base64,' + msg.data;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Coordinate mapping (mirrors the TS pure function)
  // ---------------------------------------------------------------------------
  function canvasToDevice(cx, cy) {
    var cw = canvas.width, ch = canvas.height;
    var dw = frameDeviceW, dh = frameDeviceH;
    var scale = Math.min(cw / dw, ch / dh);
    var rw = dw * scale, rh = dh * scale;
    var ox = (cw - rw) / 2, oy = (ch - rh) / 2;
    var x = Math.round(Math.max(0, Math.min(dw - 1, (cx - ox) / scale)));
    var y = Math.round(Math.max(0, Math.min(dh - 1, (cy - oy) / scale)));
    return { x: x, y: y };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // ---------------------------------------------------------------------------
  // Input capture — mouse
  // ---------------------------------------------------------------------------
  var BUTTON_MAP = { 0: 'left', 1: 'middle', 2: 'right' };

  canvas.addEventListener('mousedown', function (e) {
    e.preventDefault();
    canvas.focus();
    var pt = canvasToDevice(e.offsetX, e.offsetY);
    send({ type: 'mouse', event: 'mousePressed',
           x: pt.x, y: pt.y, button: BUTTON_MAP[e.button] || 'left',
           clickCount: 1, modifiers: getModifiers(e) });
  });

  canvas.addEventListener('mouseup', function (e) {
    e.preventDefault();
    var pt = canvasToDevice(e.offsetX, e.offsetY);
    send({ type: 'mouse', event: 'mouseReleased',
           x: pt.x, y: pt.y, button: BUTTON_MAP[e.button] || 'left',
           clickCount: 1, modifiers: getModifiers(e) });
  });

  canvas.addEventListener('mousemove', function (e) {
    var pt = canvasToDevice(e.offsetX, e.offsetY);
    send({ type: 'mouse', event: 'mouseMoved',
           x: pt.x, y: pt.y, button: 'none', clickCount: 0,
           modifiers: getModifiers(e) });
  });

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // ---------------------------------------------------------------------------
  // Input capture — wheel
  // ---------------------------------------------------------------------------
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var pt = canvasToDevice(e.offsetX, e.offsetY);
    send({ type: 'wheel', x: pt.x, y: pt.y,
           deltaX: e.deltaX, deltaY: e.deltaY });
  }, { passive: false });

  // ---------------------------------------------------------------------------
  // Input capture — keyboard
  // ---------------------------------------------------------------------------
  canvas.setAttribute('tabindex', '0');
  canvas.addEventListener('keydown', function (e) {
    e.preventDefault();
    send({ type: 'key', event: 'keyDown',
           key: e.key, code: e.code, text: isPrintable(e) ? e.key : '' });
  });

  canvas.addEventListener('keyup', function (e) {
    e.preventDefault();
    send({ type: 'key', event: 'keyUp',
           key: e.key, code: e.code, text: '' });
  });

  function isPrintable(e) {
    return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
  }

  function getModifiers(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  // ---------------------------------------------------------------------------
  // Auto-connect on load (also triggered by ?autoconnect=true query param)
  // ---------------------------------------------------------------------------
  connect();
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

async function discoverPageTarget(cdpPort: number): Promise<CdpTarget> {
  const res = await fetch(`http://localhost:${cdpPort}/json`);
  if (!res.ok) throw new Error(`CDP /json returned ${res.status}`);
  const targets = await res.json() as CdpTarget[];
  // Prefer the target matching type 'page' that isn't the DevTools UI.
  const page = targets.find(
    (t) => t.type === 'page' && !t.url.startsWith('devtools://'),
  ) ?? targets[0];
  if (!page) throw new Error('No CDP page target found');
  return page;
}

// ---------------------------------------------------------------------------
// Bridge: connects to CDP, relays frames → client, client events → CDP
// ---------------------------------------------------------------------------

function startCdpBridge(
  cdpPort: number,
  clientWs: WebSocket,
  log: (msg: string) => void,
): void {
  let cdpWs: WebSocket | null = null;
  let nextId = 1000;
  // Track whether the client ws is still connected (may have closed during async discover).
  let clientAlive = true;
  clientWs.on('close', () => { clientAlive = false; });

  const sendToCdp = (method: string, params: Record<string, unknown> = {}): void => {
    if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) return;
    const id = nextId++;
    cdpWs.send(JSON.stringify({ id, method, params }));
  };

  // Async: discover page target then open CDP websocket.
  void (async () => {
    let target: CdpTarget;
    // Retry up to 10 times — Brave may still be loading at CDP port attach.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        target = await discoverPageTarget(cdpPort);
        break;
      } catch (err) {
        if (attempt === 9) {
          log(`CDP target discovery failed after 10 attempts: ${(err as Error).message}`);
          clientWs.close(1011, 'CDP target not found');
          return;
        }
        await new Promise<void>((r) => setTimeout(r, 1000));
      }
    }

    if (!clientAlive) return;

    log(`CDP target: ${target!.url} ws=${target!.webSocketDebuggerUrl}`);
    cdpWs = new WebSocket(target!.webSocketDebuggerUrl);

    cdpWs.on('open', () => {
      log('CDP websocket open; enabling Page domain + starting screencast');
      sendToCdp('Page.enable');
      // Higher JPEG quality + larger frame so FB text (posts, comment box) is
      // legible. quality 60 read as blurry; 85 is sharp and still tunnel-friendly.
      sendToCdp('Page.startScreencast', {
        format: 'jpeg',
        quality: 85,
        maxWidth: 1600,
        maxHeight: 1000,
        everyNthFrame: 1,
      });
    });

    cdpWs.on('message', (data: Buffer) => {
      let msg: CdpMessage;
      try { msg = JSON.parse(data.toString()) as CdpMessage; } catch { return; }

      if (msg.method === 'Page.screencastFrame') {
        const params = msg.params as {
          data: string;
          metadata: Record<string, unknown>;
          sessionId: number;
        };
        // Forward frame to client.
        if (clientAlive && clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'frame',
            data: params.data,
            meta: params.metadata,
          }));
        }
        // Ack the frame so CDP continues sending.
        sendToCdp('Page.screencastFrameAck', { sessionId: params.sessionId });
      }
    });

    cdpWs.on('error', (err) => log(`CDP ws error: ${err.message}`));
    cdpWs.on('close', () => {
      log('CDP websocket closed');
      if (clientAlive) clientWs.close(1001, 'CDP session closed');
    });

    // Handle inbound events from the client → dispatch to CDP.
    clientWs.on('message', (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }

      const type = msg['type'] as string;

      if (type === 'mouse') {
        sendToCdp('Input.dispatchMouseEvent', {
          type: msg['event'],
          x: msg['x'],
          y: msg['y'],
          button: msg['button'] ?? 'left',
          clickCount: msg['clickCount'] ?? 0,
          modifiers: msg['modifiers'] ?? 0,
        });
      } else if (type === 'wheel') {
        sendToCdp('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: msg['x'],
          y: msg['y'],
          deltaX: msg['deltaX'] ?? 0,
          deltaY: msg['deltaY'] ?? 0,
          modifiers: 0,
          button: 'none',
          clickCount: 0,
        });
      } else if (type === 'key') {
        const text = msg['text'] as string | undefined;
        sendToCdp('Input.dispatchKeyEvent', {
          type: msg['event'],
          key: msg['key'],
          code: msg['code'],
          text: text ?? '',
          unmodifiedText: text ?? '',
        });
        // insertText for printable characters so they land in input fields.
        if (msg['event'] === 'keyDown' && text && text.length === 1) {
          sendToCdp('Input.insertText', { text });
        }
      }
    });

    clientWs.on('close', () => {
      log('client disconnected; stopping screencast');
      if (cdpWs && cdpWs.readyState === WebSocket.OPEN) {
        sendToCdp('Page.stopScreencast');
        cdpWs.close();
      }
    });
  })();
}

// ---------------------------------------------------------------------------
// Main — parse args, start HTTP+WS server
// Guarded by require.main so importing this module in tests does NOT
// start the HTTP server.
// ---------------------------------------------------------------------------

function parseArgs(): { cdpPort: number; servePort: number } {
  const args = process.argv.slice(2);
  let cdpPort = 9222;
  let servePort = 6090;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cdp-port' && args[i + 1]) cdpPort = parseInt(args[++i], 10);
    if (args[i] === '--serve-port' && args[i + 1]) servePort = parseInt(args[++i], 10);
  }
  return { cdpPort, servePort };
}

function log(msg: string): void {
  console.log(`[browse-stream-bridge] ${msg}`);
}

// Only start the server when run directly (node browse-stream-bridge.js ...),
// not when imported as a module by tests or other code.
if (require.main === module) {
  const { cdpPort, servePort } = parseArgs();
  const viewerHtml = buildViewerHtml();

  const httpServer = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url ?? '/', `http://localhost:${servePort}`);
    if (parsedUrl.pathname === '/viewer.html' || parsedUrl.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(viewerHtml);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    log(`client connected from ${req.socket.remoteAddress ?? 'unknown'}`);
    startCdpBridge(cdpPort, ws, log);
  });

  httpServer.listen(servePort, '0.0.0.0', () => {
    log(`listening on :${servePort}  (CDP port: ${cdpPort})`);
    log(`viewer: http://localhost:${servePort}/viewer.html`);
  });

  httpServer.on('error', (err) => {
    log(`HTTP server error: ${err.message}`);
    process.exit(1);
  });
}
