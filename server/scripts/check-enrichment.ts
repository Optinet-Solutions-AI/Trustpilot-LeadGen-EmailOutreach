// Quick status check on recent enrichment jobs.
// Usage (from /server):  npx tsx scripts/check-enrichment.ts

import dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
import { getSupabase } from '../src/lib/supabase.js';

async function main() {
  const supabase = getSupabase();

  const { data: jobs } = await supabase
    .from('scrape_jobs')
    .select('id, status, total_found, total_enriched, total_failed, started_at, completed_at, error')
    .eq('country', '_enrich_')
    .order('started_at', { ascending: false })
    .limit(8);

  console.log('Recent enrichment jobs:');
  console.log('  started_at           status      found  enriched  failed  duration  error');
  console.log('  ' + '─'.repeat(90));

  for (const j of jobs ?? []) {
    const dur = j.completed_at && j.started_at
      ? Math.round((new Date(j.completed_at).getTime() - new Date(j.started_at).getTime()) / 1000) + 's'
      : '—';
    const err = j.error ? '  ' + j.error.slice(0, 50) : '';
    const startedAt = j.started_at?.slice(0, 19) ?? '?';
    console.log(
      `  ${startedAt}  ${(j.status ?? '?').padEnd(10)}  ` +
      `${String(j.total_found ?? 0).padStart(5)}  ${String(j.total_enriched ?? 0).padStart(8)}  ` +
      `${String(j.total_failed ?? 0).padStart(6)}  ${dur.padStart(8)}${err}`
    );
  }

  const { count: totalLeads } = await supabase.from('leads').select('*', { count: 'exact', head: true });
  const { count: withWebsiteEmail } = await supabase.from('leads').select('*', { count: 'exact', head: true }).not('website_email', 'is', null);
  const { count: withPrimary } = await supabase.from('leads').select('*', { count: 'exact', head: true }).not('primary_email', 'is', null);

  console.log(`\nDB state:`);
  console.log(`  total leads:                  ${totalLeads ?? 0}`);
  console.log(`  with website_email (scraped): ${withWebsiteEmail ?? 0}`);
  console.log(`  with primary_email (any):     ${withPrimary ?? 0}`);
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
