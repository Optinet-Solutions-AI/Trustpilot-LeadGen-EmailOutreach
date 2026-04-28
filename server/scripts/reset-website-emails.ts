// Reset script — clears all website-enriched email state so the enricher
// can re-run from a clean slate (now with Tier 5 ScrapingBee fallback).
//
// What it touches:
//   - website_email          → NULL
//   - website_email_status   → NULL
//   - primary_email          → trustpilot_email (or NULL if no Trustpilot email)
//
// What it leaves alone:
//   - trustpilot_email / trustpilot_email_status (Trustpilot-side data)
//   - verification_status / verified_at / verify_* audit columns
//     (these reflect the historical verdict; they'll be overwritten next time
//     the validator runs against the new emails)
//   - outreach_status (record of past activity)
//
// Usage (from /server):
//   npx tsx scripts/reset-website-emails.ts              # dry-run, prints counts
//   npx tsx scripts/reset-website-emails.ts --confirm    # actually wipes
//   npx tsx scripts/reset-website-emails.ts --confirm --batch-size 500

import 'dotenv/config';
import { getSupabase } from '../src/lib/supabase.js';

interface Args {
  confirm: boolean;
  batchSize: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let confirm = false;
  let batchSize = 1000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') confirm = true;
    else if (a === '--batch-size' && argv[i + 1]) {
      batchSize = parseInt(argv[++i], 10) || 1000;
    }
  }
  return { confirm, batchSize };
}

async function main() {
  const { confirm, batchSize } = parseArgs();
  const supabase = getSupabase();

  // ── Pre-flight counts ──────────────────────────────────────────────
  const { count: totalLeads } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true });

  const { count: withWebsiteEmail } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .not('website_email', 'is', null);

  const { count: withWebsiteStatus } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .not('website_email_status', 'is', null);

  console.log('────────────────────────────────────────────────');
  console.log('  Reset website-enriched email state');
  console.log('────────────────────────────────────────────────');
  console.log(`  Total leads:                  ${totalLeads ?? '?'}`);
  console.log(`  With website_email set:       ${withWebsiteEmail ?? '?'}`);
  console.log(`  With website_email_status:    ${withWebsiteStatus ?? '?'}`);
  console.log('────────────────────────────────────────────────');

  if (!confirm) {
    console.log('  DRY RUN — no rows changed.');
    console.log('  Re-run with --confirm to apply.');
    return;
  }

  // ── Step 1: Recompute primary_email for leads where primary == website_email ─
  // Pull every lead with a website_email so we can rebuild primary_email from
  // trustpilot_email (or null). Doing it server-side keeps the rule simple
  // and matches what the upserter does on insert: website > trustpilot.
  console.log('\n[1/2] Recomputing primary_email…');
  let processed = 0;
  let lastId: string | null = null;

  while (true) {
    let query = supabase
      .from('leads')
      .select('id, trustpilot_email, website_email, primary_email')
      .not('website_email', 'is', null)
      .order('id', { ascending: true })
      .limit(batchSize);

    if (lastId) query = query.gt('id', lastId);

    const { data, error } = await query;
    if (error) throw new Error(`Query failed: ${error.message}`);
    if (!data || data.length === 0) break;

    // Build per-row updates: primary_email = trustpilot_email (or null)
    for (const row of data) {
      const newPrimary = row.trustpilot_email ?? null;
      if (row.primary_email === newPrimary) continue; // no change needed
      const { error: updErr } = await supabase
        .from('leads')
        .update({ primary_email: newPrimary })
        .eq('id', row.id);
      if (updErr) {
        console.error(`  ✗ ${row.id}: ${updErr.message}`);
      }
    }
    processed += data.length;
    lastId = data[data.length - 1].id;
    console.log(`  …${processed} leads scanned`);
    if (data.length < batchSize) break;
  }
  console.log(`  ✓ primary_email recomputed for ${processed} candidate leads`);

  // ── Step 2: Bulk-clear website_email + website_email_status ─────────────
  console.log('\n[2/2] Clearing website_email + website_email_status…');
  const { error: clearErr, count: cleared } = await supabase
    .from('leads')
    .update({
      website_email: null,
      website_email_status: null,
    }, { count: 'exact' })
    .not('website_email', 'is', null);

  if (clearErr) throw new Error(`Bulk clear failed: ${clearErr.message}`);
  console.log(`  ✓ Cleared website_email on ${cleared ?? '?'} rows`);

  // Also clear status on any stragglers (leads with status but no email — unlikely but cheap)
  const { error: clearStatusErr, count: clearedStatus } = await supabase
    .from('leads')
    .update({ website_email_status: null }, { count: 'exact' })
    .not('website_email_status', 'is', null);

  if (clearStatusErr) {
    console.warn(`  ⚠ status cleanup error: ${clearStatusErr.message}`);
  } else if (clearedStatus && clearedStatus > 0) {
    console.log(`  ✓ Cleared lingering website_email_status on ${clearedStatus} rows`);
  }

  console.log('\n────────────────────────────────────────────────');
  console.log('  Reset complete. Re-run enrichment from the Leads page');
  console.log('  (Enrich button) to repopulate website_email with the');
  console.log('  new 5-tier ladder including ScrapingBee fallback.');
  console.log('────────────────────────────────────────────────');
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
