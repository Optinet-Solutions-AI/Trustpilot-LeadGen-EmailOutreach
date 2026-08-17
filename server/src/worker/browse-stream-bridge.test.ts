/**
 * Unit tests for the canvasToDevice coordinate mapping helper.
 *
 * These are pure math tests — no CDP, no WebSocket, no Brave required.
 * They verify that mouse coords from the canvas display space map
 * correctly to CDP device pixel space across different aspect ratios
 * and letterbox/pillarbox configurations.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { canvasToDevice, parseArgs } from './browse-stream-bridge.js';

describe('canvasToDevice', () => {
  // -----------------------------------------------------------------------
  // Exact-fit: canvas and device have the same dimensions.
  // -----------------------------------------------------------------------
  test('identity: canvas == device dimensions', () => {
    const canvas = { w: 1280, h: 900 };
    const device = { w: 1280, h: 900 };
    // Any point maps to itself.
    expect(canvasToDevice(0, 0, canvas.w, canvas.h, device.w, device.h)).toEqual({ x: 0, y: 0 });
    expect(canvasToDevice(640, 450, canvas.w, canvas.h, device.w, device.h)).toEqual({ x: 640, y: 450 });
    expect(canvasToDevice(1279, 899, canvas.w, canvas.h, device.w, device.h)).toEqual({ x: 1279, y: 899 });
  });

  // -----------------------------------------------------------------------
  // Uniform scale-down (2x): device is twice the canvas size in both dims.
  // -----------------------------------------------------------------------
  test('uniform 2x scale down', () => {
    // Canvas 640x450, device 1280x900 — scale=0.5, no letterbox.
    const result = canvasToDevice(320, 225, 640, 450, 1280, 900);
    expect(result).toEqual({ x: 640, y: 450 });
  });

  test('uniform 2x scale down — top-left corner', () => {
    const result = canvasToDevice(0, 0, 640, 450, 1280, 900);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  test('uniform 2x scale down — bottom-right corner', () => {
    // canvas (639, 449), scale=0.5, no letterbox → device (1278, 898).
    // The bottom-right canvas pixel (639) maps to 639/0.5=1278 in device space,
    // not 1279 — the last device pixel 1279 would require canvas coord 639.5.
    const result = canvasToDevice(639, 449, 640, 450, 1280, 900);
    expect(result).toEqual({ x: 1278, y: 898 });
  });

  // -----------------------------------------------------------------------
  // Letterbox: canvas wider than device aspect ratio → horizontal bars.
  // Device: 1280x900 (16:10.24). Canvas: 1920x900 (wide).
  // Scale = min(1920/1280, 900/900) = min(1.5, 1.0) = 1.0
  // Rendered image: 1280x900. offsetX = (1920-1280)/2 = 320. offsetY = 0.
  // -----------------------------------------------------------------------
  test('letterbox (canvas wider) — center maps to center', () => {
    // Center of the rendered image in canvas coords = (320+640, 450) = (960, 450).
    const result = canvasToDevice(960, 450, 1920, 900, 1280, 900);
    expect(result).toEqual({ x: 640, y: 450 });
  });

  test('letterbox — left bar (before rendered image) clamps to x=0', () => {
    // offsetX=320, so canvas x=100 is in the left bar → clamp to x=0.
    const result = canvasToDevice(100, 450, 1920, 900, 1280, 900);
    expect(result).toEqual({ x: 0, y: 450 });
  });

  test('letterbox — right bar clamps to x=deviceW-1', () => {
    // canvas x=1900 (right bar, offsetX=320, rendered ends at 1600).
    const result = canvasToDevice(1900, 450, 1920, 900, 1280, 900);
    expect(result).toEqual({ x: 1279, y: 450 });
  });

  // -----------------------------------------------------------------------
  // Pillarbox: canvas taller than device aspect ratio → vertical bars.
  // Device: 1280x900. Canvas: 1280x1200.
  // Scale = min(1280/1280, 1200/900) = min(1.0, 1.333) = 1.0
  // Rendered: 1280x900. offsetX=0. offsetY=(1200-900)/2=150.
  // -----------------------------------------------------------------------
  test('pillarbox (canvas taller) — center maps to center', () => {
    // Center: canvas (640, 150+450) = (640, 600).
    const result = canvasToDevice(640, 600, 1280, 1200, 1280, 900);
    expect(result).toEqual({ x: 640, y: 450 });
  });

  test('pillarbox — top bar clamps to y=0', () => {
    const result = canvasToDevice(640, 50, 1280, 1200, 1280, 900);
    expect(result).toEqual({ x: 640, y: 0 });
  });

  test('pillarbox — bottom bar clamps to y=deviceH-1', () => {
    const result = canvasToDevice(640, 1180, 1280, 1200, 1280, 900);
    expect(result).toEqual({ x: 640, y: 899 });
  });

  // -----------------------------------------------------------------------
  // Scale-up: canvas larger than device (device is smaller).
  // Device: 640x450. Canvas: 1280x900.
  // Scale = min(1280/640, 900/450) = min(2, 2) = 2.
  // Rendered: 1280x900. No letterbox.
  // -----------------------------------------------------------------------
  test('scale-up 2x — center', () => {
    // canvas (640, 450) → device (320, 225).
    const result = canvasToDevice(640, 450, 1280, 900, 640, 450);
    expect(result).toEqual({ x: 320, y: 225 });
  });

  test('scale-up 2x — top-left', () => {
    const result = canvasToDevice(0, 0, 1280, 900, 640, 450);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  // -----------------------------------------------------------------------
  // Output is always rounded integers within [0, deviceW-1] × [0, deviceH-1].
  // -----------------------------------------------------------------------
  test('output coordinates are integers', () => {
    const result = canvasToDevice(100, 75, 1280, 900, 1280, 900);
    expect(Number.isInteger(result.x)).toBe(true);
    expect(Number.isInteger(result.y)).toBe(true);
  });

  test('clamps: x never goes below 0', () => {
    const result = canvasToDevice(-100, 450, 1280, 900, 1280, 900);
    expect(result.x).toBe(0);
  });

  test('clamps: y never goes below 0', () => {
    const result = canvasToDevice(640, -100, 1280, 900, 1280, 900);
    expect(result.y).toBe(0);
  });

  test('clamps: x never exceeds deviceW-1', () => {
    const result = canvasToDevice(9999, 450, 1280, 900, 1280, 900);
    expect(result.x).toBe(1279);
  });

  test('clamps: y never exceeds deviceH-1', () => {
    const result = canvasToDevice(640, 9999, 1280, 900, 1280, 900);
    expect(result.y).toBe(899);
  });

  // -----------------------------------------------------------------------
  // Regression: non-square aspect ratio canvas with scale-bound on height.
  // Device 1280x900 in a 900x900 canvas:
  // Scale = min(900/1280, 900/900) = min(0.703, 1.0) = 0.703...
  // Rendered: 900x633.9... → offsetX=0, offsetY=(900-633.9)/2=133.05
  // -----------------------------------------------------------------------
  test('height-bound scale (square canvas wider than device)', () => {
    const cw = 900, ch = 900, dw = 1280, dh = 900;
    // Top of rendered image in canvas coords ≈ y=133.
    const topOfImage = canvasToDevice(450, 133, cw, ch, dw, dh);
    // Should map close to device (640, 0).
    expect(topOfImage.x).toBe(640);
    expect(topOfImage.y).toBeLessThanOrEqual(2); // rounding tolerance
  });
});

describe('parseArgs', () => {
  const originalArgv = process.argv;
  afterEach(() => { process.argv = originalArgv; });

  test('defaults cdpPort/servePort and leaves targetUrl undefined when omitted', () => {
    process.argv = ['node', 'browse-stream-bridge.js'];
    expect(parseArgs()).toEqual({ cdpPort: 9222, servePort: 6090, targetUrl: undefined });
  });

  test('parses --cdp-port, --serve-port and --target-url', () => {
    process.argv = [
      'node', 'browse-stream-bridge.js',
      '--cdp-port', '9333',
      '--serve-port', '7000',
      '--target-url', 'https://www.facebook.com/',
    ];
    expect(parseArgs()).toEqual({
      cdpPort: 9333,
      servePort: 7000,
      targetUrl: 'https://www.facebook.com/',
    });
  });
});
