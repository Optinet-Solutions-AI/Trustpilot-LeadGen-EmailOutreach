/**
 * Re-capture & upload screenshots for leads with broken local paths.
 * Takes cropped screenshot of Trustpilot profile header only (no contact info).
 * Uploads to Supabase Storage, updates DB screenshot_path to public URL.
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

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function takeHeaderScreenshot(page, url, outputPath) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // Try specific header selectors — just the rating card, no contact info
    const selectors = [
      'section.styles_headerSection__BTHbz',
      '[data-business-unit-card-section]',
      '.business-unit-profile-summary',
      'div.styles_businessUnitHeader__sMrpj',
      'section[class*="header"]',
    ];

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const box = await el.boundingBox();
          if (box && box.height > 50) {
            await el.screenshot({ path: outputPath });
            console.log(`  OK section (${sel})`);
            return true;
          }
        }
      } catch {}
    }

    // Fallback: crop viewport to top 350px
    await page.screenshot({
      path: outputPath,
      clip: { x: 0, y: 0, width: 1280, height: 350 },
    });
    console.log('  OK viewport crop (350px)');
    return true;
  } catch (e) {
    console.log(`  FAIL: ${e.message}`);
    return false;
  }
}

async function main() {
  // Get leads with broken local paths
  const { data: leads, error } = await sb
    .from('leads')
    .select('id, company_name, screenshot_path, trustpilot_url')
    .not('screenshot_path', 'is', null)
    .not('screenshot_path', 'like', 'http%')
    .neq('screenshot_path', '');

  if (error) { console.error('DB error:', error.message); process.exit(1); }
  console.log(`Found ${leads.length} leads with broken local screenshot paths\n`);
  if (leads.length === 0) { console.log('Nothing to fix!'); return; }

  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Ensure bucket exists
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

    console.log(`[${i + 1}/${leads.length}] ${lead.company_name} -> ${tpUrl}`);

    const page = await context.newPage();
    try {
      const ok = await takeHeaderScreenshot(page, tpUrl, localPath);

      if (ok && fs.existsSync(localPath)) {
        const fileData = fs.readFileSync(localPath);

        // Upload to Supabase Storage (upsert)
        const { error: uploadErr } = await sb.storage
          .from(BUCKET)
          .upload(filename, fileData, { contentType: 'image/png', upsert: true });

        if (uploadErr) {
          console.log(`  UPLOAD FAIL: ${uploadErr.message}`);
          failed++;
          continue;
        }

        const { data: urlData } = sb.storage.from(BUCKET).getPublicUrl(filename);
        const publicUrl = urlData?.publicUrl;

        // Update DB
        await sb.from('leads').update({ screenshot_path: publicUrl }).eq('id', lead.id);
        console.log(`  -> ${publicUrl.substring(0, 80)}...`);
        success++;
      } else {
        failed++;
      }
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      failed++;
    } finally {
      await page.close();
    }

    // Don't hammer Trustpilot
    await new Promise(r => setTimeout(r, 2000));
  }

  await browser.close();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Done! ${success} fixed, ${failed} failed out of ${leads.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
