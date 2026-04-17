/**
 * Stealth Chromium launcher — ported from BannerScrapper.
 *
 * Tier ladder (escalates on bot detection):
 *   Tier 1 — vanilla Playwright (fast path for sites with no protection)
 *   Tier 2 — playwright-extra + stealth plugin + UA/viewport rotation
 *   Tier 3 — Tier 2 + datacenter proxy (requires SCRAPER_DC_PROXY_URL env)
 *   Tier 4 — Tier 2 + residential proxy (requires SCRAPER_RES_PROXY_URL env)
 *
 * Stealth patches navigator/WebGL/canvas/webdriver flags at the Chromium instance
 * level, so every tab created from the instance inherits the patches.
 */

import { chromium as vanillaChromium, type Browser, type BrowserContext } from 'playwright';
// playwright-extra exposes CJS default export
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { addExtra } = require('playwright-extra');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Cache the stealth-patched chromium instance — patching is idempotent but slow
let _stealthChromium: typeof vanillaChromium | null = null;
function getStealthChromium(): typeof vanillaChromium {
  if (!_stealthChromium) {
    const extra = addExtra(vanillaChromium);
    extra.use(StealthPlugin());
    _stealthChromium = extra;
  }
  return _stealthChromium!;
}

// Chrome-only UA pool. Claiming Firefox/Safari with Chromium internals = instant detection.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
];

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export type Tier = 1 | 2 | 3 | 4;

export interface TierConfig {
  tier: Tier;
  stealth: boolean;
  userAgentRotation: boolean;
  proxy: 'none' | 'datacenter' | 'residential';
  timeout: number;
  retries: number;
}

export const TIER_CONFIGS: Record<Tier, TierConfig> = {
  1: { tier: 1, stealth: false, userAgentRotation: false, proxy: 'none',        timeout: 20_000, retries: 1 },
  2: { tier: 2, stealth: true,  userAgentRotation: true,  proxy: 'none',        timeout: 30_000, retries: 2 },
  3: { tier: 3, stealth: true,  userAgentRotation: true,  proxy: 'datacenter',  timeout: 45_000, retries: 2 },
  4: { tier: 4, stealth: true,  userAgentRotation: true,  proxy: 'residential', timeout: 60_000, retries: 3 },
};

function getProxyForTier(tier: TierConfig): { server: string; username?: string; password?: string } | undefined {
  const raw = tier.proxy === 'datacenter'
    ? process.env.SCRAPER_DC_PROXY_URL
    : tier.proxy === 'residential'
    ? process.env.SCRAPER_RES_PROXY_URL
    : undefined;
  if (!raw) return undefined;

  // Parse URLs like http://user:pass@host:port — split auth from server
  try {
    const u = new URL(raw);
    const server = `${u.protocol}//${u.host}`;
    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    return { server, username, password };
  } catch {
    // Treat as already-formed server URL with no auth
    return { server: raw };
  }
}

export interface BrowserBundle {
  browser: Browser;
  context: BrowserContext;
  tier: Tier;
}

export async function launchBrowser(tierCfg: TierConfig): Promise<BrowserBundle> {
  const proxy = tierCfg.proxy !== 'none' ? getProxyForTier(tierCfg) : undefined;

  // If a proxy tier was requested but no env var is set, fall back silently
  // to Tier 2 stealth. The caller's tier ladder will handle escalation.
  if (tierCfg.proxy !== 'none' && !proxy) {
    console.warn(`[browser-launcher] Tier ${tierCfg.tier} requested ${tierCfg.proxy} proxy but no env var set — falling back to stealth-only`);
  }

  const chromiumToUse = tierCfg.stealth ? getStealthChromium() : vanillaChromium;

  const browser = await chromiumToUse.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--dns-prefetch-disable',
    ],
    proxy,
  });

  const viewport = tierCfg.userAgentRotation
    ? { width: 1280 + Math.floor(Math.random() * 200), height: 800 + Math.floor(Math.random() * 100) }
    : { width: 1440, height: 900 };

  const context = await browser.newContext({
    viewport,
    userAgent: tierCfg.userAgentRotation ? randomUserAgent() : undefined,
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  // Speed up loading: block heavy resources unlikely to contain emails
  await context.route('**/*.{woff,woff2,ttf,otf}', (r) => r.abort());
  await context.route('**/analytics**', (r) => r.abort());
  await context.route('**/gtag**', (r) => r.abort());
  await context.route('**/google-analytics**', (r) => r.abort());
  await context.route('**/*.{png,jpg,jpeg,gif,webp,svg,mp4,webm}', (r) => r.abort());

  // Tier 4: inject mouse-movement simulation to defeat behavioural analytics
  if (tierCfg.tier >= 4) {
    context.on('page', async (page) => {
      await page.addInitScript(() => {
        let x = Math.random() * window.innerWidth;
        let y = Math.random() * window.innerHeight;
        const jitter = () => {
          x += (Math.random() - 0.5) * 20;
          y += (Math.random() - 0.5) * 20;
          x = Math.max(0, Math.min(window.innerWidth, x));
          y = Math.max(0, Math.min(window.innerHeight, y));
          document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
        };
        const iv = setInterval(jitter, 300 + Math.random() * 400);
        window.addEventListener('beforeunload', () => clearInterval(iv));
      });
    });
  }

  return { browser, context, tier: tierCfg.tier };
}

export async function humanDelay(minMs = 800, maxMs = 2500): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  await new Promise((r) => setTimeout(r, delay));
}
