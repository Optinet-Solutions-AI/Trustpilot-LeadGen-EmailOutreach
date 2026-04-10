/**
 * One-time migration: uploads local .tmp/screenshots/*.png to Supabase Storage
 * and updates leads.screenshot_path to the public URL.
 *
 * Run: cd server && npx tsx ../scripts/migrate-screenshots-to-storage.ts
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET = 'screenshots';
const SCREENSHOTS_DIR = path.resolve(__dirname, '..', '.tmp', 'screenshots');

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Create bucket (idempotent)
  const { error: bucketError } = await supabase.storage.createBucket(BUCKET, { public: true });
  if (bucketError && !bucketError.message.includes('already exists')) {
    console.error('Failed to create bucket:', bucketError.message);
    process.exit(1);
  }
  console.log(`Bucket "${BUCKET}" ready.`);

  // Get all files
  const files = fs.readdirSync(SCREENSHOTS_DIR).filter((f) => f.endsWith('.png'));
  console.log(`Found ${files.length} screenshots to upload.`);

  let uploaded = 0;
  let updated = 0;
  let errors = 0;

  for (const filename of files) {
    const filePath = path.join(SCREENSHOTS_DIR, filename);
    const fileBuffer = fs.readFileSync(filePath);

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(filename, fileBuffer, { contentType: 'image/png', upsert: true });

    if (error) {
      console.warn(`  SKIP ${filename}: ${error.message}`);
      errors++;
      continue;
    }
    uploaded++;

    // Get public URL
    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filename);
    const publicUrl = urlData?.publicUrl;
    if (!publicUrl) continue;

    // Update any leads whose screenshot_path ends with this filename
    const { data: matchedLeads, error: queryError } = await supabase
      .from('leads')
      .select('id, screenshot_path')
      .like('screenshot_path', `%${filename}`);

    if (queryError || !matchedLeads?.length) continue;

    for (const lead of matchedLeads) {
      await supabase
        .from('leads')
        .update({ screenshot_path: publicUrl })
        .eq('id', lead.id);
      updated++;
    }

    if (uploaded % 25 === 0) console.log(`  Progress: ${uploaded}/${files.length} uploaded, ${updated} leads updated`);
  }

  console.log(`\nDone! ${uploaded} uploaded, ${updated} leads updated, ${errors} errors.`);
}

main().catch(console.error);
