/**
 * Crop the top navbar/header out of all lead screenshots already in Supabase Storage.
 * Downloads each image, removes top 90px (Trustpilot navbar + breadcrumb), re-uploads.
 * No Playwright needed — pure image manipulation.
 */

import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import path from 'path';

config({ path: path.resolve(import.meta.dirname, '..', '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'screenshots';
const CROP_TOP_PX = 90; // removes Trustpilot navbar + breadcrumb row

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

async function main() {
  // Get all leads with Supabase Storage screenshots
  const { data: leads, error } = await sb
    .from('leads')
    .select('id, company_name, screenshot_path')
    .like('screenshot_path', 'http%');

  if (error) { console.error('DB error:', error.message); process.exit(1); }
  console.log(`Found ${leads.length} leads with HTTP screenshot URLs\n`);

  let success = 0, failed = 0, skipped = 0;

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const url = lead.screenshot_path;
    const filename = url.split('/').pop();

    process.stdout.write(`[${i + 1}/${leads.length}] ${lead.company_name}... `);

    try {
      // Download
      const res = await fetch(url);
      if (!res.ok) { console.log(`SKIP (HTTP ${res.status})`); skipped++; continue; }
      const originalBuffer = Buffer.from(await res.arrayBuffer());

      // Get dimensions
      const meta = await sharp(originalBuffer).metadata();
      const newTop = CROP_TOP_PX;
      const newHeight = Math.max((meta.height ?? 350) - newTop, 50);

      // Crop
      const croppedBuffer = await sharp(originalBuffer)
        .extract({ left: 0, top: newTop, width: meta.width ?? 1280, height: newHeight })
        .toBuffer();

      // Re-upload (overwrite)
      const { error: uploadErr } = await sb.storage
        .from(BUCKET)
        .upload(filename, croppedBuffer, { contentType: 'image/png', upsert: true });

      if (uploadErr) {
        console.log(`FAIL upload: ${uploadErr.message}`);
        failed++;
        continue;
      }

      console.log(`OK (${meta.height}px → ${newHeight}px)`);
      success++;
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Done! ${success} cropped, ${skipped} skipped, ${failed} failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
