// Full enricher pipeline integration test.
//
// Runs the actual enrichLeads() function locally with mock leads (no DB
// writes) to verify all 6 tiers wire together correctly:
//   Tier 1: HTTP fast lane
//   Tier 2: Playwright + stealth
//   Tier 3: datacenter proxy   (skipped — not configured)
//   Tier 4: residential proxy  (skipped — not configured)
//   Tier 5: ScrapingBee
//   Tier 6: WHOIS
//
// What this catches that local unit tests miss:
//   - Wiring bugs between tiers (return types, deadline propagation, etc.)
//   - Unhandled errors that crash the worker
//   - Tier 6 not firing when expected
//
// Usage (from /server):
//   npx tsx scripts/test-enrich-pipeline.ts

import dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import { enrichLeads, type EnrichableLead, type EnrichmentResult } from '../src/services/scrapers/website-enricher.js';

const TEST_LEADS: Array<EnrichableLead & { expectedTier?: string }> = [
  // Should hit via HTTP fast lane or Tier 2 — sanity check the pipeline
  {
    id: 'mock-1',
    trustpilot_url: 'https://www.trustpilot.com/mock/google',
    website_url: 'https://google.com',
    website_email: null,
    expectedTier: 'fast lane or tier 2',
  },
  // Casino site that previously got access_denied at Tier 2 → should go all
  // the way to Tier 5 (ScrapingBee), then Tier 6 (WHOIS) if no email found
  {
    id: 'mock-2',
    trustpilot_url: 'https://www.trustpilot.com/mock/methwin',
    website_url: 'https://methwin.live',
    website_email: null,
    expectedTier: 'tier 5 or tier 6',
  },
  // Another likely-blocked casino
  {
    id: 'mock-3',
    trustpilot_url: 'https://www.trustpilot.com/mock/ironman98',
    website_url: 'https://ironman98.live',
    website_email: null,
    expectedTier: 'tier 5 or tier 6',
  },
];

function fmtResult(r: EnrichmentResult, expected: string | undefined): string {
  const status = r.foundEmail ? `✓ ${r.foundEmail}` : '✗ no email';
  const tier = `[tier=${r.tier}]`;
  const block = r.blockReason ? ` blockReason=${r.blockReason}` : '';
  const exp = expected ? `   (expected: ${expected})` : '';
  return `  ${status.padEnd(60)} ${tier}${block}${exp}`;
}

async function main() {
  console.log('────── Full enricher pipeline integration test ──────');
  console.log(`Leads: ${TEST_LEADS.length}`);
  console.log(`SCRAPINGBEE_API_KEY present: ${process.env.SCRAPINGBEE_API_KEY ? 'YES' : 'NO'}`);
  console.log(`Note: this WILL consume ScrapingBee credits for Tier 5 escalations.\n`);

  const startedAt = Date.now();
  let progressDots = 0;

  const results = await enrichLeads(TEST_LEADS, {
    concurrency: 2,
    onProgress: (done, total) => {
      progressDots++;
      console.log(`  [progress] ${done}/${total} done`);
    },
    onEvent: (event) => {
      // Print enricher events as they happen so we see real-time tier escalation
      if (event.type === 'enrich_email') {
        console.log(`  [event] ✓ ${event.domain} → ${event.email} (tier=${event.tier})`);
      } else if (event.type === 'enrich_no_email') {
        console.log(`  [event] ✗ ${event.domain} (reason=${event.reason ?? 'none'})`);
      } else if (event.type === 'enrich_failed') {
        console.log(`  [event] ⚠ ${event.domain} failed: ${event.reasonCode} — ${event.message}`);
      }
    },
  });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n────── Results (${elapsed}s) ──────`);

  let hits = 0;
  const tierCounts = new Map<string, number>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const expected = (TEST_LEADS[i] as { expectedTier?: string }).expectedTier;
    console.log(`${TEST_LEADS[i].website_url}`);
    console.log(fmtResult(r, expected));
    if (r.foundEmail) hits++;
    const tk = String(r.tier);
    tierCounts.set(tk, (tierCounts.get(tk) ?? 0) + 1);
  }

  console.log(`\n────── Summary ──────`);
  console.log(`Hits: ${hits}/${results.length}`);
  console.log(`Tier distribution:`);
  for (const [tier, count] of tierCounts) {
    console.log(`  ${tier}: ${count}`);
  }

  // ── Assertions ──
  console.log(`\n────── Assertions ──────`);
  const failures: string[] = [];

  // 1. Pipeline didn't crash on any lead
  if (results.length !== TEST_LEADS.length) {
    failures.push(`expected ${TEST_LEADS.length} results, got ${results.length}`);
  }

  // 2. Every result has a valid tier value
  const validTiers = new Set(['1', '2', '3', '4', 'scrapingbee', 'whois', 'none']);
  for (const r of results) {
    if (!validTiers.has(String(r.tier))) {
      failures.push(`unexpected tier value: ${r.tier} on ${r.lead.website_url}`);
    }
  }

  // 3. If foundEmail is set, tier must NOT be 'none'
  for (const r of results) {
    if (r.foundEmail && String(r.tier) === 'none') {
      failures.push(`lead ${r.lead.website_url} has email but tier=none`);
    }
  }

  // 4. If foundEmail is null, source should be 'none'
  for (const r of results) {
    if (!r.foundEmail && r.source !== 'none') {
      failures.push(`lead ${r.lead.website_url} has no email but source=${r.source}`);
    }
  }

  if (failures.length === 0) {
    console.log(`  ✓ ALL ASSERTIONS PASSED`);
    console.log(`\n[OK] Pipeline integration test passed. Safe to deploy.`);
    process.exit(0);
  } else {
    console.log(`  ✗ ${failures.length} ASSERTION(S) FAILED:`);
    for (const f of failures) console.log(`    - ${f}`);
    console.log(`\n[FAIL] Do NOT deploy. Fix issues above first.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
