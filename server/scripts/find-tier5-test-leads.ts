// Pick diverse test leads for Tier 5 validation. Filters to leads that:
//   - Have a website_url
//   - Don't have a website_email yet
//   - Span multiple categories (so we don't all-cluster on AU casinos which
//     intentionally hide emails)
//
// Prints lead URLs grouped by category so we can pick a good test set.
//
// Usage (from /server):
//   npx tsx scripts/find-tier5-test-leads.ts

import dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
import { getSupabase } from '../src/lib/supabase.js';

async function main() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('leads')
    .select('id, company_name, website_url, category, country, trustpilot_email')
    .is('website_email', null)
    .not('website_url', 'is', null)
    .limit(200);

  if (error) throw new Error(error.message);
  if (!data) return;

  // Group by category
  const byCategory = new Map<string, typeof data>();
  for (const lead of data) {
    const cat = lead.category ?? 'unknown';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(lead);
  }

  console.log(`\nTotal leads with website_url and no website_email: ${data.length}`);
  console.log(`Categories represented: ${byCategory.size}\n`);

  // Sort categories by count descending
  const sorted = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [cat, leads] of sorted) {
    console.log(`── ${cat} (${leads.length}) ──`);
    // Show first 3 of each
    for (const l of leads.slice(0, 3)) {
      const tpe = l.trustpilot_email ? `  [TP: ${l.trustpilot_email}]` : '';
      console.log(`  ${l.country ?? '??'}  ${l.company_name?.slice(0, 30).padEnd(32) ?? ''}  ${l.website_url}${tpe}`);
    }
    if (leads.length > 3) console.log(`  …+${leads.length - 3} more`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
