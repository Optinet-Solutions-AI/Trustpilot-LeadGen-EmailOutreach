// Tier 5 isolated smoke test.
//
// Picks 5 leads whose website_url historically lands on Cloudflare-protected
// pages (so the local stealth tiers will get blocked and Tier 5 will fire),
// then calls the live enrichment API on Cloud Run and streams the result.
//
// Usage (from /server):
//   npx tsx scripts/test-tier5.ts
//   npx tsx scripts/test-tier5.ts --count 10
//
// What success looks like:
//   - At least 1 lead returns a non-null website_email after Tier 5 escalation
//   - Cloud Run logs show "[tier5] ✓ tier5 hit: <email>"
//   - No "socket hang up" errors in logs

import 'dotenv/config';
import { getSupabase } from '../src/lib/supabase.js';

interface Args {
  count: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let count = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--count' && argv[i + 1]) {
      count = parseInt(argv[++i], 10) || 5;
    }
  }
  return { count };
}

// Public API Gateway URL — Cloud Run service itself requires IAM auth, so we
// have to go through the gateway (which is the same path the Vercel frontend uses).
const API_BASE_URL = 'https://trustpilot-gateway-3lazv1k9.uc.gateway.dev';

// Domains we saw blocked on the previous run (access_denied). These are the
// ones that should trigger Tier 5 escalation, so they're the right test set.
const KNOWN_BLOCKED_HOSTS = [
  'lux96.com', 's888.site', 'spinago-casino.site', 'katscasino.net',
  'pulsegaming.uk', 'casino4u.site', 'jokaroomcasinologin.live',
  'ozwin-casino.site', 'slotsrushs.com', 'outbackspins.org',
  'online-casinoonline.net', 'ironman98.live', 'casino247.win',
  'methwin.live', 'aarhuskicks.store',
];

async function main() {
  const { count } = parseArgs();
  const supabase = getSupabase();

  console.log(`[test-tier5] Looking for ${count} leads whose websites previously blocked us…`);

  // Build an OR filter for any of the known blocked hosts
  const orClauses = KNOWN_BLOCKED_HOSTS.map((h) => `website_url.ilike.%${h}%`).join(',');
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, company_name, website_url, website_email')
    .is('website_email', null)
    .not('website_url', 'is', null)
    .or(orClauses)
    .limit(count);

  if (error) throw new Error(`Lead lookup failed: ${error.message}`);
  if (!leads || leads.length === 0) {
    console.log('[test-tier5] No matching leads found. They may have all been enriched already.');
    return;
  }

  console.log(`\n[test-tier5] Found ${leads.length} candidate leads:`);
  for (const l of leads) {
    console.log(`  - ${l.company_name}: ${l.website_url}`);
  }

  console.log(`\n[test-tier5] Triggering enrichment via ${API_BASE_URL}/api/enrich…`);
  const leadIds = leads.map((l) => l.id);

  const resp = await fetch(`${API_BASE_URL}/api/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadIds }),
  });

  const json = await resp.json();
  if (!json.success) {
    console.error(`[test-tier5] API error: ${json.error}`);
    return;
  }

  const jobId = json.data.jobId;
  console.log(`[test-tier5] Job ${jobId} started for ${leadIds.length} leads`);
  console.log(`\n[test-tier5] Monitor with:`);
  console.log(`  gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=trustpilot-crm AND textPayload:${jobId.slice(0, 8)}" --limit=200 --freshness=10m --project=trustpilot-leadgen`);
  console.log(`\n[test-tier5] Polling job status every 10s…`);

  // Poll job status until completed or failed
  const startedAt = Date.now();
  while (true) {
    await new Promise((r) => setTimeout(r, 10_000));
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);

    const { data: job } = await supabase
      .from('scrape_jobs')
      .select('status, total_found, total_enriched, total_failed')
      .eq('id', jobId)
      .single();

    if (!job) {
      console.log(`  [${elapsed}s] job not found yet`);
      continue;
    }

    console.log(`  [${elapsed}s] ${job.status} — found=${job.total_found ?? 0} enriched=${job.total_enriched ?? 0} failed=${job.total_failed ?? 0}`);

    if (job.status === 'completed' || job.status === 'failed') {
      // Pull final results
      const { data: enriched } = await supabase
        .from('leads')
        .select('id, company_name, website_url, website_email')
        .in('id', leadIds);

      console.log(`\n[test-tier5] Final results:`);
      let hits = 0;
      for (const l of enriched ?? []) {
        const status = l.website_email ? `✓ ${l.website_email}` : '✗ no email';
        if (l.website_email) hits++;
        console.log(`  ${status}  ${l.website_url}`);
      }
      console.log(`\n[test-tier5] Tier 5 success rate: ${hits}/${leadIds.length}`);
      return;
    }

    // Safety cap — abort polling at 8min so script doesn't hang forever
    if (elapsed > 480) {
      console.warn(`[test-tier5] Polling timeout at ${elapsed}s — check Cloud Run logs manually`);
      return;
    }
  }
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
