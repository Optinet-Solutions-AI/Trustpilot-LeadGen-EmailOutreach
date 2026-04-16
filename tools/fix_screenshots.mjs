/**
 * Re-capture & upload screenshots for ALL leads (or just broken ones).
 * Uses the businessInfoGrid element clip to capture a clean, professional
 * profile card: company logo, name, rating, star distribution — no navbar, no breadcrumb.
 *
 * Usage:
 *   node tools/fix_screenshots.mjs          → only leads with broken local paths
 *   node tools/fix_screenshots.mjs --all    → all leads with any screenshot_path
 */

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';

config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'screenshots';
const SCREENSHOTS_DIR = path.resolve(import.meta.dirname, '..', '.tmp', 'screenshots_fix');
const ALL_MODE = process.argv.includes('--all');

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Take a clean screenshot of the Trustpilot profile card.
 * Primary: clip the businessInfoGrid (both columns: info + rating card).
 * Fallback: clip at y=130 to skip navbar and breadcrumb.
 */
async function takeProfileScreenshot(page, url, outputPath) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Primary: find the grid that contains both the info panel and rating card
    const clip = await page.evaluate(() => {
      const grid = document.querySelector('div.styles_businessInfoGrid__T_git');
      if (!grid) return null;
      const r = grid.getBoundingClientRect();
      if (r.width < 200 || r.y < 0 || r.y > 400) return null;
      return { x: Math.round(r.x), y: Math.round(r.y) - 8, width: Math.round(r.width), height: 240 };
    });

    if (clip) {
      await page.screenshot({ path: outputPath, clip });
      console.log(`  OK grid clip (${clip.width}x${clip.height} at y=${clip.y})`);
      return true;
    }

    // Fallback: fixed clip that skips navbar (y=130) and captures profile card
    await page.screenshot({
      path: outputPath,
      clip: { x: 40, y: 130, width: 1200, height: 240 },
    });
    console.log('  OK fallback clip (y=130)');
    return true;
  } catch (e) {
    console.log(`  FAIL: ${e.message.split('\n')[0]}`);
    return false;
  }
}

async function main() {
  let query = sb.from('leads').select('id, company_name, screenshot_path, trustpilot_url');

  if (ALL_MODE) {
    // Re-capture everything that has a trustpilot URL (not manual leads)
    query = query.not('screenshot_path', 'is', null).like('screenshot_path', 'http%');
    console.log('Mode: ALL leads with HTTP screenshots');
  } else {
    // Only broken local paths
    query = query
      .not('screenshot_path', 'is', null)
      .not('screenshot_path', 'like', 'http%')
      .neq('screenshot_path', '');
    console.log('Mode: only leads with broken local paths');
  }

  const { data: leads, error } = await query;
  if (error) { console.error('DB error:', error.message); process.exit(1); }
  console.log(`Found ${leads.length} leads to process\n`);
  if (leads.length === 0) { console.log('Nothing to do!'); return; }

  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  await sb.storage.createBucket(BUCKET, { public: true }).catch(() => {});

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  let success = 0, failed = 0;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const tpUrl = lead.trustpilot_url || '';

    if (!tpUrl || tpUrl.startsWith('manual:')) {
      console.log(`[${i + 1}/${leads.length}] ${lead.company_name} — skip (manual)`);
      failed++;
      continue;
    }

    const filename = path.basename(lead.screenshot_path);
    const localPath = path.join(SCREENSHOTS_DIR, filename);

    console.log(`[${i + 1}/${leads.length}] ${lead.company_name}`);

    const page = await context.newPage();
    try {
      const ok = await takeProfileScreenshot(page, tpUrl, localPath);

      if (ok && fs.existsSync(localPath)) {
        const fileData = fs.readFileSync(localPath);

        const { error: uploadErr } = await sb.storage
          .from(BUCKET)
          .upload(filename, fileData, { contentType: 'image/png', upsert: true });

        if (uploadErr) {
          console.log(`  UPLOAD FAIL: ${uploadErr.message}`);
          failed++;
          continue;
        }

        const { data: urlData } = sb.storage.from(BUCKET).getPublicUrl(filename);
        await sb.from('leads').update({ screenshot_path: urlData.publicUrl }).eq('id', lead.id);
        console.log(`  -> uploaded`);
        success++;
      } else {
        failed++;
      }
    } catch (e) {
      console.log(`  ERROR: ${e.message.split('\n')[0]}`);
      failed++;
    } finally {
      await page.close();
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  await browser.close();
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Done! ${success} fixed, ${failed} failed out of ${leads.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
