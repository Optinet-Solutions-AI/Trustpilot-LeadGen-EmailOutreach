// Wipe every object in the Supabase Storage `screenshots` bucket.
// Companion to .tmp/wipe-leads-and-scrapes-2026-05-05.sql — Supabase blocks
// direct DELETE on storage.objects, so we go through the Storage API.
//
// Usage (from /server):
//   npx tsx scripts/wipe-screenshots-bucket.ts            # dry-run, prints counts
//   npx tsx scripts/wipe-screenshots-bucket.ts --confirm  # actually deletes

import 'dotenv/config';
import { getSupabase } from '../src/lib/supabase.js';

const BUCKET = 'screenshots';
const PAGE_SIZE = 1000;

function parseArgs(): { confirm: boolean } {
  return { confirm: process.argv.slice(2).includes('--confirm') };
}

async function listAllPaths(supabase: ReturnType<typeof getSupabase>): Promise<string[]> {
  // Recursively walk every prefix in the bucket. Supabase's list() is one
  // level deep, so we BFS through "directories" until nothing's left.
  const queue: string[] = [''];
  const files: string[] = [];

  while (queue.length > 0) {
    const prefix = queue.shift()!;
    let offset = 0;

    while (true) {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .list(prefix, { limit: PAGE_SIZE, offset });

      if (error) throw new Error(`list("${prefix}") failed: ${error.message}`);
      if (!data || data.length === 0) break;

      for (const entry of data) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        // Folders have id === null in Supabase's list response.
        if (entry.id === null) queue.push(path);
        else files.push(path);
      }

      if (data.length < PAGE_SIZE) break;
      offset += data.length;
    }
  }

  return files;
}

async function main() {
  const { confirm } = parseArgs();
  const supabase = getSupabase();

  console.log('────────────────────────────────────────────────');
  console.log(`  Wipe Storage bucket: ${BUCKET}`);
  console.log('────────────────────────────────────────────────');

  const paths = await listAllPaths(supabase);
  console.log(`  Files found: ${paths.length}`);

  if (paths.length === 0) {
    console.log('  Bucket is already empty. Nothing to do.');
    return;
  }

  if (!confirm) {
    console.log('  DRY RUN — no files removed.');
    console.log('  Re-run with --confirm to delete.');
    console.log(`  Sample: ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''}`);
    return;
  }

  // Supabase remove() accepts up to ~1000 paths per call.
  let removed = 0;
  for (let i = 0; i < paths.length; i += PAGE_SIZE) {
    const chunk = paths.slice(i, i + PAGE_SIZE);
    const { error } = await supabase.storage.from(BUCKET).remove(chunk);
    if (error) {
      console.error(`  ✗ remove chunk ${i}: ${error.message}`);
      continue;
    }
    removed += chunk.length;
    console.log(`  …${removed}/${paths.length} removed`);
  }

  console.log('────────────────────────────────────────────────');
  console.log(`  ✓ Removed ${removed} files from "${BUCKET}"`);
  console.log('────────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
