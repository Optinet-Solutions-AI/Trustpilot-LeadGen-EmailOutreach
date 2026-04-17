/**
 * Popup & challenge handler — ported from BannerScrapper popup-handler.ts.
 *
 * Runs in a strict order:
 *   1. Unsupported-browser wall (rare, but blocks page render)
 *   2. Language selector (some EU sites block until language picked)
 *   3. Age gate — button / DOB form / checkbox (common on casino sites)
 *   4. Cookie/consent banner
 *   5. Modal / overlay close buttons
 *   6. Escape key (last resort)
 *
 * Also detects Cloudflare "Just a Moment" challenges and waits for auto-resolve.
 */

import type { Page } from 'playwright';

const COOKIE_SELECTORS = [
  'button[id*="accept"]', 'button[class*="accept"]',
  'button[id*="cookie"]', 'button[class*="cookie"]',
  'button[id*="consent"]', 'button[class*="consent"]',
  '[data-testid*="cookie-accept"]', '[data-testid*="accept-cookies"]',
  'button:text-is("Accept")', 'button:text-is("Accept All")',
  'button:text-is("ACCEPT ALL")', 'button:text-is("Accept Cookies")',
  'button:text-is("I Accept")', 'button:text-is("OK")',
  'button:text-is("Got it")', 'button:text-is("Allow All")',
  'button:text-is("Allow Cookies")', 'button:text-is("Agree")',
  'button:text-is("I Agree")', 'button:text-is("Accept and close")',
  'button:text("Yes, I agree")',
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '.cc-accept', '.cookie-accept', '#cookieAccept',
  '[aria-label*="Accept cookies"]', '[aria-label*="accept all"]',
];

const AGE_GATE_SELECTORS = [
  'button:text-is("Enter")', 'button:text-is("Enter Site")',
  'button:text-is("I am 18+")', "button:text-is(\"I'm 18+\")",
  'button:text-is("I am over 18")', 'button:text-is("Enter Now")',
  'button:text-is("Yes, I am 18+")', "button:text-is(\"I'm of legal age\")",
  'button:text-is("I am of legal age")',
  "button:text-is(\"I'm 18 or older\")",
  "button:text(\"Yes, I'm 18+\")", 'button:text-is("Continue")',
  'button:text-is("Proceed")',
  '[class*="age-gate"] button', '[id*="age-gate"] button',
  '[class*="age-verify"] button', '[id*="age-verify"] button',
];

const MODAL_CLOSE_SELECTORS = [
  'button[aria-label="Close"]', 'button[aria-label="close"]',
  'button[aria-label="Dismiss"]',
  '[class*="modal"] button[class*="close"]',
  '[class*="popup"] button[class*="close"]',
  '.modal-close', '.popup-close', '.dialog-close',
  'button.close', 'a.close', '[data-dismiss="modal"]',
];

const UNSUPPORTED_BROWSER_SELECTORS = [
  'a:text("Continue with unsupported browser")',
  'button:text("Continue with unsupported browser")',
  'a:text("continue anyway")', 'a:text("Continue anyway")',
  'button:text("Continue anyway")',
];

const LANGUAGE_SELECTORS = [
  'button:text-is("English")', 'a:text-is("English")',
  'li:text-is("English")',
  '[class*="language"] :text("English")',
  '[class*="lang"] :text("English")',
];

async function tryClick(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(600);
        return true;
      }
    } catch { /* selector not found — try next */ }
  }
  return false;
}

async function tryDobAgeGate(page: Page): Promise<boolean> {
  const hasDobForm = await page.evaluate(() => {
    const yearEl = document.querySelector(
      'select[name*="year"], select[id*="year"], input[name*="year"], input[placeholder*="Year"], input[placeholder*="YYYY"]',
    );
    return !!(yearEl && (yearEl as HTMLElement).offsetParent !== null);
  }).catch(() => false);
  if (!hasDobForm) return false;

  try {
    const yearSel = page.locator('select[name*="year"], select[id*="year"]').first();
    if (await yearSel.isVisible({ timeout: 800 }).catch(() => false)) {
      await yearSel.selectOption('1990');
    } else {
      const yearInput = page.locator('input[name*="year"], input[placeholder*="Year"], input[placeholder*="YYYY"]').first();
      if (await yearInput.isVisible({ timeout: 800 }).catch(() => false)) {
        await yearInput.fill('1990');
      }
    }

    const monthSel = page.locator('select[name*="month"], select[id*="month"]').first();
    if (await monthSel.isVisible({ timeout: 800 }).catch(() => false)) {
      await monthSel.selectOption('6');
    } else {
      const monthInput = page.locator('input[name*="month"], input[placeholder*="Month"], input[placeholder*="MM"]').first();
      if (await monthInput.isVisible({ timeout: 800 }).catch(() => false)) {
        await monthInput.fill('06');
      }
    }

    const daySel = page.locator('select[name*="day"], select[id*="day"]').first();
    if (await daySel.isVisible({ timeout: 800 }).catch(() => false)) {
      await daySel.selectOption('15');
    } else {
      const dayInput = page.locator('input[name*="day"], input[placeholder*="Day"], input[placeholder*="DD"]').first();
      if (await dayInput.isVisible({ timeout: 800 }).catch(() => false)) {
        await dayInput.fill('15');
      }
    }

    await page.waitForTimeout(300);
    const submitted = await tryClick(page, [
      'button:text-is("Confirm")', 'button:text-is("Submit")',
      'button:text-is("Enter")', 'button:text-is("Verify")',
      'button:text-is("Continue")', 'button[type="submit"]',
    ]);
    if (submitted) {
      await page.waitForTimeout(1000);
      return true;
    }
  } catch { /* DOB flow failed — ignore */ }
  return false;
}

async function tryAgeCheckbox(page: Page): Promise<boolean> {
  const checkboxSels = [
    'input[type="checkbox"][id*="age"]',
    'input[type="checkbox"][name*="age"]',
    'input[type="checkbox"][id*="18"]',
    'input[type="checkbox"][name*="confirm"]',
  ];
  for (const sel of checkboxSels) {
    try {
      const cb = page.locator(sel).first();
      if (await cb.isVisible({ timeout: 800 })) {
        if (!(await cb.isChecked())) await cb.check();
        await page.waitForTimeout(300);
        await tryClick(page, [
          'button:text-is("Enter")', 'button:text-is("Continue")',
          'button:text-is("Proceed")', 'button[type="submit"]',
        ]);
        return true;
      }
    } catch { /* skip */ }
  }
  return false;
}

export async function dismissPopups(page: Page): Promise<void> {
  await tryClick(page, UNSUPPORTED_BROWSER_SELECTORS);
  await tryClick(page, LANGUAGE_SELECTORS);

  const simpleAge = await tryClick(page, AGE_GATE_SELECTORS);
  if (!simpleAge) {
    const dobDone = await tryDobAgeGate(page);
    if (!dobDone) await tryAgeCheckbox(page);
  }

  await tryClick(page, COOKIE_SELECTORS);
  await tryClick(page, MODAL_CLOSE_SELECTORS);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
}

/**
 * Detect a Cloudflare interstitial and wait for Turnstile to auto-solve.
 * On residential IPs the challenge usually self-resolves in 10–18 seconds.
 * Returns true if the page is now past the challenge, false if still blocked.
 */
export async function handleCloudflareChallenge(page: Page, maxWaitMs = 20_000): Promise<boolean> {
  const isChallenge = await page.evaluate(() => {
    const body = (document.body?.innerText || '').toLowerCase();
    const title = (document.title || '').toLowerCase();
    const hasChallengeEl = !!document.querySelector('#challenge-running, #cf-spinner, .cf-browser-verification');
    return (
      body.includes('checking your browser') ||
      body.includes('cf-browser-verification') ||
      body.includes('enable javascript and cookies') ||
      title.includes('just a moment') ||
      title.includes('attention required') ||
      hasChallengeEl
    );
  }).catch(() => false);

  if (!isChallenge) return true;

  console.log('  [cf] Cloudflare challenge detected — waiting for auto-resolve…');
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    const stillChallenged = await page.evaluate(() => {
      const title = (document.title || '').toLowerCase();
      return title.includes('just a moment') || title.includes('attention required');
    }).catch(() => false);
    if (!stillChallenged) {
      console.log('  [cf] Challenge resolved');
      return true;
    }
  }
  console.log('  [cf] Challenge still active after wait — will escalate tier');
  return false;
}

/**
 * Classifies a "loaded but blocked" page so the caller can decide whether to
 * retry at the next tier. Returns null when the page looks fine.
 */
export async function detectBlock(page: Page): Promise<
  | null
  | 'cloudflare_challenge'
  | 'access_denied'
  | 'bot_detected'
  | 'empty_page'
> {
  const info = await page.evaluate(() => {
    const body = (document.body?.innerText || '').toLowerCase();
    const title = (document.title || '').toLowerCase();
    return { body, title, bodyLen: body.trim().length };
  }).catch(() => ({ body: '', title: '', bodyLen: 0 }));

  if (
    info.title.includes('just a moment') ||
    info.title.includes('attention required') ||
    info.body.includes('checking your browser') ||
    info.body.includes('cf-browser-verification')
  ) return 'cloudflare_challenge';

  if (
    info.body.includes('access denied') ||
    info.body.includes('you have been blocked') ||
    info.body.includes('bot detected') ||
    info.body.includes('automated access') ||
    info.title.includes('access denied') ||
    info.title.includes('403 forbidden')
  ) return 'access_denied';

  if (info.body.includes('are you a robot') || info.body.includes('verify you are human')) {
    return 'bot_detected';
  }

  if (info.bodyLen < 200) return 'empty_page';

  return null;
}
