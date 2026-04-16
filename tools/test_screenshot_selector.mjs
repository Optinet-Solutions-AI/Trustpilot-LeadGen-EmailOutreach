/**
 * Test script — finds the best element selector for a clean Trustpilot profile card screenshot.
 * Saves samples to .tmp/screenshot_test/ for review.
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { config } from 'dotenv';

config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const OUT_DIR = path.resolve(import.meta.dirname, '..', '.tmp', 'screenshot_test');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Test on a few different leads
const TEST_URLS = [
  'https://www.trustpilot.com/review/danske-spil-casino.dk',
  'https://www.trustpilot.com/review/willycasino.dk',
  'https://www.trustpilot.com/review/betway.dk',
];

// Candidate selectors — ordered from most specific to most general
const SELECTORS = [
  { name: 'section_interactivecard',   sel: 'section[class*="interactiveCard"]' },
  { name: 'div_businesscard',          sel: 'div[class*="businessCard"]' },
  { name: 'section_businessunit',      sel: 'section[class*="businessUnit"]' },
  { name: 'section_header',            sel: 'section[class*="header"]' },
  { name: 'div_profileheader',         sel: 'div[class*="profileHeader"]' },
  { name: 'div_businessinfo',          sel: 'div[class*="businessInfo"]' },
  { name: 'div_paper_white',           sel: 'div[class*="paper"]' },
  { name: 'section_overview',          sel: 'section[class*="overview"]' },
  { name: 'main_first_section',        sel: 'main section:first-of-type' },
  { name: 'clip_y130_h280',            sel: null, clip: { x: 0, y: 130, width: 1280, height: 280 } },
  { name: 'clip_y110_h300',            sel: null, clip: { x: 0, y: 110, width: 1280, height: 300 } },
  { name: 'clip_y90_h320',             sel: null, clip: { x: 0, y: 90,  width: 1280, height: 320 } },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  for (const url of TEST_URLS) {
    const slug = url.split('/review/')[1];
    console.log(`\n=== ${slug} ===`);

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // Print all section/div class names to help identify the right selector
    const classes = await page.evaluate(() => {
      const els = [...document.querySelectorAll('section, main > div, main > section')];
      return els.map(el => ({ tag: el.tagName, cls: el.className.substring(0, 120) })).slice(0, 15);
    });
    console.log('Top-level elements:');
    classes.forEach(c => console.log(`  <${c.tag}> ${c.cls}`));

    for (const { name, sel, clip } of SELECTORS) {
      const outPath = path.join(OUT_DIR, `${slug}__${name}.png`);
      try {
        if (sel) {
          const el = await page.$(sel);
          if (!el) { console.log(`  ${name}: NOT FOUND`); continue; }
          const box = await el.boundingBox();
          if (!box || box.height < 30) { console.log(`  ${name}: too small (${box?.height}px)`); continue; }
          await el.screenshot({ path: outPath });
          console.log(`  ${name}: OK (${Math.round(box.width)}x${Math.round(box.height)}px) → ${outPath}`);
        } else {
          await page.screenshot({ path: outPath, clip });
          console.log(`  ${name}: OK (clip) → ${outPath}`);
        }
      } catch (e) {
        console.log(`  ${name}: ERROR ${e.message.split('\n')[0]}`);
      }
    }

    await page.close();
  }

  await browser.close();
  console.log(`\nAll samples saved to: ${OUT_DIR}`);
  console.log('Open the folder and pick the cleanest one.');
}

main().catch(e => { console.error(e); process.exit(1); });
